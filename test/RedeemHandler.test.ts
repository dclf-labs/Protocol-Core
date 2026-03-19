import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';
import {
  USN,
  RedeemHandler,
  MinterHandlerV2,
  StakingVault,
  MockERC20,
} from '../typechain-types';

describe('RedeemHandler', function () {
  let usn: USN;
  let redeemHandler: RedeemHandler;
  let minterHandler: MinterHandlerV2;
  let stakingVault: StakingVault;
  let mockCollateral: MockERC20;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let rebaseManager: HardhatEthersSigner;
  let nonWhitelistedUser: HardhatEthersSigner;
  let endpointV2Mock: Contract;

  const initialMint = ethers.parseUnits('1000', 18);
  const redeemAmount = ethers.parseUnits('100', 18);
  const collateralAmount = ethers.parseUnits('50', 18);

  beforeEach(async function () {
    [owner, user, minter, rebaseManager, nonWhitelistedUser] =
      await ethers.getSigners();

    // Deploy mock LayerZero endpoint
    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5434);

    // Deploy USN
    const USNFactory = await ethers.getContractFactory('USN');
    usn = await USNFactory.deploy(endpointV2Mock.target);
    await usn.waitForDeployment();
    await usn.enablePermissionless();

    // Deploy RedeemHandler
    const RedeemHandlerFactory =
      await ethers.getContractFactory('RedeemHandler');
    redeemHandler = await RedeemHandlerFactory.deploy(await usn.getAddress());
    await redeemHandler.waitForDeployment();

    // Deploy MinterHandlerV2
    const MinterHandlerFactory =
      await ethers.getContractFactory('MinterHandlerV2');
    minterHandler = await MinterHandlerFactory.deploy(await usn.getAddress());
    await minterHandler.waitForDeployment();

    // Deploy StakingVault
    const StakingVaultFactory = await ethers.getContractFactory('StakingVault');
    stakingVault = await StakingVaultFactory.deploy(
      await usn.getAddress(),
      'StakingVault',
      'STV'
    );
    await stakingVault.waitForDeployment();

    // Deploy MockERC20 as collateral
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockCollateral = await MockERC20Factory.deploy('MockCollateral', 'MCL');
    await mockCollateral.waitForDeployment();

    // Set up roles
    await usn.setAdmin(await minterHandler.getAddress());
    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await redeemHandler.grantRole(
      await redeemHandler.BURNER_ROLE(),
      owner.address
    );
    await stakingVault.grantRole(
      await stakingVault.REBASE_MANAGER_ROLE(),
      rebaseManager.address
    );
    // Grant REDEEM_MANAGER_ROLE to the owner
    await redeemHandler.grantRole(
      await redeemHandler.REDEEM_MANAGER_ROLE(),
      owner.address
    );
    // Add mock collateral as redeemable
    await redeemHandler.addRedeemableCollateral(
      await mockCollateral.getAddress()
    );

    // Add mock collateral to MinterHandlerV2
    await minterHandler.addWhitelistedCollateral(
      await mockCollateral.getAddress()
    );

    // Add user to whitelist
    await minterHandler.addWhitelistedUser(user.address);

    // Set custodial wallet
    await minterHandler.setCustodialWallet(await redeemHandler.getAddress());
    // Prepare mint parameters
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600 * 100; // 100 hours from now
    const order = {
      message: `You are signing a request to mint ${initialMint} USN using ${initialMint} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: initialMint,
      usnAmount: initialMint,
      expiry: expiry,
      nonce: nonce,
    };
    const domain = {
      name: 'MinterHandlerV2',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await minterHandler.getAddress(),
    };
    const types = {
      Order: [
        { name: 'message', type: 'string' },
        { name: 'user', type: 'address' },
        { name: 'collateralAddress', type: 'address' },
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'usnAmount', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    };
    const signature = await user.signTypedData(domain, types, order);
    // Minter sends collateral to user
    await mockCollateral.mint(await user.getAddress(), initialMint);

    // Approve collateral to minterHandler
    await mockCollateral
      .connect(user)
      .approve(await minterHandler.getAddress(), initialMint);

    await minterHandler.connect(minter).mint(order, signature);
  });

  it('should allow redeeming tokens after minting', async function () {
    // Approve RedeemHandler to spend user's tokens
    await usn
      .connect(user)
      .approve(await redeemHandler.getAddress(), redeemAmount);

    // Mint collateral tokens to RedeemHandler
    await mockCollateral.mint(
      await redeemHandler.getAddress(),
      collateralAmount
    );

    // Prepare the redeem order
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: deadline,
      nonce: 1000000,
    };

    // Sign the order
    const domain = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
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
    const signature = await user.signTypedData(domain, types, redeemOrder);

    // Redeem tokens
    await expect(redeemHandler.connect(owner).redeem(redeemOrder, signature))
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );

    // Check balances
    expect(await usn.balanceOf(user.address)).to.equal(
      initialMint - redeemAmount
    );
    expect(await mockCollateral.balanceOf(user.address)).to.equal(
      collateralAmount
    );
  });

  it('should allow redeeming tokens after staking and rebase', async function () {
    const stakeAmount = ethers.parseUnits('500', 18);
    const rebaseAmount = ethers.parseUnits('50', 18);

    // Approve and deposit into StakingVault
    await usn
      .connect(user)
      .approve(await stakingVault.getAddress(), stakeAmount);
    await stakingVault.connect(user).deposit(stakeAmount, user.address);

    // Perform rebase
    const nonce = 0;
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const order = {
      message: `You are signing a request to mint ${rebaseAmount} USN using ${rebaseAmount} MCL as collateral.`,
      user: rebaseManager.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: rebaseAmount,
      usnAmount: rebaseAmount,
      expiry: expiry,
      nonce: nonce,
    };
    const domain = {
      name: 'MinterHandlerV2',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await minterHandler.getAddress(),
    };
    const types = {
      Order: [
        { name: 'message', type: 'string' },
        { name: 'user', type: 'address' },
        { name: 'collateralAddress', type: 'address' },
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'usnAmount', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    };
    const signature = await rebaseManager.signTypedData(domain, types, order);
    await minterHandler.addWhitelistedUser(rebaseManager.address);
    // Mint collateral to rebaseManager
    await mockCollateral.mint(
      await rebaseManager.getAddress(),
      collateralAmount
    );
    // Approve mintHandler to spend collateral
    await mockCollateral
      .connect(rebaseManager)
      .approve(await minterHandler.getAddress(), collateralAmount);
    await minterHandler.connect(minter).mint(order, signature);

    // Approve the USN to the StakingVault for rebase
    await usn
      .connect(rebaseManager)
      .approve(await stakingVault.getAddress(), rebaseAmount);
    await stakingVault.connect(rebaseManager).rebase(rebaseAmount);

    // Create withdrawal demand
    await stakingVault
      .connect(user)
      .createWithdrawalDemand(redeemAmount, false);

    // Wait for withdraw period
    await ethers.provider.send('evm_increaseTime', [86400]); // 1 day
    await ethers.provider.send('evm_mine', []);

    // Withdraw from StakingVault
    await stakingVault
      .connect(user)
      .withdraw(redeemAmount, user.address, user.address);

    // Approve RedeemHandler to spend user's tokens
    await usn
      .connect(user)
      .approve(await redeemHandler.getAddress(), redeemAmount);

    // Mint collateral tokens to RedeemHandler
    await mockCollateral.mint(
      await redeemHandler.getAddress(),
      collateralAmount
    );

    // Prepare the redeem order
    const deadline = Math.floor(Date.now() / 1000) + 360000000;
    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: deadline,
      nonce: Math.floor(Date.now()) * 1000,
    };

    // Sign the order
    const redeemDomain = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
    };
    const redeemTypes = {
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
    const redeemSignature = await user.signTypedData(
      redeemDomain,
      redeemTypes,
      redeemOrder
    );

    // Redeem tokens
    await expect(redeemHandler.redeem(redeemOrder, redeemSignature))
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );

    // Check balances
    const expectedBalance =
      initialMint - stakeAmount + redeemAmount - redeemAmount;
    expect(await usn.balanceOf(user.address)).to.equal(expectedBalance);
    expect(await mockCollateral.balanceOf(user.address)).to.equal(
      collateralAmount
    );
  });

  it('should not allow redeeming with expired signature', async function () {
    await usn
      .connect(user)
      .approve(await redeemHandler.getAddress(), redeemAmount);

    await mockCollateral.mint(
      await redeemHandler.getAddress(),
      collateralAmount
    );

    const expiredDeadline = Math.floor(Date.now() / 1000) - 3600 * 100; // 100 hours ago
    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: expiredDeadline,
      nonce: 1000000,
    };

    const domain = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
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
    const signature = await user.signTypedData(domain, types, redeemOrder);

    await expect(
      redeemHandler.redeem(redeemOrder, signature)
    ).to.be.revertedWithCustomError(redeemHandler, 'SignatureExpired');
  });

  it('should add redeemable collateral', async function () {
    const newCollateral = await (
      await ethers.getContractFactory('MockERC20')
    ).deploy('NewCollateral', 'NCL');
    await newCollateral.waitForDeployment();

    await expect(
      redeemHandler.addRedeemableCollateral(await newCollateral.getAddress())
    )
      .to.emit(redeemHandler, 'CollateralAdded')
      .withArgs(await newCollateral.getAddress());

    expect(
      await redeemHandler.redeemableCollaterals(
        await newCollateral.getAddress()
      )
    ).to.be.true;
  });

  it('should remove redeemable collateral', async function () {
    await expect(
      redeemHandler.removeRedeemableCollateral(
        await mockCollateral.getAddress()
      )
    )
      .to.emit(redeemHandler, 'CollateralRemoved')
      .withArgs(await mockCollateral.getAddress());

    expect(
      await redeemHandler.redeemableCollaterals(
        await mockCollateral.getAddress()
      )
    ).to.be.false;
  });

  it('should not allow adding zero address as collateral', async function () {
    await expect(
      redeemHandler.addRedeemableCollateral(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(redeemHandler, 'ZeroAddress');
  });

  it('should redeem with permit', async function () {
    const redeemAmount = ethers.parseUnits('100', 18);
    const collateralAmount = ethers.parseUnits('50', 18);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600 * 100); // 100 hour from now
    // Change usn minter to owner
    await usn.setAdmin(await owner.getAddress());
    // Mint USN to user
    await usn.mint(user.address, redeemAmount);

    // Prepare redeem order
    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: deadline,
      nonce: 100001,
    };

    // Sign redeem order
    const domain = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
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

    const signature = await user.signTypedData(domain, types, redeemOrder);

    // Prepare permit signature
    const nonce = await usn.nonces(user.address);
    const name = await usn.name();
    const version = '1';

    const permitDomain = {
      name: name,
      version: version,
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await usn.getAddress(),
    };

    const permitTypes = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const permitValues = {
      owner: user.address,
      spender: await redeemHandler.getAddress(),
      value: redeemAmount,
      nonce: nonce,
      deadline: deadline,
    };

    const permitSignature = await user.signTypedData(
      permitDomain,
      permitTypes,
      permitValues
    );
    const { v, r, s } = ethers.Signature.from(permitSignature);
    // Balance before redeem
    const balanceBefore = await usn.balanceOf(user.address);
    // Execute redeemWithPermit
    await expect(
      redeemHandler.redeemWithPermit(redeemOrder, signature, v, r, s)
    )
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );

    // Check balances
    expect(await usn.balanceOf(user.address)).to.equal(
      balanceBefore - redeemAmount
    );
    expect(await mockCollateral.balanceOf(user.address)).to.equal(
      collateralAmount
    );
  });

  it('should respect the redeem limit per block', async () => {
    const initialLimit = ethers.parseUnits('1000000', 18); // Default limit: 1 million USN
    expect(await redeemHandler.redeemLimitPerBlock()).to.equal(initialLimit);

    const redeemAmount = ethers.parseUnits('500000', 18);
    const collateralAmount = ethers.parseUnits('500000', 18);
    const deadline = Math.floor(Date.now() / 1000) + 3600 * 100;

    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: deadline,
      nonce: 10101,
    };

    const signature = await user.signTypedData(
      {
        name: 'RedeemHandler',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await redeemHandler.getAddress(),
      },
      {
        RedeemOrder: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      redeemOrder
    );

    await redeemHandler.grantRole(
      await redeemHandler.BURNER_ROLE(),
      owner.address
    );

    // setAdmin owner
    await usn.setAdmin(await owner.getAddress());
    await usn.mint(user.address, redeemAmount * 2n);
    await usn
      .connect(user)
      .approve(redeemHandler.getAddress(), redeemAmount * 2n);
    await mockCollateral.mint(
      redeemHandler.getAddress(),
      collateralAmount * 2n
    );

    // First redeem should succeed
    await expect(redeemHandler.connect(owner).redeem(redeemOrder, signature))
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );

    const redeemOrder2 = {
      ...redeemOrder,
      message: `You are signing a request to redeem ${redeemAmount * 3n} USN for ${collateralAmount} MCL.`,
      usnAmount: redeemAmount * 3n,
      collateralAmount: collateralAmount,
      nonce: 10102,
    };

    const signature2 = await user.signTypedData(
      {
        name: 'RedeemHandler',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await redeemHandler.getAddress(),
      },
      {
        RedeemOrder: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      redeemOrder2
    );
    // Ensure user has sufficient allowance for the second redeem
    await usn
      .connect(user)
      .approve(redeemHandler.getAddress(), redeemOrder2.usnAmount);

    // Mint additional collateral to the RedeemHandler for the second redeem
    await mockCollateral.mint(
      redeemHandler.getAddress(),
      redeemOrder2.collateralAmount
    );

    // Second redeem should fail due to limit
    await expect(
      redeemHandler.connect(owner).redeem(redeemOrder2, signature2)
    ).to.be.revertedWithCustomError(redeemHandler, 'RedeemLimitExceeded');
  });

  it('should allow redeeming in a new block after limit reset', async () => {
    const redeemAmount = ethers.parseUnits('500000', 18);
    const collateralAmount = ethers.parseUnits('500000', 18);
    const deadline = Math.floor(Date.now() / 1000) + 3600 * 100;

    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: redeemAmount,
      collateralAmount: collateralAmount,
      expiry: deadline,
      nonce: 10000,
    };

    const domain = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
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

    const signature = await user.signTypedData(domain, types, redeemOrder);

    await redeemHandler.grantRole(
      await redeemHandler.BURNER_ROLE(),
      owner.address
    );
    // setAdmin owner
    await usn.setAdmin(await owner.getAddress());
    await usn.mint(user.address, redeemAmount * 2n);
    await usn
      .connect(user)
      .approve(redeemHandler.getAddress(), redeemAmount * 2n);
    await mockCollateral.mint(
      redeemHandler.getAddress(),
      collateralAmount * 2n
    );

    // First redeem
    await expect(redeemHandler.connect(owner).redeem(redeemOrder, signature))
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );

    // Simulate moving to the next block
    await ethers.provider.send('evm_mine', []);

    // Create a new order with a different nonce for the second redeem
    const secondRedeemOrder = {
      ...redeemOrder,
      nonce: 10001,
    };

    const secondSignature = await user.signTypedData(
      domain,
      types,
      secondRedeemOrder
    );

    // Second redeem in a new block should succeed
    await expect(
      redeemHandler.connect(owner).redeem(secondRedeemOrder, secondSignature)
    )
      .to.emit(redeemHandler, 'Redeemed')
      .withArgs(
        user.address,
        await mockCollateral.getAddress(),
        redeemAmount,
        collateralAmount
      );
  });

  it('should allow admin to update redeem limit per block', async () => {
    const newLimit = ethers.parseUnits('2000000', 18);
    await expect(redeemHandler.connect(owner).setRedeemLimitPerBlock(newLimit))
      .to.emit(redeemHandler, 'RedeemLimitPerBlockUpdated')
      .withArgs(newLimit);

    expect(await redeemHandler.redeemLimitPerBlock()).to.equal(newLimit);
  });

  it('should allow admin to rescue ERC20 tokens', async () => {
    const rescueAmount = ethers.parseUnits('1000', 18);
    await mockCollateral.mint(redeemHandler.getAddress(), rescueAmount);

    const initialBalance = await mockCollateral.balanceOf(owner.address);

    await expect(
      redeemHandler
        .connect(owner)
        .rescueERC20(mockCollateral.getAddress(), rescueAmount)
    )
      .to.emit(mockCollateral, 'Transfer')
      .withArgs(redeemHandler.getAddress(), owner.address, rescueAmount);

    const finalBalance = await mockCollateral.balanceOf(owner.address);
    expect(finalBalance - initialBalance).to.equal(rescueAmount);
  });

  it('should not allow non-admin to rescue ERC20 tokens', async () => {
    const rescueAmount = ethers.parseUnits('1000', 18);
    await mockCollateral.mint(redeemHandler.getAddress(), rescueAmount);

    await expect(
      redeemHandler
        .connect(user)
        .rescueERC20(mockCollateral.getAddress(), rescueAmount)
    ).to.be.revertedWithCustomError(
      redeemHandler,
      'AccessControlUnauthorizedAccount'
    );
  });

  it('should correctly hash and encode redeem orders', async () => {
    const order = {
      message: `You are signing a request to redeem ${ethers.parseUnits('1000', 18)} USN for ${ethers.parseUnits('1000', 18)} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      usnAmount: ethers.parseUnits('1000', 18),
      collateralAmount: ethers.parseUnits('1000', 18),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      nonce: 1000,
    };

    const encodedOrder = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'string',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
      ],
      [
        order.message,
        order.user,
        order.collateralAddress,
        order.collateralAmount,
        order.usnAmount,
        order.expiry,
        order.nonce,
      ]
    );
    const hashedOrder = await redeemHandler.hashOrder(order);

    expect(encodedOrder).to.not.be.empty;
    expect(hashedOrder).to.not.be.empty;

    // Verify that the hash is correct by reconstructing it
    const domainSeparator = {
      name: 'RedeemHandler',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await redeemHandler.getAddress(),
    };

    const REDEEM_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes(
        'RedeemOrder(string message,address user,address collateralAddress,uint256 collateralAmount,uint256 usnAmount,uint256 expiry,uint256 nonce)'
      )
    );

    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'bytes32',
        'bytes32',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
      ],
      [
        REDEEM_TYPEHASH,
        ethers.keccak256(ethers.toUtf8Bytes(order.message)),
        order.user,
        order.collateralAddress,
        order.collateralAmount,
        order.usnAmount,
        order.expiry,
        order.nonce,
      ]
    );

    const domainSeparatorHash =
      ethers.TypedDataEncoder.hashDomain(domainSeparator);

    const reconstructedHash = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('\x19\x01'),
        domainSeparatorHash,
        ethers.keccak256(encodedData),
      ])
    );

    expect(hashedOrder).to.equal(reconstructedHash);
  });

  it('should revert when trying to redeem with an expired signature', async () => {
    const redeemAmount = ethers.parseUnits('1000', 18);
    const collateralAmount = ethers.parseUnits('1000', 18);
    const expiredDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    const redeemOrder = {
      message: `You are signing a request to redeem ${redeemAmount} USN for ${collateralAmount} MCL.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: collateralAmount,
      usnAmount: redeemAmount,
      expiry: expiredDeadline,
      nonce: 1000000,
    };

    const signature = await user.signTypedData(
      {
        name: 'RedeemHandler',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await redeemHandler.getAddress(),
      },
      {
        RedeemOrder: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      redeemOrder
    );

    await expect(
      redeemHandler.connect(owner).redeem(redeemOrder, signature)
    ).to.be.revertedWithCustomError(redeemHandler, 'SignatureExpired');
  });
});
