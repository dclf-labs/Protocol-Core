import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type {
  SelectiveTimelock,
  USNUpgradeableHyperlane,
} from '../typechain-types';

const HOUR = 3600n;
const DAY = 24n * HOUR;
const ADMIN_DELAY = 24n * HOUR; // USN.setAdmin
const OWNER_DELAY = 48n * HOUR; // USN.transferOwnership / renounceOwnership
const MAX_DELAY = 30n * DAY;
const GRACE = 14n * DAY;
const NONE = ''; // empty signature: data is raw calldata
// Every owner function on USN that reaches minting or the bridge trust set.
const MINT_PATHS = [
  'setAdmin', // the admin is the sole minter
  'configureHyperlane', // a hostile mailbox calls handle() and mints
  'configureISM', // a permissive ISM lets forged Hyperlane messages through
  'registerHyperlaneRemoteToken', // a hostile remote token mints through a real message
  'setPeer', // a hostile LayerZero peer mints through lzReceive
  'setDelegate', // the delegate rewrites DVN / receive-library config at the endpoint
  'setRateLimiter', // address(0) removes the bridge caps
];
const OWNER_PATHS = ['transferOwnership', 'renounceOwnership']; // leaving the timelock

describe('SelectiveTimelock', function () {
  let safe: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let newAdmin: HardhatEthersSigner;
  let usn: USNUpgradeableHyperlane;
  let tl: SelectiveTimelock;
  let usnAddr: string;
  let tlAddr: string;
  let usnIface: any;

  const sel = (fn: string) => usnIface.getFunction(fn).selector as string;
  const enc = (fn: string, args: any[] = []) =>
    usnIface.encodeFunctionData(fn, args) as string;
  const now = async () => BigInt(await time.latest());
  const setDelay = async (fn: string, d: bigint) => {
    await tl.scheduleDelayChange(usnAddr, sel(fn), d);
    await tl.executeDelayChange(usnAddr, sel(fn)); // current delay 0 -> immediate
  };

  beforeEach(async function () {
    [safe, other, stranger, newAdmin] = await ethers.getSigners();

    const Endpoint = await ethers.getContractFactory('EndpointV2Mock');
    const endpoint = await Endpoint.deploy(1);
    const USN = await ethers.getContractFactory('USNUpgradeableHyperlane');
    usnIface = USN.interface;
    const proxy = await upgrades.deployProxy(
      USN,
      ['USN', 'USN', safe.address],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    usn = USN.attach(
      await proxy.getAddress()
    ) as unknown as USNUpgradeableHyperlane;
    usnAddr = await usn.getAddress();
    await usn.enablePermissionless();
    await usn.setAdmin(safe.address);

    const TL = await ethers.getContractFactory('SelectiveTimelock');
    tl = (await TL.deploy(safe.address)) as unknown as SelectiveTimelock;
    tlAddr = await tl.getAddress();

    // wiring: mint paths 24h; transferOwnership / renounceOwnership 48h; everything else direct
    for (const fn of MINT_PATHS) await setDelay(fn, ADMIN_DELAY);
    for (const fn of OWNER_PATHS) await setDelay(fn, OWNER_DELAY);

    // hand USN over (Ownable2Step): Safe transfers, timelock accepts through the direct path
    await usn.transferOwnership(tlAddr);
    await tl.call(usnAddr, 0, NONE, enc('acceptOwnership'));
    expect(await usn.owner()).to.equal(tlAddr);
  });

  describe('construction and wiring', function () {
    it('stores per-selector delays, zero elsewhere', async function () {
      expect(await tl.owner()).to.equal(safe.address);
      expect(await tl.MAX_DELAY()).to.equal(MAX_DELAY);
      expect(await tl.GRACE_PERIOD()).to.equal(GRACE);
      for (const fn of MINT_PATHS)
        expect(await tl.delay(usnAddr, sel(fn)), fn).to.equal(ADMIN_DELAY);
      for (const fn of OWNER_PATHS)
        expect(await tl.delay(usnAddr, sel(fn)), fn).to.equal(OWNER_DELAY);
      for (const fn of [
        'pause',
        'unpause',
        'blacklistAccount',
        'unblacklistAccount',
        'addToWhitelist',
        'removeFromWhitelist',
        'enablePermissionless',
        'setEnforcedOptions',
        'setMsgInspector',
        'setPreCrime',
      ])
        expect(await tl.delay(usnAddr, sel(fn)), fn).to.equal(0);
    });
    it('delayFor resolves both calldata conventions', async function () {
      expect(await tl.delayFor(usnAddr, NONE, enc('pause'))).to.equal(0);
      expect(
        await tl.delayFor(usnAddr, NONE, enc('setAdmin', [newAdmin.address]))
      ).to.equal(ADMIN_DELAY);
      expect(
        await tl.delayFor(
          usnAddr,
          'setAdmin(address)',
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address'],
            [newAdmin.address]
          )
        )
      ).to.equal(ADMIN_DELAY);
      await expect(
        tl.delayFor(usnAddr, NONE, '0x1234')
      ).to.be.revertedWithCustomError(tl, 'BadCalldata');
    });
  });

  describe('direct path (call)', function () {
    it('owner pauses, unpauses, blacklists and whitelists immediately', async function () {
      await expect(
        tl.call(usnAddr, 0, NONE, enc('addToWhitelist', [stranger.address]))
      )
        .to.emit(tl, 'DirectCall')
        .withArgs(
          usnAddr,
          0,
          NONE,
          enc('addToWhitelist', [stranger.address]),
          '0x'
        );
      expect(await usn.isWhitelisted(stranger.address)).to.equal(true);
      await tl.call(usnAddr, 0, 'pause()', '0x');
      expect(await usn.paused()).to.equal(true);
      await tl.call(usnAddr, 0, NONE, enc('unpause'));
      expect(await usn.paused()).to.equal(false);
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('blacklistAccount', [stranger.address])
      );
      expect(await usn.blacklist(stranger.address)).to.equal(true);
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('unblacklistAccount', [stranger.address])
      );
      expect(await usn.blacklist(stranger.address)).to.equal(false);
    });
    it('refuses delayed selectors in both conventions and reports the delay', async function () {
      await expect(
        tl.call(usnAddr, 0, NONE, enc('setAdmin', [newAdmin.address]))
      )
        .to.be.revertedWithCustomError(tl, 'SelectorIsDelayed')
        .withArgs(usnAddr, sel('setAdmin'), ADMIN_DELAY);
      await expect(
        tl.call(
          usnAddr,
          0,
          'setAdmin(address)',
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address'],
            [newAdmin.address]
          )
        )
      )
        .to.be.revertedWithCustomError(tl, 'SelectorIsDelayed')
        .withArgs(usnAddr, sel('setAdmin'), ADMIN_DELAY);
      await expect(
        tl.call(usnAddr, 0, NONE, enc('transferOwnership', [stranger.address]))
      )
        .to.be.revertedWithCustomError(tl, 'SelectorIsDelayed')
        .withArgs(usnAddr, sel('transferOwnership'), OWNER_DELAY);
      await expect(
        tl.call(usnAddr, 0, NONE, enc('renounceOwnership'))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
      expect(await usn.admin()).to.equal(safe.address);
      expect(await usn.owner()).to.equal(tlAddr);
    });
    it('only the owner', async function () {
      await expect(
        tl.connect(other).call(usnAddr, 0, NONE, enc('pause'))
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      expect(await usn.paused()).to.equal(false);
    });
    it("cannot reach the timelock's own owner functions through itself", async function () {
      // msg.sender would be the timelock, not the owner
      await expect(
        tl.call(
          tlAddr,
          0,
          NONE,
          tl.interface.encodeFunctionData('scheduleDelayChange', [
            usnAddr,
            sel('setAdmin'),
            0,
          ])
        )
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
      expect(await tl.pendingDelayEta(usnAddr, sel('setAdmin'))).to.equal(0);
    });
    it('bubbles target reverts and checks value / calldata shape', async function () {
      await expect(
        tl.call(usnAddr, 0, NONE, enc('unpause')) // USN: ExpectedPause
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
      await expect(
        tl.call(usnAddr, 1, NONE, enc('pause'))
      ).to.be.revertedWithCustomError(tl, 'ValueMismatch');
      await expect(
        tl.call(usnAddr, 0, NONE, '0x1234')
      ).to.be.revertedWithCustomError(tl, 'BadCalldata');
    });
  });

  describe('queue / execute / cancel: setAdmin (24h)', function () {
    let data: string;
    let eta: bigint;
    let opHash: string;
    beforeEach(async function () {
      data = enc('setAdmin', [newAdmin.address]);
      eta = (await now()) + ADMIN_DELAY + 60n;
      opHash = await tl.hashOperation(usnAddr, 0, NONE, data, eta);
    });

    it('queue enforces eta >= now + the pair delay', async function () {
      const tooSoon = (await now()) + ADMIN_DELAY - HOUR;
      await expect(
        tl.queue(usnAddr, 0, NONE, data, tooSoon)
      ).to.be.revertedWithCustomError(tl, 'EtaTooSoon');
      await expect(tl.queue(usnAddr, 0, NONE, data, eta))
        .to.emit(tl, 'OperationQueued')
        .withArgs(opHash, usnAddr, 0, NONE, data, eta);
      expect(await tl.queued(opHash)).to.equal(true);
      await expect(
        tl.queue(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationAlreadyQueued');
    });
    it('executes from the eta, once, and changes the admin', async function () {
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotReady');
      await time.increaseTo(eta - 2n); // next block mines at eta - 1
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotReady');
      await time.increaseTo(eta);
      await expect(tl.execute(usnAddr, 0, NONE, data, eta))
        .to.emit(tl, 'OperationExecuted')
        .withArgs(opHash, usnAddr, 0, NONE, data, '0x');
      expect(await usn.admin()).to.equal(newAdmin.address);
      expect(await tl.queued(opHash)).to.equal(false);
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotQueued');
    });
    it('signature convention works end to end', async function () {
      const args = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [newAdmin.address]
      );
      await tl.queue(usnAddr, 0, 'setAdmin(address)', args, eta);
      expect(await tl.buildCalldata('setAdmin(address)', args)).to.equal(data);
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, 'setAdmin(address)', args, eta);
      expect(await usn.admin()).to.equal(newAdmin.address);
    });
    it('each selector waits its own delay', async function () {
      const own = enc('transferOwnership', [stranger.address]);
      await expect(
        tl.queue(usnAddr, 0, NONE, own, eta) // 24h+60s < 48h
      ).to.be.revertedWithCustomError(tl, 'EtaTooSoon');
      const ownEta = (await now()) + OWNER_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, own, ownEta);
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, NONE, data, eta);
      await expect(
        tl.execute(usnAddr, 0, NONE, own, ownEta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotReady');
      await time.increaseTo(ownEta);
      await tl.execute(usnAddr, 0, NONE, own, ownEta);
      expect(await usn.pendingOwner()).to.equal(stranger.address);
    });
    it('expires after the grace period', async function () {
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await time.increaseTo(eta + GRACE + 1n);
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationExpired');
      expect(await usn.admin()).to.equal(safe.address);
    });
    it('cancel removes it', async function () {
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await expect(tl.cancel(usnAddr, 0, NONE, data, eta))
        .to.emit(tl, 'OperationCancelled')
        .withArgs(opHash);
      await expect(
        tl.cancel(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotQueued');
      await time.increaseTo(eta);
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotQueued');
    });
    it('only the owner queues / executes / cancels', async function () {
      await expect(
        tl.connect(other).queue(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await time.increaseTo(eta);
      await expect(
        tl.connect(other).execute(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await expect(
        tl.connect(other).cancel(usnAddr, 0, NONE, data, eta)
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
    });
    it('value must match and target reverts bubble up', async function () {
      const bad = enc('setAdmin', [ethers.ZeroAddress]);
      await tl.queue(usnAddr, 0, NONE, bad, eta);
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await time.increaseTo(eta);
      await expect(
        tl.execute(usnAddr, 0, NONE, bad, eta)
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
      await expect(
        tl.execute(usnAddr, 0, NONE, data, eta, { value: 1 })
      ).to.be.revertedWithCustomError(tl, 'ValueMismatch');
    });
    it('zero-delay calls may still be queued (eta >= now) while the direct path stays open', async function () {
      const wl = enc('addToWhitelist', [stranger.address]);
      const soon = (await now()) + 60n;
      await tl.queue(usnAddr, 0, NONE, wl, soon);
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('removeFromWhitelist', [stranger.address])
      );
      await time.increaseTo(soon);
      await tl.execute(usnAddr, 0, NONE, wl, soon);
      expect(await usn.isWhitelisted(stranger.address)).to.equal(true);
    });
  });

  describe('delay changes (two-step, current delay applies)', function () {
    it('lowering setAdmin from 24h to 0 waits 24h, then the pair is direct', async function () {
      const tx = await tl.scheduleDelayChange(usnAddr, sel('setAdmin'), 0);
      const ts = BigInt((await tx.getBlock())!.timestamp);
      await expect(tx)
        .to.emit(tl, 'DelayChangeScheduled')
        .withArgs(usnAddr, sel('setAdmin'), 0, ts + ADMIN_DELAY);
      expect(await tl.pendingDelay(usnAddr, sel('setAdmin'))).to.equal(0);
      expect(await tl.pendingDelayEta(usnAddr, sel('setAdmin'))).to.equal(
        ts + ADMIN_DELAY
      );
      await expect(
        tl.executeDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'DelayChangeNotReady');
      await expect(
        tl.call(usnAddr, 0, NONE, enc('setAdmin', [newAdmin.address]))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed'); // still 24h meanwhile
      await time.increaseTo(ts + ADMIN_DELAY);
      await expect(tl.executeDelayChange(usnAddr, sel('setAdmin')))
        .to.emit(tl, 'DelayUpdated')
        .withArgs(usnAddr, sel('setAdmin'), ADMIN_DELAY, 0);
      expect(await tl.delay(usnAddr, sel('setAdmin'))).to.equal(0);
      expect(await tl.pendingDelayEta(usnAddr, sel('setAdmin'))).to.equal(0);
      await tl.call(usnAddr, 0, NONE, enc('setAdmin', [newAdmin.address]));
      expect(await usn.admin()).to.equal(newAdmin.address);
    });
    it('raising also waits the current delay; a new pair is immediate', async function () {
      await tl.scheduleDelayChange(usnAddr, sel('setAdmin'), 72n * HOUR);
      await expect(
        tl.executeDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'DelayChangeNotReady');
      await time.increase(ADMIN_DELAY);
      await tl.executeDelayChange(usnAddr, sel('setAdmin'));
      expect(await tl.delay(usnAddr, sel('setAdmin'))).to.equal(72n * HOUR);
      // fresh pair: current 0 -> executable right away
      await tl.scheduleDelayChange(usnAddr, sel('addToWhitelist'), 6n * HOUR);
      await tl.executeDelayChange(usnAddr, sel('addToWhitelist'));
      expect(await tl.delay(usnAddr, sel('addToWhitelist'))).to.equal(
        6n * HOUR
      );
      await expect(
        tl.call(usnAddr, 0, NONE, enc('addToWhitelist', [stranger.address]))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
    });
    it('one pending change per pair; cancel clears it', async function () {
      await tl.scheduleDelayChange(usnAddr, sel('setAdmin'), 0);
      await expect(
        tl.scheduleDelayChange(usnAddr, sel('setAdmin'), HOUR)
      ).to.be.revertedWithCustomError(tl, 'DelayChangeAlreadyPending');
      await tl.scheduleDelayChange(usnAddr, sel('transferOwnership'), 0); // other pair is independent
      await expect(tl.cancelDelayChange(usnAddr, sel('setAdmin')))
        .to.emit(tl, 'DelayChangeCancelled')
        .withArgs(usnAddr, sel('setAdmin'), 0);
      await expect(
        tl.cancelDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'NoPendingDelayChange');
      await expect(
        tl.executeDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'NoPendingDelayChange');
      await time.increase(ADMIN_DELAY);
      expect(await tl.delay(usnAddr, sel('setAdmin'))).to.equal(ADMIN_DELAY);
    });
    it('bounds, zero target, owner only', async function () {
      await expect(
        tl.scheduleDelayChange(usnAddr, sel('setAdmin'), MAX_DELAY + 1n)
      ).to.be.revertedWithCustomError(tl, 'DelayOutOfBounds');
      await expect(
        tl.scheduleDelayChange(ethers.ZeroAddress, sel('setAdmin'), HOUR)
      ).to.be.revertedWithCustomError(tl, 'ZeroAddress');
      await expect(
        tl.connect(other).scheduleDelayChange(usnAddr, sel('unpause'), HOUR)
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await expect(
        tl.connect(other).executeDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await expect(
        tl.connect(other).cancelDelayChange(usnAddr, sel('setAdmin'))
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
    });
    it('an already-queued op keeps its eta when the delay changes', async function () {
      const data = enc('setAdmin', [newAdmin.address]);
      const eta = (await now()) + ADMIN_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await tl.scheduleDelayChange(usnAddr, sel('setAdmin'), 72n * HOUR);
      await time.increaseTo(eta);
      await tl.executeDelayChange(usnAddr, sel('setAdmin'));
      await tl.execute(usnAddr, 0, NONE, data, eta);
      expect(await usn.admin()).to.equal(newAdmin.address);
    });
  });

  describe('leaving the timelock', function () {
    it('transferOwnership of USN waits its delay, then the new owner accepts', async function () {
      const data = enc('transferOwnership', [stranger.address]);
      const eta = (await now()) + OWNER_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, NONE, data, eta);
      expect(await usn.pendingOwner()).to.equal(stranger.address);
      await usn.connect(stranger).acceptOwnership();
      expect(await usn.owner()).to.equal(stranger.address);
    });
    it('timelock ownership rotates with Ownable2Step and keeps the map', async function () {
      await tl.transferOwnership(stranger.address);
      await tl.connect(stranger).acceptOwnership();
      await expect(
        tl
          .connect(stranger)
          .call(usnAddr, 0, NONE, enc('setAdmin', [stranger.address]))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
      await expect(
        tl.call(usnAddr, 0, NONE, enc('pause'))
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await tl.connect(stranger).call(usnAddr, 0, NONE, enc('pause'));
      expect(await usn.paused()).to.equal(true);
    });
  });

  describe('ownership transfers while USN is not under the timelock', function () {
    // Drops the transferOwnership / renounceOwnership delays to 0 (waits the
    // current 48h, as the two-step flow requires).
    async function unprotectOwnership() {
      for (const fn of ['transferOwnership', 'renounceOwnership'])
        await tl.scheduleDelayChange(usnAddr, sel(fn), 0);
      await time.increase(OWNER_DELAY);
      for (const fn of ['transferOwnership', 'renounceOwnership'])
        await tl.executeDelayChange(usnAddr, sel(fn));
      expect(await tl.delay(usnAddr, sel('transferOwnership'))).to.equal(0);
      expect(await tl.delay(usnAddr, sel('renounceOwnership'))).to.equal(0);
    }

    it('BYPASS: with transferOwnership at delay 0 the Safe re-takes USN and calls setAdmin seconds later', async function () {
      await unprotectOwnership();
      expect(await tl.delay(usnAddr, sel('setAdmin'))).to.equal(ADMIN_DELAY); // setAdmin is still "protected"
      const t0 = await now();
      await tl.call(usnAddr, 0, NONE, enc('transferOwnership', [safe.address]));
      await usn.connect(safe).acceptOwnership();
      await usn.connect(safe).setAdmin(newAdmin.address);
      const t1 = await now();
      expect(t1 - t0).to.be.lessThan(10n); // three consecutive blocks, no delay observed
      expect(await usn.owner()).to.equal(safe.address);
      expect(await usn.admin()).to.equal(newAdmin.address);
    });

    it('BYPASS: with renounceOwnership at delay 0 the Safe can orphan USN at once (no owner, no setAdmin, no unpause)', async function () {
      await unprotectOwnership();
      await tl.call(usnAddr, 0, NONE, enc('renounceOwnership'));
      expect(await usn.owner()).to.equal(ethers.ZeroAddress);
      await expect(
        usn.connect(safe).setAdmin(newAdmin.address)
      ).to.be.revertedWithCustomError(usn, 'OwnableUnauthorizedAccount');
      await expect(
        tl.call(usnAddr, 0, NONE, enc('unpause'))
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
    });

    it('with transferOwnership delayed, the same re-take waits 48h and shows up in the queue first', async function () {
      const data = enc('transferOwnership', [safe.address]);
      await expect(
        tl.call(usnAddr, 0, NONE, data)
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
      const eta = (await now()) + OWNER_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, data, eta);
      expect(await usn.owner()).to.equal(tlAddr);
      expect(await usn.admin()).to.equal(safe.address);
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, NONE, data, eta);
      await usn.connect(safe).acceptOwnership();
      expect(await usn.owner()).to.equal(safe.address);
    });

    it('a pending transfer out of the timelock can be withdrawn before the new owner accepts', async function () {
      await unprotectOwnership();
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('transferOwnership', [stranger.address])
      );
      expect(await usn.pendingOwner()).to.equal(stranger.address);
      // Ownable2Step: a later transferOwnership overwrites the pending owner; transferring to self clears it
      await tl.call(usnAddr, 0, NONE, enc('transferOwnership', [tlAddr]));
      await expect(
        usn.connect(stranger).acceptOwnership()
      ).to.be.revertedWithCustomError(usn, 'OwnableUnauthorizedAccount');
      expect(await usn.owner()).to.equal(tlAddr);
    });

    it('USN moved out and back under the timelock keeps the delay map', async function () {
      // out, through the delayed path
      const out = enc('transferOwnership', [safe.address]);
      const eta = (await now()) + OWNER_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, out, eta);
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, NONE, out, eta);
      await usn.connect(safe).acceptOwnership();
      // while Safe-owned, the Safe is unconstrained (that is the point of delaying the exit)
      await usn.connect(safe).setAdmin(newAdmin.address);
      expect(await usn.admin()).to.equal(newAdmin.address);
      // back in: Safe offers, timelock accepts through the direct path
      await usn.connect(safe).transferOwnership(tlAddr);
      await tl.call(usnAddr, 0, NONE, enc('acceptOwnership'));
      expect(await usn.owner()).to.equal(tlAddr);
      expect(await tl.delay(usnAddr, sel('setAdmin'))).to.equal(ADMIN_DELAY);
      await expect(
        tl.call(usnAddr, 0, NONE, enc('setAdmin', [safe.address]))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
      await tl.call(usnAddr, 0, NONE, enc('pause'));
      expect(await usn.paused()).to.equal(true);
    });

    it('a timelock that does not own USN cannot do anything to it', async function () {
      const TL = await ethers.getContractFactory('SelectiveTimelock');
      const otherTl = (await TL.deploy(
        safe.address
      )) as unknown as SelectiveTimelock;
      await expect(
        otherTl.call(usnAddr, 0, NONE, enc('pause'))
      ).to.be.revertedWithCustomError(otherTl, 'CallReverted');
      expect(await usn.paused()).to.equal(false);
    });

    it('renounceOwnership on the timelock is disabled, so USN can never be orphaned that way', async function () {
      await expect(tl.renounceOwnership()).to.be.revertedWithCustomError(
        tl,
        'RenounceDisabled'
      );
      await expect(
        tl.connect(other).renounceOwnership()
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      expect(await tl.owner()).to.equal(safe.address);
      await tl.call(usnAddr, 0, NONE, enc('pause'));
      expect(await usn.paused()).to.equal(true);
    });
  });

  describe('pause and blacklist through the timelock (direct path)', function () {
    const AMOUNT = ethers.parseUnits('100', 18);
    beforeEach(async function () {
      // Safe is the USN admin (minter) in this fixture; fund a holder
      await usn.connect(safe).mint(stranger.address, AMOUNT);
      expect(await usn.balanceOf(stranger.address)).to.equal(AMOUNT);
    });

    it('Safe pauses in one tx: transfers, mints and burns stop; unpause restores them', async function () {
      await expect(tl.call(usnAddr, 0, 'pause()', '0x'))
        .to.emit(usn, 'Paused')
        .withArgs(tlAddr);
      expect(await usn.paused()).to.equal(true);
      await expect(
        usn.connect(stranger).transfer(other.address, 1n)
      ).to.be.revertedWithCustomError(usn, 'EnforcedPause');
      await expect(
        usn.connect(safe).mint(other.address, 1n)
      ).to.be.revertedWithCustomError(usn, 'EnforcedPause');
      // and the Safe cannot pause/unpause USN directly any more: the owner is the timelock
      await expect(usn.connect(safe).unpause()).to.be.revertedWithCustomError(
        usn,
        'OwnableUnauthorizedAccount'
      );
      await expect(tl.call(usnAddr, 0, 'unpause()', '0x'))
        .to.emit(usn, 'Unpaused')
        .withArgs(tlAddr);
      await usn.connect(stranger).transfer(other.address, 1n);
      expect(await usn.balanceOf(other.address)).to.equal(1n);
    });

    it('no one but the Safe can pause, directly or through the timelock', async function () {
      await expect(
        tl.connect(other).call(usnAddr, 0, 'pause()', '0x')
      ).to.be.revertedWithCustomError(tl, 'OwnableUnauthorizedAccount');
      await expect(usn.connect(safe).pause()).to.be.revertedWithCustomError(
        usn,
        'OwnableUnauthorizedAccount'
      );
      await expect(usn.connect(other).pause()).to.be.revertedWithCustomError(
        usn,
        'OwnableUnauthorizedAccount'
      );
      expect(await usn.paused()).to.equal(false);
    });

    it("pause is idempotent-safe: pausing twice bubbles USN's EnforcedPause, unpausing twice bubbles ExpectedPause", async function () {
      await tl.call(usnAddr, 0, 'pause()', '0x');
      await expect(
        tl.call(usnAddr, 0, 'pause()', '0x')
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
      await tl.call(usnAddr, 0, 'unpause()', '0x');
      await expect(
        tl.call(usnAddr, 0, 'unpause()', '0x')
      ).to.be.revertedWithCustomError(tl, 'CallReverted');
    });

    it('a pause does not block the delayed path: a queued setAdmin still executes while paused', async function () {
      const data = enc('setAdmin', [newAdmin.address]);
      const eta = (await now()) + ADMIN_DELAY + 60n;
      await tl.queue(usnAddr, 0, NONE, data, eta);
      await tl.call(usnAddr, 0, 'pause()', '0x');
      await time.increaseTo(eta);
      await tl.execute(usnAddr, 0, NONE, data, eta);
      expect(await usn.admin()).to.equal(newAdmin.address);
      expect(await usn.paused()).to.equal(true);
      // the new admin cannot mint until the Safe unpauses
      await expect(
        usn.connect(newAdmin).mint(other.address, 1n)
      ).to.be.revertedWithCustomError(usn, 'EnforcedPause');
      await tl.call(usnAddr, 0, 'unpause()', '0x');
      await usn.connect(newAdmin).mint(other.address, 1n);
      expect(await usn.balanceOf(other.address)).to.equal(1n);
    });

    it('blacklist in one tx: the account can neither send nor receive; unblacklist restores', async function () {
      await tl.call(
        usnAddr,
        0,
        'blacklistAccount(address)',
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address'],
          [stranger.address]
        )
      );
      expect(await usn.blacklist(stranger.address)).to.equal(true);
      await expect(
        usn.connect(stranger).transfer(other.address, 1n)
      ).to.be.revertedWithCustomError(usn, 'BlacklistedAddress');
      await expect(
        usn.connect(safe).mint(stranger.address, 1n)
      ).to.be.revertedWithCustomError(usn, 'BlacklistedAddress');
      // others keep moving
      await usn.connect(safe).mint(other.address, 1n);
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('unblacklistAccount', [stranger.address])
      );
      await usn.connect(stranger).transfer(other.address, 1n);
      expect(await usn.balanceOf(other.address)).to.equal(2n);
    });

    it('pause can also be announced through queue with eta = now, and still executes at once', async function () {
      const eta = await now();
      await tl.queue(usnAddr, 0, 'pause()', '0x', eta + 1n);
      await tl.execute(usnAddr, 0, 'pause()', '0x', eta + 1n);
      expect(await usn.paused()).to.equal(true);
    });

    it('DO NOT: putting pause under a delay makes the emergency path slow', async function () {
      await tl.scheduleDelayChange(usnAddr, sel('pause'), HOUR); // fresh pair -> immediate
      await tl.executeDelayChange(usnAddr, sel('pause'));
      await expect(tl.call(usnAddr, 0, 'pause()', '0x'))
        .to.be.revertedWithCustomError(tl, 'SelectorIsDelayed')
        .withArgs(usnAddr, sel('pause'), HOUR);
      const eta = (await now()) + HOUR + 60n;
      await tl.queue(usnAddr, 0, 'pause()', '0x', eta);
      await expect(
        tl.execute(usnAddr, 0, 'pause()', '0x', eta)
      ).to.be.revertedWithCustomError(tl, 'OperationNotReady');
      expect(await usn.paused()).to.equal(false);
      // undoing it waits the 1h it now carries
      await tl.scheduleDelayChange(usnAddr, sel('pause'), 0);
      await expect(
        tl.executeDelayChange(usnAddr, sel('pause'))
      ).to.be.revertedWithCustomError(tl, 'DelayChangeNotReady');
      await time.increase(HOUR);
      await tl.executeDelayChange(usnAddr, sel('pause'));
      await tl.call(usnAddr, 0, 'pause()', '0x');
      expect(await usn.paused()).to.equal(true);
    });
  });

  describe('mint-equivalent owner functions are delayed', function () {
    const MILLION = ethers.parseUnits('1000000', 18);
    const b32 = (a: string) => ethers.zeroPadValue(a, 32);
    const sample: Record<string, any[]> = {
      setAdmin: ['0x000000000000000000000000000000000000dEaD'],
      configureHyperlane: ['0x000000000000000000000000000000000000dEaD'],
      configureISM: ['0x000000000000000000000000000000000000dEaD'],
      registerHyperlaneRemoteToken: [1, ethers.zeroPadValue('0xdead', 32)],
      setPeer: [30101, ethers.zeroPadValue('0xdead', 32)],
      setDelegate: ['0x000000000000000000000000000000000000dEaD'],
      setRateLimiter: [ethers.ZeroAddress],
    };

    it('every mint path is refused on the direct path and needs a 24h eta in the queue', async function () {
      for (const fn of MINT_PATHS) {
        const data = enc(fn, sample[fn]);
        await expect(tl.call(usnAddr, 0, NONE, data), fn)
          .to.be.revertedWithCustomError(tl, 'SelectorIsDelayed')
          .withArgs(usnAddr, sel(fn), ADMIN_DELAY);
        await expect(
          tl.queue(usnAddr, 0, NONE, data, (await now()) + ADMIN_DELAY - 1n),
          fn
        ).to.be.revertedWithCustomError(tl, 'EtaTooSoon');
      }
      expect(await usn.admin()).to.equal(safe.address);
      expect(await usn.hyperlaneEnabled()).to.equal(false);
    });

    it('BYPASS: with configureHyperlane + registerHyperlaneRemoteToken at delay 0, the owner mints any amount through a hostile mailbox', async function () {
      for (const fn of ['configureHyperlane', 'registerHyperlaneRemoteToken'])
        await tl.scheduleDelayChange(usnAddr, sel(fn), 0);
      await time.increase(ADMIN_DELAY);
      for (const fn of ['configureHyperlane', 'registerHyperlaneRemoteToken'])
        await tl.executeDelayChange(usnAddr, sel(fn));
      // "mailbox" = an EOA the attacker controls; "remote token" = anything they say
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('configureHyperlane', [other.address])
      );
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('registerHyperlaneRemoteToken', [1, b32(other.address)])
      );
      const message = ethers.concat([
        b32(other.address),
        ethers.toBeHex(MILLION, 32),
      ]);
      await usn.connect(other).handle(1, b32(other.address), message);
      expect(await usn.balanceOf(other.address)).to.equal(MILLION); // minted with no admin involved
    });

    it('with the Hyperlane config delayed, the same hijack is refused and the queue announces it 24h ahead', async function () {
      await expect(
        tl.call(usnAddr, 0, NONE, enc('configureHyperlane', [other.address]))
      ).to.be.revertedWithCustomError(tl, 'SelectorIsDelayed');
      await expect(
        usn.connect(other).handle(1, b32(other.address), '0x')
      ).to.be.revertedWithCustomError(usn, 'OnlyMailboxAllowed');
      const eta = (await now()) + ADMIN_DELAY + 60n;
      await tl.queue(
        usnAddr,
        0,
        NONE,
        enc('configureHyperlane', [other.address]),
        eta
      );
      // the Safe can cancel in the window, and pause meanwhile
      await tl.call(usnAddr, 0, 'pause()', '0x');
      await tl.cancel(
        usnAddr,
        0,
        NONE,
        enc('configureHyperlane', [other.address]),
        eta
      );
      await time.increaseTo(eta);
      await expect(
        tl.execute(
          usnAddr,
          0,
          NONE,
          enc('configureHyperlane', [other.address]),
          eta
        )
      ).to.be.revertedWithCustomError(tl, 'OperationNotQueued');
      expect(await usn.hyperlaneEnabled()).to.equal(false);
    });

    it('setRateLimiter(0) and setPeer / setDelegate go through the queue like setAdmin', async function () {
      for (const fn of ['setRateLimiter', 'setPeer', 'setDelegate']) {
        const data = enc(fn, sample[fn]);
        const eta = (await now()) + ADMIN_DELAY + 60n;
        await tl.queue(usnAddr, 0, NONE, data, eta);
        await expect(
          tl.execute(usnAddr, 0, NONE, data, eta),
          fn
        ).to.be.revertedWithCustomError(tl, 'OperationNotReady');
      }
    });

    it('reversible, non-minting owner functions stay direct (enforced options, inspector, whitelist)', async function () {
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('setMsgInspector', [ethers.ZeroAddress])
      );
      await tl.call(usnAddr, 0, NONE, enc('setEnforcedOptions', [[]]));
      await tl.call(
        usnAddr,
        0,
        NONE,
        enc('addToWhitelist', [stranger.address])
      );
      expect(await usn.isWhitelisted(stranger.address)).to.equal(true);
    });
  });
});
