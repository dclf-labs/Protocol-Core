// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "./lzv2-upgradeable/oft-upgradeable/OFTUpgradeable.sol";
import "./interfaces/IUSN.sol";

contract USNUpgradeable is
    Initializable,
    IUSN,
    OFTUpgradeable,
    Ownable2StepUpgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable
{
    address public admin;
    bool public permissionless;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public whitelistedAddresses;

    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event PermissionlessEnabled();

    error NotWhitelisted(address from, address to);

    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {}

    function initialize(string memory name, string memory symbol, address _owner) public initializer {
        __Ownable_init(_owner);
        __ERC20Burnable_init();
        __ERC20Permit_init(name);
        __OFT_init(name, symbol, _owner);
        __Ownable2Step_init();
    }

    function setAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminChanged(oldAdmin, newAdmin);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != admin) revert OnlyAdminCanMint();
        _mint(to, amount);
    }

    function blacklistAccount(address account) external onlyOwner {
        blacklist[account] = true;
        emit Blacklisted(account);
    }

    function unblacklistAccount(address account) external onlyOwner {
        blacklist[account] = false;
        emit Unblacklisted(account);
    }

    function addToWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = true;
        emit WhitelistAdded(_address);
    }

    function removeFromWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = false;
        emit WhitelistRemoved(_address);
    }

    function enablePermissionless() external onlyOwner {
        permissionless = true;
        emit PermissionlessEnabled();
    }

    function isWhitelisted(address _address) public view returns (bool) {
        return whitelistedAddresses[_address];
    }

    function decimals() public view virtual override(ERC20Upgradeable, IUSN) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 amount) internal virtual override(ERC20Upgradeable) {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();
        if (!permissionless && (!isWhitelisted(from) || !isWhitelisted(to))) revert NotWhitelisted(from, to);
        super._update(from, to, amount);
    }

    // Update the transferOwnership function
    function transferOwnership(
        address newOwner
    ) public virtual override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    // Update the _transferOwnership function
    function _transferOwnership(
        address newOwner
    ) internal virtual override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
