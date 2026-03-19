// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUSN {
    // Events
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // Custom errors
    error ZeroAddress();
    error OnlyAdminCanMint();
    error BlacklistedAddress();

    // Functions
    function setAdmin(address newAdmin) external;

    function decimals() external view returns (uint8);

    function mint(address to, uint256 amount) external;

    function admin() external view returns (address);
}