import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type {
  USN,
  StakingVaultOFTUpgradeable,
  EndpointV2Mock,
} from '../typechain-types';

const CHAIN_ID_SRC = 1;

describe('StakingVaultOFTUpgradeable — pausable', function () {
  let USN: USN;
  let StakingVault: StakingVaultOFTUpgradeable;
  let endpointMock: EndpointV2Mock;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let rebaseManager: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const initialMint = ethers.parseUnits('100000', 18);
  const stakeAmount = ethers.parseUnits('10000', 18);
  const rebaseAmount = ethers.parseUnits('500', 18);

  beforeEach(async function () {
    [owner, admin, rebaseManager, user, other, outsider] =
      await ethers.getSigners();

    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointMock = await EndpointV2Mock.deploy(CHAIN_ID_SRC);

    const USNFactory = await ethers.getContractFactory('USN');
    USN = await USNFactory.deploy(await endpointMock.getAddress());
    await USN.enablePermissionless();
    await USN.setAdmin(await owner.getAddress());
    await USN.mint(await user.getAddress(), initialMint);
    await USN.mint(await rebaseManager.getAddress(), initialMint);

    const StakingVaultFactory = await ethers.getContractFactory(
      'StakingVaultOFTUpgradeable'
    );
    const proxy = await upgrades.deployProxy(
      StakingVaultFactory,
      [await USN.getAddress(), 'Staked USN', 'sUSN', await owner.getAddress()],
      {
        initializer: 'initialize',
        constructorArgs: [await endpointMock.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    StakingVault = StakingVaultFactory.attach(
      await proxy.getAddress()
    ) as StakingVaultOFTUpgradeable;

    await StakingVault.setRebaseManager(await rebaseManager.getAddress());

    await USN.connect(user).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );
    await USN.connect(rebaseManager).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );

    // Seed shares so rebase/transfer paths have something to operate on.
    await StakingVault.connect(user).deposit(
      stakeAmount,
      await user.getAddress()
    );
  });

  describe('initial state', function () {
    it('is not paused after initialization', async function () {
      expect(await StakingVault.paused()).to.equal(false);
    });
  });

  describe('access control', function () {
    it('only DEFAULT_ADMIN_ROLE can pause', async function () {
      await expect(StakingVault.connect(outsider).pause()).to.be.reverted;
      expect(await StakingVault.paused()).to.equal(false);
    });

    it('only DEFAULT_ADMIN_ROLE can unpause', async function () {
      await StakingVault.pause();
      await expect(StakingVault.connect(outsider).unpause()).to.be.reverted;
      expect(await StakingVault.paused()).to.equal(true);
    });

    it('REBASE_MANAGER cannot pause', async function () {
      await expect(StakingVault.connect(rebaseManager).pause()).to.be.reverted;
    });

    it('honors a freshly granted admin role', async function () {
      const DEFAULT_ADMIN_ROLE = await StakingVault.DEFAULT_ADMIN_ROLE();
      await StakingVault.grantRole(
        DEFAULT_ADMIN_ROLE,
        await admin.getAddress()
      );
      await expect(StakingVault.connect(admin).pause()).to.not.be.reverted;
      expect(await StakingVault.paused()).to.equal(true);
    });
  });

  describe('pause / unpause lifecycle', function () {
    it('emits Paused on pause', async function () {
      await expect(StakingVault.pause())
        .to.emit(StakingVault, 'Paused')
        .withArgs(await owner.getAddress());
      expect(await StakingVault.paused()).to.equal(true);
    });

    it('emits Unpaused on unpause', async function () {
      await StakingVault.pause();
      await expect(StakingVault.unpause())
        .to.emit(StakingVault, 'Unpaused')
        .withArgs(await owner.getAddress());
      expect(await StakingVault.paused()).to.equal(false);
    });

    it('reverts when pausing an already-paused contract', async function () {
      await StakingVault.pause();
      await expect(StakingVault.pause()).to.be.revertedWithCustomError(
        StakingVault,
        'EnforcedPause'
      );
    });

    it('reverts when unpausing a contract that is not paused', async function () {
      await expect(StakingVault.unpause()).to.be.revertedWithCustomError(
        StakingVault,
        'ExpectedPause'
      );
    });
  });

  describe('paused state blocks state-changing flows', function () {
    beforeEach(async function () {
      await StakingVault.pause();
    });

    it('blocks rebase', async function () {
      await expect(
        StakingVault.connect(rebaseManager).rebase(rebaseAmount)
      ).to.be.revertedWithCustomError(StakingVault, 'EnforcedPause');
    });

    it('blocks share transfers (_update)', async function () {
      await expect(
        StakingVault.connect(user).transfer(await other.getAddress(), 1n)
      ).to.be.revertedWithCustomError(StakingVault, 'EnforcedPause');
    });

    it('blocks deposits (mint path through _update)', async function () {
      await expect(
        StakingVault.connect(user).deposit(
          ethers.parseUnits('1', 18),
          await user.getAddress()
        )
      ).to.be.revertedWithCustomError(StakingVault, 'EnforcedPause');
    });

    it('blocks Hyperlane outbound sends before any mailbox call', async function () {
      // _update is invoked inside sendTokensViaHyperlane *before* the mailbox
      // is queried, so the pause check fires first and the mailbox address
      // never matters here.
      await StakingVault.configureHyperlane(await outsider.getAddress());
      const destinationDomain = 2;
      const remoteToken = ethers.hexlify(ethers.randomBytes(32));
      await StakingVault.registerHyperlaneRemoteToken(
        destinationDomain,
        remoteToken
      );

      const recipient = ethers.zeroPadValue(await other.getAddress(), 32);
      await expect(
        StakingVault.connect(user).sendTokensViaHyperlane(
          destinationDomain,
          recipient,
          stakeAmount / 2n
        )
      ).to.be.revertedWithCustomError(StakingVault, 'EnforcedPause');
    });
  });

  describe('unpause restores behavior', function () {
    it('allows rebase again after unpause', async function () {
      await StakingVault.pause();
      await StakingVault.unpause();
      await expect(StakingVault.connect(rebaseManager).rebase(rebaseAmount))
        .to.emit(StakingVault, 'Rebase')
        .withArgs(rebaseAmount);
    });

    it('allows transfers again after unpause', async function () {
      await StakingVault.pause();
      await StakingVault.unpause();
      await expect(
        StakingVault.connect(user).transfer(
          await other.getAddress(),
          ethers.parseUnits('1', 18)
        )
      ).to.not.be.reverted;
      expect(await StakingVault.balanceOf(await other.getAddress())).to.equal(
        ethers.parseUnits('1', 18)
      );
    });

    it('allows deposits again after unpause', async function () {
      await StakingVault.pause();
      await StakingVault.unpause();
      const smallDeposit = ethers.parseUnits('1', 18);
      await expect(
        StakingVault.connect(user).deposit(
          smallDeposit,
          await user.getAddress()
        )
      ).to.not.be.reverted;
    });
  });

  describe('view-only access while paused', function () {
    it('does not block totalAssets / totalSupply / balanceOf', async function () {
      await StakingVault.pause();
      // These are pure view paths; they should not be gated by whenNotPaused.
      await expect(StakingVault.totalAssets()).to.not.be.reverted;
      await expect(StakingVault.totalSupply()).to.not.be.reverted;
      await expect(StakingVault.balanceOf(await user.getAddress())).to.not.be
        .reverted;
    });

    it('does not block role administration', async function () {
      await StakingVault.pause();
      const DEFAULT_ADMIN_ROLE = await StakingVault.DEFAULT_ADMIN_ROLE();
      await expect(
        StakingVault.grantRole(DEFAULT_ADMIN_ROLE, await admin.getAddress())
      ).to.not.be.reverted;
    });
  });
});
