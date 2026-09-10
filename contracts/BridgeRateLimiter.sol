// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IBridgeRateLimiter.sol";

/**
 * @title BridgeRateLimiter
 * @notice Standalone sliding-window rate limiter for LZ and Hyperlane bridge
 * paths, shared by every bridge-enabled token/vault on a chain (USN, sUSN,
 * the staking vault, ...). Callers reach it with a plain external CALL — not
 * inheritance/delegatecall — so this is the only place the limit logic,
 * storage, and any future fix live.
 *
 * Not upgradeable: fixing a bug here means deploying a new limiter and
 * repointing every token's setRateLimiter() at it, not a proxy upgrade. The
 * repoint is a register-caller + setRateLimits + setRateLimiter batch that
 * must land atomically per token — a fresh limiter starts with every bucket
 * at limit == 0 (unlimited) and zero in-flight.
 *
 * Each (caller, transport, remoteId, outbound) quadruple gets its own
 * independent bucket, keyed off msg.sender so one caller can never read or
 * spend another's headroom.
 *
 * Decay formula matches LayerZero's RateLimiter: capacity refills at a fixed
 * rate of limit/window per second, independent of how much was used.
 *
 * Default behaviour: limit == 0 means unlimited. window == 0 with a nonzero
 * limit is also valid and intentional — it decays to zero on every check, so
 * the limit acts as a per-transaction cap rather than a sliding-window total.
 */
contract BridgeRateLimiter is Ownable2Step, IBridgeRateLimiter {
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

    // Registration only gates OUTBOUND checkAndUpdate calls (see below) — it
    // is not a hard on/off switch for the caller's storage, just a deliberate
    // "stop new outbound bridging" lever. Kept as an on-chain registry for
    // monitoring/tooling as well as enforcement.
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
    error ZeroAddress();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Owner: caller registry ──────────────────────────────────────────────

    function registerCaller(address caller) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        registeredCallers[caller] = true;
        emit CallerRegistered(caller);
    }

    // Deregistering blocks only NEW outbound sends from `caller` (see
    // checkAndUpdate) — inbound delivery keeps working so funds already
    // in flight can still settle. This is a deliberate "stop new outbound,
    // let inbound drain" kill switch, not a full pause of the token.
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
            _settle(_limits[key], cfg.limit, cfg.window);
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

    // ── Enforcement ──────────────────────────────────────────────────────────

    // Registration gates outbound only: an unregistered/deregistered caller's
    // outbound calls revert, but its inbound calls still enforce normally
    // (falling back to unlimited if nothing is configured, same as any other
    // caller) so in-flight funds are never stuck mid-bridge because of a
    // registry change.
    function checkAndUpdate(
        uint8 transport,
        uint32 remoteId,
        bool outbound,
        uint256 amount
    ) external override {
        if (outbound && !registeredCallers[msg.sender]) revert NotRegisteredCaller();

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

    // Freezes the bucket's decayed-to-date in-flight amount under the OLD
    // limit/window before applying the new ones, then writes the new config.
    // Without this, raising a limit (or shrinking a window below the elapsed
    // time) changes the decay rate applied to usage that already accrued
    // under the old rate — silently wiping or inflating in-flight on a config
    // change that wasn't meant to reset anything.
    function _settle(RateLimit storage rl, uint256 newLimit, uint256 newWindow) private {
        rl.amountInFlight = _currentInFlight(rl);
        rl.lastUpdated = block.timestamp;
        rl.limit = newLimit;
        rl.window = newWindow;
    }

    // Returns the current in-flight amount after linear decay (LZ formula).
    // Decay rate = limit / window (fixed, independent of in-flight amount).
    // Math.mulDiv (not `(limit * elapsed) / window`) so a very large `limit`
    // can't make the intermediate product overflow and revert every check —
    // including inbound, which would otherwise brick delivery on that route.
    function _currentInFlight(RateLimit storage rl) private view returns (uint256) {
        uint256 elapsed = block.timestamp - rl.lastUpdated;
        if (rl.window == 0 || elapsed >= rl.window) return 0;
        uint256 decay = Math.mulDiv(rl.limit, elapsed, rl.window);
        return rl.amountInFlight <= decay ? 0 : rl.amountInFlight - decay;
    }
}
