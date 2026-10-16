// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Aretia bonding curve for Ethereum-style chains. UNAUDITED. NOT deployed anywhere. Read docs/BONDING_CURVE_EVM.md first.
 *
 * The same curve as the Solana program (program/aretia-curve): a constant-product curve over virtual reserves, one curve per token,
 * the fee taken on every trade, and when the last curve token is sold the raised coin and the tokens set aside for it go into the
 * network's Uniswap V2-style exchange with the liquidity tokens sent to the dead address, so the liquidity is locked for good.
 *
 * Design rules, kept on purpose:
 *  - IMMUTABLE. No owner, no admin function, no setter, no proxy, no upgrade. Everything that varies is fixed in the constructor
 *    (the token factory, the fee recipient, the exchange router). Changing any of it means deploying a new contract.
 *  - ONLY TOKENS FROM ARETIA'S FACTORY. A token is accepted only if its address is the one the factory's CREATE produces for a nonce
 *    the creator names, which proves the factory deployed it, and the factory only ever deploys AretiaToken: a plain ERC-20 with no
 *    hooks, no fee on transfer, no mint, no pause. So no foreign code runs while a trade is half done.
 *  - STATE BEFORE CALLS, and a reentrancy lock on top. Every external call comes after the curve's numbers are written.
 *  - ROUNDING ALWAYS AGAINST THE TRADER. Fee up, coin out down, tokens out down, and k never falls (the same rules as the Rust crate
 *    curve-math, replayed against its test vectors).
 *  - SOLVENCY CHECK. After every trade the contract's balance must cover everything it owes across all curves.
 */

