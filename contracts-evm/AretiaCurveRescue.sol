// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Rescue-graduate helper for the DEPLOYED, immutable AretiaCurve (contracts-evm/AretiaCurve.sol). Read docs/BONDING_CURVE_EVM.md,
 * section "Graduation blocked by a pre-made pair (M-4) and the rescue helper", first.
 *
 * Why it exists. `AretiaCurve.graduate` deposits through the exchange router's `addLiquidityETH` with minimums of 99.9% of each side,
 * then requires the pair's price to sit within 1% of the curve's. Anyone can create the token/WETH pair before graduation, send it 1 wei of
 * WETH and call `sync()`: the reserves are then (0, 1), the router's `quote` reverts with INSUFFICIENT_LIQUIDITY, and the curve can never
 * graduate (after 7 days it can only be unwound). The deployed curve cannot be changed.
 *
 * What it does, in ONE transaction (so nobody can re-poison the pair in between):
 *   1. reads the curve: it must be SoldOut with nothing left for sale; the deposit ratio is realSol : lpTokens;
 *   2. finds the token/WETH pair through the curve's own router's factory;
 *   3. `skim`s any unsynced excess on the pair to the caller (an unsynced donation would otherwise be swept into the graduation deposit and
 *      move the pool price);
 *   4. moves the pair's reserves to the curve's ratio, choosing the cheapest of
 *        - a donation of the missing side(s), then `sync()`, or
 *        - a swap against the pair, when the pair holds real value on the side that is too heavy: the caller pays the light side in and
 *          takes the excess of the heavy side out, at the pair's own constant-product price (with the exchange fee). The attacker who
 *          skewed the pair pays for it; the caller is paid for repairing it;
 *   5. calls `curve.graduate(token)`; the curve applies its own checks unchanged (99.9% of each side used, pool price within 1%);
 *   6. sends the caller everything left: unused coin (`msg.value` not needed, plus any coin taken out in step 4) and any tokens.
 *
 * The caller pays the coin side with `msg.value` and the token side from their own wallet (an approval to this contract for at most
 * `maxTokens`). `quote(token)` says in advance what is needed. When the token side is needed:
 *   - whenever the pair's price is ABOVE the curve's (too much coin for its tokens: the "1 wei of WETH" and "1 wei of each side" cases,
 *     or 1 ETH against 1 token-wei). Only tokens can lower the price, and nothing but tokens can be put in; the curve's own tokens cannot be
 *     touched. The amount is tiny for dust (about rC * lpTokens / realSol token units, e.g. 4e7 base units of an 18-decimal token for 1 wei
 *     of WETH at a 5 ETH raise) and, for real value, it is swapped, not donated, so the caller gets the excess coin back;
 *   - when the pair's token reserve is too small to express the ratio to 1 part in 10,000 (MIN_DERIVED below).
 *   Any holder of the token can supply it: the curve sold out, so the tokens are in buyers' hands.
 *
 * Properties, kept on purpose:
 *  - PERMISSIONLESS, NO OWNER, NO STATE. Nothing to configure after deployment. It holds no coin or tokens between calls: every call ends
 *    by sending its whole balance (coin, WETH unwrapped, tokens) to the caller.
 *  - IT CANNOT MOVE ANYONE ELSE'S TOKENS. The only `transferFrom` is from `msg.sender`, for at most the planned amount, which is at most
 *    `maxTokens`. Coin comes only from `msg.value`.
 *  - IT CANNOT GRADUATE AT A PRICE THE CURVE WOULD REFUSE. It does not touch the curve's state; it only changes the pair, and then the
 *    curve's own `graduate` runs its own checks. If the result is not a graduation, the whole transaction reverts.
 *  - IT CHECKS ITS OWN WORK. After the repair the pair's reserves must equal the planned ones exactly.
 *
 * The swap arithmetic assumes the Uniswap V2 fee of 0.3% (the most conservative of Uniswap V2, QuickSwap and PancakeSwap V2's 0.25%). On a
 * pair with a higher fee the swap reverts (K) and nothing happens.
 */

interface IRescueCurve {
    // `curves(address)` returns 13 words (status, creator, createdAt, soldOutAt, feeBps, target, vSol0, curveTokens, lpTokens, vSol, vTok,
    // realSol, realTok). It is read with a raw static call and decoded as uint256[13] (see `_curve`) to keep the stack small.
    function graduate(address token) external;
    function router() external view returns (address);
    function weth() external view returns (address);
}

interface IRescueRouter {
    function factory() external view returns (address);
}

interface IRescueFactory {
    function getPair(address, address) external view returns (address);
}

interface IRescuePair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function skim(address to) external;
    function sync() external;
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IRescueWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IRescueToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract AretiaCurveRescue {
    /** The deployed AretiaCurve this helper graduates for. */
    IRescueCurve public immutable curve;
    /** The curve's wrapped coin (read from the curve). */
    address public immutable weth;
    /** The factory of the curve's router: where the pair is looked up. */
    address public immutable pairFactory;

    /** The side of the final reserves derived from the other must be at least this, so the ratio is exact to 1 part in 10,000. */
    uint256 public constant MIN_DERIVED = 1e4;
    uint256 private constant SOLD_OUT = 2;
    uint256 private constant MIGRATED = 3;
    uint256 private constant MAX_RESERVE = type(uint112).max;

    uint256 private guard = 1;

    /** What a rescue does to the pair. At most one of tokensOut / coinOut is non-zero, and only when the other side is paid in. */
    struct Plan {
        address pair;
        uint256 reserveToken;
        uint256 reserveCoin;
        uint256 finalToken;
        uint256 finalCoin;
        uint256 tokensIn;
        uint256 coinIn;
        uint256 tokensOut;
        uint256 coinOut;
        /**
         * A pair cannot swap while either reserve is zero (its `amountOut < reserve` check fails for the empty side too), so when one side is
         * empty and the other holds value, 1 base unit of the empty side is donated and synced first. Included in tokensIn / coinIn.
         */
        uint256 preToken;
        uint256 preCoin;
    }

    event Rescued(address indexed token, address indexed caller, address pair, uint256 tokensIn, uint256 coinIn, uint256 tokensOut, uint256 coinOut);

    modifier nonReentrant() {
        require(guard == 1, "reentrant");
        guard = 2;
        _;
        guard = 1;
    }

    constructor(address curve_) {
        require(curve_ != address(0), "zero");
        curve = IRescueCurve(curve_);
        address w = IRescueCurve(curve_).weth();
        address f = IRescueRouter(IRescueCurve(curve_).router()).factory();
        require(w != address(0) && f != address(0), "zero");
        weth = w;
        pairFactory = f;
    }

    /** Only WETH sends coin here (when unwrapping). */
    receive() external payable {
        require(msg.sender == weth, "no deposits");
    }

    // ------------------------------------------------------------ views

    /**
     * What `rescue(token, ·)` would need and give right now: `tokensIn` (approve at least this, pass it as `maxTokens`), `coinIn` (send at
     * least this as value), and what the caller would receive from the repair (`tokensOut`, `coinOut`) on top of the unused value. All zero
     * apart from `pair` when no repair is needed. Reverts unless the curve is sold out.
     */
    function quote(address token) external view returns (Plan memory p) {
        (uint256 lp, uint256 coin) = _soldOut(token);
        p.pair = IRescueFactory(pairFactory).getPair(token, weth);
        if (p.pair != address(0)) _plan(p, token, lp, coin);
    }

    // ------------------------------------------------------------ the rescue

    /**
     * Repairs the pair (if there is one) to the curve's ratio and graduates the curve, in one transaction. `maxTokens` caps what is taken from
     * the caller's wallet (approval to this contract first); `msg.value` caps the coin. Everything unused, and anything the repair pays out,
     * goes back to the caller. Reverts, changing nothing, if more is needed or the curve refuses to graduate.
     */
    function rescue(address token, uint256 maxTokens) external payable nonReentrant {
        (uint256 lp, uint256 coin) = _soldOut(token);
        address pair = IRescueFactory(pairFactory).getPair(token, weth);
        Plan memory p;
        if (pair != address(0)) {
            // Unsynced excess would be swept into the graduation deposit: hand it to the caller first.
            IRescuePair(pair).skim(msg.sender);
            p.pair = pair;
            _plan(p, token, lp, coin);
            require(p.tokensIn <= maxTokens, "tokens");
            require(p.coinIn <= msg.value, "coin");
            if (p.coinIn > 0) IRescueWETH(weth).deposit{value: p.coinIn}();
            if (p.preToken > 0 || p.preCoin > 0) {
                _payIn(token, pair, p.preToken, p.preCoin);
                IRescuePair(pair).sync();
            }
            _payIn(token, pair, p.tokensIn - p.preToken, p.coinIn - p.preCoin);
            if (p.tokensOut > 0 || p.coinOut > 0) {
                bool tokenIsZero = IRescuePair(pair).token0() == token;
                (uint256 a0, uint256 a1) = tokenIsZero ? (p.tokensOut, p.coinOut) : (p.coinOut, p.tokensOut);
                IRescuePair(pair).swap(a0, a1, p.coinOut > 0 ? address(this) : msg.sender, "");
            } else if (p.tokensIn > p.preToken || p.coinIn > p.preCoin) {
                IRescuePair(pair).sync();
            }
            (uint256 rT, uint256 rC) = _reserves(pair, token);
            if (p.finalToken != 0 || p.finalCoin != 0) require(rT == p.finalToken && rC == p.finalCoin, "repair");
        }

        curve.graduate(token);
        require(_curve(token)[0] == MIGRATED, "not graduated");
        emit Rescued(token, msg.sender, pair, p.tokensIn, p.coinIn, p.tokensOut, p.coinOut);

        // Hold nothing: everything left goes to the caller.
        uint256 w = IRescueWETH(weth).balanceOf(address(this));
        if (w > 0) IRescueWETH(weth).withdraw(w);
        uint256 t = IRescueToken(token).balanceOf(address(this));
        if (t > 0) require(IRescueToken(token).transfer(msg.sender, t), "transfer");
        uint256 b = address(this).balance;
        if (b > 0) {
            (bool ok, ) = msg.sender.call{value: b}("");
            require(ok, "refund");
        }
    }

    // ------------------------------------------------------------ internals

    function _soldOut(address token) private view returns (uint256 lp, uint256 coin) {
        uint256[13] memory c = _curve(token);
        require(c[0] == SOLD_OUT && c[12] == 0, "not sold out");
        require(c[8] > 0 && c[11] > 0, "empty");
        return (c[8], c[11]);
    }

    /** The curve's stored numbers for `token`: the 13 words of `curves(address)`. */
    function _curve(address token) private view returns (uint256[13] memory c) {
        (bool ok, bytes memory ret) = address(curve).staticcall(abi.encodeWithSignature("curves(address)", token));
        require(ok && ret.length == 13 * 32, "curve");
        c = abi.decode(ret, (uint256[13]));
    }

    function _reserves(address pair, address token) private view returns (uint256 rT, uint256 rC) {
        (uint112 r0, uint112 r1, ) = IRescuePair(pair).getReserves();
        (rT, rC) = IRescuePair(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /**
     * Fills `p` from the pair's reserves. The final reserves (X tokens, Y coin) satisfy Y / X = coin / lp with the larger-magnitude side
     * derived from the other by rounding up, so the router's 0.1% minimums and the curve's 1% price check pass. Among such (X, Y) it picks
     * the smallest that the pair can reach from its reserves: by donation (X >= rT and Y >= rC) or by a swap that passes the pair's
     * constant-product check with the 0.3% fee. Smaller means the least paid in and the most taken out.
     */
    function _plan(Plan memory p, address token, uint256 lp, uint256 coin) private view {
        (uint256 rT, uint256 rC) = _reserves(p.pair, token);
        p.reserveToken = rT;
        p.reserveCoin = rC;
        if (rT == 0 && rC == 0) return; // An empty pair: the router deposits at the curve's own amounts.
        if (rT == 0) p.preToken = 1;
        if (rC == 0) p.preCoin = 1;
        rT += p.preToken;
        rC += p.preCoin;
        (uint256 x, uint256 y) = _target(rT, rC, lp, coin);
        p.finalToken = x;
        p.finalCoin = y;
        if (x >= rT) p.tokensIn = p.preToken + x - rT;
        else (p.tokensIn, p.tokensOut) = (p.preToken, rT - x);
        if (y >= rC) p.coinIn = p.preCoin + y - rC;
        else (p.coinIn, p.coinOut) = (p.preCoin, rC - y);
    }

    /** Moves `tokens` from the caller and `coin` of this contract's (already wrapped) WETH to the pair. */
    function _payIn(address token, address pair, uint256 tokens, uint256 coin) private {
        if (tokens > 0) require(IRescueToken(token).transferFrom(msg.sender, pair, tokens), "transfer");
        if (coin > 0) require(IRescueWETH(weth).transfer(pair, coin), "transfer");
    }

    /** The search's fixed inputs: the reserves now and the ratio, as base side and derived side = ceil(base * num / den), num >= den. */
    struct Search {
        bool baseIsToken;
        uint256 num;
        uint256 den;
        uint256 rT;
        uint256 rC;
    }

    /** The smallest reachable final reserves (x tokens, y coin) at the ratio coin : lp. See `_plan`. */
    function _target(uint256 rT, uint256 rC, uint256 lp, uint256 coin) private pure returns (uint256 x, uint256 y) {
        Search memory s = Search({baseIsToken: coin >= lp, num: 0, den: 0, rT: rT, rC: rC});
        (s.num, s.den) = s.baseIsToken ? (coin, lp) : (lp, coin);
        uint256 lo = _ceilDiv(MIN_DERIVED * s.den, s.num);
        if (lo == 0) lo = 1;
        uint256 hi = s.baseIsToken ? _max(rT, _ceilDiv(rC * s.den, s.num)) : _max(rC, _ceilDiv(rT * s.den, s.num));
        hi = _max(lo, hi);
        require(_ceilDiv(hi * s.num, s.den) <= MAX_RESERVE, "pair too skewed");
        if (!_feasible(lo, s)) {
            // feasible(lo) is false, feasible(hi) is true (a pure donation), and feasibility only grows with the base.
            while (hi - lo > 1) {
                uint256 mid = (lo + hi) / 2;
                if (_feasible(mid, s)) hi = mid;
                else lo = mid;
            }
            lo = hi;
        }
        return _pointAt(lo, s);
    }

    function _pointAt(uint256 b, Search memory s) private pure returns (uint256 x, uint256 y) {
        uint256 d = _ceilDiv(b * s.num, s.den);
        (x, y) = s.baseIsToken ? (b, d) : (d, b);
    }

    /** Whether the final reserves for base `b` are reachable from (rT, rC): by donation, or by a one-sided swap the pair accepts. */
    function _feasible(uint256 b, Search memory s) private pure returns (bool) {
        (uint256 x, uint256 y) = _pointAt(b, s);
        if (x >= s.rT && y >= s.rC) return true;
        uint256 k = s.rT * s.rC * 1_000_000;
        // Tokens in, coin out. The pair's check: (x*1000 - 3*amountIn) * (y*1000) >= rT*rC*1000^2.
        if (x >= s.rT) return (x * 1000 - 3 * (x - s.rT)) * (y * 1000) >= k;
        // Coin in, tokens out.
        if (y >= s.rC) return (y * 1000 - 3 * (y - s.rC)) * (x * 1000) >= k;
        return false;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}
