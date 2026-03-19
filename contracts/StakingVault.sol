// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "./interfaces/IStakingVault.sol";

contract StakingVault is ERC4626, AccessControl, ReentrancyGuard, IStakingVault {
    using SafeERC20 for IERC20;

    // Constants
    bytes32 public constant REBASE_MANAGER_ROLE = keccak256("REBASE_MANAGER_ROLE");
    bytes32 public constant BLACKLIST_MANAGER_ROLE = keccak256("BLACKLIST_MANAGER_ROLE");

    // State variables
    uint256 public withdrawPeriod;

    // Mappings
    mapping(address => WithdrawalDemand) public withdrawalDemands;
    mapping(address => bool) public blacklist;

    // Modifiers
    modifier checkWithdrawPeriod() {
        if (block.timestamp < withdrawalDemands[msg.sender].timestamp + withdrawPeriod) {
            revert WithdrawPeriodNotElapsed();
        }
        _;
    }

    // Constructor
    constructor(IERC20 _asset, string memory _name, string memory _symbol) ERC4626(_asset) ERC20(_name, _symbol) {
        if (address(_asset) == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BLACKLIST_MANAGER_ROLE, msg.sender);
        withdrawPeriod = 1 days; // Default withdraw period
    }

    // External functions
    function setRebaseManager(address _rebaseManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_rebaseManager == address(0)) revert ZeroAddress();
        _grantRole(REBASE_MANAGER_ROLE, _rebaseManager);
    }

    function setWithdrawPeriod(uint256 _newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newPeriod == 0) revert CannotSetZero();
        withdrawPeriod = _newPeriod;
        emit WithdrawPeriodUpdated(_newPeriod);
    }

    function blacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        blacklist[account] = true;
        emit Blacklisted(account);
    }

    function unblacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        blacklist[account] = false;
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

    // Public functions
    /**
     * @notice Increases the total assets in the vault through a rebase operation.
     * @dev This function will fail for fee-on-transfer tokens. For such tokens,
     * direct transfers to the vault contract should be used instead to increase
     * the underlying token amount.
     * @param _amount The amount of tokens to add to the vault
     */
    function rebase(uint256 _amount) public onlyRole(REBASE_MANAGER_ROLE) nonReentrant {
        if (_amount == 0) revert CannotSetZero();

        uint256 totalAssetsBefore = totalAssets();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), _amount);

        if (totalAssets() != totalAssetsBefore + _amount) revert AssetTransferFailed();

        emit Rebase(_amount);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override checkWithdrawPeriod returns (uint256) {
        if (owner != msg.sender) revert Unauthorized();
        if (assets == 0) revert ZeroAmount();
        uint256 shares = previewWithdraw(assets);
        if (shares > withdrawalDemands[owner].askedShares) revert WithdrawalExceedsDemand();
        delete withdrawalDemands[owner];
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override checkWithdrawPeriod returns (uint256) {
        if (owner != msg.sender) revert Unauthorized();
        if (shares == 0) revert ZeroAmount();
        if (shares > withdrawalDemands[owner].askedShares) revert RedemptionExceedsDemand();
        delete withdrawalDemands[owner];
        return super.redeem(shares, receiver, owner);
    }

    // External functions
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
        if (assets > maxAssets) revert SlippageExceeded();
        return mint(shares, receiver);
    }

    function depositWithSlippageCheck(
        uint256 assets,
        address receiver,
        uint256 minSharesOut
    ) external returns (uint256) {
        uint256 shares = previewDeposit(assets);
        if (shares < minSharesOut) revert SlippageExceeded();
        return deposit(assets, receiver);
    }

    function createWithdrawalDemand(uint256 shares, bool force) external {
        if (balanceOf(msg.sender) < shares) revert InsufficientBalance();
        if (withdrawalDemands[msg.sender].timestamp > 0 && !force) revert ExistingWithdrawalDemand();
        withdrawalDemands[msg.sender] = WithdrawalDemand({ timestamp: block.timestamp, askedShares: shares });
        emit WithdrawalDemandCreated(msg.sender, shares, block.timestamp);
    }

    function withdrawWithSlippageCheck(
        uint256 assets,
        address receiver,
        address owner,
        uint256 maxSharesBurned
    ) external checkWithdrawPeriod returns (uint256) {
        uint256 shares = previewWithdraw(assets);
        if (shares > maxSharesBurned) revert SlippageExceeded();
        return withdraw(assets, receiver, owner);
    }

    function redeemWithSlippageCheck(
        uint256 shares,
        address receiver,
        address owner,
        uint256 minAssetsOut
    ) external checkWithdrawPeriod returns (uint256) {
        uint256 assets = previewRedeem(shares);
        if (assets < minAssetsOut) revert SlippageExceeded();

        return redeem(shares, receiver, owner);
    }

    // Internal functions
    function _update(address from, address to, uint256 amount) internal virtual override {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();
        super._update(from, to, amount);
    }
}
