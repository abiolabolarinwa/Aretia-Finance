// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Aretia Pool for Ethereum-style chains. UNAUDITED. NOT deployed on any mainnet. Read docs/ARETIA_POOL_EVM.md first.
 * This is the build after the October 2026 review (M-2, M-9, L-19, L-20, I-3, I-5, I-7); the earlier Sepolia deployment is the OLD build.
 *
 * Aretia's own constant-product swap pool, the same product rules as the Solana program (program/aretia-pool, docs/ARETIA_POOL.md):
 * one pool per token, always against the chain's NATIVE coin (held by this contract directly, never wrapped), single-sided creation
 * at a starting price (the creator deposits only tokens; a virtual coin reserve `l` sets the price), a creator-chosen trading fee of
 * 0.25% or 1%, 20% of every fee owed to Aretia's fee address (accrued in `protocolOwed` and paid by `withdrawProtocolFees`, which
 * anyone may call: a trade never sends coin to the fee address, so that address can never freeze trading, review finding M-2), the
 * other 80% accruing to liquidity positions and CLAIMABLE EVEN WHILE THE LIQUIDITY IS LOCKED FOR GOOD. The creator's initial liquidity
 * is always locked for good, and every pool tracks how much of its liquidity is locked (`pools(token).locked`, finding M-9).
 *
 * Design rules, kept on purpose:
 *  - IMMUTABLE. No owner, no admin function, no setter, no proxy, no pause. The token factory, the fee recipient and the creation fee
 *    are fixed in the constructor. The protocol share, the two fee tiers and every bound are constants. Changing any of it means
 *    deploying a new contract.
 *  - ONLY TOKENS FROM ARETIA'S FACTORY. A token is accepted only if its address is the one the factory's CREATE produces for a nonce
 *    the creator names, which proves the factory deployed it, and the factory only ever deploys AretiaToken: a plain fixed-supply
 *    ERC-20 with no owner, mint, pause, blacklist, hook or fee on transfer. (On the EVM a contract cannot inspect another contract's
 *    behaviour, so unlike Solana's mint-byte check this is provenance, not inspection.) As defence in depth every token movement is
 *    compared with the balance change it should cause, so a token that moved a different amount reverts the trade.
 *  - STATE BEFORE CALLS, and a reentrancy lock on top. Every external call comes after the pool's numbers are written.
 *  - ROUNDING NEVER FAVOURS THE SWAPPER OR THE DEPOSITOR. Fee up, tokens out down, coin out down, new reserve up, deposits up,
 *    withdrawals down, fee credits down. k = X*Y never falls through a swap.
 *  - SOLVENCY CHECK. After every call that moves coin the contract's balance must cover everything it owes across all pools.
 */

interface IPoolToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract AretiaPool {
    // ------------------------------------------------------------ fixed at deployment

    /** The Aretia token factory. A pool token must have been deployed by it. */
    address public immutable factory;
    /** Is owed the creation fee and 20% of every trading fee, paid out by `withdrawProtocolFees`. */
    address public immutable feeRecipient;
    /** Flat fee in the chain's coin, paid inside createPool (owed to the fee address). Equal to the token-creation fee on that chain. */
    uint256 public immutable creationFee;

    // ------------------------------------------------------------ constants

    /** Aretia's share of every trading fee, in basis points of the fee. */
    uint256 public constant PROTOCOL_SHARE_BPS = 2000;
    uint256 public constant FEE_LOW_BPS = 25;
    uint256 public constant FEE_HIGH_BPS = 100;
    uint256 public constant MIN_X = 1000;
    uint256 public constant MIN_L = 1e12;
    uint256 public constant MIN_DL = 1000;
    /** Every reserve stays below 2^112, so every product below fits in 2^224 and no mathematics here can overflow. */
    uint256 public constant MAX = 1 << 112;
    uint256 private constant BPS = 10_000;
    uint256 private constant SCALE_BITS = 64;

    // ------------------------------------------------------------ state

    struct Pool {
        /** Zero means no pool. Otherwise 25 or 100, fixed for good. */
        uint256 feeBps;
        address creator;
        uint64 createdAt;
        /** Real token reserve. */
        uint256 x;
        /** Real coin reserve. */
        uint256 y;
        /** Total liquidity = virtual coin reserve = total shares. */
        uint256 l;
        /** Fee per share, cumulative, scaled by 2^64. Never wraps: total fees are bounded by the coin supply. */
        uint256 acc;
        /** Liquidity-provider fees accrued and not yet claimed, held outside `y`. */
        uint256 feeReserve;
        /** Liquidity locked for good across all positions. Never falls. At least the creator's l0. */
        uint256 locked;
        /** The part of LP fees (scaled by 2^64) not yet spread into `acc` because it is below one unit per share. Carried to the next fee. */
        uint256 accRemainder;
    }

    struct Position {
        bool open;
        uint256 shares;
        uint256 locked;
        uint256 checkpoint;
        uint256 pending;
        /** Where claimFees pays. Zero means the owner. */
        address recipient;
    }

    struct CreateParams {
        address token;
        uint256 factoryNonce;
        uint256 x0;
        uint256 l0;
        uint256 y0;
        uint256 feeBps;
        bool lock;
        address owner;
        uint256 firstBuyWei;
        uint256 minFirstBuyOut;
        /** Unix seconds after which the call reverts. */
        uint256 deadline;
    }

    mapping(address => Pool) public pools;
    mapping(address => mapping(address => Position)) public positions;
    /** The sum over every pool of `y + feeReserve`, plus `protocolOwed`: what the contract must always be able to pay. */
    uint256 public totalOwed;
    /** Creation fees and the protocol's share of trading fees, owed to `feeRecipient` and not yet withdrawn. */
    uint256 public protocolOwed;
    uint256 private guard = 1;

    event Created(address indexed token, address indexed creator, address indexed owner, uint256 x0, uint256 y0, uint256 l0, uint256 feeBps, bool locked);
    /**
     * One trade. A buy: `coinIn` paid (fee included), `tokensOut` received, `coinOut` and `tokensIn` zero. A sell: `tokensIn` handed in,
     * `coinOut` received after the fee, `coinIn` and `tokensOut` zero. `fee` is the whole fee, `protocol` Aretia's part of it; `x`, `y`
     * are the reserves after the trade.
     */
    event Swapped(address indexed token, address indexed trader, bool isBuy, uint256 coinIn, uint256 coinOut, uint256 tokensIn, uint256 tokensOut, uint256 fee, uint256 protocol, uint256 x, uint256 y);
    event LiquidityChanged(address indexed token, address indexed owner, bool added, uint256 dl, uint256 tokens, uint256 coin);
    event Claimed(address indexed token, address indexed owner, address recipient, uint256 amount);
    event Locked(address indexed token, address indexed owner, uint256 amount);
    event PositionTransferred(address indexed token, address indexed from, address indexed to);
    /** `recipient` is the value stored: zero means the owner. */
    event RecipientSet(address indexed token, address indexed owner, address recipient);
    event PositionClosed(address indexed token, address indexed owner);
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);

    modifier beforeDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, "expired");
        _;
    }

    modifier nonReentrant() {
        require(guard == 1, "reentrant");
        guard = 2;
        _;
        guard = 1;
    }

    constructor(address factory_, address feeRecipient_, uint256 creationFee_) {
        require(factory_ != address(0) && feeRecipient_ != address(0), "zero");
        factory = factory_;
        feeRecipient = feeRecipient_;
        creationFee = creationFee_;
    }

    /** Coin comes in only through the functions below. */
    receive() external payable {
        revert("no deposits");
    }

    // ------------------------------------------------------------ create

    /**
     * Opens the pool for `p.token`. `x0` tokens move from the caller (who must have approved this contract) into the pool; `y0` coin
     * (usually zero) goes in beside them; `l0` is the virtual coin reserve that sets the starting price, (y0 + l0) / x0. The position
     * is opened for `p.owner` and its liquidity is LOCKED FOR GOOD: `p.lock` must be true (an unlocked creator position could withdraw
     * buyers' coin, review finding M-9). Send exactly `creationFee + y0 + firstBuyWei`: the fee is owed to Aretia (see
     * `withdrawProtocolFees`), and `firstBuyWei` is the creator's own first buy, made inside the same transaction so nobody can buy before
     * the creator. Reverts after `p.deadline`.
     */
    function createPool(CreateParams calldata p) external payable nonReentrant beforeDeadline(p.deadline) {
        Pool storage pool = pools[p.token];
        require(pool.feeBps == 0, "exists");
        require(p.token == _createAddress(factory, p.factoryNonce), "not from the factory");
        require(p.feeBps == FEE_LOW_BPS || p.feeBps == FEE_HIGH_BPS, "fee tier");
        require(p.x0 >= MIN_X && p.x0 < MAX, "x0");
        require(p.l0 >= MIN_L && p.l0 < MAX, "l0");
        require(p.y0 < MAX && p.y0 + p.l0 < MAX, "y0");
        require(p.owner != address(0), "owner");
        require(p.lock, "must lock");
        require(msg.value == creationFee + p.y0 + p.firstBuyWei, "value");

        pool.feeBps = p.feeBps;
        pool.creator = msg.sender;
        pool.createdAt = uint64(block.timestamp);
        pool.x = p.x0;
        pool.y = p.y0;
        pool.l = p.l0;
        pool.locked = p.l0;
        protocolOwed += creationFee;
        totalOwed += p.y0 + creationFee;
        positions[p.token][p.owner] = Position({open: true, shares: p.l0, locked: p.l0, checkpoint: 0, pending: 0, recipient: address(0)});
        emit Created(p.token, msg.sender, p.owner, p.x0, p.y0, p.l0, p.feeBps, true);
        emit Locked(p.token, p.owner, p.l0);

        _pull(p.token, msg.sender, p.x0);
        if (p.firstBuyWei > 0) _buy(p.token, msg.sender, p.firstBuyWei, p.minFirstBuyOut);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    // ------------------------------------------------------------ swap

    /** Pays `msg.value` for tokens. Reverts unless at least `minTokensOut` result, or after `deadline`. All of the payment is used. */
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable nonReentrant beforeDeadline(deadline) {
        _buy(token, msg.sender, msg.value, minTokensOut);
    }

    function _buy(address token, address buyer, uint256 gross, uint256 minOut) private {
        Pool storage p = pools[token];
        require(p.feeBps != 0, "no pool");
        (uint256 fee, uint256 net, uint256 out) = _quoteBuy(p, gross);
        require(out >= minOut, "slippage");
        uint256 protocol = (fee * PROTOCOL_SHARE_BPS) / BPS;
        uint256 lp = fee - protocol;

        p.x -= out;
        p.y += net;
        require(p.y + p.l < MAX, "size");
        _creditFees(p, lp, protocol);
        totalOwed += net + lp + protocol;
        _emitSwap(token, buyer, true, gross, out, fee, protocol);

        _push(token, buyer, out);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /** Sells `tokensIn` back (the caller must have approved this contract). Reverts unless at least `minCoinOut` reaches the caller, or after `deadline`. */
    function sell(address token, uint256 tokensIn, uint256 minCoinOut, uint256 deadline) external nonReentrant beforeDeadline(deadline) {
        Pool storage p = pools[token];
        require(p.feeBps != 0, "no pool");
        (uint256 gross, uint256 fee) = _quoteSell(p, tokensIn);
        uint256 net = gross - fee;
        require(net >= minCoinOut, "slippage");
        uint256 protocol = (fee * PROTOCOL_SHARE_BPS) / BPS;
        uint256 lp = fee - protocol;

        p.x += tokensIn;
        p.y -= gross;
        _creditFees(p, lp, protocol);
        totalOwed = totalOwed - gross + lp + protocol;
        _emitSwap(token, msg.sender, false, net, tokensIn, fee, protocol);

        _pull(token, msg.sender, tokensIn);
        if (net > 0) _send(msg.sender, net);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    // ------------------------------------------------------------ liquidity

    /**
     * Adds `dl` of liquidity at the pool's current price. The caller pays tokens `ceil(x*dl/l)` (must have approved them) and coin
     * `ceil(y*dl/l)` out of `msg.value`; anything extra is sent back. Reverts if the tokens exceed `maxTokens`. Opens the caller's
     * position if it has none. Settles pending fees first. Reverts after `deadline`.
     */
    function addLiquidity(address token, uint256 dl, uint256 maxTokens, uint256 deadline) external payable nonReentrant beforeDeadline(deadline) {
        Pool storage p = pools[token];
        require(p.feeBps != 0, "no pool");
        require(dl >= MIN_DL, "dl");
        uint256 tokens = _ceilDiv(p.x * dl, p.l);
        uint256 coin = _ceilDiv(p.y * dl, p.l);
        require(tokens <= maxTokens, "slippage");
        require(msg.value >= coin, "coin");

        Position storage pos = positions[token][msg.sender];
        if (pos.open) _settle(p, pos);
        else {
            pos.open = true;
            pos.checkpoint = p.acc;
        }
        pos.shares += dl;
        p.x += tokens;
        p.y += coin;
        p.l += dl;
        require(p.x < MAX && p.y + p.l < MAX, "size");
        totalOwed += coin;
        emit LiquidityChanged(token, msg.sender, true, dl, tokens, coin);

        if (tokens > 0) _pull(token, msg.sender, tokens);
        uint256 refund = msg.value - coin;
        if (refund > 0) _send(msg.sender, refund);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /**
     * Removes `dl` of the caller's UNLOCKED liquidity and pays out `floor(x*dl/l)` tokens and `floor(y*dl/l)` coin. Reverts below
     * the minimums or after `deadline`. The pool can never be emptied: at least MIN_L of liquidity always stays. A position left with no
     * shares and no pending fees is closed (deleted).
     */
    function removeLiquidity(address token, uint256 dl, uint256 minTokens, uint256 minCoin, uint256 deadline) external nonReentrant beforeDeadline(deadline) {
        Pool storage p = pools[token];
        Position storage pos = positions[token][msg.sender];
        require(pos.open, "no position");
        require(dl > 0 && dl <= pos.shares - pos.locked, "unlocked shares");
        require(p.l - dl >= MIN_L, "last liquidity");
        _settle(p, pos);
        uint256 tokens = (p.x * dl) / p.l;
        uint256 coin = (p.y * dl) / p.l;
        require(tokens >= minTokens && coin >= minCoin, "slippage");

        pos.shares -= dl;
        p.x -= tokens;
        p.y -= coin;
        p.l -= dl;
        totalOwed -= coin;
        emit LiquidityChanged(token, msg.sender, false, dl, tokens, coin);
        _closeIfEmpty(token, msg.sender, pos);

        if (tokens > 0) _push(token, msg.sender, tokens);
        if (coin > 0) _send(msg.sender, coin);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /** Pays the caller's position its settled fees, to its recipient. Works on locked liquidity. Closes a position left with nothing. */
    function claimFees(address token) external nonReentrant {
        Pool storage p = pools[token];
        Position storage pos = positions[token][msg.sender];
        require(pos.open, "no position");
        _settle(p, pos);
        uint256 amount = pos.pending;
        require(amount > 0, "nothing");
        pos.pending = 0;
        p.feeReserve -= amount;
        totalOwed -= amount;
        address to = pos.recipient == address(0) ? msg.sender : pos.recipient;
        emit Claimed(token, msg.sender, to, amount);
        _closeIfEmpty(token, msg.sender, pos);
        _send(to, amount);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    /** Adds `amount` of the caller's unlocked shares to the permanent lock. Irreversible: nothing lowers `locked`. */
    function lockLiquidity(address token, uint256 amount) external nonReentrant {
        Position storage pos = positions[token][msg.sender];
        require(pos.open, "no position");
        require(amount > 0 && amount <= pos.shares - pos.locked, "unlocked shares");
        pos.locked += amount;
        pools[token].locked += amount;
        emit Locked(token, msg.sender, amount);
    }

    /**
     * Hands the whole position (locked liquidity, settled fees and all) to `to`. If `to` already has a position in this pool the two are
     * MERGED into it (shares, locked shares and pending fees add up; `to` keeps its own fee recipient), so nobody can block transfers to
     * an address by giving it a dust position first (review finding L-19). A new position's fee payee is `to` itself.
     */
    function transferPosition(address token, address to) external nonReentrant {
        Pool storage p = pools[token];
        Position storage pos = positions[token][msg.sender];
        require(pos.open, "no position");
        require(to != address(0) && to != msg.sender, "to");
        _settle(p, pos);
        Position storage dst = positions[token][to];
        if (dst.open) {
            _settle(p, dst);
            dst.shares += pos.shares;
            dst.locked += pos.locked;
            dst.pending += pos.pending;
        } else {
            positions[token][to] = Position({open: true, shares: pos.shares, locked: pos.locked, checkpoint: pos.checkpoint, pending: pos.pending, recipient: address(0)});
        }
        delete positions[token][msg.sender];
        emit PositionTransferred(token, msg.sender, to);
    }

    /** Names where the caller's fees are paid (zero means the caller). Allowed on locked liquidity: the lock covers the liquidity, not the fees. */
    function setRecipient(address token, address recipient) external {
        Position storage pos = positions[token][msg.sender];
        require(pos.open, "no position");
        pos.recipient = recipient == msg.sender ? address(0) : recipient;
        emit RecipientSet(token, msg.sender, pos.recipient);
    }

    /**
     * Pays everything owed to the fee address (creation fees and the protocol share of trading fees) to `feeRecipient`. Anyone may call it;
     * the coin can only go to `feeRecipient`. If that address refuses coin, only this call fails: trading is unaffected.
     */
    function withdrawProtocolFees() external nonReentrant {
        uint256 amount = protocolOwed;
        require(amount > 0, "nothing");
        protocolOwed = 0;
        totalOwed -= amount;
        emit ProtocolFeesWithdrawn(feeRecipient, amount);
        _send(feeRecipient, amount);
        require(address(this).balance >= totalOwed, "insolvent");
    }

    // ------------------------------------------------------------ views for pages

    /** What a buy of `coin` would do right now: fee, tokens out. Zeros if it could not (including when `buy` would revert on the size limit). */
    function quoteBuy(address token, uint256 coin) external view returns (uint256 fee, uint256 tokensOut) {
        Pool storage p = pools[token];
        if (p.feeBps == 0 || coin == 0 || coin >= MAX) return (0, 0);
        uint256 net;
        (fee, net, tokensOut) = _quoteBuyView(p, coin);
        if (tokensOut == 0 || p.y + net + p.l >= MAX) return (0, 0);
    }

    /** What selling `tokens` would do right now: gross coin, fee. Zeros if it could not. */
    function quoteSell(address token, uint256 tokens) external view returns (uint256 gross, uint256 fee) {
        Pool storage p = pools[token];
        if (p.feeBps == 0 || tokens == 0 || p.x + tokens >= MAX) return (0, 0);
        (bool ok, uint256 g, uint256 f) = _sellMath(p, tokens);
        return ok ? (g, f) : (0, 0);
    }

    /** Fees a position could claim right now. */
    function pendingFees(address token, address owner) external view returns (uint256) {
        Pool storage p = pools[token];
        Position storage pos = positions[token][owner];
        if (!pos.open) return 0;
        return pos.pending + ((pos.shares * (p.acc - pos.checkpoint)) >> SCALE_BITS);
    }

    // ------------------------------------------------------------ internals

    function _quoteBuyView(Pool storage p, uint256 offered) private view returns (uint256 fee, uint256 net, uint256 out) {
        fee = _ceilDiv(offered * p.feeBps, BPS);
        net = offered - fee;
        if (net == 0) return (0, 0, 0);
        uint256 yy = p.y + p.l;
        uint256 newX = _ceilDiv(p.x * yy, yy + net);
        out = p.x - newX;
    }

    function _quoteBuy(Pool storage p, uint256 offered) private view returns (uint256 fee, uint256 net, uint256 out) {
        require(offered > 0 && offered < MAX, "amount");
        (fee, net, out) = _quoteBuyView(p, offered);
        require(out > 0, "amount");
    }

    function _sellMath(Pool storage p, uint256 tokensIn) private view returns (bool ok, uint256 gross, uint256 fee) {
        uint256 yy = p.y + p.l;
        uint256 newY = _ceilDiv(p.x * yy, p.x + tokensIn);
        gross = yy - newY;
        if (gross == 0 || gross > p.y) return (false, 0, 0);
        fee = _ceilDiv(gross * p.feeBps, BPS);
        ok = true;
    }

    function _quoteSell(Pool storage p, uint256 tokensIn) private view returns (uint256 gross, uint256 fee) {
        require(tokensIn > 0 && p.x + tokensIn < MAX, "amount");
        bool ok;
        (ok, gross, fee) = _sellMath(p, tokensIn);
        require(ok, "amount");
    }

    /**
     * Credits a trade's fees: `protocol` to Aretia, `lp` to liquidity positions through `acc`. The part of `lp << 64` that does not divide
     * evenly by `l` is carried in `accRemainder` to the next fee instead of being lost (review finding I-5).
     */
    function _creditFees(Pool storage p, uint256 lp, uint256 protocol) private {
        protocolOwed += protocol;
        p.feeReserve += lp;
        uint256 scaled = (lp << SCALE_BITS) + p.accRemainder;
        p.acc += scaled / p.l;
        p.accRemainder = scaled % p.l;
    }

    /** Emits `Swapped` for a buy (`coin` paid in, `tokens` out) or a sell (`tokens` in, `coin` paid out after the fee). */
    function _emitSwap(address token, address trader, bool isBuy, uint256 coin, uint256 tokens, uint256 fee, uint256 protocol) private {
        Pool storage p = pools[token];
        if (isBuy) emit Swapped(token, trader, true, coin, 0, 0, tokens, fee, protocol, p.x, p.y);
        else emit Swapped(token, trader, false, 0, coin, tokens, 0, fee, protocol, p.x, p.y);
    }

    /** Deletes a position with no shares and no pending fees, so it no longer shows as open (review finding L-19). */
    function _closeIfEmpty(address token, address owner, Position storage pos) private {
        if (pos.shares == 0 && pos.pending == 0) {
            delete positions[token][owner];
            emit PositionClosed(token, owner);
        }
    }

    /** Moves the position's earned fees into `pending`. Credits are rounded down, so claims never sum to more than was credited. */
    function _settle(Pool storage p, Position storage pos) private {
        pos.pending += (pos.shares * (p.acc - pos.checkpoint)) >> SCALE_BITS;
        pos.checkpoint = p.acc;
    }

    /** Takes `amount` tokens from `from` and checks the pool's balance rose by exactly that. */
    function _pull(address token, address from, uint256 amount) private {
        uint256 before = IPoolToken(token).balanceOf(address(this));
        require(IPoolToken(token).transferFrom(from, address(this), amount), "transfer");
        require(IPoolToken(token).balanceOf(address(this)) == before + amount, "balance");
    }

    /** Sends `amount` tokens and checks the pool's balance fell by exactly that. */
    function _push(address token, address to, uint256 amount) private {
        uint256 before = IPoolToken(token).balanceOf(address(this));
        require(IPoolToken(token).transfer(to, amount), "transfer");
        require(IPoolToken(token).balanceOf(address(this)) + amount == before, "balance");
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send");
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
