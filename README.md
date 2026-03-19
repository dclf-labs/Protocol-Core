# Noon Core Contracts

This repository contains the core smart contracts for the Noon protocol, focusing on the USN stablecoin system and its associated handlers. Below is a detailed overview of the main contracts, their functions, and use cases.

## Key Contracts

### 1. USN.sol

USN is the primary stablecoin of the Noon ecosystem, designed to maintain a stable value pegged to the US Dollar.

#### Key Features:

- ERC20 compliant stablecoin
- Minting and burning capabilities
- Blacklisting functionality
- Blocks transfers if blacklisted
- Role-based access control

#### Key Functions:

- `mint(address to, uint256 amount)`: Mints new USN tokens (restricted to authorized minters).
- `burn(uint256 amount)`: Burns USN tokens from the caller's balance.
- `burnFrom(address account, uint256 amount)`: Burns USN tokens from a specified account.
- `transfer(address recipient, uint256 amount)`: Transfers USN tokens to a specified address.
- `approve(address spender, uint256 amount)`: Approves a spender to use a certain amount of USN tokens.
- `transferFrom(address sender, address recipient, uint256 amount)`: Transfers USN tokens on behalf of another address.
- `setMinter(address minter, bool status)`: Sets or revokes minter privileges (admin only).
- `blacklist(address account)` and `unblacklist(address account)`: Adds or removes an address from the blacklist (admin only).

#### Use Cases:

- **Users**: Hold, transfer, and use USN within the ecosystem.
- **Traders**: Utilize USN for trading pairs and as a stable store of value.
- **DeFi Protocols**: Integrate USN as a stablecoin option in various DeFi applications.
- **Treasury**: Manage USN supply through authorized minting and burning.
- **Compliance Team**: Manage blacklisted addresses for regulatory compliance.

### 2. MinterHandler.sol

Manages the minting process for USN, ensuring proper collateralization and adherence to protocol rules.

#### Key Features:

- EIP712 compliant order signing
- Whitelisting for users and collateral
- Custodial wallet management for treasury
- Role-based access control
- Reentrancy/Signature reuse protection based on nonce
- Mint limit per block to control minting flow

#### Mint Order Structure:

The `Order` struct used for minting USN tokens contains the following fields:

- `user`: Address of the user minting USN
- `collateralAmount`: Amount of collateral being provided
- `usnAmount`: Amount of USN to be minted
- `nonce`: Unique identifier to prevent replay attacks
- `expiry`: Timestamp after which the order becomes invalid
- `collateralAddress`: Address of the collateral token being used

This order is signed off-chain using EIP712 and verified on-chain during the minting process.

#### Key Functions:

- `mint(Order calldata order, bytes calldata signature)`: Mints USN tokens based on the provided order and signature (restricted to MINTER_ROLE).
- `setCustodialWallet(address _custodialWallet)`: Sets the custodial wallet address (admin only).
- `addWhitelistedUser(address user)`: Adds a user to the whitelist (admin only).
- `removeWhitelistedUser(address user)`: Removes a user from the whitelist (admin only).
- `addWhitelistedCollateral(address collateral)`: Adds a collateral token to the whitelist (admin only).
- `removeWhitelistedCollateral(address collateral)`: Removes a collateral token from the whitelist (admin only).
- `hashOrder(Order calldata order)`: Computes the hash of an order.
- `encodeOrder(Order calldata order)`: Encodes an order for hashing.
- `setMintLimitPerBlock(uint256 _mintLimitPerBlock)`: Sets the mint limit per block (admin only).

#### Use Cases:

- **Whitelisted Users**: Submit signed orders to mint USN tokens.
- **Collateral Providers**: Supply whitelisted assets as collateral for minting USN.
- **MINTER_ROLE**: Execute minting operations based on valid orders and signatures.
- **Protocol Admins**: Manage whitelisted users, collateral types, and the custodial wallet.
- **Integrators**: Utilize the order hashing and encoding functions for off-chain signature generation.

#### Security Features:

- Implements ReentrancyGuard to prevent reentrancy attacks.
- Uses AccessControl for role-based permissions.
- Employs EIP712 for secure, off-chain order signing.
- Validates user and collateral whitelisting, signature expiry, and nonce usage.
- Enforces a mint limit per block to prevent large sudden inflows.

### 3. RedeemHandler.sol

Manages the redemption process for USN, allowing users to exchange USN for underlying collateral.

#### Key Features:

- EIP712 compliant order signing
- Redeemable collateral management
- Role-based access control
- Secure token transfers
- Redeem limit per block to control redemption flow

#### Redeem Order Structure:

The `RedeemOrder` struct used for redeeming USN tokens contains the following fields:

- `user`: Address of the user redeeming USN
- `usnAmount`: Amount of USN to be redeemed
- `collateralAmount`: Amount of collateral to be received
- `collateralAddress`: Address of the collateral token to receive
- `nonce`: Unique identifier to prevent replay attacks
- `expiry`: Timestamp after which the order becomes invalid

Similar to the mint order, this redeem order is signed off-chain using EIP712 and verified on-chain during the redemption process.

#### Key Functions:

