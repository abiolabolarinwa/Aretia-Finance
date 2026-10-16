use super::*;
use proptest::prelude::*;

const SOL: u64 = 1_000_000_000;
const MIN_TARGET: u64 = 100_000_000; // 0.1 SOL, the devnet floor

fn k(c: &Curve) -> u128 {
    c.v_sol as u128 * c.v_tok as u128
}

fn start(total: u64, target: u64) -> (Derived, Curve) {
    let d = derive(total, target, MIN_TARGET).expect("derivable");
    (d, d.start())
}

#[test]
fn derive_splits_like_the_reference_curve() {
    // 1,000,000,000 tokens (6 decimals) and an 85 SOL target.
    let d = derive(1_000_000_000_000_000, 85 * SOL, SOL).unwrap();
    assert_eq!(d.v_sol0, 30 * SOL);
    // lp : curve is 30 : 115, about 20.69% / 79.31%.
    let share = d.lp_tokens as f64 / 1_000_000_000_000_000f64;
    assert!((share - 0.2069).abs() < 0.0005, "lp share {share}");
    assert_eq!(d.lp_tokens + d.curve_tokens, 1_000_000_000_000_000);
}

#[test]
fn derive_refuses_out_of_range() {
    assert!(derive(0, SOL, MIN_TARGET).is_none());
    assert!(derive(1, SOL, MIN_TARGET).is_none(), "one raw token cannot be split");
    assert!(derive(1_000_000, MIN_TARGET - 1, MIN_TARGET).is_none());
    assert!(derive(1_000_000, MAX_TARGET_LAMPORTS + 1, MIN_TARGET).is_none());
    assert!(derive(MAX_TOTAL_TOKENS + 1, SOL, MIN_TARGET).is_none());
}

#[test]
fn the_pool_opens_where_the_curve_ended() {
    // Buy the whole curve, then compare the price the pool would open at (SOL raised / lp tokens) with the last
    // marginal price on the curve (v_sol / v_tok). They must agree to a tiny relative error.
    for (total, target) in [(1_000_000_000_000_000u64, 85 * SOL), (777_000_000_000, 3 * SOL), (10u64.pow(18), 500 * SOL)] {
        let (d, c) = start(total, target);
        let (b, end) = buy(&c, u64::MAX / 4, 0).unwrap();
        assert!(b.sold_out);
        let pool_price = end.real_sol as f64 / d.lp_tokens as f64;
        let curve_price = end.v_sol as f64 / end.v_tok as f64;
        assert!(((pool_price - curve_price) / curve_price).abs() < 1e-6, "pool {pool_price} curve {curve_price}");
        // The raise lands on the target to within rounding.
        assert!(end.real_sol.abs_diff(target) <= 2, "raised {} target {}", end.real_sol, target);
    }
}

#[test]
fn buying_everything_sets_sold_out_and_exact_tokens() {
    let (d, c) = start(1_000_000_000_000_000, 85 * SOL);
    let (b, end) = buy(&c, 1_000 * SOL, 100).unwrap();
    assert!(b.sold_out);
    assert_eq!(b.tokens_out, d.curve_tokens);
    assert_eq!(end.real_tok, 0);
    assert!(b.gross < 1_000 * SOL, "only what was needed is charged");
    assert_eq!(b.gross, b.fee + b.net);
    assert!(buy(&end, SOL, 100).is_none(), "a closed curve sells nothing");
}

#[test]
fn zero_and_dust_are_refused() {
    let (_, c) = start(1_000_000_000_000_000, 85 * SOL);
    assert!(buy(&c, 0, 100).is_none());
    assert!(sell(&c, c.real_tok, 0, 100).is_none());
    assert!(buy(&c, 5, 10_000).is_none());
    assert!(buy(&c, 1, 100).is_none(), "one lamport buys no token");
}

#[test]
fn a_sell_beyond_what_was_sold_is_refused() {
    let (d, c) = start(1_000_000_000_000_000, 85 * SOL);
    assert!(sell(&c, d.curve_tokens, 1, 100).is_none());
}

#[test]
fn migration_dust_rule() {
    assert!(migration_consumed_enough(1_000_000, 1_000));
    assert!(!migration_consumed_enough(1_000_000, 1_001));
    assert!(migration_consumed_enough(0, 0));
}

