// SPDX-License-Identifier: MIT
pragma solidity >=0.8.20 <0.9.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRedeemHandler {
    // Structs
    struct RedeemOrder {
        string message;
        address user;
        address collateralAddress;
        uint256 collateralAmount;
        uint256 usnAmount;
        uint256 expiry;
        uint256 nonce;
    }

    // Custom errors
    error ZeroAddress();
    error CollateralAlreadyAdded();
    error CollateralNotFound();
    error InvalidCollateralAddress();
    error ZeroAmount();
    error SignatureExpired();
    error InvalidSignature();
    error InsufficientAllowance();
    error InvalidNonce();
    error RedeemLimitExceeded(uint256 limit, uint256 attempted);

    // Events
    event Redeemed(address indexed from, address indexed collateral, uint256 usnAmount, uint256 collateralAmount);
    event CollateralAdded(address indexed collateral);
    event CollateralRemoved(address indexed collateral);
    event RedeemLimitPerBlockUpdated(uint256 newLimit);

    // Functions
    function addRedeemableCollateral(address collateral) external;

    function removeRedeemableCollateral(address collateral) external;

    function redeemableCollaterals(address collateral) external view returns (bool);

    function setRedeemLimitPerBlock(uint256 _redeemLimitPerBlock) external;
}
