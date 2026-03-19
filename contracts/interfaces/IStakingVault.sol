// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingVault is IERC20 {
    // Structs
    struct WithdrawalDemand {
        uint256 timestamp;
        uint256 askedShares;
    }

    // Events
    event Rebase(uint256 amount);
    event WithdrawPeriodUpdated(uint256 newPeriod);
    event WithdrawalDemandCreated(address indexed user, uint256 shares, uint256 timestamp);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // Custom errors
    error AssetTransferFailed();
    error InsufficientBalance();
    error WithdrawalExceedsDemand();
    error RedemptionExceedsDemand();
    error BlacklistedAddress();
    error CannotRescueVaultToken();
    error CannotRescueUnderlyingAsset();
    error WithdrawPeriodNotElapsed();
    error ExistingWithdrawalDemand();
    error CannotSetZero();
    error ZeroAddress();
    error Unauthorized();
    error ZeroAmount();
    error SlippageExceeded();

    // Functions
    function rebase(uint256 _amount) external;

    function setWithdrawPeriod(uint256 _newPeriod) external;

    function createWithdrawalDemand(uint256 shares, bool force) external;

    function blacklistAccount(address account) external;

    function unblacklistAccount(address account) external;

    function rescueToken(IERC20 token, address to, uint256 amount) external;
}
