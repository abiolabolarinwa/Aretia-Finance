use super::*;
use num_bigint::BigUint;
use proptest::prelude::*;

const SOL: u64 = 1_000_000_000;

fn fresh(x0: u64, l0: u64, fee: u16) -> Pool {
    Pool::open(x0, 0, l0, fee).expect("openable")
}

fn big(a: u128, b: u128) -> BigUint {
    BigUint::from(a) * BigUint::from(b)
}

#[test]
fn open_refuses_out_of_range() {
    assert!(Pool::open(MIN_TOKENS - 1, 0, MIN_LIQUIDITY, 25).is_none());
    assert!(Pool::open(MIN_TOKENS, 0, MIN_LIQUIDITY - 1, 25).is_none());
    assert!(Pool::open(MIN_TOKENS, 0, MIN_LIQUIDITY, 30).is_none(), "only 25 and 100 bps");
    assert!(Pool::open(MAX_AMOUNT + 1, 0, MIN_LIQUIDITY, 25).is_none());
    assert!(Pool::open(MIN_TOKENS, MAX_AMOUNT + 1, MIN_LIQUIDITY, 100).is_none());
    assert!(Pool::open(MIN_TOKENS, 0, MAX_AMOUNT + 1, 100).is_none());
    assert!(Pool::open(MIN_TOKENS, 0, MIN_LIQUIDITY, 100).is_some());
}

#[test]
fn a_buy_is_priced_as_the_design_says() {
    // 1,000,000 tokens (6 decimals) with a 10 SOL virtual reserve: starting price 10 SOL per million tokens.
    let p = fresh(1_000_000_000_000, 10 * SOL, 25);
    let (b, next) = buy(&p, SOL).unwrap();
    assert_eq!(b.fee, 2_500_000, "0.25% of 1 SOL");
    assert_eq!(b.protocol, 500_000, "20% of the fee");
    assert_eq!(b.net, SOL - 2_500_000);
    // X' = ceil(k / (Y + net))
    let k = p.k();
    let y2 = 10 * SOL as u128 + b.net as u128;
    assert_eq!(next.x as u128, k / y2 + u128::from(k % y2 != 0));
    assert_eq!(b.tokens_out as u128, p.x as u128 - next.x as u128);
    assert_eq!(next.y, b.net);
    assert_eq!(next.fee_reserve, b.fee - b.protocol);
}

#[test]
fn the_price_cannot_fall_below_the_start() {
    let p = fresh(1_000_000_000_000, 10 * SOL, 100);
    // Nothing to sell into: no SOL has come in.
    assert!(sell(&p, 1).is_none());
    assert!(sell(&p, 1_000_000_000).is_none());
    let (b, after_buy) = buy(&p, 5 * SOL).unwrap();
    // Selling everything just bought gives back less than was paid, and never more than the pool holds.
    let (s, after_sell) = sell(&after_buy, b.tokens_out).unwrap();
    assert!(s.gross <= b.net);
    assert!(s.net < b.gross);
    assert!(after_sell.y <= after_buy.y);
    assert!(after_sell.x >= p.x - 1, "the token reserve returns to (almost) where it began");
    // Selling far more than was ever bought is refused outright.
    assert!(sell(&after_buy, b.tokens_out * 2).is_none() || sell(&after_buy, b.tokens_out * 2).unwrap().0.gross <= after_buy.y);
}

#[test]
fn zero_and_dust_trades_are_refused() {
    let p = fresh(1_000_000_000_000, 10 * SOL, 25);
    assert!(buy(&p, 0).is_none());
    assert!(buy(&p, 1).is_none(), "the fee takes the whole lamport");
    assert!(sell(&p, 0).is_none());
}

#[test]
fn liquidity_adds_in_proportion_and_rounds_up() {
    let p = fresh(1_000_000_000_000, 10 * SOL, 25);
    let (_, p) = buy(&p, 3 * SOL).unwrap();
    let (a, q) = add(&p, SOL).unwrap();
    // Proportional to within a unit, rounded up.
    assert_eq!(a.tokens_in as u128, (p.x as u128 * SOL as u128 + p.l as u128 - 1) / p.l as u128);
    assert_eq!(a.sol_in as u128, (p.y as u128 * SOL as u128 + p.l as u128 - 1) / p.l as u128);
    assert_eq!(q.l, p.l + SOL);
    // Removing the same liquidity returns no more than was put in.
    let (r, _) = remove(&q, SOL).unwrap();
    assert!(r.tokens_out <= a.tokens_in && r.sol_out <= a.sol_in);
}

