import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract, Signer } from 'ethers';
import { ethers as hreEthers } from 'hardhat';

describe('USN', function () {
  const ZeroAddress = '0x0000000000000000000000000000000000000000';
  let usnToken: Contract;
  let owner: Signer;
  let addr1: Signer;
  let addr2: Signer;
  let addrs: Signer[];
  let endpointV2Mock: Contract;
  let addresses: HardhatEthersSigner[];

  // hooks
  before(async () => {
    [owner, ...addresses] = await hreEthers.getSigners();
  });

  beforeEach(async function () {
    [owner, addr1, addr2, ...addrs] = await hreEthers.getSigners();

    // Deploy mock LayerZero endpoint
    const EndpointV2Mock = await hreEthers.getContractFactory('EndpointV2Mock');
    endpointV2Mock = await EndpointV2Mock.deploy(5234);

    const USNFactory = await hreEthers.getContractFactory('USN');

    usnToken = await USNFactory.deploy(endpointV2Mock.target);
    await usnToken.waitForDeployment();
    await usnToken.enablePermissionless();
  });

  // tests
  it('the token name should be correct', async () => {
    // expect
    expect(await usnToken.name()).to.equal('USN');
  });

  it('the token symbol should be correct', async () => {
    // expect
    expect(await usnToken.symbol()).to.equal('USN');
  });

  it('the token decimal should be correct', async () => {
    expect(await usnToken.decimals()).to.equal(18n);
  });

  it('the token supply should be correct', async () => {
    expect(await usnToken.totalSupply()).to.equal(0n);
  });

  it('reverts when transferring tokens to the zero address', async () => {
    await expect(
      usnToken.transfer(ZeroAddress, 1n)
    ).to.be.revertedWithCustomError(usnToken, 'ERC20InvalidReceiver');
  });

  it('should set admin correctly', async () => {
    const newAdmin = addresses[1];
    await expect(usnToken.setAdmin(newAdmin.address))
      .to.emit(usnToken, 'AdminChanged')
      .withArgs(ZeroAddress, newAdmin.address);

    expect(await usnToken.admin()).to.equal(newAdmin.address);
  });

  it('should revert when non-owner tries to set admin', async () => {
    await expect(
      usnToken.connect(addresses[0]).setAdmin(addresses[1].address)
    ).to.be.revertedWithCustomError(usnToken, 'OwnableUnauthorizedAccount');
  });

  it('should mint tokens correctly', async () => {
    const admin = addresses[1];
    await usnToken.setAdmin(admin.address);

    const recipient = addresses[2];
    const amount = hreEthers.parseUnits('100', 18);

    await expect(usnToken.connect(admin).mint(recipient.address, amount))
      .to.emit(usnToken, 'Transfer')
      .withArgs(ZeroAddress, recipient.address, amount);

    expect(await usnToken.balanceOf(recipient.address)).to.equal(amount);
  });

  it('should revert when non-admin tries to mint', async () => {
    const nonAdmin = addresses[0];
    const recipient = addresses[1];
    const amount = hreEthers.parseUnits('100', 18);

    await expect(
      usnToken.connect(nonAdmin).mint(recipient.address, amount)
    ).to.be.revertedWithCustomError(usnToken, 'OnlyAdminCanMint');
  });

  it('emits a Transfer event on successful transfers', async () => {
    const admin = addresses[1];
    await usnToken.setAdmin(admin.address);

    const from = addresses[2];
    const to = addresses[3];
    const value = hreEthers.parseUnits('10', 18);

    await usnToken.connect(admin).mint(from.address, value);

    await expect(usnToken.connect(from).transfer(to.address, value))
      .to.emit(usnToken, 'Transfer')
      .withArgs(from.address, to.address, value);
  });

  it('token balance successfully changed after transfer', async () => {
    const admin = addresses[1];
    await usnToken.setAdmin(admin.address);

    const from = addresses[2];
    const to = addresses[3];
    const value = hreEthers.parseUnits('10', 18);

    await usnToken.connect(admin).mint(from.address, value);

    await expect(
      usnToken.connect(from).transfer(to.address, value)
    ).to.changeTokenBalances(usnToken, [from, to], [-value, value]);
  });

  it('should revert when setting admin to zero address', async () => {
    await expect(usnToken.setAdmin(ZeroAddress)).to.be.revertedWithCustomError(
      usnToken,
      'ZeroAddress'
    );
  });

  it('should revert when transferring more tokens than balance', async () => {
    const from = addresses[0];
    const to = addresses[1];
    const value = hreEthers.parseUnits('10', 18);

    await expect(
      usnToken.connect(from).transfer(to.address, value)
    ).to.be.revertedWithCustomError(usnToken, 'ERC20InsufficientBalance');
  });

  it('should revert when approving spending for zero address', async () => {
    const amount = hreEthers.parseUnits('10', 18);
    await expect(
      usnToken.approve(ZeroAddress, amount)
    ).to.be.revertedWithCustomError(usnToken, 'ERC20InvalidSpender');
  });

  it('should revert when transferring from an account with insufficient allowance', async () => {
    const admin = addresses[1];
    await usnToken.setAdmin(admin.address);

    const from = addresses[2];
    const to = addresses[3];
    const spender = addresses[4];
    const value = hreEthers.parseUnits('10', 18);

    await usnToken.connect(admin).mint(from.address, value);

    await expect(
      usnToken.connect(spender).transferFrom(from.address, to.address, value)
    ).to.be.revertedWithCustomError(usnToken, 'ERC20InsufficientAllowance');
  });
  // Blacklisting tests
  it('should allow owner to blacklist an account', async () => {
    const accountToBlacklist = addresses[1];

    await expect(
      usnToken.connect(owner).blacklistAccount(accountToBlacklist.address)
    )
      .to.emit(usnToken, 'Blacklisted')
      .withArgs(accountToBlacklist.address);

    expect(await usnToken.blacklist(accountToBlacklist.address)).to.be.true;
  });

  it('should revert when non-owner tries to blacklist an account', async () => {
    const nonOwner = addresses[0];
    const accountToBlacklist = addresses[1];

    await expect(
      usnToken.connect(nonOwner).blacklistAccount(accountToBlacklist.address)
    ).to.be.revertedWithCustomError(usnToken, 'OwnableUnauthorizedAccount');
  });

  it('should prevent blacklisted accounts from transferring tokens', async () => {
    const blacklistedAccount = addresses[1];
    const recipient = addresses[2];
    const amount = hreEthers.parseUnits('10', 18);

    await usnToken.connect(owner).setAdmin(owner.address);
    await usnToken.connect(owner).mint(blacklistedAccount.address, amount);
    await usnToken.connect(owner).blacklistAccount(blacklistedAccount.address);

    await expect(
      usnToken.connect(blacklistedAccount).transfer(recipient.address, amount)
    ).to.be.revertedWithCustomError(usnToken, 'BlacklistedAddress');
  });

  it('should prevent transfers to blacklisted accounts', async () => {
    const sender = addresses[1];
    const blacklistedRecipient = addresses[2];
    const amount = hreEthers.parseUnits('10', 18);

    await usnToken.connect(owner).setAdmin(owner.address);
    await usnToken.connect(owner).mint(sender.address, amount);
    await usnToken
      .connect(owner)
      .blacklistAccount(blacklistedRecipient.address);

    await expect(
      usnToken.connect(sender).transfer(blacklistedRecipient.address, amount)
    ).to.be.revertedWithCustomError(usnToken, 'BlacklistedAddress');
  });

  it('should allow owner to unblacklist an account', async () => {
    const accountToUnblacklist = addresses[1];

    await usnToken
      .connect(owner)
      .blacklistAccount(accountToUnblacklist.address);
    expect(await usnToken.blacklist(accountToUnblacklist.address)).to.be.true;

    await expect(
      usnToken.connect(owner).unblacklistAccount(accountToUnblacklist.address)
    )
      .to.emit(usnToken, 'Unblacklisted')
      .withArgs(accountToUnblacklist.address);

    expect(await usnToken.blacklist(accountToUnblacklist.address)).to.be.false;
  });

  it('should allow transfers after unblacklisting', async () => {
    const sender = addresses[1];
    const recipient = addresses[2];
    const amount = hreEthers.parseUnits('10', 18);

    await usnToken.connect(owner).setAdmin(owner.address);
    await usnToken.connect(owner).mint(sender.address, amount);
    await usnToken.connect(owner).blacklistAccount(sender.address);

    await expect(
      usnToken.connect(sender).transfer(recipient.address, amount)
    ).to.be.revertedWithCustomError(usnToken, 'BlacklistedAddress');

    await usnToken.connect(owner).unblacklistAccount(sender.address);

    await expect(
      usnToken.connect(sender).transfer(recipient.address, amount)
    ).to.changeTokenBalances(usnToken, [sender, recipient], [-amount, amount]);
  });
  describe('Ownable2Step', () => {
    it('should not allow direct ownership transfer', async () => {
      const newOwner = addresses[1];
      await expect(usnToken.transferOwnership(newOwner.address))
        .to.emit(usnToken, 'OwnershipTransferStarted')
        .withArgs(await owner.getAddress(), newOwner.address);

      // Ownership should not have changed yet
      expect(await usnToken.owner()).to.equal(await owner.getAddress());
    });

    it('should allow two-step ownership transfer', async () => {
      const newOwner = addresses[1];

      // Start the transfer
      await usnToken.transferOwnership(newOwner.address);

      // New owner accepts the transfer
      await expect(usnToken.connect(newOwner).acceptOwnership())
        .to.emit(usnToken, 'OwnershipTransferred')
        .withArgs(await owner.getAddress(), newOwner.address);

      // Ownership should have changed
      expect(await usnToken.owner()).to.equal(newOwner.address);
    });

    it('should allow cancellation of ownership transfer', async () => {
      const newOwner = addresses[1];

      // Start the transfer
      await usnToken.transferOwnership(newOwner.address);

      // Cancel the transfer
      await usnToken.transferOwnership(owner.address);

      // Ownership should not have changed
      expect(await usnToken.owner()).to.equal(await owner.getAddress());

      // New owner should not be able to accept ownership
      await expect(
        usnToken.connect(newOwner).acceptOwnership()
      ).to.be.revertedWithCustomError(usnToken, 'OwnableUnauthorizedAccount');
    });

    it('should not allow non-pending owner to accept ownership', async () => {
      const newOwner = addresses[1];
      const notNewOwner = addresses[2];

      // Start the transfer
      await usnToken.transferOwnership(newOwner.address);

      // Not new owner tries to accept
      await expect(
        usnToken.connect(notNewOwner).acceptOwnership()
      ).to.be.revertedWithCustomError(usnToken, 'OwnableUnauthorizedAccount');
    });
  });
  describe('ERC20Permit', () => {
    const amount = hreEthers.parseUnits('100', 18);
    let owner: HardhatEthersSigner;
    let spender: HardhatEthersSigner;
    let deadline: bigint;

    beforeEach(async () => {
      [owner, spender] = await hreEthers.getSigners();
      deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
    });

    it('should allow permit', async () => {
      const nonce = await usnToken.nonces(owner.address);
      const name = await usnToken.name();
      const version = '1';
      const chainId = await hreEthers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await usnToken.getAddress(),
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
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline: deadline * 10n,
      };

      const signature = await owner.signTypedData(domain, types, values);
      const { v, r, s } = hreEthers.Signature.from(signature);

      // Ensure the deadline is in the future
      const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
      expect(deadline).to.be.greaterThan(currentTimestamp);

      await expect(
        usnToken.permit(
          owner.address,
          spender.address,
          amount,
          deadline * 10n,
          v,
          r,
          s
        )
      )
        .to.emit(usnToken, 'Approval')
        .withArgs(owner.address, spender.address, amount);

      expect(await usnToken.allowance(owner.address, spender.address)).to.equal(
        amount
      );
    });

    it('should revert on expired permit', async () => {
      const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const nonce = await usnToken.nonces(owner.address);
      const name = await usnToken.name();
      const version = '1';
      const chainId = await hreEthers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await usnToken.getAddress(),
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
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline: expiredDeadline,
      };

      const signature = await owner.signTypedData(domain, types, values);
      const { v, r, s } = hreEthers.Signature.from(signature);

      await expect(
        usnToken.permit(
          owner.address,
          spender.address,
          amount,
          expiredDeadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(usnToken, 'ERC2612ExpiredSignature');
    });

    it('should revert on invalid signature', async () => {
      const nonce = await usnToken.nonces(owner.address);
      const name = await usnToken.name();
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600 * 1000); // 1000 hour from now
      const version = '1';
      const chainId = await hreEthers.provider
        .getNetwork()
        .then((network) => network.chainId);

      const domain = {
        name,
        version,
        chainId,
        verifyingContract: await usnToken.getAddress(),
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
        owner: owner.address,
        spender: spender.address,
        value: amount,
        nonce,
        deadline,
      };

      const signature = await spender.signTypedData(domain, types, values); // Signed by spender instead of owner
      const { v, r, s } = hreEthers.Signature.from(signature);

      await expect(
        usnToken.permit(
          owner.address,
          spender.address,
          amount,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(usnToken, 'ERC2612InvalidSigner');
    });
  });

  it('Should have 18 decimals', async function () {
    const decimals = await usnToken.decimals();
    expect(decimals).to.equal(18);
  });

  // Add more tests for OFT functionality
});
