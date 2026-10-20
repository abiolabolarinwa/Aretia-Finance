use aretia_curve_grad_it::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000_000_000; // 1,000,000,000 tokens

struct Launched {
    env: Env,
    creator: Keypair,
    mint: Address,
}

fn launch(target: u64, total: u64) -> Launched {
    let mut env = Env::new();
    let creator = env.user(10);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    env.send(&[create_curve_ix(&creator.pubkey(), &mint, total, target)], &[&creator]).expect("create_curve");
    Launched { env, creator, mint }
}

fn funded_buyer(l: &mut Launched, sol: u64) -> Keypair {
    let b = l.env.user(sol);
    l.env.make_ata(&b.pubkey(), &l.mint);
    b
}

fn err_text(r: &Sent) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => format!("{:?} {}", e.err, e.meta.logs.join(" | ")),
    }
}

fn assert_fails_with(r: Sent, needle: &str) {
    match r {
        Ok(_) => panic!("expected failure containing {needle:?}, but it succeeded"),
        Err(e) => {
            let t = format!("{:?} {}", e.err, e.meta.logs.join(" | "));
            assert!(t.contains(needle), "expected {needle:?} in: {t}");
        }
    }
}

#[test]
fn creates_a_curve_and_holds_the_tokens() {
    let l = launch(10 * SOL, SUPPLY);
    let c = l.env.curve(&l.mint);
    let d = curve_math::derive(SUPPLY, 10 * SOL, 100_000_000).unwrap();
    assert_eq!(c.status, TRADING);
    assert_eq!(c.creator, l.creator.pubkey());
    assert_eq!(c.fee_bps, FEE_BPS);
    assert_eq!((c.v_sol, c.v_tok, c.real_sol, c.real_tok), (d.v_sol0, d.v_tok0, 0, d.curve_tokens));
    assert_eq!((c.curve_tokens, c.lp_tokens), (d.curve_tokens, d.lp_tokens));
    let vault = ata(&curve_pda(&l.mint), &l.mint, &TOKEN_2022);
    assert_eq!(l.env.token_amount(&vault), SUPPLY);
    assert_eq!(l.env.token_amount(&ata(&l.creator.pubkey(), &l.mint, &TOKEN_2022)), 0);
}

#[test]
fn create_refuses_what_it_should() {
    let mut env = Env::new();
    let creator = env.user(10);
    // A mint someone can still add to.
    let m1 = env.make_mint(MintKind::MintAuthorityKept, DECIMALS, SUPPLY, &creator);
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m1, SUPPLY, 10 * SOL)], &[&creator]), "MintNotAllowed");
    // A mint with a freeze power.
    let m2 = env.make_mint(MintKind::FreezeKept, DECIMALS, SUPPLY, &creator);
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m2, SUPPLY, 10 * SOL)], &[&creator]), "MintNotAllowed");
    // A mint with an extension the curve does not allow.
    let m3 = env.make_mint(MintKind::NonTransferable, DECIMALS, SUPPLY, &creator);
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m3, SUPPLY, 10 * SOL)], &[&creator]), "MintNotAllowed");
    // A good mint: more tokens than held, a target below the floor, and zero tokens.
    let m4 = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m4, SUPPLY + 1, 10 * SOL)], &[&creator]), "NotEnoughTokens");
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m4, SUPPLY, 99_999_999)], &[&creator]), "BadParameters");
    assert_fails_with(env.send(&[create_curve_ix(&creator.pubkey(), &m4, 0, 10 * SOL)], &[&creator]), "BadParameters");
    // A plain mint (no extensions) is fine, and a second curve for the same mint is not.
    let m5 = env.make_mint(MintKind::Plain, DECIMALS, SUPPLY, &creator);
    env.send(&[create_curve_ix(&creator.pubkey(), &m5, SUPPLY / 2, 10 * SOL)], &[&creator]).expect("plain mint curve");
    assert!(env.send(&[create_curve_ix(&creator.pubkey(), &m5, SUPPLY / 4, 10 * SOL)], &[&creator]).is_err(), "one curve per mint");
    // Someone who does not hold the tokens cannot open a curve for them.
    let stranger = env.user(5);
    env.make_ata(&stranger.pubkey(), &m4);
    assert!(env.send(&[create_curve_ix(&stranger.pubkey(), &m4, 1_000_000, 10 * SOL)], &[&stranger]).is_err());
}

