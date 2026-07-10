// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./periphery/USN.sol";
import "./interfaces/IRedeemHandlerV2.sol";

/**
 * @title IChainlinkPriceFeed
 * @notice Interface for Chainlink price feeds
 */
interface IChainlinkPriceFeed {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

contract RedeemHandlerV2 is IRedeemHandlerV2, ReentrancyGuard, Pausable, AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    // Constants
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    // Approver is separate from DEFAULT_ADMIN_ROLE so the party that sets the
    // daily approval cap cannot also approve queued redeems against it.
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
    bytes32 private constant REDEEM_TYPEHASH =
        keccak256(
            "RedeemOrder(string message,address user,address collateralAddress,uint256 collateralAmount,uint256 usnAmount,uint256 expiry,uint256 nonce)"
        );

    // Price constants (8 decimals to match Chainlink)
    uint256 public constant PRICE_PRECISION = 1e8;
    uint256 public constant ONE_USD = 1e8; // $1.00 with 8 decimals

    // State variables
    USN public immutable usnToken;
    address public treasury;
    uint256 public redeemLimitPerBlock;
    uint256 public currentBlockRedeemAmount;
    uint256 public lastRedeemBlock;

    // Direct redeem config
    uint256 public priceThresholdBps = 100; // 1% = 100 bps (0.99 - 1.01)
    uint256 public oracleStalenessThreshold = 1 hours;

    // Daily cap enforced at approval time (approver-side rate limit).
    uint256 public directRedeemLimitPerDay;
    uint256 public currentDayDirectRedeemApproved;
    uint256 public lastDirectRedeemApprovalDay;

    // Minimum USN amount for a direct redeem — prevents dust queue spam.
    uint256 public minDirectRedeemAmount;

    // Mappings
    mapping(address => bool) public whitelistedUsers;
    mapping(address => bool) private _redeemableCollaterals;
    mapping(address => mapping(uint256 => bool)) private usedNonces;

    // Oracle mappings (collateral => Chainlink price feed)
    mapping(address => address) public priceFeeds;

    // Queue system
    uint256 public nextQueueId = 1; // starts at 1 so 0 means "not queued"
    uint256 public constant QUEUE_EXPIRY = 48 hours;
    mapping(uint256 => QueuedRedeem) public queuedRedeems;

    // Constructor
    constructor(address _usnToken) EIP712("RedeemHandlerV2", "1") {
        if (_usnToken == address(0)) {
            revert ZeroAddress();
        }
        usnToken = USN(_usnToken);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        redeemLimitPerBlock = 1000000 * 10 ** 18; // Default limit: 1 million USN
        directRedeemLimitPerDay = 100000 * 10 ** 18; // Default: 100k USN per day of approved direct redeems
        minDirectRedeemAmount = 1e18; // Default: 1 USN — blocks dust queue spam
    }

