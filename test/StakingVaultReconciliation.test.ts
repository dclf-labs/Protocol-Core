import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type {
  USN,
  StakingVaultOFTUpgradeable,
  EndpointV2Mock,
} from '../typechain-types';

const CHAIN_ID_SRC = 1;
const STUCK_MESSAGE_TIMELOCK = 48 * 60 * 60; // 48h, mirrors contract constant
const GUID_A = ethers.keccak256(ethers.toUtf8Bytes('guid-a'));
const GUID_B = ethers.keccak256(ethers.toUtf8Bytes('guid-b'));
const REASON = 'LayerZero DVN outage from April 19';

async function increaseTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

describe('StakingVaultOFTUpgradeable — stuck message reconciliation', function () {
  let USN: USN;
  let StakingVault: StakingVaultOFTUpgradeable;
  let endpointMock: EndpointV2Mock;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const initialMint = ethers.parseUnits('100000', 18);
  const stakeAmount = ethers.parseUnits('10000', 18);

  beforeEach(async function () {
    [owner, admin, user, outsider] = await ethers.getSigners();

    const EndpointV2Mock = await ethers.getContractFactory('EndpointV2Mock');
    endpointMock = await EndpointV2Mock.deploy(CHAIN_ID_SRC);

    const USNFactory = await ethers.getContractFactory('USN');
    USN = await USNFactory.deploy(await endpointMock.getAddress());
    await USN.enablePermissionless();
    // Owner is the USN admin by default after deploy — mint to user for staking.
    await USN.setAdmin(await owner.getAddress());
    await USN.mint(await user.getAddress(), initialMint);

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

    // User stakes — gets sUSN shares 1:1
    await USN.connect(user).approve(
      await StakingVault.getAddress(),
      ethers.MaxUint256
    );
    await StakingVault.connect(user).deposit(
      stakeAmount,
      await user.getAddress()
    );

    // Simulate a cross-chain send: the user's shares end up locked in the
    // vault's own balance (this is exactly what _debit does during OFT send).
    await StakingVault.connect(user).transfer(
      await StakingVault.getAddress(),
      stakeAmount
    );

    // Sanity: vault holds the locked shares, user holds none.
    expect(await StakingVault.balanceOf(await StakingVault.getAddress())).to.equal(
      stakeAmount
    );
    expect(await StakingVault.balanceOf(await user.getAddress())).to.equal(0n);
  });

  describe('STUCK_MESSAGE_TIMELOCK', function () {
    it('is a 48h hard floor exposed as a constant', async function () {
      expect(await StakingVault.STUCK_MESSAGE_TIMELOCK()).to.equal(
        STUCK_MESSAGE_TIMELOCK
      );
    });
  });

  describe('requestHandleFixIssue', function () {
    it('only DEFAULT_ADMIN_ROLE can call it', async function () {
      await expect(
        StakingVault.connect(outsider).requestHandleFixIssue(
          GUID_A,
          stakeAmount,
          REASON
        )
      ).to.be.reverted;
    });

    it('rejects the zero guid', async function () {
      await expect(
        StakingVault.requestHandleFixIssue(ethers.ZeroHash, stakeAmount, REASON)
      ).to.be.revertedWithCustomError(StakingVault, 'InvalidGuid');
    });

    it('rejects a zero amount', async function () {
      await expect(
        StakingVault.requestHandleFixIssue(GUID_A, 0n, REASON)
      ).to.be.revertedWithCustomError(StakingVault, 'InvalidAmount');
    });

    it('emits StuckMessageReconciliationRequested with the timelock target', async function () {
      const tx = await StakingVault.requestHandleFixIssue(
        GUID_A,
        stakeAmount,
        REASON
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      await expect(tx)
        .to.emit(StakingVault, 'StuckMessageReconciliationRequested')
        .withArgs(
          GUID_A,
          await owner.getAddress(),
          stakeAmount,
          BigInt(block!.timestamp) + BigInt(STUCK_MESSAGE_TIMELOCK),
          REASON
        );
    });

    it('rejects a duplicate request for the same guid while pending', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await expect(
        StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON)
      ).to.be.revertedWithCustomError(StakingVault, 'StuckMessageRequestExists');
    });

    it('rejects a re-request for an already-executed guid', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await StakingVault.validateExecuteHandleIssue(GUID_A);
      await expect(
        StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageRequestAlreadyExecuted'
      );
    });
  });

  describe('cancelHandleFixIssue', function () {
    it('only DEFAULT_ADMIN_ROLE can call it', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await expect(StakingVault.connect(outsider).cancelHandleFixIssue(GUID_A))
        .to.be.reverted;
    });

    it('reverts if no request exists', async function () {
      await expect(
        StakingVault.cancelHandleFixIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageRequestNotFound'
      );
    });

    it('cancels a pending request and emits an event', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await expect(StakingVault.cancelHandleFixIssue(GUID_A))
        .to.emit(StakingVault, 'StuckMessageReconciliationCancelled')
        .withArgs(GUID_A);
    });

    it('lets the same guid be re-queued after cancellation', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await StakingVault.cancelHandleFixIssue(GUID_A);
      await expect(
        StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON)
      ).to.not.be.reverted;
    });

    it('cannot cancel a request that has already executed', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await StakingVault.validateExecuteHandleIssue(GUID_A);
      await expect(
        StakingVault.cancelHandleFixIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageRequestAlreadyExecuted'
      );
    });
  });

  describe('validateExecuteHandleIssue', function () {
    it('only DEFAULT_ADMIN_ROLE can call it', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await expect(
        StakingVault.connect(outsider).validateExecuteHandleIssue(GUID_A)
      ).to.be.reverted;
    });

    it('reverts if there is no request for the guid', async function () {
      await expect(
        StakingVault.validateExecuteHandleIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageRequestNotFound'
      );
    });

    it('reverts if the 48h timelock has not elapsed', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      // Well short of the 48h floor.
      await increaseTime(STUCK_MESSAGE_TIMELOCK - 60);
      await expect(
        StakingVault.validateExecuteHandleIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageTimelockNotElapsed'
      );
    });

    it('executes exactly at requestedAt + STUCK_MESSAGE_TIMELOCK', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      // The next mined block lands STUCK_MESSAGE_TIMELOCK seconds later, hitting
      // the boundary exactly (block.timestamp == requestedAt + TIMELOCK).
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await expect(StakingVault.validateExecuteHandleIssue(GUID_A)).to.not.be
        .reverted;
    });

    it('reverts if the locked balance is below the requested amount', async function () {
      const tooMuch = stakeAmount + 1n;
      await StakingVault.requestHandleFixIssue(GUID_A, tooMuch, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await expect(
        StakingVault.validateExecuteHandleIssue(GUID_A)
      ).to.be.revertedWithCustomError(StakingVault, 'InsufficientLockedBalance');
    });

    it('transfers escrowed shares to owner() and emits StuckMessageReconciled', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);

      const ownerSharesBefore = await StakingVault.balanceOf(
        await owner.getAddress()
      );
      const vaultSharesBefore = await StakingVault.balanceOf(
        await StakingVault.getAddress()
      );

      await expect(StakingVault.validateExecuteHandleIssue(GUID_A))
        .to.emit(StakingVault, 'StuckMessageReconciled')
        .withArgs(GUID_A, await owner.getAddress(), stakeAmount);

      expect(await StakingVault.balanceOf(await owner.getAddress())).to.equal(
        ownerSharesBefore + stakeAmount
      );
      expect(
        await StakingVault.balanceOf(await StakingVault.getAddress())
      ).to.equal(vaultSharesBefore - stakeAmount);
    });

    it('cannot be replayed for the same guid', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await StakingVault.validateExecuteHandleIssue(GUID_A);
      await expect(
        StakingVault.validateExecuteHandleIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageRequestAlreadyExecuted'
      );
    });

    it('tracks distinct guids independently', async function () {
      const half = stakeAmount / 2n;
      await StakingVault.requestHandleFixIssue(GUID_A, half, REASON);
      await StakingVault.requestHandleFixIssue(GUID_B, half, REASON);
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await StakingVault.validateExecuteHandleIssue(GUID_A);
      // Second guid still has its own pending request; not blocked by GUID_A.
      await expect(StakingVault.validateExecuteHandleIssue(GUID_B)).to.not.be
        .reverted;
      expect(await StakingVault.balanceOf(await owner.getAddress())).to.equal(
        stakeAmount
      );
    });

    it('honors a fresh request that was re-queued after cancel', async function () {
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await StakingVault.cancelHandleFixIssue(GUID_A);
      // Re-request resets the timelock — old elapsed time should not count.
      await StakingVault.requestHandleFixIssue(GUID_A, stakeAmount, REASON);
      await expect(
        StakingVault.validateExecuteHandleIssue(GUID_A)
      ).to.be.revertedWithCustomError(
        StakingVault,
        'StuckMessageTimelockNotElapsed'
      );
      await increaseTime(STUCK_MESSAGE_TIMELOCK);
      await expect(StakingVault.validateExecuteHandleIssue(GUID_A)).to.not.be
        .reverted;
    });
  });

  describe('admin-role grant/revoke surface', function () {
    it('respects a freshly granted admin role', async function () {
      const DEFAULT_ADMIN_ROLE = await StakingVault.DEFAULT_ADMIN_ROLE();
      await StakingVault.grantRole(
        DEFAULT_ADMIN_ROLE,
        await admin.getAddress()
      );
      await expect(
        StakingVault.connect(admin).requestHandleFixIssue(
          GUID_A,
          stakeAmount,
          REASON
        )
      ).to.not.be.reverted;
    });
  });
});
