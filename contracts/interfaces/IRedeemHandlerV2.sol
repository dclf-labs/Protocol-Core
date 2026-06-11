// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IRedeemHandlerV2 {
    // ============ Enums ============

    enum QueueStatus {
        PENDING,
        APPROVED,
        REJECTED,
        EXPIRED
    }

    // ============ Structs ============

    struct RedeemOrder {
        string message;
        address user;
        address collateralAddress;
        uint256 collateralAmount;
        uint256 usnAmount;
        uint256 expiry;
        uint256 nonce;
    }

    struct QueuedRedeem {
        address user;
        address collateralAddress;
        uint256 usnAmount;
        uint256 collateralAmount;
        uint256 price;
        uint256 queuedAt;
        QueueStatus status;
    }

    // ============ Events ============

    event Redeemed(
        address indexed user,
        address indexed collateralAddress,
        uint256 usnAmount,
        uint256 collateralAmount
    );

    event DirectRedeem(
        address indexed user,
        uint256 usnAmount,
        uint256 collateralAmount,
        address indexed collateralAddress,
        uint256 priceUsed
    );

    event RedeemQueued(uint256 indexed queueId, address indexed user, address collateralAddress, uint256 usnAmount, uint256 collateralAmount, uint256 price);
    event RedeemApproved(uint256 indexed queueId, address indexed admin);
    event RedeemRejected(uint256 indexed queueId, address indexed admin);
    event RedeemClaimed(uint256 indexed queueId, address indexed recipient, address collateralAddress, uint256 collateralAmount);
    event RedeemReclaimed(uint256 indexed queueId, address indexed user, uint256 usnAmount);

    event CollateralAdded(address indexed collateral);
    event CollateralRemoved(address indexed collateral);
    event CollateralOracleUpdated(address indexed collateral, address indexed oracle);
    event RedeemLimitPerBlockUpdated(uint256 indexed redeemLimitPerBlock);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OracleDataUsed(address indexed collateral, int256 price, uint256 updatedAt);
    event WhitelistedUserAdded(address indexed user);
    event WhitelistedUserRemoved(address indexed user);
    event PriceFeedSet(address indexed collateral, address indexed priceFeed);
    event PriceThresholdUpdated(uint256 newThresholdBps);
    event DirectRedeemLimitUpdated(uint256 newLimit);
    event OracleStalenessThresholdUpdated(uint256 newThreshold);

    // ============ Errors ============

    error ZeroAddress();
    error ZeroOracleAddress();
    error ZeroAmount();
    error CollateralAlreadyAdded();
    error CollateralNotFound();
    error InvalidCollateralAddress();
    error InvalidCollateralAmount(uint256 orderAmount, uint256 calculatedAmount);
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error InsufficientAllowance();
    error RedeemLimitExceeded(uint256 limit, uint256 requested);
    error TreasuryNotSet();
    error InsufficientTreasuryBalance(address collateral, uint256 required, uint256 available);
    error OracleNotSet(address collateral);
    error InvalidOraclePrice(int256 price);
    error StaleOracleData(uint256 updatedAt, uint256 threshold);
    error UserNotWhitelisted(address user);
    error UserAlreadyWhitelisted(address user);
    error PriceFeedNotSet(address collateral);
    error StalePrice(uint256 updatedAt, uint256 currentTime);
    error InvalidPrice(int256 price);
    error DirectRedeemLimitExceeded(uint256 limit, uint256 requested);
    error QueueNotFound(uint256 queueId);
    error QueueNotPending(uint256 queueId);
    error QueueNotExpired(uint256 queueId);
    error QueueExpired(uint256 queueId);

    // ============ External Functions ============

    function redeem(RedeemOrder calldata order, bytes calldata signature) external;

    function redeemWithPermit(
        RedeemOrder calldata order,
        bytes calldata signature,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function directRedeem(
        address collateralAddress,
        uint256 usnAmount,
        uint256 minCollateralAmount
    ) external returns (uint256 queueId);

    function approveQueuedRedeem(uint256 queueId) external;
    function rejectQueuedRedeem(uint256 queueId) external;
    function cancelQueuedRedeem(uint256 queueId) external;
    function reclaimExpiredRedeem(uint256 queueId) external;

    function previewDirectRedeem(
        address collateralAddress,
        uint256 usnAmount
    ) external view returns (uint256 collateralAmount, uint256 priceUsed);

    function addRedeemableCollateral(address collateral, address oracle) external;
    function removeRedeemableCollateral(address collateral) external;
    function updateCollateralOracle(address collateral, address oracle) external;
    function setRedeemLimitPerBlock(uint256 _redeemLimitPerBlock) external;
    function setTreasury(address _treasury) external;
    function setPriceFeed(address collateral, address priceFeed) external;
    function setPriceThreshold(uint256 thresholdBps) external;
    function setDirectRedeemLimitPerDay(uint256 limit) external;
    function setOracleStalenessThreshold(uint256 threshold) external;
    function addWhitelistedUser(address user) external;
    function removeWhitelistedUser(address user) external;

    // ============ View Functions ============

    function redeemableCollaterals(address collateral) external view returns (bool);
    function hashOrder(RedeemOrder calldata order) external view returns (bytes32);
    function encodeOrder(RedeemOrder calldata order) external pure returns (bytes memory);
    function getCollateralPrice(address collateral) external view returns (int256 price, uint256 updatedAt);
    function calculateCollateralAmount(address collateral, uint256 usnAmount) external view returns (uint256);
    function getTreasuryBalance(address collateral) external view returns (uint256);
    function isWhitelisted(address user) external view returns (bool);
    function getQueuedRedeem(uint256 queueId) external view returns (QueuedRedeem memory);
    function priceFeeds(address collateral) external view returns (address);
    function priceThresholdBps() external view returns (uint256);
    function directRedeemLimitPerDay() external view returns (uint256);
    function currentDayDirectRedeemAmount() external view returns (uint256);
    function oracleStalenessThreshold() external view returns (uint256);
    function nextQueueId() external view returns (uint256);
    function QUEUE_EXPIRY() external view returns (uint256);
}
