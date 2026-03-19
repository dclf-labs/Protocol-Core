import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, ethers as hreEthers } from 'hardhat';
import { blacklistAccountInStakingVault } from '../scripts/jobs/blacklistSUSN';
import { blacklistAccountUSN } from '../scripts/jobs/blacklistUSN';
import { mintUSN } from '../scripts/jobs/mint';
import { rebaseStakingVault } from '../scripts/jobs/rebase';
import { redeemUSN } from '../scripts/jobs/redeem';

import {
  USN,
  MinterHandlerV2,
  MockERC20,
  StakingVault,
  EndpointV2Mock,
} from '../typechain-types';

describe('Scripts Tests', () => {
  let provider: ethers.Provider;
  let owner: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let usnContract: USN;
  let endpointV2Mock: EndpointV2Mock;
  let minterHandlerContract: MinterHandlerV2;
  let mockCollateral: MockERC20;
  let stakingVault: StakingVault;

  beforeEach(async () => {
    [owner, minter] = await hreEthers.getSigners();
    provider = owner.provider as ethers.Provider;
    // Deploy mock LayerZero endpoint
    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5340);

    const USNFactory = await hreEthers.getContractFactory('USN');
    usnContract = (await USNFactory.deploy(endpointV2Mock)) as USN;
    await usnContract.waitForDeployment();
    await usnContract.enablePermissionless();

    const MinterHandlerFactory =
      await hreEthers.getContractFactory('MinterHandlerV2');
    minterHandlerContract = (await MinterHandlerFactory.deploy(
      await usnContract.getAddress()
    )) as MinterHandlerV2;
    await minterHandlerContract.waitForDeployment();
    await minterHandlerContract.setCustodialWallet(
      await minterHandlerContract.getAddress()
    );
    const MockERC20Factory = await hreEthers.getContractFactory('MockERC20');
    mockCollateral = (await MockERC20Factory.deploy(
      'Mock Collateral',
      'MCOL'
    )) as MockERC20;
    await mockCollateral.waitForDeployment();
    // Mint mock collateral to minter
    await mockCollateral.mint(
      await minter.getAddress(),
      ethers.parseUnits('10000000', 18)
    );

    // Set up initial state for contracts
    await usnContract.setAdmin(await minterHandlerContract.getAddress());
    await minterHandlerContract.grantRole(
      await minterHandlerContract.MINTER_ROLE(),
      await owner.getAddress()
    );
    await minterHandlerContract.addWhitelistedCollateral(
      await mockCollateral.getAddress()
    );

    // Deploy StakingVault
    const stakingVaultFactory =
      await hreEthers.getContractFactory('StakingVault');
    stakingVault = (await stakingVaultFactory.deploy(
      await usnContract.getAddress(),
      'Staked USN',
      'SUSN'
    )) as StakingVault;
    await stakingVault.waitForDeployment();
  });

  describe('mintUSN', () => {
    it.skip('should mint USN tokens successfully', async () => {
      const recipient = await owner.getAddress();
      const initialBalance = await usnContract.balanceOf(recipient);
      const amount = '100';
      const nonce = 1;
      const expiry = Math.floor(Date.now() / 1000) + 3600; // expiry 1 hour from now
      const collateralAddress = await mockCollateral.getAddress();
      // Whitelist recipient in minterHandler
      await minterHandlerContract.addWhitelistedUser(recipient);

      const domain = {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await provider.getNetwork()).chainId,
        verifyingContract: await minterHandlerContract.getAddress(),
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

      const value = {
        message: 'Mint USN',
        user: recipient,
        collateralAmount: ethers.parseUnits(amount, 18),
        usnAmount: ethers.parseUnits(amount, 18),
        nonce,
        expiry,
        collateralAddress,
      };

      const signature = await owner.signTypedData(domain, types, value);

      const order = {
        message: 'Mint USN',
        user: recipient,
        collateralAmount: ethers.parseUnits(amount, 18).toString(),
        usnAmount: ethers.parseUnits(amount, 18).toString(),
        nonce,
        expiry,
        collateralAddress,
      };
      //Approve collateral to minterHandlerContract
      await mockCollateral.mint(
        await owner.getAddress(),
        ethers.parseUnits(amount, 18)
      );

      // Approve collateral to minterHandlerContract
      await mockCollateral.approve(
        await minterHandlerContract.getAddress(),
        ethers.parseUnits(amount, 18)
      );

      await mintUSN(
        'http://127.0.0.1:8545/',
        await minterHandlerContract.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        order,
        signature
      );

      const finalBalance = await usnContract.balanceOf(recipient);
      expect(finalBalance - initialBalance).to.equal(
        ethers.parseUnits(amount, 18)
      );
    });
  });

  describe('blacklistUSN', () => {
    it.skip('should blacklist an account successfully', async () => {
      const accountToBlacklist = await minter.getAddress();

      // Ensure the account is not blacklisted initially
      expect(await usnContract.blacklist(accountToBlacklist)).to.be.false;

      await blacklistAccountUSN(
        'http://127.0.0.1:8545/',
        await usnContract.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        accountToBlacklist
      );

      // Check if the account is now blacklisted
      expect(await usnContract.blacklist(accountToBlacklist)).to.be.true;

      // Try to transfer tokens from the blacklisted account (should fail)
      await expect(
        usnContract
          .connect(minter)
          .transfer(await owner.getAddress(), ethers.parseUnits('1', 18))
      ).to.be.revertedWithCustomError(usnContract, 'BlacklistedAddress');

      //Unblacklist Account
      await usnContract.unblacklistAccount(accountToBlacklist);
      // Check if the account is now unblacklisted
      expect(await usnContract.blacklist(accountToBlacklist)).to.be.false;
    });
  });

  describe('blacklistAccountInStakingVault', () => {
    it.skip('should blacklist an account in StakingVault successfully', async () => {
      const accountToBlacklist = await minter.getAddress();

      const domain = {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await provider.getNetwork()).chainId,
        verifyingContract: await minterHandlerContract.getAddress(),
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

      const value = {
        message: 'Mint USN',
        user: await minter.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18),
        usnAmount: ethers.parseUnits('10', 18),
        nonce: 1,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        collateralAddress: await mockCollateral.getAddress(),
      };

      const signature = await minter.signTypedData(domain, types, value);

      // Whitelist minter
      await minterHandlerContract.addWhitelistedUser(await minter.getAddress());

      // Mint USN to minter through minterHandler
      const order = {
        message: 'Mint USN',
        user: await minter.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18).toString(),
        usnAmount: ethers.parseUnits('10', 18).toString(),
        nonce: 1,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        collateralAddress: await mockCollateral.getAddress(),
      };
      // Mint collateral to minter
      await mockCollateral
        .connect(minter)
        .mint(await minter.getAddress(), ethers.parseUnits('10', 18));
      // Approve collateral to minterHandler
      await mockCollateral
        .connect(minter)
        .approve(
          await minterHandlerContract.getAddress(),
          ethers.parseUnits('10', 18)
        );
      console.log('Successfully approved collateral to minterHandler');
      await minterHandlerContract.connect(owner).mint(order, signature);
      console.log('Successfully minted USN to minter');
      //balance of Minter
      const minterBalance = await usnContract.balanceOf(
        await minter.getAddress()
      );
      expect(minterBalance).to.equal(ethers.parseUnits('10', 18));

      // Ensure the account is not blacklisted initially
      expect(await stakingVault.blacklist(accountToBlacklist)).to.be.false;

      // Grant BLACKLIST_MANAGER_ROLE to owner
      await stakingVault.grantRole(
        await stakingVault.BLACKLIST_MANAGER_ROLE(),
        await owner.getAddress()
      );

      await blacklistAccountInStakingVault(
        'http://127.0.0.1:8545/',
        await stakingVault.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        accountToBlacklist
      );

      // Check if the account is now blacklisted
      expect(await stakingVault.blacklist(accountToBlacklist)).to.be.true;
      // Approve stakingVault to transfer USN
      await usnContract
        .connect(minter)
        .approve(await stakingVault.getAddress(), ethers.parseUnits('10', 18));
      // Try to deposit tokens from the blacklisted account (should fail)
      await expect(
        stakingVault
          .connect(minter)
          .deposit(ethers.parseUnits('1', 18), await minter.getAddress())
      ).to.be.revertedWithCustomError(stakingVault, 'BlacklistedAddress');

      // Unblacklist Account
      await stakingVault.unblacklistAccount(accountToBlacklist);
      // Try to deposit tokens from the unblacklisted account (should succeed)
      await stakingVault
        .connect(minter)
        .deposit(ethers.parseUnits('1', 18), await minter.getAddress());
      // Check if the account is now unblacklisted
      expect(await stakingVault.blacklist(accountToBlacklist)).to.be.false;
    });
  });

  describe('rebase', () => {
    it.skip('should rebase StakingVault', async () => {
      // Give rebase permission to owner
      await stakingVault.setRebaseManager(owner.address);

      const domain = {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await provider.getNetwork()).chainId,
        verifyingContract: await minterHandlerContract.getAddress(),
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
      let expiry = Math.floor(Date.now() / 1000) + 3600;
      const value = {
        message: 'Mint USN',
        user: await minter.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18),
        usnAmount: ethers.parseUnits('10', 18),
        nonce: 2,
        expiry,
        collateralAddress: await mockCollateral.getAddress(),
      };

      const signature = await minter.signTypedData(domain, types, value);

      // Whitelist minter
      await minterHandlerContract.addWhitelistedUser(await minter.getAddress());

      // Mint USN to minter through minterHandler
      const order = {
        message: 'Mint USN',
        user: await minter.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18).toString(),
        usnAmount: ethers.parseUnits('10', 18).toString(),
        nonce: 2,
        expiry,
        collateralAddress: await mockCollateral.getAddress(),
      };
      // Mint collateral to minter
      await mockCollateral
        .connect(minter)
        .mint(await minter.getAddress(), ethers.parseUnits('10', 18));
      console.log('Successfully minted collateral to minter');
      // Approve collateral to minterHandler
      await mockCollateral
        .connect(minter)
        .approve(
          await minterHandlerContract.getAddress(),
          ethers.parseUnits('10', 18)
        );
      console.log('Minter - Successfully approved collateral to minterHandler');
      await minterHandlerContract.mint(order, signature);
      console.log('Successfully minted USN to minter');

      // Check balance of minter USN
      const minterUSNBalance = await usnContract.balanceOf(
        await minter.getAddress()
      );
      expect(minterUSNBalance).to.equal(ethers.parseUnits('10', 18));

      // approve stakingVault to transfer USN
      await usnContract
        .connect(minter)
        .approve(await stakingVault.getAddress(), ethers.parseUnits('10', 18));

      //Stake USN
      await stakingVault
        .connect(minter)
        .deposit(ethers.parseUnits('10', 18), await minter.getAddress());
      //Check sUSN balance of minter
      const minterSUSNBalance = await stakingVault.balanceOf(
        await minter.getAddress()
      );
      expect(minterSUSNBalance).to.equal(ethers.parseUnits('10', 18));
      let expiryOwner = Math.floor(Date.now() / 1000) + 3600;

      const value_owner = {
        message: 'Mint USN',
        user: await owner.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18),
        usnAmount: ethers.parseUnits('10', 18),
        nonce: 1,
        expiry: expiryOwner,
        collateralAddress: await mockCollateral.getAddress(),
      };
      const signature_owner = await owner.signTypedData(
        domain,
        types,
        value_owner
      );

      // Approve user owner
      await minterHandlerContract.addWhitelistedUser(await owner.getAddress());
      // Mint USN to owner
      const orderOwner = {
        message: 'Mint USN',
        user: await owner.getAddress(),
        collateralAmount: ethers.parseUnits('10', 18).toString(),
        usnAmount: ethers.parseUnits('10', 18).toString(),
        nonce: 1,
        expiry: expiryOwner,
        collateralAddress: await mockCollateral.getAddress(),
      };
      // Mint collateral to owner
      await mockCollateral
        .connect(owner)
        .mint(await owner.getAddress(), ethers.parseUnits('100', 18));

      await mockCollateral
        .connect(owner)
        .approve(
          await minterHandlerContract.getAddress(),
          ethers.parseUnits('100', 18)
        );
      console.log('Owner - Successfully approved collateral to minterHandler');
      await minterHandlerContract.mint(orderOwner, signature_owner);

      // Approve stakingVault to transfer USN
      await usnContract
        .connect(owner)
        .approve(await stakingVault.getAddress(), ethers.parseUnits('10', 18));

      // Rebase StakingVault
      await rebaseStakingVault(
        'http://127.0.0.1:8545/',
        await stakingVault.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ethers.parseUnits('10', 18).toString()
      );
      // Check balance of StakingVault after rebase
      const stakingVaultBalance = await usnContract.balanceOf(
        await stakingVault.getAddress()
      );
      console.log(
        'StakingVault balance after rebase:',
        ethers.formatUnits(stakingVaultBalance, 18)
      );
      expect(stakingVaultBalance).to.equal(
        ethers.parseUnits('20', 18),
        'StakingVault should have 10 USN after rebase'
      );

      // Get minter SUSN balance
      const minterSUSNBalanceAfter = await stakingVault.balanceOf(
        await minter.getAddress()
      );
      expect(minterSUSNBalanceAfter).to.equal(ethers.parseUnits('10', 18));

      // Set withdraw period to 0
      await stakingVault.setWithdrawPeriod(1);
      // Get current asset
      const share = await stakingVault.balanceOf(minter);
      // Mint start withdrawal demand
      await stakingVault.connect(minter).createWithdrawalDemand(share, true);
      // Check minter's USN balance before redeeming
      const minterUSNBalanceBefore = await usnContract.balanceOf(
        await minter.getAddress()
      );
      expect(minterUSNBalanceBefore).to.equal(0);
      // Minter redeem
      await stakingVault
        .connect(minter)
        .redeem(share, await minter.getAddress(), await minter.getAddress());
      // Check minter's sUSN balance after redeeming
      const minterSUSNBalanceAfterRedeem = await stakingVault.balanceOf(
        await minter.getAddress()
      );
      expect(minterSUSNBalanceAfterRedeem).to.equal(0);
      // Minter should have the amount staked + the rebase amount
      const minterUSNBalanceAfter = await usnContract.balanceOf(
        await minter.getAddress()
      );
      // Because of the precision of the ERC4626 : 19999999999999999999 instead of 20 Ether
      expect(minterUSNBalanceAfter).to.equal(
        ethers.parseUnits('20', 18) - BigInt(1)
      );
    });
  });
  describe('redeemUSN', () => {
    it.skip('should redeem USN tokens successfully', async () => {
      // Setup
      const redeemAmount = ethers.parseUnits('50', 18);
      const collateralAmount = ethers.parseUnits('50', 18);
      const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const nonce = Math.floor(Math.random() * 1000000); // Random nonce

      // Deploy RedeemHandler
      const RedeemHandlerFactory =
        await ethers.getContractFactory('RedeemHandler');
      const redeemHandler = await RedeemHandlerFactory.deploy(
        await usnContract.getAddress()
      );
      await redeemHandler.waitForDeployment();
      await redeemHandler.grantRole(
        await redeemHandler.REDEEM_MANAGER_ROLE(),
        owner.address
      );
      // Add collateral to RedeemHandler
      await redeemHandler.addRedeemableCollateral(
        await mockCollateral.getAddress()
      );
      // set Owner as minter
      await usnContract.setAdmin(await owner.address);

      // Mint USN to owner for redemption
      await usnContract.mint(await owner.getAddress(), redeemAmount);
      //Mint collateral to owner
      await mockCollateral.mint(await owner.getAddress(), collateralAmount);
      // Transfer collateral to RedeemHandler
      await mockCollateral.transfer(
        await redeemHandler.getAddress(),
        collateralAmount
      );

      const redeemOrder = {
        message: 'Redeem USN',
        user: await owner.getAddress(),
        collateralAddress: await mockCollateral.getAddress(),
        collateralAmount: collateralAmount,
        usnAmount: redeemAmount,
        expiry: expiry,
        nonce: nonce,
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

      const signature = await owner.signTypedData(domain, types, redeemOrder);

      // Initial balances
      const initialUSNBalance = await usnContract.balanceOf(
        await owner.getAddress()
      );
      const initialCollateralBalance = await mockCollateral.balanceOf(
        await owner.getAddress()
      );

      // Approve USN for redemption
      await usnContract.approve(await redeemHandler.getAddress(), redeemAmount);
      // Set burner role to owner
      await redeemHandler.grantRole(
        await redeemHandler.BURNER_ROLE(),
        await owner.getAddress()
      );
      // Execute redeem
      await redeemUSN(
        'http://127.0.0.1:8545/',
        await redeemHandler.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        redeemOrder,
        signature
      );

      // Final balances
      const finalUSNBalance = await usnContract.balanceOf(
        await owner.getAddress()
      );
      const finalCollateralBalance = await mockCollateral.balanceOf(
        await owner.getAddress()
      );

      // Assertions
      expect(initialUSNBalance - finalUSNBalance).to.equal(redeemAmount);
      expect(finalCollateralBalance - initialCollateralBalance).to.equal(
        collateralAmount
      );
    });
  });

  describe('mintAndRebase', () => {
    it.skip('should mint USN tokens and rebase StakingVault successfully', async () => {
      // Setup
      const mintAmount = '100';
      const collateralAmount = ethers.parseUnits('100', 18);

      // Deploy mock LayerZero endpoint if not already deployed
      if (!endpointV2Mock) {
        const EndpointV2Mock =
          await ethers.getContractFactory('EndpointV2Mock');
        endpointV2Mock = await EndpointV2Mock.deploy(5340);
      }

      // Deploy USN if not already deployed
      if (!usnContract) {
        const USNFactory = await hreEthers.getContractFactory('USN');
        usnContract = (await USNFactory.deploy(endpointV2Mock)) as USN;
        await usnContract.waitForDeployment();
        await usnContract.enablePermissionless();
      }

      // Deploy MinterHandlerV2 if not already deployed
      if (!minterHandlerContract) {
        const MinterHandlerFactory =
          await hreEthers.getContractFactory('MinterHandlerV2');
        minterHandlerContract = (await MinterHandlerFactory.deploy(
          await usnContract.getAddress()
        )) as MinterHandlerV2;
        await minterHandlerContract.waitForDeployment();
        await minterHandlerContract.setCustodialWallet(
          await minterHandlerContract.getAddress()
        );
      }

      // Deploy MockERC20 as collateral if not already deployed
      if (!mockCollateral) {
        const MockERC20Factory =
          await hreEthers.getContractFactory('MockERC20');
        mockCollateral = (await MockERC20Factory.deploy(
          'Mock Collateral',
          'MCOL'
        )) as MockERC20;
        await mockCollateral.waitForDeployment();
      }

      // Deploy StakingVault if not already deployed
      if (!stakingVault) {
        const stakingVaultFactory =
          await hreEthers.getContractFactory('StakingVault');
        stakingVault = (await stakingVaultFactory.deploy(
          await usnContract.getAddress(),
          'Staked USN',
          'SUSN'
        )) as StakingVault;
        await stakingVault.waitForDeployment();
      }

      // Set up initial state for contracts
      await usnContract.setAdmin(await minterHandlerContract.getAddress());
      await minterHandlerContract.grantRole(
        await minterHandlerContract.MINTER_ROLE(),
        await owner.getAddress()
      );
      await stakingVault.setRebaseManager(await owner.getAddress());

      // Mint collateral to owner
      await mockCollateral.mint(await owner.getAddress(), collateralAmount);

      // Approve collateral to minterHandler
      await mockCollateral.approve(
        await minterHandlerContract.getAddress(),
        collateralAmount
      );

      // Get initial balances
      const initialUSNBalance = await usnContract.balanceOf(
        await owner.getAddress()
      );
      const initialStakingVaultBalance = await usnContract.balanceOf(
        await stakingVault.getAddress()
      );

      // Prepare mint order
      const nonce = 1;
      const expiry = Math.floor(Date.now() / 1000) + 3600; // expiry 1 hour from now
      const order = {
        message: 'Mint USN',
        user: await owner.getAddress(),
        collateralAmount: ethers.parseUnits(mintAmount, 18).toString(),
        usnAmount: ethers.parseUnits(mintAmount, 18).toString(),
        nonce,
        expiry,
        collateralAddress: await mockCollateral.getAddress(),
      };

      // Sign the order
      const domain = {
        name: 'MinterHandlerV2',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await minterHandlerContract.getAddress(),
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

      // Execute mint
      await expect(
        mintUSN(
          'http://127.0.0.1:8545',
          await minterHandlerContract.getAddress(),
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          order,
          signature
        )
      ).to.be.reverted;
      // Whitelist the owner
      await minterHandlerContract.addWhitelistedUser(await owner.getAddress());

      // Execute mint without expecting a revert
      await mintUSN(
        'http://127.0.0.1:8545',
        await minterHandlerContract.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        order,
        signature
      );

      // Verify the mint was successful
      const ownerUSNBalance = await usnContract.balanceOf(
        await owner.getAddress()
      );
      expect(ownerUSNBalance).to.equal(ethers.parseUnits(mintAmount, 18));

      // Approve stakingVault to transfer USN
      await usnContract
        .connect(owner)
        .approve(
          await stakingVault.getAddress(),
          ethers.parseUnits(mintAmount, 18)
        );

      // Execute rebase
      await rebaseStakingVault(
        'http://127.0.0.1:8545',
        await stakingVault.getAddress(),
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ethers.parseUnits(mintAmount, 18).toString()
      );
      // Get final balances
      const finalUSNBalance = await usnContract.balanceOf(
        await owner.getAddress()
      );
      const finalStakingVaultBalance = await usnContract.balanceOf(
        await stakingVault.getAddress()
      );

      // Assertions
      expect(finalUSNBalance - initialUSNBalance).to.equal(0);
      expect(finalStakingVaultBalance - initialStakingVaultBalance).to.equal(
        ethers.parseUnits(mintAmount, 18)
      );
    });

    it.skip('should fail to mint USN tokens when collateral is not approved', async () => {
      const mintAmount = '100';

      // Reset collateral allowance
      await mockCollateral.approve(await minterHandlerContract.getAddress(), 0);

      const order = {
        message: 'Mint USN',
        user: await owner.getAddress(),
        collateralAmount: ethers.parseUnits(mintAmount, 18).toString(),
        usnAmount: ethers.parseUnits(mintAmount, 18).toString(),
        nonce: 1,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        collateralAddress: await mockCollateral.getAddress(),
      };

      const signature = await owner.signTypedData(
        {
          name: 'MinterHandlerV2',
          version: '1',
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await minterHandlerContract.getAddress(),
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

      await expect(
        mintUSN(
          'http://127.0.0.1:8545',
          await minterHandlerContract.getAddress(),
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          order,
          signature
        )
      ).to.be.revertedWithCustomError(
        minterHandlerContract,
        'UserNotWhitelisted'
      );
    });

    it.skip('should fail to rebase when caller is not the rebase manager', async () => {
      const rebaseAmount = '10';

      // Remove rebase manager role from owner
      await stakingVault.revokeRole(
        await stakingVault.REBASE_MANAGER_ROLE(),
        await owner.getAddress()
      );

      await expect(
        rebaseStakingVault(
          'http://127.0.0.1:8545',
          await stakingVault.getAddress(),
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          ethers.parseUnits(rebaseAmount, 18).toString()
        )
      ).to.be.revertedWithCustomError(
        stakingVault,
        'AccessControlUnauthorizedAccount'
      );
    });
  });
});
