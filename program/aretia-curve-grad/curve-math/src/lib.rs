//! Aretia bonding curve maths. Pure integer arithmetic, no Solana types, so every rule here can be
//! property-tested natively. The program (programs/aretia-curve) calls only these functions to move
//! money; it does no pricing arithmetic of its own.
//!
//! The curve is constant product over virtual reserves: `v_sol * v_tok = k`. Real money only ever
//! enters or leaves through `buy` and `sell`, and
//!   * `v_sol - real_sol == v_sol0` always (every lamport that enters the vault also enters `v_sol`),
//!   * `v_sol * v_tok >= k0` always (every division that rounds, rounds against the trader).
//! Together these make the vault solvent: a seller can never be paid more than the vault holds.
#![forbid(unsafe_code)]

/// Basis-point denominator.
pub const BPS: u128 = 10_000;
/// `v_sol0 = target * 6 / 17`, the same 30 : 85 ratio the best-known curves use.
pub const V_SOL_NUM: u128 = 6;
pub const V_SOL_DEN: u128 = 17;
/// Largest token amount a curve may be created with. Keeps every product below in u128 with room to spare.
pub const MAX_TOTAL_TOKENS: u64 = 1 << 62;
/// Largest raise target (1,000,000 SOL in lamports).
pub const MAX_TARGET_LAMPORTS: u64 = 1_000_000_000_000_000;

/// The live state of a curve. All four fields move only through `buy` and `sell`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    pub v_sol: u64,
    pub v_tok: u64,
    /// Lamports the curve vault owes to token holders (net of fees).
    pub real_sol: u64,
    /// Tokens still for sale on the curve.
    pub real_tok: u64,
}

/// What a curve starts with, derived from the two numbers a creator chooses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Derived {
    pub v_sol0: u64,
    pub v_tok0: u64,
    /// Tokens sold along the curve.
    pub curve_tokens: u64,
    /// Tokens kept back to seed the liquidity pool when the curve closes.
    pub lp_tokens: u64,
}

/// Splits `total_tokens` between the curve and the pool so the pool opens at the price where the
/// curve ended, and sets the virtual reserves. None for any value outside the safe range.
pub fn derive(total_tokens: u64, target_lamports: u64, min_target: u64) -> Option<Derived> {
    if total_tokens == 0 || total_tokens > MAX_TOTAL_TOKENS {
        return None;
    }
    if target_lamports < min_target || target_lamports > MAX_TARGET_LAMPORTS {
        return None;
    }
    let s = target_lamports as u128;
    let v0 = s * V_SOL_NUM / V_SOL_DEN;
    if v0 == 0 {
        return None;
    }
    // lp / curve = v0 / (v0 + s)  =>  lp = total * v0 / (2*v0 + s)
    let lp = (total_tokens as u128) * v0 / (2 * v0 + s);
    let c = (total_tokens as u128) - lp;
    if lp == 0 || c == 0 {
        return None;
    }
    // v_tok0 = (v0 + s) * c / s, rounded up so the curve never starts richer than intended.
    let vt0 = ceil_div((v0 + s) * c, s);
    if vt0 > u64::MAX as u128 || vt0 <= c {
        return None;
    }
    Some(Derived { v_sol0: v0 as u64, v_tok0: vt0 as u64, curve_tokens: c as u64, lp_tokens: lp as u64 })
}

