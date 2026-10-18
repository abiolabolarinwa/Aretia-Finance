// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * TEST ONLY. Never deployed. Hostile stand-ins used to attack contracts-evm/AretiaPool.sol in the test suite:
 *  - HostileToken: an ERC-20 that misbehaves in a chosen way (fee on transfer, false return, lying balance, re-entering the pool).
 *  - HostileFactory: makes HostileTokens by CREATE, so a pool built with it as its "factory" accepts them (the real pool only accepts
 *    tokens from Aretia's real factory; this is how the defence in depth underneath that rule is tested).
 *  - Attacker: a contract wallet that re-enters the pool from its own receive function, or reverts when paid.
 */
contract HostileToken {
    string public name = "Hostile";
    string public symbol = "HST";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) private bal;
    mapping(address => mapping(address => uint256)) public allowance;
    /** 0 normal, 1 burns 1% of every transfer, 2 returns false, 3 re-enters, 4 moves one unit less than asked, 5 moves nothing but returns true */
    uint8 public mode;
    address public target;
    bytes public data;
    bool public bubble;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(uint8 mode_, uint256 supply, address creator) {
        mode = mode_;
        totalSupply = supply;
        bal[creator] = supply;
    }

    function arm(address target_, bytes calldata data_, bool bubble_) external {
        target = target_;
        data = data_;
        bubble = bubble_;
    }

    function balanceOf(address a) external view returns (uint256) {
        return bal[a];
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        return _move(msg.sender, to, v);
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= v, "allowance");
        allowance[from][msg.sender] = a - v;
        return _move(from, to, v);
    }

    function _move(address from, address to, uint256 v) private returns (bool) {
        if (mode == 3 && target != address(0)) {
            reentered = true;
            (bool ok, bytes memory ret) = target.call(data);
            reentrySucceeded = ok;
            if (!ok && bubble) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (mode == 2) return false;
        if (mode == 5) return true;
        if (mode == 4 && v > 0) v -= 1;
        require(bal[from] >= v, "balance");
        bal[from] -= v;
        uint256 got = mode == 1 ? v - v / 100 : v;
        bal[to] += got;
        return true;
    }
}

contract HostileFactory {
    function make(uint8 mode, uint256 supply, address creator) external returns (address) {
        return address(new HostileToken(mode, supply, creator));
    }
}

contract Attacker {
    address public target;
    bytes public data;
    bool public armed;
    bool public refuse;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function exec(address to, bytes calldata d) external payable returns (bool ok) {
        (ok, ) = to.call{value: msg.value}(d);
    }

    function approveToken(address token, address spender, uint256 v) external {
        (bool ok, ) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, v));
        require(ok);
    }

    receive() external payable {
        require(!refuse, "refused");
        if (armed) {
            armed = false;
            reentered = true;
            (bool ok, ) = target.call(data);
            reentrySucceeded = ok;
        }
    }
}
