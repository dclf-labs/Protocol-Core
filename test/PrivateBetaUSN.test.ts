import { Options } from '@layerzerolabs/lz-v2-utilities';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract, ContractFactory, ZeroAddress } from 'ethers';
import { ethers } from 'hardhat';

describe('PrivateBetaUSN Test', function () {
  const eidA = 1;
  const eidB = 2;
  let PrivateBetaUSN: ContractFactory;
  let EndpointV2Mock: ContractFactory;
  let ownerA: SignerWithAddress;
  let ownerB: SignerWithAddress;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let endpointOwner: SignerWithAddress;
  let privateBetaUSNA: Contract;
  let privateBetaUSNB: Contract;
  let privateBetaUSN: Contract;
  let mockEndpointV2A: Contract;
  let mockEndpointV2B: Contract;

  before(async function () {
    [owner, user1, user2, user3, ownerA, ownerB, endpointOwner] =
      await ethers.getSigners();
    EndpointV2Mock = await ethers.getContractFactory(
      'EndpointV2Mock',
      endpointOwner
    );
  });

  beforeEach(async function () {
    mockEndpointV2A = await EndpointV2Mock.deploy(eidA);
    mockEndpointV2B = await EndpointV2Mock.deploy(eidB);

    const USNFactory = await ethers.getContractFactory('USN');
    privateBetaUSNA = await USNFactory.deploy(mockEndpointV2A.target);
    privateBetaUSNB = await USNFactory.deploy(mockEndpointV2B.target);
    privateBetaUSN = await USNFactory.deploy(mockEndpointV2A.target);
    await privateBetaUSN.waitForDeployment();

    await privateBetaUSN.setAdmin(owner.address);
  });

  describe('Whitelisting', function () {
    it('Should allow owner to add an address to the whitelist', async function () {
      await expect(privateBetaUSN.addToWhitelist(user1.address))
        .to.emit(privateBetaUSN, 'WhitelistAdded')
        .withArgs(user1.address);

      expect(await privateBetaUSN.isWhitelisted(user1.address)).to.be.true;
    });

    it('Should allow owner to remove an address from the whitelist', async function () {
      await privateBetaUSN.addToWhitelist(user1.address);
      await expect(privateBetaUSN.removeFromWhitelist(user1.address))
        .to.emit(privateBetaUSN, 'WhitelistRemoved')
        .withArgs(user1.address);

      expect(await privateBetaUSN.isWhitelisted(user1.address)).to.be.false;
    });

    it('Should not allow non-owner to add an address to the whitelist', async function () {
      await expect(privateBetaUSN.connect(user1).addToWhitelist(user2.address))
        .to.be.revertedWithCustomError(
          privateBetaUSN,
          'OwnableUnauthorizedAccount'
        )
        .withArgs(user1.address);
    });

    it('Should not allow non-owner to remove an address from the whitelist', async function () {
      await privateBetaUSN.addToWhitelist(user1.address);
      await expect(
        privateBetaUSN.connect(user1).removeFromWhitelist(user1.address)
      )
        .to.be.revertedWithCustomError(
          privateBetaUSN,
          'OwnableUnauthorizedAccount'
        )
        .withArgs(user1.address);
    });
  });

  describe('Token transfers', function () {
    beforeEach(async function () {
      // Whitelist owner before minting
      await privateBetaUSN.addToWhitelist(owner.address);
      // Whitelist ZeroAddress to allow minting transfers
      await privateBetaUSN.addToWhitelist(ZeroAddress);
      // Mint some tokens to owner
      await privateBetaUSN.mint(owner.address, ethers.parseEther('1000'));
    });

    it('Should allow transfer between whitelisted addresses', async function () {
      await privateBetaUSN.addToWhitelist(user1.address);

      await expect(
        privateBetaUSN.transfer(user1.address, ethers.parseEther('100'))
      )
        .to.emit(privateBetaUSN, 'Transfer')
        .withArgs(owner.address, user1.address, ethers.parseEther('100'));
    });

    it('Should not allow transfer from whitelisted to non-whitelisted address', async function () {
      await expect(
        privateBetaUSN.transfer(user1.address, ethers.parseEther('100'))
      )
        .to.be.revertedWithCustomError(privateBetaUSN, 'NotWhitelisted')
        .withArgs(owner.address, user1.address);
    });
    it('Should not allow transfer from non-whitelisted to whitelisted address', async function () {
      await privateBetaUSN.addToWhitelist(user1.address);
      const isUser2Whitelisted = await privateBetaUSN.isWhitelisted(
        user2.address
      );
      if (!isUser2Whitelisted) {
        await expect(
          privateBetaUSN.transfer(user2.address, ethers.parseEther('100'))
        )
          .to.be.revertedWithCustomError(privateBetaUSN, 'NotWhitelisted')
          .withArgs(owner.address, user2.address);
      } else {
        await privateBetaUSN.transfer(user2.address, ethers.parseEther('100'));
      }

      await expect(
        privateBetaUSN
          .connect(user2)
          .transfer(user1.address, ethers.parseEther('50'))
      )
        .to.be.revertedWithCustomError(privateBetaUSN, 'NotWhitelisted')
        .withArgs(user2.address, user1.address);
    });

    it('Should not allow transfer between non-whitelisted addresses', async function () {
      // Check if user2 is whitelisted
      const isUser2Whitelisted = await privateBetaUSN.isWhitelisted(
        user2.address
      );

      if (isUser2Whitelisted) {
        await privateBetaUSN.transfer(user2.address, ethers.parseEther('100'));
      } else {
        await expect(
          privateBetaUSN.transfer(user2.address, ethers.parseEther('100'))
        )
          .to.be.revertedWithCustomError(privateBetaUSN, 'NotWhitelisted')
          .withArgs(owner.address, user2.address);
      }

      await expect(
        privateBetaUSN
          .connect(user2)
          .transfer(user3.address, ethers.parseEther('50'))
      )
        .to.be.revertedWithCustomError(privateBetaUSN, 'NotWhitelisted')
        .withArgs(user2.address, user3.address);
    });
  });
});