impl Derived {
    pub fn start(&self) -> Curve {
        Curve { v_sol: self.v_sol0, v_tok: self.v_tok0, real_sol: 0, real_tok: self.curve_tokens }
    }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

/// `ceil(amount * bps / 10000)`.
pub fn fee_up(amount: u64, bps: u16) -> u64 {
    ceil_div(amount as u128 * bps as u128, BPS) as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    /// What the buyer actually pays: may be less than offered when the curve sells out.
    pub gross: u64,
    pub fee: u64,
    /// `gross - fee`: goes into the vault.
    pub net: u64,
    pub tokens_out: u64,
    /// True when this buy took the last token on the curve.
    pub sold_out: bool,
}

/// Exact-input buy: the buyer offers `gross_offered` lamports. The fee is rounded up and taken first. Tokens
/// out are rounded down. If the offer would buy more than is left, the buy is cut to exactly what is left and
/// priced rounding up, so the buyer never pays less than the curve says.
pub fn buy(c: &Curve, gross_offered: u64, fee_bps: u16) -> Option<(Buy, Curve)> {
    if fee_bps as u128 >= BPS || gross_offered == 0 {
        return None;
    }
    let fee = fee_up(gross_offered, fee_bps).min(gross_offered);
    let net = gross_offered - fee;
    if net == 0 || c.real_tok == 0 {
        return None;
    }
    let k = c.v_sol as u128 * c.v_tok as u128;
    let new_vs = c.v_sol as u128 + net as u128;
    let new_vt = ceil_div(k, new_vs);
    let out = c.v_tok as u128 - new_vt;
    let (net_used, gross_used, fee_used, tokens_out) = if out >= c.real_tok as u128 {
        let target_vt = c.v_tok as u128 - c.real_tok as u128;
        if target_vt == 0 {
            return None;
        }
        let need_vs = ceil_div(k, target_vt);
        let net_used = need_vs - c.v_sol as u128;
        let gross_used = ceil_div(net_used * BPS, BPS - fee_bps as u128);
        (net_used, gross_used, gross_used - net_used, c.real_tok as u128)
    } else {
        (net as u128, gross_offered as u128, fee as u128, out)
    };
    if tokens_out == 0 || gross_used > gross_offered as u128 || net_used > u64::MAX as u128 {
        return None;
    }
    let next = Curve {
        v_sol: (c.v_sol as u128 + net_used) as u64,
        v_tok: (c.v_tok as u128 - tokens_out) as u64,
        real_sol: c.real_sol.checked_add(net_used as u64)?,
        real_tok: c.real_tok - tokens_out as u64,
    };
    let b = Buy { gross: gross_used as u64, fee: fee_used as u64, net: net_used as u64, tokens_out: tokens_out as u64, sold_out: next.real_tok == 0 };
    Some((b, next))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sell {
    /// Lamports leaving the vault.
    pub gross: u64,
    pub fee: u64,
    /// `gross - fee`: what the seller receives.
    pub net: u64,
}

/// Exact-input sell: the seller hands in `tokens_in`. The SOL out is rounded down, the fee up. A sell that
/// would put back more tokens than the curve has ever sold (`curve_tokens` is the most it can hold) is refused, and so
/// is one that would pay the seller nothing after the fee (`net == 0`).
pub fn sell(c: &Curve, curve_tokens: u64, tokens_in: u64, fee_bps: u16) -> Option<(Sell, Curve)> {
    if fee_bps as u128 >= BPS || tokens_in == 0 {
        return None;
    }
    let real_tok = c.real_tok.checked_add(tokens_in)?;
    if real_tok > curve_tokens {
        return None;
    }
    let k = c.v_sol as u128 * c.v_tok as u128;
    let new_vt = c.v_tok as u128 + tokens_in as u128;
    let new_vs = ceil_div(k, new_vt);
    let gross = (c.v_sol as u128).checked_sub(new_vs)?;
    if gross > c.real_sol as u128 {
        return None;
    }
    let gross = gross as u64;
    let fee = fee_up(gross, fee_bps).min(gross);
    // A sell that would pay the seller nothing (dust whose SOL rounds to zero, or is all fee) is refused: the tokens would
    // simply be lost (BONDING_CURVE.md section 8).
    if gross == fee {
        return None;
    }
    let next = Curve { v_sol: new_vs as u64, v_tok: new_vt as u64, real_sol: c.real_sol - gross, real_tok };
    Some((Sell { gross, fee, net: gross - fee }, next))
}

/// The most that may be left unspent on either side when the pool takes the graduation money, in basis
/// points of what was reserved. Anything beyond this means the pool was opened at the wrong price.
pub const MIGRATION_DUST_BPS: u128 = 10;

/// True when what the pool left behind is within the allowed dust of what was reserved.
pub fn migration_consumed_enough(reserved: u64, left_over: u64) -> bool {
    (left_over as u128) * BPS <= (reserved as u128) * MIGRATION_DUST_BPS
}

#[cfg(test)]
mod tests;
