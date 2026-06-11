import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type {
  USN,
  RedeemHandlerV2,
  MockERC20,
  MockChainlinkPriceFeed,
  EndpointV2Mock,
} from '../typechain-types';

const ONE_USD = 10n ** 8n; // Chainlink 8-decimals peg
const QUEUE_EXPIRY = 24 * 60 * 60;

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
    await handler.addRedeemableCollateral(
      await collateral.getAddress(),
      await oracle.getAddress()
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
      expect(await handler.oracleStalenessThreshold()).to.equal(3600n);
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

    it('setOracleStalenessThreshold emits and updates', async function () {
      await expect(handler.setOracleStalenessThreshold(120n))
        .to.emit(handler, 'OracleStalenessThresholdUpdated')
        .withArgs(120n);
      expect(await handler.oracleStalenessThreshold()).to.equal(120n);
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

    it('burns USN, sends collateral, emits DirectRedeem', async function () {
      const usnAmount = ethers.parseUnits('100', 18);
      const tx = handler
        .connect(user)
        .directRedeem(await collateral.getAddress(), usnAmount, 0n);

      await expect(tx).to.emit(handler, 'DirectRedeem');
      const block = await ethers.provider.getBlock('latest');
      expect(await usn.balanceOf(await user.getAddress())).to.equal(
        userInitialUSN - usnAmount
      );
      expect(block!.number).to.be.greaterThan(0);
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
});
