// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "../lzv2-upgradeable/oft-upgradeable/OFTUpgradeable.sol";
import "../interfaces/IUSN.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IMailbox.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IInterchainSecurityModule.sol";
import "@hyperlane-xyz/core/contracts/interfaces/IMessageRecipient.sol";

contract USNUpgradeableHyperlane is
    Initializable,
    IUSN,
    OFTUpgradeable,
    Ownable2StepUpgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    IMessageRecipient
{
    address public admin;
    bool public permissionless;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public whitelistedAddresses;

    // Hyperlane storage
    IMailbox public mailbox;
    IInterchainSecurityModule private _interchainSecurityModule;
    mapping(uint32 => bytes32) public remoteTokens;
    bool public hyperlaneEnabled;

    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event PermissionlessEnabled();
    event HyperlaneConfigured(address indexed mailbox);
    event RemoteTokenSet(uint32 indexed domain, bytes32 indexed remoteToken);
    event HyperlaneTransfer(uint32 indexed origin, bytes32 indexed sender, uint256 amount, bool isSending);

    error NotWhitelisted(address from, address to);
    error HyperlaneNotEnabled();
    error InvalidAmount();
    error RemoteTokenNotRegistered();
    error InsufficientInterchainFee();
    error InvalidRemoteToken();
    error InvalidRecipient();
    error OnlyMailboxAllowed();

    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {}

    function initialize(string memory name, string memory symbol, address _owner) public initializer {
        __Ownable_init(_owner);
        __ERC20Burnable_init();
        __ERC20Permit_init(name);
        __OFT_init(name, symbol, _owner);
        __Ownable2Step_init();
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
        uint256 requiredFee = mailbox.quoteDispatch(_destinationDomain, remoteToken, messageBody);
        if (msg.value < requiredFee) revert InsufficientInterchainFee();
        uint256 excessFee = msg.value - requiredFee;
        // Send only the required fee amount
        mailbox.dispatch{ value: requiredFee }(_destinationDomain, remoteToken, messageBody);
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

    function setAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminChanged(oldAdmin, newAdmin);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != admin) revert OnlyAdminCanMint();
        _mint(to, amount);
    }

    function blacklistAccount(address account) external onlyOwner {
        blacklist[account] = true;
        emit Blacklisted(account);
    }

    function unblacklistAccount(address account) external onlyOwner {
        blacklist[account] = false;
        emit Unblacklisted(account);
    }

    function addToWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = true;
        emit WhitelistAdded(_address);
    }

    function removeFromWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = false;
        emit WhitelistRemoved(_address);
    }

    function enablePermissionless() external onlyOwner {
        permissionless = true;
        emit PermissionlessEnabled();
    }

    function isWhitelisted(address _address) public view returns (bool) {
        return whitelistedAddresses[_address];
    }

    function decimals() public view virtual override(ERC20Upgradeable, IUSN) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 amount) internal virtual override(ERC20Upgradeable) {
        if (blacklist[from] || blacklist[to]) revert BlacklistedAddress();
        if (!permissionless && (!isWhitelisted(from) || !isWhitelisted(to))) revert NotWhitelisted(from, to);
        super._update(from, to, amount);
    }

    // Update the transferOwnership function
    function transferOwnership(
        address newOwner
    ) public virtual override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    // Update the _transferOwnership function
    function _transferOwnership(
        address newOwner
    ) internal virtual override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
