// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./lzv2-upgradeable/oft-upgradeable/OFTUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IStakedUSNBasicOFT.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IMailbox.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IInterchainSecurityModule.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IMessageRecipient.sol";

contract StakedUSNOFTHyperlane is OFTUpgradeable, AccessControlUpgradeable, IStakedUSNBasicOFT, IMessageRecipient {
    bytes32 public constant BLACKLIST_MANAGER_ROLE = keccak256("BLACKLIST_MANAGER_ROLE");
    uint8 public constant VERSION = 1;

    mapping(address => bool) public blacklist;

    // Hyperlane storage
    IMailbox public mailbox;
    IInterchainSecurityModule private _interchainSecurityModule;
    mapping(uint32 => bytes32) public remoteTokens;
    bool public hyperlaneEnabled;

    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {}

    function initialize(string memory _name, string memory _symbol, address _owner) public initializer {
        __OFT_init(_name, _symbol, _owner);
        __Ownable_init(_owner);
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        _grantRole(BLACKLIST_MANAGER_ROLE, _owner);
    }

    function blacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        blacklist[account] = true;
        emit Blacklisted(account);
    }

    function unblacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        blacklist[account] = false;
        emit Unblacklisted(account);
    }

    function _update(address from, address to, uint256 amount) internal virtual override {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();
        super._update(from, to, amount);
    }

    // Override required functions to resolve conflicts
    function _msgSender() internal view virtual override returns (address) {
        return super._msgSender();
    }

    function _msgData() internal view virtual override returns (bytes calldata) {
        return super._msgData();
    }

    // Setup Hyperlane integration
    function configureHyperlane(address _mailbox) external onlyOwner {
        mailbox = IMailbox(_mailbox);
        hyperlaneEnabled = true;
        emit HyperlaneConfigured(_mailbox);
    }

    function configureISM(address _ism) external onlyOwner {
        _interchainSecurityModule = IInterchainSecurityModule(_ism);
    }

    // Register a remote Hyperlane token contract
    function registerHyperlaneRemoteToken(uint32 _domain, bytes32 _remoteToken) external onlyOwner {
        require(_remoteToken != bytes32(0), "Invalid remote token");
        remoteTokens[_domain] = _remoteToken;
        emit RemoteTokenSet(_domain, _remoteToken);
    }

    // Send tokens via Hyperlane
    function sendTokensViaHyperlane(uint32 _destinationDomain, bytes32 _recipient, uint256 _amount) external payable {
        if (!hyperlaneEnabled) revert HyperlaneNotEnabled();
        if (_amount == 0) revert InvalidAmount();
        if (_recipient == bytes32(0)) revert InvalidRecipient();
        bytes32 remoteToken = remoteTokens[_destinationDomain];
        if (remoteToken == bytes32(0)) revert RemoteTokenNotRegistered();

        // Burn tokens first
        _burn(msg.sender, _amount);

        // Encode message with recipient and amount
        bytes memory messageBody = abi.encodePacked(_recipient, _amount);

        // Fee handling with refund
        uint256 requiredFee = mailbox.quoteDispatch(_destinationDomain, remoteToken, messageBody, hex"0001");
        if (msg.value < requiredFee) revert InsufficientInterchainFee();
        uint256 excessFee = msg.value - requiredFee;
        // Send only the required fee amount
        mailbox.dispatch{ value: requiredFee }(_destinationDomain, remoteToken, messageBody, hex"0001");
        // Refund excess ETH if any
        if (excessFee > 0) {
            (bool success, ) = msg.sender.call{ value: excessFee }("");
            require(success, "ETH refund failed");
        }

        emit HyperlaneTransfer(
            _destinationDomain,
            _recipient,
            _amount,
            true // isSending = true
        );
    }

    /**
     * @dev Mints tokens to recipient when mailbox receives transfer message.
     * @dev Emits `HyperlaneTransfer` event on the destination chain.
     * @param _origin The identifier of the origin chain.
     * @param _sender The sender address (remote token contract).
     * @param _message The encoded remote transfer message containing the recipient address and amount.
     */
    function handle(uint32 _origin, bytes32 _sender, bytes calldata _message) external payable override onlyMailbox {
        if (!hyperlaneEnabled) revert HyperlaneNotEnabled();

        // Verify sender is registered remote token
        bytes32 expectedToken = remoteTokens[_origin];
        if (_sender != expectedToken) revert InvalidRemoteToken();

        // Decode message - first 32 bytes for recipient (bytes32), next 32 bytes for amount
        bytes32 recipientBytes32 = bytes32(_message[:32]);
        uint256 amount = uint256(bytes32(_message[32:64]));

        // Convert bytes32 recipient to address
        address recipient = address(uint160(uint256(recipientBytes32)));

        if (recipient == address(0)) revert InvalidRecipient();

        _mint(recipient, amount);

        emit HyperlaneTransfer(
            _origin,
            _sender,
            amount,
            false // isSending = false
        );
    }

    // Required by IMessageRecipient interface
    function interchainSecurityModule() external view returns (IInterchainSecurityModule) {
        return _interchainSecurityModule;
    }

    // Modifier to ensure only mailbox can call handle
    modifier onlyMailbox() {
        if (msg.sender != address(mailbox)) revert OnlyMailboxAllowed();
        _;
    }
}
