import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import type { USNUpgradeableHyperlane } from '../typechain-types';
import { TRANSPORT_LZ, TRANSPORT_HYPERLANE } from './helpers/bridgeRateLimiter';

// ── Constants ─────────────────────────────────────────────────────────────────

const USN_PROXY = '0xdA67B4284609d2d48e5d10cfAc411572727dc1eD';
const LZ_ENDPOINT = '0x1a44076050125825900e736c501f859c50fE728c';
const SOPHON_EID = 30225;

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
//   OAppCore root+0    = endpoint address
//   ReentrancyGuard root+0 = _status uint256 (1 = NOT_ENTERED)
//
// The BridgeRateLimiter slot must be zero pre-upgrade to prove it does not
// collide with any pre-existing storage.

const RAW_SLOTS = {
  erc20TotalSupply:
    '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace02',
  ownableOwner:
    '0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300',
  lzEndpoint:
    '0x72ab1bc1039b79dc4724ffca13de82c96834302d3c7e0d4252232d4b2dd8f900',
  reentrancyStatus:
    '0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00',
  bridgeRateLimiter:
    '0x63a6a5fc9c18d1890bac0c27ad895de6f091c8269e5f94ea1fa52545fb6d7e00',
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
      lzEndpoint: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.lzEndpoint
      ),
      reentrancyStatus: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.reentrancyStatus
      ),
      bridgeRateLimiter: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.bridgeRateLimiter
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
      lzEndpoint: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.lzEndpoint
      ),
      reentrancyStatus: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.reentrancyStatus
      ),
      bridgeRateLimiter: await ethers.provider.getStorage(
        USN_PROXY,
        RAW_SLOTS.bridgeRateLimiter
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
  // The BridgeRateLimiter check specifically proves that its ERC-7201 slot
  // (keccak256("noon.storage.bridgeratelimiter") − 1, masked) did not overlap
  // any slot already occupied in the pre-upgrade proxy.

  describe('storage layout — raw slot validation', function () {
    it('BridgeRateLimiter ERC-7201 slot was zero pre-upgrade (no collision with existing storage)', async function () {
      expect(rawBefore.bridgeRateLimiter).to.equal(ethers.ZeroHash);
    });

    it('ERC20 totalSupply slot is byte-identical after upgrade', async function () {
      expect(rawAfter.erc20TotalSupply).to.equal(rawBefore.erc20TotalSupply);
      expect(rawBefore.erc20TotalSupply).to.not.equal(ethers.ZeroHash);
    });

    it('Ownable owner slot is byte-identical after upgrade', async function () {
      expect(rawAfter.ownableOwner).to.equal(rawBefore.ownableOwner);
      expect(rawBefore.ownableOwner).to.not.equal(ethers.ZeroHash);
    });

    it('LZ endpoint slot is byte-identical after upgrade', async function () {
      expect(rawAfter.lzEndpoint).to.equal(rawBefore.lzEndpoint);
      expect(rawBefore.lzEndpoint).to.not.equal(ethers.ZeroHash);
    });

    it('ReentrancyGuard status slot is byte-identical after upgrade', async function () {
      expect(rawAfter.reentrancyStatus).to.equal(rawBefore.reentrancyStatus);
      expect(rawBefore.reentrancyStatus).to.not.equal(ethers.ZeroHash);
    });
  });

  // ── Rate limiter wired up on the upgraded proxy ───────────────────────────
  //
  // ORDERING NOTE: the storage-preservation `it` blocks above must remain
  // before this describe — its `before()` mutates proxy state (enablePermissionless,
  // configureHyperlane) that the outer assertions read in their pre-upgrade form.
  //
  // These tests confirm that BridgeRateLimiterUpgradeable is correctly wired
  // into the upgraded proxy — i.e., that the ERC-7201 slot didn't collide with
  // any existing storage and that the send/receive hooks are reached.

  describe('rate limiter enforcement on the upgraded proxy', function () {
    const RATE_LIMIT = ethers.parseUnits('100', 18);
    const WINDOW = 86400n;
    const OVER_LIMIT = RATE_LIMIT + ethers.parseUnits('1', 18);
    const HL_DOMAIN = 100; // arbitrary — just needs a registered remote token

    let mockMailboxAddr: string;

    before(async function () {
      this.timeout(60_000);

      await fund(snap.owner);
      const ownerSigner = await ethers.getImpersonatedSigner(snap.owner);

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
      await proxy.connect(ownerSigner).setRateLimits([
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
      const { limit, window } = await proxy.getRateLimit(
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
      ).to.be.revertedWithCustomError(proxy, 'RateLimitExceeded');
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
      ).to.be.revertedWithCustomError(proxy, 'RateLimitExceeded');
    });
  });
});
