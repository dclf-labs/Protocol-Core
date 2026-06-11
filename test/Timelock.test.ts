import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { Timelock, MockProxyAdmin } from '../typechain-types';

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  return block.timestamp;
}

async function increaseTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

const ONE_DAY = 24 * 60 * 60;
const MIN_DELAY = ONE_DAY;
const MAX_DELAY = 2 * ONE_DAY;
const OWNERSHIP_TRANSFER_DELAY = 2 * ONE_DAY;

describe('Timelock', function () {
  let timelock: Timelock;
  let proxyAdmin: MockProxyAdmin;
  let owner: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let proxy: HardhatEthersSigner;
  let implementation: HardhatEthersSigner;

  const initialDelay = ONE_DAY;
  const sampleData = '0xdeadbeef';

  async function opId(
    pa: string,
    p: string,
    impl: string,
    data: string,
  ): Promise<string> {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'address', 'bytes'],
        [pa, p, impl, data],
      ),
    );
  }

  async function ownershipOpId(pa: string, no: string): Promise<string> {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address'],
        [pa, no],
      ),
    );
  }

  beforeEach(async function () {
    [owner, outsider, newOwner, proxy, implementation] =
      await ethers.getSigners();

    const MockProxyAdminFactory =
      await ethers.getContractFactory('MockProxyAdmin');
    proxyAdmin = await MockProxyAdminFactory.deploy();

    const TimelockFactory = await ethers.getContractFactory('Timelock');
    timelock = await TimelockFactory.deploy(
      await owner.getAddress(),
      initialDelay,
    );
  });

  describe('constructor', function () {
    it('sets owner and delay', async function () {
      expect(await timelock.owner()).to.equal(await owner.getAddress());
      expect(await timelock.delay()).to.equal(initialDelay);
    });

    it('emits DelayUpdated(0, initialDelay)', async function () {
      const TimelockFactory = await ethers.getContractFactory('Timelock');
      const tl = await TimelockFactory.deploy(
        await owner.getAddress(),
        MIN_DELAY,
      );
      await tl.waitForDeployment();
      await expect(tl.deploymentTransaction())
        .to.emit(tl, 'DelayUpdated')
        .withArgs(0, MIN_DELAY);
    });

    it('reverts when initialDelay < MIN_DELAY', async function () {
      const TimelockFactory = await ethers.getContractFactory('Timelock');
      await expect(
        TimelockFactory.deploy(await owner.getAddress(), MIN_DELAY - 1),
      ).to.be.revertedWithCustomError(timelock, 'DelayTooShort');
    });

    it('reverts when initialDelay > MAX_DELAY', async function () {
      const TimelockFactory = await ethers.getContractFactory('Timelock');
      await expect(
        TimelockFactory.deploy(await owner.getAddress(), MAX_DELAY + 1),
      ).to.be.revertedWithCustomError(timelock, 'DelayTooLong');
    });

    it('accepts MIN_DELAY and MAX_DELAY boundaries', async function () {
      const TimelockFactory = await ethers.getContractFactory('Timelock');
      const tlMin = await TimelockFactory.deploy(
        await owner.getAddress(),
        MIN_DELAY,
      );
      const tlMax = await TimelockFactory.deploy(
        await owner.getAddress(),
        MAX_DELAY,
      );
      expect(await tlMin.delay()).to.equal(MIN_DELAY);
      expect(await tlMax.delay()).to.equal(MAX_DELAY);
    });

    it('exposes the constant delays', async function () {
      expect(await timelock.MIN_DELAY()).to.equal(MIN_DELAY);
      expect(await timelock.MAX_DELAY()).to.equal(MAX_DELAY);
      expect(await timelock.OWNERSHIP_TRANSFER_DELAY()).to.equal(
        OWNERSHIP_TRANSFER_DELAY,
      );
    });
  });

  describe('getOperationId / getOwnershipTransferOperationId', function () {
    it('getOperationId matches keccak256(abi.encode(...))', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      const expected = await opId(pa, p, impl, sampleData);
      expect(
        await timelock.getOperationId(pa, p, impl, sampleData),
      ).to.equal(expected);
    });

    it('different inputs produce different ids', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      const a = await timelock.getOperationId(pa, p, impl, sampleData);
      const b = await timelock.getOperationId(pa, p, impl, '0xdead');
      expect(a).to.not.equal(b);
    });

    it('getOwnershipTransferOperationId matches keccak256(abi.encode(...))', async function () {
      const pa = await proxyAdmin.getAddress();
      const no = await newOwner.getAddress();
      const expected = await ownershipOpId(pa, no);
      expect(
        await timelock.getOwnershipTransferOperationId(pa, no),
      ).to.equal(expected);
    });
  });

  describe('scheduleUpgrade', function () {
    it('only owner can schedule', async function () {
      await expect(
        timelock
          .connect(outsider)
          .scheduleUpgrade(
            await proxyAdmin.getAddress(),
            await proxy.getAddress(),
            await implementation.getAddress(),
            sampleData,
          ),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('records scheduledAt and emits UpgradeScheduled', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      const id = await opId(pa, p, impl, sampleData);

      const tx = await timelock.scheduleUpgrade(pa, p, impl, sampleData);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await timelock.scheduledAt(id)).to.equal(block!.timestamp);
      await expect(tx)
        .to.emit(timelock, 'UpgradeScheduled')
        .withArgs(pa, p, impl, id);
    });

    it('reverts when the same op is scheduled twice', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);
      await expect(
        timelock.scheduleUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'OperationAlreadyScheduled');
    });

    it('allows independent scheduling of distinct ops', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);
      await expect(timelock.scheduleUpgrade(pa, p, impl, '0xbeef')).to.not.be
        .reverted;
    });
  });

  describe('executeUpgrade', function () {
    let pa: string;
    let p: string;
    let impl: string;

    beforeEach(async function () {
      pa = await proxyAdmin.getAddress();
      p = await proxy.getAddress();
      impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);
    });

    it('only owner can execute', async function () {
      await increaseTime(initialDelay);
      await expect(
        timelock
          .connect(outsider)
          .executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('reverts OperationNotScheduled for unscheduled op', async function () {
      await expect(
        timelock.executeUpgrade(pa, p, impl, '0xfeed'),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('reverts DelayNotElapsed before delay passes', async function () {
      await increaseTime(initialDelay - 60);
      await expect(
        timelock.executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'DelayNotElapsed');
    });

    it('forwards the call to ProxyAdmin after delay and emits UpgradeExecuted', async function () {
      await increaseTime(initialDelay);
      const id = await opId(pa, p, impl, sampleData);
      const tx = await timelock.executeUpgrade(pa, p, impl, sampleData);
      await expect(tx)
        .to.emit(timelock, 'UpgradeExecuted')
        .withArgs(pa, p, impl, id);
      await expect(tx)
        .to.emit(proxyAdmin, 'UpgradeAndCallReceived')
        .withArgs(p, impl, sampleData, 0);

      expect(await proxyAdmin.upgradeAndCallCount()).to.equal(1);
      expect(await proxyAdmin.lastProxy()).to.equal(p);
      expect(await proxyAdmin.lastImplementation()).to.equal(impl);
      expect(await proxyAdmin.lastData()).to.equal(sampleData);
      expect(await timelock.scheduledAt(id)).to.equal(0);
    });

    it('forwards msg.value to ProxyAdmin', async function () {
      await increaseTime(initialDelay);
      const value = ethers.parseEther('0.42');
      await timelock.executeUpgrade(pa, p, impl, sampleData, {
        value,
      });
      expect(await proxyAdmin.lastValue()).to.equal(value);
      expect(
        await ethers.provider.getBalance(await proxyAdmin.getAddress()),
      ).to.equal(value);
    });

    it('cannot be replayed after a successful execute', async function () {
      await increaseTime(initialDelay);
      await timelock.executeUpgrade(pa, p, impl, sampleData);
      await expect(
        timelock.executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('allows re-scheduling after execute', async function () {
      await increaseTime(initialDelay);
      await timelock.executeUpgrade(pa, p, impl, sampleData);
      await expect(timelock.scheduleUpgrade(pa, p, impl, sampleData)).to.not.be
        .reverted;
    });

    it('bubbles up a revert from ProxyAdmin and leaves scheduledAt set', async function () {
      await proxyAdmin.setShouldRevert(true, 'proxy-admin-blew-up');
      await increaseTime(initialDelay);
      await expect(
        timelock.executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWith('proxy-admin-blew-up');
      const id = await opId(pa, p, impl, sampleData);
      expect(await timelock.scheduledAt(id)).to.not.equal(0);
    });
  });

  describe('cancelUpgrade', function () {
    let pa: string;
    let p: string;
    let impl: string;

    beforeEach(async function () {
      pa = await proxyAdmin.getAddress();
      p = await proxy.getAddress();
      impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);
    });

    it('only owner can cancel', async function () {
      await expect(
        timelock
          .connect(outsider)
          .cancelUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('reverts OperationNotScheduled if not scheduled', async function () {
      await expect(
        timelock.cancelUpgrade(pa, p, impl, '0xfeed'),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('clears scheduledAt and emits UpgradeCancelled', async function () {
      const id = await opId(pa, p, impl, sampleData);
      await expect(timelock.cancelUpgrade(pa, p, impl, sampleData))
        .to.emit(timelock, 'UpgradeCancelled')
        .withArgs(pa, p, impl, id);
      expect(await timelock.scheduledAt(id)).to.equal(0);
    });

    it('prevents execute after cancel', async function () {
      await timelock.cancelUpgrade(pa, p, impl, sampleData);
      await increaseTime(initialDelay);
      await expect(
        timelock.executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('allows re-scheduling after cancel', async function () {
      await timelock.cancelUpgrade(pa, p, impl, sampleData);
      await expect(timelock.scheduleUpgrade(pa, p, impl, sampleData)).to.not.be
        .reverted;
    });
  });

  describe('setDelay', function () {
    it('only owner can set delay', async function () {
      await expect(
        timelock.connect(outsider).setDelay(MAX_DELAY),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('rejects newDelay < MIN_DELAY', async function () {
      await expect(
        timelock.setDelay(MIN_DELAY - 1),
      ).to.be.revertedWithCustomError(timelock, 'DelayTooShort');
    });

    it('rejects newDelay > MAX_DELAY', async function () {
      await expect(
        timelock.setDelay(MAX_DELAY + 1),
      ).to.be.revertedWithCustomError(timelock, 'DelayTooLong');
    });

    it('rejects a decrease (newDelay < current)', async function () {
      await timelock.setDelay(MAX_DELAY);
      await expect(
        timelock.setDelay(MIN_DELAY),
      ).to.be.revertedWithCustomError(timelock, 'DelayTooShort');
    });

    it('accepts an increase and emits DelayUpdated', async function () {
      const previous = await timelock.delay();
      await expect(timelock.setDelay(MAX_DELAY))
        .to.emit(timelock, 'DelayUpdated')
        .withArgs(previous, MAX_DELAY);
      expect(await timelock.delay()).to.equal(MAX_DELAY);
    });

    it('accepts equal delay (no-op)', async function () {
      await expect(timelock.setDelay(initialDelay)).to.not.be.reverted;
      expect(await timelock.delay()).to.equal(initialDelay);
    });

    it('extends the wait for already-scheduled operations', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);

      await timelock.setDelay(MAX_DELAY);

      // After the old delay elapses, the new (larger) delay still blocks it.
      await increaseTime(initialDelay);
      await expect(
        timelock.executeUpgrade(pa, p, impl, sampleData),
      ).to.be.revertedWithCustomError(timelock, 'DelayNotElapsed');

      // After the additional time, it succeeds.
      await increaseTime(MAX_DELAY - initialDelay);
      await expect(timelock.executeUpgrade(pa, p, impl, sampleData)).to.not.be
        .reverted;
    });
  });

  describe('getExecuteAfter', function () {
    it('returns 0 when not scheduled', async function () {
      expect(
        await timelock.getExecuteAfter(
          await proxyAdmin.getAddress(),
          await proxy.getAddress(),
          await implementation.getAddress(),
          sampleData,
        ),
      ).to.equal(0);
    });

    it('returns scheduledAt + delay when scheduled', async function () {
      const pa = await proxyAdmin.getAddress();
      const p = await proxy.getAddress();
      const impl = await implementation.getAddress();
      await timelock.scheduleUpgrade(pa, p, impl, sampleData);
      const at = await latestTimestamp();
      expect(
        await timelock.getExecuteAfter(pa, p, impl, sampleData),
      ).to.equal(at + initialDelay);
    });
  });

  describe('scheduleProxyAdminOwnershipTransfer', function () {
    it('only owner', async function () {
      await expect(
        timelock
          .connect(outsider)
          .scheduleProxyAdminOwnershipTransfer(
            await proxyAdmin.getAddress(),
            await newOwner.getAddress(),
          ),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('records the scheduled timestamp and emits event', async function () {
      const pa = await proxyAdmin.getAddress();
      const no = await newOwner.getAddress();
      const id = await ownershipOpId(pa, no);
      const tx = await timelock.scheduleProxyAdminOwnershipTransfer(pa, no);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await timelock.scheduledOwnershipTransferAt(id)).to.equal(
        block!.timestamp,
      );
      await expect(tx)
        .to.emit(timelock, 'ProxyAdminOwnershipTransferScheduled')
        .withArgs(pa, no, id);
    });

    it('rejects double-scheduling the same transfer', async function () {
      const pa = await proxyAdmin.getAddress();
      const no = await newOwner.getAddress();
      await timelock.scheduleProxyAdminOwnershipTransfer(pa, no);
      await expect(
        timelock.scheduleProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWithCustomError(timelock, 'OperationAlreadyScheduled');
    });
  });

  describe('executeProxyAdminOwnershipTransfer', function () {
    let pa: string;
    let no: string;

    beforeEach(async function () {
      pa = await proxyAdmin.getAddress();
      no = await newOwner.getAddress();
      await timelock.scheduleProxyAdminOwnershipTransfer(pa, no);
    });

    it('only owner', async function () {
      await increaseTime(OWNERSHIP_TRANSFER_DELAY);
      await expect(
        timelock
          .connect(outsider)
          .executeProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('reverts OperationNotScheduled if not scheduled', async function () {
      await increaseTime(OWNERSHIP_TRANSFER_DELAY);
      await expect(
        timelock.executeProxyAdminOwnershipTransfer(
          pa,
          await outsider.getAddress(),
        ),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('reverts DelayNotElapsed before delay passes', async function () {
      await increaseTime(OWNERSHIP_TRANSFER_DELAY - 60);
      await expect(
        timelock.executeProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWithCustomError(timelock, 'DelayNotElapsed');
    });

    it('forwards transferOwnership and clears scheduledAt', async function () {
      await increaseTime(OWNERSHIP_TRANSFER_DELAY);
      const id = await ownershipOpId(pa, no);
      const tx = await timelock.executeProxyAdminOwnershipTransfer(pa, no);
      await expect(tx)
        .to.emit(timelock, 'ProxyAdminOwnershipTransferExecuted')
        .withArgs(pa, no, id);
      await expect(tx)
        .to.emit(proxyAdmin, 'TransferOwnershipReceived')
        .withArgs(no);

      expect(await proxyAdmin.transferOwnershipCount()).to.equal(1);
      expect(await proxyAdmin.lastNewOwner()).to.equal(no);
      expect(await timelock.scheduledOwnershipTransferAt(id)).to.equal(0);
    });

    it('bubbles up a revert from ProxyAdmin and leaves scheduledAt set', async function () {
      await proxyAdmin.setShouldRevert(true, 'transfer-blew-up');
      await increaseTime(OWNERSHIP_TRANSFER_DELAY);
      await expect(
        timelock.executeProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWith('transfer-blew-up');
      const id = await ownershipOpId(pa, no);
      expect(await timelock.scheduledOwnershipTransferAt(id)).to.not.equal(0);
    });
  });

  describe('cancelProxyAdminOwnershipTransfer', function () {
    let pa: string;
    let no: string;

    beforeEach(async function () {
      pa = await proxyAdmin.getAddress();
      no = await newOwner.getAddress();
      await timelock.scheduleProxyAdminOwnershipTransfer(pa, no);
    });

    it('only owner', async function () {
      await expect(
        timelock
          .connect(outsider)
          .cancelProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('reverts OperationNotScheduled if not scheduled', async function () {
      await expect(
        timelock.cancelProxyAdminOwnershipTransfer(
          pa,
          await outsider.getAddress(),
        ),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });

    it('clears scheduledAt and emits event', async function () {
      const id = await ownershipOpId(pa, no);
      await expect(timelock.cancelProxyAdminOwnershipTransfer(pa, no))
        .to.emit(timelock, 'ProxyAdminOwnershipTransferCancelled')
        .withArgs(pa, no, id);
      expect(await timelock.scheduledOwnershipTransferAt(id)).to.equal(0);
    });

    it('prevents execute after cancel', async function () {
      await timelock.cancelProxyAdminOwnershipTransfer(pa, no);
      await increaseTime(OWNERSHIP_TRANSFER_DELAY);
      await expect(
        timelock.executeProxyAdminOwnershipTransfer(pa, no),
      ).to.be.revertedWithCustomError(timelock, 'OperationNotScheduled');
    });
  });

  describe('getOwnershipTransferExecuteAfter', function () {
    it('returns 0 when not scheduled', async function () {
      expect(
        await timelock.getOwnershipTransferExecuteAfter(
          await proxyAdmin.getAddress(),
          await newOwner.getAddress(),
        ),
      ).to.equal(0);
    });

    it('returns scheduledAt + OWNERSHIP_TRANSFER_DELAY when scheduled', async function () {
      const pa = await proxyAdmin.getAddress();
      const no = await newOwner.getAddress();
      await timelock.scheduleProxyAdminOwnershipTransfer(pa, no);
      const at = await latestTimestamp();
      expect(
        await timelock.getOwnershipTransferExecuteAfter(pa, no),
      ).to.equal(at + OWNERSHIP_TRANSFER_DELAY);
    });
  });

  describe('Ownable2Step ownership handover', function () {
    it('transferOwnership does not change owner until acceptOwnership', async function () {
      await timelock.transferOwnership(await newOwner.getAddress());
      expect(await timelock.owner()).to.equal(await owner.getAddress());
      expect(await timelock.pendingOwner()).to.equal(
        await newOwner.getAddress(),
      );

      await timelock.connect(newOwner).acceptOwnership();
      expect(await timelock.owner()).to.equal(await newOwner.getAddress());
    });

    it('old owner loses access after the handover completes', async function () {
      await timelock.transferOwnership(await newOwner.getAddress());
      await timelock.connect(newOwner).acceptOwnership();

      await expect(timelock.setDelay(MAX_DELAY)).to.be.revertedWithCustomError(
        timelock,
        'OwnableUnauthorizedAccount',
      );
      await expect(timelock.connect(newOwner).setDelay(MAX_DELAY)).to.not.be
        .reverted;
    });
  });
});
