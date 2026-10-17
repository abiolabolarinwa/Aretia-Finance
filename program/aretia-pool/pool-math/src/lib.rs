//! Aretia Pool maths. Pure integer arithmetic, no Solana types, so every rule here can be property-tested
//! natively. The program (programs/aretia-pool) calls only these functions to price and split money.
//!
//! The pool is constant product over effective reserves `X = x + vx` (real tokens plus a virtual token reserve) and
//! `Y = y + l` (real SOL plus a virtual reserve equal to the liquidity `l`). A pool made from tokens alone has `y = 0`,
//! and nobody can sell more SOL out of the pool than buyers paid in (`gross <= y`), so the price never falls below the
//! starting price. With `vx = 0` the price has no ceiling. With `vx > 0` the pool has a price RANGE: buyers can take at
//! most the real tokens `x` (`out <= x`), so the price tops out where `x` reaches zero. That is the same shape as a
//! concentrated-liquidity position with a lower and an upper price, fixed for the whole pool.
//!
//! Rounding: every division rounds so that the pool keeps the remainder, never the trader or the depositor.
//!   * swaps: `X * Y` never decreases;
//!   * add liquidity by `f`:    `X' * Y' >= X * Y * (1 + f)^2`;
//!   * remove liquidity by `f`: `X' * Y' >= X * Y * (1 - f)^2`;
//!   * the fee credited to positions never exceeds the fee taken.
#![forbid(unsafe_code)]

/// Basis-point denominator.
pub const BPS: u128 = 10_000;
/// The share of every trading fee that goes to Aretia, in basis points of the fee: 20%.
pub const PROTOCOL_SHARE_BPS: u128 = 2_000;
/// The trading fees a creator may pick, in basis points of the SOL leg.
pub const ALLOWED_FEE_BPS: [u16; 2] = [25, 100];
/// The highest fee a launch-protection schedule may start at: 25%, in basis points.
pub const MAX_SNIPER_BPS: u16 = 2_500;
/// The longest a launch-protection schedule may last: one hour.
pub const MAX_DECAY_SECS: u32 = 3_600;
/// Smallest token deposit a pool may be created with, in raw units.
pub const MIN_TOKENS: u64 = 1_000;
/// Smallest liquidity a pool may be created with: 0.01 SOL of virtual reserve.
pub const MIN_LIQUIDITY: u64 = 10_000_000;
/// Smallest liquidity change by adding or removing (removing everything that is left is always allowed).
pub const MIN_LIQUIDITY_DELTA: u64 = 1_000;
/// Every amount going into a pool is held below this, so sums of reserves cannot overflow and `X * Y` fits u128.
pub const MAX_AMOUNT: u64 = 1 << 62;

/// The state the maths needs. All fields move only through the functions below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pool {
    /// Real token reserve.
    pub x: u64,
    /// Virtual token reserve: zero means no upper price. Scales with liquidity like `l` does.
    pub vx: u64,
    /// Real SOL reserve (lamports), not counting accrued fees.
    pub y: u64,
    /// Total liquidity = virtual SOL reserve = total shares.
    pub l: u64,
    pub fee_bps: u16,
    /// Cumulative fee per share, times 2^64. Wraps; only differences are meaningful.
    pub acc: u128,
    /// Lamports of LP fees accrued and not yet claimed.
    pub fee_reserve: u64,
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

/// `ceil(amount * bps / 10000)`.
pub fn fee_up(amount: u64, bps: u16) -> u64 {
    ceil_div(amount as u128 * bps as u128, BPS) as u64
}

/// Protocol part of a fee (rounded down); the rest belongs to the liquidity providers.
pub fn protocol_part(fee: u64) -> u64 {
    (fee as u128 * PROTOCOL_SHARE_BPS / BPS) as u64
}

/// The fee in force `now`, for a pool whose fee starts at `start_bps` at `start_ts` and falls in a straight line to `base_bps` over
/// `decay_secs`. The part above the base is rounded UP, so the schedule never undercharges. With no schedule it is the base.
pub fn effective_fee_bps(base_bps: u16, start_bps: u16, decay_secs: u32, start_ts: i64, now: i64) -> u16 {
    if decay_secs == 0 || start_bps <= base_bps {
        return base_bps;
    }
    let elapsed = now.saturating_sub(start_ts).max(0) as u64;
    if elapsed >= decay_secs as u64 {
        return base_bps;
    }
    let left = decay_secs as u64 - elapsed;
    let extra = ceil_div((start_bps - base_bps) as u128 * left as u128, decay_secs as u128) as u16;
    base_bps + extra
}

