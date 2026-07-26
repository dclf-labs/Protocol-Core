// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GenericTimelock
 * @notice Compound-style timelock. Queues arbitrary calls (target, value,
 *         function signature, ABI-encoded inputs) and executes them after a
 *         configurable delay. Any contract whose privileged function is owned
 *         (or role-granted) to this timelock can be safely managed through it.
 *
 * Typical wiring:
 *   1. Deploy GenericTimelock with (multisig, delay).
 *   2. Transfer ownership / grant admin role on target contracts to this
 *      timelock's address.
 *   3. Multisig calls `queue(target, value, signature, data, eta)` to schedule.
 *   4. After `eta`, multisig (or anyone if made permissionless) calls
 *      `execute(...)` — the timelock forwards the call to `target`.
 *
 * The `signature` parameter is the textual function signature (e.g.
 * "setWithdrawPeriod(uint256)"). The keccak256 selector is prepended to `data`
 * automatically. If `signature` is empty, `data` is used as raw calldata (so a
 * pre-encoded call from an off-chain builder still works).
 */
contract GenericTimelock is Ownable2Step, ReentrancyGuard {
    // ============ Constants ============

    /// @notice Minimum acceptable delay between queue and execute.
    uint256 public constant MIN_DELAY = 1 days;

    /// @notice Maximum acceptable delay between queue and execute.
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Maximum window after `eta` during which an execution is still
    /// accepted. After this, the queued op expires and must be re-queued.
    /// Prevents indefinitely-live pending calls that could surprise later.
    uint256 public constant GRACE_PERIOD = 14 days;

    // ============ Storage ============

    /// @notice Current queue-to-execute delay.
    uint256 public delay;

    /// @notice opHash => queued flag. True once queued, false after execute/cancel.
    mapping(bytes32 => bool) public queued;

    // ============ Events ============

    event DelayUpdated(uint256 previousDelay, uint256 newDelay);
    event OperationQueued(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        uint256 eta
    );
    event OperationExecuted(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        bytes returnData
    );
    event OperationCancelled(bytes32 indexed opHash);

    // ============ Errors ============

    error DelayOutOfBounds(uint256 given, uint256 min, uint256 max);
    error EtaTooSoon(uint256 eta, uint256 minEta);
    error EtaTooLate(uint256 eta, uint256 maxEta);
    error OperationAlreadyQueued(bytes32 opHash);
    error OperationNotQueued(bytes32 opHash);
    error OperationNotReady(uint256 eta, uint256 nowTs);
    error OperationExpired(uint256 eta, uint256 gracePeriodEnd, uint256 nowTs);
    error CallReverted(bytes returnData);

    // ============ Constructor ============

    /**
     * @param initialOwner Address that can queue / execute / cancel / setDelay.
     * @param initialDelay Delay in seconds; must be in [MIN_DELAY, MAX_DELAY].
     */
    constructor(address initialOwner, uint256 initialDelay) Ownable(initialOwner) {
        if (initialDelay < MIN_DELAY || initialDelay > MAX_DELAY) {
            revert DelayOutOfBounds(initialDelay, MIN_DELAY, MAX_DELAY);
        }
        delay = initialDelay;
        emit DelayUpdated(0, initialDelay);
    }

    // ============ Admin ============

    /**
     * @notice Update the timelock delay. Must be within [MIN_DELAY, MAX_DELAY].
     * @dev The new delay only affects operations queued AFTER the change.
     */
    function setDelay(uint256 newDelay) external onlyOwner {
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) {
            revert DelayOutOfBounds(newDelay, MIN_DELAY, MAX_DELAY);
        }
        uint256 previousDelay = delay;
        delay = newDelay;
        emit DelayUpdated(previousDelay, newDelay);
    }

    // ============ Queue / Execute / Cancel ============

    /**
     * @notice Queue an operation for later execution.
     * @param target Contract to call.
     * @param value ETH to send with the call.
     * @param signature Textual function signature (e.g. "setFoo(uint256)"). Pass
     *        empty string to treat `data` as raw calldata.
     * @param data ABI-encoded arguments (WITHOUT the 4-byte selector) when
     *        `signature` is non-empty, else raw calldata.
     * @param eta Earliest timestamp at which the operation may execute. Must
     *        satisfy `eta >= block.timestamp + delay` at queue time.
     * @return opHash The unique identifier for this operation.
     */
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

    /**
     * @notice Cancel a queued operation before it executes.
     */
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

    /**
     * @notice Execute a previously queued operation once its eta has passed.
     * @dev Owner-only by convention. If you want permissionless execution, wrap
     *      this contract with a role-based adapter or fork with the modifier
     *      removed.
     */
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
        if (msg.value != value) {
            revert CallReverted(abi.encode("msg.value != value"));
        }
        delete queued[opHash];

        bytes memory callData = _buildCalldata(signature, data);
        bool ok;
        (ok, returnData) = target.call{value: value}(callData);
        if (!ok) revert CallReverted(returnData);

        emit OperationExecuted(opHash, target, value, signature, data, returnData);
    }

    // ============ Views ============

    /**
     * @notice Deterministic identifier for an operation. Two queued operations
     *         with the same parameters share the same hash — they cannot be
     *         queued simultaneously.
     */
    function hashOperation(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, signature, data, eta));
    }

    /**
     * @notice Build the raw calldata for a call. Public for off-chain tooling
     *         that wants to preview the exact bytes forwarded to `target`.
     */
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

    // ============ Fallback ============

    /// @notice Accept ETH so operations can carry `value > 0` without a
    ///         separate pre-funding step.
    receive() external payable {}
}
