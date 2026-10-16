//! Prints test vectors for the web code's copy of the curve maths: the same inputs run through the Rust curve-math and
//! Meteora argument maths, so the TypeScript can be checked against the code that actually runs on chain.
//!
//!   cargo run --example vectors > ../../../website/src/scripts/__fixtures__/curveVectors.json
use aretia_curve_it::{ata, curve_pda, meteora_pool, migrator_pda, pda, pool_args, sol_vault_pda, Address, METEORA, TOKEN_2022, WSOL};
use curve_math::{buy, derive, sell, Curve};

fn st(c: &Curve) -> String {
    format!("{{\"vSol\":\"{}\",\"vTok\":\"{}\",\"realSol\":\"{}\",\"realTok\":\"{}\"}}", c.v_sol, c.v_tok, c.real_sol, c.real_tok)
}

fn main() {
    const SOL: u64 = 1_000_000_000;
    let min = 100_000_000;
    let cases: [(u64, u64, u16); 6] = [
        (1_000_000_000_000_000, 85 * SOL, 100),
        (1_000_000_000_000_000, 10 * SOL, 100),
        (777_000_000_000, 3 * SOL, 29),
        (10u64.pow(18), 500 * SOL, 0),
        (123_456_789_012_345, SOL / 10, 250),
        (4_000_000_000_000_000_000, 1_000_000 * SOL, 100),
    ];
    let mut derives = vec![];
    let mut runs = vec![];
    let mut seed: u64 = 0x1234_5678_9ABC_DEF1;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for (total, target, fee) in cases {
        let d = derive(total, target, min);
        derives.push(match &d {
            Some(d) => format!("{{\"total\":\"{total}\",\"target\":\"{target}\",\"out\":{{\"vSol0\":\"{}\",\"vTok0\":\"{}\",\"curveTokens\":\"{}\",\"lpTokens\":\"{}\"}}}}", d.v_sol0, d.v_tok0, d.curve_tokens, d.lp_tokens),
            None => format!("{{\"total\":\"{total}\",\"target\":\"{target}\",\"out\":null}}"),
        });
        let Some(d) = d else { continue };
        let mut c = d.start();
        let mut steps = vec![];
        for _ in 0..40 {
            let sell_now = c.real_tok < d.curve_tokens && next() % 3 == 0;
            if sell_now {
                let sold = d.curve_tokens - c.real_tok;
                let amount = (sold as u128 * (1 + next() % 100) as u128 / 100).max(1) as u64;
                match sell(&c, d.curve_tokens, amount, fee) {
                    Some((s, n)) => {
                        steps.push(format!("{{\"op\":\"sell\",\"amount\":\"{amount}\",\"result\":{{\"gross\":\"{}\",\"fee\":\"{}\",\"net\":\"{}\"}},\"state\":{}}}", s.gross, s.fee, s.net, st(&n)));
                        c = n;
                    }
                    None => steps.push(format!("{{\"op\":\"sell\",\"amount\":\"{amount}\",\"result\":null,\"state\":{}}}", st(&c))),
                }
            } else {
                let offer = 1 + next() % (target / 3).max(2);
                match buy(&c, offer, fee) {
                    Some((b, n)) => {
                        steps.push(format!("{{\"op\":\"buy\",\"amount\":\"{offer}\",\"result\":{{\"gross\":\"{}\",\"fee\":\"{}\",\"net\":\"{}\",\"tokensOut\":\"{}\",\"soldOut\":{}}},\"state\":{}}}", b.gross, b.fee, b.net, b.tokens_out, b.sold_out, st(&n)));
                        c = n;
                    }
                    None => steps.push(format!("{{\"op\":\"buy\",\"amount\":\"{offer}\",\"result\":null,\"state\":{}}}", st(&c))),
                }
            }
            if c.real_tok == 0 {
                break;
            }
        }
        // And one buy of everything, to cover the cut-down path.
        let d2 = derive(total, target, min).unwrap();
        let (b, end) = buy(&d2.start(), u64::MAX / 4, fee).unwrap();
        steps.push(format!("{{\"op\":\"buyAllFresh\",\"amount\":\"{}\",\"result\":{{\"gross\":\"{}\",\"fee\":\"{}\",\"net\":\"{}\",\"tokensOut\":\"{}\",\"soldOut\":{}}},\"state\":{}}}", u64::MAX / 4, b.gross, b.fee, b.net, b.tokens_out, b.sold_out, st(&end)));
        runs.push(format!("{{\"total\":\"{total}\",\"target\":\"{target}\",\"fee\":{fee},\"steps\":[{}]}}", steps.join(",")));
    }
    let mut pools = vec![];
    for (sol, tok) in [(85 * SOL, 206_896_551_724_137u64), (10 * SOL, 100_000_000_000_000), (SOL / 10, 7_777_777_777), (1_000 * SOL, 3_000_000_000_000_000_000), (3 * SOL, 1_234_567)] {
        let (l, p) = pool_args(sol, tok);
        pools.push(format!("{{\"sol\":\"{sol}\",\"tokens\":\"{tok}\",\"liquidity\":\"{l}\",\"sqrtPrice\":\"{p}\"}}"));
    }
    // Addresses the program and Meteora derive, for two fixed mints and a fixed position key.
    let mut addrs = vec![];
    for (mint, nft) in [("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG", "3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg"), ("4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX", "9HVuUHU4mm6PYZFRnY7KzuGsHVSZ8QUVavarJLpJt5f4")] {
        let mint = Address::from_str_const(mint);
        let nft = Address::from_str_const(nft);
        let curve = curve_pda(&mint);
        let migrator = migrator_pda(&curve);
        let pool = meteora_pool(&mint);
        addrs.push(format!(
            "{{\"mint\":\"{mint}\",\"nft\":\"{nft}\",\"curve\":\"{curve}\",\"solVault\":\"{}\",\"tokenVault\":\"{}\",\"migrator\":\"{migrator}\",\"pool\":\"{pool}\",\"position\":\"{}\",\"nftAccount\":\"{}\",\"vaultA\":\"{}\",\"vaultB\":\"{}\"}}",
            sol_vault_pda(&curve),
            ata(&curve, &mint, &TOKEN_2022),
            pda(&[b"position", nft.as_ref()], &METEORA),
            pda(&[b"position_nft_account", nft.as_ref()], &METEORA),
            pda(&[b"token_vault", mint.as_ref(), pool.as_ref()], &METEORA),
            pda(&[b"token_vault", WSOL.as_ref(), pool.as_ref()], &METEORA),
        ));
    }
    println!("{{\"derive\":[{}],\"runs\":[{}],\"pool\":[{}],\"addresses\":[{}]}}", derives.join(","), runs.join(","), pools.join(","), addrs.join(","));
}