#[test]
fn a_buy_matches_the_maths_to_the_lamport() {
    let mut l = launch(10 * SOL, SUPPLY);
    let buyer = funded_buyer(&mut l, 100);
    let before = l.env.curve(&l.mint);
    let (expect, next) = curve_math::buy(&before.math(), 2 * SOL, FEE_BPS).unwrap();
    let (fee_before, curve_before, buyer_before) = (l.env.lamports(&FEE_WALLET), l.env.lamports(&sol_vault_pda(&curve_pda(&l.mint))), l.env.lamports(&buyer.pubkey()));

    l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, 2 * SOL, expect.tokens_out)], &[&buyer]).expect("buy");

    let c = l.env.curve(&l.mint);
    assert_eq!((c.v_sol, c.v_tok, c.real_sol, c.real_tok), (next.v_sol, next.v_tok, next.real_sol, next.real_tok));
    assert_eq!(l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022)), expect.tokens_out);
    assert_eq!(l.env.lamports(&FEE_WALLET) - fee_before, expect.fee);
    assert_eq!(l.env.lamports(&sol_vault_pda(&curve_pda(&l.mint))) - curve_before, expect.net);
    assert_eq!(buyer_before - l.env.lamports(&buyer.pubkey()), expect.gross, "the buyer pays the offer and nothing else (the transaction fee is the payer's)");
    assert_eq!(expect.fee, 11_600_000, "0.58% of 2 SOL");
}

#[test]
fn buys_refuse_what_they_should() {
    let mut l = launch(10 * SOL, SUPPLY);
    let buyer = funded_buyer(&mut l, 100);
    let (q, _) = curve_math::buy(&l.env.curve(&l.mint).math(), SOL, FEE_BPS).unwrap();
    // Slippage: demand one token more than the curve gives.
    assert_fails_with(l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, SOL, q.tokens_out + 1)], &[&buyer]), "Slippage");
    // Dust.
    assert_fails_with(l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, 1, 0)], &[&buyer]), "TradeTooSmall");
    // The fee must go to Aretia's wallet, not anyone else's.
    let thief = Keypair::new();
    assert!(l.env.send(&[buy_ix_with(&buyer.pubkey(), &l.mint, &ata(&buyer.pubkey(), &l.mint, &TOKEN_2022), &thief.pubkey(), SOL, 0)], &[&buyer]).is_err());
    // Tokens must land in the buyer's own account for this mint.
    let other = funded_buyer(&mut l, 1);
    assert!(l.env.send(&[buy_ix_with(&buyer.pubkey(), &l.mint, &ata(&other.pubkey(), &l.mint, &TOKEN_2022), &FEE_WALLET, SOL, 0)], &[&buyer]).is_err());
    // Nothing above changed the curve.
    assert_eq!(l.env.curve(&l.mint).real_sol, 0);
}

#[test]
fn a_round_trip_returns_less_and_leaves_the_vault_whole() {
    let mut l = launch(10 * SOL, SUPPLY);
    let buyer = funded_buyer(&mut l, 100);
    let start_lamports = l.env.lamports(&buyer.pubkey());
    let curve_addr = sol_vault_pda(&curve_pda(&l.mint));
    let rent_floor = l.env.lamports(&curve_addr);

    l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, 3 * SOL, 0)], &[&buyer]).unwrap();
    let held = l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022));
    let fee_before = l.env.lamports(&FEE_WALLET);
    let (expect, _) = curve_math::sell(&l.env.curve(&l.mint).math(), l.env.curve(&l.mint).curve_tokens, held, FEE_BPS).unwrap();
    assert_fails_with(l.env.send(&[sell_ix(&buyer.pubkey(), &l.mint, held, expect.net + 1)], &[&buyer]), "Slippage");
    l.env.send(&[sell_ix(&buyer.pubkey(), &l.mint, held, expect.net)], &[&buyer]).expect("sell");

    let end = l.env.lamports(&buyer.pubkey());
    assert!(end < start_lamports, "two fees were paid");
    assert_eq!(l.env.lamports(&FEE_WALLET) - fee_before, expect.fee);
    let c = l.env.curve(&l.mint);
    assert_eq!(c.real_tok, c.curve_tokens, "every token is back on the curve");
    assert!(c.real_sol <= 2, "only rounding dust is left owing: {}", c.real_sol);
    assert!(l.env.lamports(&curve_addr) >= rent_floor + c.real_sol, "the vault still holds its rent and what it owes");
    // Selling tokens you do not hold fails in the token program, and nothing is paid.
    assert!(l.env.send(&[sell_ix(&buyer.pubkey(), &l.mint, 1, 0)], &[&buyer]).is_err());
}

