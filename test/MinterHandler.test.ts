import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';
import { USN, MinterHandlerV2, MockERC20 } from '../typechain-types';
describe('MinterHandlerV2', () => {
  let usnToken: USN;
  let minterHandler: MinterHandlerV2;
  let mockCollateral: MockERC20;
  let owner: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let nonWhitelistedUser: HardhatEthersSigner;
  let endpointV2Mock: Contract;

  beforeEach(async () => {
    [owner, minter, user, nonWhitelistedUser] = await ethers.getSigners();

    // Deploy mock LayerZero endpoint
    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5340);

    const USNFactory = await ethers.getContractFactory('USN');
    usnToken = await USNFactory.deploy(endpointV2Mock.target);
    expect(await usnToken.owner()).to.equal(owner.address);
    await usnToken.enablePermissionless();
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockCollateral = await MockERC20Factory.deploy('Mock Collateral', 'MCL');

    const MinterHandlerFactory =
      await ethers.getContractFactory('MinterHandlerV2');
    minterHandler = await MinterHandlerFactory.deploy(
      await usnToken.getAddress()
    );
    // Set custodial wallet
    await minterHandler.setCustodialWallet(await minterHandler.getAddress());

    // Set MinterHandlerV2 as the admin of USN
    await usnToken.setAdmin(await minterHandler.getAddress());

    // Add mock collateral to whitelist
    await minterHandler.addWhitelistedCollateral(
      await mockCollateral.getAddress()
    );
  });

  it('should set MinterHandlerV2 as the admin of USN', async () => {
    expect(await usnToken.admin()).to.equal(await minterHandler.getAddress());
  });

  it('should allow MinterHandlerV2 to mint USN tokens', async () => {
    const amount = ethers.parseUnits('100', 18);

    // Grant MINTER_ROLE to minter
    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );

    // Add user to whitelist
    await minterHandler.addWhitelistedUser(user.address);
    // Prepare mint parameters
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
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
    await mockCollateral.mint(await user.getAddress(), amount);

    // Should approve sufficient collateral
    await mockCollateral
      .connect(user)
      .approve(await minterHandler.getAddress(), amount);

    // Mint tokens
    await expect(minterHandler.connect(minter).mint(order, signature))
      .to.emit(usnToken, 'Transfer')
      .withArgs(ethers.ZeroAddress, user.address, amount);

    expect(await usnToken.balanceOf(user.address)).to.equal(amount);
  });

  it('should emit WhitelistedUserAdded event when adding a user', async () => {
    await expect(minterHandler.addWhitelistedUser(user.address))
      .to.emit(minterHandler, 'WhitelistedUserAdded')
      .withArgs(user.address);
  });

  it('should emit WhitelistedUserRemoved event when removing a user', async () => {
    await minterHandler.addWhitelistedUser(user.address);
    await expect(minterHandler.removeWhitelistedUser(user.address))
      .to.emit(minterHandler, 'WhitelistedUserRemoved')
      .withArgs(user.address);
  });

  it('should revert when non-minter tries to mint', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
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

    //Reverted with "AccessControl: account 0x... is missing role ..."
    await expect(minterHandler.connect(user).mint(order, signature)).to.be
      .reverted;
  });

  it('should revert when minting with expired signature', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
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

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);

    await expect(
      minterHandler.connect(minter).mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'SignatureExpired');
  });

  it('should revert when minting with non-whitelisted collateral', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonWhitelistedCollateral = ethers.Wallet.createRandom().address;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: nonWhitelistedCollateral,
      collateralAmount: amount,
      usnAmount: amount,
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

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);

    await expect(
      minterHandler.connect(minter).mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'CollateralNotWhitelisted');
  });

  it('should revert when minting twice with the same signature', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
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

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);
    await expect(
      minterHandler.addWhitelistedCollateral(await mockCollateral.getAddress())
    ).to.be.revertedWithCustomError(
      minterHandler,
      'CollateralAlreadyWhitelisted'
    );
    // Minter sends collateral to user
    await mockCollateral.mint(await user.getAddress(), amount);

    // Should approve sufficient collateral
    await mockCollateral
      .connect(user)
      .approve(await minterHandler.getAddress(), amount);

    // First mint should succeed
    await expect(minterHandler.connect(minter).mint(order, signature)).to.not.be
      .reverted;

    // Second mint with the same signature should fail
    await expect(
      minterHandler.connect(minter).mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'NonceAlreadyUsed');
  });
  //HERE

  it('should set custodial wallet', async () => {
    const newCustodialWallet = ethers.Wallet.createRandom().address;
    await expect(minterHandler.setCustodialWallet(newCustodialWallet))
      .to.emit(minterHandler, 'CustodialWalletSet')
      .withArgs(newCustodialWallet);
    expect(await minterHandler.custodialWallet()).to.equal(newCustodialWallet);
  });

  it('should revert when setting invalid custodial wallet', async () => {
    await expect(
      minterHandler.setCustodialWallet(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(minterHandler, 'ZeroAddress');
  });

  it('should add whitelisted collateral', async () => {
    const newCollateral = ethers.Wallet.createRandom().address;
    await expect(minterHandler.addWhitelistedCollateral(newCollateral))
      .to.emit(minterHandler, 'WhitelistedCollateralAdded')
      .withArgs(newCollateral);
    expect(await minterHandler.whitelistedCollaterals(newCollateral)).to.be
      .true;
  });

  it('should remove whitelisted collateral', async () => {
    await expect(
      minterHandler.removeWhitelistedCollateral(
        await mockCollateral.getAddress()
      )
    )
      .to.emit(minterHandler, 'WhitelistedCollateralRemoved')
      .withArgs(await mockCollateral.getAddress());
    expect(
      await minterHandler.whitelistedCollaterals(
        await mockCollateral.getAddress()
      )
    ).to.be.false;
  });

  it('should hash order correctly', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      expiry: expiry,
      nonce: nonce,
    };

    const hash = await minterHandler.hashOrder(order);
    expect(hash.length).to.be.equal(66);
  });

  it('should revert when non-admin tries to add whitelisted user', async () => {
    await expect(
      minterHandler.connect(user).addWhitelistedUser(nonWhitelistedUser.address)
    ).to.be.reverted;
  });

  it('should revert when non-admin tries to remove whitelisted user', async () => {
    await minterHandler.addWhitelistedUser(user.address);
    await expect(
      minterHandler.connect(user).removeWhitelistedUser(user.address)
    ).to.be.reverted;
  });
  it('should mint with EIP-1271 signature from a contract wallet', async () => {
    // Deploy a mock EIP-1271 contract wallet
    const MockEIP1271Wallet =
      await ethers.getContractFactory('MockEIP1271Wallet');
    const mockWallet = await MockEIP1271Wallet.deploy(owner.address);
    await mockWallet.waitForDeployment();
    const amount = ethers.parseUnits('100', 18);

    // Whitelist the mock wallet
    await minterHandler.addWhitelistedUser(await mockWallet.getAddress());
    // Mint collateral to the mock wallet
    await mockCollateral.mint(await mockWallet.getAddress(), amount);
    // Approve the mock wallet to spend the collateral
    await mockWallet.approve(
      await mockCollateral.getAddress(),
      await minterHandler.getAddress(),
      amount
    );
    // Prepare order data
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: await mockWallet.getAddress(),
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      expiry: expiry,
      nonce: nonce,
    };

    // Generate EIP-712 signature
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

    const signature = await owner.signTypedData(domain, types, order);

    // Set the mock wallet to return isValidSignature = true
    await mockWallet.setIsValidSignature(true);

    // Grant MINTER_ROLE to the test contract
    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      owner.address
    );

    // Mint tokens
    await expect(minterHandler.mint(order, signature))
      .to.emit(minterHandler, 'Mint')
      .withArgs(
        await mockWallet.getAddress(),
        amount,
        amount,
        await mockCollateral.getAddress()
      );

    // Verify minted amount
    expect(await usnToken.balanceOf(await mockWallet.getAddress())).to.equal(
      amount
    );
  });

  it('should revert minting with invalid EIP-1271 signature', async () => {
    // Deploy a mock EIP-1271 contract wallet
    const MockEIP1271Wallet =
      await ethers.getContractFactory('MockEIP1271Wallet');
    const mockWallet = await MockEIP1271Wallet.deploy(owner.address);
    await mockWallet.waitForDeployment();

    // Whitelist the mock wallet
    await minterHandler.addWhitelistedUser(await mockWallet.getAddress());

    // Prepare order data
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: await mockWallet.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
    };

    // Generate EIP-712 signature
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
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'usnAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'collateralAddress', type: 'address' },
      ],
    };

    const signature = await owner.signTypedData(domain, types, order);

    // Set the mock wallet to return isValidSignature = false
    await mockWallet.setIsValidSignature(false);

    // Grant MINTER_ROLE to the test contract
    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      owner.address
    );

    // Attempt to mint tokens (should revert)
    await expect(
      minterHandler.mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'InvalidSignature');
  });

  it('should revert when non-admin tries to add whitelisted collateral', async () => {
    const newCollateral = ethers.Wallet.createRandom().address;
    await expect(
      minterHandler.connect(user).addWhitelistedCollateral(newCollateral)
    ).to.be.reverted;
  });

  it('should revert when non-admin tries to remove whitelisted collateral', async () => {
    await expect(
      minterHandler
        .connect(user)
        .removeWhitelistedCollateral(await mockCollateral.getAddress())
    ).to.be.reverted;
  });

  it('should revert when minting with non-whitelisted user', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: nonWhitelistedUser.address,
      collateralAmount: amount,
      usnAmount: amount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
    };

    const signature = await nonWhitelistedUser.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'collateralAddress', type: 'address' },
        ],
      },
      order
    );

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );

    await expect(
      minterHandler.connect(minter).mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'UserNotWhitelisted');
  });
  it('should revert when minting with invalid signature', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAmount: amount,
      usnAmount: amount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
    };

    const invalidSignature = '0x' + '1'.repeat(130); // 65 bytes (130 hex characters) of '1's

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);
    await expect(
      minterHandler.connect(minter).mint(order, invalidSignature)
    ).to.be.revertedWithCustomError(minterHandler, 'ECDSAInvalidSignature');
  });

  it('should revert when minting with insufficient collateral', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      expiry: expiry,
      nonce: nonce,
    };

    const signature = await user.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      order
    );

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);

    // Don't mint any collateral tokens to the user
    await expect(minterHandler.connect(minter).mint(order, signature)).to.be
      .reverted; // ERC20: transfer amount exceeds balance
  });

  it('should respect the mint limit per block', async () => {
    const initialLimit = ethers.parseUnits('1000000', 18); // Default limit: 1 million USN
    expect(await minterHandler.mintLimitPerBlock()).to.equal(initialLimit);

    const amount = ethers.parseUnits('500000', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      expiry: expiry,
      nonce: nonce,
    };

    const signature = await user.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      order
    );

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);
    await mockCollateral.mint(user.address, amount);
    await mockCollateral
      .connect(user)
      .approve(minterHandler.getAddress(), amount);

    // First mint should succeed
    await expect(minterHandler.connect(minter).mint(order, signature)).to.not.be
      .reverted;
    const order2 = {
      message: `You are signing a request to mint ${amount * 3n} USN using ${amount * 3n} MCL as collateral.`,
      user: user.address,
      collateralAmount: amount * 3n,
      usnAmount: amount * 3n,
      nonce: nonce + 1,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
    };

    // Mint collateral to user
    await mockCollateral.mint(user.address, amount * 3n);

    // Approve again
    await mockCollateral
      .connect(user)
      .approve(minterHandler.getAddress(), amount * 3n);
    const signature2 = await user.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      order2
    );
    await expect(
      minterHandler.connect(minter).mint(order2, signature2)
    ).to.be.revertedWithCustomError(minterHandler, 'MintLimitExceeded');
  });

  it('should allow minting in a new block after limit reset', async () => {
    const amount = ethers.parseUnits('500000', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAddress: await mockCollateral.getAddress(),
      collateralAmount: amount,
      usnAmount: amount,
      expiry: expiry,
      nonce: nonce,
    };

    const signature = await user.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      order
    );

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);
    await mockCollateral.mint(user.address, amount * 2n);
    await mockCollateral
      .connect(user)
      .approve(minterHandler.getAddress(), amount * 2n);

    // First mint
    await expect(minterHandler.connect(minter).mint(order, signature)).to.not.be
      .reverted;

    // Simulate moving to the next block
    await ethers.provider.send('evm_mine', []);

    // Second mint in a new block should succeed
    const order2 = { ...order, nonce: 2 };
    const signature2 = await user.signTypedData(
      {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandler.getAddress(),
      },
      {
        Order: [
          { name: 'message', type: 'string' },
          { name: 'user', type: 'address' },
          { name: 'collateralAddress', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'usnAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      order2
    );

    await expect(minterHandler.connect(minter).mint(order2, signature2)).to.not
      .be.reverted;
  });

  it('should allow admin to update mint limit per block', async () => {
    const newLimit = ethers.parseUnits('2000000', 18);
    await expect(minterHandler.connect(owner).setMintLimitPerBlock(newLimit))
      .to.emit(minterHandler, 'MintLimitPerBlockUpdated')
      .withArgs(newLimit);

    expect(await minterHandler.mintLimitPerBlock()).to.equal(newLimit);
  });
  it('should not allow minting with 0 collateral or 0 USN amount for a user that is not the minter', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: user.address,
      collateralAmount: 0n,
      usnAmount: amount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
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
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'usnAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'collateralAddress', type: 'address' },
      ],
    };

    const signature = await user.signTypedData(domain, types, order);

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);
    // Mint should fail with 0 collateral amount
    await expect(
      minterHandler.connect(minter).mint(order, signature)
    ).to.be.revertedWithCustomError(minterHandler, 'ZeroAmount');

    // Verify that no tokens were minted
    expect(await usnToken.balanceOf(user.address)).to.equal(0);
  });

  it('should allow minting with 0 collateral for the minter', async () => {
    const amount = ethers.parseUnits('100', 18);
    const nonce = 2;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${amount} USN using ${amount} MCL as collateral.`,
      user: minter.address,
      collateralAmount: 0n,
      usnAmount: amount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
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

    const signature = await minter.signTypedData(domain, types, order);

    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(minter.address);

    // Mint should succeed with 0 collateral amount for the minter
    await expect(minterHandler.connect(minter).mint(order, signature)).to.not.be
      .reverted;

    // Verify that tokens were minted
    expect(await usnToken.balanceOf(minter.address)).to.equal(amount);
  });
  it('should revert when minting with more than 2% difference for a random user', async () => {
    const collateralAmount = ethers.parseUnits('100', 18);
    const usnAmount = ethers.parseUnits('103', 18); //3% more than collateral
    const nonce = 3;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const order = {
      message: `You are signing a request to mint ${usnAmount} USN using ${collateralAmount} MCL as collateral.`,
      user: user.address,
      collateralAmount: collateralAmount,
      usnAmount: usnAmount,
      nonce: nonce,
      expiry: expiry,
      collateralAddress: await mockCollateral.getAddress(),
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
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'usnAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'collateralAddress', type: 'address' },
      ],
    };
    await minterHandler.grantRole(
      await minterHandler.MINTER_ROLE(),
      minter.address
    );
    await minterHandler.addWhitelistedUser(user.address);

    const signature = await user.signTypedData(domain, types, order);

    // Mint collateral tokens to user
    await mockCollateral.mint(user.address, collateralAmount);

    // Approve collateral to minterHandler
    await mockCollateral
      .connect(user)
      .approve(await minterHandler.getAddress(), collateralAmount);

    // Attempt to mint should revert due to more than 10% difference
    await expect(minterHandler.connect(minter).mint(order, signature))
      .to.be.revertedWithCustomError(minterHandler, 'CollateralUsnMismatch')
      .withArgs(collateralAmount, usnAmount);

    // Verify that no tokens were minted
    expect(await usnToken.balanceOf(user.address)).to.equal(0);
  });
});
