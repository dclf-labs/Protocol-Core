import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';
import {
  USN,
  MinterHandlerV2,
  StakingVault,
  MockERC20,
} from '../typechain-types';

describe('USNStakingVault', function () {
  let USN: USN;
  let MinterHandlerV2: MinterHandlerV2;
  let StakingVault: StakingVault;
  let mockCollateral: MockERC20;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let rebaseManager: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let externalUser: HardhatEthersSigner;
  let blacklistManager: HardhatEthersSigner;
  let endpointV2Mock: Contract;

  const initialMint = ethers.parseUnits('1000000', 18);
  const stakeAmount = ethers.parseUnits('10000', 18);
  const rebaseAmount = ethers.parseUnits('1000', 18);

  beforeEach(async function () {
    [
      owner,
      user1,
      user2,
      rebaseManager,
      minter,
      externalUser,
      blacklistManager,
    ] = await ethers.getSigners();

    // Deploy mock LayerZero endpoint
    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5432);

    const USNFactory = await ethers.getContractFactory('USN');
    USN = await USNFactory.deploy(endpointV2Mock.target);
    expect(await USN.owner()).to.equal(await owner.getAddress());
    await USN.enablePermissionless();
    const MinterHandlerFactory =
      await ethers.getContractFactory('MinterHandlerV2');
    MinterHandlerV2 = await MinterHandlerFactory.deploy(await USN.getAddress());

    const StakingVaultFactory = await ethers.getContractFactory('StakingVault');
    StakingVault = await StakingVaultFactory.deploy(
      await USN.getAddress(),
      'Staked USN',
      'sUSN'
    );

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockCollateral = await MockERC20Factory.deploy('Mock Collateral', 'MCOL');

    // Set up roles and permissions
    await USN.setAdmin(await MinterHandlerV2.getAddress());
    await MinterHandlerV2.grantRole(
      await MinterHandlerV2.MINTER_ROLE(),
      await minter.getAddress()
    );
    await MinterHandlerV2.addWhitelistedUser(await user1.getAddress());
    await MinterHandlerV2.addWhitelistedUser(await user2.getAddress());
    await MinterHandlerV2.addWhitelistedUser(await rebaseManager.getAddress());
    await MinterHandlerV2.addWhitelistedCollateral(
      await mockCollateral.getAddress()
    );
    await StakingVault.setRebaseManager(await rebaseManager.getAddress());
    await StakingVault.grantRole(
      await StakingVault.BLACKLIST_MANAGER_ROLE(),
      await blacklistManager.getAddress()
    );

    // Mint initial USN for users
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiry = currentTimestamp + 360000; // 100 hours from now
    const nonce = 1;

    for (const user of [user1, user2, rebaseManager]) {
      const userAddress = await user.getAddress();
      const order = {
        message: `You are signing a request to mint ${initialMint} USN using ${initialMint} MCOL as collateral.`,
        user: userAddress,
        collateralAmount: initialMint,
        usnAmount: initialMint,
        nonce: nonce,
        expiry: expiry,
        collateralAddress: await mockCollateral.getAddress(),
      };

      const domain = {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await MinterHandlerV2.getAddress(),
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
      MinterHandlerV2.setCustodialWallet(await StakingVault.getAddress());
      // Mint collateral to user
      await mockCollateral.mint(userAddress, initialMint);

      // Approve MinterHandlerV2 to spend collateral
      await mockCollateral
        .connect(user)
        .approve(await MinterHandlerV2.getAddress(), initialMint);

      // Mint USN
      await MinterHandlerV2.connect(minter).mint(order, signature);
    }

    // Approve StakingVault to spend USN
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );
    await USN.connect(user2).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );
    await USN.connect(rebaseManager).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );
  });

  it('should allow staking USN and minting shares', async function () {
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    const shares = await StakingVault.balanceOf(await user1.getAddress());
    expect(shares).to.equal(stakeAmount);

    const assets = await StakingVault.totalAssets();
    expect(assets).to.equal(stakeAmount);

    // Test ERC20 sUSN properties
    expect(await StakingVault.name()).to.equal('Staked USN');
    expect(await StakingVault.symbol()).to.equal('sUSN');
    expect(await StakingVault.decimals()).to.equal(18);
  });

  it('should mint correct amount of sUSN when depositing USN', async function () {
    const initialBalance = await StakingVault.balanceOf(
      await user1.getAddress()
    );
    expect(initialBalance).to.equal(0);

    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    const newBalance = await StakingVault.balanceOf(await user1.getAddress());
    expect(newBalance).to.equal(stakeAmount);

    // Test that the total supply of sUSN has increased
    expect(await StakingVault.totalSupply()).to.equal(stakeAmount);
  });

  it('should allow transfer of sUSN tokens', async function () {
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    const transferAmount = ethers.parseUnits('5000', 18);
    await StakingVault.connect(user1).transfer(
      await user2.getAddress(),
      transferAmount
    );

    expect(await StakingVault.balanceOf(await user1.getAddress())).to.equal(
      stakeAmount - transferAmount
    );
    expect(await StakingVault.balanceOf(await user2.getAddress())).to.equal(
      transferAmount
    );
  });

  it('should reflect rebase in withdrawals', async function () {
    // Stake USN
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );
    //get convertToAssets
    const assets = await StakingVault.convertToAssets(stakeAmount);

    // Perform rebase
    await StakingVault.connect(rebaseManager).rebase(rebaseAmount);

    //Check if new convertToAssets is greater than before
    const newAssets = await StakingVault.convertToAssets(stakeAmount);
    expect(newAssets).to.be.greaterThan(assets);
    //ADMIN should set period
    await expect(
      StakingVault.setWithdrawPeriod(0)
    ).to.be.revertedWithCustomError(StakingVault, 'CannotSetZero');
    await StakingVault.setWithdrawPeriod(1);

    // Calculate expected assets after rebase
    const expectedAssets = stakeAmount + rebaseAmount;

    // Get staking vault balance of shares for user1
    const userShares = await StakingVault.balanceOf(await user1.getAddress());
    expect(userShares).to.equal(stakeAmount);

    //WithdrawDemand
    await StakingVault.connect(user1).createWithdrawalDemand(userShares, true);
    // Verify total assets in vault
    expect(await StakingVault.totalAssets()).to.equal(expectedAssets);
    //Balance USN Before withdrawal
    const balanceUsnBefore = await USN.balanceOf(await user1.getAddress());
    //Balance sUSN before
    const balanceSUsnBefore = await StakingVault.balanceOf(
      await user1.getAddress()
    );
    // Redeem user shares
    await StakingVault.connect(user1).redeem(
      userShares,
      await user1.getAddress(),
      await user1.getAddress()
    );
    //Balance USN After withdrawal
    const balanceUsnAfter = await USN.balanceOf(await user1.getAddress());
    //Balance sUSN after
    const balanceSUsnAfter = await StakingVault.balanceOf(
      await user1.getAddress()
    );
    //Check if balance sUSN before is greater than after
    expect(balanceSUsnBefore).to.be.greaterThan(balanceSUsnAfter);

    //Check if balance sUSN to be 0
    expect(balanceSUsnAfter).to.equal(0);

    expect(balanceUsnAfter).to.equal(balanceUsnBefore + newAssets);
    expect(balanceUsnAfter).to.be.greaterThan(balanceUsnBefore);
  });

  it('should enforce withdraw period', async function () {
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );
    //ADMIN should set period
    await StakingVault.setWithdrawPeriod(86400);
    //Call for withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      stakeAmount,
      false
    );

    // Try to withdraw immediately (should fail)
    await expect(
      StakingVault.connect(user1).withdraw(
        stakeAmount,
        await user1.getAddress(),
        await user1.getAddress()
      )
    ).to.be.revertedWithCustomError(StakingVault, 'WithdrawPeriodNotElapsed');

    // Fast forward time
    await ethers.provider.send('evm_increaseTime', [86400]); // 1 day
    await ethers.provider.send('evm_mine', []);

    // Withdraw should now succeed
    await StakingVault.connect(user1).withdraw(
      stakeAmount,
      await user1.getAddress(),
      await user1.getAddress()
    );

    expect(await USN.balanceOf(await user1.getAddress())).to.equal(initialMint);
  });

  it('should not allow external user to redeem on behalf of withdrawal demand owner', async function () {
    // Stake USN
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Set withdraw period to 0 for simplicity
    await expect(
      StakingVault.setWithdrawPeriod(0)
    ).to.be.revertedWithCustomError(StakingVault, 'CannotSetZero');
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      stakeAmount,
      false
    );

    // Calculate shares
    const shares = await StakingVault.balanceOf(await user1.getAddress());

    // External user connot redeem for another user
    await expect(
      StakingVault.connect(externalUser).redeem(
        shares,
        await externalUser.getAddress(),
        await user1.getAddress()
      )
    ).to.be.revertedWithCustomError(StakingVault, 'Unauthorized');

    // Ensure user1's balance hasn't changed
    expect(await StakingVault.balanceOf(await user1.getAddress())).to.equal(
      shares
    );
  });

  it('should not allow external user to withdraw on behalf of withdrawal demand owner', async function () {
    // Stake USN
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Set withdraw period to 0 for simplicity
    await expect(
      StakingVault.setWithdrawPeriod(0)
    ).to.be.revertedWithCustomError(StakingVault, 'CannotSetZero');
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      stakeAmount,
      false
    );

    // External user tries to withdraw in behalf of someone else
    await expect(
      StakingVault.connect(externalUser).withdraw(
        stakeAmount,
        await externalUser.getAddress(),
        await user1.getAddress()
      )
    ).to.be.revertedWithCustomError(StakingVault, 'Unauthorized');

    // Ensure user1's balance hasn't changed
    expect(await StakingVault.balanceOf(await user1.getAddress())).to.equal(
      stakeAmount
    );
  });

  it('should not allow external user to withdraw on behalf of withdrawal demand owner when approved', async function () {
    // Stake USN
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Set withdraw period to 0 for simplicity
    await expect(
      StakingVault.setWithdrawPeriod(0)
    ).to.be.revertedWithCustomError(StakingVault, 'CannotSetZero');
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      stakeAmount,
      false
    );

    // User1 approves external user
    await StakingVault.connect(user1).approve(
      await externalUser.getAddress(),
      stakeAmount
    );

    // External user tries to withdraw on behalf of user1
    await expect(
      StakingVault.connect(externalUser).withdraw(
        stakeAmount,
        await user1.getAddress(),
        await user1.getAddress()
      )
    ).to.be.revertedWithCustomError(StakingVault, 'Unauthorized');

    // Ensure user1's balance in StakingVault hasn't changed
    expect(await StakingVault.balanceOf(await user1.getAddress())).to.equal(
      stakeAmount
    );

    // Ensure user1's USN balance hasn't changed
    expect(await USN.balanceOf(await user1.getAddress())).to.equal(
      initialMint - stakeAmount
    );
  });

  it('should not allow blacklisted user to stake', async function () {
    // Blacklist user1
    await StakingVault.connect(blacklistManager).blacklistAccount(
      await user1.getAddress()
    );

    // Try to stake USN (should fail)
    await expect(
      StakingVault.connect(user1).deposit(stakeAmount, await user1.getAddress())
    ).to.be.revertedWithCustomError(StakingVault, 'BlacklistedAddress');
  });

  it('should not allow blacklisted user to withdraw', async function () {
    // Stake USN
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Set withdraw period to 0 for simplicity
    await expect(
      StakingVault.setWithdrawPeriod(0)
    ).to.be.revertedWithCustomError(StakingVault, 'CannotSetZero');
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      stakeAmount,
      false
    );

    // Blacklist user1
    await StakingVault.connect(blacklistManager).blacklistAccount(
      await user1.getAddress()
    );

    // Try to withdraw (should fail)
    await expect(
      StakingVault.connect(user1).withdraw(
        stakeAmount,
        await user1.getAddress(),
        await user1.getAddress()
      )
    ).to.be.revertedWithCustomError(StakingVault, 'BlacklistedAddress');
  });

  it('should not allow transfer to blacklisted address', async function () {
    // Stake USN with user1
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Blacklist user2
    await StakingVault.connect(blacklistManager).blacklistAccount(
      await user2.getAddress()
    );

    // Try to transfer from user1 to blacklisted user2 (should fail)
    await expect(
      StakingVault.connect(user1).transfer(
        await user2.getAddress(),
        stakeAmount
      )
    ).to.be.revertedWithCustomError(StakingVault, 'BlacklistedAddress');
  });

  it('should allow transfer after unblacklisting', async function () {
    // Stake USN with user1
    await StakingVault.connect(user1).deposit(
      stakeAmount,
      await user1.getAddress()
    );

    // Blacklist user2
    await StakingVault.connect(blacklistManager).blacklistAccount(
      await user2.getAddress()
    );
    // Transfer should revert
    await expect(
      StakingVault.connect(user1).transfer(
        await user2.getAddress(),
        stakeAmount
      )
    ).to.be.revertedWithCustomError(StakingVault, 'BlacklistedAddress');

    // Unblacklist user2
    await StakingVault.connect(blacklistManager).unblacklistAccount(
      await user2.getAddress()
    );

    // Transfer should now succeed
    await expect(
      StakingVault.connect(user1).transfer(
        await user2.getAddress(),
        stakeAmount
      )
    ).to.not.be.reverted;

    // Check balances
    expect(await StakingVault.balanceOf(await user2.getAddress())).to.equal(
      stakeAmount
    );
    expect(await StakingVault.balanceOf(await user1.getAddress())).to.equal(0);
  });

  it('should allow admin to rescue tokens', async function () {
    const TestTokenFactory = await ethers.getContractFactory('MockERC20'); // Using USN as a test token
    const testToken = await TestTokenFactory.deploy('TestToken', 'TEST');

    const rescueAmount = ethers.parseUnits('1000', 18);

    // Transfer some test tokens to the StakingVault
    await testToken.mint(await StakingVault.getAddress(), rescueAmount);

    const initialBalance = await testToken.balanceOf(await owner.getAddress());

    // Rescue tokens
    await expect(
      StakingVault.connect(owner).rescueToken(
        await testToken.getAddress(),
        await owner.getAddress(),
        rescueAmount
      )
    ).to.not.be.reverted;

    // Check balances
    expect(await testToken.balanceOf(await owner.getAddress())).to.equal(
      initialBalance + rescueAmount
    );
    expect(await testToken.balanceOf(await StakingVault.getAddress())).to.equal(
      0
    );
  });

  it('should not allow rescuing vault token or underlying asset', async function () {
    // Attempt to rescue vault token (should fail)
    await expect(
      StakingVault.connect(owner).rescueToken(
        await StakingVault.getAddress(),
        await owner.getAddress(),
        stakeAmount
      )
    ).to.be.revertedWithCustomError(StakingVault, 'CannotRescueVaultToken');

    // Attempt to rescue underlying asset (should fail)
    await expect(
      StakingVault.connect(owner).rescueToken(
        await USN.getAddress(),
        await owner.getAddress(),
        stakeAmount
      )
    ).to.be.revertedWithCustomError(
      StakingVault,
      'CannotRescueUnderlyingAsset'
    );
  });
  it('should allow depositWithPermit', async function () {
    const amount = ethers.parseUnits('1000', 18);
    const deadline = Math.floor(Date.now() / 1000) + 3600 * 100; // 100 hour from now
    const nonce = await USN.nonces(user1.address);

    const domain = {
      name: await USN.name(),
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await USN.getAddress(),
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const values = {
      owner: user1.address,
      spender: await StakingVault.getAddress(),
      value: amount,
      nonce: nonce,
      deadline: deadline,
    };

    const signature = await user1.signTypedData(domain, types, values);
    const { v, r, s } = ethers.Signature.from(signature);

    const initialBalance = await StakingVault.balanceOf(user1.address);
    await expect(
      StakingVault.connect(user1).depositWithPermit(
        amount,
        user1.address,
        deadline,
        v,
        r,
        s
      )
    )
      .to.emit(StakingVault, 'Deposit')
      .withArgs(user1.address, user1.address, amount, amount);

    const finalBalance = await StakingVault.balanceOf(user1.address);
    expect(finalBalance).to.equal(initialBalance + amount);
  });

  it('should allow rebaseWithPermit', async function () {
    const amount = ethers.parseUnits('1000', 18);
    const deadline = Math.floor(Date.now() / 1000) + 3600 * 100; // 100 hour from now
    const nonce = await USN.nonces(rebaseManager.address);

    const domain = {
      name: await USN.name(),
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await USN.getAddress(),
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const values = {
      owner: rebaseManager.address,
      spender: await StakingVault.getAddress(),
      value: amount,
      nonce: nonce,
      deadline: deadline,
    };

    const signature = await rebaseManager.signTypedData(domain, types, values);
    const { v, r, s } = ethers.Signature.from(signature);

    const initialTotalSupply = await StakingVault.totalSupply();
    await expect(
      StakingVault.connect(rebaseManager).rebaseWithPermit(
        amount,
        deadline,
        v,
        r,
        s
      )
    )
      .to.emit(StakingVault, 'Rebase')
      .withArgs(initialTotalSupply + amount);

    // Shouldn't change the total supply
    const finalTotalSupply = await StakingVault.totalSupply();
    expect(finalTotalSupply).to.equal(initialTotalSupply);
  });
  it('should allow depositWithSlippageCheck', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const minSharesOut = ethers.parseUnits('990', 18); // Allowing for 1% slippage

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );

    const initialBalance = await StakingVault.balanceOf(user1.address);

    await expect(
      StakingVault.connect(user1).depositWithSlippageCheck(
        depositAmount,
        user1.address,
        minSharesOut
      )
    )
      .to.emit(StakingVault, 'Deposit')
      .withArgs(
        user1.address,
        user1.address,
        depositAmount,
        await StakingVault.previewDeposit(depositAmount)
      );

    const finalBalance = await StakingVault.balanceOf(user1.address);
    expect(finalBalance).to.be.gte(initialBalance + minSharesOut);
  });

  it('should revert depositWithSlippageCheck if slippage is exceeded', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const minSharesOut = ethers.parseUnits('1001', 18); // Unrealistic expectation

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );

    await expect(
      StakingVault.connect(user1).depositWithSlippageCheck(
        depositAmount,
        user1.address,
        minSharesOut
      )
    ).to.be.revertedWithCustomError(StakingVault, 'SlippageExceeded');
  });
  it('should allow withdrawWithSlippageCheck', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const withdrawAmount = ethers.parseUnits('500', 18);

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand with the exact amount of shares to be withdrawn
    const sharesToWithdraw = (await StakingVault.balanceOf(user1)) / 2n;
    await StakingVault.connect(user1).createWithdrawalDemand(
      sharesToWithdraw,
      true
    );

    const initialBalance = await USN.balanceOf(user1.address);

    await expect(
      StakingVault.connect(user1).withdrawWithSlippageCheck(
        withdrawAmount,
        user1.address,
        user1.address,
        sharesToWithdraw + (2n * sharesToWithdraw) / 100n //2% slippage
      )
    )
      .to.emit(StakingVault, 'Withdraw')
      .withArgs(
        user1.address,
        user1.address,
        user1.address,
        withdrawAmount,
        sharesToWithdraw
      );

    const finalBalance = await USN.balanceOf(user1.address);
    expect(finalBalance).to.equal(initialBalance + withdrawAmount);
  });

  it('should revert withdrawWithSlippageCheck if slippage is exceeded', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const withdrawAmount = ethers.parseUnits('500', 18);
    const maxSharesBurned = ethers.parseUnits('490', 18); // Unrealistic expectation

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      withdrawAmount,
      true
    );

    await expect(
      StakingVault.connect(user1).withdrawWithSlippageCheck(
        withdrawAmount,
        user1.address,
        user1.address,
        maxSharesBurned
      )
    ).to.be.revertedWithCustomError(StakingVault, 'SlippageExceeded');
  });

  it('should allow redeemWithSlippageCheck', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const redeemShares = ethers.parseUnits('500', 18);
    const minAssetsOut = ethers.parseUnits('490', 18); // Allowing for 2% slippage

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      redeemShares,
      true
    );

    const initialBalance = await USN.balanceOf(user1.address);

    await expect(
      StakingVault.connect(user1).redeemWithSlippageCheck(
        redeemShares,
        user1.address,
        user1.address,
        minAssetsOut
      )
    )
      .to.emit(StakingVault, 'Withdraw')
      .withArgs(
        user1.address,
        user1.address,
        user1.address,
        await StakingVault.previewRedeem(redeemShares),
        redeemShares
      );

    const finalBalance = await USN.balanceOf(user1.address);
    expect(finalBalance).to.be.gte(initialBalance + minAssetsOut);
  });

  it('should revert redeemWithSlippageCheck if slippage is exceeded', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const redeemShares = ethers.parseUnits('500', 18);
    const minAssetsOut = ethers.parseUnits('510', 18); // Unrealistic expectation

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      redeemShares,
      true
    );

    await expect(
      StakingVault.connect(user1).redeemWithSlippageCheck(
        redeemShares,
        user1.address,
        user1.address,
        minAssetsOut
      )
    ).to.be.revertedWithCustomError(StakingVault, 'SlippageExceeded');
  });
  it('should successfully redeemWithSlippageCheck when slippage is within limits', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const redeemShares = ethers.parseUnits('500', 18);
    const minAssetsOut = ethers.parseUnits('490', 18); // Slightly lower than expected to account for potential slippage

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      redeemShares,
      true
    );

    const initialBalance = await USN.balanceOf(user1.address);

    await expect(
      StakingVault.connect(user1).redeemWithSlippageCheck(
        redeemShares,
        user1.address,
        user1.address,
        minAssetsOut
      )
    ).to.emit(StakingVault, 'Withdraw');

    const finalBalance = await USN.balanceOf(user1.address);
    expect(finalBalance).to.be.gte(initialBalance + minAssetsOut);
  });

  it('should revert redeemWithSlippageCheck if withdrawal period has not passed', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const redeemShares = ethers.parseUnits('500', 18);
    const minAssetsOut = ethers.parseUnits('490', 18);

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    await StakingVault.setWithdrawPeriod(10);
    // Create withdrawal demand
    await StakingVault.connect(user1).createWithdrawalDemand(
      redeemShares,
      true
    );

    await expect(
      StakingVault.connect(user1).redeemWithSlippageCheck(
        redeemShares,
        user1.address,
        user1.address,
        minAssetsOut
      )
    ).to.be.revertedWithCustomError(StakingVault, 'WithdrawPeriodNotElapsed');
  });

  it('should revert redeemWithSlippageCheck if user has no withdrawal demand', async function () {
    const depositAmount = ethers.parseUnits('1000', 18);
    const redeemShares = ethers.parseUnits('500', 18);
    const minAssetsOut = ethers.parseUnits('490', 18);

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, depositAmount);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      depositAmount
    );
    await StakingVault.connect(user1).deposit(depositAmount, user1.address);

    // Set withdraw period to 1 for testing
    await StakingVault.setWithdrawPeriod(1);

    // Do not create a withdrawal demand

    await expect(
      StakingVault.connect(user1).redeemWithSlippageCheck(
        redeemShares,
        user1.address,
        user1.address,
        minAssetsOut
      )
    ).to.be.revertedWithCustomError(StakingVault, 'RedemptionExceedsDemand');
  });
  it('should allow mintWithSlippageCheck', async function () {
    const mintShares = ethers.parseUnits('1000', 18);
    const maxAssets = ethers.parseUnits('1010', 18); // Allowing for 1% slippage

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, maxAssets);
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      maxAssets
    );

    const initialBalance = await StakingVault.balanceOf(user1.address);

    await expect(
      StakingVault.connect(user1).mintWithSlippageCheck(
        mintShares,
        user1.address,
        maxAssets
      )
    )
      .to.emit(StakingVault, 'Deposit')
      .withArgs(
        user1.address,
        user1.address,
        await StakingVault.previewMint(mintShares),
        mintShares
      );

    const finalBalance = await StakingVault.balanceOf(user1.address);
    expect(finalBalance).to.equal(initialBalance + mintShares);
  });

  it('should revert mintWithSlippageCheck if slippage is exceeded', async function () {
    const mintShares = ethers.parseUnits('1000', 18);
    const maxAssets = ethers.parseUnits('990', 18); // Unrealistic expectation (too low)

    await USN.setAdmin(owner.address);
    await USN.mint(user1.address, ethers.parseUnits('1100', 18)); // Mint more than maxAssets
    await USN.connect(user1).approve(
      await StakingVault.getAddress(),
      ethers.parseUnits('1100', 18)
    );

    await expect(
      StakingVault.connect(user1).mintWithSlippageCheck(
        mintShares,
        user1.address,
        maxAssets
      )
    ).to.be.revertedWithCustomError(StakingVault, 'SlippageExceeded');
  });
});