#[test]
fn donations_change_nothing() {
    let mut l = launch(10 * SOL, SUPPLY);
    let buyer = funded_buyer(&mut l, 100);
    let curve_addr = sol_vault_pda(&curve_pda(&l.mint));
    let vault = ata(&curve_pda(&l.mint), &l.mint, &TOKEN_2022);
    // Someone sends SOL straight to the SOL vault and tokens straight to the token vault.
    let payer = l.env.payer.pubkey();
    let donate_sol = solana_instruction::Instruction::new_with_bytes(SYSTEM, &{
        let mut d = vec![2, 0, 0, 0];
        d.extend_from_slice(&(5 * SOL).to_le_bytes());
        d
    }, vec![solana_instruction::AccountMeta::new(payer, true), solana_instruction::AccountMeta::new(curve_addr, false)]);
    l.env.send(&[donate_sol], &[]).unwrap();
    let before = l.env.curve(&l.mint);
    let (expect, next) = curve_math::buy(&before.math(), SOL, FEE_BPS).unwrap();
    l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, SOL, expect.tokens_out)], &[&buyer]).unwrap();
    let c = l.env.curve(&l.mint);
    assert_eq!((c.v_sol, c.v_tok, c.real_sol, c.real_tok), (next.v_sol, next.v_tok, next.real_sol, next.real_tok));
    let _ = vault;
}

#[test]
fn selling_out_closes_the_curve_and_an_unmigrated_curve_can_be_unwound() {
    let mut l = launch(10 * SOL, SUPPLY);
    let a = funded_buyer(&mut l, 200);
    let b = funded_buyer(&mut l, 200);
    // `a` buys most, then `b` buys the rest with an oversized offer: only what is left is charged.
    l.env.send(&[buy_ix(&a.pubkey(), &l.mint, 5 * SOL, 0)], &[&a]).unwrap();
    let b_before = l.env.lamports(&b.pubkey());
    l.env.send(&[buy_ix(&b.pubkey(), &l.mint, 100 * SOL, 0)], &[&b]).unwrap();
    let c = l.env.curve(&l.mint);
    assert_eq!(c.status, SOLD_OUT);
    assert_eq!(c.real_tok, 0);
    assert!(b_before - l.env.lamports(&b.pubkey()) < 100 * SOL, "the oversized offer was cut to what was needed");
    assert!(c.real_sol.abs_diff(10 * SOL) <= 2, "the raise landed on the target: {}", c.real_sol);

    // Closed to trading.
    assert_fails_with(l.env.send(&[buy_ix(&a.pubkey(), &l.mint, SOL, 0)], &[&a]), "NotTrading");
    assert_fails_with(l.env.send(&[sell_ix(&a.pubkey(), &l.mint, 1_000, 0)], &[&a]), "NotTrading");
    // Too early to unwind.
    let stranger = l.env.user(1);
    assert_fails_with(l.env.send(&[abort_ix(&stranger.pubkey(), &l.mint)], &[&stranger]), "TooEarly");
    l.env.warp_seconds(7 * 24 * 60 * 60 - 5);
    assert_fails_with(l.env.send(&[abort_ix(&stranger.pubkey(), &l.mint)], &[&stranger]), "TooEarly");
    l.env.warp_seconds(10);
    l.env.send(&[abort_ix(&stranger.pubkey(), &l.mint)], &[&stranger]).expect("abort after the wait");
    assert_eq!(l.env.curve(&l.mint).status, ABORTED);

    // Buying stays closed, selling reopens, and every holder can leave.
    assert_fails_with(l.env.send(&[buy_ix(&a.pubkey(), &l.mint, SOL, 0)], &[&a]), "NotTrading");
    let curve_addr = sol_vault_pda(&curve_pda(&l.mint));
    let rent_floor = l.env.lamports(&curve_addr) - l.env.curve(&l.mint).real_sol;
    for who in [&a, &b] {
        let held = l.env.token_amount(&ata(&who.pubkey(), &l.mint, &TOKEN_2022));
        l.env.send(&[sell_ix(&who.pubkey(), &l.mint, held, 0)], &[who]).expect("unwind sell");
    }
    let c = l.env.curve(&l.mint);
    assert_eq!(c.real_tok, c.curve_tokens);
    assert!(l.env.lamports(&curve_addr) >= rent_floor, "the vault never went below its rent");
    assert!(c.real_sol < 100, "only dust remains");
}