/// True when a launch-protection schedule is inside what the program allows. `(0, 0)` means no schedule.
pub fn schedule_ok(base_bps: u16, start_bps: u16, decay_secs: u32) -> bool {
    if start_bps == 0 && decay_secs == 0 {
        return true;
    }
    decay_secs > 0 && decay_secs <= MAX_DECAY_SECS && start_bps > base_bps && start_bps <= MAX_SNIPER_BPS
}

impl Pool {
    /// The pool's opening state, or None for any value outside the safe range.
    pub fn open(x0: u64, y0: u64, l0: u64, fee_bps: u16) -> Option<Pool> {
        Pool::open_ranged(x0, y0, l0, fee_bps, 0)
    }

    /// Like `open`, with a virtual token reserve `vx0` that sets an upper price. Zero means none; otherwise it must be
    /// between a thousandth and a thousand times the tokens deposited, which keeps the range between about 1.002x and
    /// a million times the starting price.
    pub fn open_ranged(x0: u64, y0: u64, l0: u64, fee_bps: u16, vx0: u64) -> Option<Pool> {
        if vx0 != 0 && (vx0 > MAX_AMOUNT || (vx0 as u128) * 1_000 < x0 as u128 || (vx0 as u128) > (x0 as u128) * 1_000) {
            return None;
        }
        if !ALLOWED_FEE_BPS.contains(&fee_bps) || x0 < MIN_TOKENS || l0 < MIN_LIQUIDITY {
            return None;
        }
        if x0 > MAX_AMOUNT || y0 > MAX_AMOUNT || l0 > MAX_AMOUNT {
            return None;
        }
        Some(Pool { x: x0, vx: vx0, y: y0, l: l0, fee_bps, acc: 0, fee_reserve: 0 })
    }

    /// Effective SOL reserve.
    pub fn big_y(&self) -> u128 {
        self.y as u128 + self.l as u128
    }

    /// Effective token reserve.
    pub fn big_x(&self) -> u128 {
        self.x as u128 + self.vx as u128
    }

    /// `X * Y`, which fits u128 while both are below 2^64 (checked wherever they grow).
    pub fn k(&self) -> u128 {
        self.big_x() * self.big_y()
    }

    /// True while every reserve is inside the range the maths is proved for.
    pub fn in_range(&self) -> bool {
        self.big_y() <= u64::MAX as u128 && self.big_x() <= u64::MAX as u128 && self.big_x() > 0 && self.l > 0
    }

