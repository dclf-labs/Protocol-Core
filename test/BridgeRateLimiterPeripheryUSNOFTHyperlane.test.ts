import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  USNOFTHyperlane,
  EndpointV2Mock,
  MockMailbox,
  BridgeRateLimiter,
} from '../typechain-types';
import {
  TRANSPORT_LZ,
  TRANSPORT_HYPERLANE,
  CHAIN_ID_SRC,
  CHAIN_ID_DST,
  HL_DOMAIN,
  LZ_OPTIONS,
  lzReceiveAs,
  deployAndWireRateLimiter,
} from './helpers/bridgeRateLimiter';

// periphery/USNOFTHyperlane is the dual-transport (LZ OFT + Hyperlane) remote
// USN token (deployed as USN on zkSync Era). It has no local mint() — supply
// only enters via lzReceive/handle — so balances are seeded through the
// Hyperlane inbound path. Covers all four hook points. Hashlock L-01.
describe('BridgeRateLimiter — periphery/USNOFTHyperlane', function () {
  let tokenSrc: USNOFTHyperlane;
  let tokenDst: USNOFTHyperlane;
  let limiterSrc: BridgeRateLimiter;
  let limiterDst: BridgeRateLimiter;
  let endpointSrc: EndpointV2Mock;
  let endpointDst: EndpointV2Mock;
  let mockMailbox: MockMailbox;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const HUNDRED = ethers.parseUnits('100', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;
  // Seeding domain: registered on tokenSrc only, distinct from HL_DOMAIN so
  // seeding never consumes the bucket under test.
  const SEED_DOMAIN = 7;

  async function deployToken(
    endpoint: EndpointV2Mock
  ): Promise<USNOFTHyperlane> {
    const Factory = await ethers.getContractFactory('USNOFTHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['USN', 'USN', await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    return Factory.attach(
      await proxy.getAddress()
    ) as unknown as USNOFTHyperlane;
  }

  // Impersonate the mailbox and deliver a Hyperlane transfer to `token`
  async function handleAs(
    token: USNOFTHyperlane,
    origin: number,
    recipientAddr: string,
    amount: bigint
  ) {
    const mailboxAddr = await mockMailbox.getAddress();
    await network.provider.send('hardhat_setBalance', [
      mailboxAddr,
      '0x1000000000000000000',
    ]);
    const impersonated = await ethers.getImpersonatedSigner(mailboxAddr);
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    const message = ethers.concat([
      ethers.zeroPadValue(recipientAddr, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    return token.connect(impersonated).handle(origin, remoteToken, message);
  }

  async function seedBalance(recipient: string, amount: bigint) {
    await handleAs(tokenSrc, SEED_DOMAIN, recipient, amount);
  }

  function sendParamFor(to: string, amountLD: bigint) {
    return {
      dstEid: CHAIN_ID_DST,
      to: ethers.zeroPadValue(to, 32),
      amountLD,
      minAmountLD: amountLD,
      extraOptions: LZ_OPTIONS,
      composeMsg: '0x',
      oftCmd: '0x',
    };
  }

  async function lzSend(amountLD: bigint) {
    const sendParam = sendParamFor(await user.getAddress(), amountLD);
    const feeResult = await tokenSrc.quoteSend(sendParam, false);
    const fee = {
      nativeFee: feeResult.nativeFee,
      lzTokenFee: feeResult.lzTokenFee,
    };
    return tokenSrc
      .connect(user)
      .send(sendParam, fee, await user.getAddress(), {
        value: fee.nativeFee,
      });
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

    limiterSrc = await deployAndWireRateLimiter(owner, tokenSrc);
    limiterDst = await deployAndWireRateLimiter(owner, tokenDst);

    // Wire LZ routing
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

    // Configure Hyperlane (mock mailbox so quoteDispatch/dispatch work)
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    await tokenSrc.configureHyperlane(await mockMailbox.getAddress());
    await tokenSrc.registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);
    await tokenSrc.registerHyperlaneRemoteToken(SEED_DOMAIN, remoteToken);

    await seedBalance(await user.getAddress(), HUNDRED);
  });

  // ── Token-side wiring ────────────────────────────────────────────────────

  describe('setRateLimiter', function () {
    it('reverts for non-owner', async function () {
      await expect(
        tokenSrc.connect(outsider).setRateLimiter(await limiterSrc.getAddress())
      ).to.be.revertedWithCustomError(tokenSrc, 'OwnableUnauthorizedAccount');
    });

    it('rejects a non-zero address with no code', async function () {
      await expect(
        tokenSrc.setRateLimiter(await outsider.getAddress())
      ).to.be.revertedWithCustomError(tokenSrc, 'InvalidRateLimiter');
    });

    it('emits RateLimiterSet and exposes the wired address', async function () {
      const Factory = await ethers.getContractFactory('BridgeRateLimiter');
      const fresh = await Factory.deploy(await owner.getAddress());
      await expect(tokenSrc.setRateLimiter(await fresh.getAddress()))
        .to.emit(tokenSrc, 'RateLimiterSet')
        .withArgs(await fresh.getAddress());
      expect(await tokenSrc.rateLimiter()).to.equal(await fresh.getAddress());
    });

    it('address(0) unwires: bridge paths bypass the limiter entirely', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      await expect(lzSend(TEN + ONE)).to.be.revertedWithCustomError(
        limiterSrc,
        'RateLimitExceeded'
      );

      await tokenSrc.setRateLimiter(ethers.ZeroAddress);
      expect(await tokenSrc.rateLimiter()).to.equal(ethers.ZeroAddress);
      await expect(lzSend(TEN + ONE)).to.not.be.reverted;
      const { available } = await limiterSrc.getRateLimit(
        await tokenSrc.getAddress(),
        TRANSPORT_LZ,
        CHAIN_ID_DST,
        true
      );
      expect(available).to.equal(TEN);
    });
  });

  // ── Storage layout ───────────────────────────────────────────────────────

  describe('storage layout', function () {
    it('rateLimiter packs into slot 4 beside hyperlaneEnabled — no new slot for the live proxy', async function () {
      // OFTUpgradeable/OAppCoreUpgradeable/AccessControlUpgradeable are all
      // ERC-7201 namespaced, so this contract's own variables start at slot 0:
      // blacklist(0) mailbox(1) _ism(2) remoteTokens(3)
      // hyperlaneEnabled(4, byte 0) rateLimiter(4, bytes 1-20).
      const limiterAddr = await limiterSrc.getAddress();
      const expected = ethers.toBeHex((BigInt(limiterAddr) << 8n) | 1n, 32);
      expect(
        await ethers.provider.getStorage(await tokenSrc.getAddress(), 4)
      ).to.equal(expected);
      expect(
        await ethers.provider.getStorage(await tokenSrc.getAddress(), 5)
      ).to.equal(ethers.ZeroHash);
    });
  });

  // ── Limiter admin surface ────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-owner', async function () {
      await expect(
        limiterSrc
          .connect(outsider)
          .setRateLimits(await tokenSrc.getAddress(), [
            {
              transport: TRANSPORT_HYPERLANE,
              remoteId: HL_DOMAIN,
              outbound: true,
              limit: LIMIT,
              window: WINDOW,
            },
          ])
      ).to.be.revertedWithCustomError(limiterSrc, 'OwnableUnauthorizedAccount');
    });

    it('emits RateLimitSet per entry', async function () {
      await expect(
        limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
          {
            transport: TRANSPORT_LZ,
            remoteId: CHAIN_ID_DST,
            outbound: false,
            limit: TEN,
            window: WINDOW,
          },
        ])
      )
        .to.emit(limiterSrc, 'RateLimitSet')
        .withArgs(
          await tokenSrc.getAddress(),
          TRANSPORT_HYPERLANE,
          HL_DOMAIN,
          true,
          LIMIT,
          WINDOW
        )
        .and.to.emit(limiterSrc, 'RateLimitSet')
        .withArgs(
          await tokenSrc.getAddress(),
          TRANSPORT_LZ,
          CHAIN_ID_DST,
          false,
          TEN,
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
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
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
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('passes when amount is under limit', async function () {
      await setLimit();
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
    });

    it('passes when amount equals limit exactly', async function () {
      await setLimit();
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when over limit, and burns nothing', async function () {
      await setLimit();
      await seedBalance(await user.getAddress(), ONE);
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });

    it('reverts when cumulative sends exceed limit', async function () {
      await setLimit();
      for (let i = 0; i < 5; i++) {
        await tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });
      }
      // 5 × 10 = 50 = LIMIT exhausted
      await seedBalance(await user.getAddress(), ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
    });
  });

  // ── Hyperlane inbound (handle → rate limit → _mint) ──────────────────────

  describe('Hyperlane inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(handleAs(tokenSrc, HL_DOMAIN, await user.getAddress(), TEN))
        .to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(handleAs(tokenSrc, HL_DOMAIN, await user.getAddress(), TEN))
        .to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit, and mints nothing', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(
        handleAs(tokenSrc, HL_DOMAIN, await user.getAddress(), LIMIT + ONE)
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ outbound (_debit via send()) ──────────────────────────────────────

  describe('LZ outbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(lzSend(TEN)).to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore - TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      await expect(lzSend(TEN)).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when over limit, and burns nothing', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(lzSend(TEN + ONE)).to.be.revertedWithCustomError(
        limiterSrc,
        'RateLimitExceeded'
      );
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });

    it('reverts when cumulative sends exceed limit', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      for (let i = 0; i < 5; i++) {
        await lzSend(TEN);
      }
      await expect(lzSend(ONE)).to.be.revertedWithCustomError(
        limiterSrc,
        'RateLimitExceeded'
      );
    });
  });

  // ── LZ inbound (_credit via lzReceive) ───────────────────────────────────

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

    it('passes when amount is under limit', async function () {
      await limiterDst.setRateLimits(await tokenDst.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_SRC,
          outbound: false,
          limit: LIMIT,
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
          TEN
        )
      ).to.not.be.reverted;
      expect(await tokenDst.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit, and mints nothing', async function () {
      await limiterDst.setRateLimits(await tokenDst.getAddress(), [
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
      ).to.be.revertedWithCustomError(limiterDst, 'RateLimitExceeded');
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
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
    });

    it('in-flight decays proportionally with elapsed time', async function () {
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      // Advance half a window → ~50% decays
      await time.increase(Number(WINDOW / 2n));

      const halfLimit = LIMIT / 2n;
      await seedBalance(await user.getAddress(), halfLimit);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, halfLimit, { value: 0 })
      ).to.not.be.reverted;
    });

    it('fully decays after window elapses', async function () {
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      await time.increase(Number(WINDOW));

      await seedBalance(await user.getAddress(), LIMIT);
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

      const { available } = await limiterSrc.getRateLimit(
        await tokenSrc.getAddress(),
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
        limiterSrc
          .connect(outsider)
          .resetInFlight(
            await tokenSrc.getAddress(),
            TRANSPORT_LZ,
            CHAIN_ID_DST,
            true
          )
      ).to.be.revertedWithCustomError(limiterSrc, 'OwnableUnauthorizedAccount');
    });

    it('clears in-flight and restores full availability', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      await lzSend(LIMIT);
      await expect(lzSend(ONE)).to.be.revertedWithCustomError(
        limiterSrc,
        'RateLimitExceeded'
      );

      await limiterSrc.resetInFlight(
        await tokenSrc.getAddress(),
        TRANSPORT_LZ,
        CHAIN_ID_DST,
        true
      );

      await seedBalance(await user.getAddress(), LIMIT);
      await expect(lzSend(LIMIT)).to.not.be.reverted;
    });
  });

  // ── Cross-key isolation ───────────────────────────────────────────────────

  describe('cross-key isolation', function () {
    it('exhausting (HYPERLANE, domain=99, outbound) does not affect (LZ, eid=2, outbound)', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
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
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');

      // The LZ outbound bucket for CHAIN_ID_DST must be unaffected
      await seedBalance(await user.getAddress(), TEN);
      await expect(lzSend(TEN)).to.not.be.reverted;
    });

    it('exhausting outbound does not affect inbound for the same domain', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
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
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');

      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(
        handleAs(tokenSrc, HL_DOMAIN, await user.getAddress(), LIMIT)
      ).to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + LIMIT
      );
    });
  });

  // ── window == 0 (per-transaction cap) ────────────────────────────────────

  describe('window == 0 (per-transaction cap)', function () {
    it('decays instantly — limit applies per transaction, no accumulation', async function () {
      await limiterSrc.setRateLimits(await tokenSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: 0,
        },
      ]);

      await expect(lzSend(TEN)).to.not.be.reverted;

      await seedBalance(await user.getAddress(), TEN);
      await expect(lzSend(TEN)).to.not.be.reverted;

      await seedBalance(await user.getAddress(), TEN + ONE);
      await expect(lzSend(TEN + ONE)).to.be.revertedWithCustomError(
        limiterSrc,
        'RateLimitExceeded'
      );
    });
  });
});
