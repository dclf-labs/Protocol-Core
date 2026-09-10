// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IBridgeRateLimiter
/// @notice Minimal surface a bridge-enabled token/vault needs to enforce a
/// shared rate limit. Everything else (admin surface, storage, decay math)
/// lives in the BridgeRateLimiter contract itself.
interface IBridgeRateLimiter {
    /// @notice Checks `amount` against the caller's bucket for
    /// (msg.sender, transport, remoteId, outbound) and records it if allowed.
    /// Reverts with RateLimitExceeded if the bucket has insufficient headroom,
    /// or NotRegisteredCaller if msg.sender is not a registered caller.
    function checkAndUpdate(uint8 transport, uint32 remoteId, bool outbound, uint256 amount) external;
}
