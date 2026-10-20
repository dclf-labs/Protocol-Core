import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type {
  StakingVaultOFTUpgradeableHyperlane,
  EndpointV2Mock,
  MockERC20,
  WithdrawalHandler,
} from '../typechain-types';

// Hashlock L-02: redeem() accepted a delegated call (msg.sender holding an
// ERC-20 allowance from `owner`) but filed the withdrawal claim under
// msg.sender, so a spender burned the owner's shares and collected the claim
// itself — or, if the spender was whitelisted, took the assets directly.
// withdraw() already rejected delegation. redeem() now does too, so the two
// agree and the owner's shares can only be redeemed by the owner.
describe('StakingVaultOFTUpgradeableHyperlane — delegated redeem (L-02)', function () {
  let vault: StakingVaultOFTUpgradeableHyperlane;
  let asset: MockERC20;
  let endpoint: EndpointV2Mock;
  let withdrawalHandler: WithdrawalHandler;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let spender: HardhatEthersSigner;

  const DEPOSIT = ethers.parseUnits('1000', 18);
  const SHARES = ethers.parseUnits('1000', 18); // 1:1 on a fresh vault

  beforeEach(async function () {
    [admin, holder, spender] = await ethers.getSigners();

    const ERC20Factory = await ethers.getContractFactory('MockERC20');
    asset = (await ERC20Factory.deploy(
      'Mock Asset',
      'mASSET'
    )) as unknown as MockERC20;

    const EndpointFactory = await ethers.getContractFactory('EndpointV2Mock');
    endpoint = (await EndpointFactory.deploy(1)) as unknown as EndpointV2Mock;

    const VaultFactory = await ethers.getContractFactory(
      'StakingVaultOFTUpgradeableHyperlane'
    );
    const proxy = await upgrades.deployProxy(
      VaultFactory,
      [
        await asset.getAddress(),
        'Staked Vault',
        'sVLT',
        await admin.getAddress(),
      ],
      {
        initializer: 'initialize',
        constructorArgs: [await endpoint.getAddress()],
        unsafeAllow: ['constructor'],
      }
    );
    vault = VaultFactory.attach(
      await proxy.getAddress()
    ) as unknown as StakingVaultOFTUpgradeableHyperlane;

    // Non-whitelisted exits go through the withdrawal handler; wire it the
    // same way the LZ vault suite does.
    const HandlerFactory = await ethers.getContractFactory('WithdrawalHandler');
    withdrawalHandler = (await HandlerFactory.deploy(
      await asset.getAddress(),
      24 * 60 * 60
    )) as unknown as WithdrawalHandler;
    await withdrawalHandler.grantRole(
      await withdrawalHandler.STAKING_VAULT_ROLE(),
      await vault.getAddress()
    );
    await vault.setWithdrawalHandler(await withdrawalHandler.getAddress());

    // holder deposits and approves spender for all of their shares — the
    // exact precondition for the delegated call the audit exercised.
    await asset.mint(await holder.getAddress(), DEPOSIT);
    await asset.connect(holder).approve(await vault.getAddress(), DEPOSIT);
    await vault.connect(holder).deposit(DEPOSIT, await holder.getAddress());
    await vault.connect(holder).approve(await spender.getAddress(), SHARES);
  });

  it("non-whitelisted spender with allowance cannot redeem on the owner's behalf", async function () {
    const sharesBefore = await vault.balanceOf(await holder.getAddress());
    const allowanceBefore = await vault.allowance(
      await holder.getAddress(),
      await spender.getAddress()
    );

    // The only receiver a non-whitelisted caller may pass. Pre-fix this
    // burned holder's shares and queued a claim for spender.
    await expect(
      vault
        .connect(spender)
        .redeem(
          SHARES,
          await withdrawalHandler.getAddress(),
          await holder.getAddress()
        )
    ).to.be.revertedWithCustomError(vault, 'Unauthorized');

    // Rejected before any state change: shares intact, allowance untouched,
    // nothing queued at the handler.
    expect(await vault.balanceOf(await holder.getAddress())).to.equal(
      sharesBefore
    );
    expect(
      await vault.allowance(
        await holder.getAddress(),
        await spender.getAddress()
      )
    ).to.equal(allowanceBefore);
    expect(
      await asset.balanceOf(await withdrawalHandler.getAddress())
    ).to.equal(0n);
  });

  it("whitelisted spender with allowance cannot redeem on the owner's behalf (the direct-payout case)", async function () {
    // Pre-fix this was the harder-to-reverse variant: whitelisted callers
    // skip the queue, so spender received the assets immediately.
    await vault.whitelistAccount(await spender.getAddress());
    const sharesBefore = await vault.balanceOf(await holder.getAddress());

    await expect(
      vault
        .connect(spender)
        .redeem(SHARES, await spender.getAddress(), await holder.getAddress())
    ).to.be.revertedWithCustomError(vault, 'Unauthorized');

    expect(await vault.balanceOf(await holder.getAddress())).to.equal(
      sharesBefore
    );
    expect(await asset.balanceOf(await spender.getAddress())).to.equal(0n);
  });

  it('redeem and withdraw now agree: delegated withdraw is rejected the same way', async function () {
    await expect(
      vault
        .connect(spender)
        .withdraw(
          DEPOSIT,
          await withdrawalHandler.getAddress(),
          await holder.getAddress()
        )
    ).to.be.revertedWithCustomError(vault, 'Unauthorized');
  });

  it('owner redeeming their own shares via the queue still works and files the claim under the owner', async function () {
    const assetsBefore = await asset.balanceOf(
      await withdrawalHandler.getAddress()
    );

    await expect(
      vault
        .connect(holder)
        .redeem(
          SHARES,
          await withdrawalHandler.getAddress(),
          await holder.getAddress()
        )
    )
      .to.emit(vault, 'WithdrawalDemandCreated')
      .withArgs(await holder.getAddress(), DEPOSIT, (ts: bigint) => ts > 0n);

    expect(await vault.balanceOf(await holder.getAddress())).to.equal(0n);
    expect(
      await asset.balanceOf(await withdrawalHandler.getAddress())
    ).to.equal(assetsBefore + DEPOSIT);
  });

  it('whitelisted owner redeeming their own shares directly still works', async function () {
    await vault.whitelistAccount(await holder.getAddress());

    await vault
      .connect(holder)
      .redeem(SHARES, await holder.getAddress(), await holder.getAddress());

    expect(await vault.balanceOf(await holder.getAddress())).to.equal(0n);
    expect(await asset.balanceOf(await holder.getAddress())).to.equal(DEPOSIT);
  });

  it('owner check runs first: zero shares from the owner still reverts ZeroAmount', async function () {
    await expect(
      vault
        .connect(holder)
        .redeem(
          0n,
          await withdrawalHandler.getAddress(),
          await holder.getAddress()
        )
    ).to.be.revertedWithCustomError(vault, 'ZeroAmount');
  });
});
