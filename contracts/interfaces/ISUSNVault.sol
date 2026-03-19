// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ISUSNVault
 * @notice Minimal interface for sUSN vault rebase (StakingVault)
 */
interface ISUSNVault {
    function rebase(uint256 _amount) external;
}
