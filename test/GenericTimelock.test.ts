import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import type {
  GenericTimelock,
  MockTimelockTarget,
  WithdrawalHandler,
  MockERC20,
  MinterHandlerV2,
  RedeemHandlerV2,
  USN,
  EndpointV2Mock,
  MockChainlinkPriceFeed,
} from '../typechain-types';

const DAY = 24 * 60 * 60;

async function now(): Promise<number> {
  return (await ethers.provider.getBlock('latest'))!.timestamp;
}

async function increaseTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

describe('GenericTimelock', function () {
  let owner: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let timelock: GenericTimelock;
  let target: MockTimelockTarget;
  let handler: WithdrawalHandler;
  let usn: MockERC20;

  const DELAY = 2 * DAY;

  beforeEach(async function () {
    [owner, outsider, user] = await ethers.getSigners();

    // Deploy USN mock + WithdrawalHandler (deployer is DEFAULT_ADMIN_ROLE initially)
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    usn = await MockERC20Factory.deploy('USN', 'USN');
    const WithdrawalHandlerFactory =
      await ethers.getContractFactory('WithdrawalHandler');
    handler = await WithdrawalHandlerFactory.deploy(
      await usn.getAddress(),
      DAY
    );

    // Deploy the Timelock
    const TimelockFactory = await ethers.getContractFactory('GenericTimelock');
    timelock = await TimelockFactory.deploy(owner.address, DELAY);

    // Deploy the mock target with the timelock as its Ownable owner
    const TargetFactory = await ethers.getContractFactory('MockTimelockTarget');
    target = await TargetFactory.deploy(await timelock.getAddress());

    // Hand admin of WithdrawalHandler to the timelock:
    // grant DEFAULT_ADMIN_ROLE to timelock, then renounce from the deployer.
    const adminRole = await handler.DEFAULT_ADMIN_ROLE();
    await handler.grantRole(adminRole, await timelock.getAddress());
    await handler.renounceRole(adminRole, owner.address);
  });

  describe('constructor', function () {
    it('rejects delay below MIN_DELAY', async function () {
      // MIN_DELAY is 2 days — exactly one second below should still revert.
      const Factory = await ethers.getContractFactory('GenericTimelock');
      await expect(
        Factory.deploy(owner.address, 2 * DAY - 1)
      ).to.be.revertedWithCustomError(timelock, 'DelayOutOfBounds');
    });

    it('rejects delay above MAX_DELAY', async function () {
      const Factory = await ethers.getContractFactory('GenericTimelock');
      await expect(
        Factory.deploy(owner.address, 30 * DAY + 1)
      ).to.be.revertedWithCustomError(timelock, 'DelayOutOfBounds');
    });

    it('emits DelayUpdated with previous=0', async function () {
      const Factory = await ethers.getContractFactory('GenericTimelock');
      const fresh = await Factory.deploy(owner.address, DELAY);
      const deployTx = fresh.deploymentTransaction()!;
      await expect(deployTx).to.emit(fresh, 'DelayUpdated').withArgs(0, DELAY);
    });
  });

  describe('access control', function () {
    it('only owner can queue', async function () {
      const eta = (await now()) + DELAY + 1;
      await expect(
        timelock
          .connect(outsider)
          .queue(await target.getAddress(), 0, 'setValue(uint256)', '0x', eta)
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('only owner can execute', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [42]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 2);
      await expect(
        timelock
          .connect(outsider)
          .execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('only owner can cancel', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await expect(
        timelock
          .connect(outsider)
          .cancel(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');
    });

    it('direct setDelay reverts NotSelf for outsider', async function () {
      await expect(
        timelock.connect(outsider).setDelay(3 * DAY)
      )
        .to.be.revertedWithCustomError(timelock, 'NotSelf')
        .withArgs(outsider.address);
    });

    it('direct setDelay reverts NotSelf even for the owner', async function () {
      // Self-timelocked: owner cannot bypass the delay by calling setDelay directly.
      await expect(timelock.setDelay(3 * DAY))
        .to.be.revertedWithCustomError(timelock, 'NotSelf')
        .withArgs(owner.address);
    });
  });

  describe('queue → execute happy path (MockTimelockTarget)', function () {
    it('setValue after delay actually updates target state', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [1234]
      );

      await expect(
        timelock.queue(await target.getAddress(), 0, sig, data, eta)
      ).to.emit(timelock, 'OperationQueued');

      // Cannot execute before eta
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotReady');

      await increaseTime(DELAY + 2);

      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      )
        .to.emit(target, 'ValueSet')
        .withArgs(1234);

      expect(await target.value()).to.equal(1234n);
    });

    it('setLabel via string arg works too', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setLabel(string)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['string'],
        ['hello']
      );
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 2);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);
      expect(await target.label()).to.equal('hello');
    });

    it('executes on the exact eta boundary (>=, not >)', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [7]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);

      // Wind exactly to eta
      const cur = await now();
      await increaseTime(eta - cur);
      // block.timestamp is now == eta, execute must pass
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.emit(target, 'ValueSet');
    });
  });

  describe('queue → execute happy path (WithdrawalHandler)', function () {
    it('setWithdrawPeriod through the timelock changes handler state', async function () {
      expect(await handler.withdrawPeriod()).to.equal(BigInt(DAY));

      const eta = (await now()) + DELAY + 1;
      const sig = 'setWithdrawPeriod(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [3 * DAY]
      );

      await timelock.queue(await handler.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 2);
      await expect(
        timelock.execute(await handler.getAddress(), 0, sig, data, eta)
      )
        .to.emit(handler, 'WithdrawPeriodUpdated')
        .withArgs(3 * DAY);

      expect(await handler.withdrawPeriod()).to.equal(BigInt(3 * DAY));
    });

    it('same timelock can act on both handler and target in one flow', async function () {
      // Two independent queued ops, one per target, both need to land after
      // delay. Each queue tx bumps block.timestamp by 1, so buffer eta > delay+2.
      const eta = (await now()) + DELAY + 10;

      const sig1 = 'setWithdrawPeriod(uint256)';
      const data1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [7 * DAY]
      );
      const sig2 = 'setValue(uint256)';
      const data2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [999]
      );

      await timelock.queue(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.queue(await target.getAddress(), 0, sig2, data2, eta);

      await increaseTime(DELAY + 20);

      await timelock.execute(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.execute(await target.getAddress(), 0, sig2, data2, eta);

      expect(await handler.withdrawPeriod()).to.equal(BigInt(7 * DAY));
      expect(await target.value()).to.equal(999n);
    });
  });

  describe('raw calldata path (signature = "")', function () {
    it('accepts pre-encoded calldata when signature is empty', async function () {
      const eta = (await now()) + DELAY + 1;
      // Full 4+32 bytes of setValue(uint256) with arg = 55
      const preencoded = target.interface.encodeFunctionData('setValue', [55]);
      await timelock.queue(await target.getAddress(), 0, '', preencoded, eta);
      await increaseTime(DELAY + 2);
      await timelock.execute(await target.getAddress(), 0, '', preencoded, eta);
      expect(await target.value()).to.equal(55n);
    });
  });

  describe('cancel', function () {
    it('cancelling before execute blocks the execute call', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await expect(
        timelock.cancel(await target.getAddress(), 0, sig, data, eta)
      ).to.emit(timelock, 'OperationCancelled');
      await increaseTime(DELAY + 2);
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotQueued');
    });

    it('cannot cancel a non-queued op', async function () {
      const eta = (await now()) + DELAY + 1;
      await expect(
        timelock.cancel(
          await target.getAddress(),
          0,
          'setValue(uint256)',
          '0x',
          eta
        )
      ).to.be.revertedWithCustomError(timelock, 'OperationNotQueued');
    });
  });

  describe('replay + boundary checks', function () {
    it('cannot double-execute the same op', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 2);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotQueued');
    });

    it('cannot queue the same op twice concurrently', async function () {
      // Buffer eta > delay so the second queue tx (which advances the block
      // by 1 second) still satisfies `eta >= now + delay`.
      const eta = (await now()) + DELAY + 10;
      await timelock.queue(
        await target.getAddress(),
        0,
        'setValue(uint256)',
        '0x',
        eta
      );
      await expect(
        timelock.queue(
          await target.getAddress(),
          0,
          'setValue(uint256)',
          '0x',
          eta
        )
      ).to.be.revertedWithCustomError(timelock, 'OperationAlreadyQueued');
    });

    it('rejects eta < now + delay at queue time', async function () {
      const eta = (await now()) + DELAY - 5;
      await expect(
        timelock.queue(
          await target.getAddress(),
          0,
          'setValue(uint256)',
          '0x',
          eta
        )
      ).to.be.revertedWithCustomError(timelock, 'EtaTooSoon');
    });

    it('rejects execute past eta + GRACE_PERIOD', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      // Fast-forward past eta + 14 days
      await increaseTime(DELAY + 14 * DAY + 2);
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationExpired');
    });

    it('expired op: same params + same eta cannot be re-queued', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      // Let it expire
      await increaseTime(DELAY + 14 * DAY + 2);

      // Re-queue attempt with the same (past) eta reverts EtaTooSoon (the
      // eta<now+delay check fires before OperationAlreadyQueued, but the point
      // is: this identical op cannot be revived).
      await expect(
        timelock.queue(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'EtaTooSoon');
    });

    it('expired op: same params + new eta can be re-queued and executed', async function () {
      const oldEta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [4242]
      );
      await timelock.queue(await target.getAddress(), 0, sig, data, oldEta);

      // Expire the original
      await increaseTime(DELAY + 14 * DAY + 5);

      // Fresh eta produces a fresh opHash (eta is part of the hash)
      const newEta = (await now()) + DELAY + 10;
      await timelock.queue(await target.getAddress(), 0, sig, data, newEta);
      await increaseTime(DELAY + 20);
      await timelock.execute(await target.getAddress(), 0, sig, data, newEta);

      expect(await target.value()).to.equal(4242n);

      // Sanity: the old expired opHash still has queued=true (never cleared),
      // but is unreachable — execute reverts OperationExpired, and its eta
      // can't be reused because it's in the past.
      const oldHash = await timelock.hashOperation(
        await target.getAddress(),
        0,
        sig,
        data,
        oldEta
      );
      expect(await timelock.queued(oldHash)).to.equal(true);
    });

    it('expired op: cancel frees the stale queued slot', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 14 * DAY + 2);

      const opHash = await timelock.hashOperation(
        await target.getAddress(),
        0,
        sig,
        data,
        eta
      );
      expect(await timelock.queued(opHash)).to.equal(true);

      // Cancel works even after expiry (no eta/delay check in cancel)
      await expect(
        timelock.cancel(await target.getAddress(), 0, sig, data, eta)
      ).to.emit(timelock, 'OperationCancelled');

      expect(await timelock.queued(opHash)).to.equal(false);
    });
  });

  describe('ETH forwarding', function () {
    it('forwards msg.value to the target call', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'payMe()';
      const data = '0x';
      const value = ethers.parseEther('0.1');
      await timelock.queue(await target.getAddress(), value, sig, data, eta);
      await increaseTime(DELAY + 2);
      await timelock.execute(await target.getAddress(), value, sig, data, eta, {
        value,
      });
      expect(await target.etherReceived()).to.equal(value);
    });

    it('reverts with ValueMismatch when msg.value != queued value', async function () {
      const eta = (await now()) + DELAY + 1;
      const sig = 'payMe()';
      const data = '0x';
      const value = ethers.parseEther('0.1');
      const wrong = ethers.parseEther('0.05');
      await timelock.queue(await target.getAddress(), value, sig, data, eta);
      await increaseTime(DELAY + 2);
      // Now a dedicated error with the two operand values, not overloaded CallReverted.
      await expect(
        timelock.execute(await target.getAddress(), value, sig, data, eta, {
          value: wrong,
        })
      )
        .to.be.revertedWithCustomError(timelock, 'ValueMismatch')
        .withArgs(wrong, value);
    });

    it('sending ETH directly to the timelock reverts (no receive/fallback)', async function () {
      // The contract intentionally has no receive/fallback — nothing spends
      // from its balance and stray ETH would be stuck.
      await expect(
        owner.sendTransaction({
          to: await timelock.getAddress(),
          value: 1n,
        })
      ).to.be.reverted;
    });
  });

  describe('reverts from target surface up as CallReverted', function () {
    it('surfaces target revert data exactly', async function () {
      // Tighten: not just the error shape — decode returnData and verify it
      // equals the target's own IntentionalRevert("nope") payload.
      const eta = (await now()) + DELAY + 1;
      const sig = 'alwaysReverts()';
      const data = '0x';
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 2);

      const expectedRevert = target.interface.encodeErrorResult(
        'IntentionalRevert',
        ['nope']
      );
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      )
        .to.be.revertedWithCustomError(timelock, 'CallReverted')
        .withArgs(expectedRevert);
    });
  });

  describe('setDelay (self-timelocked — must go through queue/execute)', function () {
    it('updates delay within bounds via queue/execute', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setDelay(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [3 * DAY]
      );
      await timelock.queue(await timelock.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(await timelock.getAddress(), 0, sig, data, eta)
      )
        .to.emit(timelock, 'DelayUpdated')
        .withArgs(DELAY, 3 * DAY);
      expect(await timelock.delay()).to.equal(BigInt(3 * DAY));
    });

    it('is delay-gated: cannot execute a setDelay change before eta', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setDelay(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [3 * DAY]
      );
      await timelock.queue(await timelock.getAddress(), 0, sig, data, eta);
      // Try immediately
      await expect(
        timelock.execute(await timelock.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotReady');
      // Delay unchanged
      expect(await timelock.delay()).to.equal(BigInt(DELAY));
    });

    it('out-of-bounds delay surfaces as CallReverted(DelayOutOfBounds) via execute', async function () {
      const sig = 'setDelay(uint256)';
      // MIN_DELAY - 1
      {
        const eta = (await now()) + DELAY + 5;
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256'],
          [2 * DAY - 1]
        );
        await timelock.queue(await timelock.getAddress(), 0, sig, data, eta);
        await increaseTime(DELAY + 10);
        const expected = timelock.interface.encodeErrorResult(
          'DelayOutOfBounds',
          [2 * DAY - 1, 2 * DAY, 30 * DAY]
        );
        await expect(
          timelock.execute(await timelock.getAddress(), 0, sig, data, eta)
        )
          .to.be.revertedWithCustomError(timelock, 'CallReverted')
          .withArgs(expected);
      }
      // MAX_DELAY + 1 — use a fresh eta and re-queue
      {
        const eta = (await now()) + DELAY + 5;
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256'],
          [30 * DAY + 1]
        );
        await timelock.queue(await timelock.getAddress(), 0, sig, data, eta);
        await increaseTime(DELAY + 10);
        await expect(
          timelock.execute(await timelock.getAddress(), 0, sig, data, eta)
        ).to.be.revertedWithCustomError(timelock, 'CallReverted');
      }
    });
  });

  describe('hashOperation determinism', function () {
    it('same inputs → same hash; different eta → different hash', async function () {
      const targetAddr = await target.getAddress();
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [42]);
      const h1 = await timelock.hashOperation(targetAddr, 0, sig, data, 1000);
      const h2 = await timelock.hashOperation(targetAddr, 0, sig, data, 1000);
      const h3 = await timelock.hashOperation(targetAddr, 0, sig, data, 1001);
      expect(h1).to.equal(h2);
      expect(h1).to.not.equal(h3);
    });
  });

  describe('buildCalldata', function () {
    it('with signature: prepends the 4-byte selector', async function () {
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [42]);
      const built = await timelock.buildCalldata(sig, data);
      const expected = target.interface.encodeFunctionData('setValue', [42]);
      expect(built).to.equal(expected);
    });

    it('with empty signature: returns data unchanged', async function () {
      const raw = '0xdeadbeef';
      expect(await timelock.buildCalldata('', raw)).to.equal(raw);
    });
  });
});

