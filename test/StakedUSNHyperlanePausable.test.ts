import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { StakedUSNHyperlane } from '../typechain-types';

describe('StakedUSNHyperlane — pausable', function () {
  let token: StakedUSNHyperlane;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let mailboxSigner: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, admin, user, other, outsider, mailboxSigner] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory('StakedUSNHyperlane');
    const proxy = await upgrades.deployProxy(
      Factory,
      ['Staked USN', 'sUSN', await owner.getAddress()],
      { initializer: 'initialize', unsafeAllow: ['constructor'] }
    );
    token = Factory.attach(await proxy.getAddress()) as StakedUSNHyperlane;
  });

  describe('initial state', function () {
    it('is not paused after initialization', async function () {
      expect(await token.paused()).to.equal(false);
    });
  });

  describe('access control', function () {
    it('only DEFAULT_ADMIN_ROLE can pause', async function () {
      await expect(token.connect(outsider).pause()).to.be.reverted;
      expect(await token.paused()).to.equal(false);
    });

    it('only DEFAULT_ADMIN_ROLE can unpause', async function () {
      await token.pause();
      await expect(token.connect(outsider).unpause()).to.be.reverted;
      expect(await token.paused()).to.equal(true);
    });

    it('honors a freshly granted admin role', async function () {
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      await token.grantRole(DEFAULT_ADMIN_ROLE, await admin.getAddress());
      await expect(token.connect(admin).pause()).to.not.be.reverted;
      expect(await token.paused()).to.equal(true);
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
        'EnforcedPause'
      );
    });

    it('reverts when unpausing a contract that is not paused', async function () {
      await expect(token.unpause()).to.be.revertedWithCustomError(
        token,
        'ExpectedPause'
      );
    });
  });

  describe('paused state blocks state-changing flows', function () {
    const seed = ethers.parseUnits('1000', 18);
    const domain = 7;
    let remoteToken: string;

    beforeEach(async function () {
      // Seed user balance via the mailbox handle path before pausing, and
      // register the same domain for the outbound send path.
      await token.configureHyperlane(await mailboxSigner.getAddress());
      remoteToken = ethers.hexlify(ethers.randomBytes(32));
      await token.registerHyperlaneRemoteToken(domain, remoteToken);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(seed), 32),
      ]);
      await token.connect(mailboxSigner).handle(domain, remoteToken, message);
      await token.pause();
    });

    it('blocks share transfers (_update)', async function () {
      await expect(
        token.connect(user).transfer(await other.getAddress(), 1n)
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks burns', async function () {
      await expect(
        token.connect(user).burn(1n)
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks Hyperlane outbound sends before any mailbox call', async function () {
      // _burn → _update is invoked inside sendTokensViaHyperlane *after* the
      // remote-token lookup but before the mailbox is queried, so as long as
      // the destination is registered the pause check fires before any
      // mailbox interaction.
      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await expect(
        token
          .connect(user)
          .sendTokensViaHyperlane(domain, recipient, seed / 2n)
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('blocks Hyperlane inbound handle (mint path)', async function () {
      const message = ethers.concat([
        ethers.zeroPadValue(await other.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits('1', 18)), 32),
      ]);
      await expect(
        token.connect(mailboxSigner).handle(domain, remoteToken, message)
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });
  });

  describe('unpause restores behavior', function () {
    const seed = ethers.parseUnits('1000', 18);

    beforeEach(async function () {
      await token.configureHyperlane(await mailboxSigner.getAddress());
      const origin = 7;
      const remoteToken = ethers.hexlify(ethers.randomBytes(32));
      await token.registerHyperlaneRemoteToken(origin, remoteToken);
      const message = ethers.concat([
        ethers.zeroPadValue(await user.getAddress(), 32),
        ethers.zeroPadValue(ethers.toBeHex(seed), 32),
      ]);
      await token.connect(mailboxSigner).handle(origin, remoteToken, message);
    });

    it('allows transfers again after unpause', async function () {
      await token.pause();
      await token.unpause();
      await expect(
        token
          .connect(user)
          .transfer(await other.getAddress(), ethers.parseUnits('1', 18))
      ).to.not.be.reverted;
      expect(await token.balanceOf(await other.getAddress())).to.equal(
        ethers.parseUnits('1', 18)
      );
    });

    it('allows burns again after unpause', async function () {
      await token.pause();
      await token.unpause();
      await expect(token.connect(user).burn(ethers.parseUnits('1', 18))).to.not
        .be.reverted;
    });
  });

  describe('view-only access while paused', function () {
    it('does not block totalSupply / balanceOf', async function () {
      await token.pause();
      await expect(token.totalSupply()).to.not.be.reverted;
      await expect(token.balanceOf(await user.getAddress())).to.not.be.reverted;
    });

    it('does not block role administration', async function () {
      await token.pause();
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      await expect(
        token.grantRole(DEFAULT_ADMIN_ROLE, await admin.getAddress())
      ).to.not.be.reverted;
    });

    it('does not block blacklist administration', async function () {
      await token.pause();
      await expect(token.blacklistAccount(await outsider.getAddress())).to.not
        .be.reverted;
      expect(await token.blacklist(await outsider.getAddress())).to.equal(true);
    });
  });
});