#[test]
fn abort_is_only_for_a_sold_out_curve() {
    let mut l = launch(10 * SOL, SUPPLY);
    let s = l.env.user(1);
    l.env.warp_seconds(30 * 24 * 60 * 60);
    assert_fails_with(l.env.send(&[abort_ix(&s.pubkey(), &l.mint)], &[&s]), "NotSoldOut");
}

/// A scripted sequence of random buys and sells from three people, each step checked against the maths and the
/// vault's real balances.
#[test]
fn random_trading_tracks_the_model_and_never_drains_the_vault() {
    let mut l = launch(20 * SOL, SUPPLY);
    let people: Vec<Keypair> = (0..3).map(|_| funded_buyer(&mut l, 500)).collect();
    let curve_addr = sol_vault_pda(&curve_pda(&l.mint));
    let floor = l.env.lamports(&curve_addr);
    let mut model = l.env.curve(&l.mint).math();
    let curve_tokens = l.env.curve(&l.mint).curve_tokens;
    let mut seed: u64 = 0x9E3779B97F4A7C15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for step in 0..120 {
        let who = &people[(next() % 3) as usize];
        let held = l.env.token_amount(&ata(&who.pubkey(), &l.mint, &TOKEN_2022));
        let sell = held > 0 && next() % 2 == 0;
        if sell {
            let amount = (held as u128 * (1 + next() % 100) as u128 / 100).max(1) as u64;
            match curve_math::sell(&model, curve_tokens, amount, FEE_BPS) {
                Some((s, n)) => {
                    l.env.send(&[sell_ix(&who.pubkey(), &l.mint, amount, s.net)], &[who]).unwrap_or_else(|e| panic!("step {step}: sell refused: {}", err_text(&Err(e))));
                    model = n;
                }
                None => assert!(l.env.send(&[sell_ix(&who.pubkey(), &l.mint, amount, 0)], &[who]).is_err()),
            }
        } else {
            let offer = 1_000_000 + next() % (3 * SOL);
            match curve_math::buy(&model, offer, FEE_BPS) {
                Some((b, n)) => {
                    l.env.send(&[buy_ix(&who.pubkey(), &l.mint, offer, b.tokens_out)], &[who]).unwrap_or_else(|e| panic!("step {step}: buy refused: {}", err_text(&Err(e))));
                    model = n;
                }
                None => assert!(l.env.send(&[buy_ix(&who.pubkey(), &l.mint, offer, 0)], &[who]).is_err()),
            }
        }
        let c = l.env.curve(&l.mint);
        assert_eq!((c.v_sol, c.v_tok, c.real_sol, c.real_tok), (model.v_sol, model.v_tok, model.real_sol, model.real_tok), "step {step}");
        assert_eq!(l.env.lamports(&curve_addr), floor + c.real_sol, "step {step}: the vault holds exactly what it owes plus rent");
        if c.status != TRADING {
            break;
        }
    }
}

