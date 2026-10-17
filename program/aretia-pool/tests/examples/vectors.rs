//! Prints test vectors for the web code's copy of the pool maths and addresses: the same inputs run through the Rust pool-math
//! and the program's address derivation, so the TypeScript can be checked against the code that actually runs on chain.
//!
//!   cargo run --example vectors > ../../../website/src/scripts/__fixtures__/aretiaPoolVectors.json
use aretia_pool_it::{ata, pool_pda, position_pda, sol_vault_pda, Address, TOKEN_2022};
use pool_math::{add, buy, effective_fee_bps, pending_fee, remove, sell, Pool};

fn st(p: &Pool) -> String {
    format!("{{\"x\":\"{}\",\"y\":\"{}\",\"l\":\"{}\",\"acc\":\"{}\",\"feeReserve\":\"{}\"}}", p.x, p.y, p.l, p.acc, p.fee_reserve)
}

fn main() {
    const SOL: u64 = 1_000_000_000;
    let cases: [(u64, u64, u64, u16); 6] = [
        (600_000_000_000_000, 0, 10 * SOL, 25),
        (600_000_000_000_000, 0, 10 * SOL, 100),
        (1_000_000, 0, 10_000_000, 100),
        (123_456_789_012_345, 3 * SOL, 77 * SOL, 25),
        (4_000_000_000_000_000_000 / 4, 0, 1_000_000 * SOL, 100),
        (5_000, 50_000_000, 10_000_000, 25),
    ];
    let mut seed: u64 = 0x2468_ACE0_1357_9BDF;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut runs = vec![];
    for (x0, y0, l0, fee) in cases {
        let mut p = Pool::open(x0, y0, l0, fee).expect("openable");
        let mut steps = vec![];
        for _ in 0..60 {
            match next() % 5 {
                0 | 1 => {
                    let amt = 1 + next() % (p.big_y().min(u64::MAX as u128 / 4) as u64 / 2 + 1);
                    match buy(&p, amt) {
                        Some((b, n)) => {
                            steps.push(format!("{{\"op\":\"buy\",\"amount\":\"{amt}\",\"result\":{{\"gross\":\"{}\",\"fee\":\"{}\",\"protocol\":\"{}\",\"net\":\"{}\",\"tokensOut\":\"{}\"}},\"state\":{}}}", b.gross, b.fee, b.protocol, b.net, b.tokens_out, st(&n)));
                            p = n;
                        }
                        None => steps.push(format!("{{\"op\":\"buy\",\"amount\":\"{amt}\",\"result\":null,\"state\":{}}}", st(&p))),
                    }
                }
                2 => {
                    let amt = 1 + next() % (p.x / 3 + 1);
                    match sell(&p, amt) {
                        Some((s, n)) => {
                            steps.push(format!("{{\"op\":\"sell\",\"amount\":\"{amt}\",\"result\":{{\"gross\":\"{}\",\"fee\":\"{}\",\"protocol\":\"{}\",\"net\":\"{}\"}},\"state\":{}}}", s.gross, s.fee, s.protocol, s.net, st(&n)));
                            p = n;
                        }
                        None => steps.push(format!("{{\"op\":\"sell\",\"amount\":\"{amt}\",\"result\":null,\"state\":{}}}", st(&p))),
                    }
                }
                3 => {
                    let dl = 1 + next() % (p.l / 5 + 1);
                    match add(&p, dl) {
                        Some((a, n)) => {
                            steps.push(format!("{{\"op\":\"add\",\"amount\":\"{dl}\",\"result\":{{\"tokensIn\":\"{}\",\"solIn\":\"{}\"}},\"state\":{}}}", a.tokens_in, a.sol_in, st(&n)));
                            p = n;
                        }
                        None => steps.push(format!("{{\"op\":\"add\",\"amount\":\"{dl}\",\"result\":null,\"state\":{}}}", st(&p))),
                    }
                }
                _ => {
                    let dl = 1 + next() % (p.l / 4 + 1);
                    match remove(&p, dl) {
                        Some((r, n)) => {
                            steps.push(format!("{{\"op\":\"remove\",\"amount\":\"{dl}\",\"result\":{{\"tokensOut\":\"{}\",\"solOut\":\"{}\"}},\"state\":{}}}", r.tokens_out, r.sol_out, st(&n)));
                            p = n;
                        }
                        None => steps.push(format!("{{\"op\":\"remove\",\"amount\":\"{dl}\",\"result\":null,\"state\":{}}}", st(&p))),
                    }
                }
            }
        }
        runs.push(format!("{{\"x0\":\"{x0}\",\"y0\":\"{y0}\",\"l0\":\"{l0}\",\"fee\":{fee},\"steps\":[{}]}}", steps.join(",")));
    }
    // Fee claims, including a checkpoint behind a wrapped accumulator.
    let mut claims = vec![];
    for (shares, acc, cp) in [(10_000_000u64, (7u128 << 64) + 12345, 0u128), (u64::MAX / 3, 3u128 << 64, 1u128 << 63), (10, 3u128 << 64, u128::MAX - (1u128 << 63)), (1, 0, 0)] {
        let r = pending_fee(shares, acc, cp);
        claims.push(format!("{{\"shares\":\"{shares}\",\"acc\":\"{acc}\",\"checkpoint\":\"{cp}\",\"out\":{}}}", r.map(|v| format!("\"{v}\"")).unwrap_or("null".into())));
    }
    // The launch fee schedule at many moments.
    let mut schedule = vec![];
    for (base, start, decay, t0) in [(100u16, 2_000u16, 600u32, 1_000i64), (25, 1_000, 300, 0), (25, 2_500, 3_600, 1_700_000_000), (100, 0, 0, 5), (100, 100, 600, 5)] {
        for dt in [-50i64, 0, 1, 59, 150, 299, 300, 301, 599, 600, 3_599, 3_600, 100_000] {
            schedule.push(format!("{{\"base\":{base},\"start\":{start},\"decay\":{decay},\"t0\":\"{t0}\",\"now\":\"{}\",\"fee\":{}}}", t0 + dt, effective_fee_bps(base, start, decay, t0, t0 + dt)));
        }
    }
    // Addresses the program derives, for two fixed mints and owners.
    let mut addrs = vec![];
    for (mint, owner) in [("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG", "4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX"), ("4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX", "3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg")] {
        let mint = Address::from_str_const(mint);
        let owner = Address::from_str_const(owner);
        let pool = pool_pda(&mint);
        addrs.push(format!(
            "{{\"mint\":\"{mint}\",\"owner\":\"{owner}\",\"pool\":\"{pool}\",\"solVault\":\"{}\",\"tokenVault\":\"{}\",\"position\":\"{}\"}}",
            sol_vault_pda(&pool),
            ata(&pool, &mint, &TOKEN_2022),
            position_pda(&pool, &owner),
        ));
    }
    println!("{{\"program\":\"{}\",\"runs\":[{}],\"claims\":[{}],\"schedule\":[{}],\"addresses\":[{}]}}", aretia_pool_it::PROGRAM_ID, runs.join(","), claims.join(","), schedule.join(","), addrs.join(","));
}
