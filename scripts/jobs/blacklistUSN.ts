import { ethers } from 'hardhat';
import { USN__factory } from '../../typechain-types';

async function blacklistAccountUSN(
  providerUrl: string,
  contractAddress: string,
  privateKey: string,
  accountToBlacklist: string
): Promise<void> {
  try {
    // Connect to the Ethereum network
    const provider = new ethers.JsonRpcProvider(providerUrl);

    // Create a signer from the private key
    const signer = new ethers.Wallet(privateKey, provider);

    // Create an instance of the USN contract
    const usnContract = USN__factory.connect(contractAddress, signer);

    // Blacklist the account
    const tx = await usnContract.blacklistAccount(accountToBlacklist);

    // Wait for the transaction to be mined
    await tx.wait();

    console.log(`Successfully blacklisted account: ${accountToBlacklist}`);
  } catch (error) {
    console.error('Error blacklisting account:', error);
    throw error;
  }
}

export { blacklistAccountUSN };
