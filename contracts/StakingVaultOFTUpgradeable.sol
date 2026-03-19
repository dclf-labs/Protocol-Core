// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "./lzv2-upgradeable/oft-upgradeable/OFTUpgradeable.sol";
import "./interfaces/IStakingVaultUpgradeable.sol";
import "./interfaces/IWithdrawalHandler.sol";

// Separate storage contract to avoid storage collisions in upgrades
abstract contract StakingVaultStorageV1 {
    bytes32 internal constant STAKING_VAULT_STORAGE_POSITION = keccak256("StakingVault.storage.location");

    struct StakingVaultStorage {
        mapping(address => bool) blacklist;
        address withdrawalHandler;
    }

    function getStakingVaultStorage() internal pure returns (StakingVaultStorage storage s) {
        bytes32 position = STAKING_VAULT_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    // Gap for future storage variables
    uint256[50] private __gap;
}

contract StakingVaultOFTUpgradeable is
    Initializable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    OFTUpgradeable,
    IStakingVaultUpgradeable,
    StakingVaultStorageV1
{
    using SafeERC20 for IERC20;

    // Constants
    bytes32 public constant REBASE_MANAGER_ROLE = keccak256("REBASE_MANAGER_ROLE");
    bytes32 public constant BLACKLIST_MANAGER_ROLE = keccak256("BLACKLIST_MANAGER_ROLE");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {
        _disableInitializers();
    }

    function initialize(IERC20 _asset, string memory _name, string memory _symbol, address _owner) public initializer {
        if (address(_asset) == address(0)) revert ZeroAddress();

        __ERC4626_init(IERC20(_asset));
        __ERC20_init(_name, _symbol);
        __AccessControl_init();
        __ReentrancyGuard_init();
        __OFT_init(_name, _symbol, _owner);
        __Ownable_init(_owner);

        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        _grantRole(BLACKLIST_MANAGER_ROLE, _owner);
    }

    function setRebaseManager(address _rebaseManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_rebaseManager == address(0)) revert ZeroAddress();
        _grantRole(REBASE_MANAGER_ROLE, _rebaseManager);
    }

    function blacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        StakingVaultStorage storage s = getStakingVaultStorage();
        s.blacklist[account] = true;
        emit Blacklisted(account);
    }

    function unblacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        StakingVaultStorage storage s = getStakingVaultStorage();
        s.blacklist[account] = false;
        emit Unblacklisted(account);
    }

    function rescueToken(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(token) == address(this)) revert CannotRescueVaultToken();
        if (address(token) == address(asset())) revert CannotRescueUnderlyingAsset();
        token.safeTransfer(to, amount);
        emit TokenRescued(address(token), to, amount);
    }

    function rebaseWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyRole(REBASE_MANAGER_ROLE) {
        try IERC20Permit(address(asset())).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        rebase(amount);
    }

    function rebase(uint256 _amount) public onlyRole(REBASE_MANAGER_ROLE) nonReentrant {
        if (_amount == 0) revert CannotSetZero();

        uint256 totalAssetsBefore = totalAssets();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), _amount);

        if (totalAssets() != totalAssetsBefore + _amount) revert AssetTransferFailed();

        emit Rebase(_amount);
    }

    function setWithdrawalHandler(address _handler) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_handler == address(0)) revert ZeroAddress();
        StakingVaultStorage storage s = getStakingVaultStorage();
        s.withdrawalHandler = _handler;
    }

    function createWithdrawalDemand(uint256 assets) internal {
        StakingVaultStorage storage s = getStakingVaultStorage();

        if (s.blacklist[msg.sender]) revert BlacklistedAddress();
        // Create withdrawal request in handler
        IWithdrawalHandler(s.withdrawalHandler).createWithdrawalRequest(msg.sender, assets);

        emit WithdrawalDemandCreated(msg.sender, assets, block.timestamp);
    }

    function depositWithPermit(
        uint256 assets,
        address receiver,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        try IERC20Permit(address(asset())).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return deposit(assets, receiver);
    }

    function mintWithSlippageCheck(uint256 shares, address receiver, uint256 maxAssets) external returns (uint256) {
        uint256 assets = previewMint(shares);
        if (assets > maxAssets) revert SlippageExceeded(assets, maxAssets);
        return mint(shares, receiver);
    }

    function depositWithSlippageCheck(
        uint256 assets,
        address receiver,
        uint256 minSharesOut
    ) external returns (uint256) {
        uint256 shares = previewDeposit(assets);
        if (shares < minSharesOut) revert SlippageExceeded(shares, minSharesOut);
        return deposit(assets, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        StakingVaultStorage storage s = getStakingVaultStorage();
        if (owner != msg.sender) revert Unauthorized();
        if (assets == 0) revert ZeroAmount();
        if (receiver != s.withdrawalHandler) revert Unauthorized();
        createWithdrawalDemand(assets);
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        StakingVaultStorage storage s = getStakingVaultStorage();
        if (msg.sender != address(this)) revert Unauthorized();
        if (shares == 0) revert ZeroAmount();
        if (receiver != s.withdrawalHandler) revert Unauthorized();
        uint256 assets = previewRedeem(shares);
        createWithdrawalDemand(assets);
        return super.redeem(shares, receiver, owner);
    }

    function withdrawWithSlippageCheck(
        uint256 assets,
        address receiver,
        address owner,
        uint256 maxSharesBurned
    ) external returns (uint256) {
        uint256 shares = previewWithdraw(assets);
        if (shares > maxSharesBurned) revert SlippageExceeded(shares, maxSharesBurned);
        return withdraw(assets, receiver, owner);
    }

    function redeemWithSlippageCheck(
        uint256 shares,
        address receiver,
        address owner,
        uint256 minAssetsOut
    ) external returns (uint256) {
        uint256 assets = previewRedeem(shares);
        if (assets < minAssetsOut) revert SlippageExceeded(assets, minAssetsOut);
        return redeem(shares, receiver, owner);
    }

    function _update(address from, address to, uint256 amount) internal virtual override(ERC20Upgradeable) {
        StakingVaultStorage storage s = getStakingVaultStorage();
        if (s.blacklist[from] || s.blacklist[to]) revert BlacklistedAddress();
        super._update(from, to, amount);
    }

    // Override required functions to resolve conflicts
    function _msgSender() internal view virtual override returns (address) {
        return super._msgSender();
    }

    function _msgData() internal view virtual override returns (bytes calldata) {
        return super._msgData();
    }

    function decimals() public view virtual override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return 18;
    }

    function _debit(
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal virtual override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        (amountSentLD, amountReceivedLD) = _debitView(_amountLD, _minAmountLD, _dstEid);

        // Lock tokens instead of burning
        _update(msg.sender, address(this), amountSentLD);
        return (amountSentLD, amountReceivedLD);
    }

    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 /*_srcEid*/
    ) internal virtual override returns (uint256 amountReceivedLD) {
        if (_to == address(0x0)) _to = address(0xdead);

        // Unlock tokens instead of minting
        _update(address(this), _to, _amountLD);
        return _amountLD;
    }
}
