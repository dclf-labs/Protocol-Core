// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingVaultUpgradeableHyperlane is IERC20 {
    // Structs
    struct WithdrawalDemand {
        uint256 timestamp;
        uint256 askedShares;
    }

    // Events
    event Rebase(uint256 amount);
    event WithdrawPeriodUpdated(uint256 newPeriod);
    event WithdrawalDemandCreated(address indexed user, uint256 assets, uint256 timestamp);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event HyperlaneTransfer(
        uint32 indexed destinationOrOriginDomain,
        bytes32 indexed recipientOrSender,
        uint256 amount,
        bool isSending
    );
    event RemoteTokenSet(uint32 indexed domain, bytes32 indexed remoteToken);
    event HyperlaneConfigured(address mailbox);
    event Whitelisted(address indexed account);
    event Unwhitelisted(address indexed account);

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
    error NoSharesMinted();
    error HyperlaneNotEnabled();
    error InvalidAmount();
    error InvalidRemoteToken();
    error InvalidRecipient();
    error InsufficientInterchainFee();
    error OnlyMailboxAllowed();
    error RemoteTokenNotRegistered();

    // Functions
    function rebase(uint256 _amount) external;

    function blacklistAccount(address account) external;

    function unblacklistAccount(address account) external;

    function rescueToken(IERC20 token, address to, uint256 amount) external;
}
