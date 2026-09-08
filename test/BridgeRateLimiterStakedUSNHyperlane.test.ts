import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type { StakedUSNHyperlane, MockMailbox } from '../typechain-types';
import { TRANSPORT_HYPERLANE, HL_DOMAIN } from './helpers/bridgeRateLimiter';

// StakedUSNHyperlane has no LZ/OFT path — Hyperlane is its only bridge
// transport, so this suite only exercises the two Hyperlane hook points.
const HL_DOMAIN_B = 42;

describe('BridgeRateLimiterUpgradeable — StakedUSNHyperlane', function () {
  let token: StakedUSNHyperlane;
  let mockMailbox: MockMailbox;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;

  async function deployToken(): Promise<StakedUSNHyperlane> {
    const Factory = await ethers.getContractFactory('StakedUSNHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['Staked USN', 'sUSN', await owner.getAddress()],
      { initializer: 'initialize' }
    );
    return Factory.attach(
      await proxy.getAddress()
    ) as unknown as StakedUSNHyperlane;
  }

  // Seed balance via Hyperlane handle — the only mint path on this contract
  async function seedBalance(
    tok: StakedUSNHyperlane,
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

  beforeEach(async function () {
    [owner, user, other, outsider] = await ethers.getSigners();

    const MailboxFactory = await ethers.getContractFactory('MockMailbox');
    mockMailbox = (await MailboxFactory.deploy()) as MockMailbox;

    token = await deployToken();

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

  // ── Admin surface ────────────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-owner', async function () {
      await expect(
        token.connect(outsider).setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      ).to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount');
    });

    it('emits RateLimitSet', async function () {
      await expect(
        token.setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      )
        .to.emit(token, 'RateLimitSet')
        .withArgs(TRANSPORT_HYPERLANE, HL_DOMAIN, true, LIMIT, WINDOW);
    });

    it('reverts with InvalidTransport for unknown transport value', async function () {
      await expect(
        token.setRateLimits([
          {
            transport: 2, // > TRANSPORT_HYPERLANE (1)
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      ).to.be.revertedWithCustomError(token, 'InvalidTransport');
    });
  });

  // ── Hyperlane outbound ───────────────────────────────────────────────────

  describe('Hyperlane outbound rate limit', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
    });

    it('passes when limit is 0 (unlimited)', async function () {
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('passes when amount is under limit', async function () {
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      await seedBalance(token, await user.getAddress(), ONE);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');
    });
  });

  // ── Hyperlane inbound ────────────────────────────────────────────────────

  describe('Hyperlane inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await token.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        token
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await token.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        token
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await token.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(LIMIT + ONE), 32),
      ]);
      await expect(
        token
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');
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
      await token.setRateLimits([
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
      const { available } = await token.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(LIMIT);
    });

    it('decay rate is proportional to limit, not in-flight amount (LZ formula)', async function () {
      // Send well under limit (20 of 50), then wait half the window.
      // decay = limit * elapsed / window = 50 * 43200 / 86400 = 25.
      // Since inFlight(20) <= decay(25), currentInFlight = 0 → available = limit.
      const sendAmount = ethers.parseUnits('20', 18);
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, sendAmount, { value: 0 });
      await time.increase(Number(WINDOW / 2n));
      const { available } = await token.getRateLimit(
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
        token
          .connect(outsider)
          .resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true)
      ).to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount');
    });

    it('emits InFlightReset with the rate limit key', async function () {
      const expectedKey = ethers.keccak256(
        ethers.solidityPacked(
          ['uint8', 'uint32', 'bool'],
          [TRANSPORT_HYPERLANE, HL_DOMAIN, true]
        )
      );
      await expect(token.resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true))
        .to.emit(token, 'InFlightReset')
        .withArgs(expectedKey);
    });

    it('clears in-flight and restores availability', async function () {
      await token.setRateLimits([
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
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');

      await token.resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true);

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
      await token.setRateLimits([
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
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');

      // The bucket for HL_DOMAIN_B must be unaffected
      await seedBalance(token, await user.getAddress(), TEN);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN_B, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('exhausting outbound does not affect inbound for the same domain', async function () {
      await token.setRateLimits([
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
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');

      // Inbound bucket for the same domain must be unaffected
      const balBefore = await token.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(LIMIT), 32),
      ]);
      await expect(
        token
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await token.balanceOf(await user.getAddress())).to.equal(
        balBefore + LIMIT
      );
    });
  });

  // ── Limit update mid-window ───────────────────────────────────────────────

  describe('limit update mid-window', function () {
    it('lowering limit below amountInFlight clamps available to 0 without reverting', async function () {
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      const half = LIMIT / 2n;
      await token
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, half, { value: 0 });

      // Drop limit below current amountInFlight (~half)
      const newLimit = half / 2n;
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: newLimit,
          window: WINDOW,
        },
      ]);

      // available must clamp to 0, no underflow
      const { available } = await token.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(0n);

      // Any further send on this key must revert
      await seedBalance(token, await user.getAddress(), ONE);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');
    });
  });

  // ── window == 0 (per-transaction cap) ────────────────────────────────────

  describe('window == 0 (per-transaction cap)', function () {
    it('decays instantly — limit applies per transaction, no accumulation', async function () {
      // window == 0: amountInFlight decays to zero on every check, so the limit
      // acts as a per-tx ceiling rather than a sliding-window accumulator.
      await token.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: 0,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);

      // First tx at exactly the limit — passes
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      // Immediately after: in-flight has decayed to zero, full limit is restored
      await seedBalance(token, await user.getAddress(), TEN);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      // A single tx over the per-tx cap still reverts
      await seedBalance(token, await user.getAddress(), TEN + ONE);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.be.revertedWithCustomError(token, 'RateLimitExceeded');
    });
  });
});
