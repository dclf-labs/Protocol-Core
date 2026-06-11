import { expect } from 'chai';
import { Contract, Signer } from 'ethers';
import { ethers, upgrades } from 'hardhat';

describe('USNUpgradeable', function () {
  let usn: Contract;
  let endpointV2Mock: Contract;
  let owner: Signer;
  let addr1: Signer;
  let addr2: Signer;
  let addrs: Signer[];

  const name = 'USN';
  const symbol = 'USN';
  const localDecimals = 18;

  beforeEach(async function () {
    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();
    const USNUpgradeable = await ethers.getContractFactory('USNUpgradeable');
    // Deploy mock EndpointV2Mock contract
    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5234);
    await endpointV2Mock.waitForDeployment();
    // Use the deployed mock endpoint address instead of the hardcoded one
    const mockLzEndpoint = await endpointV2Mock.getAddress();
    usn = await upgrades.deployProxy(
      USNUpgradeable,
      [name, symbol, await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [mockLzEndpoint], // Arguments for constructor
        unsafeAllow: ['constructor'],
      }
    );
    await usn.waitForDeployment();
    //set usn permissionless
    await usn.enablePermissionless();

    // Mint some tokens to the owner for testing
    const initialSupply = ethers.parseEther('1000000');
    await usn.setAdmin(await owner.getAddress());
    await usn.mint(await owner.getAddress(), initialSupply);
  });

  describe('Deployment', function () {
    it('Should set the right owner', async function () {
      expect(await usn.owner()).to.equal(await owner.getAddress());
    });

    it('Should assign the total supply of tokens to the owner', async function () {
      const ownerBalance = await usn.balanceOf(await owner.getAddress());
      expect(await usn.totalSupply()).to.equal(ownerBalance);
    });

    it('Should set the correct name and symbol', async function () {
      expect(await usn.name()).to.equal(name);
      expect(await usn.symbol()).to.equal(symbol);
    });

    it('Should not allow initialization with zero address owner', async function () {
      const USNUpgradeable = await ethers.getContractFactory('USNUpgradeable');
      await expect(
        upgrades.deployProxy(
          USNUpgradeable,
          [name, symbol, ethers.ZeroAddress],
          {
            initializer: 'initialize',
            constructorArgs: [endpointV2Mock.target],
            unsafeAllow: ['constructor'],
          }
        )
      ).to.be.revertedWithCustomError(USNUpgradeable, 'OwnableInvalidOwner');
    });
  });

  describe('Transactions', function () {
    it('Should transfer tokens between accounts', async function () {
      const amount = ethers.parseEther('50');
      await usn.transfer(await addr1.getAddress(), amount);
      const addr1Balance = await usn.balanceOf(await addr1.getAddress());
      expect(addr1Balance).to.equal(amount);

      await usn.connect(addr1).transfer(await addr2.getAddress(), amount);
      const addr2Balance = await usn.balanceOf(await addr2.getAddress());
      expect(addr2Balance).to.equal(amount);
    });

    it("Should fail if sender doesn't have enough tokens", async function () {
      const initialOwnerBalance = await usn.balanceOf(await owner.getAddress());
      await expect(
        usn.connect(addr1).transfer(await owner.getAddress(), 1)
      ).to.be.revertedWithCustomError(usn, 'ERC20InsufficientBalance');
      expect(await usn.balanceOf(await owner.getAddress())).to.equal(
        initialOwnerBalance
      );
    });

    it('Should update balances after transfers', async function () {
      const initialOwnerBalance = await usn.balanceOf(await owner.getAddress());
      const amount = ethers.parseEther('100');

      await usn.transfer(await addr1.getAddress(), amount);
      await usn.transfer(await addr2.getAddress(), amount);

      const finalOwnerBalance = await usn.balanceOf(await owner.getAddress());
      expect(finalOwnerBalance).to.equal(
        initialOwnerBalance - BigInt(amount) * BigInt(2)
      );

      const addr1Balance = await usn.balanceOf(await addr1.getAddress());
      expect(addr1Balance).to.equal(amount);

      const addr2Balance = await usn.balanceOf(await addr2.getAddress());
      expect(addr2Balance).to.equal(amount);
    });

    it('Should not allow transfer to zero address', async function () {
      const amount = ethers.parseEther('50');
      await expect(
        usn.transfer(ethers.ZeroAddress, amount)
      ).to.be.revertedWithCustomError(usn, 'ERC20InvalidReceiver');
    });
  });

  describe('Minting', function () {
    it('Should allow the owner to mint tokens', async function () {
      const mintAmount = ethers.parseEther('1000');
      await usn.mint(await addr1.getAddress(), mintAmount);
      expect(await usn.balanceOf(await addr1.getAddress())).to.equal(
        mintAmount
      );
    });

    it('Should not allow non-owners to mint tokens', async function () {
      const mintAmount = ethers.parseEther('1000');
      await expect(
        usn.connect(addr1).mint(await addr2.getAddress(), mintAmount)
      ).to.be.revertedWithCustomError(usn, 'OnlyAdminCanMint');
    });

    it('Should not allow minting to zero address', async function () {
      const mintAmount = ethers.parseEther('1000');
      await expect(
        usn.mint(ethers.ZeroAddress, mintAmount)
      ).to.be.revertedWithCustomError(usn, 'ERC20InvalidReceiver');
    });
  });

  describe('Burning', function () {
    it('Should allow users to burn their own tokens', async function () {
      const burnAmount = ethers.parseEther('100');
      await usn.transfer(await addr1.getAddress(), burnAmount);
      await usn.connect(addr1).burn(burnAmount);
      expect(await usn.balanceOf(await addr1.getAddress())).to.equal(0);
    });

    it('Should not allow burning more tokens than balance', async function () {
      const balance = await usn.balanceOf(await owner.getAddress());
      await expect(usn.burn(balance + BigInt(1))).to.be.revertedWithCustomError(
        usn,
        'ERC20InsufficientBalance'
      );
    });
  });

  // Add more tests for USNUpgradeable specific functionality
  describe('USNUpgradeable Specific', function () {
    it('Should have the correct OFT version', async function () {
      const [interfaceId, version] = await usn.oftVersion();
      expect(version).to.equal(1);
    });

    it('Should not require approval', async function () {
      expect(await usn.approvalRequired()).to.be.false;
    });
  });

  describe('Upgradeability', function () {
    it('Should be upgradeable', async function () {
      const USNUpgradeableV2 =
        await ethers.getContractFactory('USNUpgradeable');
      const upgradedUSN = await upgrades.upgradeProxy(
        usn.target,
        USNUpgradeableV2,
        {
          constructorArgs: [endpointV2Mock.target],
          unsafeAllow: ['constructor'],
        }
      );

      await upgradedUSN.waitForDeployment();

      // Check that the address remains the same
      expect(upgradedUSN.target).to.equal(usn.target);

      // Check that the state is preserved
      expect(await upgradedUSN.name()).to.equal('USN');
      expect(await upgradedUSN.symbol()).to.equal('USN');
      expect(await upgradedUSN.owner()).to.equal(await owner.getAddress());
      // Check that the decimals are preserved
      expect(await upgradedUSN.decimals()).to.equal(localDecimals);
    });

    it('Should not be upgradeable by non-owner', async function () {
      const USNUpgradeableV2 =
        await ethers.getContractFactory('USNUpgradeable');

      await expect(
        upgrades.upgradeProxy(usn.target, USNUpgradeableV2.connect(addr1), {
          constructorArgs: [endpointV2Mock.target],
          unsafeAllow: ['constructor'],
        })
      ).to.be.revertedWithCustomError(usn, 'OwnableUnauthorizedAccount');
    });

    it('Should not allow initialization after upgrade', async function () {
      const USNUpgradeableV2 =
        await ethers.getContractFactory('USNUpgradeable');
      const upgradedUSN = await upgrades.upgradeProxy(
        usn.target,
        USNUpgradeableV2,
        {
          constructorArgs: [endpointV2Mock.target],
          unsafeAllow: ['constructor'],
        }
      );

      await upgradedUSN.waitForDeployment();

      await expect(
        upgradedUSN.initialize(name, symbol, await owner.getAddress())
      ).to.be.revertedWithCustomError(upgradedUSN, 'InvalidInitialization');
    });
  });
});
