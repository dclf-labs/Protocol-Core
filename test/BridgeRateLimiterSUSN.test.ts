import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  StakedUSNOFTHyperlane,
  EndpointV2Mock,
  MockMailbox,
} from '../typechain-types';
import {
  TRANSPORT_LZ,
  TRANSPORT_HYPERLANE,
  CHAIN_ID_SRC,
  CHAIN_ID_DST,
  HL_DOMAIN,
  LZ_OPTIONS,
  lzReceiveAs,
} from './helpers/bridgeRateLimiter';

describe('BridgeRateLimiterUpgradeable — StakedUSNOFTHyperlane', function () {
  let tokenSrc: StakedUSNOFTHyperlane;
  let tokenDst: StakedUSNOFTHyperlane;
  let endpointSrc: EndpointV2Mock;
  let endpointDst: EndpointV2Mock;
  let mockMailbox: MockMailbox;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;

  async function deployToken(
    endpoint: EndpointV2Mock
  ): Promise<StakedUSNOFTHyperlane> {
    const Factory = await ethers.getContractFactory('StakedUSNOFTHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['Staked USN', 'sUSN', await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    return Factory.attach(
      await proxy.getAddress()
    ) as unknown as StakedUSNOFTHyperlane;
  }

  // Seed balance via Hyperlane handle — the only mint path on sUSN
  async function seedBalance(
    token: StakedUSNOFTHyperlane,
    recipient: string,
    amount: bigint
  ) {
    const mailboxAddr = await mockMailbox.getAddress();
    await network.provider.send('hardhat_setBalance', [
      mailboxAddr,
      '0x1000000000000000000',
    ]);
    const impersonated = await ethers.getImpersonatedSigner(mailboxAddr);
    const seedDomain = 7;
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    // Register if needed (idempotent — re-registering same value is fine)
    await token.registerHyperlaneRemoteToken(seedDomain, remoteToken);
    const message = ethers.concat([
      ethers.zeroPadValue(recipient, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    await token.connect(impersonated).handle(seedDomain, remoteToken, message);
  }

  beforeEach(async function () {
    [owner, user, other, outsider] = await ethers.getSigners();

    const EndpointFactory = await ethers.getContractFactory('EndpointV2Mock');
    endpointSrc = await EndpointFactory.deploy(CHAIN_ID_SRC);
    endpointDst = await EndpointFactory.deploy(CHAIN_ID_DST);

    const MailboxFactory = await ethers.getContractFactory('MockMailbox');
    mockMailbox = (await MailboxFactory.deploy()) as MockMailbox;

    tokenSrc = await deployToken(endpointSrc);
    tokenDst = await deployToken(endpointDst);

    await endpointSrc.setDestLzEndpoint(
      await tokenDst.getAddress(),
      await endpointDst.getAddress()
    );
    await endpointDst.setDestLzEndpoint(
      await tokenSrc.getAddress(),
      await endpointSrc.getAddress()
    );
    await tokenSrc.setPeer(
      CHAIN_ID_DST,
      ethers.zeroPadValue(await tokenDst.getAddress(), 32)
    );
    await tokenDst.setPeer(
      CHAIN_ID_SRC,
      ethers.zeroPadValue(await tokenSrc.getAddress(), 32)
    );

    await tokenSrc.configureHyperlane(await mockMailbox.getAddress());
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    await tokenSrc.registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);

    await seedBalance(
      tokenSrc,
      await user.getAddress(),
      ethers.parseUnits('100', 18)
    );
  });

  // ── Admin surface ────────────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-owner', async function () {
      await expect(
        tokenSrc.connect(outsider).setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      ).to.be.revertedWithCustomError(tokenSrc, 'OwnableUnauthorizedAccount');
    });

    it('emits RateLimitSet', async function () {
      await expect(
        tokenSrc.setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      )
        .to.emit(tokenSrc, 'RateLimitSet')
        .withArgs(TRANSPORT_HYPERLANE, HL_DOMAIN, true, LIMIT, WINDOW);
    });
  });

  // ── Hyperlane outbound ───────────────────────────────────────────────────

  describe('Hyperlane outbound rate limit', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
    });

    it('passes when amount is under limit', async function () {
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await seedBalance(tokenSrc, await user.getAddress(), ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });
  });

  // ── Hyperlane inbound ────────────────────────────────────────────────────

  describe('Hyperlane inbound rate limit', function () {
    beforeEach(async function () {
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
    });

    it('passes when amount is under limit', async function () {
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        tokenSrc
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      const mailboxImpersonated = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(LIMIT + ONE), 32),
      ]);
      await expect(
        tokenSrc
          .connect(mailboxImpersonated)
          .handle(HL_DOMAIN, remoteToken, message)
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ outbound ──────────────────────────────────────────────────────────

  describe('LZ outbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const sendParam = {
        dstEid: CHAIN_ID_DST,
        to: ethers.zeroPadValue(await user.getAddress(), 32),
        amountLD: TEN,
        minAmountLD: TEN,
        extraOptions: LZ_OPTIONS,
        composeMsg: '0x',
        oftCmd: '0x',
      };
      const feeResult = await tokenSrc.quoteSend(sendParam, false);
      const fee = {
        nativeFee: feeResult.nativeFee,
        lzTokenFee: feeResult.lzTokenFee,
      };
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(
        tokenSrc.connect(user).send(sendParam, fee, await user.getAddress(), {
          value: fee.nativeFee,
        })
      ).to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.be.lt(
        balBefore
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      await seedBalance(tokenSrc, await user.getAddress(), ONE);
      const overLimit = TEN + ONE;
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      const sendParam = {
        dstEid: CHAIN_ID_DST,
        to: ethers.zeroPadValue(await user.getAddress(), 32),
        amountLD: overLimit,
        minAmountLD: overLimit,
        extraOptions: LZ_OPTIONS,
        composeMsg: '0x',
        oftCmd: '0x',
      };
      const feeResult = await tokenSrc.quoteSend(sendParam, false);
      const fee = {
        nativeFee: feeResult.nativeFee,
        lzTokenFee: feeResult.lzTokenFee,
      };
      await expect(
        tokenSrc.connect(user).send(sendParam, fee, await user.getAddress(), {
          value: fee.nativeFee,
        })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ inbound ───────────────────────────────────────────────────────────

  describe('LZ inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await tokenDst.balanceOf(await user.getAddress());
      await expect(
        lzReceiveAs(
          await endpointDst.getAddress(),
          tokenDst,
          CHAIN_ID_SRC,
          await tokenSrc.getAddress(),
          await user.getAddress(),
          TEN
        )
      ).to.not.be.reverted;
      expect(await tokenDst.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await tokenDst.setRateLimits([
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_SRC,
          outbound: false,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const balBefore = await tokenDst.balanceOf(await user.getAddress());
      await expect(
        lzReceiveAs(
          await endpointDst.getAddress(),
          tokenDst,
          CHAIN_ID_SRC,
          await tokenSrc.getAddress(),
          await user.getAddress(),
          TEN + ONE
        )
      ).to.be.revertedWithCustomError(tokenDst, 'RateLimitExceeded');
      expect(await tokenDst.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── Window decay ─────────────────────────────────────────────────────────

  describe('window decay', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await tokenSrc.setRateLimits([
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
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await time.increase(Number(WINDOW));
      await seedBalance(tokenSrc, await user.getAddress(), LIMIT);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });

    it('available never goes below zero when decay exceeds in-flight', async function () {
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 });
      await time.increase(Number(WINDOW * 10n));
      const { available } = await tokenSrc.getRateLimit(
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
        tokenSrc
          .connect(outsider)
          .resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true)
      ).to.be.revertedWithCustomError(tokenSrc, 'OwnableUnauthorizedAccount');
    });

    it('clears in-flight and restores availability', async function () {
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');

      await tokenSrc.resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true);

      await seedBalance(tokenSrc, await user.getAddress(), LIMIT);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });
  });

  // ── Cross-key isolation ───────────────────────────────────────────────────

  describe('cross-key isolation', function () {
    it('exhausting (HYPERLANE, domain=99, outbound) does not affect (LZ, eid=2, outbound)', async function () {
      await tokenSrc.setRateLimits([
        { transport: TRANSPORT_HYPERLANE, remoteId: HL_DOMAIN, outbound: true, limit: LIMIT, window: WINDOW },
        { transport: TRANSPORT_LZ, remoteId: CHAIN_ID_DST, outbound: true, limit: LIMIT, window: WINDOW },
      ]);

      // Exhaust the Hyperlane outbound bucket
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');

      // The LZ outbound bucket for CHAIN_ID_DST must be unaffected
      await seedBalance(tokenSrc, await user.getAddress(), TEN);
      const sendParam = {
        dstEid: CHAIN_ID_DST,
        to: ethers.zeroPadValue(await user.getAddress(), 32),
        amountLD: TEN,
        minAmountLD: TEN,
        extraOptions: LZ_OPTIONS,
        composeMsg: '0x',
        oftCmd: '0x',
      };
      const feeResult = await tokenSrc.quoteSend(sendParam, false);
      const fee = {
        nativeFee: feeResult.nativeFee,
        lzTokenFee: feeResult.lzTokenFee,
      };
      await expect(
        tokenSrc
          .connect(user)
          .send(sendParam, fee, await user.getAddress(), {
            value: fee.nativeFee,
          })
      ).to.not.be.reverted;
    });
  });

  // ── Limit update mid-window ───────────────────────────────────────────────

  describe('limit update mid-window', function () {
    it('lowering limit below amountInFlight clamps available to 0 without reverting', async function () {
      await tokenSrc.setRateLimits([
        { transport: TRANSPORT_HYPERLANE, remoteId: HL_DOMAIN, outbound: true, limit: LIMIT, window: WINDOW },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      const half = LIMIT / 2n;
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, half, { value: 0 });

      // Drop limit below current amountInFlight (~half)
      const newLimit = half / 2n;
      await tokenSrc.setRateLimits([
        { transport: TRANSPORT_HYPERLANE, remoteId: HL_DOMAIN, outbound: true, limit: newLimit, window: WINDOW },
      ]);

      // available must clamp to 0, no underflow
      const { available } = await tokenSrc.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(0n);

      // Any further send on this key must revert
      await seedBalance(tokenSrc, await user.getAddress(), ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });
  });

  // ── window == 0 (per-transaction cap) ────────────────────────────────────

  describe('window == 0 (per-transaction cap)', function () {
    it('decays instantly — limit applies per transaction, no accumulation', async function () {
      // window == 0: amountInFlight decays to zero on every check, so the limit
      // acts as a per-tx ceiling rather than a sliding-window accumulator.
      await tokenSrc.setRateLimits([
        { transport: TRANSPORT_HYPERLANE, remoteId: HL_DOMAIN, outbound: true, limit: TEN, window: 0 },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);

      // First tx at exactly the limit — passes
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      // Immediately after: in-flight has decayed to zero, full limit is restored
      await seedBalance(tokenSrc, await user.getAddress(), TEN);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      // A single tx over the per-tx cap still reverts
      await seedBalance(tokenSrc, await user.getAddress(), TEN + ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });
  });
});