interface IAretiaToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IUniswapV2Router {
    function WETH() external view returns (address);
    function factory() external view returns (address);
    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

contract AretiaCurve {
    // ------------------------------------------------------------ fixed at deployment

    /** The Aretia token factory. A curve token must have been deployed by it. */
    address public immutable factory;
    /** Receives the fee on every trade. */
    address public immutable feeRecipient;
    /** The exchange router used at graduation. */
    IUniswapV2Router public immutable router;
    /** The exchange's wrapped native coin, read from the router once. */
    address public immutable weth;

    // ------------------------------------------------------------ constants

    /** Fee on every trade, in basis points of the coin side: 0.58%. */
    uint256 public constant FEE_BPS = 58;
    uint256 public constant MIN_TARGET = 1e16; // 0.01 of the native coin
    uint256 public constant MAX_TARGET = 1e24;
    uint256 public constant MAX_TOTAL = 1 << 96;
    uint256 public constant ABORT_AFTER = 7 days;
    /** What the exchange may leave unspent at graduation, in basis points of each side. */
    uint256 public constant DUST_BPS = 10;
    /** How far the pool's price may sit from the curve's last price, in basis points. */
    uint256 public constant PRICE_TOLERANCE_BPS = 100;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant BPS = 10_000;

    // ------------------------------------------------------------ state

    enum Status {
        None,
        Trading,
        SoldOut,
        Migrated,
        Aborted
    }

    struct Curve {
        Status status;
        address creator;
        uint64 createdAt;
        uint64 soldOutAt;
        uint256 feeBps;
        uint256 target;
        uint256 vSol0;
        uint256 curveTokens;
        uint256 lpTokens;
        uint256 vSol;
        uint256 vTok;
        /** Coin owed to holders, net of fees. */
        uint256 realSol;
        /** Tokens still for sale. */
        uint256 realTok;
    }

    mapping(address => Curve) public curves;
    /** The sum of `realSol` over every curve: what the contract must always be able to pay. */
    uint256 public totalOwed;
    uint256 private lock = 1;

    event Created(address indexed token, address indexed creator, uint256 curveTokens, uint256 lpTokens, uint256 target, uint256 vSol0, uint256 vTok0);
    event Traded(address indexed token, address indexed trader, bool isBuy, uint256 coin, uint256 fee, uint256 tokens, uint256 vSol, uint256 vTok, uint256 realSol);
    event Migrated(address indexed token, uint256 coin, uint256 tokens, uint256 liquidity);
    event Aborted(address indexed token);

    modifier nonReentrant() {
        require(lock == 1, "reentrant");
        lock = 2;
        _;
        lock = 1;
    }

    constructor(address factory_, address feeRecipient_, address router_) {
        require(factory_ != address(0) && feeRecipient_ != address(0) && router_ != address(0), "zero");
        factory = factory_;
        feeRecipient = feeRecipient_;
        router = IUniswapV2Router(router_);
        weth = IUniswapV2Router(router_).WETH();
    }

    /** The exchange sends back any coin it did not use. Nothing else may send coin here without a trade. */
    receive() external payable {
        require(msg.sender == address(router), "no deposits");
    }

    // ------------------------------------------------------------ create

    /**
     * Opens the curve for `token`. `total` tokens move from the caller (who must have approved this contract for at least that much)
     * into the contract and are split between the curve and the pool. `factoryNonce` is the factory's contract nonce when it made
     * the token (the first token it ever made used 1): it proves the factory deployed it.
     *
     * Any coin sent with this call is the creator's own first buy, made inside the same transaction so nobody can buy before the
     * creator. `minFirstBuyOut` is the least that buy must give; it is ignored when no coin is sent.
     */
    function createCurve(address token, uint256 factoryNonce, uint256 total, uint256 target, uint256 minFirstBuyOut) external payable nonReentrant {
        require(curves[token].status == Status.None, "exists");
        require(token == _createAddress(factory, factoryNonce), "not from the factory");
        require(total > 0 && total <= MAX_TOTAL, "total");
        require(target >= MIN_TARGET && target <= MAX_TARGET, "target");

        uint256 vSol0 = (target * 6) / 17;
        uint256 lp = (total * vSol0) / (2 * vSol0 + target);
        uint256 c = total - lp;
        require(lp > 0 && c > 0, "split");
        uint256 vTok0 = _ceilDiv((vSol0 + target) * c, target);
        require(vTok0 > c, "reserves");

        curves[token] = Curve({
            status: Status.Trading,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            soldOutAt: 0,
            feeBps: FEE_BPS,
            target: target,
            vSol0: vSol0,
            curveTokens: c,
            lpTokens: lp,
            vSol: vSol0,
            vTok: vTok0,
            realSol: 0,
            realTok: c
        });

        uint256 before = IAretiaToken(token).balanceOf(address(this));
        require(IAretiaToken(token).transferFrom(msg.sender, address(this), total), "transfer");
        require(IAretiaToken(token).balanceOf(address(this)) == before + total, "balance");
        emit Created(token, msg.sender, c, lp, target, vSol0, vTok0);
        if (msg.value > 0) _buy(token, minFirstBuyOut, msg.value);
    }

    // ------------------------------------------------------------ buy

    /**
     * Pays `msg.value` for tokens. The fee comes off first. If the payment would buy more than is left, only what is left is bought
     * and the rest is sent straight back. Reverts unless at least `minTokensOut` result.
     */
    function buy(address token, uint256 minTokensOut) external payable nonReentrant {
        _buy(token, minTokensOut, msg.value);
    }

    /** The buy, for `paid` of the coin sent with the call. Any part not needed is sent back to the caller. */
    function _buy(address token, uint256 minTokensOut, uint256 paid) private {
        Curve storage c = curves[token];
        require(c.status == Status.Trading, "not trading");
        (uint256 gross, uint256 fee, uint256 net, uint256 out) = _quoteBuy(c, paid);
        require(out >= minTokensOut, "slippage");

        c.vSol += net;
        c.vTok -= out;
        c.realSol += net;
        c.realTok -= out;
        totalOwed += net;
        if (c.realTok == 0) {
            c.status = Status.SoldOut;
            c.soldOutAt = uint64(block.timestamp);
        }
        _emitTrade(token, true, gross, fee, out);

        require(IAretiaToken(token).transfer(msg.sender, out), "transfer");
        if (fee > 0) _send(feeRecipient, fee);
        uint256 refund = paid - gross;
        if (refund > 0) _send(msg.sender, refund);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    // ------------------------------------------------------------ sell

    /**
     * Sells `tokensIn` back (the caller must have approved this contract). Reverts unless at least `minCoinOut` reaches the caller
     * after the fee. Open while trading, and again if an unfinished graduation was aborted.
     */
    function sell(address token, uint256 tokensIn, uint256 minCoinOut) external nonReentrant {
        Curve storage c = curves[token];
        require(c.status == Status.Trading || c.status == Status.Aborted, "not open");
        (uint256 gross, uint256 fee) = _applySell(c, tokensIn);
        uint256 net = gross - fee;
        require(net >= minCoinOut, "slippage");
        totalOwed -= gross;
        _emitTrade(token, false, gross, fee, tokensIn);

        uint256 before = IAretiaToken(token).balanceOf(address(this));
        require(IAretiaToken(token).transferFrom(msg.sender, address(this), tokensIn), "transfer");
        require(IAretiaToken(token).balanceOf(address(this)) == before + tokensIn, "balance");
        if (net > 0) _send(msg.sender, net);
        if (fee > 0) _send(feeRecipient, fee);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /** The sale's arithmetic and the curve's new numbers, in one place. Reverts for any sale the curve cannot honour. */
    function _applySell(Curve storage c, uint256 tokensIn) private returns (uint256 gross, uint256 fee) {
        require(tokensIn > 0, "amount");
        uint256 newRealTok = c.realTok + tokensIn;
        require(newRealTok <= c.curveTokens, "more than sold");
        uint256 newVTok = c.vTok + tokensIn;
        uint256 newVSol = _ceilDiv(c.vSol * c.vTok, newVTok);
        require(newVSol <= c.vSol, "price");
        gross = c.vSol - newVSol;
        require(gross <= c.realSol, "vault");
        fee = _feeUp(gross, c.feeBps);
        if (fee > gross) fee = gross;
        c.vSol = newVSol;
        c.vTok = newVTok;
        c.realSol -= gross;
        c.realTok = newRealTok;
    }

    function _emitTrade(address token, bool isBuy, uint256 coin, uint256 fee, uint256 tokens) private {
        Curve storage c = curves[token];
        emit Traded(token, msg.sender, isBuy, coin, fee, tokens, c.vSol, c.vTok, c.realSol);
    }

    // ------------------------------------------------------------ graduation

    /**
     * Anyone may call this once the curve has sold out. Puts the coin raised and the pool tokens into the exchange and sends the
     * liquidity tokens to the dead address. Reverts, and changes nothing, unless the exchange took all but 0.1% of both sides AND the
     * pool's price is within 1% of the curve's last price. (If someone made a pool for this token first at another price, this fails
     * for good, and after seven days `abortMigration` lets holders sell back.)
     */
    function graduate(address token) external nonReentrant {
        Curve storage c = curves[token];
        require(c.status == Status.SoldOut && c.realTok == 0, "not sold out");
        uint256 coinIn = c.realSol;
        uint256 tokensIn = c.lpTokens;

        c.status = Status.Migrated;
        c.realSol = 0;
        totalOwed -= coinIn;

        uint256 tokensBefore = IAretiaToken(token).balanceOf(address(this));
        require(IAretiaToken(token).approve(address(router), tokensIn), "approve");
        (uint256 usedTokens, uint256 usedCoin, uint256 liquidity) = router.addLiquidityETH{value: coinIn}(
            token, tokensIn, tokensIn - (tokensIn * DUST_BPS) / BPS, coinIn - (coinIn * DUST_BPS) / BPS, DEAD, block.timestamp
        );
        require(IAretiaToken(token).approve(address(router), 0), "approve");
        require(IAretiaToken(token).balanceOf(address(this)) == tokensBefore - usedTokens, "balance");
        require(usedTokens + (tokensIn * DUST_BPS) / BPS >= tokensIn && usedCoin + (coinIn * DUST_BPS) / BPS >= coinIn, "price");

        _requirePoolPrice(token, coinIn, tokensIn);
        emit Migrated(token, usedCoin, usedTokens, liquidity);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /** After seven days sold out without graduating, anyone may reopen selling (never buying) so holders can leave along the curve. */
    function abortMigration(address token) external {
        Curve storage c = curves[token];
        require(c.status == Status.SoldOut, "not sold out");
        require(block.timestamp >= uint256(c.soldOutAt) + ABORT_AFTER, "too early");
        c.status = Status.Aborted;
        emit Aborted(token);
    }

    // ------------------------------------------------------------ views for pages

    /** What a buy of `coin` would do right now: payment taken, fee, tokens out. Zeros if it could not. */
    function quoteBuy(address token, uint256 coin) external view returns (uint256 gross, uint256 fee, uint256 tokensOut) {
        Curve storage c = curves[token];
        if (c.status != Status.Trading) return (0, 0, 0);
        (gross, fee, , tokensOut) = _quoteBuy(c, coin);
    }

    // ------------------------------------------------------------ internals

    function _quoteBuy(Curve storage c, uint256 offered) private view returns (uint256 gross, uint256 fee, uint256 net, uint256 out) {
        require(offered > 0, "amount");
        fee = _feeUp(offered, c.feeBps);
        if (fee > offered) fee = offered;
        net = offered - fee;
        require(net > 0 && c.realTok > 0, "amount");
        uint256 k = c.vSol * c.vTok;
        uint256 newVTok = _ceilDiv(k, c.vSol + net);
        out = c.vTok - newVTok;
        gross = offered;
        if (out >= c.realTok) {
            // Cut to what is left, priced rounding up.
            uint256 targetVTok = c.vTok - c.realTok;
            require(targetVTok > 0, "reserves");
            net = _ceilDiv(k, targetVTok) - c.vSol;
            gross = _ceilDiv(net * BPS, BPS - c.feeBps);
            fee = gross - net;
            out = c.realTok;
        }
        require(out > 0 && gross <= offered, "amount");
    }

    function _feeUp(uint256 amount, uint256 bps) private pure returns (uint256) {
        return _ceilDiv(amount * bps, BPS);
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send");
    }

    /** The pool's coin per token must sit within the tolerance of the coin raised per pool token. */
    function _requirePoolPrice(address token, uint256 coinIn, uint256 tokensIn) private view {
        address pair = IUniswapV2Factory(router.factory()).getPair(token, weth);
        require(pair != address(0), "no pool");
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        (uint256 rToken, uint256 rCoin) = IUniswapV2Pair(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        require(rToken > 0 && rCoin > 0, "empty pool");
        // rCoin / rToken against coinIn / tokensIn, cross-multiplied.
        uint256 lhs = rCoin * tokensIn;
        uint256 rhs = coinIn * rToken;
        require(lhs * BPS >= rhs * (BPS - PRICE_TOLERANCE_BPS) && lhs * BPS <= rhs * (BPS + PRICE_TOLERANCE_BPS), "pool price");
    }

    /** The address a CREATE from `deployer` at contract nonce `n` makes: keccak256(rlp([deployer, n])), last 20 bytes. */
    function _createAddress(address deployer, uint256 n) private pure returns (address) {
        bytes memory data;
        if (n == 0) data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        else if (n <= 0x7f) data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(n));
        else if (n <= 0xff) data = abi.encodePacked(bytes1(0xd7), bytes1(0x94), deployer, bytes1(0x81), uint8(n));
        else if (n <= 0xffff) data = abi.encodePacked(bytes1(0xd8), bytes1(0x94), deployer, bytes1(0x82), uint16(n));
        else if (n <= 0xffffff) data = abi.encodePacked(bytes1(0xd9), bytes1(0x94), deployer, bytes1(0x83), uint24(n));
        else if (n <= 0xffffffff) data = abi.encodePacked(bytes1(0xda), bytes1(0x94), deployer, bytes1(0x84), uint32(n));
        else revert("nonce");
        return address(uint160(uint256(keccak256(data))));
    }
}
