// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @dev Test-only target for GenericTimelock.
 *      Exposes a handful of owner-gated setters, a payable one, and one that
 *      reverts on purpose so tests can assert error surfacing.
 */
contract MockTimelockTarget is Ownable {
    uint256 public value;
    string public label;
    uint256 public etherReceived;

    event ValueSet(uint256 newValue);
    event LabelSet(string newLabel);
    event Paid(uint256 amount);

    error IntentionalRevert(string reason);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setValue(uint256 _v) external onlyOwner {
        value = _v;
        emit ValueSet(_v);
    }

    function setLabel(string calldata _l) external onlyOwner {
        label = _l;
        emit LabelSet(_l);
    }

    function payMe() external payable onlyOwner {
        etherReceived += msg.value;
        emit Paid(msg.value);
    }

    function alwaysReverts() external onlyOwner {
        revert IntentionalRevert("nope");
    }
}
