/**
 * Pre-acceptance check for a deployed SelectiveTimelock. Run it BEFORE the Safe signs acceptOwnership, and again
 * after the hand-over batch. Exits 1 on any finding.
 *
 * Checks
 *   ownership   : before hand-over  owner == deployer-ish (anything), pendingOwner == SAFE, USN.owner == SAFE
 *                 after hand-over   owner == SAFE, pendingOwner == 0, USN.owner == timelock
 *   delay map   : the nine DELAYED selectors == DELAY; every other selector ever scheduled (DelayChangeScheduled
 *                 events) == 0 and nothing pending (pendingDelayEta == 0 everywhere)
 *   queue       : no OperationQueued whose opHash is still queued
 *   dormant     : no DirectCall / OperationExecuted ever emitted (a fresh timelock has done nothing)
 *
 *   TIMELOCK=0x… npx hardhat run scripts/verify-selective-timelock.ts --network mainnet
 * Env: TIMELOCK (required), SAFE, USN, DELAY (default 86400), FROM_BLOCK (default: latest - 50k blocks; pass the deployment block for older timelocks).
 */
import { ethers } from 'hardhat';

const TIMELOCK = process.env.TIMELOCK;
const SAFE = process.env.SAFE ?? '0x1ea169EcCcf7714E7ba04900e1a3357cCA77327f';
const USN = process.env.USN ?? '0xdA67B4284609d2d48e5d10cfAc411572727dc1eD';
const DELAY = BigInt(process.env.DELAY ?? 86400);

const USN_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function setAdmin(address)',
  'function configureHyperlane(address)',
  'function configureISM(address)',
  'function registerHyperlaneRemoteToken(uint32,bytes32)',
  'function setPeer(uint32,bytes32)',
  'function setDelegate(address)',
  'function setRateLimiter(address)',
  'function transferOwnership(address)',
  'function renounceOwnership()',
];
const DELAYED = [
  'setAdmin',
  'configureHyperlane',
  'configureISM',
  'registerHyperlaneRemoteToken',
  'setPeer',
  'setDelegate',
  'setRateLimiter',
  'transferOwnership',
  'renounceOwnership',
];

async function main() {
  if (!TIMELOCK) throw new Error('TIMELOCK env required');
  const p = ethers.provider;
  const tl = await ethers.getContractAt('SelectiveTimelock', TIMELOCK);
  const usn = new ethers.Contract(USN, USN_ABI, p);
  const iface = new ethers.Interface(USN_ABI);
  const sel = (fn: string) => iface.getFunction(fn)!.selector;
  const findings: string[] = [];
  const ok = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) findings.push(msg);
  };

  // ---- ownership
  const [owner, pending, usnOwner, usnPending] = await Promise.all([
    tl.owner(),
    tl.pendingOwner(),
    usn.owner(),
    usn.pendingOwner(),
  ]);
  const handedOver = owner === SAFE;
  console.log(
    `timelock ${TIMELOCK}: owner ${owner} pendingOwner ${pending} | USN owner ${usnOwner} pendingOwner ${usnPending}`
  );
  console.log(`phase: ${handedOver ? 'AFTER hand-over' : 'BEFORE acceptance'}`);
  if (!handedOver) {
    ok(pending === SAFE, 'pendingOwner is the Safe');
    ok(usnOwner === SAFE, 'USN still owned by the Safe');
  } else {
    ok(pending === ethers.ZeroAddress, 'no pending owner on the timelock');
    ok(usnOwner === TIMELOCK, 'USN owned by the timelock');
    ok(usnPending === ethers.ZeroAddress, 'no pending owner on USN');
  }

  // ---- delay map: expected pairs
  for (const fn of DELAYED) {
    const d = await tl.delay(USN, sel(fn));
    ok(d === DELAY, `delay ${fn} (${sel(fn)}) == ${DELAY}s (is ${d}s)`);
  }

  // ---- events: every pair ever scheduled, every op ever queued
  let from = Number(process.env.FROM_BLOCK ?? 0);
  if (!from) {
    // default window: the last 50k blocks (~1 week); pass FROM_BLOCK=<deployment block> for older deployments
    const latest = await p.getBlockNumber();
    from = Math.max(0, latest - 50_000);
  }
  // public RPCs cap eth_getLogs at ~10k blocks per call: walk the range in chunks
  const latestBlock = await p.getBlockNumber();
  const logs = async (filter: any) => {
    const out: any[] = [];
    for (let a = from; a <= latestBlock; a += 9_000) {
      out.push(
        ...(await tl.queryFilter(filter, a, Math.min(a + 8_999, latestBlock)))
      );
    }
    return out;
  };
  const scheduled = await logs(tl.filters.DelayChangeScheduled());
  const updated = await logs(tl.filters.DelayUpdated());
  const queuedEv = await logs(tl.filters.OperationQueued());
  const executed = await logs(tl.filters.OperationExecuted());
  const direct = await logs(tl.filters.DirectCall());
  console.log(
    `events since block ${from}: DelayChangeScheduled ${scheduled.length}, DelayUpdated ${updated.length}, OperationQueued ${queuedEv.length}, OperationExecuted ${executed.length}, DirectCall ${direct.length}`
  );

  const pairs = new Map<string, { target: string; selector: string }>();
  for (const e of [...scheduled, ...updated]) {
    const a = (e as any).args;
    pairs.set(`${a.target}:${a.selector}`, {
      target: a.target,
      selector: a.selector,
    });
  }
  const expected = new Set(DELAYED.map((fn) => `${USN}:${sel(fn)}`));
  for (const [key, { target, selector }] of pairs) {
    const [d, pd, pe] = await Promise.all([
      tl.delay(target, selector),
      tl.pendingDelay(target, selector),
      tl.pendingDelayEta(target, selector),
    ]);
    ok(
      pe === 0n,
      `no pending delay change on ${target.slice(0, 10)}…:${selector} (pending ${pd}s eta ${pe})`
    );
    if (!expected.has(key))
      ok(
        d === 0n,
        `unexpected pair ${target}:${selector} has delay 0 (is ${d}s)`
      );
  }
  for (const e of queuedEv) {
    const h = (e as any).args.opHash;
    ok(!(await tl.queued(h)), `operation ${h} is not queued any more`);
  }
  if (!handedOver) {
    ok(
      executed.length === 0 && direct.length === 0,
      'timelock has never executed or direct-called anything'
    );
    ok(queuedEv.length === 0, 'nothing was ever queued');
  }

  console.log(
    findings.length
      ? `\n✗ ${findings.length} finding(s) — do NOT accept:`
      : '\n✓ clean'
  );
  for (const f of findings) console.log(`   - ${f}`);
  if (findings.length) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
