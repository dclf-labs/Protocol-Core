// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title BridgeRateLimiterUpgradeable
 * @notice Abstract sliding-window rate limiter for LZ and Hyperlane bridge paths.
 *
 * Each (transport, remoteId, direction) triple gets its own independent bucket.
 * Storage is namespaced (ERC-7201) so it is safe to add to an existing
 * upgradeable proxy without shifting any inherited storage slots.
 *
 * Decay formula matches LayerZero's RateLimiter: capacity refills at a fixed
 * rate of limit/window per second, independent of how much was used.
 *
 * Default behaviour: limit == 0 means unlimited. Configure limits explicitly
 * via setRateLimits() after the upgrade.
 */
abstract contract BridgeRateLimiterUpgradeable {
    uint8 internal constant TRANSPORT_LZ = 0;
    uint8 internal constant TRANSPORT_HYPERLANE = 1;

    struct RateLimit {
        uint256 limit;
        uint256 window;
        uint256 amountInFlight;
        uint256 lastUpdated;
    }

    struct RateLimitConfig {
        uint8 transport;
        uint32 remoteId;
        bool outbound;
        uint256 limit;
        uint256 window;
    }

    /// @custom:storage-location erc7201:noon.storage.bridgeratelimiter
    struct RateLimiterStorage {
        mapping(bytes32 => RateLimit) limits;
    }

    // keccak256(abi.encode(uint256(keccak256("noon.storage.bridgeratelimiter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        0x63a6a5fc9c18d1890bac0c27ad895de6f091c8269e5f94ea1fa52545fb6d7e00;

    event RateLimitSet(uint8 transport, uint32 remoteId, bool outbound, uint256 limit, uint256 window);
    // key = keccak256(abi.encodePacked(transport, remoteId, outbound)) — use _rlKey() to reconstruct
    event InFlightReset(bytes32 indexed key);

    error RateLimitExceeded(uint256 requested, uint256 available);
    error InvalidTransport();

    function _getRateLimiterStorage() private pure returns (RateLimiterStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    function _rlKey(uint8 transport, uint32 remoteId, bool outbound) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(transport, remoteId, outbound));
    }

    // Returns the current in-flight amount after linear decay (LZ formula).
    // Decay rate = limit / window (fixed, independent of in-flight amount).
    function _currentInFlight(RateLimit storage rl) private view returns (uint256) {
        uint256 elapsed = block.timestamp - rl.lastUpdated;
        if (rl.window == 0 || elapsed >= rl.window) return 0;
        uint256 decay = (rl.limit * elapsed) / rl.window;
        return rl.amountInFlight <= decay ? 0 : rl.amountInFlight - decay;
    }

    function _checkAndUpdateRateLimit(bytes32 key, uint256 amount) internal {
        RateLimit storage rl = _getRateLimiterStorage().limits[key];

        // limit == 0 → unlimited
        if (rl.limit == 0) return;

        uint256 current = _currentInFlight(rl);
        uint256 available = rl.limit > current ? rl.limit - current : 0;

        if (amount > available) revert RateLimitExceeded(amount, available);

        rl.amountInFlight = current + amount;
        rl.lastUpdated = block.timestamp;
    }

    function _setRateLimit(bytes32 key, uint256 limit, uint256 window) internal {
        RateLimiterStorage storage $ = _getRateLimiterStorage();
        $.limits[key].limit = limit;
        $.limits[key].window = window;
    }

    function _resetInflightForKey(bytes32 key) internal {
        RateLimit storage rl = _getRateLimiterStorage().limits[key];
        rl.amountInFlight = 0;
        rl.lastUpdated = block.timestamp;
        emit InFlightReset(key);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setRateLimits(RateLimitConfig[] calldata configs) external virtual;

    function resetInFlight(uint8 transport, uint32 remoteId, bool outbound) external virtual;

    // ── View ─────────────────────────────────────────────────────────────────

    function getRateLimit(
        uint8 transport,
        uint32 remoteId,
        bool outbound
    ) external view returns (uint256 limit, uint256 window, uint256 available) {
        bytes32 key = _rlKey(transport, remoteId, outbound);
        RateLimit storage rl = _getRateLimiterStorage().limits[key];

        limit = rl.limit;
        window = rl.window;

        if (limit == 0) {
            available = type(uint256).max;
            return (limit, window, available);
        }

        uint256 current = _currentInFlight(rl);
        available = limit > current ? limit - current : 0;
    }
}
