use aretia_curve_it::*;
use solana_signer::Signer;

#[test]
fn poc_sell_that_pays_nothing_is_accepted() {
    let mut env = Env::new();
    let creator = env.user(10);
    let supply: u64 = 1_000_000_000_000_000;
    let mint = env.make_mint(MintKind::Launch, 6, supply, &creator);
    env.send(&[create_curve_ix(&creator.pubkey(), &mint, supply, 10 * SOL)], &[&creator]).unwrap();
    let b = env.user(100);
    env.make_ata(&b.pubkey(), &mint);
    env.send(&[buy_ix(&b.pubkey(), &mint, SOL, 0)], &[&b]).unwrap();
    let c0 = env.curve(&mint);
    // find largest tokens_in with gross == 0 via the model
    let m = c0.math();
    let mut t = 1u64;
    while curve_math::sell(&m, c0.curve_tokens, t * 2, FEE_BPS).map(|(s, _)| s.net == 0).unwrap_or(false) { t *= 2; }
    let (s, _) = curve_math::sell(&m, c0.curve_tokens, t, FEE_BPS).unwrap();
    println!("tokens_in={t} gross={} fee={} net={}", s.gross, s.fee, s.net);
    let lam0 = env.lamports(&b.pubkey());
    let tok0 = env.token_amount(&ata(&b.pubkey(), &mint, &TOKEN_2022));
    env.send(&[sell_ix(&b.pubkey(), &mint, t, 0)], &[&b]).expect("zero-proceeds sell accepted");
    let tok1 = env.token_amount(&ata(&b.pubkey(), &mint, &TOKEN_2022));
    let c1 = env.curve(&mint);
    println!("tokens lost={} lamports delta={} (tx fee only) real_sol {}->{} real_tok {}->{}", tok0 - tok1, lam0 as i128 - env.lamports(&b.pubkey()) as i128, c0.real_sol, c1.real_sol, c0.real_tok, c1.real_tok);
    assert_eq!(tok0 - tok1, t);
}
