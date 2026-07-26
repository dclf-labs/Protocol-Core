// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IGenericTimelock
 * @notice Events and errors emitted by GenericTimelock. Kept in a separate
 *         interface so external monitors, indexers and other contracts can
 *         reference the event/error shapes without importing the full
 *         implementation.
 */
interface IGenericTimelock {
    // ============ Events ============

    /**
     * @notice Emitted when the delay is (re)initialised or updated.
     * @param previousDelay Previous delay in seconds (0 on constructor init).
     * @param newDelay New delay in seconds.
     */
    event DelayUpdated(uint256 previousDelay, uint256 newDelay);

    /**
     * @notice Emitted when a call is queued for delayed execution.
     * @param opHash Deterministic operation identifier.
     * @param target Contract that will be called.
     * @param value Native token amount to forward with the call.
     * @param signature Textual function signature (empty = raw calldata mode).
     * @param data ABI-encoded arguments (without selector) when signature is
     *        non-empty, else raw calldata.
     * @param eta Earliest timestamp at which the operation may execute.
     */
    event OperationQueued(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        uint256 eta
    );

    /**
     * @notice Emitted after a queued operation is successfully executed.
     * @param opHash Deterministic operation identifier.
     * @param target Contract that was called.
     * @param value Native token amount forwarded with the call.
     * @param signature Textual function signature (empty = raw calldata mode).
     * @param data ABI-encoded arguments (without selector) when signature is
     *        non-empty, else raw calldata.
     * @param returnData Raw return data from the underlying target call.
     */
    event OperationExecuted(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        bytes returnData
    );

    /**
     * @notice Emitted when a queued operation is cancelled before execution.
     * @param opHash Deterministic operation identifier.
     */
    event OperationCancelled(bytes32 indexed opHash);

    // ============ Errors ============

    /// @notice Given delay is outside [MIN_DELAY, MAX_DELAY].
    error DelayOutOfBounds(uint256 given, uint256 min, uint256 max);

    /// @notice queue: `eta` must be at least `block.timestamp + delay`.
    error EtaTooSoon(uint256 eta, uint256 minEta);

    /// @notice Reserved for future use — currently unused. Kept in the
    ///         interface so downstream consumers can pattern-match on it if
    ///         the implementation ever adds an upper bound on eta.
    error EtaTooLate(uint256 eta, uint256 maxEta);

    /// @notice Cannot queue: the identical operation is already queued.
    error OperationAlreadyQueued(bytes32 opHash);

    /// @notice Cannot execute/cancel: no such operation is currently queued.
    error OperationNotQueued(bytes32 opHash);

    /// @notice execute: current time has not yet reached `eta`.
    error OperationNotReady(uint256 eta, uint256 nowTs);

    /// @notice execute: current time is past `eta + GRACE_PERIOD`.
    error OperationExpired(uint256 eta, uint256 gracePeriodEnd, uint256 nowTs);

    /**
     * @notice execute: the forwarded call reverted OR msg.value != queued value.
     *         `returnData` is the raw revert payload from the target when
     *         reverted, or an ABI-encoded string when the timelock itself
     *         detected the mismatch.
     */
    error CallReverted(bytes returnData);
}
