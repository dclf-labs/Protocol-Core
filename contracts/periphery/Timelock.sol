// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "../interfaces/IProxyAdmin.sol";
import "../interfaces/ITimelock.sol";

/**
 * @title Timelock
 * @dev Enforces a delay on proxy upgrades performed via one or more ProxyAdmin contracts.
 *      The single owner (e.g. a multisig) must first schedule an upgrade; the upgrade
 *      can only be executed after the timelock delay has passed.
 *
 *      Use: set each ProxyAdmin's owner to this Timelock, and set this Timelock's owner
 *      to the multisig. All upgrades then go: multisig -> Timelock (schedule) -> wait ->
 *      multisig -> Timelock (execute) -> ProxyAdmin.upgradeAndCall.
 */
contract Timelock is Ownable2Step, ITimelock {
    /// @dev Minimum delay that can be set (e.g. 1 day) to prevent bypass.
    uint256 public constant MIN_DELAY = 1 days;

    /// @dev Maximum delay cap (e.g. 2 days).
    uint256 public constant MAX_DELAY = 2 days;
    /// @dev Fixed delay for ProxyAdmin ownership transfer handover.
    uint256 public constant OWNERSHIP_TRANSFER_DELAY = 2 days;

    /// @dev Current delay that must pass between schedule and execute.
    uint256 public delay;

    /// @dev operationId => timestamp when the operation was scheduled (0 = not scheduled or executed/cancelled).
    mapping(bytes32 => uint256) public scheduledAt;
    /// @dev ownershipOperationId => timestamp when the ownership transfer was scheduled.
    mapping(bytes32 => uint256) public scheduledOwnershipTransferAt;

    /**
     * @param initialOwner The single owner (e.g. multisig) that can schedule, execute, cancel, and set delay.
     * @param initialDelay Initial timelock delay (must be between MIN_DELAY and MAX_DELAY).
     */
    constructor(address initialOwner, uint256 initialDelay) Ownable(initialOwner) {
        if (initialDelay < MIN_DELAY) revert DelayTooShort(initialDelay, MIN_DELAY);
        if (initialDelay > MAX_DELAY) revert DelayTooLong(initialDelay, MAX_DELAY);
        delay = initialDelay;
        emit DelayUpdated(0, initialDelay);
    }

    /**
     * @dev Returns the unique id for a scheduled upgrade.
     */
    function getOperationId(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes memory data
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(proxyAdmin, proxy, implementation, data));
    }

    /**
     * @dev Returns the unique id for a scheduled ProxyAdmin ownership transfer.
     */
    function getOwnershipTransferOperationId(
        address proxyAdmin,
        address newOwner
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(proxyAdmin, newOwner));
    }

    /**
     * @dev Schedules an upgrade. Only the owner can call. Same operation can be rescheduled (overwrites).
     */
    function scheduleUpgrade(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external onlyOwner {
        bytes32 opId = getOperationId(proxyAdmin, proxy, implementation, data);
        if (scheduledAt[opId] != 0) revert OperationAlreadyScheduled(opId);
        scheduledAt[opId] = block.timestamp;
        emit UpgradeScheduled(proxyAdmin, proxy, implementation, opId);
    }

    /**
     * @dev Executes a previously scheduled upgrade after the delay has passed.
     *      Forwards msg.value to ProxyAdmin.upgradeAndCall for upgrade-and-initialize flows.
     */
    function executeUpgrade(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external payable onlyOwner {
        bytes32 opId = getOperationId(proxyAdmin, proxy, implementation, data);
        uint256 at = scheduledAt[opId];
        if (at == 0) revert OperationNotScheduled(opId);

        uint256 executeAfter = at + delay;
        if (block.timestamp < executeAfter) {
            revert DelayNotElapsed(opId, executeAfter, block.timestamp);
        }

        delete scheduledAt[opId];
        IProxyAdmin(proxyAdmin).upgradeAndCall{value: msg.value}(proxy, implementation, data);
        emit UpgradeExecuted(proxyAdmin, proxy, implementation, opId);
    }

    /**
     * @dev Cancels a scheduled upgrade. Only the owner can call.
     */
    function cancelUpgrade(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external onlyOwner {
        bytes32 opId = getOperationId(proxyAdmin, proxy, implementation, data);
        if (scheduledAt[opId] == 0) revert OperationNotScheduled(opId);
        delete scheduledAt[opId];
        emit UpgradeCancelled(proxyAdmin, proxy, implementation, opId);
    }

    /**
     * @dev Updates the timelock delay. Only the owner. New delay must be between MIN_DELAY and MAX_DELAY.
     */
    function setDelay(uint256 newDelay) external onlyOwner {
        if (newDelay < MIN_DELAY) revert DelayTooShort(newDelay, MIN_DELAY);
        if (newDelay > MAX_DELAY) revert DelayTooLong(newDelay, MAX_DELAY);
        uint256 previousDelay = delay;
        if (newDelay < previousDelay) revert DelayTooShort(newDelay, previousDelay);
        delay = newDelay;
        emit DelayUpdated(previousDelay, newDelay);
    }

    /**
     * @dev Returns the timestamp after which the given operation can be executed (schedule time + delay).
     */
    function getExecuteAfter(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external view returns (uint256) {
        bytes32 opId = getOperationId(proxyAdmin, proxy, implementation, data);
        uint256 at = scheduledAt[opId];
        return at == 0 ? 0 : at + delay;
    }

    /**
     * @dev Schedules a ProxyAdmin ownership transfer. Only owner.
     *      This path is always guarded by a fixed 30-day delay.
     */
    function scheduleProxyAdminOwnershipTransfer(
        address proxyAdmin,
        address newOwner
    ) external onlyOwner {
        bytes32 opId = getOwnershipTransferOperationId(proxyAdmin, newOwner);
        if (scheduledOwnershipTransferAt[opId] != 0) revert OperationAlreadyScheduled(opId);
        scheduledOwnershipTransferAt[opId] = block.timestamp;
        emit ProxyAdminOwnershipTransferScheduled(proxyAdmin, newOwner, opId);
    }

    /**
     * @dev Executes a scheduled ProxyAdmin ownership transfer after 30 days.
     */
    function executeProxyAdminOwnershipTransfer(
        address proxyAdmin,
        address newOwner
    ) external onlyOwner {
        bytes32 opId = getOwnershipTransferOperationId(proxyAdmin, newOwner);
        uint256 at = scheduledOwnershipTransferAt[opId];
        if (at == 0) revert OperationNotScheduled(opId);

        uint256 executeAfter = at + OWNERSHIP_TRANSFER_DELAY;
        if (block.timestamp < executeAfter) {
            revert DelayNotElapsed(opId, executeAfter, block.timestamp);
        }

        delete scheduledOwnershipTransferAt[opId];
        IProxyAdmin(proxyAdmin).transferOwnership(newOwner);
        emit ProxyAdminOwnershipTransferExecuted(proxyAdmin, newOwner, opId);
    }

    /**
     * @dev Cancels a scheduled ProxyAdmin ownership transfer.
     */
    function cancelProxyAdminOwnershipTransfer(
        address proxyAdmin,
        address newOwner
    ) external onlyOwner {
        bytes32 opId = getOwnershipTransferOperationId(proxyAdmin, newOwner);
        if (scheduledOwnershipTransferAt[opId] == 0) revert OperationNotScheduled(opId);
        delete scheduledOwnershipTransferAt[opId];
        emit ProxyAdminOwnershipTransferCancelled(proxyAdmin, newOwner, opId);
    }

    /**
     * @dev Returns timestamp after which ownership transfer can execute.
     */
    function getOwnershipTransferExecuteAfter(
        address proxyAdmin,
        address newOwner
    ) external view returns (uint256) {
        bytes32 opId = getOwnershipTransferOperationId(proxyAdmin, newOwner);
        uint256 at = scheduledOwnershipTransferAt[opId];
        return at == 0 ? 0 : at + OWNERSHIP_TRANSFER_DELAY;
    }
}
