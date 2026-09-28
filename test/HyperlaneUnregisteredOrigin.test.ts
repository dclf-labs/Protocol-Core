import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { EndpointV2Mock } from '../typechain-types';

// Hashlock L-04: every Hyperlane receiver compared `_sender` against
// `remoteTokens[_origin]` but never required a registration to exist. For an
// origin that was never registered the lookup is bytes32(0), so a forged
// message with sender = 0 passed authentication (and, on the rate-limited
// contracts, hit an unconfigured — unlimited — bucket). All six receivers now
// reject an unregistered origin outright.
//
// The mailbox is a plain signer: handle() only checks msg.sender == mailbox,
// so no mock is needed to drive the inbound path.
const REGISTERED_ORIGIN = 239;
const UNREGISTERED_ORIGIN = 777777;
const ZERO_SENDER = ethers.ZeroHash;

type Receiver = {
  name: string;
  deploy: () => Promise<any>;
  // Put `amount` worth of receivable supply in place for the happy path
  // (escrowed shares for the vault; nothing for the mint-on-receive tokens).
  prepare?: (token: any, amount: bigint) => Promise<void>;
};

describe('Hyperlane handle() — unregistered origins are rejected (L-04)', function () {
  let owner: HardhatEthersSigner;
  let mailbox: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let endpoint: EndpointV2Mock;
  let remoteToken: string;

  const AMOUNT = ethers.parseUnits('1000', 18);

  function message(recipient: string, amount: bigint) {
    return ethers.concat([
      ethers.zeroPadValue(recipient, 32),
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
  }

  async function deployProxy(
    name: string,
    args: unknown[],
    constructorArgs?: unknown[]
  ) {
    const Factory = await ethers.getContractFactory(name);
    const proxy = await upgrades.deployProxy(Factory, args, {
      initializer: 'initialize',
      ...(constructorArgs
        ? { constructorArgs, unsafeAllow: ['constructor'] }
        : { unsafeAllow: ['constructor'] }),
    });
    return Factory.attach(await proxy.getAddress());
  }

  before(async function () {
    [owner, mailbox, user, admin] = await ethers.getSigners();
    const EndpointFactory = await ethers.getContractFactory('EndpointV2Mock');
    endpoint = await EndpointFactory.deploy(1);
    remoteToken = ethers.hexlify(ethers.randomBytes(32));
  });

  const receivers: Receiver[] = [
    {
      name: 'USNUpgradeableHyperlane',
      deploy: async () => {
        const usn: any = await deployProxy(
          'USNUpgradeableHyperlane',
          ['USN', 'USN', owner.address],
          [await endpoint.getAddress()]
        );
        // Transfers/mints are whitelist-gated until permissionless mode is on.
        await usn.enablePermissionless();
        return usn;
      },
    },
    {
      name: 'StakingVaultOFTUpgradeableHyperlane',
      deploy: async () => {
        const usn: any = await deployProxy(
          'USNUpgradeableHyperlane',
          ['USN', 'USN', owner.address],
          [await endpoint.getAddress()]
        );
        await usn.enablePermissionless();
        await usn.setAdmin(admin.address);
        const vault = await deployProxy(
          'StakingVaultOFTUpgradeableHyperlane',
          [await usn.getAddress(), 'sUSN', 'sUSN', owner.address],
          [await endpoint.getAddress()]
        );
        (vault as any).__usn = usn;
        return vault;
      },
      // handle() unlocks escrowed shares (`_update(address(this), …)`), so the
      // vault must hold shares before an inbound message can succeed.
      prepare: async (vault: any, amount: bigint) => {
        const usn = vault.__usn;
        await usn.connect(admin).mint(owner.address, amount);
        await usn.approve(await vault.getAddress(), amount);
        await vault.deposit(amount, await vault.getAddress());
      },
    },
    {
      name: 'remote/StakedUSNHyperlane',
      deploy: async () =>
        deployProxy('StakedUSNHyperlane', ['sUSN', 'sUSN', owner.address]),
    },
    {
      name: 'remote/StakedUSNOFTHyperlane',
      deploy: async () =>
        deployProxy(
          'StakedUSNOFTHyperlane',
          ['sUSN', 'sUSN', owner.address],
          [await endpoint.getAddress()]
        ),
    },
    {
      name: 'periphery/USNHyperlane',
      deploy: async () =>
        deployProxy('USNHyperlane', ['USN', 'USN', owner.address]),
    },
    {
      name: 'periphery/USNOFTHyperlane',
      deploy: async () =>
        deployProxy(
          'USNOFTHyperlane',
          ['USN', 'USN', owner.address],
          [await endpoint.getAddress()]
        ),
    },
  ];

  for (const r of receivers) {
    describe(r.name, function () {
      let token: any;

      beforeEach(async function () {
        token = await r.deploy();
        await token.configureHyperlane(mailbox.address);
        await token.registerHyperlaneRemoteToken(
          REGISTERED_ORIGIN,
          remoteToken
        );
        if (r.prepare) await r.prepare(token, AMOUNT);
      });

      it('rejects an unregistered origin with sender = 0 (the forged-message case)', async function () {
        const balBefore = await token.balanceOf(user.address);
        await expect(
          token
            .connect(mailbox)
            .handle(
              UNREGISTERED_ORIGIN,
              ZERO_SENDER,
              message(user.address, AMOUNT)
            )
        ).to.be.revertedWithCustomError(token, 'InvalidRemoteToken');
        expect(await token.balanceOf(user.address)).to.equal(balBefore);
      });

      it('rejects an unregistered origin with a non-zero sender', async function () {
        await expect(
          token
            .connect(mailbox)
            .handle(
              UNREGISTERED_ORIGIN,
              remoteToken,
              message(user.address, AMOUNT)
            )
        ).to.be.revertedWithCustomError(token, 'InvalidRemoteToken');
      });

      it('rejects a registered origin with the wrong sender (including 0)', async function () {
        const wrong = ethers.hexlify(ethers.randomBytes(32));
        await expect(
          token
            .connect(mailbox)
            .handle(REGISTERED_ORIGIN, wrong, message(user.address, AMOUNT))
        ).to.be.revertedWithCustomError(token, 'InvalidRemoteToken');
        await expect(
          token
            .connect(mailbox)
            .handle(
              REGISTERED_ORIGIN,
              ZERO_SENDER,
              message(user.address, AMOUNT)
            )
        ).to.be.revertedWithCustomError(token, 'InvalidRemoteToken');
      });

      it('still accepts a registered origin with the registered sender', async function () {
        const balBefore = await token.balanceOf(user.address);
        await expect(
          token
            .connect(mailbox)
            .handle(
              REGISTERED_ORIGIN,
              remoteToken,
              message(user.address, AMOUNT)
            )
        )
          .to.emit(token, 'HyperlaneTransfer')
          .withArgs(REGISTERED_ORIGIN, remoteToken, AMOUNT, false);
        expect(await token.balanceOf(user.address)).to.equal(
          balBefore + AMOUNT
        );
      });

      it('rejects the same origin id on a deployment where it was never registered', async function () {
        // registerHyperlaneRemoteToken refuses bytes32(0), so a registration
        // cannot be cleared; a fresh deployment is the never-registered state.
        const fresh = await r.deploy();
        await fresh.configureHyperlane(mailbox.address);
        await expect(
          fresh
            .connect(mailbox)
            .handle(
              REGISTERED_ORIGIN,
              ZERO_SENDER,
              message(user.address, AMOUNT)
            )
        ).to.be.revertedWithCustomError(fresh, 'InvalidRemoteToken');
      });
    });
  }
});
