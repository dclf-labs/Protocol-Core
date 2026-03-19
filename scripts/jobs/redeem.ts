import { ethers } from 'ethers';
import { RedeemHandler__factory } from '../../typechain-types';

interface RedeemOrder {
  user: string;
  collateralAddress: string;
  usnAmount: string;
  collateralAmount: string;
  expiry: number;
  nonce: number;
}

export async function redeemUSN(
  rpcUrl: string,
  redeemHandlerAddress: string,
  privateKey: string,
  order: RedeemOrder,
  signature: string
) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const redeemHandler = RedeemHandler__factory.connect(
    redeemHandlerAddress,
    signer
  );

  try {
    const redeemTx = await redeemHandler.redeem(
      {
        user: order.user,
        collateralAddress: order.collateralAddress,
        usnAmount: order.usnAmount,
        collateralAmount: order.collateralAmount,
        expiry: order.expiry,
        nonce: order.nonce,
      },
      signature
    );
    const receipt = await redeemTx.wait();

    if (receipt) {
      console.log('Redeem successful');
      console.log('Transaction hash:', receipt.hash);
      console.log('Gas used:', receipt.gasUsed.toString());
    } else {
      console.log('Transaction failed');
    }
  } catch (error) {
    console.error('Error during redeem:', error);
  }
}
