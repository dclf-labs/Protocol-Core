// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IUSN.sol";
import "./interfaces/IMinterHandlerV2.sol";
import "./interfaces/ISUSNVault.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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

contract MinterHandlerV2 is IMinterHandlerV2, ReentrancyGuard, AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    // Custom errors
    error ThresholdTooHigh(uint256 threshold, uint256 max);

    // Constants
    /// @dev MINTER_ROLE can be granted to any address, including multisig wallets (e.g. Gnosis Safe).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant ORDER_TYPEHASH =
        keccak256(
            "Order(string message,address user,address collateralAddress,uint256 collateralAmount,uint256 usnAmount,uint256 expiry,uint256 nonce)"
        );
    
    // Price constants (8 decimals to match Chainlink)
    uint256 public constant PRICE_PRECISION = 1e8;
    uint256 public constant ONE_USD = 1e8; // $1.00 with 8 decimals

    // State variables
    IUSN public immutable usnToken;
    address public custodialWallet;
    /// @dev sUSN vault (StakingVault) for mint-and-rebase; must grant REBASE_MANAGER_ROLE to this contract.
    address public sUSNVault;
    uint256 public mintLimitPerBlock;
    uint256 public currentBlockMintAmount;
    uint256 public lastMintBlock;
    /// @dev Max USN amount that can be rebased in a single mintAndRebase call; managed by DEFAULT_ADMIN_ROLE.
    uint256 public rebaseLimit;
    
    // Direct mint config
    uint256 public priceThresholdBps = 100; // 1% = 100 bps (0.99 - 1.01)
    uint256 public directMintLimitPerDay;
    uint256 public currentDayDirectMintAmount;
    uint256 public lastDirectMintDay;
    uint256 public oracleStalenessThreshold = 1 hours;

    // Mappings
    mapping(address => bool) public whitelistedUsers;
    mapping(address => bool) public whitelistedCollaterals;
    mapping(address => mapping(uint256 => bool)) private usedNonces;
    
    // Oracle mappings (collateral => Chainlink price feed)
    mapping(address => address) public priceFeeds;


    // Constructor
    constructor(address _usnToken) EIP712("MinterHandlerV2", "1") {
        if (_usnToken == address(0)) {
            revert ZeroAddress();
        }
        usnToken = IUSN(_usnToken);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        mintLimitPerBlock = 1000000 * 10 ** 18; // Default limit: 1 million USN
        directMintLimitPerDay = 100000 * 10 ** 18; // Default: 100k USN per day for direct mints
        rebaseLimit = 30000 * 10 ** 18; // Default: 30,000 USN per mintAndRebase call
    }
    // External functions
    function setCustodialWallet(address _custodialWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_custodialWallet == address(0)) {
            revert ZeroAddress();
        }
        custodialWallet = _custodialWallet;
        emit CustodialWalletSet(_custodialWallet);
    }

    function setMintLimitPerBlock(uint256 _mintLimitPerBlock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        mintLimitPerBlock = _mintLimitPerBlock;
        emit MintLimitPerBlockUpdated(_mintLimitPerBlock);
    }

    function setSUSNVault(address _sUSNVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_sUSNVault == address(0)) revert ZeroAddress();
        sUSNVault = _sUSNVault;
        emit SUSNVaultSet(_sUSNVault);
    }

    /**
     * @notice Set the maximum USN amount that can be rebased in a single mintAndRebase call.
     * @param _rebaseLimit Max amount (18 decimals)
     */
    function setRebaseLimit(uint256 _rebaseLimit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        rebaseLimit = _rebaseLimit;
        emit RebaseLimitUpdated(_rebaseLimit);
    }

    /**
     * @notice Mint USN and rebase the sUSN vault with that amount.
     * @dev Callable by MINTER_ROLE (e.g. multisig). Mints USN to this contract, then calls
     *      sUSNVault.rebase(amount). Requires: (1) sUSNVault set, (2) this contract has
     *      REBASE_MANAGER_ROLE on the vault.
     * @param amount Amount of USN to mint and transfer into the vault as rebase.
     */
    function mintAndRebase(uint256 amount) external nonReentrant onlyRole(MINTER_ROLE) {
        if (sUSNVault == address(0)) revert SUSNVaultNotSet();
        if (amount == 0) revert ZeroAmount();
        if (amount > rebaseLimit) revert RebaseLimitExceeded(rebaseLimit, amount);

        usnToken.mint(address(this), amount);
        IERC20(address(usnToken)).approve(sUSNVault, amount);
        ISUSNVault(sUSNVault).rebase(amount);

        emit MintAndRebase(amount);
    }

    function mint(Order calldata order, bytes calldata signature) external nonReentrant onlyRole(MINTER_ROLE) {
        if (!whitelistedUsers[order.user]) {
            revert UserNotWhitelisted(order.user);
        }
        if (!whitelistedCollaterals[order.collateralAddress]) {
            revert CollateralNotWhitelisted(order.collateralAddress);
        }
        if (block.timestamp > order.expiry) {
            revert SignatureExpired(order.expiry, block.timestamp);
        }
        if (usedNonces[order.user][order.nonce]) {
            revert NonceAlreadyUsed(order.user, order.nonce);
        }
        if ((order.collateralAmount == 0 || order.usnAmount == 0) && order.user != msg.sender) {
            revert ZeroAmount();
        }

        if (order.user != msg.sender) {
            uint256 collateralDecimals = IERC20Metadata(order.collateralAddress).decimals();
            uint256 usnDecimals = usnToken.decimals();

            uint256 normalizedCollateralAmount = order.collateralAmount * 10 ** (18 - collateralDecimals);
            uint256 normalizedUsnAmount = order.usnAmount * 10 ** (18 - usnDecimals);

            uint256 difference;
            if (normalizedCollateralAmount > normalizedUsnAmount) {
                difference = normalizedCollateralAmount - normalizedUsnAmount;
            } else {
                difference = normalizedUsnAmount - normalizedCollateralAmount;
            }

            // Calculate 2% of the larger amount
            uint256 twoPercent = (
                normalizedCollateralAmount > normalizedUsnAmount ? normalizedCollateralAmount : normalizedUsnAmount
            ) / 50;

            if (difference > twoPercent) {
                revert CollateralUsnMismatch(order.collateralAmount, order.usnAmount);
            }
        }

        bytes32 hash = hashOrder(order);

        if (!_isValidSignature(order.user, hash, signature)) {
            revert InvalidSignature();
        }

        if (block.number > lastMintBlock) {
            currentBlockMintAmount = 0;
            lastMintBlock = block.number;
        }

        if (currentBlockMintAmount + order.usnAmount > mintLimitPerBlock) {
            revert MintLimitExceeded(mintLimitPerBlock, currentBlockMintAmount + order.usnAmount);
        }

        usedNonces[order.user][order.nonce] = true;
        usnToken.mint(order.user, order.usnAmount);
        currentBlockMintAmount += order.usnAmount;

        _transferCollateral(order.collateralAddress, order.user, order.collateralAmount);

        emit Mint(order.user, order.collateralAmount, order.usnAmount, order.collateralAddress);
    }

    /**
     * @notice Direct mint function - allows whitelisted users to mint USN directly without MINTER_ROLE
     * @dev Uses Chainlink price feeds to determine the exchange rate
     *      - If price is within threshold of $1.00 (default 1%): mint 1:1
     *      - If price < lower bound: mint based on actual price (user gets less USN)
     *      - If price > upper bound: cap at 1:1 (user still gets 1:1, protocol takes no extra)
     * @param collateralAddress The collateral token address (USDC, USDT, etc.)
     * @param collateralAmount The amount of collateral to deposit
     * @param minUsnAmount Minimum USN amount to receive (slippage protection)
     */
    function directMint(
        address collateralAddress,
        uint256 collateralAmount,
        uint256 minUsnAmount
    ) external nonReentrant {
        // Verify user is whitelisted
        if (!whitelistedUsers[msg.sender]) {
            revert UserNotWhitelisted(msg.sender);
        }
        
        // Verify collateral is whitelisted
        if (!whitelistedCollaterals[collateralAddress]) {
            revert CollateralNotWhitelisted(collateralAddress);
        }
        
        // Verify price feed exists
        address priceFeed = priceFeeds[collateralAddress];
        if (priceFeed == address(0)) {
            revert PriceFeedNotSet(collateralAddress);
        }
        
        if (collateralAmount == 0) {
            revert ZeroAmount();
        }
        
        // Get price from oracle
        uint256 price = _getPrice(priceFeed);
        
        // Calculate USN amount based on price logic
        uint256 usnAmount = _calculateUsnAmount(collateralAddress, collateralAmount, price);
        
        // Slippage protection
        if (usnAmount < minUsnAmount) {
            revert CollateralUsnMismatch(collateralAmount, minUsnAmount);
        }
        
        // Check daily direct mint limit
        uint256 currentDay = block.timestamp / 1 days;
        if (currentDay > lastDirectMintDay) {
            currentDayDirectMintAmount = 0;
            lastDirectMintDay = currentDay;
        }
        
        if (currentDayDirectMintAmount + usnAmount > directMintLimitPerDay) {
            revert DirectMintLimitExceeded(directMintLimitPerDay, currentDayDirectMintAmount + usnAmount);
        }
        
        // Check per-block limit as well
        if (block.number > lastMintBlock) {
            currentBlockMintAmount = 0;
            lastMintBlock = block.number;
        }
        
        if (currentBlockMintAmount + usnAmount > mintLimitPerBlock) {
            revert MintLimitExceeded(mintLimitPerBlock, currentBlockMintAmount + usnAmount);
        }
        
        // Update counters
        currentDayDirectMintAmount += usnAmount;
        currentBlockMintAmount += usnAmount;
        
        // Transfer collateral and mint USN
        _transferCollateral(collateralAddress, msg.sender, collateralAmount);
        usnToken.mint(msg.sender, usnAmount);
        
        emit DirectMint(msg.sender, collateralAmount, usnAmount, collateralAddress, price);
    }
    
    /**
     * @notice Preview how much USN would be minted for a given collateral amount
     * @param collateralAddress The collateral token address
     * @param collateralAmount The amount of collateral
     * @return usnAmount The amount of USN that would be minted
     * @return priceUsed The price used for calculation (8 decimals)
     */
    function previewDirectMint(
        address collateralAddress,
        uint256 collateralAmount
    ) external view returns (uint256 usnAmount, uint256 priceUsed) {
        address priceFeed = priceFeeds[collateralAddress];
        if (priceFeed == address(0)) {
            revert PriceFeedNotSet(collateralAddress);
        }
        
        priceUsed = _getPrice(priceFeed);
        usnAmount = _calculateUsnAmount(collateralAddress, collateralAmount, priceUsed);
    }
    
    /**
     * @notice Calculate USN amount based on collateral and price
     * @dev Price logic:
     *      - Within threshold (0.99-1.01 by default): 1:1 mint
     *      - Below lower bound: mint at actual price (less USN)
     *      - Above upper bound: cap at 1:1
     */
    function _calculateUsnAmount(
        address collateralAddress,
        uint256 collateralAmount,
        uint256 price
    ) internal view returns (uint256) {
        uint256 collateralDecimals = IERC20Metadata(collateralAddress).decimals();
        uint256 usnDecimals = usnToken.decimals();
        
        // Normalize collateral to 18 decimals
        uint256 normalizedCollateral = collateralAmount * 10 ** (18 - collateralDecimals);
        
        // Calculate bounds
        uint256 lowerBound = ONE_USD - (ONE_USD * priceThresholdBps / 10000); // e.g., 0.99 USD
        uint256 upperBound = ONE_USD + (ONE_USD * priceThresholdBps / 10000); // e.g., 1.01 USD
        
        uint256 usnAmount;
        
        if (price >= lowerBound && price <= upperBound) {
            // Within threshold: 1:1 mint
            usnAmount = normalizedCollateral;
        } else if (price < lowerBound) {
            // Below threshold: mint based on actual price (user gets less USN)
            // usnAmount = collateral * price / 1.00
            usnAmount = (normalizedCollateral * price) / ONE_USD;
        } else {
            // Above threshold: cap at 1:1 (don't give more than deposited)
            usnAmount = normalizedCollateral;
        }
        
        // Adjust for USN decimals if different from 18
        if (usnDecimals != 18) {
            usnAmount = usnAmount / 10 ** (18 - usnDecimals);
        }
        
        return usnAmount;
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
    
    // ============ Admin Functions for Direct Mint ============
    
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
        if (_thresholdBps > 1000) {
            revert ThresholdTooHigh(_thresholdBps, 1000); // Max 10%
        }
        priceThresholdBps = _thresholdBps;
        emit PriceThresholdUpdated(_thresholdBps);
    }
    
    /**
     * @notice Set daily limit for direct mints
     * @param _limit Daily limit in USN (18 decimals)
     */
    function setDirectMintLimitPerDay(uint256 _limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        directMintLimitPerDay = _limit;
        emit DirectMintLimitUpdated(_limit);
    }
    
    /**
     * @notice Set oracle staleness threshold
     * @param _threshold Staleness threshold in seconds
     */
    function setOracleStalenessThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracleStalenessThreshold = _threshold;
        emit OracleStalenessThresholdUpdated(_threshold);
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

    function addWhitelistedCollateral(address collateral) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (collateral == address(0)) {
            revert ZeroAddress();
        }
        if (whitelistedCollaterals[collateral]) {
            revert CollateralAlreadyWhitelisted(collateral);
        }
        whitelistedCollaterals[collateral] = true;
        emit WhitelistedCollateralAdded(collateral);
    }

    function removeWhitelistedCollateral(address collateral) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!whitelistedCollaterals[collateral]) {
            revert CollateralNotWhitelisted(collateral);
        }
        whitelistedCollaterals[collateral] = false;
        emit WhitelistedCollateralRemoved(collateral);
    }

    // Public functions
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(encodeOrder(order)));
    }

    function encodeOrder(Order calldata order) public pure returns (bytes memory) {
        return
            abi.encode(
                ORDER_TYPEHASH,
                keccak256(bytes(order.message)), // Hashing the message to ensure consistent encoding and fixed length
                order.user,
                order.collateralAddress,
                order.collateralAmount,
                order.usnAmount,
                order.expiry,
                order.nonce
            );
    }

    // Internal functions
    function _transferCollateral(address collateral, address user, uint256 amount) internal {
        IERC20(collateral).safeTransferFrom(user, custodialWallet, amount);
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