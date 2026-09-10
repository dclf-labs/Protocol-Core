import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  StakingVaultOFTUpgradeableHyperlane,
  EndpointV2Mock,
  MockMailbox,
  MockERC20,
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

describe('BridgeRateLimiter — StakingVaultOFTUpgradeableHyperlane', function () {
  let vaultSrc: StakingVaultOFTUpgradeableHyperlane;
  let vaultDst: StakingVaultOFTUpgradeableHyperlane;
  let limiterSrc: BridgeRateLimiter;
  let limiterDst: BridgeRateLimiter;
  let endpointSrc: EndpointV2Mock;
  let endpointDst: EndpointV2Mock;
  let mockMailbox: MockMailbox;
  let asset: MockERC20;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = ethers.parseUnits('1', 18);
  const TEN = ethers.parseUnits('10', 18);
  const LIMIT = ethers.parseUnits('50', 18);
  const WINDOW = 86400n;

  async function deployVault(
    endpoint: EndpointV2Mock
  ): Promise<StakingVaultOFTUpgradeableHyperlane> {
    const Factory = await ethers.getContractFactory(
      'StakingVaultOFTUpgradeableHyperlane'
    );
    const proxy = await upgrades.deployProxy(
      Factory,
      [
        await asset.getAddress(),
        'Staked Vault',
        'sVLT',
        await owner.getAddress(),
      ],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    return Factory.attach(
      await proxy.getAddress()
    ) as unknown as StakingVaultOFTUpgradeableHyperlane;
  }

  // Transfer shares from user to vault — simulates tokens locked by a prior bridge-out
  async function seedLockedBalance(
    vault: StakingVaultOFTUpgradeableHyperlane,
    amount: bigint
  ) {
    await vault.connect(user).transfer(await vault.getAddress(), amount);
  }

  beforeEach(async function () {
    [owner, user, other, outsider] = await ethers.getSigners();

    const ERC20Factory = await ethers.getContractFactory('MockERC20');
    asset = (await ERC20Factory.deploy(
      'Mock Asset',
      'mASSET'
    )) as unknown as MockERC20;

    const EndpointFactory = await ethers.getContractFactory('EndpointV2Mock');
    endpointSrc = (await EndpointFactory.deploy(
      CHAIN_ID_SRC
    )) as unknown as EndpointV2Mock;
    endpointDst = (await EndpointFactory.deploy(
      CHAIN_ID_DST
    )) as unknown as EndpointV2Mock;

    const MailboxFactory = await ethers.getContractFactory('MockMailbox');
    mockMailbox = (await MailboxFactory.deploy()) as unknown as MockMailbox;

    vaultSrc = await deployVault(endpointSrc);
    vaultDst = await deployVault(endpointDst);

    limiterSrc = await deployAndWireRateLimiter(owner, vaultSrc);
    limiterDst = await deployAndWireRateLimiter(owner, vaultDst);

    await endpointSrc.setDestLzEndpoint(
      await vaultDst.getAddress(),
      await endpointDst.getAddress()
    );
    await endpointDst.setDestLzEndpoint(
      await vaultSrc.getAddress(),
      await endpointSrc.getAddress()
    );
    await vaultSrc.setPeer(
      CHAIN_ID_DST,
      ethers.zeroPadValue(await vaultDst.getAddress(), 32)
    );
    await vaultDst.setPeer(
      CHAIN_ID_SRC,
      ethers.zeroPadValue(await vaultSrc.getAddress(), 32)
    );

    await vaultSrc.configureHyperlane(await mockMailbox.getAddress());
    const remoteToken = ethers.zeroPadValue(await other.getAddress(), 32);
    await vaultSrc.registerHyperlaneRemoteToken(HL_DOMAIN, remoteToken);

    // Mint asset, deposit into both vaults so each holds its own liquidity
    await asset.mint(await user.getAddress(), ethers.parseUnits('200', 18));
    await asset
      .connect(user)
      .approve(await vaultSrc.getAddress(), ethers.parseUnits('100', 18));
    await asset
      .connect(user)
      .approve(await vaultDst.getAddress(), ethers.parseUnits('100', 18));
    await vaultSrc
      .connect(user)
      .deposit(ethers.parseUnits('100', 18), await user.getAddress());
    await vaultDst
      .connect(user)
      .deposit(ethers.parseUnits('100', 18), await user.getAddress());
  });

  // ── Vault ↔ limiter wiring ───────────────────────────────────────────────

  describe('setRateLimiter', function () {
    it('reverts for non-admin', async function () {
      await expect(
        vaultSrc.connect(outsider).setRateLimiter(await limiterSrc.getAddress())
      ).to.be.revertedWithCustomError(
        vaultSrc,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('emits RateLimiterSet', async function () {
      const Factory = await ethers.getContractFactory('BridgeRateLimiter');
      const newLimiter = await Factory.connect(owner).deploy(
        await owner.getAddress()
      );
      await expect(vaultSrc.setRateLimiter(await newLimiter.getAddress()))
        .to.emit(vaultSrc, 'RateLimiterSet')
        .withArgs(await newLimiter.getAddress());
    });

    it('reverts when the target has no code', async function () {
      await expect(
        vaultSrc.setRateLimiter(await outsider.getAddress())
      ).to.be.revertedWithCustomError(vaultSrc, 'InvalidRateLimiter');
    });

    it('allows unwiring back to address(0)', async function () {
      await expect(vaultSrc.setRateLimiter(ethers.ZeroAddress)).to.not.be
        .reverted;
      expect(await vaultSrc.rateLimiter()).to.equal(ethers.ZeroAddress);
    });
  });

  // ── Limiter admin surface ────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-owner', async function () {
      await expect(
        limiterSrc
          .connect(outsider)
          .setRateLimits(await vaultSrc.getAddress(), [
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

    it('emits RateLimitSet', async function () {
      await expect(
        limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      )
        .to.emit(limiterSrc, 'RateLimitSet')
        .withArgs(
          await vaultSrc.getAddress(),
          TRANSPORT_HYPERLANE,
          HL_DOMAIN,
          true,
          LIMIT,
          WINDOW
        );
    });
  });

  describe('checkAndUpdate outbound blocking (deny-list, not allow-list)', function () {
    it('outbound is allowed by default for any caller — no registration needed', async function () {
      await expect(
        limiterSrc
          .connect(outsider)
          .checkAndUpdate(TRANSPORT_HYPERLANE, HL_DOMAIN, true, ONE)
      ).to.not.be.reverted;
    });

    it('inbound is never blocked, even for an explicitly blocked caller', async function () {
      await limiterSrc.blockOutbound(await outsider.getAddress());
      await expect(
        limiterSrc
          .connect(outsider)
          .checkAndUpdate(TRANSPORT_HYPERLANE, HL_DOMAIN, false, ONE)
      ).to.not.be.reverted;
    });

    it('blockOutbound blocks outbound but not inbound for a caller', async function () {
      await limiterSrc.blockOutbound(await vaultSrc.getAddress());

      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      // Outbound now reverts at the limiter, surfacing as a bare call failure
      // through the vault (the vault has no special handling for this error).
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.reverted;

      // Inbound still delivers — blocking must not strand in-flight funds.
      await seedLockedBalance(vaultSrc, TEN);
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await network.provider.send('hardhat_setBalance', [
        await mockMailbox.getAddress(),
        '0x1000000000000000000',
      ]);
      const mailboxSigner = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = await vaultSrc.remoteTokens(HL_DOMAIN);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        vaultSrc.connect(mailboxSigner).handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('unblockOutbound restores outbound', async function () {
      await limiterSrc.blockOutbound(await vaultSrc.getAddress());
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.reverted;

      await limiterSrc.unblockOutbound(await vaultSrc.getAddress());
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.not.be.reverted;
    });
  });

  describe('ownership (Ownable2Step)', function () {
    it('requires acceptOwnership — transferOwnership alone does not hand over control', async function () {
      await limiterSrc.transferOwnership(await outsider.getAddress());
      expect(await limiterSrc.owner()).to.equal(await owner.getAddress());
      expect(await limiterSrc.pendingOwner()).to.equal(
        await outsider.getAddress()
      );

      await limiterSrc.connect(outsider).acceptOwnership();
      expect(await limiterSrc.owner()).to.equal(await outsider.getAddress());
    });
  });

  describe('mid-window reconfiguration settles before applying new limit/window (M-1)', function () {
    it('raising the limit mid-window does not retroactively wipe accrued in-flight', async function () {
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      // Exhaust the bucket
      await vaultSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });
      const { available: availableBefore } = await limiterSrc.getRateLimit(
        await vaultSrc.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(availableBefore).to.equal(0n);

      // Raise the limit — settling means the already-accrued TEN is preserved
      // under the new limit, not reinterpreted as if it had been decaying at
      // the new (much faster) rate the whole time.
      const NEW_LIMIT = ethers.parseUnits('1000', 18);
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: NEW_LIMIT,
          window: WINDOW,
        },
      ]);
      const { available: availableAfter } = await limiterSrc.getRateLimit(
        await vaultSrc.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      // Within a few seconds of real decay under the OLD (10/86400s) rate —
      // nowhere near what a naive read against the NEW, much larger limit
      // would produce.
      expect(availableAfter).to.be.closeTo(
        NEW_LIMIT - TEN,
        ethers.parseUnits('0.01', 18)
      );
    });

    it('shrinking the window below the elapsed time does not retroactively zero in-flight', async function () {
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      const BIG_WINDOW = 1_000_000n;
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: BIG_WINDOW,
        },
      ]);
      await vaultSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });

      // Shrink the window to something the (tiny, real) elapsed time since
      // the ORIGINAL lastUpdated would already exceed — a naive
      // implementation reading elapsed-since-old-lastUpdated against the NEW
      // window would treat the bucket as "expired" and refill it to the full
      // TEN, erasing the send that just happened.
      const SMALL_WINDOW = 2n;
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: SMALL_WINDOW,
        },
      ]);
      const { available } = await limiterSrc.getRateLimit(
        await vaultSrc.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      // Settling resets lastUpdated at reconfigure time, so elapsed-since-
      // settle is ~0 here — available should be dust, not a full TEN refill.
      expect(available).to.be.lt(ethers.parseUnits('0.001', 18));
    });

    it('re-enabling a disabled bucket does not carry stale frozen in-flight forward', async function () {
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      // Exhaust the bucket
      await vaultSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 });

      // Disable (limit == 0) — decay is proportional to limit, so while
      // disabled the bucket's amountInFlight is frozen and does not decay,
      // no matter how much real time passes.
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: 0,
          window: WINDOW,
        },
      ]);
      await time.increase(Number(WINDOW * 10n));

      // Re-enable with the same limit. A buggy _settle would carry the
      // frozen TEN forward and read it as still fully in-flight even though
      // 10 windows' worth of real time passed while disabled.
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const { available } = await limiterSrc.getRateLimit(
        await vaultSrc.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );
      expect(available).to.equal(TEN);
    });
  });

  describe('overflow-safe decay with a very large limit (M-2)', function () {
    it('does not revert when limit is near type(uint256).max', async function () {
      const HUGE_LIMIT = ethers.MaxUint256 - 1n;
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: HUGE_LIMIT,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.not.be.reverted;

      // getRateLimit must also not revert when computing decay for this bucket
      await expect(
        limiterSrc.getRateLimit(
          await vaultSrc.getAddress(),
          TRANSPORT_HYPERLANE,
          HL_DOMAIN,
          true
        )
      ).to.not.be.reverted;
    });
  });

  // ── Hyperlane outbound ───────────────────────────────────────────────────

  describe('Hyperlane outbound rate limit', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
    });

    it('passes when limit is 0 (unlimited)', async function () {
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore - TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, TEN, { value: 0 })
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore - TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── Hyperlane inbound ────────────────────────────────────────────────────

  describe('Hyperlane inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      await seedLockedBalance(vaultSrc, TEN);

      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await network.provider.send('hardhat_setBalance', [
        await mockMailbox.getAddress(),
        '0x1000000000000000000',
      ]);
      const mailboxSigner = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = await vaultSrc.remoteTokens(HL_DOMAIN);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        vaultSrc.connect(mailboxSigner).handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('passes when amount is under limit', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      await seedLockedBalance(vaultSrc, TEN);

      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await network.provider.send('hardhat_setBalance', [
        await mockMailbox.getAddress(),
        '0x1000000000000000000',
      ]);
      const mailboxSigner = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = await vaultSrc.remoteTokens(HL_DOMAIN);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(TEN), 32),
      ]);
      await expect(
        vaultSrc.connect(mailboxSigner).handle(HL_DOMAIN, remoteToken, message)
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: false,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await network.provider.send('hardhat_setBalance', [
        await mockMailbox.getAddress(),
        '0x1000000000000000000',
      ]);
      const mailboxSigner = await ethers.getImpersonatedSigner(
        await mockMailbox.getAddress()
      );
      const remoteToken = await vaultSrc.remoteTokens(HL_DOMAIN);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(LIMIT + ONE), 32),
      ]);
      await expect(
        vaultSrc.connect(mailboxSigner).handle(HL_DOMAIN, remoteToken, message)
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ outbound ──────────────────────────────────────────────────────────

  describe('LZ outbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      // Seed locked balance on vaultDst so the synchronous LZ delivery can unlock
      await seedLockedBalance(vaultDst, TEN);

      const sendParam = {
        dstEid: CHAIN_ID_DST,
        to: ethers.zeroPadValue(await user.getAddress(), 32),
        amountLD: TEN,
        minAmountLD: TEN,
        extraOptions: LZ_OPTIONS,
        composeMsg: '0x',
        oftCmd: '0x',
      };
      const feeResult = await vaultSrc.quoteSend(sendParam, false);
      const fee = {
        nativeFee: feeResult.nativeFee,
        lzTokenFee: feeResult.lzTokenFee,
      };
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await expect(
        vaultSrc.connect(user).send(sendParam, fee, await user.getAddress(), {
          value: fee.nativeFee,
        })
      ).to.not.be.reverted;
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.be.lt(
        balBefore
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_DST,
          outbound: true,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const overLimit = TEN + ONE;
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      const sendParam = {
        dstEid: CHAIN_ID_DST,
        to: ethers.zeroPadValue(await user.getAddress(), 32),
        amountLD: overLimit,
        minAmountLD: overLimit,
        extraOptions: LZ_OPTIONS,
        composeMsg: '0x',
        oftCmd: '0x',
      };
      // Rate limit fires in _debit before _lzSend fee check — no value needed
      await expect(
        vaultSrc
          .connect(user)
          .send(
            sendParam,
            { nativeFee: 0n, lzTokenFee: 0n },
            await user.getAddress()
          )
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── LZ inbound ───────────────────────────────────────────────────────────

  describe('LZ inbound rate limit', function () {
    it('passes when limit is 0 (unlimited)', async function () {
      await seedLockedBalance(vaultDst, TEN);

      const balBefore = await vaultDst.balanceOf(await user.getAddress());
      await expect(
        lzReceiveAs(
          await endpointDst.getAddress(),
          vaultDst,
          CHAIN_ID_SRC,
          await vaultSrc.getAddress(),
          await user.getAddress(),
          TEN
        )
      ).to.not.be.reverted;
      expect(await vaultDst.balanceOf(await user.getAddress())).to.equal(
        balBefore + TEN
      );
    });

    it('reverts with RateLimitExceeded when over limit', async function () {
      await limiterDst.setRateLimits(await vaultDst.getAddress(), [
        {
          transport: TRANSPORT_LZ,
          remoteId: CHAIN_ID_SRC,
          outbound: false,
          limit: TEN,
          window: WINDOW,
        },
      ]);
      const balBefore = await vaultDst.balanceOf(await user.getAddress());
      await expect(
        lzReceiveAs(
          await endpointDst.getAddress(),
          vaultDst,
          CHAIN_ID_SRC,
          await vaultSrc.getAddress(),
          await user.getAddress(),
          TEN + ONE
        )
      ).to.be.revertedWithCustomError(limiterDst, 'RateLimitExceeded');
      expect(await vaultDst.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── resetInFlight ────────────────────────────────────────────────────────

  describe('resetInFlight', function () {
    it('reverts for non-owner', async function () {
      await expect(
        limiterSrc
          .connect(outsider)
          .resetInFlight(
            await vaultSrc.getAddress(),
            TRANSPORT_HYPERLANE,
            HL_DOMAIN,
            true
          )
      ).to.be.revertedWithCustomError(limiterSrc, 'OwnableUnauthorizedAccount');
    });

    it('clears in-flight and restores availability', async function () {
      await limiterSrc.setRateLimits(await vaultSrc.getAddress(), [
        {
          transport: TRANSPORT_HYPERLANE,
          remoteId: HL_DOMAIN,
          outbound: true,
          limit: LIMIT,
          window: WINDOW,
        },
      ]);
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await vaultSrc
        .connect(user)
        .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 });

      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, ONE, { value: 0 })
      ).to.be.revertedWithCustomError(limiterSrc, 'RateLimitExceeded');

      await limiterSrc.resetInFlight(
        await vaultSrc.getAddress(),
        TRANSPORT_HYPERLANE,
        HL_DOMAIN,
        true
      );

      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });
  });
});
