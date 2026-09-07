import { ethers, network } from 'hardhat';
import type {
  USNUpgradeableHyperlane,
  StakedUSNOFTHyperlane,
  StakingVaultOFTUpgradeableHyperlane,
} from '../typechain-types';

export const TRANSPORT_LZ = 0;
export const TRANSPORT_HYPERLANE = 1;
export const CHAIN_ID_SRC = 1;
export const CHAIN_ID_DST = 2;
export const HL_DOMAIN = 99;
export const DECIMAL_CONVERSION_RATE = 10n ** 12n;
export const LZ_OPTIONS = '0x00030100110100000000000000000000000000030d40';

export function encodeOFTMsg(recipient: string, amountLD: bigint): string {
  const recipientB32 = ethers.zeroPadValue(recipient, 32);
  const amountSD = amountLD / DECIMAL_CONVERSION_RATE;
  return ethers.concat([recipientB32, ethers.toBeHex(amountSD, 8)]);
}

export async function lzReceiveAs(
  endpointAddress: string,
  token: USNUpgradeableHyperlane | StakedUSNOFTHyperlane | StakingVaultOFTUpgradeableHyperlane,
  srcEid: number,
  peerAddress: string,
  recipientAddress: string,
  amountLD: bigint
) {
  await network.provider.send('hardhat_setBalance', [
    endpointAddress,
    '0x1000000000000000000',
  ]);
  const impersonated = await ethers.getImpersonatedSigner(endpointAddress);
  const origin = {
    srcEid,
    sender: ethers.zeroPadValue(peerAddress, 32),
    nonce: 1n,
  };
  const guid = ethers.zeroPadValue('0x01', 32);
  const message = encodeOFTMsg(recipientAddress, amountLD);
  return token
    .connect(impersonated)
    .lzReceive(origin, guid, message, ethers.ZeroAddress, '0x');
}
