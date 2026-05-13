# Noon Core Contracts

Core smart contracts for the [Noon protocol](https://docs.noon.capital) — a stablecoin system built around USN, a USD-pegged stablecoin with yield generation through DeFi lending, yield trading, private credit, and real-world assets.

## Overview

The protocol consists of:

- **USN** — ERC20 stablecoin with cross-chain support (LayerZero OFT + Hyperlane)
- **sUSN** — Staked USN via an ERC4626 vault, earning yield through rebases
- **MinterHandlerV2** — Signature-based and direct minting with Chainlink oracle pricing
- **RedeemHandler** — Signature-based USN redemption for collateral
- **WithdrawalHandler** — Queued withdrawal system with timelock for the staking vault
- **Cross-chain contracts** — USNOFTHyperlane, StakedUSNOFTHyperlane for multi-chain bridging

USN can be accessed permissionlessly via DEXes (Uniswap, Curve, Syncswap, Ekubo), while minting and redemption require whitelisting.

## Contracts

### USN.sol

ERC20 stablecoin implementing LayerZero's OFT (Omnichain Fungible Token) standard with ERC20Permit and ERC20Burnable.

**Features:**
- Minting and burning with admin control
- Blacklisting and whitelisting
- Permissionless mode toggle — once enabled, removes whitelist requirement for transfers
- Cross-chain transfers via LayerZero

**Key Functions:**
- `mint(address to, uint256 amount)` — Mint USN (admin only)
- `blacklistAccount(address)` / `unblacklistAccount(address)` — Manage blacklist (owner only)
- `addToWhitelist(address)` / `removeFromWhitelist(address)` — Manage whitelist (owner only)
- `enablePermissionless()` — Remove whitelist restrictions permanently (owner only)

### MinterHandlerV2.sol

Manages USN minting through two mechanisms: EIP712 signature-based orders and direct minting with Chainlink oracle pricing.

**Roles:**
- `MINTER_ROLE` — Execute mint orders and rebases
- `DEFAULT_ADMIN_ROLE` — Configuration and parameter management

**Order Structure:**
```solidity
struct Order {
    string message;
    address user;
    address collateralAddress;
    uint256 collateralAmount;
    uint256 usnAmount;
    uint256 expiry;
    uint256 nonce;
}
```

**Key Functions:**
- `mint(Order calldata order, bytes calldata signature)` — Mint USN from a signed order (MINTER_ROLE)
- `directMint(address collateralAddress, uint256 collateralAmount, uint256 minUsnAmount)` — Mint using oracle price
- `previewDirectMint(address collateralAddress, uint256 collateralAmount)` — Preview direct mint output
- `mintAndRebase(uint256 amount)` — Mint and deposit into staking vault (MINTER_ROLE)
- `setCustodialWallet(address)` — Set collateral destination (admin)
- `setSUSNVault(address)` — Set staking vault for rebases (admin)
- `setPriceFeed(address collateral, address priceFeed)` — Configure Chainlink oracle (admin)
- `setMintLimitPerBlock(uint256)` — Rate limit per block (default: 1M USN)
- `setDirectMintLimitPerDay(uint256)` — Daily limit for direct mints (default: 100k USN)
- `setRebaseLimit(uint256)` — Max rebase amount per call (default: 30k USN)
- `setPriceThreshold(uint256)` — Oracle deviation tolerance in bps (default: 100 = 1%)
- `setOracleStalenessThreshold(uint256)` — Max oracle age (default: 1 hour)

**Direct Mint Pricing Logic:**
- Within ±1% of $1.00: 1:1 mint ratio
- Below lower bound: mint at actual oracle price
- Above upper bound: capped at 1:1

**Security:**
- ReentrancyGuard on all mint paths
- EIP712 off-chain signing with nonce-based replay prevention
- Per-block and per-day rate limiting
- Chainlink oracle staleness checks
- User and collateral whitelisting

### RedeemHandler.sol

Manages USN redemption — users exchange USN for underlying collateral via signed orders.

**Roles:**
- `BURNER_ROLE` — Execute redemptions
- `REDEEM_MANAGER_ROLE` — Manage redeemable collateral list
- `DEFAULT_ADMIN_ROLE` — Configuration and rescue

**Order Structure:**
```solidity
struct RedeemOrder {
    string message;
    address user;
    address collateralAddress;
    uint256 collateralAmount;
    uint256 usnAmount;
    uint256 expiry;
    uint256 nonce;
}
```

**Key Functions:**
- `redeem(RedeemOrder calldata order, bytes calldata signature)` — Redeem USN for collateral (BURNER_ROLE)
- `redeemWithPermit(...)` — Redeem using EIP-2612 permit for gasless approvals
- `addRedeemableCollateral(address)` / `removeRedeemableCollateral(address)` — Manage collateral list
- `setRedeemLimitPerBlock(uint256)` — Rate limit per block (default: 1M USN)
- `rescueERC20(address token, uint256 amount)` — Recover accidentally sent tokens (admin)

**Security:**
- EIP712 signing with nonce-based replay prevention
- Per-block rate limiting
- SafeERC20 for secure transfers
- Collateral and signature validation

### StakingVault.sol

ERC4626-compliant tokenized vault where users stake USN and receive sUSN shares. Yield is distributed through rebases that increase share value.

**Roles:**
- `REBASE_MANAGER_ROLE` — Add assets via rebase
- `BLACKLIST_MANAGER_ROLE` — Manage blacklist
- `DEFAULT_ADMIN_ROLE` — Configuration

**Key Functions:**
- `rebase(uint256 amount)` — Add assets to vault, increasing share value (REBASE_MANAGER_ROLE)
- `rebaseWithPermit(...)` — Rebase using ERC20Permit
- `createWithdrawalDemand(uint256 shares, bool force)` — Initiate withdrawal with timelock
- `withdraw(...)` / `redeem(...)` — Execute withdrawal after timelock period
- `depositWithPermit(...)` — Deposit using ERC20Permit
- `depositWithSlippageCheck(...)` / `redeemWithSlippageCheck(...)` — Operations with slippage protection
- `setWithdrawPeriod(uint256)` — Configure timelock duration (default: 1 day)
- `blacklistAccount(address)` / `unblacklistAccount(address)` — Manage blacklist
- `rescueToken(IERC20 token, address to, uint256 amount)` — Recover accidentally sent tokens

**Security:**
- ReentrancyGuard on rebase
- Two-step withdrawal with configurable timelock
- Blacklisting for compliance
- Cannot rescue vault token or underlying asset

### WithdrawalHandler.sol

Standalone withdrawal queuing contract used by the staking vault for managing withdrawal requests with timelocks.

**Roles:**
- `STAKING_VAULT_ROLE` — Create withdrawal requests
- `DEFAULT_ADMIN_ROLE` — Configuration

**Key Functions:**
- `createWithdrawalRequest(address user, uint256 amount)` — Queue a withdrawal (STAKING_VAULT_ROLE)
- `claimWithdrawal(uint256 requestId)` — Claim after timelock expires
- `setWithdrawPeriod(uint256)` — Configure timelock duration
- `getWithdrawalRequest(address user, uint256 requestId)` — Query request status

### Cross-Chain Contracts

#### USNOFTHyperlane.sol

Upgradeable USN token with both LayerZero OFT and Hyperlane cross-chain messaging support.

- `sendTokensViaHyperlane(uint32 destinationDomain, bytes32 recipient, uint256 amount)` — Bridge USN cross-chain
- `configureHyperlane(address mailbox)` — Set Hyperlane mailbox
- `registerHyperlaneRemoteToken(uint32 domain, bytes32 remoteToken)` — Register remote chain token
- Blacklist management via `BLACKLIST_MANAGER_ROLE`

#### StakedUSNOFTHyperlane.sol

Same architecture as USNOFTHyperlane but for the sUSN staked token.

#### StakingVaultOFTUpgradeable.sol

Upgradeable ERC4626 vault combined with LayerZero OFT for cross-chain sUSN transfers.

## Deployed Contracts

### Ethereum Mainnet

| Contract | Proxy | Implementation |
| --- | --- | --- |
| StakingVault | `0xE24a3DC889621612422A64E6388927901608B91D` | `0xD1fFb6a6a42C86B931B2a6d388D1F25C1C775B34` |

## Development

### Prerequisites

- Node.js >= 18
- Yarn

### Setup

```bash
cp .env.example .env  # Configure RPC URLs and keys
yarn install
```

### Build & Test

```bash
yarn compile              # Compile contracts
yarn test                 # Run tests
yarn test:coverage        # Generate coverage report
yarn test:trace           # Run with call traces
```

### Deploy

```bash
./bin/deploy.sh <network> <contract-name>

# Examples:
./bin/deploy.sh mainnet USN
./bin/deploy.sh mainnet MinterHandlerV2
```

### Other Commands

```bash
yarn size                 # Contract size report
yarn lint                 # Lint Solidity and TypeScript
yarn format               # Format all files
yarn generate:docs        # Generate Solidity docs
```

### Configuration

- **Solidity**: 0.8.28 with optimizer (200 runs)
- **Framework**: Hardhat with TypeScript
- **Proxies**: OpenZeppelin Transparent Proxy (upgradeable contracts)
- **Cross-chain**: LayerZero V2 + Hyperlane
- **Oracles**: Chainlink price feeds (for direct minting)

### Supported Networks

Ethereum, zkSync Era, Sophon, Starknet, HyperEVM and various testnets (Sepolia, Goerli, etc.).

## Test Coverage

| File | % Stmts | % Funcs | % Lines |
| --- | --- | --- | --- |
| contracts/MinterHandler.sol | 96.43% | 100.00% | 97.87% |
| contracts/RedeemHandler.sol | 97.62% | 90.00% | 96.43% |
| contracts/StakingVault.sol | 100.00% | 100.00% | 100.00% |
| contracts/USN.sol | 100.00% | 100.00% | 100.00% |

## Security

- EIP712 typed data signing for all mint/redeem operations
- Nonce-based replay attack prevention
- Per-block and per-day rate limiting
- Chainlink oracle integration with staleness checks
- Role-based access control (AccessControl)
- ReentrancyGuard on state-changing operations
- SafeERC20 for all token transfers
- Blacklisting for regulatory compliance
- Two-step withdrawal with configurable timelock
- CI pipeline includes [Slither](https://github.com/crytic/slither) and [Mythril](https://github.com/Consensys/mythril) static analysis

## License

MIT
