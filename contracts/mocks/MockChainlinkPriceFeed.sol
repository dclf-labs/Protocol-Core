// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockChainlinkPriceFeed {
    int256 public price;
    uint256 public updatedAt;
    uint8 private _decimals;

    constructor(int256 _price, uint8 decimals_) {
        price = _price;
        updatedAt = block.timestamp;
        _decimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }

    function setPriceWithoutTimestampUpdate(int256 _price) external {
        price = _price;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt_,
            uint80 answeredInRound
        )
    {
        return (1, price, updatedAt, updatedAt, 1);
    }
}
