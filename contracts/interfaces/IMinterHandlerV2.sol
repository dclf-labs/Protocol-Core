// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMinterHandlerV2 {
    error ZeroAddress();
    error UserNotWhitelisted(address user);
    error CollateralNotWhitelisted(address collateral);
    error ZeroAmount();
    error CollateralUsnMismatch(uint256 collateralAmount, uint256 usnAmount);
    error MintLimitExceeded(uint256 limit, uint256 requested);
    error UserAlreadyWhitelisted(address user);
    error CollateralAlreadyWhitelisted(address collateral);

    // Errors for direct mint
    error PriceFeedNotSet(address collateral);
    error StalePrice(uint256 updatedAt, uint256 currentTime);
    error InvalidPrice(int256 price);
    error DirectMintLimitExceeded(uint256 limit, uint256 requested);
    error SUSNVaultNotSet();
    error CannotSetZero();
    error RebaseLimitExceeded(uint256 limit, uint256 requested);

    event CustodialWalletSet(address indexed custodialWallet);
    event MintLimitPerBlockUpdated(uint256 indexed mintLimitPerBlock);
    event WhitelistedUserAdded(address indexed user);
    event WhitelistedUserRemoved(address indexed user);
    event WhitelistedCollateralAdded(address indexed collateral);
    event WhitelistedCollateralRemoved(address indexed collateral);

        // Events for direct mint
    event DirectMint(address indexed user, uint256 collateralAmount, uint256 usnAmount, address collateralAddress, uint256 priceUsed);
    event PriceFeedSet(address indexed collateral, address indexed priceFeed);
    event PriceThresholdUpdated(uint256 newThresholdBps);
    event DirectMintLimitUpdated(uint256 newLimit);
    event OracleStalenessThresholdUpdated(uint256 newThreshold);
    event SUSNVaultSet(address indexed sUSNVault);
    event MintAndRebase(uint256 amount);
    event RebaseLimitUpdated(uint256 newLimit);
}