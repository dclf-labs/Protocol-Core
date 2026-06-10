// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockProxyAdmin {
    event UpgradeAndCallReceived(
        address proxy,
        address implementation,
        bytes data,
        uint256 value
    );
    event TransferOwnershipReceived(address newOwner);

    address public lastProxy;
    address public lastImplementation;
    bytes public lastData;
    uint256 public lastValue;
    uint256 public upgradeAndCallCount;

    address public lastNewOwner;
    uint256 public transferOwnershipCount;

    bool public shouldRevert;
    string public revertReason;

    function setShouldRevert(bool _shouldRevert, string calldata _reason) external {
        shouldRevert = _shouldRevert;
        revertReason = _reason;
    }

    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes calldata data
    ) external payable {
        if (shouldRevert) revert(revertReason);
        lastProxy = proxy;
        lastImplementation = implementation;
        lastData = data;
        lastValue = msg.value;
        upgradeAndCallCount++;
        emit UpgradeAndCallReceived(proxy, implementation, data, msg.value);
    }

    function transferOwnership(address newOwner) external {
        if (shouldRevert) revert(revertReason);
        lastNewOwner = newOwner;
        transferOwnershipCount++;
        emit TransferOwnershipReceived(newOwner);
    }

    receive() external payable {}
}
