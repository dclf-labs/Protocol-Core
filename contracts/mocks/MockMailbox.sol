// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockMailbox {
    event Dispatched(uint32 destinationDomain, bytes32 recipientAddress, bytes message);

    function quoteDispatch(uint32, bytes32, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function quoteDispatch(uint32, bytes32, bytes calldata, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _message
    ) external payable returns (bytes32) {
        emit Dispatched(_destinationDomain, _recipientAddress, _message);
        return bytes32(0);
    }

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _message,
        bytes calldata
    ) external payable returns (bytes32) {
        emit Dispatched(_destinationDomain, _recipientAddress, _message);
        return bytes32(0);
    }
}
