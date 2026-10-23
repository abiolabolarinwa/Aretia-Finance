// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Orders {
    function balanceOf(address) external view returns (uint256);
}

interface IFactoryOrders {
    function creatorOf(address token) external view returns (address);
}

interface IWrappedNative {
    function deposit() external payable;
}

/// @title AretiaOrders
/// @notice Limit buy and limit sell for Aretia Launch tokens. The owner escrows what they will pay with; anyone (a keeper) may
/// fill the order by routing a swap through a whitelisted venue; this contract measures what actually arrived and refuses the
/// fill unless the owner receives at least their limit, after Aretia's fee. Buy and sell are the same check, so there is no
/// price oracle. Specification: docs/aretia-launch/adr/0007-order-program.md (this is its EVM stage).
///
/// @dev What the contract enforces, so no keeper or client can skip it:
///  - a fill delivers at least `ceil(slice * minOutRemaining / inRemaining)` to the owner, after the sell fee;
///  - the venue is paid EXACTLY the slice it was told to spend (the contract approves that and nothing more, then revokes it);
///  - only venues on the admin whitelist can be called, never a token, and never this contract;
///  - the keeper's reward is a share of the price improvement above the limit;
///  - only the owner can cancel, and a cancel always works, paused or not;
///  - fees are copied into the order when it is made and cannot change afterwards; each has a hard cap.
///
/// KNOWN LIMIT (unlike the Solana program, which gives every order its own vault): escrow here is pooled in this one contract.
/// A venue is called by this contract, so a venue that could make this contract call arbitrary functions (a token, an
/// aggregator with arbitrary-call features) could move OTHER orders' tokens. Only plain swap routers may be whitelisted; the
/// admin is a multisig behind a timelock for that reason. Tokens that take a fee on transfer are refused.
contract AretiaOrders {
    struct Order {
        address owner;
        address launchToken;
        address quoteToken;
        bool isBuy;
        uint16 cancelBps;
        uint16 buyBps;
        uint16 sellBps;
        uint16 keeperBps;
        uint256 inTotal;
        uint256 inRemaining;
        uint256 minOutRemaining;
        /// Buy: input filled so far. Sell: gross output received so far. The fee is the cumulative ceiling on this, less `feePaid`.
        uint256 feeBaseCum;
        uint256 feePaid;
    }

    /// Working values of one fill, kept in memory so the function stays within the stack.
    struct Settlement {
        uint256 net;
        uint256 sellFee;
        uint256 feeBaseAfter;
        uint256 reward;
        uint256 toOwner;
        uint256 remaining;
        address owner;
        address tokenOut;
    }

    uint16 public constant MAX_CANCEL_BPS = 100;
    uint16 public constant MAX_BUY_BPS = 300;
    uint16 public constant MAX_SELL_BPS = 300;
    uint16 public constant MAX_KEEPER_BPS = 5000;
    uint256 private constant BPS = 10_000;

    IFactoryOrders public immutable factory;
    address public immutable wrappedNative;

    address public admin;
    address public feeRecipient;
    uint16 public cancelBps;
    uint16 public buyBps;
    uint16 public sellBps;
    uint16 public keeperBps;
    bool public paused;
    uint256 public nextId = 1;
    mapping(uint256 => Order) public orders;
    mapping(address => bool) public venues;
    /// Smallest order per payment asset, in its base units (the USD 50 floor). Zero means the asset is not enabled.
    mapping(address => uint256) public minAmount;
    /// Tokens proven to come from the factory by their CREATE address (see `proveLaunchToken`). Needed for factories that, like the
    /// ones already deployed, have no `creatorOf`.
    mapping(address => bool) public proven;
    uint256 private _lock = 1;

    event OrderCreated(
        uint256 indexed id,
        address indexed owner,
        address indexed launchToken,
        address quoteToken,
        bool isBuy,
        uint256 amountIn,
        uint256 minOut
    );
    event OrderFilled(
        uint256 indexed id,
        address indexed keeper,
        address venue,
        uint256 inputUsed,
        uint256 received,
        uint256 aretiaFee,
        uint256 keeperReward,
        uint256 toOwner,
        uint256 remaining
    );
    event OrderCancelled(uint256 indexed id, address indexed owner, uint256 refunded, uint256 fee);
    event AdminChanged(address indexed admin);
    event VenueSet(address indexed venue, bool allowed);
    event QuoteSet(address indexed token, uint256 minAmount);
    event LaunchTokenProven(address indexed token, uint256 factoryNonce);
    event ConfigSet(address feeRecipient, uint16 cancelBps, uint16 buyBps, uint16 sellBps, uint16 keeperBps, bool paused);

    error Reentrant();
    error NotAdmin();
    error NotOwner();
    error ZeroAddress();
    error FeeAboveCap();
    error Paused();
    error NoSuchOrder();
    error NotALaunchToken();
    error NotFromFactory();
    error QuoteNotEnabled();
    error ZeroAmount();
    error BelowMinimum();
    error SameToken();
    error TransferFailed();
    error TokenTakesAFee();
    error VenueNotAllowed();
    error SliceNotAllowed();
    error AmountTooSmall();
    error VenueFailed();
    error WrongAmountSpent();
    error LimitNotMet();
    error NotWrappedNativeOrder();
    error Overflow();

    constructor(
        address admin_,
        address feeRecipient_,
        address factory_,
        address wrappedNative_,
        uint16 cancelBps_,
        uint16 buyBps_,
        uint16 sellBps_,
        uint16 keeperBps_
    ) {
        if (admin_ == address(0) || feeRecipient_ == address(0) || factory_ == address(0) || wrappedNative_ == address(0)) revert ZeroAddress();
        _checkFees(cancelBps_, buyBps_, sellBps_, keeperBps_);
        admin = admin_;
        feeRecipient = feeRecipient_;
        factory = IFactoryOrders(factory_);
        wrappedNative = wrappedNative_;
        cancelBps = cancelBps_;
        buyBps = buyBps_;
        sellBps = sellBps_;
        keeperBps = keeperBps_;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ------------------------------------------------------------------------------------------------ administration

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    /// Changes what NEW orders are made with. Open orders keep the fees they were made with.
    function setConfig(address feeRecipient_, uint16 cancelBps_, uint16 buyBps_, uint16 sellBps_, uint16 keeperBps_, bool paused_) external onlyAdmin {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        _checkFees(cancelBps_, buyBps_, sellBps_, keeperBps_);
        feeRecipient = feeRecipient_;
        cancelBps = cancelBps_;
        buyBps = buyBps_;
        sellBps = sellBps_;
        keeperBps = keeperBps_;
        paused = paused_;
        emit ConfigSet(feeRecipient_, cancelBps_, buyBps_, sellBps_, keeperBps_, paused_);
    }

    /// A venue is called by this contract during a fill: only plain swap routers belong here (see the contract note).
    function setVenue(address venue, bool allowed) external onlyAdmin {
        if (venue == address(0) || venue == address(this)) revert VenueNotAllowed();
        venues[venue] = allowed;
        emit VenueSet(venue, allowed);
    }

    /// Lists a payment asset with its smallest order (zero switches it off).
    function setQuote(address token, uint256 minAmount_) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        minAmount[token] = minAmount_;
        emit QuoteSet(token, minAmount_);
    }

    function _checkFees(uint16 c, uint16 b, uint16 s, uint16 k) private pure {
        if (c > MAX_CANCEL_BPS || b > MAX_BUY_BPS || s > MAX_SELL_BPS || k > MAX_KEEPER_BPS) revert FeeAboveCap();
    }

    // ------------------------------------------------------------------------------------------------ making an order

    /// @param isBuy Buy: pay `amountIn` of `quoteToken` for at least `minOut` of `launchToken`. Sell: sell `amountIn` of
    /// `launchToken` for at least `minOut` of `quoteToken`. The limit is what the owner ends up holding, after Aretia's fee.
    function createOrder(address launchToken, address quoteToken, bool isBuy, uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256 id) {
        // Check everything first, so a token that has not been vetted is never called; then take the money (a failure reverts all).
        id = _open(msg.sender, launchToken, quoteToken, isBuy, amountIn, minOut);
        _pull(isBuy ? quoteToken : launchToken, msg.sender, amountIn);
    }

    /// A buy paid in the chain's native currency: it is wrapped, and the order is a buy against the wrapped token.
    function createBuyWithNative(address launchToken, uint256 minOut) external payable nonReentrant returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        address w = wrappedNative;
        id = _open(msg.sender, launchToken, w, true, msg.value, minOut);
        uint256 before = IERC20Orders(w).balanceOf(address(this));
        IWrappedNative(w).deposit{value: msg.value}();
        if (IERC20Orders(w).balanceOf(address(this)) - before != msg.value) revert TokenTakesAFee();
    }

    /// @notice Proves a token was deployed by the factory, so orders can be made for it. Works for any factory: the token's
    /// address must be the one the factory's CREATE produces at `factoryNonce` (the factory's contract nonce when it made the token;
    /// its first token used 1). Anyone can call it, once per token. A factory that only deploys Aretia tokens makes this a proof
    /// that the token is one; the factory this contract is deployed with must be exactly that.
    function proveLaunchToken(address token, uint256 factoryNonce) external {
        if (token != _createAddress(address(factory), factoryNonce) || token.code.length == 0) revert NotFromFactory();
        proven[token] = true;
        emit LaunchTokenProven(token, factoryNonce);
    }

    /// A launch token is one proven by its address, or one a factory that keeps a register (`creatorOf`) vouches for. A factory
    /// without that function simply answers "no" here, instead of making the order revert for the wrong reason.
    function _isLaunchToken(address token) private view returns (bool) {
        if (proven[token]) return true;
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeCall(IFactoryOrders.creatorOf, (token)));
        return ok && ret.length == 32 && abi.decode(ret, (address)) != address(0);
    }

    /// The address a CREATE from `deployer` at contract nonce `n` makes: keccak256(rlp([deployer, n])), last 20 bytes.
    function _createAddress(address deployer, uint256 n) private pure returns (address) {
        bytes memory data;
        if (n == 0) data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        else if (n <= 0x7f) data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(n));
        else if (n <= 0xff) data = abi.encodePacked(bytes1(0xd7), bytes1(0x94), deployer, bytes1(0x81), uint8(n));
        else if (n <= 0xffff) data = abi.encodePacked(bytes1(0xd8), bytes1(0x94), deployer, bytes1(0x82), uint16(n));
        else if (n <= 0xffffff) data = abi.encodePacked(bytes1(0xd9), bytes1(0x94), deployer, bytes1(0x83), uint24(n));
        else if (n <= 0xffffffff) data = abi.encodePacked(bytes1(0xda), bytes1(0x94), deployer, bytes1(0x84), uint32(n));
        else revert Overflow();
        return address(uint160(uint256(keccak256(data))));
    }

    function _open(address owner, address launchToken, address quoteToken, bool isBuy, uint256 amountIn, uint256 minOut) private returns (uint256 id) {
        if (paused) revert Paused();
        if (amountIn == 0 || minOut == 0) revert ZeroAmount();
        if (launchToken == quoteToken) revert SameToken();
        if (!_isLaunchToken(launchToken)) revert NotALaunchToken();
        uint256 floor = minAmount[quoteToken];
        if (floor == 0) revert QuoteNotEnabled();
        if ((isBuy ? amountIn : minOut) < floor) revert BelowMinimum();
        id = nextId++;
        orders[id] = Order({
            owner: owner,
            launchToken: launchToken,
            quoteToken: quoteToken,
            isBuy: isBuy,
            cancelBps: cancelBps,
            buyBps: buyBps,
            sellBps: sellBps,
            keeperBps: keeperBps,
            inTotal: amountIn,
            inRemaining: amountIn,
            minOutRemaining: minOut,
            feeBaseCum: 0,
            feePaid: 0
        });
        emit OrderCreated(id, owner, launchToken, quoteToken, isBuy, amountIn, minOut);
    }

    // ------------------------------------------------------------------------------------------------ filling

    /// @notice Fills `slice` of the order's remaining input through `venue`, which is called with `venueData` and is approved
    /// to take exactly the swap amount. Callable by anyone. The output must arrive at THIS contract: the data names it.
    function fill(uint256 id, uint256 slice, address venue, bytes calldata venueData) external nonReentrant {
        Order storage o = orders[id];
        if (o.owner == address(0)) revert NoSuchOrder();
        if (paused) revert Paused();
        if (!venues[venue] || venue == o.launchToken || venue == o.quoteToken || venue == address(this)) revert VenueNotAllowed();
        if (!_sliceAllowed(slice, o.inRemaining, o.inTotal)) revert SliceNotAllowed();

        (uint256 buyFee, uint256 received) = _swap(o, slice, venue, venueData);
        _settle(id, o, slice, buyFee, received, venue);
    }

    /// Takes Aretia's buy fee, lets the venue spend exactly the swap amount, and measures what came back.
    function _swap(Order storage o, uint256 slice, address venue, bytes calldata venueData) private returns (uint256 buyFee, uint256 received) {
        address tokenIn = o.isBuy ? o.quoteToken : o.launchToken;
        address tokenOut = o.isBuy ? o.launchToken : o.quoteToken;

        // Buy: the fee leaves the payment asset before the swap, so the venue is only given what is really spent.
        uint256 swapIn = slice;
        if (o.isBuy) {
            uint256 due = _ceilBps(o.feeBaseCum + slice, o.buyBps);
            buyFee = due > o.feePaid ? due - o.feePaid : 0;
            if (buyFee >= slice) revert AmountTooSmall();
            swapIn = slice - buyFee;
            _push(tokenIn, feeRecipient, buyFee);
        }

        uint256 inBefore = IERC20Orders(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20Orders(tokenOut).balanceOf(address(this));
        _approve(tokenIn, venue, swapIn);
        (bool ok, ) = venue.call(venueData);
        _approve(tokenIn, venue, 0);
        if (!ok) revert VenueFailed();
        if (inBefore - IERC20Orders(tokenIn).balanceOf(address(this)) != swapIn) revert WrongAmountSpent();
        received = IERC20Orders(tokenOut).balanceOf(address(this)) - outBefore;
    }

    /// Checks the owner's limit against what arrived, updates the order, and pays everyone.
    function _settle(uint256 id, Order storage o, uint256 slice, uint256 buyFee, uint256 received, address venue) private {
        Settlement memory r;
        uint256 required = _requiredOut(slice, o.inRemaining, o.minOutRemaining);
        (r.net, r.sellFee, r.feeBaseAfter) = _netOf(o, slice, received);
        if (r.net < required) revert LimitNotMet();
        r.reward = ((r.net - required) * o.keeperBps) / BPS;
        r.toOwner = r.net - r.reward;

        // Effects, then the payouts.
        r.owner = o.owner;
        r.tokenOut = o.isBuy ? o.launchToken : o.quoteToken;
        o.inRemaining -= slice;
        o.minOutRemaining -= required;
        o.feeBaseCum = r.feeBaseAfter;
        o.feePaid += o.isBuy ? buyFee : r.sellFee;
        r.remaining = o.inRemaining;
        if (r.remaining == 0) delete orders[id];

        if (r.sellFee > 0) _push(r.tokenOut, feeRecipient, r.sellFee);
        if (r.reward > 0) _push(r.tokenOut, msg.sender, r.reward);
        _push(r.tokenOut, r.owner, r.toOwner);
        emit OrderFilled(id, msg.sender, venue, slice, received, buyFee + r.sellFee, r.reward, r.toOwner, r.remaining);
    }

    /// What the owner is owed from `received`: a buy gets all of it, a sell loses Aretia's fee (cumulative ceiling, so slicing
    /// an order cannot inflate the fee).
    function _netOf(Order storage o, uint256 slice, uint256 received) private view returns (uint256 net, uint256 sellFee, uint256 feeBaseAfter) {
        if (o.isBuy) return (received, 0, o.feeBaseCum + slice);
        feeBaseAfter = o.feeBaseCum + received;
        uint256 due = _ceilBps(feeBaseAfter, o.sellBps);
        sellFee = due > o.feePaid ? due - o.feePaid : 0;
        if (sellFee > received) revert AmountTooSmall();
        net = received - sellFee;
    }

    // ------------------------------------------------------------------------------------------------ cancelling

    /// @notice Returns what is unfilled, less the cancel fee (in the asset that was escrowed). Owner only; never blocked.
    function cancel(uint256 id) external nonReentrant {
        Order memory o = orders[id];
        if (o.owner == address(0)) revert NoSuchOrder();
        if (msg.sender != o.owner) revert NotOwner();
        delete orders[id];
        address token = o.isBuy ? o.quoteToken : o.launchToken;
        uint256 fee = _ceilBps(o.inRemaining, o.cancelBps);
        if (fee > o.inRemaining) fee = o.inRemaining;
        // A token issuer can block an address (USDC and USDT do). If Aretia's fee address is blocked, the fee cannot be paid; the
        // owner must still get everything back, so the fee is waived rather than the cancel failing.
        if (fee > 0 && !_tryPush(token, feeRecipient, fee)) fee = 0;
        uint256 refund = o.inRemaining - fee;
        if (refund > 0) _push(token, o.owner, refund);
        emit OrderCancelled(id, o.owner, refund, fee);
    }

    // ------------------------------------------------------------------------------------------------ arithmetic

    function _ceilBps(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }

    /// `ceil(slice * minOutRemaining / inRemaining)`; the last slice owes exactly what is left.
    function _requiredOut(uint256 slice, uint256 inRemaining, uint256 minOutRemaining) private pure returns (uint256) {
        if (slice == inRemaining) return minOutRemaining;
        return (slice * minOutRemaining + inRemaining - 1) / inRemaining;
    }

    /// At least 5% of the order, or whatever remains: a keeper cannot grind an order into dust.
    function _sliceAllowed(uint256 slice, uint256 inRemaining, uint256 inTotal) private pure returns (bool) {
        return slice > 0 && slice <= inRemaining && (slice == inRemaining || slice * 20 >= inTotal);
    }

    // ------------------------------------------------------------------------------------------------ token plumbing
    // Low-level calls, so tokens that return nothing (USDT) work and a `false` return is caught.

    function _pull(address token, address from, uint256 amount) private {
        uint256 before = IERC20Orders(token).balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (IERC20Orders(token).balanceOf(address(this)) - before != amount) revert TokenTakesAFee();
    }

    function _tryPush(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// Sets an allowance, going through zero first as USDT requires.
    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (amount == 0) return;
        (ok, ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
