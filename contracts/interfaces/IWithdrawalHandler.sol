// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IWithdrawalHandler {
    function createWithdrawalRequest(address user, uint256 amount) external returns (uint256);
} 