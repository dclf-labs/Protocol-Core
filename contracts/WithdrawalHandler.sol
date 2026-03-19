// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract WithdrawalHandler is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct WithdrawalRequest {
        uint256 amount;
        uint256 timestamp;
        bool claimed;
    }

    bytes32 public constant STAKING_VAULT_ROLE = keccak256("STAKING_VAULT_ROLE");
    
    IERC20 public immutable usn;
    uint256 public withdrawPeriod;
    
    // user => requestId => WithdrawalRequest
    mapping(address => mapping(uint256 => WithdrawalRequest)) public withdrawalRequests;
    mapping(address => uint256) public nextRequestId;

    event WithdrawalRequestCreated(address indexed user, uint256 indexed requestId, uint256 amount, uint256 timestamp);
    event WithdrawalClaimed(address indexed user, uint256 indexed requestId, uint256 amount);
    event WithdrawPeriodUpdated(uint256 newPeriod);

    error WithdrawPeriodNotElapsed();
    error AlreadyClaimed();
    error Unauthorized();
    error ZeroAmount();

    constructor(address _usn, uint256 _withdrawPeriod) {
        usn = IERC20(_usn);
        withdrawPeriod = _withdrawPeriod;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function createWithdrawalRequest(address user, uint256 amount) external onlyRole(STAKING_VAULT_ROLE) returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        
        uint256 requestId = nextRequestId[user]++;
        withdrawalRequests[user][requestId] = WithdrawalRequest({
            amount: amount,
            timestamp: block.timestamp,
            claimed: false
        });

        emit WithdrawalRequestCreated(user, requestId, amount, block.timestamp);
        return requestId;
    }

    function claimWithdrawal(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawalRequests[msg.sender][requestId];
        
        if (request.amount == 0) revert Unauthorized();
        if (request.claimed) revert AlreadyClaimed();
        if (block.timestamp < request.timestamp + withdrawPeriod) revert WithdrawPeriodNotElapsed();

        request.claimed = true;
        usn.safeTransfer(msg.sender, request.amount);

        emit WithdrawalClaimed(msg.sender, requestId, request.amount);
    }

    function setWithdrawPeriod(uint256 _newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        withdrawPeriod = _newPeriod;
        emit WithdrawPeriodUpdated(_newPeriod);
    }

    function getWithdrawalRequest(address user, uint256 requestId) external view returns (WithdrawalRequest memory) {
        return withdrawalRequests[user][requestId];
    }

    function getUserNextRequestId(address user) external view returns (uint256) {
        return nextRequestId[user];
    }
}