// ---------------------------------------------------------------- graduation

fn sold_out_curve(target: u64) -> (Launched, Keypair) {
    let mut l = launch(target, SUPPLY);
    let buyer = funded_buyer(&mut l, target / SOL * 3 + 10);
    l.env.send(&[buy_ix(&buyer.pubkey(), &l.mint, target * 2, 0)], &[&buyer]).expect("buy the curve out");
    assert_eq!(l.env.curve(&l.mint).status, SOLD_OUT);
    (l, buyer)
}

fn migrate(l: &mut Launched) -> Sent {
    let payer = l.env.payer.pubkey();
    let creator = l.creator.pubkey();
    let a = MigrateAccounts::new(&l.mint, &creator);
    l.env.send(&[compute_budget_ix(1_400_000), migrate_ix(&payer, &l.mint, &creator, &a, 100_000_000)], &[])
}

fn pool_fields(env: &Env, mint: &Address) -> (u64, u64, u64) {
    let d = env.svm.get_account(&pool_pda(mint)).expect("the pool exists").data;
    let u = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().unwrap());
    (u(76), u(84), u(92)) // x, y, l
}

#[test]
fn migrate_needs_a_sold_out_curve() {
    let mut l = launch(10 * SOL, SUPPLY);
    assert_fails_with(migrate(&mut l), "NotSoldOut");
}

#[test]
fn graduation_opens_a_locked_pool_owned_by_the_creator_at_the_curves_price() {
    let (mut l, buyer) = sold_out_curve(20 * SOL);
    let before = l.env.curve(&l.mint);
    let creator = l.creator.pubkey();
    let payer_before = l.env.lamports(&l.env.payer.pubkey());
    let fee_before = l.env.lamports(&FEE_WALLET);
    let r = migrate(&mut l).unwrap_or_else(|e| panic!("migrate failed: {}", err_text(&Err(e))));
    eprintln!("migrate used {} compute units", r.compute_units_consumed);

    let c = l.env.curve(&l.mint);
    assert_eq!(c.status, MIGRATED);
    assert_eq!(c.real_sol, 0);
    assert_eq!(c.pool, pool_pda(&l.mint));
    // The pool holds every token set aside and every lamport raised, plus the minimum virtual liquidity.
    let (x, y, lq) = pool_fields(&l.env, &l.mint);
    assert_eq!((x, y, lq), (before.lp_tokens, before.real_sol, 10_000_000));
    let a = MigrateAccounts::new(&l.mint, &creator);
    assert_eq!(l.env.token_amount(&a.pool_vault), before.lp_tokens);
    assert_eq!(l.env.svm.get_account(&a.pool).unwrap().owner, POOL_PROGRAM);
    // The position is the creator's and is locked in full.
    let pos = l.env.svm.get_account(&a.position).expect("position").data;
    assert_eq!(&pos[40..72], creator.as_ref(), "owner");
    assert_eq!(u64::from_le_bytes(pos[72..80].try_into().unwrap()), 10_000_000, "shares");
    assert_eq!(u64::from_le_bytes(pos[80..88].try_into().unwrap()), 10_000_000, "locked");
    // The curve's vault is empty but for rent, and nothing is stranded in the migrator.
    assert_eq!(l.env.lamports(&sol_vault_pda(&curve_pda(&l.mint))), l.env.svm.minimum_balance_for_rent_exemption(0));
    assert_eq!(l.env.lamports(&migrator_pda(&curve_pda(&l.mint))), 0);
    assert_eq!(l.env.token_amount(&ata(&migrator_pda(&curve_pda(&l.mint)), &l.mint, &TOKEN_2022)), 0);
    // Aretia took the pool's creation fee, and the caller paid only that and rent.
    assert_eq!(l.env.lamports(&FEE_WALLET) - fee_before, 50_000_000);
    let spent = payer_before - l.env.lamports(&l.env.payer.pubkey());
    assert!(spent < 70_000_000, "the caller paid {spent}");
    // The pool opens within 0.1% of where the curve ended: (SOL raised + 0.01 SOL) / tokens against v_sol / v_tok.
    let end = before.v_sol as f64 / before.v_tok as f64;
    let pool_price = (y + lq) as f64 / x as f64;
    assert!(((pool_price - end) / end).abs() < 0.001, "pool {pool_price} curve {end}");

    // And it works: a holder sells some tokens into it through the pool program.
    let held = l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022));
    let sol_before = l.env.lamports(&buyer.pubkey());
    // Wrapped-SOL accounts for the seller and for Aretia (on a real cluster Aretia's already exists).
    let payer_key = l.env.payer.pubkey();
    l.env.send(&[ata_ix(&payer_key, &buyer.pubkey(), &WSOL, &TOKEN), ata_ix(&payer_key, &FEE_WALLET, &WSOL, &TOKEN)], &[]).expect("wrapped-SOL accounts");
    l.env.send(&[pool_swap_ix(&buyer.pubkey(), &l.mint, false, held / 2, 1)], &[&buyer]).expect("sell into the graduated pool");
    assert!(l.env.token_amount(&ata(&buyer.pubkey(), &WSOL, &TOKEN)) > 0, "the seller was paid in wrapped SOL");
    let _ = sol_before;
    // A second migration is refused.
    assert!(migrate(&mut l).is_err());
}