    // ============ External Functions ============

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) {
            revert ZeroAddress();
        }
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    function setRedeemLimitPerBlock(uint256 _redeemLimitPerBlock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        redeemLimitPerBlock = _redeemLimitPerBlock;
        emit RedeemLimitPerBlockUpdated(_redeemLimitPerBlock);
    }

    function addRedeemableCollateral(address collateral, address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (collateral == address(0)) revert ZeroAddress();
        if (oracle == address(0)) revert ZeroOracleAddress();
        if (_redeemableCollaterals[collateral]) revert CollateralAlreadyAdded();

        _redeemableCollaterals[collateral] = true;
        priceFeeds[collateral] = oracle;

        emit CollateralAdded(collateral);
        emit CollateralOracleUpdated(collateral, oracle);
    }

    function removeRedeemableCollateral(address collateral) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_redeemableCollaterals[collateral]) revert CollateralNotFound();
        _redeemableCollaterals[collateral] = false;
        delete priceFeeds[collateral];
        emit CollateralRemoved(collateral);
    }

    function updateCollateralOracle(address collateral, address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle == address(0)) revert ZeroOracleAddress();
        if (!_redeemableCollaterals[collateral]) revert CollateralNotFound();

        priceFeeds[collateral] = oracle;
        emit CollateralOracleUpdated(collateral, oracle);
    }

    function redeemableCollaterals(address collateral) external view returns (bool) {
        return _redeemableCollaterals[collateral];
    }

    function redeem(
        RedeemOrder calldata order,
        bytes calldata signature
    ) public nonReentrant whenNotPaused onlyRole(BURNER_ROLE) {
        if (!whitelistedUsers[order.user]) {
            revert UserNotWhitelisted(order.user);
        }
        if (!_redeemableCollaterals[order.collateralAddress]) {
            revert InvalidCollateralAddress();
        }
        if (block.timestamp > order.expiry) {
            revert SignatureExpired();
        }
        if (usedNonces[order.user][order.nonce]) {
            revert InvalidNonce();
        }
        if (order.usnAmount == 0) {
            revert ZeroAmount();
        }

        bytes32 hash = hashOrder(order);

        if (!_isValidSignature(order.user, hash, signature)) {
            revert InvalidSignature();
        }

        uint256 currentAllowance = usnToken.allowance(order.user, address(this));
        if (currentAllowance < order.usnAmount) revert InsufficientAllowance();

        if (block.number > lastRedeemBlock) {
            currentBlockRedeemAmount = 0;
            lastRedeemBlock = block.number;
        }

        if (currentBlockRedeemAmount + order.usnAmount > redeemLimitPerBlock) {
            revert RedeemLimitExceeded(redeemLimitPerBlock, currentBlockRedeemAmount + order.usnAmount);
        }

        if (treasury == address(0)) revert TreasuryNotSet();

        // Calculate collateral amount based on oracle price
        uint256 calculatedCollateralAmount = _calculateCollateralFromOracle(order.collateralAddress, order.usnAmount);

        // Check treasury has sufficient balance
        uint256 treasuryBalance = IERC20(order.collateralAddress).balanceOf(treasury);
        if (treasuryBalance < calculatedCollateralAmount) {
            revert InsufficientTreasuryBalance(order.collateralAddress, calculatedCollateralAmount, treasuryBalance);
        }

        if (order.collateralAmount == 0) revert ZeroAmount();

        // Validate that order.collateralAmount is not more advantageous than calculated amount
        if (order.collateralAmount > calculatedCollateralAmount) {
            revert InvalidCollateralAmount(order.collateralAmount, calculatedCollateralAmount);
        }

        usedNonces[order.user][order.nonce] = true;
        currentBlockRedeemAmount += order.usnAmount;

        usnToken.burnFrom(order.user, order.usnAmount);

        // Transfer collateral from treasury to user
        IERC20(order.collateralAddress).safeTransferFrom(treasury, order.user, calculatedCollateralAmount);

        emit Redeemed(order.user, order.collateralAddress, order.usnAmount, calculatedCollateralAmount);
    }

    function redeemWithPermit(
        RedeemOrder calldata order,
        bytes calldata signature,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused onlyRole(BURNER_ROLE) {
        if (!whitelistedUsers[order.user]) revert UserNotWhitelisted(order.user);
        bytes32 hash = hashOrder(order);
        if (!_isValidSignature(order.user, hash, signature)) revert InvalidSignature();

        try
            IERC20Permit(address(usnToken)).permit(order.user, address(this), order.usnAmount, order.expiry, v, r, s)
        {} catch {}

        redeem(order, signature);
    }

    /**
     * @notice Direct redeem function - queues a redeem request for admin approval
     * @dev All direct redeems are queued and require manual admin approval to execute.
     *      This prevents cycling attacks (e.g. directMint -> directRedeem in one tx) from
     *      draining the redeem limits and blocking legitimate redeemers.
     *      Uses Chainlink price feeds to lock the exchange rate at queue time:
     *      - If price is within threshold of $1.00 (default 1%): redeem 1:1
     *      - If price < lower bound: use peg price (protocol protection, user gets less collateral)
     *      - If price > upper bound: use actual price (user gets less collateral, fair market value)
     * @param collateralAddress The collateral token address (USDC, USDT, etc.)
     * @param usnAmount The amount of USN to burn
     * @param minCollateralAmount Minimum collateral amount to receive (slippage protection)
     */
    function directRedeem(
        address collateralAddress,
        uint256 usnAmount,
        uint256 minCollateralAmount
    ) external nonReentrant whenNotPaused returns (uint256 queueId) {
        // Verify user is whitelisted
        if (!whitelistedUsers[msg.sender]) {
            revert UserNotWhitelisted(msg.sender);
        }

        // Verify collateral is redeemable
        if (!_redeemableCollaterals[collateralAddress]) {
            revert InvalidCollateralAddress();
        }

        // Verify price feed exists
        address priceFeed = priceFeeds[collateralAddress];
        if (priceFeed == address(0)) {
            revert PriceFeedNotSet(collateralAddress);
        }

        if (treasury == address(0)) revert TreasuryNotSet();

        // Amount / balance / allowance / min-size checks.
        _antiSpamCheck(msg.sender, usnAmount);

        // Get price from oracle
        uint256 price = _getPrice(priceFeed);

        // Calculate collateral amount based on price logic
        uint256 collateralAmount = _calculateCollateralAmount(collateralAddress, usnAmount, price);

        // Slippage protection
        if (collateralAmount < minCollateralAmount) {
            revert InvalidCollateralAmount(minCollateralAmount, collateralAmount);
        }

        // Soft treasury balance check at queue time — treasury balance is re-checked implicitly
        // at approval time by safeTransferFrom in approveQueuedRedeem.
        uint256 treasuryBalance = IERC20(collateralAddress).balanceOf(treasury);
        if (treasuryBalance < collateralAmount) {
            revert InsufficientTreasuryBalance(collateralAddress, collateralAmount, treasuryBalance);
        }

        // All direct redeems go through the queue for admin verification.
        queueId = nextQueueId++;
        queuedRedeems[queueId] = QueuedRedeem({
            user: msg.sender,
            collateralAddress: collateralAddress,
            usnAmount: usnAmount,
            collateralAmount: collateralAmount,
            price: price,
            queuedAt: block.timestamp,
            status: QueueStatus.PENDING
        });

        emit RedeemQueued(queueId, msg.sender, collateralAddress, usnAmount, collateralAmount, price);
        return queueId;
    }

    // ============ Queue Functions ============

    /**
     * @notice Approver executes a queued redeem in one step
     * @dev Burns USN from user and sends collateral at the price locked at queue time.
     *      Enforces a daily cap on approved amounts; the cap is set by DEFAULT_ADMIN_ROLE,
     *      not by APPROVER_ROLE, so an approver cannot silently raise their own limit.
     */
    function approveQueuedRedeem(uint256 _queueId) external nonReentrant whenNotPaused onlyRole(APPROVER_ROLE) {
        QueuedRedeem storage q = queuedRedeems[_queueId];
        if (q.queuedAt == 0) revert QueueNotFound(_queueId);
        if (q.status != QueueStatus.PENDING) revert QueueNotPending(_queueId);
        if (block.timestamp > q.queuedAt + QUEUE_EXPIRY) revert QueueExpired(_queueId);

        // Re-validate — state may have changed during the 48h window. If the
        // user was de-KYB'd, the collateral delisted (e.g. after a depeg), or
        // the treasury drained, we must not execute at the queue-time price.
        if (!whitelistedUsers[q.user]) revert UserNotWhitelisted(q.user);
        if (!_redeemableCollaterals[q.collateralAddress]) revert InvalidCollateralAddress();
        if (treasury == address(0)) revert TreasuryNotSet();
        uint256 treasuryBalance = IERC20(q.collateralAddress).balanceOf(treasury);
        if (treasuryBalance < q.collateralAmount) {
            revert InsufficientTreasuryBalance(q.collateralAddress, q.collateralAmount, treasuryBalance);
        }

        // Enforce daily cap on approved amount.
        uint256 currentDay = block.timestamp / 1 days;
        uint256 dayApproved = currentDay > lastDirectRedeemApprovalDay ? 0 : currentDayDirectRedeemApproved;
        uint256 newDayApproved = dayApproved + q.usnAmount;
        if (newDayApproved > directRedeemLimitPerDay) {
            revert DirectRedeemLimitExceeded(directRedeemLimitPerDay, newDayApproved);
        }
        currentDayDirectRedeemApproved = newDayApproved;
        lastDirectRedeemApprovalDay = currentDay;

        q.status = QueueStatus.APPROVED;

        // Execute immediately: burn USN from user and send collateral
        usnToken.burnFrom(q.user, q.usnAmount);
        IERC20(q.collateralAddress).safeTransferFrom(treasury, q.user, q.collateralAmount);

        emit RedeemApproved(_queueId, msg.sender);
        emit RedeemClaimed(_queueId, q.user, q.collateralAddress, q.collateralAmount);
    }

    /**
     * @notice Approver rejects a queued redeem
     */
    function rejectQueuedRedeem(uint256 _queueId) external onlyRole(APPROVER_ROLE) {
        QueuedRedeem storage q = queuedRedeems[_queueId];
        if (q.queuedAt == 0) revert QueueNotFound(_queueId);
        if (q.status != QueueStatus.PENDING) revert QueueNotPending(_queueId);

        q.status = QueueStatus.REJECTED;
        emit RedeemRejected(_queueId, msg.sender);
    }

    /**
     * @notice User cancels their own pending queued redeem
     */
    function cancelQueuedRedeem(uint256 _queueId) external {
        QueuedRedeem storage q = queuedRedeems[_queueId];
        if (q.queuedAt == 0) revert QueueNotFound(_queueId);
        if (q.status != QueueStatus.PENDING) revert QueueNotPending(_queueId);
        if (msg.sender != q.user) revert UserNotWhitelisted(msg.sender);

        q.status = QueueStatus.REJECTED;
        emit RedeemRejected(_queueId, msg.sender);
    }

    /**
     * @notice Mark an expired queued redeem (callable by anyone after 24h)
     */
    function reclaimExpiredRedeem(uint256 _queueId) external {
        QueuedRedeem storage q = queuedRedeems[_queueId];
        if (q.queuedAt == 0) revert QueueNotFound(_queueId);
        if (q.status != QueueStatus.PENDING) revert QueueNotPending(_queueId);
        if (block.timestamp <= q.queuedAt + QUEUE_EXPIRY) revert QueueNotExpired(_queueId);

        q.status = QueueStatus.EXPIRED;
        emit RedeemReclaimed(_queueId, q.user, q.usnAmount);
    }

    function getQueuedRedeem(uint256 _queueId) external view returns (QueuedRedeem memory) {
        QueuedRedeem memory q = queuedRedeems[_queueId];
        if (q.queuedAt == 0) revert QueueNotFound(_queueId);
        return q;
    }

    /**
     * @notice Preview how much collateral would be received for a given USN amount
     * @param collateralAddress The collateral token address
     * @param usnAmount The amount of USN to burn
     * @return collateralAmount The amount of collateral that would be received
     * @return priceUsed The price used for calculation (8 decimals)
     */
    function previewDirectRedeem(
        address collateralAddress,
        uint256 usnAmount
    ) external view returns (uint256 collateralAmount, uint256 priceUsed) {
        address priceFeed = priceFeeds[collateralAddress];
        if (priceFeed == address(0)) {
            revert PriceFeedNotSet(collateralAddress);
        }

        priceUsed = _getPrice(priceFeed);
        collateralAmount = _calculateCollateralAmount(collateralAddress, usnAmount, priceUsed);
    }

    /**
     * @notice Calculate collateral amount based on USN and price
     * @dev Price logic:
     *      - Within threshold (0.99-1.01 by default): 1:1 redeem
     *      - Below lower bound: use peg price (less collateral, protects protocol)
     *      - Above upper bound: use actual price (less collateral, fair market)
     */
    function _calculateCollateralAmount(
        address collateralAddress,
        uint256 usnAmount,
        uint256 price
    ) internal view returns (uint256) {
        uint256 collDecimals = IERC20Metadata(collateralAddress).decimals();
        uint256 usnDecimals = usnToken.decimals();

        // Normalize USN to 18 decimals
        uint256 normalizedUsn = usnAmount * 10 ** (18 - usnDecimals);

        // Calculate bounds
        uint256 lowerBound = ONE_USD - (ONE_USD * priceThresholdBps / 10000); // e.g., 0.99 USD
        uint256 upperBound = ONE_USD + (ONE_USD * priceThresholdBps / 10000); // e.g., 1.01 USD

        uint256 collateralAmount;

        if (price >= lowerBound && price <= upperBound) {
            // Within threshold: 1:1 redeem
            collateralAmount = normalizedUsn;
        } else if (price < lowerBound) {
            // Below threshold: use peg price (protect protocol, user gets less collateral)
            // collateral = usn * ONE_USD / ONE_USD = usn (1:1 at peg)
            collateralAmount = normalizedUsn;
        } else {
            // Above threshold: use actual price (user gets less collateral)
            // collateral = usn * ONE_USD / price
            collateralAmount = (normalizedUsn * ONE_USD) / price;
        }

        // Convert from 18 decimals to collateral decimals
        if (collDecimals < 18) {
            collateralAmount = collateralAmount / 10 ** (18 - collDecimals);
        } else if (collDecimals > 18) {
            collateralAmount = collateralAmount * 10 ** (collDecimals - 18);
        }

        return collateralAmount;
    }

    // ============ Admin Functions for Direct Redeem ============

    /**
     * @notice Set price feed for a collateral token
     * @param collateral The collateral token address
     * @param priceFeed The Chainlink price feed address (collateral/USD)
     */
    function setPriceFeed(address collateral, address priceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (collateral == address(0)) revert ZeroAddress();
        priceFeeds[collateral] = priceFeed;
        emit PriceFeedSet(collateral, priceFeed);
    }

    /**
     * @notice Set price threshold in basis points
     * @param _thresholdBps Threshold in bps (100 = 1%)
     */
    function setPriceThreshold(uint256 _thresholdBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_thresholdBps <= 1000, "Threshold too high"); // Max 10%
        priceThresholdBps = _thresholdBps;
        emit PriceThresholdUpdated(_thresholdBps);
    }

    /**
     * @notice Set oracle staleness threshold
     * @param _threshold Staleness threshold in seconds
     */
    function setOracleStalenessThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracleStalenessThreshold = _threshold;
        emit OracleStalenessThresholdUpdated(_threshold);
    }

    /**
     * @notice Set the daily cap on approved direct redeem amount
     * @dev Restricted to DEFAULT_ADMIN_ROLE. APPROVER_ROLE (which consumes the cap in
     *      `approveQueuedRedeem`) is intentionally excluded so approvers cannot raise
     *      their own limit.
     */
    function setDirectRedeemLimitPerDay(uint256 _limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        directRedeemLimitPerDay = _limit;
        emit DirectRedeemLimitUpdated(_limit);
    }

    /**
     * @notice Set the minimum USN amount accepted by `directRedeem`
     * @dev Guards the queue from dust spam. Setting to 0 disables the min check
     *      (zero-amount calls still revert via ZeroAmount).
     */
    function setMinDirectRedeemAmount(uint256 _min) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minDirectRedeemAmount = _min;
        emit MinDirectRedeemAmountUpdated(_min);
    }

    /**
     * @notice Pause redeem entry points (`redeem`, `redeemWithPermit`, `directRedeem`, `approveQueuedRedeem`).
     * @dev Admin recovery paths (reject/cancel/reclaim) remain callable while paused.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function addWhitelistedUser(address user) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (user == address(0)) {
            revert ZeroAddress();
        }
        if (whitelistedUsers[user]) {
            revert UserAlreadyWhitelisted(user);
        }
        whitelistedUsers[user] = true;
        emit WhitelistedUserAdded(user);
    }

    function removeWhitelistedUser(address user) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!whitelistedUsers[user]) {
            revert UserNotWhitelisted(user);
        }
        whitelistedUsers[user] = false;
        emit WhitelistedUserRemoved(user);
    }

    // ============ Public Functions ============

    function hashOrder(RedeemOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(encodeOrder(order)));
    }

    function encodeOrder(RedeemOrder calldata order) public pure returns (bytes memory) {
        return
            abi.encode(
                REDEEM_TYPEHASH,
                keccak256(bytes(order.message)),
                order.user,
                order.collateralAddress,
                order.collateralAmount,
                order.usnAmount,
                order.expiry,
                order.nonce
            );
    }

    function getCollateralPrice(address collateral) public view returns (int256 price, uint256 updatedAt) {
        address priceFeed = priceFeeds[collateral];
        if (priceFeed == address(0)) revert OracleNotSet(collateral);

        IChainlinkPriceFeed oracle = IChainlinkPriceFeed(priceFeed);
        (, int256 answer, , uint256 updatedAt_, ) = oracle.latestRoundData();

        if (answer <= 0) revert InvalidOraclePrice(answer);
        if (block.timestamp - updatedAt_ > oracleStalenessThreshold) {
            revert StaleOracleData(updatedAt_, oracleStalenessThreshold);
        }

        return (answer, updatedAt_);
    }

    function calculateCollateralAmount(address collateral, uint256 usnAmount) external view returns (uint256) {
        return _calculateCollateralFromOracle(collateral, usnAmount);
    }

    function getTreasuryBalance(address collateral) external view returns (uint256) {
        if (treasury == address(0)) revert TreasuryNotSet();
        return IERC20(collateral).balanceOf(treasury);
    }

    function isWhitelisted(address user) public view returns (bool) {
        return whitelistedUsers[user];
    }

    // ============ Internal Functions ============

    /**
     * @notice Anti-spam gate applied to `directRedeem` at queue time.
     * @dev Enforces the four cheap conditions that make a queued redeem plausibly executable
     *      — non-zero amount, meets the configurable min-size, user actually holds the USN,
     *      user has approved this contract to burn it. This prevents an attacker from
     *      spamming the queue with entries that can never be approved (approver would just
     *      waste gas on failing `burnFrom`).
     */
    function _antiSpamCheck(address user, uint256 usnAmount) internal view {
        if (usnAmount == 0) revert ZeroAmount();
        if (usnAmount < minDirectRedeemAmount) {
            revert DirectRedeemAmountTooSmall(minDirectRedeemAmount, usnAmount);
        }
        uint256 balance = usnToken.balanceOf(user);
        if (balance < usnAmount) {
            revert InsufficientUserBalance(usnAmount, balance);
        }
        uint256 currentAllowance = usnToken.allowance(user, address(this));
        if (currentAllowance < usnAmount) revert InsufficientAllowance();
    }

    /**
     * @notice Calculate collateral amount using oracle price directly (for signed redeems)
     * @dev Uses max(price, pegPrice) to protect the protocol
     */
    function _calculateCollateralFromOracle(address collateral, uint256 usnAmount) internal view returns (uint256) {
        (int256 price, ) = getCollateralPrice(collateral);
        uint256 collateralPrice = uint256(price);
        uint256 collDecimals = IERC20Metadata(collateral).decimals();

        // Use the higher of actual price vs peg to protect the protocol
        uint256 effectivePrice = collateralPrice < ONE_USD ? ONE_USD : collateralPrice;

        uint256 baseCollateralAmount;
        if (collDecimals + 8 >= 18) {
            baseCollateralAmount = (usnAmount * (10 ** (collDecimals + 8 - 18))) / effectivePrice;
        } else {
            baseCollateralAmount = (usnAmount / (10 ** (18 - collDecimals - 8))) / effectivePrice;
        }

        return baseCollateralAmount;
    }

    /**
     * @notice Get price from Chainlink oracle
     */
    function _getPrice(address priceFeed) internal view returns (uint256) {
        IChainlinkPriceFeed oracle = IChainlinkPriceFeed(priceFeed);

        (
            ,
            int256 answer,
            ,
            uint256 updatedAt,
        ) = oracle.latestRoundData();

        // Check staleness
        if (block.timestamp - updatedAt > oracleStalenessThreshold) {
            revert StalePrice(updatedAt, block.timestamp);
        }

        // Check valid price
        if (answer <= 0) {
            revert InvalidPrice(answer);
        }

        // Normalize to 8 decimals (standard Chainlink precision)
        uint8 feedDecimals = oracle.decimals();
        if (feedDecimals == 8) {
            return uint256(answer);
        } else if (feedDecimals < 8) {
            return uint256(answer) * 10 ** (8 - feedDecimals);
        } else {
            return uint256(answer) / 10 ** (feedDecimals - 8);
        }
    }

    function _isValidSignature(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            // EOA
            return ECDSA.recover(hash, signature) == signer;
        } else {
            // Contract wallet
            try IERC1271(signer).isValidSignature(hash, signature) returns (bytes4 magicValue) {
                return magicValue == IERC1271.isValidSignature.selector;
            } catch {
                return false;
            }
        }
    }
}
