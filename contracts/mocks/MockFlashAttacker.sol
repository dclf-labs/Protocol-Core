// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMinterHandlerV2Attack {
    function directMint(address collateralAddress, uint256 collateralAmount, uint256 minUsnAmount) external;
}

interface IRedeemHandlerV2Attack {
    function directRedeem(address collateralAddress, uint256 usnAmount, uint256 minCollateralAmount)
        external
        returns (uint256);
}

/// @dev Test helper that executes the cycling attack from issue #13 in a single
///      external call. Success means the redeemed collateral came back inside
///      the same transaction (which would let a flashloan be repaid). With the
///      fix in place, `directRedeem` only queues, so this contract holds zero
///      collateral after `attack` returns.
contract MockFlashAttacker {
    function attack(
        address minter,
        address handler,
        address collateralToken,
        address usnToken,
        uint256 collateralIn
    ) external {
        IERC20(collateralToken).approve(minter, collateralIn);
        IMinterHandlerV2Attack(minter).directMint(collateralToken, collateralIn, 0);

        uint256 minted = IERC20(usnToken).balanceOf(address(this));
        IERC20(usnToken).approve(handler, minted);
        IRedeemHandlerV2Attack(handler).directRedeem(collateralToken, minted, 0);
    }
}