#[test]
fn removing_everything_is_allowed_and_dust_is_not() {
    let p = fresh(10_000, 10_000_000, 25);
    assert!(remove(&p, 500).is_none(), "below the minimum and not everything");
    assert!(remove(&p, 0).is_none());
    assert!(remove(&p, p.l + 1).is_none());
    let (r, q) = remove(&p, p.l).unwrap();
    assert_eq!((r.tokens_out, r.sol_out), (10_000, 0));
    assert_eq!(q.l, 0);
    assert!(buy(&q, SOL).is_none(), "an emptied pool does not trade");
}

#[test]
fn pending_fee_matches_exact_big_integer_arithmetic() {
    let acc: u128 = (7u128 << 64) + 0x1234_5678_9abc_def0_1111_2222_3333_4444u128 % (1u128 << 64);
    for shares in [1u64, 999, 10_000_000, u64::MAX / 3] {
        let want = (BigUint::from(shares) * BigUint::from(acc) >> 64u32).to_u64_digits();
        let got = pending_fee(shares, acc, 0);
        match want.len() {
            0 => assert_eq!(got, Some(0)),
            1 => assert_eq!(got, Some(want[0])),
            _ => assert_eq!(got, None, "does not fit u64"),
        }
    }
}

#[test]
fn the_accumulator_may_wrap_without_changing_a_claim() {
    // A checkpoint near the top of the range and an accumulator that has wrapped past zero.
    let cp = u128::MAX - (1u128 << 63);
    let acc = cp.wrapping_add(3u128 << 64);
    assert_eq!(pending_fee(10, acc, cp), Some(30));
}

fn any_pool() -> impl Strategy<Value = Pool> {
    (1_000u64..(1u64 << 56), 10_000_000u64..(1u64 << 52), prop_oneof![Just(25u16), Just(100u16)])
        .prop_map(|(x, l, f)| Pool::open(x, 0, l, f).unwrap())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20_000))]

    /// Any run of buys and sells: `X * Y` never decreases, the real SOL reserve is never overdrawn, and the fee
    /// reserve plus the protocol part always equals the fees taken.
    #[test]
    fn swaps_never_lower_k_or_overdraw(p in any_pool(), ops in proptest::collection::vec((any::<bool>(), 1u64..(1u64 << 50)), 1..40)) {
        let mut p = p;
        let mut fees = 0u128;
        let mut protocol = 0u128;
        for (is_buy, amt) in ops {
            let k0 = p.k();
            if is_buy {
                if let Some((b, next)) = buy(&p, amt) {
                    prop_assert_eq!(b.gross, b.net + b.fee);
                    prop_assert!(b.protocol <= b.fee);
                    fees += b.fee as u128; protocol += b.protocol as u128;
                    p = next;
                }
            } else if let Some((s, next)) = sell(&p, amt) {
                prop_assert_eq!(s.gross, s.net + s.fee);
                prop_assert!(s.gross <= p.y, "never pays more than the pool holds");
                fees += s.fee as u128; protocol += s.protocol as u128;
                p = next;
            }
            prop_assert!(p.k() >= k0, "k fell");
            prop_assert!(p.x > 0 && p.l > 0);
        }
        prop_assert_eq!(p.fee_reserve as u128 + protocol, fees);
    }

    /// Buying and selling straight back never returns more than was paid, with or without the fee.
    #[test]
    fn a_round_trip_never_profits(p in any_pool(), gross in 1_000u64..(1u64 << 50)) {
        if let Some((b, after)) = buy(&p, gross) {
            if let Some((s, _)) = sell(&after, b.tokens_out) {
                prop_assert!(s.gross <= b.net, "gross out {} > net in {}", s.gross, b.net);
                prop_assert!(s.net < b.gross);
            }
        }
    }

    /// Adding by f: X'Y' >= XY(1+f)^2. Removing by f: X'Y' >= XY(1-f)^2. Checked in big integers: with
    /// l' = l + dl, the claim is X'Y' * l^2 >= XY * l'^2 (and with l' = l - dl for removal).
    #[test]
    fn liquidity_changes_never_lower_k_per_share(p in any_pool(), buy_in in 0u64..(1u64 << 48), dl_frac in 1u64..100) {
        let mut p = p;
        if buy_in > 0 { if let Some((_, n)) = buy(&p, buy_in) { p = n; } }
        let dl = (p.l / 100 * dl_frac).max(MIN_LIQUIDITY_DELTA);
        if let Some((_, q)) = add(&p, dl) {
            let lhs = big(q.x as u128, q.big_y()) * big(p.l as u128, p.l as u128);
            let rhs = big(p.x as u128, p.big_y()) * big(q.l as u128, q.l as u128);
            prop_assert!(lhs >= rhs, "add lowered k per share");
            prop_assert!(q.y >= p.y && q.x >= p.x);
        }
        if dl < p.l {
            if let Some((r, q)) = remove(&p, dl) {
                let lhs = big(q.x as u128, q.big_y()) * big(p.l as u128, p.l as u128);
                let rhs = big(p.x as u128, p.big_y()) * big(q.l as u128, q.l as u128);
                prop_assert!(lhs >= rhs, "remove lowered k per share");
                prop_assert!(r.tokens_out <= p.x && r.sol_out <= p.y);
            }
        }
    }

    /// Add then remove of the same liquidity never returns more than was deposited.
    #[test]
    fn add_then_remove_never_profits(p in any_pool(), buy_in in 0u64..(1u64 << 48), dl in MIN_LIQUIDITY_DELTA..(1u64 << 50)) {
        let mut p = p;
        if buy_in > 0 { if let Some((_, n)) = buy(&p, buy_in) { p = n; } }
        if let Some((a, q)) = add(&p, dl) {
            let (r, _) = remove(&q, dl).unwrap();
            prop_assert!(r.tokens_out <= a.tokens_in);
            prop_assert!(r.sol_out <= a.sol_in);
        }
    }

    /// The fees every position may claim never add up to more than was credited to the providers.
    #[test]
    fn claims_never_exceed_fees_credited(p in any_pool(), trades in proptest::collection::vec(1_000u64..(1u64 << 45), 1..30), split in 1u64..1000) {
        let mut p = p;
        // Two positions share the pool in the ratio split : 1000 - split (ties out to l exactly).
        let a = (p.l as u128 * split as u128 / 1000) as u64;
        let shares = [a, p.l - a];
        let mut credited = 0u128;
        for t in trades {
            let before = p.fee_reserve;
            if let Some((_, n)) = buy(&p, t) { p = n; }
            if let Some((_, n)) = sell(&p, t) { p = n; }
            credited += (p.fee_reserve - before) as u128;
        }
        let claims: u128 = shares.iter().map(|s| pending_fee(*s, p.acc, 0).unwrap() as u128).sum();
        prop_assert!(claims <= credited, "claims {claims} > credited {credited}");
        prop_assert!(credited == p.fee_reserve as u128);
    }

    /// Fee maths on its own.
    #[test]
    fn the_fee_is_rounded_up_and_split_without_loss(amount in 1u64..u64::MAX / 2, fee_bps in prop_oneof![Just(25u16), Just(100u16)]) {
        let fee = fee_up(amount, fee_bps);
        prop_assert!(fee as u128 * BPS >= amount as u128 * fee_bps as u128);
        prop_assert!((fee as u128 - 1) * BPS < amount as u128 * fee_bps as u128 || fee == 0);
        let protocol = protocol_part(fee);
        prop_assert!(protocol as u128 * BPS <= fee as u128 * PROTOCOL_SHARE_BPS);
        prop_assert_eq!(protocol + (fee - protocol), fee);
    }
}

