// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUSNHyperlane {
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    error BlacklistedAddress();

    event HyperlaneConfigured(address indexed mailbox);
    event RemoteTokenSet(uint32 indexed domain, bytes32 indexed remoteToken);
    event HyperlaneTransfer(uint32 indexed origin, bytes32 indexed sender, uint256 amount, bool isSending);

    error NotWhitelisted(address from, address to);
    error HyperlaneNotEnabled();
    error InvalidAmount();
    error RemoteTokenNotRegistered();
    error InsufficientInterchainFee();
    error InvalidRemoteToken();
    error InvalidRecipient();
    error OnlyMailboxAllowed();

    function blacklistAccount(address account) external;

    function unblacklistAccount(address account) external;

    function blacklist(address account) external view returns (bool);
}
