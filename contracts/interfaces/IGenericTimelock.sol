// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IGenericTimelock
/// @notice Events and errors emitted by GenericTimelock. Split out so external
///         monitors, indexers, and other contracts can reference the shapes
///         without importing the full implementation.
interface IGenericTimelock {
    // ============ Events ============

    /// @notice Emitted on constructor init (previousDelay == 0) and on every setDelay.
    event DelayUpdated(uint256 previousDelay, uint256 newDelay);

    /// @notice Emitted when a call is queued for delayed execution.
    event OperationQueued(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        uint256 eta
    );

    /// @notice Emitted after a queued operation is successfully executed.
    event OperationExecuted(
        bytes32 indexed opHash,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        bytes returnData
    );

    /// @notice Emitted when a queued operation is cancelled (before or after expiry).
    event OperationCancelled(bytes32 indexed opHash);

    // ============ Errors ============

    /// @notice Given delay is outside [MIN_DELAY, MAX_DELAY].
    error DelayOutOfBounds(uint256 given, uint256 min, uint256 max);

    /// @notice queue: `eta` must be at least `block.timestamp + delay`.
    error EtaTooSoon(uint256 eta, uint256 minEta);

    /// @notice Cannot queue: the identical operation is already queued.
    error OperationAlreadyQueued(bytes32 opHash);

    /// @notice Cannot execute/cancel: no such operation is currently queued.
    error OperationNotQueued(bytes32 opHash);

    /// @notice execute: current time has not yet reached `eta`.
    error OperationNotReady(uint256 eta, uint256 nowTs);

    /// @notice execute: current time is past `eta + GRACE_PERIOD`.
    error OperationExpired(uint256 eta, uint256 gracePeriodEnd, uint256 nowTs);

    /// @notice execute: `msg.value` did not match the value queued for this op.
    error ValueMismatch(uint256 given, uint256 expected);

    /// @notice setDelay: caller must be the timelock itself (routed through
    ///         queue/execute). Direct calls, even from the owner, revert.
    error NotSelf(address caller);

    /// @notice execute: the forwarded target call reverted. `returnData` is the
    ///         raw revert payload — decode it with the target contract's ABI.
    error CallReverted(bytes returnData);
}
