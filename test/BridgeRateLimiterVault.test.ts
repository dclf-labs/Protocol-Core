import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network, upgrades } from 'hardhat';
import type {
  StakingVaultOFTUpgradeableHyperlane,
  EndpointV2Mock,
  MockMailbox,
  MockERC20,
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

describe('BridgeRateLimiterUpgradeable — StakingVaultOFTUpgradeableHyperlane', function () {
  let vaultSrc: StakingVaultOFTUpgradeableHyperlane;
  let vaultDst: StakingVaultOFTUpgradeableHyperlane;
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

  // ── Admin surface ────────────────────────────────────────────────────────

  describe('setRateLimits', function () {
    it('reverts for non-admin', async function () {
      await expect(
        vaultSrc.connect(outsider).setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      ).to.be.revertedWithCustomError(
        vaultSrc,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('emits RateLimitSet', async function () {
      await expect(
        vaultSrc.setRateLimits([
          {
            transport: TRANSPORT_HYPERLANE,
            remoteId: HL_DOMAIN,
            outbound: true,
            limit: LIMIT,
            window: WINDOW,
          },
        ])
      )
        .to.emit(vaultSrc, 'RateLimitSet')
        .withArgs(TRANSPORT_HYPERLANE, HL_DOMAIN, true, LIMIT, WINDOW);
    });
  });

  // ── Hyperlane outbound ───────────────────────────────────────────────────

  describe('Hyperlane outbound rate limit', function () {
    let recipient: string;

    beforeEach(async function () {
      recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await vaultSrc.setRateLimits([
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
      const balBefore = await vaultSrc.balanceOf(await user.getAddress());
      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT + ONE, {
            value: 0,
          })
      ).to.be.revertedWithCustomError(vaultSrc, 'RateLimitExceeded');
      expect(await vaultSrc.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── Hyperlane inbound ────────────────────────────────────────────────────

  describe('Hyperlane inbound rate limit', function () {
    beforeEach(async function () {
      await vaultSrc.setRateLimits([
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
      ).to.be.revertedWithCustomError(vaultSrc, 'RateLimitExceeded');
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
      await vaultSrc.setRateLimits([
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
      ).to.be.revertedWithCustomError(vaultSrc, 'RateLimitExceeded');
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
      await vaultDst.setRateLimits([
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
      ).to.be.revertedWithCustomError(vaultDst, 'RateLimitExceeded');
      expect(await vaultDst.balanceOf(await user.getAddress())).to.equal(
        balBefore
      );
    });
  });

  // ── resetInFlight ────────────────────────────────────────────────────────

  describe('resetInFlight', function () {
    it('reverts for non-admin', async function () {
      await expect(
        vaultSrc
          .connect(outsider)
          .resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true)
      ).to.be.revertedWithCustomError(
        vaultSrc,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('clears in-flight and restores availability', async function () {
      await vaultSrc.setRateLimits([
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
      ).to.be.revertedWithCustomError(vaultSrc, 'RateLimitExceeded');

      await vaultSrc.resetInFlight(TRANSPORT_HYPERLANE, HL_DOMAIN, true);

      await expect(
        vaultSrc
          .connect(user)
          .sendTokensViaHyperlane(HL_DOMAIN, recipient, LIMIT, { value: 0 })
      ).to.not.be.reverted;
    });
  });
});
