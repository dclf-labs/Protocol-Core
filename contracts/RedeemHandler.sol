// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./interfaces/IRedeemHandler.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract RedeemHandler is AccessControl, EIP712, IRedeemHandler, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Constants
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant REDEEM_MANAGER_ROLE = keccak256("REDEEM_MANAGER_ROLE");
    bytes32 private constant REDEEM_TYPEHASH =
        keccak256(
            "RedeemOrder(string message,address user,address collateralAddress,uint256 collateralAmount,uint256 usnAmount,uint256 expiry,uint256 nonce)"
        );

    // State variables
    ERC20Burnable public immutable usnToken;
    mapping(address => bool) public redeemableCollaterals;
    uint256 public redeemLimitPerBlock;
    uint256 public currentBlockRedeemAmount;
    uint256 public lastRedeemBlock;
    mapping(address => mapping(uint256 => bool)) private usedNonces;

    // Constructor
    constructor(address _usnToken) EIP712("RedeemHandler", "1") {
        usnToken = ERC20Burnable(_usnToken);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        redeemLimitPerBlock = 1000000 * 10 ** 18; // Default limit: 1 million USN
    }

    // External functions
    function addRedeemableCollateral(address collateral) external onlyRole(REDEEM_MANAGER_ROLE) {
        if (collateral == address(0)) revert ZeroAddress();
        if (redeemableCollaterals[collateral]) revert CollateralAlreadyAdded();
        redeemableCollaterals[collateral] = true;
        emit CollateralAdded(collateral);
    }

    function removeRedeemableCollateral(address collateral) external onlyRole(REDEEM_MANAGER_ROLE) {
        if (!redeemableCollaterals[collateral]) revert CollateralNotFound();
        redeemableCollaterals[collateral] = false;
        emit CollateralRemoved(collateral);
    }

    function setRedeemLimitPerBlock(uint256 _redeemLimitPerBlock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        redeemLimitPerBlock = _redeemLimitPerBlock;
        emit RedeemLimitPerBlockUpdated(_redeemLimitPerBlock);
    }

    function rescueERC20(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).transfer(msg.sender, amount);
    }

    function redeem(RedeemOrder calldata order, bytes calldata signature) public nonReentrant onlyRole(BURNER_ROLE) {
        if (order.user == address(0)) revert ZeroAddress();
        if (!redeemableCollaterals[order.collateralAddress]) revert InvalidCollateralAddress();
        if (order.usnAmount == 0) revert ZeroAmount();
        if (order.collateralAmount == 0) revert ZeroAmount();
        if (block.timestamp > order.expiry) revert SignatureExpired();
        if (usedNonces[order.user][order.nonce]) revert InvalidNonce();

        bytes32 hash = hashOrder(order);
        if (!_isValidSignature(order.user, hash, signature)) revert InvalidSignature();

        uint256 currentAllowance = usnToken.allowance(order.user, address(this));
        if (currentAllowance < order.usnAmount) revert InsufficientAllowance();

        if (block.number > lastRedeemBlock) {
            currentBlockRedeemAmount = 0;
            lastRedeemBlock = block.number;
        }

        if (currentBlockRedeemAmount + order.usnAmount > redeemLimitPerBlock) {
            revert RedeemLimitExceeded(redeemLimitPerBlock, currentBlockRedeemAmount + order.usnAmount);
        }

        currentBlockRedeemAmount += order.usnAmount;
        usedNonces[order.user][order.nonce] = true;

        usnToken.burnFrom(order.user, order.usnAmount);

        IERC20(order.collateralAddress).safeTransfer(order.user, order.collateralAmount);

        emit Redeemed(order.user, order.collateralAddress, order.usnAmount, order.collateralAmount);
    }

    function redeemWithPermit(
        RedeemOrder calldata order,
        bytes calldata signature,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyRole(BURNER_ROLE) {
        bytes32 hash = hashOrder(order);
        if (!_isValidSignature(order.user, hash, signature)) revert InvalidSignature();

        try
            IERC20Permit(address(usnToken)).permit(order.user, address(this), order.usnAmount, order.expiry, v, r, s)
        {} catch {}

        redeem(order, signature);
    }

    // Public functions
    function hashOrder(RedeemOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(encodeOrder(order)));
    }

    function encodeOrder(RedeemOrder calldata order) public pure returns (bytes memory) {
        return
            abi.encode(
                REDEEM_TYPEHASH,
                keccak256(bytes(order.message)),
                order.user,
                order.collateralAddress,
                order.collateralAmount,
                order.usnAmount,
                order.expiry,
                order.nonce
            );
    }

    // Internal functions
    function _isValidSignature(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            // EOA
            return ECDSA.recover(hash, signature) == signer;
        } else {
            // Contract wallet
            try IERC1271(signer).isValidSignature(hash, signature) returns (bytes4 magicValue) {
                return magicValue == IERC1271.isValidSignature.selector;
            } catch {
                return false;
            }
        }
    }
}
