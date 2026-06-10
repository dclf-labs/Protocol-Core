import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type {
  USNUpgradeableHyperlane,
  EndpointV2Mock,
} from '../typechain-types';

const CHAIN_ID_SRC = 1;

describe('USNUpgradeableHyperlane — pausable', function () {
  let token: USNUpgradeableHyperlane;
  let endpointMock: EndpointV2Mock;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let mailboxSigner: HardhatEthersSigner;

  const seed = ethers.parseUnits('1000', 18);

  beforeEach(async function () {
    [owner, admin, user, other, outsider, mailboxSigner] =
      await ethers.getSigners();

    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointMock = await EndpointV2Mock.deploy(CHAIN_ID_SRC);

    const Factory = await ethers.getContractFactory('USNUpgradeableHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['USN', 'USN', await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [await endpointMock.getAddress()],
        unsafeAllow: ['constructor'],
      },
    );
    token = Factory.attach(
      await proxy.getAddress(),
    ) as unknown as USNUpgradeableHyperlane;

    // Permissionless transfers + admin minting so tests can seed balances
    // without going through the Hyperlane handle path.
    await token.enablePermissionless();
    await token.setAdmin(await admin.getAddress());
    await token.connect(admin).mint(await user.getAddress(), seed);
  });

  describe('initial state', function () {
    it('is not paused after initialization', async function () {
      expect(await token.paused()).to.equal(false);
    });
  });

  describe('access control', function () {
    it('only owner can pause', async function () {
      await expect(
        token.connect(outsider).pause(),
      ).to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount');
      expect(await token.paused()).to.equal(false);
    });

    it('only owner can unpause', async function () {
      await token.pause();
      await expect(
        token.connect(outsider).unpause(),
      ).to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount');
      expect(await token.paused()).to.equal(true);
    });

    it('admin (mint privilege) cannot pause', async function () {
      await expect(token.connect(admin).pause()).to.be.revertedWithCustomError(
        token,
        'OwnableUnauthorizedAccount',
      );
    });

    it('honors a freshly handed-over Ownable2Step owner', async function () {
      await token.transferOwnership(await other.getAddress());
      await token.connect(other).acceptOwnership();
      await expect(token.connect(other).pause()).to.not.be.reverted;
      expect(await token.paused()).to.equal(true);
      // old owner is no longer authorized
      await expect(token.unpause()).to.be.revertedWithCustomError(
        token,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('pause / unpause lifecycle', function () {
    it('emits Paused on pause', async function () {
      await expect(token.pause())
        .to.emit(token, 'Paused')
        .withArgs(await owner.getAddress());
      expect(await token.paused()).to.equal(true);
    });

    it('emits Unpaused on unpause', async function () {
      await token.pause();
      await expect(token.unpause())
        .to.emit(token, 'Unpaused')
        .withArgs(await owner.getAddress());
      expect(await token.paused()).to.equal(false);
    });

    it('reverts when pausing an already-paused contract', async function () {
      await token.pause();
      await expect(token.pause()).to.be.revertedWithCustomError(
        token,
        'EnforcedPause',
      );
    });

    it('reverts when unpausing a contract that is not paused', async function () {
      await expect(token.unpause()).to.be.revertedWithCustomError(
        token,
        'ExpectedPause',
      );
    });
  });

  describe('paused state blocks state-changing flows', function () {
    const domain = 7;
    let remoteToken: string;

    beforeEach(async function () {
      await token.configureHyperlane(await mailboxSigner.getAddress());
      remoteToken = ethers.hexlify(ethers.randomBytes(32));
      await token.registerHyperlaneRemoteToken(domain, remoteToken);
      await token.pause();
    });

    it('blocks transfers (_update)', async function () {
      await expect(
        token.connect(user).transfer(await other.getAddress(), 1n),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks burns', async function () {
      await expect(
        token.connect(user).burn(1n),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks admin mint', async function () {
      await expect(
        token.connect(admin).mint(await other.getAddress(), 1n),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks Hyperlane outbound sends (burn inside sendTokensViaHyperlane)', async function () {
      // _burn → _update fires before any mailbox interaction, so the pause
      // check trips even though no mailbox is wired up.
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(domain, recipient, seed / 2n),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks Hyperlane inbound handle (mint path)', async function () {
      const message = ethers.concat([
        ethers.zeroPadValue(await other.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits('1', 18)), 32),
      ]);
      await expect(
        token.connect(mailboxSigner).handle(domain, remoteToken, message),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });
  });

  describe('unpause restores behavior', function () {
    it('allows transfers again after unpause', async function () {
      await token.pause();
      await token.unpause();
      const amount = ethers.parseUnits('1', 18);
      await expect(
        token.connect(user).transfer(await other.getAddress(), amount),
      ).to.not.be.reverted;
      expect(await token.balanceOf(await other.getAddress())).to.equal(amount);
    });

    it('allows burns again after unpause', async function () {
      await token.pause();
      await token.unpause();
      await expect(token.connect(user).burn(ethers.parseUnits('1', 18))).to.not
        .be.reverted;
    });

    it('allows admin mint again after unpause', async function () {
      await token.pause();
      await token.unpause();
      const amount = ethers.parseUnits('5', 18);
      await expect(token.connect(admin).mint(await other.getAddress(), amount))
        .to.not.be.reverted;
      expect(await token.balanceOf(await other.getAddress())).to.equal(amount);
    });
  });

  describe('view-only and admin access while paused', function () {
    it('does not block totalSupply / balanceOf', async function () {
      await token.pause();
      await expect(token.totalSupply()).to.not.be.reverted;
      await expect(token.balanceOf(await user.getAddress())).to.not.be.reverted;
    });

    it('does not block setAdmin', async function () {
      await token.pause();
      await expect(token.setAdmin(await other.getAddress())).to.not.be.reverted;
      expect(await token.admin()).to.equal(await other.getAddress());
    });

    it('does not block blacklist administration', async function () {
      await token.pause();
      await expect(token.blacklistAccount(await outsider.getAddress())).to.not
        .be.reverted;
      expect(await token.blacklist(await outsider.getAddress())).to.equal(true);
    });

    it('does not block whitelist administration', async function () {
      await token.pause();
      await expect(token.addToWhitelist(await outsider.getAddress())).to.not.be
        .reverted;
      expect(await token.isWhitelisted(await outsider.getAddress())).to.equal(
        true,
      );
    });
  });
});
