import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  USNUpgradeableHyperlane,
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

describe('BridgeRateLimiterUpgradeable — USNUpgradeableHyperlane', function () {
  let tokenSrc: USNUpgradeableHyperlane;
  let tokenDst: USNUpgradeableHyperlane;
  let endpointSrc: EndpointV2Mock;
  let endpointDst: EndpointV2Mock;
  let mockMailbox: MockMailbox;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const HUNDRED = ethers.parseUnits('100', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;

  async function deployToken(
    endpoint: EndpointV2Mock
  ): Promise<USNUpgradeableHyperlane> {
    const Factory = await ethers.getContractFactory('USNUpgradeableHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['USN', 'USN', await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    const token = Factory.attach(
      await proxy.getAddress()
    ) as unknown as USNUpgradeableHyperlane;
    await token.enablePermissionless();
    await token.setAdmin(await admin.getAddress());
    return token;
  }

  beforeEach(async function () {
    [owner, admin, user, other, outsider] = await ethers.getSigners();

    const EndpointFactory = await ethers.getContractFactory('EndpointV2Mock');
    endpointSrc = await EndpointFactory.deploy(CHAIN_ID_SRC);
    endpointDst = await EndpointFactory.deploy(CHAIN_ID_DST);

    const MailboxFactory = await ethers.getContractFactory('MockMailbox');
    mockMailbox = (await MailboxFactory.deploy()) as MockMailbox;

    tokenSrc = await deployToken(endpointSrc);
    tokenDst = await deployToken(endpointDst);

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
    await tokenSrc.configureHyperlane(await mockMailbox.getAddress());
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    await tokenSrc.registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);

    await tokenSrc.connect(admin).mint(await user.getAddress(), HUNDRED);
  });

  // helper: impersonate an address to call handle() as the registered mailbox
  async function handleAs(
    mailboxAddr: string,
    token: USNUpgradeableHyperlane,
    origin: number,
    remoteTokenAddr: string,
    recipientAddr: string,
    amount: bigint
  ) {
    await network.provider.send('hardhat_setBalance', [
      mailboxAddr,
      '0x1000000000000000000',
    ]);
    const impersonated = await ethers.getImpersonatedSigner(mailboxAddr);
    const remoteToken = ethers.zeroPadValue(remoteTokenAddr, 32);
    const message = ethers.concat([
      ethers.zeroPadValue(recipientAddr, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    return token.connect(impersonated).handle(origin, remoteToken, message);
  }

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

    it('emits RateLimitSet per entry', async function () {
      await expect(
        tokenSrc.setRateLimits([
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
        .to.emit(tokenSrc, 'RateLimitSet')
        .withArgs(TRANSPORT_HYPERLANE, HL_DOMAIN, true, LIMIT, WINDOW)
        .and.to.emit(tokenSrc, 'RateLimitSet')
        .withArgs(TRANSPORT_LZ, CHAIN_ID_DST, false, TEN, WINDOW);
    });
  });

  describe('resetInFlight', function () {
    it('reverts for non-owner', async function () {
      await expect(
        tokenSrc
          .connect(outsider)
          .resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true)
      ).to.be.revertedWithCustomError(tokenSrc, 'OwnableUnauthorizedAccount');
    });

    it('clears in-flight and restores full availability', async function () {
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

      await tokenSrc.connect(admin).mint(await user.getAddress(), LIMIT);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });
  });

  // ── View ─────────────────────────────────────────────────────────────────

  describe('getRateLimit', function () {
    it('returns max uint256 available when limit is 0 (unlimited)', async function () {
      const { limit, available } = await tokenSrc.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(limit).to.equal(0n);
      expect(available).to.equal(ethers.MaxUint256);
    });

    it('returns full limit as available when nothing consumed', async function () {
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const { limit, available } = await tokenSrc.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(limit).to.equal(LIMIT);
      expect(available).to.equal(LIMIT);
    });

    it('reflects partial consumption', async function () {
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
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });

      const { available } = await tokenSrc.getRateLimit(
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.be.closeTo(
        LIMIT - TEN,
        ethers.parseUnits('0.01', 18)
      );
    });
  });

  // ── Hyperlane outbound (sendTokensViaHyperlane → rate limit → _burn) ─────

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

    it('passes when amount equals limit exactly', async function () {
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });

    it('reverts with RateLimitExceeded when amount exceeds limit', async function () {
      await tokenSrc.connect(admin).mint(await user.getAddress(), ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });

    it('reverts when cumulative sends exceed limit', async function () {
      for (let i = 0; i < 5; i++) {
        await tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });
      }
      // 5 × 10 = 50 = LIMIT exhausted
      await tokenSrc.connect(admin).mint(await user.getAddress(), ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });
  });

  // ── Hyperlane inbound (handle → rate limit → _mint) ──────────────────────

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
      await expect(
        handleAs(
          await mockMailbox.getAddress(),
          tokenSrc,
          HL_DOMAIN,
          await other.getAddress(),
          await user.getAddress(),
          TEN
        )
      ).to.not.be.reverted;
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when amount exceeds limit', async function () {
      const balBefore = await tokenSrc.balanceOf(await user.getAddress());
      await expect(
        handleAs(
          await mockMailbox.getAddress(),
          tokenSrc,
          HL_DOMAIN,
          await other.getAddress(),
          await user.getAddress(),
          LIMIT + ONE
        )
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ outbound (_debit via send()) ──────────────────────────────────────

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

    it('reverts with RateLimitExceeded when amount exceeds limit', async function () {
      await tokenSrc.setRateLimits([
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const overLimit = TEN + ONE;
      await tokenSrc.connect(admin).mint(await user.getAddress(), ONE);
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
      // Funds must NOT have been burned
      expect(await tokenSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
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

    it('reverts with RateLimitExceeded when amount exceeds limit', async function () {
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

    it('in-flight decays proportionally with elapsed time', async function () {
      await tokenSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      // Advance half a window → ~50% decays
      await time.increase(Number(WINDOW / 2n));

      const halfLimit = LIMIT / 2n;
      await tokenSrc.connect(admin).mint(await user.getAddress(), halfLimit);
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

      await tokenSrc.connect(admin).mint(await user.getAddress(), LIMIT);
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
      await tokenSrc.connect(admin).mint(await user.getAddress(), TEN);
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
      await tokenSrc.connect(admin).mint(await user.getAddress(), ONE);
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
      await tokenSrc.connect(admin).mint(await user.getAddress(), TEN);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;

      // A single tx over the per-tx cap still reverts
      await tokenSrc.connect(admin).mint(await user.getAddress(), TEN + ONE);
      await expect(
        tokenSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN + ONE, { value: 0 })
      ).to.be.revertedWithCustomError(tokenSrc, 'RateLimitExceeded');
    });
  });
});
