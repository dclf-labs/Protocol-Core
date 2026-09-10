import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  USNUpgradeableHyperlane,
  BridgeRateLimiter,
} from '../typechain-types';
import {
  TRANSPORT_LZ,
  TRANSPORT_HYPERLANE,
  deployAndWireRateLimiter,
} from './helpers/bridgeRateLimiter';

// ── Constants ─────────────────────────────────────────────────────────────────

const USN_PROXY = '0xdA67B4284609d2d48e5d10cfAc411572727dc1eD';
const LZ_ENDPOINT = '0x1a44076050125825900e736c501f859c50fE728c';
const SOPHON_EID = 30225;
const ZKSYNC_EID = 30165;

// EIP-1967 admin slot — holds the ProxyAdmin address for Transparent proxies
const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// ── ERC-7201 storage slot roots ───────────────────────────────────────────────
//
// Each entry is the first word of a storage namespace. Reading these via
// provider.getStorage() returns raw bytes rather than ABI-decoded values, so
// layout shifts that coincidentally decode correctly through the ABI are still
// caught. Slots with non-zero first-word scalars are chosen for maximum signal:
//
//   ERC20   root+2     = _totalSupply   (uint256; root+0 is a mapping ≡ 0)
//   Ownable root+0     = _owner address
//
// OAppCore root+0 is the peers mapping base, which is always zero (a mapping
// stores nothing at its base slot) — not a meaningful check on its own. Instead
// zkSyncPeer below is the mapping *entry* slot for peers[ZKSYNC_EID]:
// keccak256(abi.encode(uint256(ZKSYNC_EID), OAppCoreStorageLocation)). zkSync
// (not Sophon) is the peer actually configured non-zero on mainnet today, so
// it's the one that makes this a meaningful raw-slot check. endpoint is an
// immutable baked into bytecode, not proxy storage, so it has no slot to check
// at all. USNUpgradeableHyperlane also does not inherit ReentrancyGuardUpgradeable
// (only the vault does), so there is no reentrancy namespace to check here
// either. EIP712Upgradeable's _hashedName/_hashedVersion are legacy fields OZ
// 5.x explicitly zeroes on init (the domain separator is rebuilt from
// _name/_version instead), so that namespace has no non-zero scalar to check
// either.
//
// rateLimiter (the pointer to the standalone BridgeRateLimiter contract) is a
// plain linear-storage variable appended after the existing declared fields —
// not an ERC-7201 namespace — so there's no hash-derived slot to collide-check
// here; its "no pre-existing garbage" proof is the functional read-back below
// (proxy.rateLimiter() == address(0) immediately post-upgrade).

// OAppCoreStorageLocation — ERC-7201 root of the peers mapping (OAppCoreUpgradeable.sol):
// keccak256(abi.encode(uint256(keccak256("layerzerov2.storage.oappcore")) - 1)) & ~bytes32(uint256(0xff))
const OAPPCORE_STORAGE_LOCATION =
  '0x72ab1bc1039b79dc4724ffca13de82c96834302d3c7e0d4252232d4b2dd8f900';
const zkSyncPeerSlot = ethers.keccak256(
  ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(ZKSYNC_EID), 32),
    OAPPCORE_STORAGE_LOCATION,
  ])
);

const RAW_SLOTS = {
  erc20TotalSupply:
    '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace02',
  ownableOwner:
    '0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300',
  zkSyncPeer: zkSyncPeerSlot,
} as const;

const PROXY_ADMIN_ABI = [
  'function owner() view returns (address)',
  'function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable',
];

