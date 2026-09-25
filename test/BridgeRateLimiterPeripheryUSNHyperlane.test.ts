import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  USNHyperlane,
  MockMailbox,
  BridgeRateLimiter,
} from '../typechain-types';
import {
  TRANSPORT_HYPERLANE,
  HL_DOMAIN,
  deployAndWireRateLimiter,
} from './helpers/bridgeRateLimiter';

// periphery/USNHyperlane is the Hyperlane-only remote USN/sUSN token (deployed
// as USN on TAC and as the sUSN endpoint of the mainnet vault's TAC route). It
// has no LZ/OFT path, so this suite only exercises the two Hyperlane hook
// points — the same shape as the StakedUSNHyperlane suite. Hashlock L-01.
const HL_DOMAIN_B = 42;

describe('BridgeRateLimiter — periphery/USNHyperlane', function () {
  let token: USNHyperlane;
  let limiter: BridgeRateLimiter;
  let mockMailbox: MockMailbox;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;

  async function deployToken(): Promise<USNHyperlane> {
    const Factory = await ethers.getContractFactory('USNHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['USN', 'USN', await owner.getAddress()],
      { initializer: 'initialize' }
    );
    return Factory.attach(await proxy.getAddress()) as unknown as USNHyperlane;
  }

  // Seed balance via Hyperlane handle — the only mint path on this contract
  async function seedBalance(
    tok: USNHyperlane,
    recipient: string,
    amount: bigint,
    domain = 7
  ) {
    const mailboxAddr = await mockMailbox.getAddress();
    await network.provider.send('hardhat_setBalance', [
      mailboxAddr,
      '0x1000000000000000000',
    ]);
    const impersonated = await ethers.getImpersonatedSigner(mailboxAddr);
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    // Register if needed (idempotent — re-registering same value is fine)
    await tok.registerHyperlaneRemoteToken(domain, remoteToken);
    const message = ethers.concat([
      ethers.zeroPadValue(recipient, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    await tok.connect(impersonated).handle(domain, remoteToken, message);
  }

  async function handleAs(
    origin: number,
    recipientAddr: string,
    amount: bigint
  ) {
    const mailboxImpersonated = await ethers.getImpersonatedSigner(
      await mockMailbox.getAddress()
    );
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    const message = ethers.concat([
      ethers.zeroPadValue(recipientAddr, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    return token
      .connect(mailboxImpersonated)
      .handle(origin, remoteToken, message);
  }

  beforeEach(async function () {
    [owner, user, other, outsider] = await ethers.getSigners();

    const MailboxFactory = await ethers.getContractFactory('MockMailbox');
    mockMailbox = (await MailboxFactory.deploy()) as MockMailbox;

    token = await deployToken();
    limiter = await deployAndWireRateLimiter(owner, token);

    await token.configureHyperlane(await mockMailbox.getAddress());
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    await token.registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);
    await token.registerHyperlaneRemoteToken(HL_DOMAIN_B, remoteToken);

    await seedBalance(
      token,
      await user.getAddress(),
      ethers.parseUnits('100', 18)
    );
  });

  // ── Token-side wiring ────────────────────────────────────────────────────

  describe('setRateLimiter', function () {
    it('reverts for non-owner', async function () {
      await expect(
        token.connect(outsider).setRateLimiter(await limiter.getAddress())
      ).to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount');
    });

    it('rejects a non-zero address with no code', async function () {
      await expect(
        token.setRateLimiter(await outsider.getAddress())
      ).to.be.revertedWithCustomError(token, 'InvalidRateLimiter');
    });

    it('emits RateLimiterSet and exposes the wired address', async function () {
      const Factory = await ethers.getContractFactory('BridgeRateLimiter');
      const fresh = await Factory.deploy(await owner.getAddress());
      await expect(token.setRateLimiter(await fresh.getAddress()))
        .to.emit(token, 'RateLimiterSet')
        .withArgs(await fresh.getAddress());
      expect(await token.rateLimiter()).to.equal(await fresh.getAddress());
    });

    it('address(0) unwires: bridge paths bypass the limiter entirely', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      // Wired: over-limit send reverts
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');

      // Unwired: same send passes, and the limiter bucket is untouched
      await token.setRateLimiter(ethers.ZeroAddress);
      expect(await token.rateLimiter()).to.equal(ethers.ZeroAddress);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.not.be.reverted;
      const { available } = await limiter.getRateLimit(
        await token.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(TEN);
    });
  });

  // ── Storage layout ───────────────────────────────────────────────────────

  describe('storage layout', function () {
    it('rateLimiter packs into slot 4 beside hyperlaneEnabled — no new slot for the live proxies', async function () {
      // Every inherited base is ERC-7201 namespaced, so this contract's own
      // variables start at slot 0: blacklist(0) mailbox(1) _ism(2)
      // remoteTokens(3) hyperlaneEnabled(4, byte 0) rateLimiter(4, bytes 1-20).
      // Read raw rather than through the ABI so a layout shift that still
      // happens to decode correctly is caught.
      const limiterAddr = await limiter.getAddress();
      const expected = ethers.toBeHex((BigInt(limiterAddr) << 8n) | 1n, 32);
      expect(
        await ethers.provider.getStorage(await token.getAddress(), 4)
      ).to.equal(expected);
      expect(
        await ethers.provider.getStorage(await token.getAddress(), 5)
      ).to.equal(ethers.ZeroHash);
    });
  });

  // ── Limiter admin surface ────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-owner', async function () {
      await expect(
        limiter.connect(outsider).setRateLimits(await token.getAddress(), [
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      ).to.be.revertedWithCustomError(limiter, 'OwnableUnauthorizedAccount');
    });

    it('emits RateLimitSet', async function () {
      await expect(
        limiter.setRateLimits(await token.getAddress(), [
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      )
        .to.emit(limiter, 'RateLimitSet')
        .withArgs(
          await token.getAddress(),
          TRANSPORT_HYPERLANE,
          HL_DOMAIN,
          true,
          LIMIT,
          WINDOW
        );
    });
  });

  // ── Hyperlane outbound (sendTokensViaHyperlane → rate limit → _burn) ─────

  describe('Hyperlane outbound rate limit', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
    });

    async function setLimit() {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
    }

    it('passes when limit is 0 (unlimited)', async function () {
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('passes when amount is under limit', async function () {
      await setLimit();
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('passes when amount equals limit exactly', async function () {
      await setLimit();
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when over limit, and burns nothing', async function () {
      await setLimit();
      await seedBalance(token, await user.getAddress(), ONE);
      const balBefore = await token.balanceOf(await user.getAddress());
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });

    it('reverts when cumulative sends exceed limit', async function () {
      await setLimit();
      for (let i = 0; i < 5; i++) {
        await token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });
      }
      // 5 × 10 = 50 = LIMIT exhausted
      await seedBalance(token, await user.getAddress(), ONE);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
    });
  });

  // ── Hyperlane inbound (handle → rate limit → _mint) ──────────────────────

  describe('Hyperlane inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await token.balanceOf(await user.getAddress());
      await expect(handleAs(HL_DOMAIN, await user.getAddress(), TEN)).to.not.be
        .reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await token.balanceOf(await user.getAddress());
      await expect(handleAs(HL_DOMAIN, await user.getAddress(), TEN)).to.not.be
        .reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit, and mints nothing', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await token.balanceOf(await user.getAddress());
      await expect(
        handleAs(HL_DOMAIN, await user.getAddress(), LIMIT + ONE)
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── Window decay ─────────────────────────────────────────────────────────

  describe('window decay', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
    });

    it('fully decays after window elapses', async function () {
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await time.increase(Number(WINDOW));
      await seedBalance(token, await user.getAddress(), LIMIT);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });

    it('available never goes below zero when decay exceeds in-flight', async function () {
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 });
      await time.increase(Number(WINDOW * 10n));
      const { available } = await limiter.getRateLimit(
        await token.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(LIMIT);
    });
  });

  // ── resetInFlight ────────────────────────────────────────────────────────

  describe('resetInFlight', function () {
    it('reverts for non-owner', async function () {
      await expect(
        limiter
          .connect(outsider)
          .resetInFlight(
            await token.getAddress(),
            TRANSPORT_HYPERLANE,
            HL_DOMAIN,
            true
          )
      ).to.be.revertedWithCustomError(limiter, 'OwnableUnauthorizedAccount');
    });

    it('clears in-flight and restores availability', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');

      await limiter.resetInFlight(
        await token.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );

      await seedBalance(token, await user.getAddress(), LIMIT);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });
  });

  // ── Cross-key isolation ───────────────────────────────────────────────────

  describe('cross-key isolation', function () {
    it('exhausting (domain=HL_DOMAIN, outbound) does not affect (domain=HL_DOMAIN_B, outbound)', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN_B,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);

      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');

      // The bucket for HL_DOMAIN_B must be unaffected
      await seedBalance(token, await user.getAddress(), TEN);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN_B, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('exhausting outbound does not affect inbound for the same domain', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);

      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');

      // Inbound bucket for the same domain must be unaffected
      const balBefore = await token.balanceOf(await user.getAddress());
      await expect(handleAs(HL_DOMAIN, await user.getAddress(), LIMIT)).to.not
        .be.reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + LIMIT
      );
    });
  });

  // ── window == 0 (per-transaction cap) ────────────────────────────────────

  describe('window == 0 (per-transaction cap)', function () {
    it('decays instantly — limit applies per transaction, no accumulation', async function () {
      await limiter.setRateLimits(await token.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: 0,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);

      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      await seedBalance(token, await user.getAddress(), TEN);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      await seedBalance(token, await user.getAddress(), TEN + ONE);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiter, 'RateLimitExceeded');
    });
  });
});
