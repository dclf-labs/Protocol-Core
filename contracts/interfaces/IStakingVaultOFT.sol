// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IStakingVault.sol";

interface IStakingVaultOFT {
    function initialize(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        address _owner
    ) external;
}