// ============================================================================
// Extended fixture — same timelock, four contracts of different admin shapes.
// Demonstrates the timelock managing:
//   1. MockTimelockTarget           (Ownable — owner = timelock)
//   2. WithdrawalHandler            (AccessControl DEFAULT_ADMIN_ROLE)
//   3. MinterHandlerV2              (AccessControl DEFAULT_ADMIN_ROLE)
//   4. RedeemHandlerV2              (AccessControl DEFAULT_ADMIN_ROLE)
// Each admin path is different in Solidity but interchangeable from the
// timelock's perspective — it only sees (target, signature, data).
// ============================================================================
describe('GenericTimelock — multi-contract control (WithdrawalHandler + Minter + Redeem + Mock)', function () {
  let owner: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  let timelock: GenericTimelock;
  let target: MockTimelockTarget;
  let handler: WithdrawalHandler;
  let minter: MinterHandlerV2;
  let redeem: RedeemHandlerV2;
  let usn: USN;
  let endpointMock: EndpointV2Mock;
  let collateral: MockERC20;
  let oracle: MockChainlinkPriceFeed;

  const DELAY = 2 * DAY;

  beforeEach(async function () {
    [owner, outsider] = await ethers.getSigners();

    // --- USN needs an LZ endpoint mock ---
    const EndpointV2MockFactory =
      await ethers.getContractFactory('EndpointV2Mock');
    endpointMock = await EndpointV2MockFactory.deploy(1);
    const USNFactory = await ethers.getContractFactory('USN');
    usn = await USNFactory.deploy(await endpointMock.getAddress());
    await usn.enablePermissionless();
    await usn.setAdmin(await owner.getAddress());

    // --- Collateral + oracle for RedeemHandler setup ---
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    collateral = await MockERC20Factory.deploy('Collateral', 'COL');
    const MockOracleFactory = await ethers.getContractFactory(
      'MockChainlinkPriceFeed'
    );
    oracle = await MockOracleFactory.deploy(10n ** 8n, 8); // $1 with 8dp

    // --- Deploy all four managed contracts ---
    const WithdrawalHandlerFactory =
      await ethers.getContractFactory('WithdrawalHandler');
    handler = await WithdrawalHandlerFactory.deploy(
      await usn.getAddress(),
      DAY
    );

    const MinterFactory = await ethers.getContractFactory('MinterHandlerV2');
    minter = await MinterFactory.deploy(await usn.getAddress());

    const RedeemFactory = await ethers.getContractFactory('RedeemHandlerV2');
    redeem = await RedeemFactory.deploy(await usn.getAddress());

    const TimelockFactory = await ethers.getContractFactory('GenericTimelock');
    timelock = await TimelockFactory.deploy(owner.address, DELAY);

    const TargetFactory = await ethers.getContractFactory('MockTimelockTarget');
    target = await TargetFactory.deploy(await timelock.getAddress());

    // --- Hand admin to the timelock on all three AccessControl targets ---
    const adminRole = await handler.DEFAULT_ADMIN_ROLE();
    for (const c of [handler, minter, redeem]) {
      await c.grantRole(adminRole, await timelock.getAddress());
      await c.renounceRole(adminRole, owner.address);
      // Sanity: deployer really lost admin
      expect(await c.hasRole(adminRole, owner.address)).to.equal(false);
      expect(await c.hasRole(adminRole, await timelock.getAddress())).to.equal(
        true
      );
    }
  });

  it('rejects direct admin calls on all three handlers (post-transfer sanity)', async function () {
    await expect(
      handler.setWithdrawPeriod(3 * DAY)
    ).to.be.revertedWithCustomError(
      handler,
      'AccessControlUnauthorizedAccount'
    );
    await expect(
      minter.setMintLimitPerBlock(ethers.parseUnits('1', 18))
    ).to.be.revertedWithCustomError(minter, 'AccessControlUnauthorizedAccount');
    await expect(
      redeem.setRedeemLimitPerBlock(ethers.parseUnits('1', 18))
    ).to.be.revertedWithCustomError(redeem, 'AccessControlUnauthorizedAccount');
  });

  describe('controlling MinterHandlerV2', function () {
    it('setMintLimitPerBlock via timelock updates state and emits', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setMintLimitPerBlock(uint256)';
      const newLimit = ethers.parseUnits('50000', 18);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [newLimit]
      );
      await timelock.queue(await minter.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(await minter.getAddress(), 0, sig, data, eta)
      )
        .to.emit(minter, 'MintLimitPerBlockUpdated')
        .withArgs(newLimit);
      expect(await minter.mintLimitPerBlock()).to.equal(newLimit);
    });

    it('addWhitelistedUser via timelock', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'addWhitelistedUser(address)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [outsider.address]
      );
      await timelock.queue(await minter.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await minter.getAddress(), 0, sig, data, eta);
      expect(await minter.whitelistedUsers(outsider.address)).to.equal(true);
    });

    it('pause + unpause via timelock', async function () {
      // Pause
      let eta = (await now()) + DELAY + 5;
      await timelock.queue(await minter.getAddress(), 0, 'pause()', '0x', eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(
        await minter.getAddress(),
        0,
        'pause()',
        '0x',
        eta
      );
      expect(await minter.paused()).to.equal(true);

      // Unpause with a fresh eta
      eta = (await now()) + DELAY + 5;
      await timelock.queue(
        await minter.getAddress(),
        0,
        'unpause()',
        '0x',
        eta
      );
      await increaseTime(DELAY + 10);
      await timelock.execute(
        await minter.getAddress(),
        0,
        'unpause()',
        '0x',
        eta
      );
      expect(await minter.paused()).to.equal(false);
    });

    it('outsider cannot bypass the timelock by calling minter directly', async function () {
      await expect(
        minter.connect(outsider).setMintLimitPerBlock(1n)
      ).to.be.revertedWithCustomError(
        minter,
        'AccessControlUnauthorizedAccount'
      );
    });
  });

  describe('controlling RedeemHandlerV2', function () {
    it('setRedeemLimitPerBlock via timelock', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setRedeemLimitPerBlock(uint256)';
      const newLimit = ethers.parseUnits('42000', 18);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [newLimit]
      );
      await timelock.queue(await redeem.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(await redeem.getAddress(), 0, sig, data, eta)
      )
        .to.emit(redeem, 'RedeemLimitPerBlockUpdated')
        .withArgs(newLimit);
      expect(await redeem.redeemLimitPerBlock()).to.equal(newLimit);
    });

    it('addRedeemableCollateral (two-arg) via timelock', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'addRedeemableCollateral(address,address)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address'],
        [await collateral.getAddress(), await oracle.getAddress()]
      );
      await timelock.queue(await redeem.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await redeem.getAddress(), 0, sig, data, eta);
      expect(
        await redeem.redeemableCollaterals(await collateral.getAddress())
      ).to.equal(true);
    });

    it('setPriceThreshold via timelock (guarded by internal 10% cap)', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setPriceThreshold(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [200n]
      );
      await timelock.queue(await redeem.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await redeem.getAddress(), 0, sig, data, eta);
      expect(await redeem.priceThresholdBps()).to.equal(200n);
    });

    it('timelock cannot bypass target-side invariants (>10% cap still enforced)', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'setPriceThreshold(uint256)';
      // 1001 bps > 10% cap in RedeemHandlerV2.setPriceThreshold
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [1001n]
      );
      await timelock.queue(await redeem.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(await redeem.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'CallReverted');
    });
  });

  describe('single flow: change params on all four contracts through one timelock', function () {
    it('queues 4 ops, waits once, executes 4 ops', async function () {
      const eta = (await now()) + DELAY + 20;

      const sig1 = 'setWithdrawPeriod(uint256)';
      const data1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [5 * DAY]
      );
      const sig2 = 'setMintLimitPerBlock(uint256)';
      const data2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [ethers.parseUnits('123456', 18)]
      );
      const sig3 = 'setRedeemLimitPerBlock(uint256)';
      const data3 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [ethers.parseUnits('7777', 18)]
      );
      const sig4 = 'setValue(uint256)';
      const data4 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2026n]
      );

      // Queue all 4
      await timelock.queue(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.queue(await minter.getAddress(), 0, sig2, data2, eta);
      await timelock.queue(await redeem.getAddress(), 0, sig3, data3, eta);
      await timelock.queue(await target.getAddress(), 0, sig4, data4, eta);

      // Wind past eta once
      await increaseTime(DELAY + 30);

      // Execute all 4
      await timelock.execute(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.execute(await minter.getAddress(), 0, sig2, data2, eta);
      await timelock.execute(await redeem.getAddress(), 0, sig3, data3, eta);
      await timelock.execute(await target.getAddress(), 0, sig4, data4, eta);

      expect(await handler.withdrawPeriod()).to.equal(BigInt(5 * DAY));
      expect(await minter.mintLimitPerBlock()).to.equal(
        ethers.parseUnits('123456', 18)
      );
      expect(await redeem.redeemLimitPerBlock()).to.equal(
        ethers.parseUnits('7777', 18)
      );
      expect(await target.value()).to.equal(2026n);
    });

    it('cancelling one op does not affect the other three queued ops', async function () {
      const eta = (await now()) + DELAY + 20;
      const sig1 = 'setWithdrawPeriod(uint256)';
      const data1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [11 * DAY]
      );
      const sig2 = 'setMintLimitPerBlock(uint256)';
      const data2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [ethers.parseUnits('42', 18)]
      );
      const sig3 = 'setRedeemLimitPerBlock(uint256)';
      const data3 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [ethers.parseUnits('42', 18)]
      );
      const sig4 = 'setValue(uint256)';
      const data4 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [42n]
      );

      await timelock.queue(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.queue(await minter.getAddress(), 0, sig2, data2, eta);
      await timelock.queue(await redeem.getAddress(), 0, sig3, data3, eta);
      await timelock.queue(await target.getAddress(), 0, sig4, data4, eta);

      // Cancel the minter op only
      await timelock.cancel(await minter.getAddress(), 0, sig2, data2, eta);

      await increaseTime(DELAY + 30);

      // Cancelled one reverts
      await expect(
        timelock.execute(await minter.getAddress(), 0, sig2, data2, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotQueued');

      // Other three still execute
      await timelock.execute(await handler.getAddress(), 0, sig1, data1, eta);
      await timelock.execute(await redeem.getAddress(), 0, sig3, data3, eta);
      await timelock.execute(await target.getAddress(), 0, sig4, data4, eta);

      expect(await handler.withdrawPeriod()).to.equal(BigInt(11 * DAY));
      expect(await redeem.redeemLimitPerBlock()).to.equal(
        ethers.parseUnits('42', 18)
      );
      expect(await target.value()).to.equal(42n);
      // Minter untouched
      expect(await minter.mintLimitPerBlock()).to.not.equal(
        ethers.parseUnits('42', 18)
      );
    });

    it('rescheduling: after execute, same params can be re-queued with new eta', async function () {
      // First cycle
      let eta = (await now()) + DELAY + 5;
      const sig = 'setValue(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]);
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);
      expect(await target.value()).to.equal(1n);

      // Second cycle with new eta — should re-queue cleanly
      eta = (await now()) + DELAY + 5;
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);
    });
  });

  // =========================================================================
  // Ownership retransfer through the timelock.
  // These prove there's no lock-in: whoever holds the timelock's owner slot
  // today can hand any managed contract back off (to a wallet, a different
  // timelock, a governance module, etc.) using the same queue → execute path.
  // =========================================================================
  describe('ownership retransfer through the timelock', function () {
    it('Ownable target: transferOwnership away from the timelock', async function () {
      const eta = (await now()) + DELAY + 5;
      const sig = 'transferOwnership(address)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [outsider.address]
      );

      expect(await target.owner()).to.equal(await timelock.getAddress());

      await timelock.queue(await target.getAddress(), 0, sig, data, eta);
      await increaseTime(DELAY + 10);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);

      expect(await target.owner()).to.equal(outsider.address);

      // Timelock is no longer owner → its next queued setValue reverts on exec
      const eta2 = (await now()) + DELAY + 5;
      const setSig = 'setValue(uint256)';
      const setData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [777n]
      );
      await timelock.queue(await target.getAddress(), 0, setSig, setData, eta2);
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(await target.getAddress(), 0, setSig, setData, eta2)
      ).to.be.revertedWithCustomError(timelock, 'CallReverted');

      // New owner can call directly
      await target.connect(outsider).setValue(777n);
      expect(await target.value()).to.equal(777n);
    });

    it('AccessControl target: grant admin to a new address, then renounce timelock admin', async function () {
      // Two-tx handover: grant new admin, then renounce old (safe pattern)
      const adminRole = await handler.DEFAULT_ADMIN_ROLE();
      const eta = (await now()) + DELAY + 20;

      const grantSig = 'grantRole(bytes32,address)';
      const grantData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [adminRole, outsider.address]
      );
      const renounceSig = 'renounceRole(bytes32,address)';
      const renounceData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [adminRole, await timelock.getAddress()]
      );

      await timelock.queue(
        await handler.getAddress(),
        0,
        grantSig,
        grantData,
        eta
      );
      await timelock.queue(
        await handler.getAddress(),
        0,
        renounceSig,
        renounceData,
        eta
      );
      await increaseTime(DELAY + 30);

      await timelock.execute(
        await handler.getAddress(),
        0,
        grantSig,
        grantData,
        eta
      );
      expect(await handler.hasRole(adminRole, outsider.address)).to.equal(true);
      expect(
        await handler.hasRole(adminRole, await timelock.getAddress())
      ).to.equal(true);

      await timelock.execute(
        await handler.getAddress(),
        0,
        renounceSig,
        renounceData,
        eta
      );
      expect(await handler.hasRole(adminRole, outsider.address)).to.equal(true);
      expect(
        await handler.hasRole(adminRole, await timelock.getAddress())
      ).to.equal(false);

      // New admin can now set params directly (bypassing the timelock)
      await handler.connect(outsider).setWithdrawPeriod(9 * DAY);
      expect(await handler.withdrawPeriod()).to.equal(BigInt(9 * DAY));

      // Old timelock can no longer control the handler
      const failEta = (await now()) + DELAY + 5;
      await timelock.queue(
        await handler.getAddress(),
        0,
        'setWithdrawPeriod(uint256)',
        ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1 * DAY]),
        failEta
      );
      await increaseTime(DELAY + 10);
      await expect(
        timelock.execute(
          await handler.getAddress(),
          0,
          'setWithdrawPeriod(uint256)',
          ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1 * DAY]),
          failEta
        )
      ).to.be.revertedWithCustomError(timelock, 'CallReverted');
    });

    it('full handover: migrate all three handlers to a brand-new timelock in one flow', async function () {
      // Deploy a new timelock with a different owner + delay
      const NewTLFactory = await ethers.getContractFactory('GenericTimelock');
      const newTL = await NewTLFactory.deploy(outsider.address, 3 * DAY);
      const adminRole = await handler.DEFAULT_ADMIN_ROLE();

      const eta = (await now()) + DELAY + 40;

      // Six ops: grant new + renounce old, across handler, minter, redeem
      const grantSig = 'grantRole(bytes32,address)';
      const renounceSig = 'renounceRole(bytes32,address)';
      const grantData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [adminRole, await newTL.getAddress()]
      );
      const renounceData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [adminRole, await timelock.getAddress()]
      );

      for (const c of [handler, minter, redeem]) {
        await timelock.queue(await c.getAddress(), 0, grantSig, grantData, eta);
        await timelock.queue(
          await c.getAddress(),
          0,
          renounceSig,
          renounceData,
          eta
        );
      }

      await increaseTime(DELAY + 60);

      for (const c of [handler, minter, redeem]) {
        await timelock.execute(
          await c.getAddress(),
          0,
          grantSig,
          grantData,
          eta
        );
        await timelock.execute(
          await c.getAddress(),
          0,
          renounceSig,
          renounceData,
          eta
        );
      }

      // All three now under newTL, old timelock has no admin anywhere
      for (const c of [handler, minter, redeem]) {
        expect(await c.hasRole(adminRole, await newTL.getAddress())).to.equal(
          true
        );
        expect(
          await c.hasRole(adminRole, await timelock.getAddress())
        ).to.equal(false);
      }

      // New timelock (owner = outsider) can now change params on each target
      const newEta = (await now()) + 3 * DAY + 10;
      const sig = 'setMintLimitPerBlock(uint256)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [ethers.parseUnits('9999', 18)]
      );
      await newTL
        .connect(outsider)
        .queue(await minter.getAddress(), 0, sig, data, newEta);
      await increaseTime(3 * DAY + 20);
      await newTL
        .connect(outsider)
        .execute(await minter.getAddress(), 0, sig, data, newEta);
      expect(await minter.mintLimitPerBlock()).to.equal(
        ethers.parseUnits('9999', 18)
      );
    });

    it('ownership transfer is delay-gated: executing before eta reverts', async function () {
      // Prove there is no fast-path for `transferOwnership` — the timelock
      // treats it exactly like any other queued call. If we try to execute
      // BEFORE the delay elapses, we get OperationNotReady, not a bypass.
      const eta = (await now()) + DELAY + 5;
      const sig = 'transferOwnership(address)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [outsider.address]
      );
      await timelock.queue(await target.getAddress(), 0, sig, data, eta);

      // Try to execute immediately (0 wait) — must revert
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotReady');

      // Try to execute part-way through the delay — must still revert
      await increaseTime(DELAY / 2);
      await expect(
        timelock.execute(await target.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotReady');

      // Ownership unchanged throughout
      expect(await target.owner()).to.equal(await timelock.getAddress());

      // After the full delay it works
      await increaseTime(DELAY);
      await timelock.execute(await target.getAddress(), 0, sig, data, eta);
      expect(await target.owner()).to.equal(outsider.address);
    });

    it('role grant/renounce is delay-gated: executing before eta reverts', async function () {
      // Same demonstration but for AccessControl.grantRole — no shortcut.
      const adminRole = await handler.DEFAULT_ADMIN_ROLE();
      const eta = (await now()) + DELAY + 5;
      const sig = 'grantRole(bytes32,address)';
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [adminRole, outsider.address]
      );
      await timelock.queue(await handler.getAddress(), 0, sig, data, eta);

      // Immediate execute → OperationNotReady
      await expect(
        timelock.execute(await handler.getAddress(), 0, sig, data, eta)
      ).to.be.revertedWithCustomError(timelock, 'OperationNotReady');

      // Role still not granted
      expect(await handler.hasRole(adminRole, outsider.address)).to.equal(
        false
      );

      await increaseTime(DELAY + 10);
      await timelock.execute(await handler.getAddress(), 0, sig, data, eta);
      expect(await handler.hasRole(adminRole, outsider.address)).to.equal(true);
    });

    it("rotate the timelock's own owner via Ownable2Step (not gated by delay)", async function () {
      // Two-step: transferOwnership queued by current owner, then acceptOwnership
      // by the pending owner. The Ownable2Step transfer itself is NOT gated by
      // the timelock delay — that's intentional; only calls FROM the timelock
      // are gated, not who operates the timelock.
      await timelock.transferOwnership(outsider.address);
      expect(await timelock.owner()).to.equal(owner.address); // still old
      expect(await timelock.pendingOwner()).to.equal(outsider.address);

      await timelock.connect(outsider).acceptOwnership();
      expect(await timelock.owner()).to.equal(outsider.address);

      // Old owner can no longer queue
      const eta = (await now()) + DELAY + 5;
      await expect(
        timelock.queue(
          await target.getAddress(),
          0,
          'setValue(uint256)',
          '0x',
          eta
        )
      ).to.be.revertedWithCustomError(timelock, 'OwnableUnauthorizedAccount');

      // New owner can
      await timelock
        .connect(outsider)
        .queue(
          await target.getAddress(),
          0,
          'setValue(uint256)',
          ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [11n]),
          eta
        );
    });
  });
});
