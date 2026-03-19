const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

const contractPath = path.join(
  __dirname,
  'abi.json' //../artifacts/@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol/ILayerZeroEndpointV2.json'
);
const contract_artifact = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const abi = contract_artifact;
// Function to decode the error
function decodeError(errorData, abi) {
  const iface = new ethers.Interface(abi);

  try {
    // Try to decode as a custom error
    const decodedError = iface.parseError(errorData);
    return {
      name: decodedError.name,
      args: decodedError.args,
    };
  } catch (e) {
    // If it's not a custom error, it might be a revert string
    try {
      const decodedString = iface.parseError(errorData);
      return {
        name: 'Error',
        args: [decodedString],
      };
    } catch (e2) {
      // If we can't decode it, return the original data
      return {
        name: 'Unknown Error',
        args: [errorData],
      };
    }
  }
}

const errorData = '0x4bbeab07';

const decodedError = decodeError(errorData, abi);
console.log(decodedError);