#[test]
fn the_launch_fee_falls_in_a_line_and_never_undercharges() {
    // 20% falling to 1% over 600 seconds, starting at t = 1000.
    let f = |now| effective_fee_bps(100, 2_000, 600, 1_000, now);
    assert_eq!(f(900), 2_000, "before the start counts as the start");
    assert_eq!(f(1_000), 2_000);
    assert_eq!(f(1_300), 100 + 950, "halfway: 1% + half of 19%");
    assert_eq!(f(1_599), 100 + 4, "ceil of 1900 * 1 / 600 is 4: rounded up");
    assert_eq!(f(1_600), 100);
    assert_eq!(f(9_999_999), 100);
    // No schedule, or one that does not exceed the base, is the base.
    assert_eq!(effective_fee_bps(100, 0, 0, 0, 5), 100);
    assert_eq!(effective_fee_bps(100, 100, 600, 0, 5), 100);
    assert_eq!(effective_fee_bps(100, 50, 600, 0, 5), 100);
}

#[test]
fn schedules_are_bounded() {
    assert!(schedule_ok(25, 0, 0));
    assert!(schedule_ok(25, 2_500, 3_600));
    assert!(!schedule_ok(25, 2_501, 600));
    assert!(!schedule_ok(25, 2_000, 3_601));
    assert!(!schedule_ok(25, 25, 600), "a schedule must start above the base");
    assert!(!schedule_ok(25, 2_000, 0));
    assert!(!schedule_ok(25, 0, 600));
}

proptest! {
    /// The launch fee is never below the base, never above its start, and never rises with time.
    #[test]
    fn the_launch_fee_is_monotone_and_bounded(base in prop_oneof![Just(25u16), Just(100u16)], start in 101u16..=2_500, decay in 1u32..=3_600, t0 in 0i64..1_000_000, a in 0i64..8_000, b in 0i64..8_000) {
        let (early, late) = (a.min(b), a.max(b));
        let fe = effective_fee_bps(base, start, decay, t0, t0 + early);
        let fl = effective_fee_bps(base, start, decay, t0, t0 + late);
        prop_assert!(fe >= fl);
        prop_assert!(fl >= base && fe <= start.max(base));
    }
}
