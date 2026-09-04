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

const PROXY_ADMIN_ABI = [
  'function owner() view returns (address)',
  'function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable',
];

async function fund(addr: string) {
  await network.provider.send('hardhat_setBalance', [addr, '0xde0b6b3a7640000']);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('USNUpgradeableHyperlane — mainnet fork upgrade safety', function () {
  // Skip entire suite when no RPC URL is available
  before(function () {
    if (!process.env.ETHEREUM_MAINNET_RPC_URL) this.skip();
  });

  let proxy: USNUpgradeableHyperlane;

  // Pre-upgrade state snapshot — all read before the implementation is swapped
  let snap: {
    totalSupply: bigint;
    owner: string;
    admin: string;
    permissionless: boolean;
    hyperlaneEnabled: boolean;
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
      params: [{ forking: { jsonRpcUrl: process.env.ETHEREUM_MAINNET_RPC_URL } }],
    });

    proxy = (await ethers.getContractAt(
      'USNUpgradeableHyperlane',
      USN_PROXY
    )) as unknown as USNUpgradeableHyperlane;

    // 2. Snapshot every piece of state we care about preserving
    const adminAddr = await proxy.admin();
    snap = {
      totalSupply: await proxy.totalSupply(),
      owner: await proxy.owner(),
      admin: adminAddr,
      permissionless: await proxy.permissionless(),
      hyperlaneEnabled: await proxy.hyperlaneEnabled(),
      adminBalance: await proxy.balanceOf(adminAddr),
      sophonPeer: await proxy.peers(SOPHON_EID),
      adminWhitelisted: await proxy.whitelistedAddresses(adminAddr),
      adminBlacklisted: await proxy.blacklist(adminAddr),
    };

    // 3. Locate ProxyAdmin and its controller via EIP-1967 admin slot
    const raw = await ethers.provider.getStorage(USN_PROXY, EIP1967_ADMIN_SLOT);
    const proxyAdminAddr = ethers.getAddress('0x' + raw.slice(-40));
    const proxyAdmin = new ethers.Contract(proxyAdminAddr, PROXY_ADMIN_ABI, ethers.provider);
    const proxyAdminOwner: string = await proxyAdmin.owner();

    await fund(proxyAdminOwner);
    const adminOwnerSigner = await ethers.getImpersonatedSigner(proxyAdminOwner);

    // 4. Deploy new implementation against the real mainnet LZ endpoint
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('USNUpgradeableHyperlane', deployer);
    const newImpl = await Factory.deploy(LZ_ENDPOINT);
    await newImpl.waitForDeployment();

    // 5. Upgrade — proxy storage must survive untouched
    await proxyAdmin
      .connect(adminOwnerSigner)
      .upgradeAndCall(USN_PROXY, await newImpl.getAddress(), '0x');
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
    expect(await proxy.whitelistedAddresses(snap.admin)).to.equal(snap.adminWhitelisted);
  });

  it('admin blacklist status is unchanged after upgrade', async function () {
    expect(await proxy.blacklist(snap.admin)).to.equal(snap.adminBlacklisted);
  });

  // ── Rate limiter wired up on the upgraded proxy ───────────────────────────
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
      await proxy.connect(ownerSigner).registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);

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
      const { limit, window } = await proxy.getRateLimit(TRANSPORT_LZ, SOPHON_EID, true);
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

      // The rate limit check fires inside _debit, before the LZ endpoint is
      // consulted, so no native fee is required for the revert to surface
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
