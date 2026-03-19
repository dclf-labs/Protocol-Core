import { ethers } from 'hardhat';
import { StakingVault__factory } from '../../typechain-types';

async function rebaseStakingVault(
  providerUrl: string,
  contractAddress: string,
  privateKey: string,
  addedReward: string
): Promise<void> {
  try {
    // Connect to the Ethereum network
    const provider = new ethers.JsonRpcProvider(providerUrl);

    // Create a signer from the private key
    const signer = new ethers.Wallet(privateKey, provider);

    // Create an instance of the StakingVault contract
    const stakingVaultContract = StakingVault__factory.connect(
      contractAddress,
      signer
    );

    // Call the rebase function
    const tx = await stakingVaultContract.rebase(addedReward);

    // Wait for the transaction to be mined
    await tx.wait();

    console.log(
      `Successfully rebased StakingVault to new total supply: ${addedReward}`
    );
  } catch (error) {
    console.error('Error rebasing StakingVault:', error);
    throw error;
  }
}

export { rebaseStakingVault };
