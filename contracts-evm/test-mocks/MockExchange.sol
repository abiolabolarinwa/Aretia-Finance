// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * TEST ONLY. Never deployed. A small stand-in for a Uniswap V2 exchange, with the same observable behaviour at the points the curve
 * depends on: `addLiquidityETH` follows V2's `_addLiquidity` (the first deposit sets the price; later ones are trimmed to the pool's
 * ratio and must meet the minimums), refunds unused coin to the caller, and records where the liquidity went. `seedPool` makes a pool at
 * any price, to test someone else creating it first. The same curve tests also run against the real Uniswap V2 code on a fork.
 */
interface IToken {
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

contract MockPair {
    address public token0;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address token0_) {
        token0 = token0_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function set(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }
}

contract MockExchange {
    address public immutable WETH = address(0x00000000000000000000000000000000000bEe70);
    mapping(address => mapping(address => address)) public getPair;
    address public lastLiquidityTo;
    uint256 public lastLiquidity;

    function factory() external view returns (address) {
        return address(this);
    }

    function _pairFor(address token) internal returns (MockPair p) {
        address existing = getPair[token][WETH];
        if (existing != address(0)) return MockPair(existing);
        p = new MockPair(token < WETH ? token : WETH);
        getPair[token][WETH] = address(p);
        getPair[WETH][token] = address(p);
    }

    /** Makes the pool for `token` at the given reserves (in the pair's own order: token first, coin second). */
    function seedPool(address token, uint112 tokenReserve, uint112 coinReserve) external {
        MockPair p = _pairFor(token);
        (uint112 r0, uint112 r1) = p.token0() == token ? (tokenReserve, coinReserve) : (coinReserve, tokenReserve);
        p.set(r0, r1);
    }

    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        require(deadline >= block.timestamp, "expired");
        MockPair p = _pairFor(token);
        (uint112 r0, uint112 r1, ) = p.getReserves();
        (uint256 rToken, uint256 rCoin) = p.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rToken == 0 && rCoin == 0) {
            (amountToken, amountETH) = (amountTokenDesired, msg.value);
        } else {
            uint256 coinOptimal = (amountTokenDesired * rCoin) / rToken;
            if (coinOptimal <= msg.value) {
                require(coinOptimal >= amountETHMin, "INSUFFICIENT_B_AMOUNT");
                (amountToken, amountETH) = (amountTokenDesired, coinOptimal);
            } else {
                uint256 tokenOptimal = (msg.value * rToken) / rCoin;
                require(tokenOptimal <= amountTokenDesired && tokenOptimal >= amountTokenMin, "INSUFFICIENT_A_AMOUNT");
                (amountToken, amountETH) = (tokenOptimal, msg.value);
            }
        }
        require(IToken(token).transferFrom(msg.sender, address(p), amountToken), "pull");
        uint256 nt = rToken + amountToken;
        uint256 nc = rCoin + amountETH;
        if (p.token0() == token) p.set(uint112(nt), uint112(nc));
        else p.set(uint112(nc), uint112(nt));
        lastLiquidityTo = to;
        liquidity = amountToken + amountETH;
        lastLiquidity = liquidity;
        if (msg.value > amountETH) {
            (bool ok, ) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "refund");
        }
    }
}

/** TEST ONLY. A buyer that tries to re-enter the curve while it is being paid or refunded. */
interface ICurve {
    function buy(address token, uint256 minTokensOut) external payable;
    function sell(address token, uint256 tokensIn, uint256 minCoinOut) external;
}

contract Reenter {
    ICurve public immutable curve;
    address public immutable token;
    /** 0: do nothing. 1: buy again from the refund. 2: sell from the refund. */
    uint256 public mode;
    bool public blocked;
    bool public nestedOk;

    constructor(address curve_, address token_) {
        curve = ICurve(curve_);
        token = token_;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function approveCurve(uint256 amount) external {
        IToken(token).approve(address(curve), amount);
    }

    function sellOnce(uint256 amount) external {
        curve.sell(token, amount, 0);
    }

    function buyOnce(uint256 minOut) external payable {
        curve.buy{value: msg.value}(token, minOut);
    }

    receive() external payable {
        if (mode == 1) {
            try curve.buy{value: 1e12}(token, 0) {} catch { blocked = true; }
        } else if (mode == 2) {
            try curve.sell(token, 1, 0) { nestedOk = true; } catch { blocked = true; }
        }
    }
}
