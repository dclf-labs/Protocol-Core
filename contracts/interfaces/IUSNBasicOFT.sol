// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IUSNBasicOFT {
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    error BlacklistedAddress();

    function blacklistAccount(address account) external;

    function unblacklistAccount(address account) external;

    function blacklist(address account) external view returns (bool);
}
