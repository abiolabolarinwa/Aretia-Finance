//! Pure decision logic for the presale: no Anchor, no I/O, so it compiles and is unit-tested on the host
//! (`cargo test`, or `rustc --edition 2021 --test src/policy.rs`) without the SBF toolchain.
//! `lib.rs` calls these functions; the account constraints that enforce the *same* rules on-chain are separate and
//! are NOT covered by these tests (see docs/audit/TEST_EVIDENCE.md).

/// Widest Pyth confidence interval accepted, as basis points of the price (100 bps = 1%).
/// Policy parameter: SOL/USD normally trades at a small fraction of this; owner to confirm.
pub const MAX_PRICE_CONF_BPS: u64 = 100;

// ---- F-16: oracle confidence ------------------------------------------------------------------------------------
/// True when the price is positive and its confidence interval is at most `max_bps` of the price.
/// Pyth publishes `price +/- conf`; a wide interval means the feed itself is uncertain, so we refuse to price a purchase
/// off it. u128 arithmetic: `conf * 10_000` and `price * max_bps` cannot overflow.
pub fn price_confidence_ok(price: i64, conf: u64, max_bps: u64) -> bool {
    if price <= 0 {
        return false;
    }
    (conf as u128) * 10_000 <= (price as u128) * (max_bps as u128)
}

// ---- F-15: who may finalize --------------------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizeCheck {
    Allowed,
    StillOpen,
    NotPermitted,
}
/// Once the sale window has ended, anyone may finalize: the outcome (sweep to treasury vs. Refunding) is a pure function
/// of on-chain state and every destination account is bound to the config, so the caller cannot influence it. This
/// removes the dependency on a single key for buyers to be able to exit. Finalizing *early* because the hard cap was
/// reached stays authority-only, as before.
pub fn finalize_check(caller_is_authority: bool, now: i64, end_ts: i64, hard_cap_reached: bool) -> FinalizeCheck {
    if now >= end_ts {
        return FinalizeCheck::Allowed;
    }
    if hard_cap_reached {
        return if caller_is_authority { FinalizeCheck::Allowed } else { FinalizeCheck::NotPermitted };
    }
    FinalizeCheck::StillOpen
}

// ---- F-20: sales must be backed by the funded ACT reserve ----------------------------------------------------------
/// Raw-unit cushion kept on top of the grossed-up amount owed. Same value `sweep_unsold_act` has always used: the gross-up
/// estimate can be a few raw units short against Token-2022's fee rounding, so never plan to the last unit.
pub const GROSS_UP_SAFETY_MARGIN: u64 = 100_000;

/// True when the funded reserve can pay out `gross_needed` (the grossed-up amount the vault must send so buyers net their
/// whole allocation) plus `margin`. An overflowing sum is never enough.
pub fn reserve_covers(gross_needed: u64, reserve_net: u64, margin: u64) -> bool {
    match gross_needed.checked_add(margin) {
        Some(required) => required <= reserve_net,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // F-16 ---------------------------------------------------------------------------------------------------------
    #[test]
    fn confidence_accepts_a_tight_interval() {
        // 0.05% of a $150.00000000 price (expo -8): price = 15_000_000_000, conf = 7_500_000
        assert!(price_confidence_ok(15_000_000_000, 7_500_000, MAX_PRICE_CONF_BPS));
    }
    #[test]
    fn confidence_boundary_is_inclusive() {
        // exactly 1%: conf * 10_000 == price * 100
        assert!(price_confidence_ok(10_000, 100, 100));
        assert!(!price_confidence_ok(10_000, 101, 100));
    }
    #[test]
    fn confidence_rejects_a_wide_interval() {
        assert!(!price_confidence_ok(15_000_000_000, 1_500_000_001, MAX_PRICE_CONF_BPS));
        assert!(!price_confidence_ok(15_000_000_000, u64::MAX, MAX_PRICE_CONF_BPS));
    }
    #[test]
    fn confidence_rejects_non_positive_price_even_with_zero_conf() {
        assert!(!price_confidence_ok(0, 0, MAX_PRICE_CONF_BPS));
        assert!(!price_confidence_ok(-1, 0, MAX_PRICE_CONF_BPS));
        assert!(!price_confidence_ok(i64::MIN, 0, MAX_PRICE_CONF_BPS));
    }
    #[test]
    fn confidence_math_cannot_overflow() {
        // extreme inputs must neither panic nor wrap: the product is computed in u128
        let _ = price_confidence_ok(i64::MAX, u64::MAX, u64::MAX);
        assert!(!price_confidence_ok(1, u64::MAX, u64::MAX / 20_000));
        assert!(price_confidence_ok(i64::MAX, 0, 0));
        assert!(!price_confidence_ok(1, 1, 0));
    }

    // F-15 ---------------------------------------------------------------------------------------------------------
    const END: i64 = 1_000;
    #[test]
    fn anyone_can_finalize_once_the_window_has_ended() {
        assert_eq!(finalize_check(false, END, END, false), FinalizeCheck::Allowed);
        assert_eq!(finalize_check(false, END + 86_400 * 365, END, false), FinalizeCheck::Allowed);
        assert_eq!(finalize_check(false, END, END, true), FinalizeCheck::Allowed);
    }
    #[test]
    fn a_stranger_cannot_finalize_early_even_at_the_hard_cap() {
        assert_eq!(finalize_check(false, END - 1, END, false), FinalizeCheck::StillOpen);
        assert_eq!(finalize_check(false, END - 1, END, true), FinalizeCheck::NotPermitted);
    }
    #[test]
    fn the_authority_keeps_its_existing_powers() {
        assert_eq!(finalize_check(true, END - 1, END, false), FinalizeCheck::StillOpen);
        assert_eq!(finalize_check(true, END - 1, END, true), FinalizeCheck::Allowed);
        assert_eq!(finalize_check(true, END, END, false), FinalizeCheck::Allowed);
    }

    // F-20 ---------------------------------------------------------------------------------------------------------
    #[test]
    fn a_reserve_that_covers_the_gross_need_plus_margin_is_enough() {
        assert!(reserve_covers(1_000, 1_000 + GROSS_UP_SAFETY_MARGIN, GROSS_UP_SAFETY_MARGIN));
        assert!(reserve_covers(0, 0, 0));
        assert!(reserve_covers(1_000, 5_000_000, GROSS_UP_SAFETY_MARGIN));
    }
    #[test]
    fn one_raw_unit_short_is_not_enough() {
        assert!(!reserve_covers(1_000, 1_000 + GROSS_UP_SAFETY_MARGIN - 1, GROSS_UP_SAFETY_MARGIN));
        assert!(!reserve_covers(1, 0, 0));
    }
    #[test]
    fn an_empty_reserve_backs_nothing() {
        assert!(!reserve_covers(1, 0, GROSS_UP_SAFETY_MARGIN));
        assert!(!reserve_covers(GROSS_UP_SAFETY_MARGIN, 0, GROSS_UP_SAFETY_MARGIN));
    }
    #[test]
    fn the_margin_addition_cannot_overflow_into_a_pass() {
        assert!(!reserve_covers(u64::MAX, u64::MAX, 1));
        assert!(!reserve_covers(u64::MAX - 5, u64::MAX, 10));
        assert!(reserve_covers(u64::MAX - 10, u64::MAX, 10));
    }
}
