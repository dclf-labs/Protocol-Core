// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IGenericTimelock.sol";

/// @title GenericTimelock
/// @notice Queues arbitrary (target, value, signature, data, eta) calls and
///         executes them after a configurable delay. The owner can queue,
///         execute, and cancel operations. Every executed call is forwarded
///         from this contract's context, so target contracts that gate on
///         `msg.sender == address(this timelock)` are supported.
///
/// Delay guarantees an integrator should reason about:
///   - MIN_DELAY = 2 days. This is the hard floor on every operation. No
///     configuration change can go below it, so any observer knows that a
///     newly-queued op cannot execute sooner than 2 days from now.
///   - `setDelay` is self-timelocked: it is only callable by this contract
///     itself, i.e. via queue/execute. Reducing the delay from N to M
///     therefore takes at least N seconds (the current delay), not zero.
///     A compromised owner cannot instantly drop the delay to accelerate
///     a follow-up attack — they still have to wait the pre-compromise
///     delay for the delay change itself to take effect.
///   - Ownership rotation on this contract uses Ownable2Step (transfer +
///     accept) but is NOT timelocked; who operates the timelock is
///     considered a governance-level decision, not an on-chain action the
///     timelock guards against itself.
contract GenericTimelock is Ownable2Step, ReentrancyGuard, IGenericTimelock {
    // ============ Constants ============

    /// @notice Minimum acceptable delay between queue and execute.
    uint256 public constant MIN_DELAY = 2 days;

    /// @notice Maximum acceptable delay between queue and execute.
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Window after `eta` during which an execution is still accepted.
    ///         Past this, the queued flag remains set but `execute` reverts —
    ///         see `cancel` to free the slot, or re-queue with a fresh `eta`.
    uint256 public constant GRACE_PERIOD = 14 days;

    // ============ Storage ============

    /// @notice Current queue-to-execute delay.
    uint256 public delay;

    /// @notice opHash => queued flag. True once queued, false after execute/cancel.
    mapping(bytes32 => bool) public queued;

    // ============ Constructor ============

    /// @param initialOwner Address that can queue / execute / cancel / setDelay.
    /// @param initialDelay Delay in seconds; must satisfy MIN_DELAY <= x <= MAX_DELAY.
    constructor(address initialOwner, uint256 initialDelay) Ownable(initialOwner) {
        if (initialDelay < MIN_DELAY || initialDelay > MAX_DELAY) {
            revert DelayOutOfBounds(initialDelay, MIN_DELAY, MAX_DELAY);
        }
        delay = initialDelay;
        emit DelayUpdated(0, initialDelay);
    }

    // ============ Admin ============

    /// @notice Update the timelock delay. Self-timelocked: only callable by
    ///         this contract itself (routed through queue/execute). Reducing
    ///         the delay therefore takes at least the current delay.
    /// @dev The new delay only affects operations queued AFTER the change;
    ///      already-queued ops keep their original `eta`.
    /// @param newDelay New delay in seconds. Must be in [MIN_DELAY, MAX_DELAY].
    function setDelay(uint256 newDelay) external {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) {
            revert DelayOutOfBounds(newDelay, MIN_DELAY, MAX_DELAY);
        }
        uint256 previousDelay = delay;
        delay = newDelay;
        emit DelayUpdated(previousDelay, newDelay);
    }

    // ============ Queue / Execute / Cancel ============

    /// @notice Queue an operation for later execution.
    /// @param target Contract to call.
    /// @param value ETH to send with the call. `msg.value` at `execute` time must equal this.
    /// @param signature Textual function signature (e.g. "setFoo(uint256)"). Pass empty
    ///        string to treat `data` as raw calldata.
    /// @param data ABI-encoded arguments (without the 4-byte selector) when `signature` is
    ///        non-empty, else raw calldata.
    /// @param eta Earliest timestamp at which the operation may execute. Must satisfy
    ///        `eta >= block.timestamp + delay` at queue time.
    /// @return opHash Unique identifier for this operation.
    function queue(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) external onlyOwner returns (bytes32 opHash) {
        uint256 minEta = block.timestamp + delay;
        if (eta < minEta) revert EtaTooSoon(eta, minEta);

        opHash = hashOperation(target, value, signature, data, eta);
        if (queued[opHash]) revert OperationAlreadyQueued(opHash);
        queued[opHash] = true;

        emit OperationQueued(opHash, target, value, signature, data, eta);
    }

    /// @notice Cancel a queued operation. Callable at any time before execute, and
    ///         also after expiry to free the queued slot.
    /// @param target Same as `queue`.
    /// @param value Same as `queue`.
    /// @param signature Same as `queue`.
    /// @param data Same as `queue`.
    /// @param eta Same as `queue`.
    function cancel(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) external onlyOwner {
        bytes32 opHash = hashOperation(target, value, signature, data, eta);
        if (!queued[opHash]) revert OperationNotQueued(opHash);
        delete queued[opHash];
        emit OperationCancelled(opHash);
    }

    /// @notice Execute a queued operation once its `eta` has passed and before
    ///         `eta + GRACE_PERIOD`.
    /// @param target Same as `queue`.
    /// @param value Same as `queue`. `msg.value` must equal this exactly.
    /// @param signature Same as `queue`.
    /// @param data Same as `queue`.
    /// @param eta Same as `queue`.
    /// @return returnData Raw return data from the underlying target call.
    function execute(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) external payable onlyOwner nonReentrant returns (bytes memory returnData) {
        bytes32 opHash = hashOperation(target, value, signature, data, eta);
        if (!queued[opHash]) revert OperationNotQueued(opHash);
        if (block.timestamp < eta) revert OperationNotReady(eta, block.timestamp);
        uint256 gracePeriodEnd = eta + GRACE_PERIOD;
        if (block.timestamp > gracePeriodEnd) {
            revert OperationExpired(eta, gracePeriodEnd, block.timestamp);
        }
        if (msg.value != value) revert ValueMismatch(msg.value, value);

        delete queued[opHash];

        bytes memory callData = _buildCalldata(signature, data);
        bool ok;
        (ok, returnData) = target.call{value: value}(callData);
        if (!ok) revert CallReverted(returnData);

        emit OperationExecuted(opHash, target, value, signature, data, returnData);
    }

    // ============ Views ============

    /// @notice Deterministic identifier for an operation. Two operations with
    ///         identical params share the same hash and cannot be queued
    ///         simultaneously.
    function hashOperation(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, signature, data, eta));
    }

    /// @notice Preview the exact bytes forwarded to `target` at execute time.
    function buildCalldata(
        string calldata signature,
        bytes calldata data
    ) external pure returns (bytes memory) {
        return _buildCalldata(signature, data);
    }

    // ============ Internal ============

    function _buildCalldata(
        string calldata signature,
        bytes calldata data
    ) internal pure returns (bytes memory) {
        if (bytes(signature).length == 0) return data;
        return bytes.concat(bytes4(keccak256(bytes(signature))), data);
    }

    // Intentionally no receive/fallback: this contract does not spend from
    // its own balance. All ETH for value>0 executions must be supplied via
    // `msg.value` at `execute` time.
}
