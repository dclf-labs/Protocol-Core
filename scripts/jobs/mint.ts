import { ethers } from 'hardhat';
import { MinterHandler__factory } from '../../typechain-types';

async function mintUSN(
  providerUrl: string,
  contractAddress: string,
  privateKey: string,
  order: {
    user: string;
    collateralAmount: string;
    usnAmount: string;
    nonce: number;
    expiry: number;
    collateralAddress: string;
  },
  signature: string
): Promise<void> {
  try {
    // Connect to the Ethereum network
    const provider = new ethers.JsonRpcProvider(providerUrl);

    // Create a signer from the private key
    const signer = new ethers.Wallet(privateKey, provider);

    // Create an instance of the MinterHandler contract
    const minterHandlerContract = MinterHandler__factory.connect(
      contractAddress,
      signer
    );

    // Mint the tokens using the mint function of MinterHandler
    const tx = await minterHandlerContract.mint(order, signature);

    // Wait for the transaction to be mined
    await tx.wait();

    console.log(`Successfully minted ${order.usnAmount} USN to ${order.user}`);
  } catch (error) {
    console.error('Error minting USN:', error);
    throw error;
  }
}

export { mintUSN };
