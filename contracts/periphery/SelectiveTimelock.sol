// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/ISelectiveTimelock.sol";

/// @title SelectiveTimelock
/// @notice GenericTimelock with the delay keyed by (target, selector) instead
///         of one global value. Queues arbitrary (target, value, signature,
///         data, eta) calls and executes them after that pair's delay. Pairs
///         with a delay of 0 may also be executed immediately by the owner
///         through `call`. Every forwarded call runs from this contract's
///         context, so it is the owner-of-record of the target.
///
/// Intended wiring for USN:
///   24h    : USN.setAdmin(address)            — the admin is the sole minter
///   24h    : USN.transferOwnership(address)   — otherwise the owner could hand USN
///   24h    : USN.renounceOwnership()            to a fresh owner and call setAdmin at once
///   direct : everything else the owner can do on USN (pause, blacklist,
///            whitelist, setRateLimiter, peers, enforced options, ...)
///
/// Delay guarantees an integrator should reason about:
///   - Every delay is in [0, MAX_DELAY]. 0 means "direct".
///   - Changing a pair's delay is the same two-step flow as GenericTimelock,
///     with the pair's CURRENT delay applied to the change:
///     scheduleDelayChange(target, selector, newDelay) records the request,
///     executeDelayChange(target, selector) applies it once the current delay
///     has elapsed. Reducing setAdmin from 24h to 0 thus takes 24h. Putting a
///     new pair under a delay (current 0) is immediate.
///   - Ownership rotation on this contract uses Ownable2Step (transfer +
///     accept) but is NOT timelocked; the new owner inherits the same map.
///     renounceOwnership is disabled.
contract SelectiveTimelock is Ownable2Step, ReentrancyGuard, ISelectiveTimelock {
    // ============ Constants ============

    /// @notice Maximum acceptable delay for any (target, selector).
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Window after `eta` during which an execution is still accepted.
    ///         Past this, `execute` reverts `OperationExpired`. The queued
    ///         flag remains set for the expired opHash but has no on-chain
    ///         effect — that opHash can never execute (eta is in the past)
    ///         and cannot be re-queued (same eta trips `EtaTooSoon`).
    ///         To retry the operation, queue it again with a fresh `eta`;
    ///         the new opHash is independent.
    uint256 public constant GRACE_PERIOD = 14 days;

    // ============ Storage ============

    /// @notice (target, selector) => queue-to-execute delay. 0 = direct.
    mapping(address => mapping(bytes4 => uint256)) public delay;

    /// @notice (target, selector) => pending delay change (0 if none scheduled).
    mapping(address => mapping(bytes4 => uint256)) public pendingDelay;

    /// @notice (target, selector) => earliest timestamp at which the pending
    ///         delay change may be executed. 0 iff no change is pending.
    mapping(address => mapping(bytes4 => uint256)) public pendingDelayEta;

    /// @notice opHash => queued flag. True once queued, false after execute/cancel.
    mapping(bytes32 => bool) public queued;

    // ============ Constructor ============

    /// @param initialOwner Address that can queue / execute / cancel operations,
    ///        run direct calls, and administer delays.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Disabled. An ownerless timelock would leave the target without
    ///         any owner path; rotate with transferOwnership + acceptOwnership.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ============ Delay management (self-timelocked, explicit two-step) ============

    /// @notice Schedule a change to the delay of (target, selector). The change
    ///         cannot be applied until the pair's CURRENT delay has elapsed since
    ///         scheduling — so reducing a delay takes at least the current delay.
    /// @param newDelay New delay in seconds. Must be in [0, MAX_DELAY].
    /// @dev At most one delay change can be pending per pair. Use
    ///      cancelDelayChange first to replace a pending one.
    function scheduleDelayChange(
        address target,
        bytes4 selector,
        uint256 newDelay
    ) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        if (newDelay > MAX_DELAY) revert DelayOutOfBounds(newDelay, 0, MAX_DELAY);
        if (pendingDelayEta[target][selector] != 0) {
            revert DelayChangeAlreadyPending(
                target,
                selector,
                pendingDelay[target][selector],
                pendingDelayEta[target][selector]
            );
        }
        uint256 eta = block.timestamp + delay[target][selector];
        pendingDelay[target][selector] = newDelay;
        pendingDelayEta[target][selector] = eta;
        emit DelayChangeScheduled(target, selector, newDelay, eta);
    }

    /// @notice Apply the pending delay change of (target, selector) once the
    ///         pair's CURRENT delay has elapsed.
    /// @dev Only affects operations queued AFTER this call; already-queued ops
    ///      keep their original `eta`.
    function executeDelayChange(address target, bytes4 selector) external onlyOwner {
        uint256 eta = pendingDelayEta[target][selector];
        if (eta == 0) revert NoPendingDelayChange(target, selector);
        if (block.timestamp < eta) revert DelayChangeNotReady(eta, block.timestamp);

        uint256 previousDelay = delay[target][selector];
        uint256 newDelay = pendingDelay[target][selector];
        delay[target][selector] = newDelay;
        delete pendingDelay[target][selector];
        delete pendingDelayEta[target][selector];
        emit DelayUpdated(target, selector, previousDelay, newDelay);
    }

    /// @notice Cancel a pending delay change of (target, selector) before it is executed.
    function cancelDelayChange(address target, bytes4 selector) external onlyOwner {
        if (pendingDelayEta[target][selector] == 0) revert NoPendingDelayChange(target, selector);
        uint256 cancelledDelay = pendingDelay[target][selector];
        delete pendingDelay[target][selector];
        delete pendingDelayEta[target][selector];
        emit DelayChangeCancelled(target, selector, cancelledDelay);
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
    ///        `eta >= block.timestamp + delay[target][selector]` at queue time.
    /// @return opHash Unique identifier for this operation.
    function queue(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) external onlyOwner returns (bytes32 opHash) {
        uint256 minEta = block.timestamp + delay[target][_selector(signature, data)];
        if (eta < minEta) revert EtaTooSoon(eta, minEta);

        opHash = hashOperation(target, value, signature, data, eta);
        if (queued[opHash]) revert OperationAlreadyQueued(opHash);
        queued[opHash] = true;

        emit OperationQueued(opHash, target, value, signature, data, eta);
    }

    /// @notice Cancel a queued operation. Callable at any time before execute.
    ///         Also callable on an already-expired op, but this only clears
    ///         a mapping entry that has no effect either way — the expired
    ///         opHash can already never execute and can never be re-queued.
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

    // ============ Direct path (owner, zero-delay pairs only) ============

    /// @notice Execute an operation immediately. Reverts `SelectorIsDelayed`
    ///         when (target, selector) carries a delay — use `queue` then.
    /// @param signature / data Same conventions as `queue`.
    function call(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data
    ) external payable onlyOwner nonReentrant returns (bytes memory returnData) {
        bytes4 selector = _selector(signature, data);
        uint256 d = delay[target][selector];
        if (d != 0) revert SelectorIsDelayed(target, selector, d);
        if (msg.value != value) revert ValueMismatch(msg.value, value);

        bytes memory callData = _buildCalldata(signature, data);
        bool ok;
        (ok, returnData) = target.call{value: value}(callData);
        if (!ok) revert CallReverted(returnData);

        emit DirectCall(target, value, signature, data, returnData);
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

    /// @notice Delay that applies to this (signature, data) on `target`. 0 = direct.
    function delayFor(
        address target,
        string calldata signature,
        bytes calldata data
    ) external view returns (uint256) {
        return delay[target][_selector(signature, data)];
    }

    // ============ Internal ============

    function _buildCalldata(
        string calldata signature,
        bytes calldata data
    ) internal pure returns (bytes memory) {
        if (bytes(signature).length == 0) return data;
        return bytes.concat(bytes4(keccak256(bytes(signature))), data);
    }

    /// @dev Selector the forwarded call will carry: from `signature` when given,
    ///      else the first 4 bytes of raw `data`. Empty data (plain value
    ///      transfer) maps to selector 0x00000000.
    function _selector(
        string calldata signature,
        bytes calldata data
    ) internal pure returns (bytes4) {
        if (bytes(signature).length != 0) return bytes4(keccak256(bytes(signature)));
        if (data.length == 0) return bytes4(0);
        if (data.length < 4) revert BadCalldata();
        return bytes4(data[:4]);
    }

    // Intentionally no receive/fallback: this contract does not spend from
    // its own balance. All ETH for value>0 executions must be supplied via
    // `msg.value` at `execute` / `call` time.
}
