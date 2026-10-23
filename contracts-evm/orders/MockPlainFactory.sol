// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract PlainToken {
    mapping(address => uint256) public balanceOf;

    constructor(address to, uint256 supply) {
        balanceOf[to] = supply;
    }
}

/// @dev TEST ONLY. A factory like the ones already deployed: it makes tokens with CREATE and has NO `creatorOf`.
contract MockPlainFactory {
    address public lastToken;

    function make(address to, uint256 supply) external returns (address token) {
        token = address(new PlainToken(to, supply));
        lastToken = token;
    }
}
