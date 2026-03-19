// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMinterHandlerV2 {
    struct Order {
        string message;
        address user;
        address collateralAddress;
        uint256 collateralAmount;
        uint256 usnAmount;
        uint256 expiry;
        uint256 nonce;
    }

    error ZeroAddress();
    error UserNotWhitelisted(address user);
    error CollateralNotWhitelisted(address collateral);
    error SignatureExpired(uint256 expiry, uint256 currentTime);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error ZeroAmount();
    error CollateralUsnMismatch(uint256 collateralAmount, uint256 usnAmount);
    error InvalidSignature();
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
    event Mint(address indexed user, uint256 collateralAmount, uint256 usnAmount, address collateralAddress);
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

    function mint(Order calldata order, bytes calldata signature) external;
    function hashOrder(Order calldata order) external view returns (bytes32);
    function encodeOrder(Order calldata order) external pure returns (bytes memory);
}