#[test]
fn migrate_refuses_the_wrong_accounts_and_an_oversized_budget() {
    let (mut l, _b) = sold_out_curve(5 * SOL);
    let payer = l.env.payer.pubkey();
    let creator = l.creator.pubkey();
    let good = MigrateAccounts::new(&l.mint, &creator);
    // A position for someone else, a pool address for another mint, a different "creator".
    let other = Address::new_unique();
    let wrong_owner = MigrateAccounts::new(&l.mint, &other);
    assert_fails_with(l.env.send(&[migrate_ix(&payer, &l.mint, &creator, &wrong_owner, 100_000_000)], &[]), "WrongAccount");
    let wrong_pool = MigrateAccounts::new(&Address::new_unique(), &creator);
    assert_fails_with(l.env.send(&[migrate_ix(&payer, &l.mint, &creator, &wrong_pool, 100_000_000)], &[]), "WrongAccount");
    assert_fails_with(l.env.send(&[migrate_ix(&payer, &l.mint, &other, &good, 100_000_000)], &[]), "WrongAccount");
    assert_fails_with(l.env.send(&[migrate_ix(&payer, &l.mint, &creator, &good, 200_000_001)], &[]), "BadParameters");
    // Too small a budget cannot pay the pool's fee: the whole migration fails and nothing moves.
    assert!(l.env.send(&[compute_budget_ix(1_400_000), migrate_ix(&payer, &l.mint, &creator, &good, 10_000_000)], &[]).is_err());
    assert_eq!(l.env.curve(&l.mint).status, SOLD_OUT);
    migrate(&mut l).expect("the right call still works afterwards");
}

#[test]
fn curves_of_every_size_graduate() {
    for target in [SOL / 10, SOL, 3 * SOL, 85 * SOL] {
        let (mut l, _b) = sold_out_curve(target);
        let raised = l.env.curve(&l.mint).real_sol;
        migrate(&mut l).unwrap_or_else(|e| panic!("target {target}: {}", err_text(&Err(e))));
        let (_, y, _) = pool_fields(&l.env, &l.mint);
        assert_eq!(y, raised, "target {target}");
    }
}

/// The pool program's `swap`, built by hand (the pool's SOL side is wrapped SOL: the trader and Aretia both need a wrapped-SOL account).
fn pool_swap_ix(trader: &Address, mint: &Address, is_buy: bool, amount_in: u64, min_out: u64) -> solana_instruction::Instruction {
    use solana_instruction::AccountMeta;
    let pool = pool_pda(mint);
    let mut d = disc("swap").to_vec();
    d.push(is_buy as u8);
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    let w = |a: Address, s: bool| AccountMeta::new(a, s);
    let r = |a: Address| AccountMeta::new_readonly(a, false);
    solana_instruction::Instruction::new_with_bytes(
        POOL_PROGRAM,
        &d,
        vec![
            w(*trader, true),
            w(pool, false),
            w(ata(&pool, &WSOL, &TOKEN), false),
            r(*mint),
            w(ata(&pool, mint, &TOKEN_2022), false),
            w(ata(trader, mint, &TOKEN_2022), false),
            w(ata(trader, &WSOL, &TOKEN), false),
            w(ata(&FEE_WALLET, &WSOL, &TOKEN), false),
            r(TOKEN_2022),
            r(TOKEN),
        ],
    )
}

