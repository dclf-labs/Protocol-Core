// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { OFT, ERC20 } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IUSN } from "./interfaces/IUSN.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract USN is IUSN, OFT, Ownable2Step, ERC20Burnable, ERC20Permit {
    address public admin;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public whitelistedAddresses;
    bool public permissionless;

    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event PermissionlessEnabled();

    error NotWhitelisted(address from, address to);

    constructor(address _lzEndpoint) 
        OFT("USN", "USN", _lzEndpoint, msg.sender) 
        Ownable(msg.sender)
        ERC20Permit("USN")
    {
        // No initial supply
        _transferOwnership(msg.sender);
        permissionless = false;
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

    function decimals() public view virtual override(ERC20, IUSN) returns (uint8) {
        return super.decimals();
    }

    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal virtual override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        if (blacklist[_from]) revert BlacklistedAddress();
        if (!permissionless && !isWhitelisted(_from)) revert NotWhitelisted(_from, address(0));
        return super._debit(_from, _amountLD, _minAmountLD, _dstEid);
    }

    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal virtual override returns (uint256 amountReceivedLD) {
        if (blacklist[_to]) revert BlacklistedAddress();
        if (!permissionless && !isWhitelisted(_to)) revert NotWhitelisted(address(0), _to);
        return super._credit(_to, _amountLD, _srcEid);
    }

    function _update(address from, address to, uint256 amount) internal virtual override(ERC20) {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();
        if (!permissionless && (!isWhitelisted(from) || !isWhitelisted(to))) revert NotWhitelisted(from, to);
        super._update(from, to, amount);
    }

    function transferOwnership(address newOwner) public virtual override(Ownable2Step, Ownable) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override(Ownable2Step, Ownable) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