async function fund(addr: string) {
  await network.provider.send('hardhat_setBalance', [
    addr,
    '0xde0b6b3a7640000',
  ]);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('USNUpgradeableHyperlane — mainnet fork upgrade safety', function () {
  // Skip entire suite when no RPC URL is available
  before(function () {
    if (!process.env.ETHEREUM_MAINNET_RPC_URL) this.skip();
  });

  let proxy: USNUpgradeableHyperlane;

  // Pre-upgrade state snapshot — all read before the implementation is swapped
  // Raw storage slot snapshots — bytes32 values read directly from the proxy
  // storage trie, independent of the contract ABI
  let rawBefore: Record<keyof typeof RAW_SLOTS, string>;
  let rawAfter: Record<keyof typeof RAW_SLOTS, string>;

  let snap: {
    totalSupply: bigint;
    owner: string;
    admin: string;
    permissionless: boolean;
    hyperlaneEnabled: boolean;
    mailbox: string;
    adminBalance: bigint;
    sophonPeer: string;
    adminWhitelisted: boolean;
    adminBlacklisted: boolean;
  };

  before(async function () {
    this.timeout(120_000);

    // 1. Fork mainnet at current block
    await network.provider.request({
      method: 'hardhat_reset',
      params: [
        { forking: { jsonRpcUrl: process.env.ETHEREUM_MAINNET_RPC_URL } },
      ],
    });

    proxy = (await ethers.getContractAt(
      'USNUpgradeableHyperlane',
      USN_PROXY
    )) as unknown as USNUpgradeableHyperlane;

    // 2. Snapshot raw storage slots before the upgrade
    rawBefore = {
      erc20TotalSupply: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.erc20TotalSupply
      ),
      ownableOwner: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.ownableOwner
      ),
      zkSyncPeer: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.zkSyncPeer
      ),
    };

    // 3. Snapshot every piece of state we care about preserving
    const adminAddr = await proxy.admin();
    snap = {
      totalSupply: await proxy.totalSupply(),
      owner: await proxy.owner(),
      admin: adminAddr,
      permissionless: await proxy.permissionless(),
      hyperlaneEnabled: await proxy.hyperlaneEnabled(),
      mailbox: await proxy.mailbox(),
      adminBalance: await proxy.balanceOf(adminAddr),
      sophonPeer: await proxy.peers(SOPHON_EID),
      adminWhitelisted: await proxy.whitelistedAddresses(adminAddr),
      adminBlacklisted: await proxy.blacklist(adminAddr),
    };

    // 4. Locate ProxyAdmin and its controller via EIP-1967 admin slot
    const raw = await ethers.provider.getStorage(USN_PROXY, EIP1967_ADMIN_SLOT);
    const proxyAdminAddr = ethers.getAddress('0x' + raw.slice(-40));
    const proxyAdmin = new ethers.Contract(
      proxyAdminAddr,
      PROXY_ADMIN_ABI,
      ethers.provider
    );
    const proxyAdminOwner: string = await proxyAdmin.owner();

    await fund(proxyAdminOwner);
    const adminOwnerSigner =
      await ethers.getImpersonatedSigner(proxyAdminOwner);

    // 4. Deploy new implementation against the real mainnet LZ endpoint
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory(
      'USNUpgradeableHyperlane',
      deployer
    );
    const newImpl = await Factory.deploy(LZ_ENDPOINT);
    await newImpl.waitForDeployment();

    // 4b. Automated upgrade-safety check on the new implementation. Unlike
    // the sUSN vault, this proxy's mainnet layout isn't registered in
    // .openzeppelin/mainnet.json (it was never deployed/upgraded through the
    // OZ Upgrades plugin), so validateUpgrade can't diff it against a
    // tracked "before" layout without first importing the pre-rate-limiter
    // source as a reference — validateImplementation still catches storage-
    // layout hazards (e.g. unsafe delegatecall, missing initializer guards)
    // in the new implementation on its own; the manual raw-slot assertions
    // below are what actually pin the before/after comparison for this file.
    await upgrades.validateImplementation(Factory, {
      constructorArgs: [LZ_ENDPOINT],
      unsafeAllow: ['constructor'],
    });

    // 5. Upgrade — proxy storage must survive untouched
    await proxyAdmin
      .connect(adminOwnerSigner)
      .upgradeAndCall(USN_PROXY, await newImpl.getAddress(), '0x');

    // 6. Re-snapshot raw storage slots after the upgrade
    rawAfter = {
      erc20TotalSupply: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.erc20TotalSupply
      ),
      ownableOwner: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.ownableOwner
      ),
      zkSyncPeer: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.zkSyncPeer
      ),
    };
  });

  // ── Storage preservation ──────────────────────────────────────────────────

  it('totalSupply is unchanged after upgrade', async function () {
    expect(await proxy.totalSupply()).to.equal(snap.totalSupply);
  });

  it('owner is unchanged after upgrade', async function () {
    expect(await proxy.owner()).to.equal(snap.owner);
  });

  it('admin is unchanged after upgrade', async function () {
    expect(await proxy.admin()).to.equal(snap.admin);
  });

  it('permissionless flag is unchanged after upgrade', async function () {
    expect(await proxy.permissionless()).to.equal(snap.permissionless);
  });

  it('hyperlaneEnabled is unchanged after upgrade', async function () {
    expect(await proxy.hyperlaneEnabled()).to.equal(snap.hyperlaneEnabled);
  });

  it('admin token balance is unchanged after upgrade', async function () {
    expect(await proxy.balanceOf(snap.admin)).to.equal(snap.adminBalance);
  });

  it('Sophon LZ peer is unchanged after upgrade', async function () {
    expect(await proxy.peers(SOPHON_EID)).to.equal(snap.sophonPeer);
  });

  it('admin whitelist status is unchanged after upgrade', async function () {
    expect(await proxy.whitelistedAddresses(snap.admin)).to.equal(
      snap.adminWhitelisted
    );
  });

  it('admin blacklist status is unchanged after upgrade', async function () {
    expect(await proxy.blacklist(snap.admin)).to.equal(snap.adminBlacklisted);
  });

  it('mailbox address is unchanged after upgrade', async function () {
    expect(await proxy.mailbox()).to.equal(snap.mailbox);
  });

  // ── Storage layout — raw slot validation ─────────────────────────────────
  //
  // These assertions read bytes32 values directly from the proxy storage trie,
  // bypassing the ABI. A layout shift that coincidentally decodes to the same
  // value through the ABI would still fail here because the raw bytes differ.
  //
  describe('storage layout — raw slot validation', function () {
    it('rateLimiter is unset immediately after upgrade (fresh linear-storage slot, no pre-existing garbage)', async function () {
      expect(await proxy.rateLimiter()).to.equal(ethers.ZeroAddress);
    });

    it('ERC20 totalSupply slot is byte-identical after upgrade', async function () {
      expect(rawAfter.erc20TotalSupply).to.equal(rawBefore.erc20TotalSupply);
      expect(rawBefore.erc20TotalSupply).to.not.equal(ethers.ZeroHash);
    });

    it('Ownable owner slot is byte-identical after upgrade', async function () {
      expect(rawAfter.ownableOwner).to.equal(rawBefore.ownableOwner);
      expect(rawBefore.ownableOwner).to.not.equal(ethers.ZeroHash);
    });

    it('zkSync peer mapping entry slot is byte-identical after upgrade', async function () {
      expect(rawAfter.zkSyncPeer).to.equal(rawBefore.zkSyncPeer);
      expect(rawBefore.zkSyncPeer).to.not.equal(ethers.ZeroHash);
    });
  });

  // ── Fail-open before the limiter is wired ─────────────────────────────────
  //
  // ORDERING NOTE: must run after the raw-slot describe above (which asserts
  // rateLimiter is still address(0)) and before "rate limiter enforcement"
  // below (which wires it). Every _checkAndUpdateRateLimit call site guards
  // the external call with `if (limiter != address(0))`, so an implementation
  // upgrade that lands before setRateLimiter() is called must NOT brick
  // bridging — it's simply unenforced, same as pre-upgrade. Uses its own
  // Hyperlane domain (50) so it can't collide with the "rate limiter
  // enforcement" describe's own setup below.

  it('bridging still works immediately after upgrade, before the limiter is wired (fail-open, not fail-closed)', async function () {
    this.timeout(60_000);
    expect(await proxy.rateLimiter()).to.equal(ethers.ZeroAddress);

    const PRE_WIRE_DOMAIN = 50;
    const MockMailboxFactory = await ethers.getContractFactory('MockMailbox');
    const mockMailbox = await MockMailboxFactory.deploy();
    const mockMailboxAddr = await mockMailbox.getAddress();

    await fund(snap.owner);
    const ownerSigner = await ethers.getImpersonatedSigner(snap.owner);
    if (!snap.permissionless) {
      await proxy.connect(ownerSigner).enablePermissionless();
    }
    await proxy.connect(ownerSigner).configureHyperlane(mockMailboxAddr);
    const remoteToken = ethers.zeroPadValue(
      ethers.Wallet.createRandom().address,
      32
    );
    await proxy
      .connect(ownerSigner)
      .registerHyperlaneRemoteToken(PRE_WIRE_DOMAIN, remoteToken);

    // Inbound: handle() must succeed with nothing wired
    await fund(mockMailboxAddr);
    const mailboxSigner = await ethers.getImpersonatedSigner(mockMailboxAddr);
    const [, , , recipient] = await ethers.getSigners();
    const amount = ethers.parseUnits('1', 18);
    const message = ethers.concat([
      ethers.zeroPadValue(await recipient.getAddress(), 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    const balBefore = await proxy.balanceOf(await recipient.getAddress());
    await expect(
      proxy
        .connect(mailboxSigner)
        .handle(PRE_WIRE_DOMAIN, remoteToken, message)
    ).to.not.be.reverted;
    expect(await proxy.balanceOf(await recipient.getAddress())).to.equal(
      balBefore + amount
    );

    // Outbound: sendTokensViaHyperlane() must succeed with nothing wired.
    // (Not exercising the LZ send() path here — it requires a real configured
    // peer for quoting/delivery, which is a live-mainnet-state dependency
    // unrelated to what this test is isolating; the LZ _debit call site gets
    // the same `if (limiter != address(0))` guard as every other one, and
    // Hyperlane outbound already proves the guard fires correctly.)
    await fund(snap.admin);
    const adminSigner = await ethers.getImpersonatedSigner(snap.admin);
    const [, , testUser] = await ethers.getSigners();
    const testUserAddr = await testUser.getAddress();
    await proxy.connect(adminSigner).mint(testUserAddr, amount);
    const outboundRecipient = ethers.zeroPadValue(
      await recipient.getAddress(),
      32
    );
    await expect(
      proxy
        .connect(testUser)
        .sendTokensViaHyperlane(PRE_WIRE_DOMAIN, outboundRecipient, amount, {
          value: 0,
        })
    ).to.not.be.reverted;
  });

  // ── Rate limiter wired up on the upgraded proxy ───────────────────────────
  //
  // ORDERING NOTE: the storage-preservation `it` blocks above must remain
  // before this describe — its `before()` mutates proxy state (enablePermissionless,
  // configureHyperlane) that the outer assertions read in their pre-upgrade form.
  //
  // These tests confirm the standalone BridgeRateLimiter is correctly wired
  // into the upgraded proxy — i.e., that setRateLimiter() takes effect and
  // that the send/receive hooks actually reach it.

  describe('rate limiter enforcement on the upgraded proxy', function () {
    const RATE_LIMIT = ethers.parseUnits('100', 18);
    const WINDOW = 86400n;
    const OVER_LIMIT = RATE_LIMIT + ethers.parseUnits('1', 18);
    const HL_DOMAIN = 100; // arbitrary — just needs a registered remote token

    let mockMailboxAddr: string;
    let limiter: BridgeRateLimiter;

    before(async function () {
      this.timeout(60_000);

      await fund(snap.owner);
      const ownerSigner = await ethers.getImpersonatedSigner(snap.owner);

      limiter = await deployAndWireRateLimiter(
        ownerSigner,
        proxy.connect(ownerSigner) as unknown as USNUpgradeableHyperlane
      );

      // Open permissionless mode so test mints can reach arbitrary addresses
      // without requiring whitelist management in this fork context
      if (!snap.permissionless) {
        await proxy.connect(ownerSigner).enablePermissionless();
      }

      // Configure a fresh MockMailbox so Hyperlane inbound is reachable
      // regardless of what was (or wasn't) configured on mainnet
      const MockMailboxFactory = await ethers.getContractFactory('MockMailbox');
      const mockMailbox = await MockMailboxFactory.deploy();
      mockMailboxAddr = await mockMailbox.getAddress();
      await proxy.connect(ownerSigner).configureHyperlane(mockMailboxAddr);

      // Register a remote token for the test Hyperlane domain
      const remoteToken = ethers.zeroPadValue(
        ethers.Wallet.createRandom().address,
        32
      );
      await proxy
        .connect(ownerSigner)
        .registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);

      // Set rate limits for both directions under test
      await limiter
        .connect(ownerSigner)
        .setRateLimits(await proxy.getAddress(), [
          {
            transport: TRANSPORT_LZ,
            remoteId: SOPHON_EID,
            outbound: true,
            limit: RATE_LIMIT,
            window: WINDOW,
          },
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: false,
            limit: RATE_LIMIT,
            window: WINDOW,
          },
        ]);
    });

    it('getRateLimit reflects the configured LZ outbound limit', async function () {
      const { limit, window } = await limiter.getRateLimit(
        await proxy.getAddress(),
        TRANSPORT_LZ,
        SOPHON_EID,
        true
      );
      expect(limit).to.equal(RATE_LIMIT);
      expect(window).to.equal(WINDOW);
    });

    it('LZ outbound: send over rate limit reverts with RateLimitExceeded', async function () {
      // Mint tokens to a local test address so there is a balance to attempt sending
      await fund(snap.admin);
      const adminSigner = await ethers.getImpersonatedSigner(snap.admin);
      const [, , testUser] = await ethers.getSigners();
      const testUserAddr = await testUser.getAddress();
      await proxy.connect(adminSigner).mint(testUserAddr, OVER_LIMIT);

      // send() calls _debit() (OFTCoreUpgradeable.sol line 205) before _lzSend()
      // (line 215). _payNative's msg.value check lives inside _lzSend, so a
      // rate-limit revert in _debit is reached before msg.value is inspected —
      // passing { nativeFee: 0n } with no { value } here is intentional.
      const sendParam = {
        dstEid: SOPHON_EID,
        to: ethers.zeroPadValue(testUserAddr, 32),
        amountLD: OVER_LIMIT,
        minAmountLD: OVER_LIMIT,
        extraOptions: '0x00030100110100000000000000000000000000030d40',
        composeMsg: '0x',
        oftCmd: '0x',
      };
      await expect(
        proxy
          .connect(testUser)
          .send(sendParam, { nativeFee: 0n, lzTokenFee: 0n }, testUserAddr)
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
    });

    it('Hyperlane inbound: handle over rate limit reverts with RateLimitExceeded', async function () {
      await fund(mockMailboxAddr);
      const mailboxSigner = await ethers.getImpersonatedSigner(mockMailboxAddr);
      const remoteToken = await proxy.remoteTokens(HL_DOMAIN);
      const [, , , recipient] = await ethers.getSigners();

      // Rate limit check fires before _mint, so no tokens are created on revert
      const message = ethers.concat([
        ethers.zeroPadValue(await recipient.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(OVER_LIMIT), 32),
      ]);
      await expect(
        proxy.connect(mailboxSigner).handle(HL_DOMAIN, remoteToken, message)
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
    });
  });
});