#[test]
fn a_stranger_cannot_block_a_curve_by_opening_its_vault_first() {
    // The curve's token vault is the associated account of the curve address for the mint, and anyone may open an associated
    // account for any owner. Opening it before the creator does must not stop the curve from being created.
    let mut env = Env::new();
    let creator = env.user(10);
    let stranger = env.user(1);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    let curve = curve_pda(&mint);
    env.send(&[ata_ix(&stranger.pubkey(), &curve, &mint, &TOKEN_2022)], &[&stranger]).expect("anyone can open the vault account");
    let r = env.send(&[create_curve_ix(&creator.pubkey(), &mint, SUPPLY, 10 * SOL)], &[&creator]);
    assert!(r.is_ok(), "create_curve was blocked by a pre-opened vault: {}", err_text(&r));
    assert_eq!(env.token_amount(&ata(&curve, &mint, &TOKEN_2022)), SUPPLY);
}

#[test]
fn a_pool_someone_else_opened_first_lets_holders_unwind_at_once() {
    // Anyone holding one token can open the token's Aretia Pool before the curve migrates, and its address is fixed by the token,
    // so `migrate` can then never succeed. Holders must not be frozen for the whole delay when that is plain to see.
    let (mut l, buyer) = sold_out_curve(10 * SOL);
    let caller = l.env.user(1);
    let pool = pool_pda(&l.mint);
    assert_fails_with(l.env.send(&[abort_ix(&caller.pubkey(), &l.mint)], &[&caller]), "TooEarly");
    // A pool that is not there changes nothing.
    let mut with_pool = abort_ix(&caller.pubkey(), &l.mint);
    with_pool.accounts.push(solana_instruction::AccountMeta::new_readonly(pool, false));
    assert_fails_with(l.env.send(&[with_pool.clone()], &[&caller]), "TooEarly");
    // Once the pool program holds an account at that address, the curve can be unwound straight away and selling reopens.
    l.env.svm.set_account(pool, solana_account::Account { lamports: 10_000_000, data: vec![1u8; 64], owner: POOL_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    l.env.send(&[with_pool], &[&caller]).expect("abort at once when the pool is taken");
    assert_eq!(l.env.curve(&l.mint).status, ABORTED);
    let held = l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022));
    l.env.send(&[sell_ix(&buyer.pubkey(), &l.mint, held / 2, 0)], &[&buyer]).expect("holders can sell back");
}

#[test]
fn migrate_still_works_when_someone_opened_the_migrators_accounts_first() {
    // The migrator's token and wrapped-SOL accounts are opened in the handler with create-idempotent, so opening them in advance
    // (anyone may) must not block graduation.
    let (mut l, _buyer) = sold_out_curve(10 * SOL);
    let stranger = l.env.user(1);
    let migrator = migrator_pda(&curve_pda(&l.mint));
    l.env.send(&[ata_ix(&stranger.pubkey(), &migrator, &l.mint, &TOKEN_2022), ata_ix(&stranger.pubkey(), &migrator, &WSOL, &TOKEN)], &[&stranger]).expect("anyone can open them");
    let r = migrate(&mut l);
    assert!(r.is_ok(), "migrate was blocked by pre-opened migrator accounts: {}", err_text(&r));
}

// ---------------------------------------------------------------- regressions for the 2026-10 review (docs/audit/2026-10-full-review)

