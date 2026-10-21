// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Pair seeder for the Launch page's "open a Uniswap V2-style pool" flow (website/src/scripts/walletPoolEvmFlow.ts). Read
 * docs/BONDING_CURVE_EVM.md, section "Graduation blocked by a pre-made pair (M-4) and the rescue helper", first.
 *
 * Why it exists. The page opens a pool with the router's `addLiquidityETH`, minimums equal to the amounts. Anyone can create the
 * token/WETH pair first, send it 1 wei of WETH and call `sync()`: the pair then has no liquidity tokens at all (totalSupply == 0) but
 * non-zero reserves, the router's `quote` reverts with INSUFFICIENT_LIQUIDITY (or picks other amounts, failing the minimums), and the
 * page can never open the pool through the router.
 *
 * What it does, in one transaction, only for a pair with NO liquidity tokens (nobody owns its reserves):
 *   1. creates the pair if it does not exist yet;
 *   2. `skim`s any unsynced excess to the caller;
 *   3. tops the pair up so its reserves become EXACTLY `tokenAmount` tokens and `msg.value` coin (the dust already there counts towards
 *      them, so the caller pays slightly less), pulling the tokens straight from the caller to the pair and wrapping the coin;
 *   4. `mint`s the liquidity tokens to `to` (the dead address to lock, or the caller);
 *   5. checks the pair's reserves are exactly the intended ones, i.e. the pool opened at exactly the intended price;
 *   6. refunds the coin it did not need.
 * If the pair already has reserves above either intended amount, or already has liquidity tokens, it reverts: that pool is owned by someone.
 *
 * Properties, kept on purpose: PERMISSIONLESS, NO OWNER, NO STATE; holds nothing between calls; the only `transferFrom` is from
 * `msg.sender`. Works for any ERC-20 (including ones that return no bool); a token that moves a different amount than asked (fee on
 * transfer) fails the exact-reserve check and the whole call reverts.
 */

interface ISeederRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface ISeederFactory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

interface ISeederPair {
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function getReserves() external view returns (uint112, uint112, uint32);
    function skim(address to) external;
    function mint(address to) external returns (uint256);
}

interface ISeederWETH {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
}

contract AretiaPairSeeder {
    /** The exchange router whose factory and wrapped coin are used (read once at deployment). */
    address public immutable router;
    address public immutable pairFactory;
    address public immutable weth;

    uint256 private guard = 1;

    event Seeded(address indexed token, address indexed caller, address pair, address to, uint256 tokenAmount, uint256 coinAmount, uint256 tokensPaid, uint256 coinPaid, uint256 liquidity);

    modifier nonReentrant() {
        require(guard == 1, "reentrant");
        guard = 2;
        _;
        guard = 1;
    }

    constructor(address router_) {
        require(router_ != address(0), "zero");
        router = router_;
        address f = ISeederRouter(router_).factory();
        address w = ISeederRouter(router_).WETH();
        require(f != address(0) && w != address(0), "zero");
        pairFactory = f;
        weth = w;
    }

    /** Coin comes in only with `seed`. */
    receive() external payable {
        revert("no deposits");
    }

    /**
     * What `seed(token, tokenAmount, ·)` with `coinAmount` would take from the caller right now: (`tokensPaid`, `coinPaid`), and whether it
     * can go ahead at all (`ok`: no liquidity tokens yet and reserves at or below both amounts).
     */
    function quote(address token, uint256 tokenAmount, uint256 coinAmount) external view returns (bool ok, address pair, uint256 tokensPaid, uint256 coinPaid) {
        pair = ISeederFactory(pairFactory).getPair(token, weth);
        if (pair == address(0)) return (tokenAmount > 0 && coinAmount > 0, pair, tokenAmount, coinAmount);
        if (ISeederPair(pair).totalSupply() != 0) return (false, pair, 0, 0);
        (uint256 rT, uint256 rC) = _reserves(pair, token);
        if (rT >= tokenAmount || rC >= coinAmount) return (false, pair, 0, 0);
        return (true, pair, tokenAmount - rT, coinAmount - rC);
    }

    /**
     * Opens the token/WETH pool with reserves of exactly `tokenAmount` tokens and `msg.value` coin, liquidity tokens to `to`. The caller must
     * have approved this contract for at least `tokenAmount` (less is pulled when the pair already holds dust). Returns the pair and the
     * liquidity minted.
     */
    function seed(address token, uint256 tokenAmount, address to) external payable nonReentrant returns (address pair, uint256 liquidity) {
        require(token != address(0) && token != weth && to != address(0) && token.code.length > 0, "args");
        require(tokenAmount > 0 && tokenAmount <= type(uint112).max && msg.value > 0 && msg.value <= type(uint112).max, "amounts");
        pair = ISeederFactory(pairFactory).getPair(token, weth);
        if (pair == address(0)) pair = ISeederFactory(pairFactory).createPair(token, weth);
        require(ISeederPair(pair).totalSupply() == 0, "pool has liquidity");
        ISeederPair(pair).skim(msg.sender);
        (uint256 rT, uint256 rC) = _reserves(pair, token);
        require(rT < tokenAmount && rC < msg.value, "reserves above amounts");
        uint256 tokensPaid = tokenAmount - rT;
        uint256 coinPaid = msg.value - rC;

        _transferFrom(token, msg.sender, pair, tokensPaid);
        ISeederWETH(weth).deposit{value: coinPaid}();
        require(ISeederWETH(weth).transfer(pair, coinPaid), "transfer");
        liquidity = ISeederPair(pair).mint(to);

        (uint256 fT, uint256 fC) = _reserves(pair, token);
        require(fT == tokenAmount && fC == msg.value, "price");
        emit Seeded(token, msg.sender, pair, to, tokenAmount, msg.value, tokensPaid, coinPaid, liquidity);

        uint256 b = address(this).balance;
        if (b > 0) {
            (bool ok, ) = msg.sender.call{value: b}("");
            require(ok, "refund");
        }
    }

    function _reserves(address pair, address token) private view returns (uint256 rT, uint256 rC) {
        (uint112 r0, uint112 r1, ) = ISeederPair(pair).getReserves();
        (rT, rC) = ISeederPair(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /** transferFrom that accepts tokens returning nothing (as the pair's own `_safeTransfer` does). */
    function _transferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
    }
}
