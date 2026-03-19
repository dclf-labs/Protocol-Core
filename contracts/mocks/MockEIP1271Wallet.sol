// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockEIP1271Wallet is IERC1271 {
    address public owner;
    bool public returnValid;

    mapping(address => mapping(address => uint256)) public allowances;

    constructor(address _owner) {
        owner = _owner;
        returnValid = true;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) public view override returns (bytes4 magicValue) {
        if (returnValid) {
            address signer = ECDSA.recover(hash, signature);
            if (signer == owner) {
                return IERC1271.isValidSignature.selector;
            }
        }
        return 0xffffffff;
    }

    function setIsValidSignature(bool _isValid) external {
        returnValid = _isValid;
    }

    function approve(address token, address spender, uint256 amount) external {
        require(msg.sender == owner, "Only owner can approve");
        allowances[token][spender] = amount;
        IERC20(token).approve(spender, amount);
    }

    function allowance(address token, address spender) external view returns (uint256) {
        return allowances[token][spender];
    }
}