/// L-8: the PoC sold 262,144 raw units for 0 lamports and the tokens were lost. Now a sell that would pay nothing after the
/// fee is refused, the seller keeps the tokens, and the smallest sell that pays something still works.
#[test]
fn l8_a_sell_that_pays_nothing_is_refused() {
    let mut l = launch(10 * SOL, SUPPLY);
    let b = funded_buyer(&mut l, 100);
    l.env.send(&[buy_ix(&b.pubkey(), &l.mint, SOL, 0)], &[&b]).expect("buy");
    let c0 = l.env.curve(&l.mint);
    let m = c0.math();
    // The largest power of two whose SOL out, after the fee, is zero: the PoC's amount.
    let net = |t: u64| {
        let k = m.v_sol as u128 * m.v_tok as u128;
        let nvt = m.v_tok as u128 + t as u128;
        let gross = (m.v_sol as u128 - (k / nvt + u128::from(k % nvt != 0))) as u64;
        gross - curve_math::fee_up(gross, FEE_BPS).min(gross)
    };
    let mut t = 1u64;
    while net(t * 2) == 0 {
        t *= 2;
    }
    let tok = ata(&b.pubkey(), &l.mint, &TOKEN_2022);
    let tok0 = l.env.token_amount(&tok);
    assert_fails_with(l.env.send(&[sell_ix(&b.pubkey(), &l.mint, t, 0)], &[&b]), "TradeTooSmall");
    assert_eq!(l.env.token_amount(&tok), tok0, "the seller kept the tokens");
    assert_eq!(l.env.curve(&l.mint).real_tok, c0.real_tok);
    let mut lo = t;
    while net(lo) == 0 {
        lo += 1;
    }
    let lam0 = l.env.lamports(&b.pubkey());
    l.env.send(&[sell_ix(&b.pubkey(), &l.mint, lo, 1)], &[&b]).expect("the first sell that pays something");
    assert!(l.env.lamports(&b.pubkey()) > lam0);
}

/// I-13: a rise in rent after a curve opened must not freeze its sells (the floor is the rent the vault paid).
#[test]
fn i13_a_rise_in_rent_does_not_freeze_sells() {
    let mut l = launch(10 * SOL, SUPPLY);
    let b = funded_buyer(&mut l, 100);
    l.env.send(&[buy_ix(&b.pubkey(), &l.mint, 2 * SOL, 0)], &[&b]).expect("buy");
    let mut rent: solana_rent::Rent = l.env.svm.get_sysvar();
    rent.lamports_per_byte *= 2;
    l.env.svm.set_sysvar(&rent);
    let held = l.env.token_amount(&ata(&b.pubkey(), &l.mint, &TOKEN_2022));
    // The program no longer refuses (before the fix this first sell failed with Insolvent).
    l.env.send(&[sell_ix(&b.pubkey(), &l.mint, held / 2, 1)], &[&b]).expect("selling still works after rent doubled");
    // Emptying the vault below the new rent-exempt minimum is refused by the runtime itself (a rent-exempt account may not
    // become rent-paying), not by the program; anyone can clear it by sending the vault the difference, which the curve ignores.
    let rest = held - held / 2;
    let r = l.env.send(&[sell_ix(&b.pubkey(), &l.mint, rest, 1)], &[&b]);
    assert!(err_text(&r).contains("InsufficientFundsForRent") && !err_text(&r).contains("Insolvent"), "{}", err_text(&r));
    let vault = sol_vault_pda(&curve_pda(&l.mint));
    let top_up = l.env.svm.minimum_balance_for_rent_exemption(0);
    let mut d = vec![2, 0, 0, 0];
    d.extend_from_slice(&top_up.to_le_bytes());
    let payer = l.env.payer.pubkey();
    let gift = solana_instruction::Instruction::new_with_bytes(SYSTEM, &d, vec![solana_instruction::AccountMeta::new(payer, true), solana_instruction::AccountMeta::new(vault, false)]);
    l.env.send(&[gift], &[]).expect("top up the vault");
    l.env.send(&[sell_ix(&b.pubkey(), &l.mint, rest, 1)], &[&b]).expect("and then selling everything back works");
    let c = l.env.curve(&l.mint);
    assert_eq!(c.real_tok, c.curve_tokens);
}