    /// Splits a fee, credits the providers, and returns the protocol part.
    fn credit(&mut self, fee: u64) -> u64 {
        let protocol = protocol_part(fee);
        let lp = fee - protocol;
        // l > 0 always while the pool trades.
        let per_share = ((lp as u128) << 64) / self.l as u128;
        self.acc = self.acc.wrapping_add(per_share);
        self.fee_reserve += lp;
        protocol
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    /// What the buyer pays, in lamports.
    pub gross: u64,
    pub fee: u64,
    /// Aretia's part of the fee, sent to the fee wallet.
    pub protocol: u64,
    /// `gross - fee`: enters the pool's SOL reserve.
    pub net: u64,
    pub tokens_out: u64,
}

/// Exact-input buy: `gross` lamports in, tokens out. None if the trade is too small or too large.
pub fn buy(p: &Pool, gross: u64) -> Option<(Buy, Pool)> {
    if !p.in_range() || gross == 0 {
        return None;
    }
    let fee = fee_up(gross, p.fee_bps).min(gross);
    let net = gross - fee;
    if net == 0 {
        return None;
    }
    let new_y = p.big_y().checked_add(net as u128)?;
    if new_y > u64::MAX as u128 {
        return None;
    }
    let new_big_x = ceil_div(p.k(), new_y);
    let out = p.big_x().checked_sub(new_big_x)?;
    // Buyers can take only real tokens: with a price range, this is where the price tops out.
    if out == 0 || new_big_x == 0 || out > p.x as u128 {
        return None;
    }
    let mut next = *p;
    next.x = p.x - out as u64;
    next.y = p.y.checked_add(net)?;
    let protocol = next.credit(fee);
    let b = Buy { gross, fee, protocol, net, tokens_out: out as u64 };
    Some((b, next))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sell {
    /// Lamports leaving the SOL reserve.
    pub gross: u64,
    pub fee: u64,
    pub protocol: u64,
    /// `gross - fee`: what the seller receives.
    pub net: u64,
}

/// Exact-input sell: `tokens_in` tokens in, SOL out (rounded down), fee rounded up. Refused when it would pay out
/// more SOL than the pool really holds.
pub fn sell(p: &Pool, tokens_in: u64) -> Option<(Sell, Pool)> {
    if !p.in_range() || tokens_in == 0 {
        return None;
    }
    let new_big_x = p.big_x().checked_add(tokens_in as u128)?;
    if new_big_x > u64::MAX as u128 {
        return None;
    }
    let new_y = ceil_div(p.k(), new_big_x);
    let gross = p.big_y().checked_sub(new_y)?;
    if gross == 0 || gross > p.y as u128 {
        return None;
    }
    let gross = gross as u64;
    let fee = fee_up(gross, p.fee_bps).min(gross);
    let mut next = *p;
    next.x = p.x.checked_add(tokens_in)?;
    next.y = p.y - gross;
    let protocol = next.credit(fee);
    let s = Sell { gross, fee, protocol, net: gross - fee };
    Some((s, next))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Add {
    pub tokens_in: u64,
    pub sol_in: u64,
}

/// Adds `dl` of liquidity at the current price. The depositor pays both sides rounded up.
pub fn add(p: &Pool, dl: u64) -> Option<(Add, Pool)> {
    if !p.in_range() || dl < MIN_LIQUIDITY_DELTA {
        return None;
    }
    let dx = ceil_div(p.x as u128 * dl as u128, p.l as u128);
    let dy = ceil_div(p.y as u128 * dl as u128, p.l as u128);
    let dvx = ceil_div(p.vx as u128 * dl as u128, p.l as u128);
    let mut next = *p;
    next.x = u64::try_from((p.x as u128).checked_add(dx)?).ok()?;
    next.vx = u64::try_from((p.vx as u128).checked_add(dvx)?).ok()?;
    next.y = u64::try_from((p.y as u128).checked_add(dy)?).ok()?;
    next.l = p.l.checked_add(dl)?;
    if next.x > MAX_AMOUNT || next.vx > MAX_AMOUNT || next.y > MAX_AMOUNT || next.l > MAX_AMOUNT || !next.in_range() {
        return None;
    }
    Some((Add { tokens_in: dx as u64, sol_in: dy as u64 }, next))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Remove {
    pub tokens_out: u64,
    pub sol_out: u64,
}

/// Removes `dl` of liquidity. The provider receives both sides rounded down. Anything smaller than
/// `MIN_LIQUIDITY_DELTA` is refused unless it is everything that is left.
pub fn remove(p: &Pool, dl: u64) -> Option<(Remove, Pool)> {
    if p.l == 0 || dl == 0 || dl > p.l || (dl < MIN_LIQUIDITY_DELTA && dl != p.l) {
        return None;
    }
    let dx = p.x as u128 * dl as u128 / p.l as u128;
    let dy = p.y as u128 * dl as u128 / p.l as u128;
    let dvx = p.vx as u128 * dl as u128 / p.l as u128;
    let mut next = *p;
    next.x = p.x - dx as u64;
    next.vx = p.vx - dvx as u64;
    next.y = p.y - dy as u64;
    next.l = p.l - dl;
    Some((Remove { tokens_out: dx as u64, sol_out: dy as u64 }, next))
}

/// What a position may claim: `shares * (acc - checkpoint) >> 64`, rounded down. The product is up to 192 bits wide,
/// so it is done in two halves; the result is None if it does not fit u64 (which a sane pool never reaches).
pub fn pending_fee(shares: u64, acc: u128, checkpoint: u128) -> Option<u64> {
    let diff = acc.wrapping_sub(checkpoint);
    let (hi, lo) = ((diff >> 64) as u64, diff as u64);
    let low = (shares as u128 * lo as u128) >> 64;
    let high = shares as u128 * hi as u128;
    u64::try_from(high.checked_add(low)?).ok()
}

#[cfg(test)]
mod tests;
