// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Interface for OpenZeppelin ProxyAdmin compatible contracts.
 * Proxy is typed as address for compatibility; it must be an ITransparentUpgradeableProxy.
 */
interface IProxyAdmin {
    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes memory data
    ) external payable;

    function transferOwnership(address newOwner) external;
}
