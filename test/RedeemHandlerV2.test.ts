import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type {
  USN,
  RedeemHandlerV2,
  MinterHandlerV2,
  MockERC20,
  MockChainlinkPriceFeed,
  MockFlashAttacker,
  EndpointV2Mock,
} from '../typechain-types';

const ONE_USD = 10n ** 8n; // Chainlink 8-decimals peg
const QUEUE_EXPIRY = 48 * 60 * 60;
const DEFAULT_MIN_DIRECT_REDEEM = 10n ** 18n;
const DEFAULT_DAILY_APPROVAL_CAP = 100_000n * 10n ** 18n;

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  return block!.timestamp;
}

async function increaseTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

interface RedeemOrder {
  message: string;
  user: string;
  collateralAddress: string;
  collateralAmount: bigint;
  usnAmount: bigint;
  expiry: number;
  nonce: number;
}

describe('RedeemHandlerV2', function () {
  let usn: USN;
  let handler: RedeemHandlerV2;
  let minter: MinterHandlerV2;
  let collateral: MockERC20;
  let oracle: MockChainlinkPriceFeed;
  let endpointMock: EndpointV2Mock;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let burner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const userInitialUSN = ethers.parseUnits('10000', 18);
  const treasuryInitialCollateral = ethers.parseUnits('1000000', 18);

  let domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: string;
  };
  const types = {
    RedeemOrder: [
      { name: 'message', type: 'string' },
      { name: 'user', type: 'address' },
      { name: 'collateralAddress', type: 'address' },
      { name: 'collateralAmount', type: 'uint256' },
      { name: 'usnAmount', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };

  async function makeOrder(
    overrides: Partial<RedeemOrder> = {}
  ): Promise<RedeemOrder> {
    return {
      message: 'redeem',
      user: await user.getAddress(),
      collateralAddress: await collateral.getAddress(),
      collateralAmount: ethers.parseUnits('100', 18),
      usnAmount: ethers.parseUnits('100', 18),
      expiry: (await latestTimestamp()) + 3600,
      nonce: 1,
      ...overrides,
    };
  }

  async function signOrder(
    signer: HardhatEthersSigner,
    order: RedeemOrder
  ): Promise<string> {
    return signer.signTypedData(domain, types, order);
  }

  beforeEach(async function () {
    [owner, admin, burner, user, treasury, outsider] =
      await ethers.getSigners();

    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointMock = await EndpointV2Mock.deploy(1);

    const USNFactory = await ethers.getContractFactory('USN');
    usn = await USNFactory.deploy(await endpointMock.getAddress());
    await usn.enablePermissionless();
    await usn.setAdmin(await owner.getAddress());

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    collateral = await MockERC20Factory.deploy('Collateral', 'COL');

    const MockOracleFactory = await ethers.getContractFactory(
      'MockChainlinkPriceFeed'
    );
    oracle = await MockOracleFactory.deploy(ONE_USD, 8);

    const RedeemHandlerV2Factory =
      await ethers.getContractFactory('RedeemHandlerV2');
    handler = await RedeemHandlerV2Factory.deploy(await usn.getAddress());

    // Wiring
    await handler.grantRole(
      await handler.DEFAULT_ADMIN_ROLE(),
      await admin.getAddress()
    );
    await handler.grantRole(
      await handler.BURNER_ROLE(),
      await burner.getAddress()
    );
    // Owner needs APPROVER_ROLE for the existing approve/reject tests to keep
    // working without threading a new signer through every call.
    await handler.grantRole(
      await handler.APPROVER_ROLE(),
      await owner.getAddress()
    );
    await handler.addRedeemableCollateral(
      await collateral.getAddress(),
      await oracle.getAddress()
    );
    await handler.setCollateralStalenessThreshold(
      await collateral.getAddress(),
      3600n
    );
    await handler.addWhitelistedUser(await user.getAddress());
    await handler.setTreasury(await treasury.getAddress());

    // Seed
    await usn.mint(await user.getAddress(), userInitialUSN);
    await collateral.mint(
      await treasury.getAddress(),
      treasuryInitialCollateral
    );
    await collateral
      .connect(treasury)
      .approve(await handler.getAddress(), ethers.MaxUint256);

    // Minter handler wired so the fixture can model the #13 cycling attack.
    // custodialWallet == treasury: collateral moved into treasury on mint is
    // the same pool the redeem handler pulls from, which is the assumption
    // the auditor's PoC relies on.
    const MinterHandlerV2Factory =
      await ethers.getContractFactory('MinterHandlerV2');
    minter = await MinterHandlerV2Factory.deploy(await usn.getAddress());
    await minter.setCustodialWallet(await treasury.getAddress());
    await minter.setPriceFeed(
      await collateral.getAddress(),
      await oracle.getAddress()
    );
    await minter.addWhitelistedCollateral(await collateral.getAddress());
    await minter.setCollateralStalenessThreshold(
      await collateral.getAddress(),
      3600n
    );
    await minter.addWhitelistedUser(await user.getAddress());
    // USN's mint() is admin-gated. Owner remains admin (needed by other tests
    // that seed USN); tests that call minter.directMint must transfer USN
    // admin to the minter temporarily.

    domain = {
      name: 'RedeemHandlerV2',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await handler.getAddress(),
    };
  });

  describe('constructor', function () {
    it('reverts on zero USN address', async function () {
      const Factory = await ethers.getContractFactory('RedeemHandlerV2');
      await expect(
        Factory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
    });

    it('sets the deployer as default admin and seeds defaults', async function () {
      expect(
        await handler.hasRole(
          await handler.DEFAULT_ADMIN_ROLE(),
          await owner.getAddress()
        )
      ).to.equal(true);
      expect(await handler.redeemLimitPerBlock()).to.equal(
        ethers.parseUnits('1000000', 18)
      );
      expect(await handler.directRedeemLimitPerDay()).to.equal(
        ethers.parseUnits('100000', 18)
      );
      expect(await handler.priceThresholdBps()).to.equal(100n);
      expect(await handler.QUEUE_EXPIRY()).to.equal(QUEUE_EXPIRY);
    });
  });

  describe('admin: treasury / limits / staleness / threshold', function () {
    it('only DEFAULT_ADMIN_ROLE can set treasury', async function () {
      await expect(
        handler.connect(outsider).setTreasury(await outsider.getAddress())
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('rejects zero address treasury and emits TreasuryUpdated on success', async function () {
      await expect(
        handler.setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
      await expect(handler.setTreasury(await outsider.getAddress()))
        .to.emit(handler, 'TreasuryUpdated')
        .withArgs(await treasury.getAddress(), await outsider.getAddress());
      expect(await handler.treasury()).to.equal(await outsider.getAddress());
    });

    it('setRedeemLimitPerBlock emits and updates', async function () {
      await expect(handler.setRedeemLimitPerBlock(42n))
        .to.emit(handler, 'RedeemLimitPerBlockUpdated')
        .withArgs(42n);
      expect(await handler.redeemLimitPerBlock()).to.equal(42n);
    });

    it('setDirectRedeemLimitPerDay emits and updates', async function () {
      await expect(handler.setDirectRedeemLimitPerDay(99n))
        .to.emit(handler, 'DirectRedeemLimitUpdated')
        .withArgs(99n);
      expect(await handler.directRedeemLimitPerDay()).to.equal(99n);
    });

    it('setCollateralStalenessThreshold emits, updates, and guards inputs', async function () {
      const collAddr = await collateral.getAddress();
      await expect(
        handler
          .connect(outsider)
          .setCollateralStalenessThreshold(collAddr, 120n)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
      await expect(
        handler.setCollateralStalenessThreshold(ethers.ZeroAddress, 120n)
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
      await expect(
        handler.setCollateralStalenessThreshold(collAddr, 0n)
      ).to.be.revertedWithCustomError(handler, 'ZeroAmount');
      await expect(handler.setCollateralStalenessThreshold(collAddr, 120n))
        .to.emit(handler, 'CollateralStalenessThresholdUpdated')
        .withArgs(collAddr, 120n);
      expect(await handler.collateralStalenessThreshold(collAddr)).to.equal(
        120n
      );
    });

    it('setPriceThreshold caps at 10% (1000 bps)', async function () {
      await expect(handler.setPriceThreshold(1001n)).to.be.revertedWith(
        'Threshold too high'
      );
      await expect(handler.setPriceThreshold(500n))
        .to.emit(handler, 'PriceThresholdUpdated')
        .withArgs(500n);
      expect(await handler.priceThresholdBps()).to.equal(500n);
    });
  });

  describe('admin: collateral & oracle management', function () {
    let other: MockERC20;

    beforeEach(async function () {
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      other = await MockERC20Factory.deploy('Other', 'OTH');
    });

    it('addRedeemableCollateral guards on roles, zero, and duplicate', async function () {
      await expect(
        handler
          .connect(outsider)
          .addRedeemableCollateral(
            await other.getAddress(),
            await oracle.getAddress()
          )
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
      await expect(
        handler.addRedeemableCollateral(
          ethers.ZeroAddress,
          await oracle.getAddress()
        )
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
      await expect(
        handler.addRedeemableCollateral(
          await other.getAddress(),
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(handler, 'ZeroOracleAddress');
      await expect(
        handler.addRedeemableCollateral(
          await collateral.getAddress(),
          await oracle.getAddress()
        )
      ).to.be.revertedWithCustomError(handler, 'CollateralAlreadyAdded');
    });

    it('addRedeemableCollateral emits both events and sets state', async function () {
      const tx = handler.addRedeemableCollateral(
        await other.getAddress(),
        await oracle.getAddress()
      );
      await expect(tx)
        .to.emit(handler, 'CollateralAdded')
        .withArgs(await other.getAddress());
      await expect(tx)
        .to.emit(handler, 'CollateralOracleUpdated')
        .withArgs(await other.getAddress(), await oracle.getAddress());
      expect(
        await handler.redeemableCollaterals(await other.getAddress())
      ).to.equal(true);
      expect(await handler.priceFeeds(await other.getAddress())).to.equal(
        await oracle.getAddress()
      );
    });

    it('removeRedeemableCollateral clears the oracle and emits', async function () {
      await expect(
        handler.removeRedeemableCollateral(await other.getAddress())
      ).to.be.revertedWithCustomError(handler, 'CollateralNotFound');
      await expect(
        handler.removeRedeemableCollateral(await collateral.getAddress())
      )
        .to.emit(handler, 'CollateralRemoved')
        .withArgs(await collateral.getAddress());
      expect(
        await handler.redeemableCollaterals(await collateral.getAddress())
      ).to.equal(false);
      expect(await handler.priceFeeds(await collateral.getAddress())).to.equal(
        ethers.ZeroAddress
      );
    });

    it('updateCollateralOracle requires the collateral to be registered', async function () {
      await expect(
        handler.updateCollateralOracle(
          await other.getAddress(),
          await oracle.getAddress()
        )
      ).to.be.revertedWithCustomError(handler, 'CollateralNotFound');
      await expect(
        handler.updateCollateralOracle(
          await collateral.getAddress(),
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(handler, 'ZeroOracleAddress');

      const newOracleFactory = await ethers.getContractFactory(
        'MockChainlinkPriceFeed'
      );
      const newOracle = await newOracleFactory.deploy(ONE_USD, 8);
      await expect(
        handler.updateCollateralOracle(
          await collateral.getAddress(),
          await newOracle.getAddress()
        )
      )
        .to.emit(handler, 'CollateralOracleUpdated')
        .withArgs(await collateral.getAddress(), await newOracle.getAddress());
    });

    it('setPriceFeed allows arbitrary feed (not gated by addRedeemableCollateral)', async function () {
      await expect(
        handler.setPriceFeed(ethers.ZeroAddress, await oracle.getAddress())
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
      await expect(
        handler.setPriceFeed(
          await other.getAddress(),
          await oracle.getAddress()
        )
      )
        .to.emit(handler, 'PriceFeedSet')
        .withArgs(await other.getAddress(), await oracle.getAddress());
    });
  });

  describe('admin: whitelist', function () {
    it('addWhitelistedUser rejects zero / duplicate and emits', async function () {
      await expect(
        handler.addWhitelistedUser(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(handler, 'ZeroAddress');
      await expect(
        handler.addWhitelistedUser(await user.getAddress())
      ).to.be.revertedWithCustomError(handler, 'UserAlreadyWhitelisted');
      await expect(handler.addWhitelistedUser(await outsider.getAddress()))
        .to.emit(handler, 'WhitelistedUserAdded')
        .withArgs(await outsider.getAddress());
    });

    it('removeWhitelistedUser rejects unknown and emits', async function () {
      await expect(
        handler.removeWhitelistedUser(await outsider.getAddress())
      ).to.be.revertedWithCustomError(handler, 'UserNotWhitelisted');
      await expect(handler.removeWhitelistedUser(await user.getAddress()))
        .to.emit(handler, 'WhitelistedUserRemoved')
        .withArgs(await user.getAddress());
      expect(await handler.isWhitelisted(await user.getAddress())).to.equal(
        false
      );
    });
  });

  describe('redeem (signed)', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
    });

    it('happy path: burns USN, transfers collateral, emits Redeemed', async function () {
      const order = await makeOrder();
      const signature = await signOrder(user, order);

      const beforeUsn = await usn.balanceOf(await user.getAddress());
      const beforeCol = await collateral.balanceOf(await user.getAddress());
      const beforeTreasury = await collateral.balanceOf(
        await treasury.getAddress()
      );

      await expect(handler.connect(burner).redeem(order, signature))
        .to.emit(handler, 'Redeemed')
        .withArgs(
          await user.getAddress(),
          await collateral.getAddress(),
          order.usnAmount,
          order.collateralAmount
        );

      expect(await usn.balanceOf(await user.getAddress())).to.equal(
        beforeUsn - order.usnAmount
      );
      expect(await collateral.balanceOf(await user.getAddress())).to.equal(
        beforeCol + order.collateralAmount
      );
      expect(await collateral.balanceOf(await treasury.getAddress())).to.equal(
        beforeTreasury - order.collateralAmount
      );
    });

    it('reverts when caller lacks BURNER_ROLE', async function () {
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(outsider).redeem(order, signature)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('reverts on non-whitelisted user', async function () {
      await handler.removeWhitelistedUser(await user.getAddress());
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'UserNotWhitelisted');
    });

    it('reverts on non-redeemable collateral', async function () {
      const order = await makeOrder({
        collateralAddress: await outsider.getAddress(),
      });
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InvalidCollateralAddress');
    });

    it('reverts on expired order', async function () {
      const order = await makeOrder({
        expiry: (await latestTimestamp()) - 1,
      });
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'SignatureExpired');
    });

    it('reverts on zero usnAmount', async function () {
      const order = await makeOrder({ usnAmount: 0n });
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'ZeroAmount');
    });

    it('reverts on invalid signature (wrong signer)', async function () {
      const order = await makeOrder();
      const signature = await signOrder(outsider, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InvalidSignature');
    });

    it('reverts on nonce replay', async function () {
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await handler.connect(burner).redeem(order, signature);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InvalidNonce');
    });

    it('reverts on insufficient allowance', async function () {
      await usn.connect(user).approve(await handler.getAddress(), 0n);
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InsufficientAllowance');
    });

    it('reverts when per-block redeem limit would be exceeded', async function () {
      // Set the limit strictly below a single order amount; the very first
      // redeem trips the check inside the same block it lands in.
      await handler.setRedeemLimitPerBlock(ethers.parseUnits('99', 18));
      const order = await makeOrder();
      const sig = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, sig)
      ).to.be.revertedWithCustomError(handler, 'RedeemLimitExceeded');
    });

    it('resets the block counter at the next block', async function () {
      await handler.setRedeemLimitPerBlock(ethers.parseUnits('150', 18));
      const order1 = await makeOrder({ nonce: 1 });
      const order2 = await makeOrder({ nonce: 2 });
      const sig1 = await signOrder(user, order1);
      const sig2 = await signOrder(user, order2);
      await handler.connect(burner).redeem(order1, sig1);
      await ethers.provider.send('evm_mine', []);
      await expect(handler.connect(burner).redeem(order2, sig2)).to.not.be
        .reverted;
    });

    it('reverts when treasury unset', async function () {
      const Factory = await ethers.getContractFactory('RedeemHandlerV2');
      const fresh = await Factory.deploy(await usn.getAddress());
      await fresh.grantRole(
        await fresh.BURNER_ROLE(),
        await burner.getAddress()
      );
      await fresh.addRedeemableCollateral(
        await collateral.getAddress(),
        await oracle.getAddress()
      );
      await fresh.addWhitelistedUser(await user.getAddress());
      await usn
        .connect(user)
        .approve(await fresh.getAddress(), ethers.MaxUint256);

      const order = await makeOrder();
      const freshDomain = {
        ...domain,
        verifyingContract: await fresh.getAddress(),
      };
      const sig = await user.signTypedData(freshDomain, types, order);
      await expect(
        fresh.connect(burner).redeem(order, sig)
      ).to.be.revertedWithCustomError(fresh, 'TreasuryNotSet');
    });

    it('reverts when treasury has insufficient balance', async function () {
      // drain treasury
      await collateral
        .connect(treasury)
        .transfer(await outsider.getAddress(), treasuryInitialCollateral);
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InsufficientTreasuryBalance');
    });

    it('reverts on zero collateralAmount', async function () {
      const order = await makeOrder({ collateralAmount: 0n });
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'ZeroAmount');
    });

    it('reverts when order.collateralAmount > calculated', async function () {
      // calculatedCollateralAmount with peg price = usnAmount (same decimals)
      const order = await makeOrder({
        usnAmount: ethers.parseUnits('100', 18),
        collateralAmount: ethers.parseUnits('101', 18),
      });
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InvalidCollateralAmount');
    });

    it('reverts on stale oracle data inside getCollateralPrice', async function () {
      await increaseTime(3601);
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'StaleOracleData');
    });

    it('reverts on non-positive oracle answer', async function () {
      await oracle.setPrice(0);
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler.connect(burner).redeem(order, signature)
      ).to.be.revertedWithCustomError(handler, 'InvalidOraclePrice');
    });

    it('normalizes feed decimals for the signed redeem path', async function () {
      // Fix #17: a feed that reports prices in 18 decimals must yield the same collateral
      // amount as an 8-decimal feed. Before the fix the raw 18-dec answer was fed into the
      // 8-dec pricing formula and rounded the redemption toward zero / caused a revert.
      const MockOracleFactory = await ethers.getContractFactory(
        'MockChainlinkPriceFeed'
      );
      const highDecOracle = await MockOracleFactory.deploy(
        ethers.parseUnits('1', 18),
        18
      );
      await handler.updateCollateralOracle(
        await collateral.getAddress(),
        await highDecOracle.getAddress()
      );

      const order = await makeOrder();
      const signature = await signOrder(user, order);

      const beforeCol = await collateral.balanceOf(await user.getAddress());
      await expect(handler.connect(burner).redeem(order, signature)).to.emit(
        handler,
        'Redeemed'
      );
      // At the peg with the same 100e18 request, user receives 100e18 collateral
      // regardless of the feed's native precision.
      expect(await collateral.balanceOf(await user.getAddress())).to.equal(
        beforeCol + order.collateralAmount
      );
    });
  });

  describe('redeemWithPermit', function () {
    it('falls back to plain allowance path when permit signature is irrelevant', async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      const fakeSig = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };
      await expect(
        handler
          .connect(burner)
          .redeemWithPermit(order, signature, fakeSig.v, fakeSig.r, fakeSig.s)
      ).to.emit(handler, 'Redeemed');
    });

    it('reverts non-whitelisted user before touching permit', async function () {
      await handler.removeWhitelistedUser(await user.getAddress());
      const order = await makeOrder();
      const signature = await signOrder(user, order);
      await expect(
        handler
          .connect(burner)
          .redeemWithPermit(
            order,
            signature,
            27,
            ethers.ZeroHash,
            ethers.ZeroHash
          )
      ).to.be.revertedWithCustomError(handler, 'UserNotWhitelisted');
    });

    it('reverts on bad inner signature even with permit args', async function () {
      const order = await makeOrder();
      const badSig = await signOrder(outsider, order);
      await expect(
        handler
          .connect(burner)
          .redeemWithPermit(order, badSig, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(handler, 'InvalidSignature');
    });
  });

  describe('directRedeem (immediate path)', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
    });

    it('queues the request without burning or transferring', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      const usnBefore = await usn.balanceOf(await user.getAddress());
      const colBefore = await collateral.balanceOf(await user.getAddress());
      const treasuryBefore = await collateral.balanceOf(
        await treasury.getAddress()
      );

      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), usnAmount, 0n)
      ).to.emit(handler, 'RedeemQueued');

      // No burn, no transfer until an approver acts on the queue entry.
      expect(await usn.balanceOf(await user.getAddress())).to.equal(usnBefore);
      expect(await collateral.balanceOf(await user.getAddress())).to.equal(
        colBefore
      );
      expect(await collateral.balanceOf(await treasury.getAddress())).to.equal(
        treasuryBefore
      );
      expect(await handler.nextQueueId()).to.equal(2n);
    });

    it('reverts on non-whitelisted user', async function () {
      await expect(
        handler
          .connect(outsider)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('1', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'UserNotWhitelisted');
    });

    it('reverts on non-redeemable collateral', async function () {
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await outsider.getAddress(),
            ethers.parseUnits('1', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'InvalidCollateralAddress');
    });

    it('reverts on zero usnAmount', async function () {
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), 0n, 0n)
      ).to.be.revertedWithCustomError(handler, 'ZeroAmount');
    });

    it('reverts on slippage shortfall', async function () {
      await oracle.setPrice(ONE_USD * 2n); // price > upper bound → less collateral
      const usnAmount = ethers.parseUnits('100', 18);
      const minOut = ethers.parseUnits('100', 18); // same as input
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), usnAmount, minOut)
      ).to.be.revertedWithCustomError(handler, 'InvalidCollateralAmount');
    });

    it('reverts when insufficient allowance', async function () {
      await usn.connect(user).approve(await handler.getAddress(), 0n);
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('1', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'InsufficientAllowance');
    });

    it('reverts when treasury unset', async function () {
      await handler.setTreasury(await outsider.getAddress());
      // change to outsider treasury which has no balance and no approval
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('1', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'InsufficientTreasuryBalance');
    });

    it('reverts when oracle is not set', async function () {
      // setPriceFeed to zero
      await handler.setPriceFeed(
        await collateral.getAddress(),
        ethers.ZeroAddress
      );
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('1', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'PriceFeedNotSet');
    });
  });

  describe('directRedeem (queue path)', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      // Force queue path by lowering per-block limit below the redeem
      await handler.setRedeemLimitPerBlock(ethers.parseUnits('1', 18));
    });

    it('queues instead of executing when limit would be exceeded', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      const beforeBalance = await usn.balanceOf(await user.getAddress());
      const tx = await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await expect(tx).to.emit(handler, 'RedeemQueued');
      // USN not burnt yet
      expect(await usn.balanceOf(await user.getAddress())).to.equal(
        beforeBalance
      );
      expect(await handler.nextQueueId()).to.equal(2n);

      const q = await handler.getQueuedRedeem(1n);
      expect(q.user).to.equal(await user.getAddress());
      expect(q.usnAmount).to.equal(usnAmount);
      expect(q.status).to.equal(0n); // PENDING
    });

    it('approveQueuedRedeem burns USN and sends collateral', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);

      const beforeUsn = await usn.balanceOf(await user.getAddress());
      const beforeCol = await collateral.balanceOf(await user.getAddress());

      const tx = handler.approveQueuedRedeem(1n);
      await expect(tx)
        .to.emit(handler, 'RedeemApproved')
        .withArgs(1n, await owner.getAddress());
      await expect(tx).to.emit(handler, 'RedeemClaimed');

      expect(await usn.balanceOf(await user.getAddress())).to.equal(
        beforeUsn - usnAmount
      );
      expect(await collateral.balanceOf(await user.getAddress())).to.be.gt(
        beforeCol
      );
      const q = await handler.getQueuedRedeem(1n);
      expect(q.status).to.equal(1n); // APPROVED
    });

    it('approveQueuedRedeem reverts on missing / non-pending / expired', async function () {
      await expect(
        handler.approveQueuedRedeem(42n)
      ).to.be.revertedWithCustomError(handler, 'QueueNotFound');

      const usnAmount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await handler.rejectQueuedRedeem(1n);
      await expect(
        handler.approveQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(handler, 'QueueNotPending');

      // Queue another and let it expire
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await increaseTime(QUEUE_EXPIRY + 1);
      await expect(
        handler.approveQueuedRedeem(2n)
      ).to.be.revertedWithCustomError(handler, 'QueueExpired');
    });

    it('rejectQueuedRedeem flips status to REJECTED and reverts on bad id', async function () {
      await expect(
        handler.rejectQueuedRedeem(99n)
      ).to.be.revertedWithCustomError(handler, 'QueueNotFound');

      const usnAmount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await expect(handler.rejectQueuedRedeem(1n))
        .to.emit(handler, 'RedeemRejected')
        .withArgs(1n, await owner.getAddress());
      const q = await handler.getQueuedRedeem(1n);
      expect(q.status).to.equal(2n); // REJECTED
    });

    it('cancelQueuedRedeem is restricted to the queue owner', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await expect(
        handler.connect(outsider).cancelQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(handler, 'UserNotWhitelisted');
      await expect(handler.connect(user).cancelQueuedRedeem(1n))
        .to.emit(handler, 'RedeemRejected')
        .withArgs(1n, await user.getAddress());
    });

    it('reclaimExpiredRedeem only works after QUEUE_EXPIRY', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);
      await expect(
        handler.reclaimExpiredRedeem(1n)
      ).to.be.revertedWithCustomError(handler, 'QueueNotExpired');
      await increaseTime(QUEUE_EXPIRY + 1);
      await expect(handler.connect(outsider).reclaimExpiredRedeem(1n))
        .to.emit(handler, 'RedeemReclaimed')
        .withArgs(1n, await user.getAddress(), usnAmount);
      const q = await handler.getQueuedRedeem(1n);
      expect(q.status).to.equal(3n); // EXPIRED
    });

    it('getQueuedRedeem reverts on missing id', async function () {
      await expect(handler.getQueuedRedeem(999n)).to.be.revertedWithCustomError(
        handler,
        'QueueNotFound'
      );
    });
  });

  describe('previewDirectRedeem & price logic', function () {
    it('returns 1:1 within threshold', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      const [collateralAmount, priceUsed] = await handler.previewDirectRedeem(
        await collateral.getAddress(),
        usnAmount
      );
      expect(priceUsed).to.equal(ONE_USD);
      expect(collateralAmount).to.equal(usnAmount);
    });

    it('still 1:1 below threshold (peg-protected)', async function () {
      await oracle.setPrice(ONE_USD / 2n);
      const usnAmount = ethers.parseUnits('100', 18);
      const [collateralAmount] = await handler.previewDirectRedeem(
        await collateral.getAddress(),
        usnAmount
      );
      expect(collateralAmount).to.equal(usnAmount);
    });

    it('gives less collateral above threshold (actual price)', async function () {
      await oracle.setPrice(ONE_USD * 2n);
      const usnAmount = ethers.parseUnits('100', 18);
      const [collateralAmount] = await handler.previewDirectRedeem(
        await collateral.getAddress(),
        usnAmount
      );
      expect(collateralAmount).to.equal(usnAmount / 2n);
    });

    it('reverts on missing price feed', async function () {
      await expect(
        handler.previewDirectRedeem(
          await outsider.getAddress(),
          ethers.parseUnits('1', 18)
        )
      ).to.be.revertedWithCustomError(handler, 'PriceFeedNotSet');
    });

    it('reverts on stale oracle in directRedeem', async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await increaseTime(3601);
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('100', 18),
            0n
          )
      ).to.be.revertedWithCustomError(handler, 'StalePrice');
    });
  });

  describe('view helpers', function () {
    it('getCollateralPrice returns the oracle answer + timestamp', async function () {
      const [price, ts] = await handler.getCollateralPrice(
        await collateral.getAddress()
      );
      expect(price).to.equal(ONE_USD);
      expect(ts).to.be.greaterThan(0n);
    });

    it('getCollateralPrice reverts when oracle not set', async function () {
      await expect(
        handler.getCollateralPrice(await outsider.getAddress())
      ).to.be.revertedWithCustomError(handler, 'OracleNotSet');
    });

    it('calculateCollateralAmount returns the oracle-derived collateral', async function () {
      const out = await handler.calculateCollateralAmount(
        await collateral.getAddress(),
        ethers.parseUnits('100', 18)
      );
      expect(out).to.equal(ethers.parseUnits('100', 18));
    });

    it('getTreasuryBalance returns the treasury collateral balance', async function () {
      expect(
        await handler.getTreasuryBalance(await collateral.getAddress())
      ).to.equal(treasuryInitialCollateral);
    });

    it('getTreasuryBalance reverts when treasury not set', async function () {
      const Factory = await ethers.getContractFactory('RedeemHandlerV2');
      const fresh = await Factory.deploy(await usn.getAddress());
      await expect(
        fresh.getTreasuryBalance(await collateral.getAddress())
      ).to.be.revertedWithCustomError(fresh, 'TreasuryNotSet');
    });

    it('hashOrder / encodeOrder are deterministic', async function () {
      const order = await makeOrder();
      const encoded = await handler.encodeOrder(order);
      const hash = await handler.hashOrder(order);
      expect(encoded).to.be.a('string');
      expect(hash).to.match(/^0x[0-9a-f]{64}$/i);
    });
  });

  // ============================================================
  // Gap coverage for the mechanism the PR introduces (as opposed to the
  // attack-regression tests further below, which prove the bug is dead).
  // ============================================================

  describe('directRedeem: minimum amount (anti-spam)', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
    });

    it('reverts when usnAmount < minDirectRedeemAmount', async function () {
      const belowMin = ethers.parseUnits('0.1', 18); // < 1 USN default min
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), belowMin, 0n)
      )
        .to.be.revertedWithCustomError(handler, 'DirectRedeemAmountTooSmall')
        .withArgs(DEFAULT_MIN_DIRECT_REDEEM, belowMin);
    });

    it('accepts usnAmount == minDirectRedeemAmount (boundary)', async function () {
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            DEFAULT_MIN_DIRECT_REDEEM,
            0n
          )
      ).to.emit(handler, 'RedeemQueued');
    });

    it('setMinDirectRedeemAmount is DEFAULT_ADMIN_ROLE only and emits event', async function () {
      await expect(
        handler.connect(outsider).setMinDirectRedeemAmount(5n)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
      await expect(handler.setMinDirectRedeemAmount(5n))
        .to.emit(handler, 'MinDirectRedeemAmountUpdated')
        .withArgs(5n);
      expect(await handler.minDirectRedeemAmount()).to.equal(5n);
    });

    it('setting min to 0 disables the min check but zero still reverts', async function () {
      await handler.setMinDirectRedeemAmount(0n);
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), 0n, 0n)
      ).to.be.revertedWithCustomError(handler, 'ZeroAmount');
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), 1n, 0n)
      ).to.emit(handler, 'RedeemQueued');
    });
  });

  describe('directRedeem: balance / allowance checks (anti-spam)', function () {
    it('reverts InsufficientUserBalance when balance < usnAmount even with allowance', async function () {
      await handler.addWhitelistedUser(await outsider.getAddress());
      await usn
        .connect(outsider)
        .approve(await handler.getAddress(), ethers.MaxUint256);

      const amount = ethers.parseUnits('1', 18);
      await expect(
        handler
          .connect(outsider)
          .directRedeem(await collateral.getAddress(), amount, 0n)
      )
        .to.be.revertedWithCustomError(handler, 'InsufficientUserBalance')
        .withArgs(amount, 0n);
    });

    it('reverts InsufficientAllowance when allowance < usnAmount even with sufficient balance', async function () {
      // user holds 10k USN seeded but does not approve the handler
      const amount = ethers.parseUnits('1', 18);
      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), amount, 0n)
      ).to.be.revertedWithCustomError(handler, 'InsufficientAllowance');
    });
  });

  describe('role separation: APPROVER_ROLE vs DEFAULT_ADMIN_ROLE', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await handler
        .connect(user)
        .directRedeem(
          await collateral.getAddress(),
          ethers.parseUnits('100', 18),
          0n
        );
    });

    it('approveQueuedRedeem reverts for DEFAULT_ADMIN_ROLE without APPROVER_ROLE', async function () {
      await expect(
        handler.connect(admin).approveQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('rejectQueuedRedeem reverts for DEFAULT_ADMIN_ROLE without APPROVER_ROLE', async function () {
      await expect(
        handler.connect(admin).rejectQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('setDirectRedeemLimitPerDay reverts for APPROVER_ROLE without DEFAULT_ADMIN_ROLE', async function () {
      await handler.grantRole(
        await handler.APPROVER_ROLE(),
        await outsider.getAddress()
      );
      await expect(
        handler.connect(outsider).setDirectRedeemLimitPerDay(1n)
      ).to.be.revertedWithCustomError(
        handler,
        'AccessControlUnauthorizedAccount'
      );
      await expect(
        handler.connect(admin).setDirectRedeemLimitPerDay(1n)
      ).to.emit(handler, 'DirectRedeemLimitUpdated');
    });
  });

  describe('daily cap enforced at approval time', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
    });

    it('approveQueuedRedeem consumes the daily cap and updates counter', async function () {
      const amount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0n);

      const before = await handler.currentDayDirectRedeemApproved();
      await handler.approveQueuedRedeem(1n);
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(
        before + amount
      );
    });

    it('reverts DirectRedeemLimitExceeded when consumption would exceed cap', async function () {
      const smallCap = ethers.parseUnits('50', 18);
      await handler.setDirectRedeemLimitPerDay(smallCap);
      const amount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0n);

      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(handler, 'DirectRedeemLimitExceeded')
        .withArgs(smallCap, amount);
    });

    it('rejectQueuedRedeem does NOT consume the cap', async function () {
      const amount = ethers.parseUnits('100', 18);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0n);

      const before = await handler.currentDayDirectRedeemApproved();
      await handler.rejectQueuedRedeem(1n);
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(before);
    });

    it('day rollover resets the counter (explicit UTC day boundary)', async function () {
      const cap = ethers.parseUnits('100', 18);
      await handler.setDirectRedeemLimitPerDay(cap);
      const amount = ethers.parseUnits('100', 18);

      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0n);
      await handler.approveQueuedRedeem(1n);
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(cap);

      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0n);
      await expect(
        handler.approveQueuedRedeem(2n)
      ).to.be.revertedWithCustomError(handler, 'DirectRedeemLimitExceeded');

      const now = await latestTimestamp();
      const nextDayStart = (Math.floor(now / 86400) + 1) * 86400;
      await ethers.provider.send('evm_setNextBlockTimestamp', [nextDayStart]);
      await ethers.provider.send('evm_mine', []);

      await handler.approveQueuedRedeem(2n);
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(amount);
    });

    it('accumulates approved amounts across multiple entries within one day', async function () {
      // Cap = 100 USN, entries of 60 and 50. Sum (110) overflows the cap at
      // the second approval — exercises the newDayApproved = dayApproved +
      // q.usnAmount arithmetic that single-entry tests do not.
      const cap = ethers.parseUnits('100', 18);
      await handler.setDirectRedeemLimitPerDay(cap);
      const first = ethers.parseUnits('60', 18);
      const second = ethers.parseUnits('50', 18);

      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), first, 0n);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), second, 0n);

      await handler.approveQueuedRedeem(1n);
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(first);

      await expect(handler.approveQueuedRedeem(2n))
        .to.be.revertedWithCustomError(handler, 'DirectRedeemLimitExceeded')
        .withArgs(cap, first + second);

      // Counter unchanged by the failed approval attempt
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(first);
    });
  });

  describe('queue lifecycle: state changes between queue and approval', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await handler
        .connect(user)
        .directRedeem(
          await collateral.getAddress(),
          ethers.parseUnits('100', 18),
          0n
        );
    });

    it('un-whitelisting the user after queueing reverts UserNotWhitelisted at approval', async function () {
      await handler.removeWhitelistedUser(await user.getAddress());
      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(handler, 'UserNotWhitelisted')
        .withArgs(await user.getAddress());
    });

    it('removing the collateral after queueing reverts InvalidCollateralAddress at approval', async function () {
      await handler.removeRedeemableCollateral(await collateral.getAddress());
      await expect(
        handler.approveQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(handler, 'InvalidCollateralAddress');
    });

    it('treasury drained after queueing reverts InsufficientTreasuryBalance at approval', async function () {
      const q = await handler.getQueuedRedeem(1n);
      const treasuryBalance = await collateral.balanceOf(
        await treasury.getAddress()
      );
      await collateral
        .connect(treasury)
        .transfer(await outsider.getAddress(), treasuryBalance);

      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(handler, 'InsufficientTreasuryBalance')
        .withArgs(await collateral.getAddress(), q.collateralAmount, 0n);
    });

    it('user transfers USN away after queueing: burnFrom reverts with ERC20InsufficientBalance (queue-then-drain)', async function () {
      // Re-validation covers whitelist/collateral/treasury but not user
      // balance/allowance — those still fire from the ERC20 layer. Documents
      // the escrow-less design.
      const q = await handler.getQueuedRedeem(1n);
      const bal = await usn.balanceOf(await user.getAddress());
      await usn.connect(user).transfer(await outsider.getAddress(), bal);

      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(usn, 'ERC20InsufficientBalance')
        .withArgs(await user.getAddress(), 0n, q.usnAmount);
    });

    it('user revokes allowance after queueing: burnFrom reverts with ERC20InsufficientAllowance (queue-then-revoke)', async function () {
      const q = await handler.getQueuedRedeem(1n);
      await usn.connect(user).approve(await handler.getAddress(), 0n);

      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(usn, 'ERC20InsufficientAllowance')
        .withArgs(await handler.getAddress(), 0n, q.usnAmount);
    });

    it('price is locked at queue time: oracle drift does not change payout', async function () {
      const q = await handler.getQueuedRedeem(1n);
      const lockedCollateral = q.collateralAmount;

      await oracle.setPrice(ONE_USD / 2n);

      const before = await collateral.balanceOf(await user.getAddress());
      await handler.approveQueuedRedeem(1n);
      const after = await collateral.balanceOf(await user.getAddress());
      expect(after - before).to.equal(lockedCollateral);
    });
  });

  describe('queue expiry boundary', function () {
    beforeEach(async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await handler
        .connect(user)
        .directRedeem(
          await collateral.getAddress(),
          ethers.parseUnits('100', 18),
          0n
        );
    });

    it('succeeds at exactly queuedAt + QUEUE_EXPIRY (comparison is strict `>`)', async function () {
      const q = await handler.getQueuedRedeem(1n);
      const target = Number(q.queuedAt) + QUEUE_EXPIRY;
      await ethers.provider.send('evm_setNextBlockTimestamp', [target]);
      await expect(handler.approveQueuedRedeem(1n)).to.emit(
        handler,
        'RedeemApproved'
      );
    });

    it('reverts QueueExpired at queuedAt + QUEUE_EXPIRY + 1s', async function () {
      const q = await handler.getQueuedRedeem(1n);
      const target = Number(q.queuedAt) + QUEUE_EXPIRY + 1;
      await ethers.provider.send('evm_setNextBlockTimestamp', [target]);
      await expect(
        handler.approveQueuedRedeem(1n)
      ).to.be.revertedWithCustomError(handler, 'QueueExpired');
    });
  });

  // ============================================================
  // Attack-focused regression tests for issues #13 and #12.
  // Each test names the exact property from the audit finding it verifies.
  // ============================================================

  describe('issue #13: directMint -> directRedeem cycling attack', function () {
    it('single-tx sequential cycle leaves the treasury credited and the redeem cap untouched (literal regression)', async function () {
      const cycleAmount = ethers.parseUnits('100', 18);

      // Fund the attacker (= `user`) with collateral to feed the mint side.
      await collateral.mint(await user.getAddress(), cycleAmount);
      await collateral
        .connect(user)
        .approve(await minter.getAddress(), cycleAmount);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);

      // Transfer USN admin to minter so directMint can mint.
      await usn.setAdmin(await minter.getAddress());

      const treasuryBefore = await collateral.balanceOf(
        await treasury.getAddress()
      );
      const userUsnBefore = await usn.balanceOf(await user.getAddress());
      const userColBefore = await collateral.balanceOf(await user.getAddress());
      const capBefore = await handler.currentDayDirectRedeemApproved();

      await minter
        .connect(user)
        .directMint(await collateral.getAddress(), cycleAmount, 0);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), cycleAmount, 0);

      // Collateral moved into treasury via mint and STAYED there — the redeem
      // did not return it (which is the whole point of the queue).
      expect(await collateral.balanceOf(await treasury.getAddress())).to.equal(
        treasuryBefore + cycleAmount
      );
      expect(await collateral.balanceOf(await user.getAddress())).to.equal(
        userColBefore - cycleAmount
      );
      // USN was minted, not burned.
      expect(await usn.balanceOf(await user.getAddress())).to.equal(
        userUsnBefore + cycleAmount
      );
      // Redeem cap unconsumed — approvals are the only cap consumer.
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(
        capBefore
      );
      // A PENDING queue entry was created, nothing more.
      const q = await handler.getQueuedRedeem(1n);
      expect(q.status).to.equal(0n);
      expect(q.usnAmount).to.equal(cycleAmount);
    });

    it('flashloan-style single-external-call cycle leaves the attacker with zero collateral', async function () {
      const cycleAmount = ethers.parseUnits('100', 18);

      const AttackerFactory =
        await ethers.getContractFactory('MockFlashAttacker');
      const attacker: MockFlashAttacker = await AttackerFactory.deploy();

      await minter.addWhitelistedUser(await attacker.getAddress());
      await handler.addWhitelistedUser(await attacker.getAddress());
      // Simulate the flashloan proceeds landing in the attacker contract.
      await collateral.mint(await attacker.getAddress(), cycleAmount);
      await usn.setAdmin(await minter.getAddress());

      await attacker.attack(
        await minter.getAddress(),
        await handler.getAddress(),
        await collateral.getAddress(),
        await usn.getAddress(),
        cycleAmount
      );

      // Attacker's collateral is stuck in the treasury; nothing came back
      // inside the tx, so a flashloan can't be repaid.
      expect(await collateral.balanceOf(await attacker.getAddress())).to.equal(
        0n
      );
      // The redeem side left behind a PENDING queue entry for the attacker.
      const q = await handler.getQueuedRedeem(1n);
      expect(q.user).to.equal(await attacker.getAddress());
      expect(q.status).to.equal(0n);
      expect(q.usnAmount).to.equal(cycleAmount);
    });

    it('repeated cycling across multiple blocks does not drain the daily approval cap', async function () {
      const cycleAmount = ethers.parseUnits('100', 18);
      const cycles = 4;

      await collateral.mint(
        await user.getAddress(),
        cycleAmount * BigInt(cycles)
      );
      await collateral
        .connect(user)
        .approve(await minter.getAddress(), ethers.MaxUint256);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await usn.setAdmin(await minter.getAddress());

      for (let i = 0; i < cycles; i++) {
        await minter
          .connect(user)
          .directMint(await collateral.getAddress(), cycleAmount, 0);
        await handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), cycleAmount, 0);
        await ethers.provider.send('evm_mine', []);
      }

      // Cap is not touched by any amount of queuing — approvals are the only
      // consumer, and no approver ran here.
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(0n);
      expect(await handler.nextQueueId()).to.equal(BigInt(cycles + 1));
    });

    it('attacker spam does not block a legitimate redeemer (per-entry approvals, not FIFO)', async function () {
      const spam = DEFAULT_MIN_DIRECT_REDEEM;
      const aliceAmount = ethers.parseUnits('50', 18);

      // outsider = attacker, user = Alice
      await handler.addWhitelistedUser(await outsider.getAddress());
      await usn.mint(await outsider.getAddress(), spam * 4n);
      await usn
        .connect(outsider)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);

      for (let i = 0; i < 4; i++) {
        await handler
          .connect(outsider)
          .directRedeem(await collateral.getAddress(), spam, 0);
      }
      // Alice queues id 5.
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), aliceAmount, 0);

      const capBefore = await handler.currentDayDirectRedeemApproved();
      await expect(handler.approveQueuedRedeem(5n)).to.emit(
        handler,
        'RedeemApproved'
      );
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(
        capBefore + aliceAmount
      );
      // Attacker's entries are still PENDING and consumed no cap.
      for (let id = 1n; id <= 4n; id++) {
        const q = await handler.getQueuedRedeem(id);
        expect(q.status).to.equal(0n);
      }
    });
  });

  describe('issue #12: front-run and marginal overflow into the queue', function () {
    it('Bob queueing first does not change Alice`s locked price or shunt her onto a different path', async function () {
      const bobAmount = DEFAULT_MIN_DIRECT_REDEEM;
      const aliceAmount = ethers.parseUnits('50', 18);

      const bob = outsider;
      await handler.addWhitelistedUser(await bob.getAddress());
      await usn.mint(await bob.getAddress(), bobAmount);
      await usn
        .connect(bob)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);

      await handler
        .connect(bob)
        .directRedeem(await collateral.getAddress(), bobAmount, 0);
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), aliceAmount, 0);

      const bobEntry = await handler.getQueuedRedeem(1n);
      const aliceEntry = await handler.getQueuedRedeem(2n);
      // Both entries are equal-class PENDING queue records; there is no
      // distinct "immediate" path Bob's action could have shunted Alice off of.
      expect(bobEntry.status).to.equal(0n);
      expect(aliceEntry.status).to.equal(0n);
      // Alice's locked collateral was computed from her own call, unaffected
      // by Bob's earlier entry (1:1 at peg).
      expect(aliceEntry.usnAmount).to.equal(aliceAmount);
      expect(aliceEntry.collateralAmount).to.equal(aliceAmount);
      // Both approvable independently within the default cap.
      await expect(handler.approveQueuedRedeem(1n)).to.emit(
        handler,
        'RedeemApproved'
      );
      await expect(handler.approveQueuedRedeem(2n)).to.emit(
        handler,
        'RedeemApproved'
      );
      expect(await handler.currentDayDirectRedeemApproved()).to.equal(
        bobAmount + aliceAmount
      );
    });

    it('amounts far above the old daily cap queue with no special path; only approval reverts', async function () {
      const bigAmount = ethers.parseUnits('200000', 18);
      await usn.mint(await user.getAddress(), bigAmount);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      // Treasury needs enough collateral to survive the queue-time check.
      await collateral.mint(await treasury.getAddress(), bigAmount);

      const cap = await handler.directRedeemLimitPerDay();
      expect(bigAmount).to.be.gt(cap);

      await expect(
        handler
          .connect(user)
          .directRedeem(await collateral.getAddress(), bigAmount, 0)
      ).to.emit(handler, 'RedeemQueued');

      // The old marginal-overflow logic no longer exists — the whole amount
      // sits in one queue entry, and only the approval consults the cap.
      await expect(handler.approveQueuedRedeem(1n))
        .to.be.revertedWithCustomError(handler, 'DirectRedeemLimitExceeded')
        .withArgs(cap, bigAmount);
    });

    it('amounts far above the old per-block redeem limit queue too (limit no longer gates directRedeem)', async function () {
      await handler.setRedeemLimitPerBlock(1n);
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      // 100 USN >> 1 wei block limit — under the old code this would have
      // gone through the queue path via _wouldExceedLimits; here it just
      // queues like any other call.
      await expect(
        handler
          .connect(user)
          .directRedeem(
            await collateral.getAddress(),
            ethers.parseUnits('100', 18),
            0
          )
      ).to.emit(handler, 'RedeemQueued');
    });

    it('directRedeem always returns the new queueId (invariant change from the old immediate path)', async function () {
      await usn
        .connect(user)
        .approve(await handler.getAddress(), ethers.MaxUint256);
      const amount = ethers.parseUnits('1', 18);

      // Peek the return value without mutating state.
      const nextIdBefore = await handler.nextQueueId();
      const returned = await handler
        .connect(user)
        .directRedeem.staticCall(await collateral.getAddress(), amount, 0);
      // Old behavior: 0 on the immediate path. New invariant: always the id.
      expect(returned).to.equal(nextIdBefore);
      expect(returned).to.be.gte(1n);

      // Executing for real advances nextQueueId as predicted.
      await handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), amount, 0);
      expect(await handler.nextQueueId()).to.equal(returned + 1n);
    });
  });
});
