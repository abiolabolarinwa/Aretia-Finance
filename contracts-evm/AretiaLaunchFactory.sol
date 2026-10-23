// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AretiaToken} from "./AretiaTokenFactory.sol";

interface IV2Factory {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}

interface IWrapped {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

interface IV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function skim(address to) external;
}

/**
 * Aretia Launch, EVM: create a token AND open its trading pool with the liquidity locked, all in ONE transaction. The lock is not a
 * choice made afterwards and cannot be skipped: there is no other way to create a token here.
 *
 * In `launch` the factory, in this order and atomically (any failure reverts everything, so nothing is ever half done):
 *   1. creates a fixed-supply AretiaToken (no owner, no mint, no pause, no fee on transfer) and receives its whole supply;
 *   2. opens the token's pool on the network's Uniswap V2-style exchange with `poolBps` of the supply and all the coin sent beyond the
 *      fee, and sends the pool's liquidity tokens to the dead address, so nobody (the creator, Aretia, anyone) can ever withdraw the
 *      liquidity;
 *   3. sends the rest of the supply to the creator;
 *   4. sends the flat fee to the fee recipient.
 * At least MIN_POOL_BPS (70%) of the supply must go into the pool, and at least `minLiquidity` of the coin.
 *
 * What the lock does NOT do: it does not stop the creator selling the tokens they keep (up to 30%), and it does not make a token safe or
 * valuable. It removes one thing: pulling the liquidity out from under buyers.
 *
 * The factory is immutable: no owner, no admin, no setters, no upgrade, and it holds nothing between calls. The fee, fee recipient,
 * exchange factory, wrapped coin and minimum liquidity are fixed at deployment; the page only trusts the factory addresses written in
 * its own code and reads these back before signing.
 *
 * The pool is opened by sending the tokens and the wrapped coin straight to the pair and calling its `mint`, not through the router:
 * anyone can create the pair for a token before the token exists (its address is predictable) and send it dust, which makes the router's
 * `addLiquidityETH` revert. Going straight to the pair works whatever is already there: anything unsynced is skimmed to the creator, and
 * anything synced only adds coin to the pool at the sender's own cost.
 */
contract AretiaLaunchFactory {
    uint256 public constant MIN_POOL_BPS = 7000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /** Where the creation fee goes. Fixed at deployment. */
    address public immutable feeRecipient;
    /** The exact flat fee, in wei of the chain's native coin. Fixed at deployment. */
    uint256 public immutable fee;
    /** The Uniswap V2-style factory the pool is opened on. Fixed at deployment. */
    address public immutable dexFactory;
    /** The wrapped native coin the pool pairs the token with. Fixed at deployment. */
    address public immutable wrapped;
    /** The least coin, in wei, a launch must put into the pool. Fixed at deployment. */
    uint256 public immutable minLiquidity;

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address indexed pair,
        string name,
        string symbol,
        uint8 decimals,
        uint256 supply,
        uint256 poolTokens,
        uint256 poolCoin
    );

    constructor(address feeRecipient_, uint256 fee_, address dexFactory_, address wrapped_, uint256 minLiquidity_) {
        require(feeRecipient_ != address(0) && dexFactory_ != address(0) && wrapped_ != address(0), "address");
        require(minLiquidity_ > 0, "liquidity");
        feeRecipient = feeRecipient_;
        fee = fee_;
        dexFactory = dexFactory_;
        wrapped = wrapped_;
        minLiquidity = minLiquidity_;
    }

    /**
     * Creates the token and opens its locked pool. Send `fee` plus the coin for the pool (at least `minLiquidity`); `poolBps` is the share
     * of the supply that goes into the pool, from 7000 (70%) to 10000 (100%).
     */
    function launch(string calldata name, string calldata symbol, uint8 decimals, uint256 supply, uint256 poolBps)
        external
        payable
        returns (address token, address pair)
    {
        require(msg.value >= fee + minLiquidity, "value");
        require(supply > 0, "supply");
        require(bytes(name).length > 0 && bytes(name).length <= 32, "name");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 11, "symbol");
        require(decimals <= 18, "decimals");
        require(poolBps >= MIN_POOL_BPS && poolBps <= 10_000, "pool share");
        uint256 poolTokens = (supply * poolBps) / 10_000;
        require(poolTokens > 0, "pool tokens");
        uint256 poolCoin = msg.value - fee;

        token = address(new AretiaToken(name, symbol, decimals, supply, address(this)));

        pair = IV2Factory(dexFactory).getPair(token, wrapped);
        if (pair == address(0)) pair = IV2Factory(dexFactory).createPair(token, wrapped);
        // Anything someone sent to a pair they made first, and has not synced, goes to the creator, not into the pool.
        IV2Pair(pair).skim(msg.sender);

        IWrapped(wrapped).deposit{value: poolCoin}();
        require(IWrapped(wrapped).transfer(pair, poolCoin), "wrap");
        require(AretiaToken(token).transfer(pair, poolTokens), "tokens");
        require(IV2Pair(pair).mint(DEAD) > 0, "mint");

        uint256 rest = supply - poolTokens;
        if (rest > 0) require(AretiaToken(token).transfer(msg.sender, rest), "rest");

        emit TokenLaunched(token, msg.sender, pair, name, symbol, decimals, supply, poolTokens, poolCoin);

        if (fee > 0) {
            (bool ok, ) = feeRecipient.call{value: fee}("");
            require(ok, "fee transfer");
        }
    }
}