- `redeem(RedeemOrder calldata order, bytes calldata signature)`: Redeems USN for the specified collateral token based on a signed order (restricted to BURNER_ROLE). Verifies the order details, signature, and allowance before burning USN and transferring collateral.
- `redeemWithPermit(RedeemOrder calldata order, bytes calldata signature, uint8 v, bytes32 r, bytes32 s)`: Redeems USN using EIP-2612 permit for gasless approvals.
- `addRedeemableCollateral(address collateral)`: Adds a new redeemable collateral token (restricted to REDEEM_MANAGER_ROLE).
- `removeRedeemableCollateral(address collateral)`: Removes a redeemable collateral token (restricted to REDEEM_MANAGER_ROLE).
- `hashOrder(RedeemOrder calldata order)`: Computes the EIP712-compliant hash of a redeem order.
- `encodeOrder(RedeemOrder calldata order)`: Encodes a redeem order for hashing, following the REDEEM_TYPEHASH structure.
- `setRedeemLimitPerBlock(uint256 newLimit)`: Sets a new redeem limit per block (admin only).

#### Use Cases:

- **USN Holders**: Redeem USN for underlying collateral by submitting signed orders.
- **BURNER_ROLE**: Execute redemption operations based on valid orders and signatures.
- **REDEEM_MANAGER_ROLE**: Manage the list of redeemable collateral tokens.
- **Integrators**: Utilize the order hashing and encoding functions for off-chain signature generation.
- **Admin**: Manage redeem limits to control redemption flow.

#### Security Features:

- Implements AccessControl for role-based permissions (BURNER_ROLE, REDEEM_MANAGER_ROLE).
- Employs EIP712 for secure, off-chain order signing and verification.
- Validates redeemable collaterals, signature expiry, and allowances.
- Uses SafeERC20 for secure token transfers.
- Implements checks for zero addresses, zero amounts, and valid collateral.
- Prevents removal of USN as a redeemable collateral.
- Enforces a redeem limit per block to prevent large sudden outflows.

#### Additional Notes:

- The contract uses an immutable DOMAIN_SEPARATOR for EIP712 compliance, computed at construction.
- The contract inherits from AccessControl and EIP712, providing a robust foundation for role management and typed data signing.
- The redeem functions include comprehensive checks to ensure the validity and security of each redemption operation.
- The redeemWithPermit function allows for gasless approvals, improving user experience.

Both MinterHandler and RedeemHandler use EIP712 for secure, off-chain order signing. The main difference between the two order types is their purpose:

- Mint orders are used to create new USN tokens by providing collateral.
- Redeem orders are used to exchange USN tokens back into the underlying collateral.

The use of signed orders allows for gasless approvals and enhanced security in both minting and redemption processes.

## StakingVault

The StakingVault contract is an advanced ERC4626-compliant tokenized vault that allows users to stake their assets and earn rewards. It incorporates several key features for enhanced security, flexibility, and control:

### Key Features:

1. **ERC4626 Compliance**: Implements the ERC4626 tokenized vault standard for seamless integration with other DeFi protocols.

2. **Role-Based Access Control**: Utilizes OpenZeppelin's AccessControl for managing different roles within the system.

3. **Rebase Mechanism**: Allows authorized managers to add assets to the vault, effectively increasing the value of each share.

4. **Withdrawal Period**: Implements a customizable withdrawal period to prevent sudden large outflows.

5. **Blacklisting**: Allows designated managers to blacklist addresses, preventing them from transferring tokens.

6. **Rescue Functionality**: Enables the admin to rescue any accidentally sent tokens, except for the vault token and underlying asset.

### Roles:

- **DEFAULT_ADMIN_ROLE**: Can set other roles and change critical parameters.
- **REBASE_MANAGER_ROLE**: Can perform rebases to add assets to the vault.
- **BLACKLIST_MANAGER_ROLE**: Can add or remove addresses from the blacklist.

### Key Functions:

- `createWithdrawalDemand`: Users must create a withdrawal demand before withdrawing.
- `withdraw` and `redeem`: Override ERC4626 functions to enforce the withdrawal period and demand system.
- `rebase`: Allows adding assets to the vault, increasing the value of each share.
- `blacklistAccount` and `unblacklistAccount`: Manage the blacklist.
- `rescueToken`: Allows the admin to recover accidentally sent tokens.
- `setRebaseManager`: Grants the REBASE_MANAGER_ROLE to a specified address.
- `setWithdrawPeriod`: Allows the admin to update the withdrawal period.

### Security Features:

- Implements ReentrancyGuard to prevent reentrancy attacks.
- Uses SafeERC20 for secure token transfers.
- Enforces a withdrawal period to prevent sudden large outflows.
- Includes a blacklist feature to restrict malicious actors.
- Checks for zero amounts and failed transfers in the rebase function.
- Prevents rescuing of the vault token and underlying asset.

### Contract Structure:

- Inherits from ERC4626, AccessControl, ReentrancyGuard, and IStakingVault.
- Uses OpenZeppelin's implementation of ERC20Permit (through ERC4626).
- Defines constants for role management (REBASE_MANAGER_ROLE, BLACKLIST_MANAGER_ROLE).
- Implements a WithdrawalDemand struct to manage withdrawal requests.
- Uses mappings for withdrawal demands and blacklist management.

### Constructor:

- Initializes the contract with the underlying asset, name, and symbol.
- Sets up initial roles and default withdrawal period.

The StakingVault provides a secure and flexible solution for asset staking, with built-in protections and management capabilities to ensure the stability and security of the staked assets. It leverages OpenZeppelin's battle-tested contracts and follows best practices in smart contract development.

## Test Coverage

| File                        | % Stmts | % Funcs | % Lines |
| --------------------------- | ------- | ------- | ------- |
| contracts/MinterHandler.sol | 96.43%  | 100.00% | 97.87%  |
| contracts/RedeemHandler.sol | 97.62%  | 90.00%  | 96.43%  |
| contracts/StakingVault.sol  | 100.00% | 100.00% | 100.00% |
| contracts/USN.sol          | 100.00% | 100.00% | 100.00% |
