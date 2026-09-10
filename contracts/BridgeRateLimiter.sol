// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IBridgeRateLimiter.sol";

/**
 * @title BridgeRateLimiter
 * @notice Standalone sliding-window rate limiter for LZ and Hyperlane bridge
 * paths, shared by every bridge-enabled token/vault on a chain (USN, sUSN,
 * the staking vault, ...). Callers reach it with a plain external CALL — not
 * inheritance/delegatecall — so this is the only place the limit logic,
 * storage, and any future fix live.
 *
 * Each (caller, transport, remoteId, outbound) quadruple gets its own
 * independent bucket, keyed off msg.sender so one registered caller can
 * never read or spend another's headroom.
 *
 * Decay formula matches LayerZero's RateLimiter: capacity refills at a fixed
 * rate of limit/window per second, independent of how much was used.
 *
 * Default behaviour: limit == 0 means unlimited. Configure limits explicitly
 * via setRateLimits() after registering the caller.
 */
contract BridgeRateLimiter is Ownable, IBridgeRateLimiter {
    uint8 public constant TRANSPORT_LZ = 0;
    uint8 public constant TRANSPORT_HYPERLANE = 1;

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

    mapping(address => bool) public registeredCallers;
    mapping(bytes32 => RateLimit) private _limits;

    event CallerRegistered(address indexed caller);
    event CallerDeregistered(address indexed caller);
    event RateLimitSet(address indexed caller, uint8 transport, uint32 remoteId, bool outbound, uint256 limit, uint256 window);
    // key = keccak256(abi.encodePacked(caller, transport, remoteId, outbound))
    event InFlightReset(address indexed caller, bytes32 indexed key);

    error NotRegisteredCaller();
    error InvalidTransport();
    error RateLimitExceeded(uint256 requested, uint256 available);

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyRegisteredCaller() {
        if (!registeredCallers[msg.sender]) revert NotRegisteredCaller();
        _;
    }

    // ── Owner: caller registry ──────────────────────────────────────────────

    function registerCaller(address caller) external onlyOwner {
        registeredCallers[caller] = true;
        emit CallerRegistered(caller);
    }

    function deregisterCaller(address caller) external onlyOwner {
        registeredCallers[caller] = false;
        emit CallerDeregistered(caller);
    }

    // ── Owner: rate limit config ────────────────────────────────────────────

    function setRateLimits(address caller, RateLimitConfig[] calldata configs) external onlyOwner {
        for (uint256 i = 0; i < configs.length; i++) {
            RateLimitConfig calldata cfg = configs[i];
            if (cfg.transport > TRANSPORT_HYPERLANE) revert InvalidTransport();
            bytes32 key = _key(caller, cfg.transport, cfg.remoteId, cfg.outbound);
            _limits[key].limit = cfg.limit;
            _limits[key].window = cfg.window;
            emit RateLimitSet(caller, cfg.transport, cfg.remoteId, cfg.outbound, cfg.limit, cfg.window);
        }
    }

    function resetInFlight(address caller, uint8 transport, uint32 remoteId, bool outbound) external onlyOwner {
        if (transport > TRANSPORT_HYPERLANE) revert InvalidTransport();
        bytes32 key = _key(caller, transport, remoteId, outbound);
        RateLimit storage rl = _limits[key];
        rl.amountInFlight = 0;
        rl.lastUpdated = block.timestamp;
        emit InFlightReset(caller, key);
    }

    // ── Registered callers: enforcement ─────────────────────────────────────

    function checkAndUpdate(
        uint8 transport,
        uint32 remoteId,
        bool outbound,
        uint256 amount
    ) external override onlyRegisteredCaller {
        RateLimit storage rl = _limits[_key(msg.sender, transport, remoteId, outbound)];

        // limit == 0 → unlimited
        if (rl.limit == 0) return;

        uint256 current = _currentInFlight(rl);
        uint256 available = rl.limit > current ? rl.limit - current : 0;

        if (amount > available) revert RateLimitExceeded(amount, available);

        rl.amountInFlight = current + amount;
        rl.lastUpdated = block.timestamp;
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function getRateLimit(
        address caller,
        uint8 transport,
        uint32 remoteId,
        bool outbound
    ) external view returns (uint256 limit, uint256 window, uint256 available) {
        RateLimit storage rl = _limits[_key(caller, transport, remoteId, outbound)];

        limit = rl.limit;
        window = rl.window;

        if (limit == 0) {
            available = type(uint256).max;
            return (limit, window, available);
        }

        uint256 current = _currentInFlight(rl);
        available = limit > current ? limit - current : 0;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _key(address caller, uint8 transport, uint32 remoteId, bool outbound) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(caller, transport, remoteId, outbound));
    }

    // Returns the current in-flight amount after linear decay (LZ formula).
    // Decay rate = limit / window (fixed, independent of in-flight amount).
    function _currentInFlight(RateLimit storage rl) private view returns (uint256) {
        uint256 elapsed = block.timestamp - rl.lastUpdated;
        if (rl.window == 0 || elapsed >= rl.window) return 0;
        uint256 decay = (rl.limit * elapsed) / rl.window;
        return rl.amountInFlight <= decay ? 0 : rl.amountInFlight - decay;
    }
}