#[derive(Clone, Debug)]
enum Op {
    Buy { actor: usize, lamports: u64 },
    /// Sell this many basis points of what the actor holds.
    Sell { actor: usize, bps: u16 },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0usize..4, 1u64..400 * SOL).prop_map(|(actor, lamports)| Op::Buy { actor, lamports }),
        (0usize..4, 1u16..=10_000).prop_map(|(actor, bps)| Op::Sell { actor, bps }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2_000, ..ProptestConfig::default() })]

    /// Whatever anyone does, the vault stays solvent: every sell of tokens the curve handed out is payable, the
    /// two reserve invariants hold, k never falls, and what leaves the vault never exceeds what entered it.
    #[test]
    fn the_vault_cannot_be_drained(
        total in 1_000_000u64..(1u64 << 62),
        target in MIN_TARGET..2_000 * SOL,
        fee_bps in prop_oneof![Just(0u16), Just(29u16), Just(100u16), 0u16..2_000],
        ops in proptest::collection::vec(op(), 1..60),
    ) {
        prop_assume!(derive(total, target, MIN_TARGET).is_some());
        let (d, mut c) = start(total, target);
        let k0 = k(&c);
        let mut held = [0u64; 4];
        let mut vault_in: u128 = 0;
        let mut vault_out: u128 = 0;
        for o in ops {
            match o {
                Op::Buy { actor, lamports } => {
                    if let Some((b, next)) = buy(&c, lamports, fee_bps) {
                        // The buyer never pays more than offered nor less than the fee rate asks.
                        prop_assert!(b.gross <= lamports);
                        prop_assert!(b.fee as u128 * BPS >= b.gross as u128 * fee_bps as u128);
                        prop_assert_eq!(b.gross, b.fee + b.net);
                        prop_assert!(k(&next) >= k(&c), "k fell on a buy");
                        vault_in += b.net as u128;
                        held[actor] += b.tokens_out;
                        c = next;
                    }
                }
                Op::Sell { actor, bps } => {
                    let amount = (held[actor] as u128 * bps as u128 / BPS) as u64;
                    if amount == 0 { continue; }
                    // A holder of curve tokens must always be able to sell them: never None for solvency.
                    let r = sell(&c, d.curve_tokens, amount, fee_bps);
                    prop_assert!(r.is_some(), "a legitimate sell was refused: {:?} amount {}", c, amount);
                    let (s, next) = r.unwrap();
                    prop_assert!(k(&next) >= k(&c), "k fell on a sell");
                    prop_assert!(s.gross <= c.real_sol);
                    prop_assert_eq!(s.gross, s.fee + s.net);
                    prop_assert!(s.fee as u128 * BPS >= s.gross as u128 * fee_bps as u128);
                    vault_out += s.gross as u128;
                    held[actor] -= amount;
                    c = next;
                }
            }
            prop_assert_eq!(c.v_sol - c.real_sol, d.v_sol0, "v_sol - real_sol drifted");
            prop_assert!(k(&c) >= k0);
            prop_assert_eq!(c.real_sol as u128, vault_in - vault_out);
            prop_assert_eq!(c.real_tok as u128 + held.iter().map(|h| *h as u128).sum::<u128>(), d.curve_tokens as u128);
        }
        // Everyone sells everything back: the vault still pays every one of them, and is left with a
        // non-negative remainder (dust that rounding kept on the vault's side).
        for actor in 0..4 {
            let amount = held[actor];
            if amount == 0 { continue; }
            let r = sell(&c, d.curve_tokens, amount, fee_bps);
            prop_assert!(r.is_some(), "final unwind refused: {:?} amount {}", c, amount);
            c = r.unwrap().1;
            held[actor] = 0;
        }
        prop_assert_eq!(c.real_tok, d.curve_tokens);
        prop_assert!(c.v_sol >= d.v_sol0);
    }

    /// A round trip, with no fee, in the same state, never returns more SOL than went in.
    #[test]
    fn a_round_trip_never_profits(
        total in 1_000_000u64..(1u64 << 62),
        target in MIN_TARGET..2_000 * SOL,
        warmup in proptest::collection::vec(1u64..300 * SOL, 0..8),
        lamports in 1u64..300 * SOL,
        fee_bps in prop_oneof![Just(0u16), Just(100u16)],
    ) {
        prop_assume!(derive(total, target, MIN_TARGET).is_some());
        let (d, mut c) = start(total, target);
        for w in warmup {
            if let Some((_, next)) = buy(&c, w, fee_bps) { c = next; }
        }
        if let Some((b, mid)) = buy(&c, lamports, fee_bps) {
            if let Some((s, _)) = sell(&mid, d.curve_tokens, b.tokens_out, fee_bps) {
                prop_assert!(s.net <= b.gross, "round trip gained: paid {} got {}", b.gross, s.net);
                prop_assert!(s.gross <= b.net, "the vault paid out more than it took for the same tokens");
            }
        }
    }

    /// More SOL never buys fewer tokens.
    #[test]
    fn a_bigger_buy_never_gets_less(
        total in 1_000_000u64..(1u64 << 62),
        target in MIN_TARGET..2_000 * SOL,
        a in 1u64..500 * SOL,
        extra in 0u64..500 * SOL,
        fee_bps in 0u16..1_000,
    ) {
        prop_assume!(derive(total, target, MIN_TARGET).is_some());
        let (_, c) = start(total, target);
        if let (Some((small, _)), Some((big, _))) = (buy(&c, a, fee_bps), buy(&c, a + extra, fee_bps)) {
            prop_assert!(big.tokens_out >= small.tokens_out);
        }
    }

    /// Derived values always satisfy the relationships the program relies on.
    #[test]
    fn derive_is_consistent(total in 2u64..MAX_TOTAL_TOKENS, target in MIN_TARGET..MAX_TARGET_LAMPORTS) {
        if let Some(d) = derive(total, target, MIN_TARGET) {
            prop_assert_eq!(d.curve_tokens as u128 + d.lp_tokens as u128, total as u128);
            prop_assert!(d.v_tok0 > d.curve_tokens);
            prop_assert!(d.curve_tokens > 0 && d.lp_tokens > 0);
        }
    }
}
