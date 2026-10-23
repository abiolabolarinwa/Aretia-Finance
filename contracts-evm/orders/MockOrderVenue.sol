// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IOrders {
    function fill(uint256 id, uint256 slice, address venue, bytes calldata data) external;
    function cancel(uint256 id) external;
}

/// @dev TEST ONLY. A swap venue that exchanges at whatever amounts the caller names (paid from its own inventory), plus
/// deliberately hostile functions, so tests can drive the order contract through good fills, bad prices and attacks.
/// It calls tokens with low-level calls so it works with tokens that return nothing (USDT-style).
contract MockOrderVenue {
    function _pullFrom(address token, address from, uint256 amount) private {
        (bool ok, ) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        require(ok, "PULL");
    }

    function _pay(address token, address to, uint256 amount) private {
        (bool ok, ) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok, "PAY");
    }

    /// Takes `spend` of `tokenIn` from the caller (which must have approved this venue) and pays `amountOut` of `tokenOut` to `to`.
    function swap(address tokenIn, address tokenOut, uint256 spend, uint256 amountOut, address to) external {
        _pullFrom(tokenIn, msg.sender, spend);
        _pay(tokenOut, to, amountOut);
    }

    /// Hostile: takes the tokens and sends the output to someone other than the order contract.
    function swapToElsewhere(address tokenIn, address tokenOut, uint256 spend, uint256 amountOut, address to) external {
        _pullFrom(tokenIn, msg.sender, spend);
        _pay(tokenOut, to, amountOut);
    }

    /// Hostile: spends less than it was approved for (keeps the rest of the allowance).
    function swapLess(address tokenIn, address tokenOut, uint256 spend, uint256 amountOut, address to) external {
        _pullFrom(tokenIn, msg.sender, spend - 1);
        _pay(tokenOut, to, amountOut);
    }

    /// Hostile: calls back into the order contract.
    function reenterFill(address orders, uint256 id, uint256 slice) external {
        IOrders(orders).fill(id, slice, address(this), "");
    }

    function reenterCancel(address orders, uint256 id) external {
        IOrders(orders).cancel(id);
    }

    function fail() external pure {
        revert("NOPE");
    }
}

/// @dev TEST ONLY. A plain ERC-20 with a public mint, standing in for a payment asset such as USDC.
contract MockQuote {
    mapping(address => bool) public blocked;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    /// An issuer's blocklist: nothing can be sent to a blocked address.
    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(!blocked[to], "BLOCKED");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        require(!blocked[to], "BLOCKED");
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// @dev TEST ONLY. Like USDT: `transfer`, `transferFrom` and `approve` return nothing, and approving from a non-zero
/// allowance to another non-zero amount reverts.
contract MockNoReturnQuote {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external {
        require(v == 0 || allowance[msg.sender][s] == 0, "USDT: approve from non-zero");
        allowance[msg.sender][s] = v;
    }

    function transferFrom(address from, address to, uint256 v) external {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v;
    }
}

/// @dev TEST ONLY. Takes 1% of every transfer: the order contract must refuse it.
contract MockTaxQuote {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v - v / 100;
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v - v / 100;
        return true;
    }
}

/// @dev TEST ONLY. A constant-product router with Uniswap V2's `getAmountsOut` / `swapExactTokensForTokens` interface and its
/// 0.3% fee, holding its own reserves. Enough to exercise the order client and keeper against the real call shapes.
contract MockSwapRouter {
    mapping(address => mapping(address => uint256)) public reserve;

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TOKEN");
    }

    /// Adds liquidity from the caller: `a` of tokenA and `b` of tokenB.
    function seed(address tokenA, address tokenB, uint256 a, uint256 b) external {
        _call(tokenA, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), a));
        _call(tokenB, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), b));
        reserve[tokenA][tokenB] += a;
        reserve[tokenB][tokenA] += b;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "PATH");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _out(amountIn, reserve[path[0]][path[1]], reserve[path[1]][path[0]]);
    }

    function _out(uint256 amountIn, uint256 rIn, uint256 rOut) private pure returns (uint256) {
        require(rIn > 0 && rOut > 0, "NO_POOL");
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(path.length == 2, "PATH");
        uint256 rIn = reserve[path[0]][path[1]];
        uint256 rOut = reserve[path[1]][path[0]];
        uint256 out = _out(amountIn, rIn, rOut);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        _call(path[0], abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountIn));
        reserve[path[0]][path[1]] = rIn + amountIn;
        reserve[path[1]][path[0]] = rOut - out;
        _call(path[1], abi.encodeWithSelector(0xa9059cbb, to, out));
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}
