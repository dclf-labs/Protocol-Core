// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITimelock {
    event UpgradeScheduled(
        address indexed proxyAdmin,
        address indexed proxy,
        address implementation,
        bytes32 operationId
    );
    event UpgradeExecuted(
        address indexed proxyAdmin,
        address indexed proxy,
        address implementation,
        bytes32 operationId
    );
    event UpgradeCancelled(
        address indexed proxyAdmin,
        address indexed proxy,
        address implementation,
        bytes32 operationId
    );
    event DelayUpdated(uint256 previousDelay, uint256 newDelay);
    event ProxyAdminOwnershipTransferScheduled(
        address indexed proxyAdmin,
        address indexed newOwner,
        bytes32 operationId
    );
    event ProxyAdminOwnershipTransferExecuted(
        address indexed proxyAdmin,
        address indexed newOwner,
        bytes32 operationId
    );
    event ProxyAdminOwnershipTransferCancelled(
        address indexed proxyAdmin,
        address indexed newOwner,
        bytes32 operationId
    );

    error OperationNotScheduled(bytes32 operationId);
    error OperationAlreadyScheduled(bytes32 operationId);
    error DelayNotElapsed(bytes32 operationId, uint256 executeAfter, uint256 currentTime);
    error DelayTooShort(uint256 requested, uint256 minDelay);
    error DelayTooLong(uint256 requested, uint256 maxDelay);
}
