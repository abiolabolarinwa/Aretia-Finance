use aretia_pool_it::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000_000_000; // 1,000,000,000 tokens
const X0: u64 = 600_000_000_000_000;
const L0: u64 = 10 * SOL;

struct Launched {
    env: Env,
    creator: Keypair,
    mint: Address,
}

fn launch_with(x0: u64, y0: u64, l0: u64, fee: u16, lock: bool) -> Launched {
    launch_ranged(x0, y0, l0, fee, lock, 0)
}

fn launch_ranged(x0: u64, y0: u64, l0: u64, fee: u16, lock: bool, vx0: u64) -> Launched {
    let mut env = Env::new();
    let creator = env.user(100);
    env.make_wsol(&creator.pubkey(), 0);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    let c = creator.pubkey();
    env.send(&[create_pool_ix_full(&c, &c, &c, &mint, x0, y0, l0, fee, lock, 0, 0, vx0)], &[&creator]).expect("create_pool");
    Launched { env, creator, mint }
}

fn launch(fee: u16, lock: bool) -> Launched {
    launch_with(X0, 0, L0, fee, lock)
}

fn trader(l: &mut Launched, sol: u64, tokens: u64) -> Keypair {
    let b = l.env.user(sol);
    l.env.make_wsol(&b.pubkey(), sol * SOL);
    if tokens > 0 {
        l.env.give_tokens(&l.mint, DECIMALS, &l.creator, &b.pubkey(), tokens);
    } else {
        l.env.make_ata(&b.pubkey(), &l.mint);
    }
    b
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

fn rent0(env: &Env) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(0)
}

/// The SOL vault holds exactly: rent + real reserve + unclaimed fees (+ whatever strangers donated).
fn assert_vault_exact(l: &Launched, donated_sol: u64, donated_tok: u64) {
    let p = l.env.pool(&l.mint);
    let pool = pool_pda(&l.mint);
    assert_eq!(l.env.wsol_account(&sol_vault_pda(&pool)), p.y + p.fee_reserve + donated_sol, "the wrapped-SOL vault must hold exactly y + fee reserve (+ donations)");
    assert_eq!(l.env.token_amount(&ata(&pool, &l.mint, &TOKEN_2022)), p.x + donated_tok, "token vault must hold exactly x");
}

#[test]
fn creates_a_single_sided_pool_and_holds_the_tokens() {
    let mut l = launch(25, true);
    let p = l.env.pool(&l.mint);
    let pool = pool_pda(&l.mint);
    assert_eq!((p.x, p.y, p.l, p.fee_bps, p.fee_reserve, p.acc), (X0, 0, L0, 25, 0, 0));
    assert_eq!(p.creator, l.creator.pubkey());
    let pos = l.env.position(&l.mint, &l.creator.pubkey());
    assert_eq!((pos.shares, pos.locked, pos.pending, pos.checkpoint), (L0, L0, 0, 0));
    assert_eq!(l.env.token_amount(&ata(&pool, &l.mint, &TOKEN_2022)), X0);
    assert_eq!(l.env.token_amount(&ata(&l.creator.pubkey(), &l.mint, &TOKEN_2022)), SUPPLY - X0);
    assert_vault_exact(&l, 0, 0);
    // The creation fee reached the fee wallet: it started at 1 SOL.
    assert_eq!(l.env.lamports(&FEE_WALLET), SOL + CREATE_FEE);
    // The creator paid the fee and the rent, nothing else is missing: the fee payer of the transaction is the test payer.
    let _ = &mut l;
}

#[test]
fn an_unlocked_pool_can_be_opened_and_the_owner_can_differ_from_the_creator() {
    let mut env = Env::new();
    let creator = env.user(100);
    let owner = env.user(1);
    env.make_wsol(&creator.pubkey(), 5 * SOL);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    env.send(&[create_pool_ix(&creator.pubkey(), &owner.pubkey(), &mint, X0, 3 * SOL, L0, 100, false)], &[&creator]).expect("create");
    let pos = env.position(&mint, &owner.pubkey());
    assert_eq!((pos.shares, pos.locked), (L0, 0));
    let p = env.pool(&mint);
    assert_eq!((p.y, p.fee_bps), (3 * SOL, 100), "two-sided creation");
    // The creator has no position and no power over the owner's.
    assert!(env.svm.get_account(&position_pda(&pool_pda(&mint), &creator.pubkey())).is_none());
}

#[test]
fn create_refuses_what_it_should() {
    let mut env = Env::new();
    let creator = env.user(100);
    let c = creator.pubkey();
    let kinds = [MintKind::MintAuthorityKept, MintKind::FreezeKept, MintKind::NonTransferable, MintKind::TransferFee];
    for k in kinds {
        let m = env.make_mint(k, DECIMALS, SUPPLY, &creator);
        assert_fails_with(env.send(&[create_pool_ix(&c, &c, &m, X0, 0, L0, 25, true)], &[&creator]), "MintNotAllowed");
    }
    let m4 = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    assert_fails_with(env.send(&[create_pool_ix(&c, &c, &m4, SUPPLY + 1, 0, L0, 25, true)], &[&creator]), "NotEnoughTokens");
    assert_fails_with(env.send(&[create_pool_ix(&c, &c, &m4, X0, 0, L0, 30, true)], &[&creator]), "BadParameters");
    assert_fails_with(env.send(&[create_pool_ix(&c, &c, &m4, X0, 0, 9_999_999, 25, true)], &[&creator]), "BadParameters");
    assert_fails_with(env.send(&[create_pool_ix(&c, &c, &m4, 999, 0, L0, 25, true)], &[&creator]), "BadParameters");
    // The fee wallet is fixed.
    let thief = Address::new_unique();
    let mut bad = create_pool_ix(&c, &c, &m4, X0, 0, L0, 25, true);
    bad.accounts[8].pubkey = thief;
    assert!(env.send(&[bad], &[&creator]).is_err());
    // A plain mint is fine; a second pool for the same mint is not.
    let m5 = env.make_mint(MintKind::Plain, DECIMALS, SUPPLY, &creator);
    env.send(&[create_pool_ix(&c, &c, &m5, SUPPLY / 2, 0, L0, 25, false)], &[&creator]).expect("plain mint pool");
    assert!(env.send(&[create_pool_ix(&c, &c, &m5, SUPPLY / 4, 0, L0, 25, false)], &[&creator]).is_err(), "one pool per mint");
    // Someone who does not hold the tokens cannot open a pool for them.
    let stranger = env.user(5);
    env.make_ata(&stranger.pubkey(), &m4);
    assert!(env.send(&[create_pool_ix(&stranger.pubkey(), &stranger.pubkey(), &m4, 1_000_000, 0, L0, 25, true)], &[&stranger]).is_err());
}

#[test]
fn a_buy_matches_the_maths_to_the_lamport_and_pays_aretia_its_share() {
    let mut l = launch(25, true);
    let buyer = trader(&mut l, 100, 0);
    let before = l.env.pool(&l.mint);
    let (q, next) = pool_math::buy(&before.math(), 2 * SOL).unwrap();
    let (fee_before, buyer_before) = (l.env.wsol(&FEE_WALLET), l.env.wsol(&buyer.pubkey()));

    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 2 * SOL, q.tokens_out)], &[&buyer]).expect("buy");

    let p = l.env.pool(&l.mint);
    assert_eq!((p.x, p.y, p.l, p.acc, p.fee_reserve), (next.x, next.y, next.l, next.acc, next.fee_reserve));
    assert_eq!(l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022)), q.tokens_out);
    assert_eq!(l.env.wsol(&FEE_WALLET) - fee_before, q.protocol);
    assert_eq!(q.fee, 5_000_000, "0.25% of 2 SOL");
    assert_eq!(q.protocol, 1_000_000, "20% of that");
    assert_eq!(buyer_before - l.env.wsol(&buyer.pubkey()), 2 * SOL, "the buyer pays the offer and nothing else");
    assert_vault_exact(&l, 0, 0);
}

#[test]
fn a_sell_matches_the_maths_and_cannot_go_below_the_start() {
    let mut l = launch(100, true);
    let seller = trader(&mut l, 5, 50_000_000_000_000);
    // Nothing has been paid in, so nothing can be sold.
    assert_fails_with(l.env.send(&[swap_ix(&seller.pubkey(), &l.mint, false, 1_000_000_000, 0)], &[&seller]), "TradeTooSmall");
    let buyer = trader(&mut l, 100, 0);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 4 * SOL, 0)], &[&buyer]).expect("buy");
    let bought = l.env.token_amount(&ata(&buyer.pubkey(), &l.mint, &TOKEN_2022));

    let before = l.env.pool(&l.mint);
    let (s, next) = pool_math::sell(&before.math(), bought).unwrap();
    let (fee_before, seller_before) = (l.env.wsol(&FEE_WALLET), l.env.wsol(&buyer.pubkey()));
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, false, bought, s.net)], &[&buyer]).expect("sell");
    let p = l.env.pool(&l.mint);
    assert_eq!((p.x, p.y, p.acc, p.fee_reserve), (next.x, next.y, next.acc, next.fee_reserve));
    assert_eq!(l.env.wsol(&buyer.pubkey()) - seller_before, s.net);
    assert_eq!(l.env.wsol(&FEE_WALLET) - fee_before, s.protocol);
    assert!(s.gross < 4 * SOL, "a round trip loses to the fee and the rounding");
    assert_vault_exact(&l, 0, 0);
    // Selling a lot more than the pool can pay for is refused.
    assert_fails_with(l.env.send(&[swap_ix(&seller.pubkey(), &l.mint, false, 50_000_000_000_000, 0)], &[&seller]), "TradeTooSmall");
}

#[test]
fn swaps_refuse_what_they_should() {
    let mut l = launch(25, true);
    let buyer = trader(&mut l, 100, 0);
    let (q, _) = pool_math::buy(&l.env.pool(&l.mint).math(), SOL).unwrap();
    assert_fails_with(l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, SOL, q.tokens_out + 1)], &[&buyer]), "Slippage");
    assert_fails_with(l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 1, 0)], &[&buyer]), "TradeTooSmall");
    assert_fails_with(l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 0, 0)], &[&buyer]), "TradeTooSmall");
    // The fee goes to Aretia's wallet, not anyone else's.
    let thief = Keypair::new();
    assert!(l.env.send(&[swap_ix_with(&buyer.pubkey(), &l.mint, &ata(&buyer.pubkey(), &l.mint, &TOKEN_2022), &thief.pubkey(), true, SOL, 0)], &[&buyer]).is_err());
    // Tokens land in the trader's own account for this mint.
    let other = trader(&mut l, 1, 0);
    assert!(l.env.send(&[swap_ix_with(&buyer.pubkey(), &l.mint, &ata(&other.pubkey(), &l.mint, &TOKEN_2022), &FEE_WALLET, true, SOL, 0)], &[&buyer]).is_err());
    // Someone else's signature cannot spend the buyer's SOL.
    let mut forged = swap_ix(&buyer.pubkey(), &l.mint, true, SOL, 0);
    forged.accounts[0].is_signer = false;
    assert!(l.env.send(&[forged], &[]).is_err());
}

#[test]
fn locked_liquidity_stays_and_its_fees_can_be_claimed() {
    let mut l = launch(100, true);
    let buyer = trader(&mut l, 1000, 0);
    for _ in 0..5 {
        l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 20 * SOL, 0)], &[&buyer]).expect("buy");
    }
    let creator = l.creator.pubkey();
    // Locked: not a single share can be removed.
    assert_fails_with(l.env.send(&[remove_ix(&creator, &l.mint, 1_000_000, 0, 0)], &[&l.creator]), "Locked");
    assert_fails_with(l.env.send(&[remove_ix(&creator, &l.mint, L0, 0, 0)], &[&l.creator]), "Locked");
    // But the fees can be claimed, once.
    let p = l.env.pool(&l.mint);
    let want = pool_math::pending_fee(L0, p.acc, 0).unwrap();
    assert!(want > 0 && want <= p.fee_reserve);
    let before = l.env.wsol(&creator);
    l.env.send(&[claim_ix(&creator, &l.mint)], &[&l.creator]).expect("claim");
    assert_eq!(l.env.wsol(&creator) - before, want);
    assert_eq!(l.env.pool(&l.mint).fee_reserve, p.fee_reserve - want);
    assert_eq!(l.env.position(&l.mint, &creator).pending, 0);
    assert_fails_with(l.env.send(&[claim_ix(&creator, &l.mint)], &[&l.creator]), "NothingToClaim");
    assert_vault_exact(&l, 0, 0);
    // A stranger can neither claim nor lock the creator's position.
    let stranger = l.env.user(2);
    assert!(l.env.send(&[claim_ix_for(&stranger.pubkey(), &l.mint, &creator)], &[&stranger]).is_err());
}

#[test]
fn an_unlocked_position_can_lock_later_and_then_cannot_unlock() {
    let mut l = launch(25, false);
    let c = l.creator.pubkey();
    // Remove a quarter, then lock half of what is left.
    l.env.send(&[remove_ix(&c, &l.mint, L0 / 4, 0, 0)], &[&l.creator]).expect("remove a quarter");
    let pos = l.env.position(&l.mint, &c);
    assert_eq!((pos.shares, pos.locked), (L0 - L0 / 4, 0));
    let half = pos.shares / 2;
    l.env.send(&[lock_ix(&c, &l.mint, half)], &[&l.creator]).expect("lock");
    assert_fails_with(l.env.send(&[lock_ix(&c, &l.mint, pos.shares)], &[&l.creator]), "BadParameters");
    assert_fails_with(l.env.send(&[lock_ix(&c, &l.mint, 0)], &[&l.creator]), "BadParameters");
    // The unlocked part can go; one share more cannot.
    let unlocked = pos.shares - half;
    assert_fails_with(l.env.send(&[remove_ix(&c, &l.mint, unlocked + 1, 0, 0)], &[&l.creator]), "Locked");
    l.env.send(&[remove_ix(&c, &l.mint, unlocked, 0, 0)], &[&l.creator]).expect("remove the rest of the unlocked part");
    let after = l.env.position(&l.mint, &c);
    assert_eq!((after.shares, after.locked), (half, half));
    assert_fails_with(l.env.send(&[remove_ix(&c, &l.mint, 1_000, 0, 0)], &[&l.creator]), "Locked");
    // Someone else cannot lock or remove for the creator.
    let stranger = l.env.user(2);
    assert!(l.env.send(&[lock_ix(&stranger.pubkey(), &l.mint, 1)], &[&stranger]).is_err());
    assert_vault_exact(&l, 0, 0);
}

#[test]
fn a_second_provider_adds_and_removes_in_proportion() {
    let mut l = launch(25, true);
    let buyer = trader(&mut l, 1000, 0);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 30 * SOL, 0)], &[&buyer]).expect("buy");
    let lp = trader(&mut l, 100, 100_000_000_000_000);
    let p0 = l.env.pool(&l.mint);
    let dl = 2 * SOL;
    let (a, next) = pool_math::add(&p0.math(), dl).unwrap();
    // Caps below what is needed fail.
    assert_fails_with(l.env.send(&[add_ix(&lp.pubkey(), &l.mint, dl, a.tokens_in - 1, a.sol_in)], &[&lp]), "Slippage");
    assert_fails_with(l.env.send(&[add_ix(&lp.pubkey(), &l.mint, dl, a.tokens_in, a.sol_in - 1)], &[&lp]), "Slippage");
    assert_fails_with(l.env.send(&[add_ix(&lp.pubkey(), &l.mint, 999, u64::MAX, u64::MAX)], &[&lp]), "BadParameters");
    let (tok0, sol0) = (l.env.token_amount(&ata(&lp.pubkey(), &l.mint, &TOKEN_2022)), l.env.wsol(&lp.pubkey()));
    l.env.send(&[add_ix(&lp.pubkey(), &l.mint, dl, a.tokens_in, a.sol_in)], &[&lp]).expect("add");
    let p = l.env.pool(&l.mint);
    assert_eq!((p.x, p.y, p.l), (next.x, next.y, next.l));
    let pos = l.env.position(&l.mint, &lp.pubkey());
    assert_eq!((pos.shares, pos.locked, pos.checkpoint), (dl, 0, p0.acc), "new provider earns nothing from earlier trades");
    assert_eq!(tok0 - l.env.token_amount(&ata(&lp.pubkey(), &l.mint, &TOKEN_2022)), a.tokens_in);
    assert!(sol0 - l.env.wsol(&lp.pubkey()) >= a.sol_in);
    assert_vault_exact(&l, 0, 0);

    // Trades now share fees by liquidity.
    for _ in 0..4 {
        l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 5 * SOL, 0)], &[&buyer]).expect("buy");
    }
    let p1 = l.env.pool(&l.mint);
    let mine = pool_math::pending_fee(dl, p1.acc, p0.acc).unwrap();
    let creators = pool_math::pending_fee(L0, p1.acc, 0).unwrap();
    assert!(mine + creators <= p1.fee_reserve);
    assert!(mine > 0 && creators > mine);

    // Remove it all: gets back no more than it put in, plus nothing from the fees (they stay claimable).
    let (r, _) = pool_math::remove(&p1.math(), dl).unwrap();
    l.env.send(&[remove_ix(&lp.pubkey(), &l.mint, dl, r.tokens_out, r.sol_out)], &[&lp]).expect("remove");
    assert_eq!(l.env.position(&l.mint, &lp.pubkey()).pending, mine, "fees were settled, not lost");
    let before = l.env.wsol(&lp.pubkey());
    l.env.send(&[claim_ix(&lp.pubkey(), &l.mint)], &[&lp]).expect("claim after leaving");
    assert_eq!(l.env.wsol(&lp.pubkey()) - before, mine);
    assert_vault_exact(&l, 0, 0);
    // Min amounts are enforced on the way out.
    l.env.send(&[add_ix(&lp.pubkey(), &l.mint, dl, u64::MAX, u64::MAX)], &[&lp]).expect("add again");
    assert_fails_with(l.env.send(&[remove_ix(&lp.pubkey(), &l.mint, 1_000, u64::MAX, 0)], &[&lp]), "Slippage");
    assert_fails_with(l.env.send(&[remove_ix(&lp.pubkey(), &l.mint, 1_000, 0, u64::MAX)], &[&lp]), "Slippage");
}

#[test]
fn donations_to_the_vaults_change_nothing() {
    let mut l = launch(25, true);
    let buyer = trader(&mut l, 100, 0);
    let donor = trader(&mut l, 50, 10_000_000_000_000);
    let pool = pool_pda(&l.mint);
    let (q, next) = pool_math::buy(&l.env.pool(&l.mint).math(), SOL).unwrap();
    // Tokens and SOL sent straight to the vaults.
    l.env.give_tokens(&l.mint, DECIMALS, &donor, &pool, 5_000_000_000_000);
    l.env.donate_wsol(&donor, &pool, 7 * SOL);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, SOL, q.tokens_out)], &[&buyer]).expect("the same quote still holds");
    let p = l.env.pool(&l.mint);
    assert_eq!((p.x, p.y, p.acc), (next.x, next.y, next.acc));
    assert_vault_exact(&l, 7 * SOL, 5_000_000_000_000);
}

#[test]
fn the_fee_wallet_receives_exactly_the_protocol_share_over_many_trades() {
    let mut l = launch(100, true);
    let a = trader(&mut l, 1000, 100_000_000_000_000);
    let start = l.env.wsol(&FEE_WALLET);
    let mut model = l.env.pool(&l.mint).math();
    let mut expect = 0u64;
    for i in 0..30u64 {
        let amt = (i + 1) * SOL / 3;
        let (b, n) = pool_math::buy(&model, amt).unwrap();
        model = n;
        expect += b.protocol;
        l.env.send(&[swap_ix(&a.pubkey(), &l.mint, true, amt, 0)], &[&a]).unwrap();
        if i % 3 == 2 {
            let tok = b.tokens_out / 2;
            let (s, n) = pool_math::sell(&model, tok).unwrap();
            model = n;
            expect += s.protocol;
            l.env.send(&[swap_ix(&a.pubkey(), &l.mint, false, tok, 0)], &[&a]).unwrap();
        }
    }
    assert_eq!(l.env.wsol(&FEE_WALLET) - start, expect);
    let p = l.env.pool(&l.mint);
    assert_eq!((p.x, p.y, p.acc, p.fee_reserve), (model.x, model.y, model.acc, model.fee_reserve));
    assert_vault_exact(&l, 0, 0);
}

#[test]
fn the_launch_fee_falls_with_time_and_the_stored_fee_stays_the_base() {
    let mut env = Env::new();
    let creator = env.user(100);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    let c = creator.pubkey();
    env.set_time(10_000);
    // 20% falling to 1% over 600 seconds.
    env.send(&[create_pool_ix_sched(&c, &c, &mint, X0, 0, L0, 100, true, 2_000, 600)], &[&creator]).expect("create");
    let p0 = env.pool(&mint);
    assert_eq!((p0.fee_bps, p0.fee_start_bps, p0.decay_secs, p0.created_at), (100, 2_000, 600, 10_000));
    let buyer = env.user(1000);
    env.make_wsol(&buyer.pubkey(), 1000 * SOL);
    env.make_ata(&buyer.pubkey(), &mint);
    let mut model = p0.math();
    let mut fees = vec![];
    for (t, expect_bps) in [(10_000i64, 2_000u16), (10_300, 1_050), (10_599, 104), (10_600, 100), (50_000, 100)] {
        env.set_time(t);
        assert_eq!(pool_math::effective_fee_bps(100, 2_000, 600, 10_000, t), expect_bps);
        let mut m = model;
        m.fee_bps = expect_bps;
        let (b, mut n) = pool_math::buy(&m, SOL).unwrap();
        n.fee_bps = 100;
        let before = env.wsol(&FEE_WALLET);
        env.send(&[swap_ix(&buyer.pubkey(), &mint, true, SOL, b.tokens_out)], &[&buyer]).expect("buy");
        let p = env.pool(&mint);
        assert_eq!((p.x, p.y, p.acc, p.fee_reserve, p.fee_bps), (n.x, n.y, n.acc, n.fee_reserve, 100), "t = {t}");
        assert_eq!(env.wsol(&FEE_WALLET) - before, b.protocol);
        fees.push(b.fee);
        model = n;
    }
    assert_eq!(fees[0], SOL / 5, "20% of the first buy");
    assert!(fees.windows(2).all(|w| w[0] >= w[1]), "the fee never rises");
    assert_eq!(fees[3], SOL / 100);
    // A seller pays the schedule too.
    env.set_time(10_000);
    let mint2 = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    env.send(&[create_pool_ix_sched(&c, &c, &mint2, X0, 0, L0, 100, true, 2_000, 600)], &[&creator]).expect("create 2");
    env.make_ata(&buyer.pubkey(), &mint2);
    env.send(&[swap_ix(&buyer.pubkey(), &mint2, true, 5 * SOL, 0)], &[&buyer]).unwrap();
    let held = env.token_amount(&ata(&buyer.pubkey(), &mint2, &TOKEN_2022));
    let mut m = env.pool(&mint2).math();
    m.fee_bps = 2_000;
    let (s, _) = pool_math::sell(&m, held / 2).unwrap();
    let got_before = env.wsol(&buyer.pubkey());
    env.send(&[swap_ix(&buyer.pubkey(), &mint2, false, held / 2, s.net)], &[&buyer]).expect("sell at the launch fee");
    assert_eq!(env.wsol(&buyer.pubkey()) - got_before, s.net);
    assert_eq!(s.fee, pool_math::fee_up(s.gross, 2_000));
}

#[test]
fn bad_launch_schedules_are_refused() {
    let mut env = Env::new();
    let creator = env.user(100);
    let c = creator.pubkey();
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    for (start, decay) in [(2_501u16, 600u32), (2_000, 3_601), (100, 600), (50, 600), (2_000, 0), (0, 600)] {
        assert_fails_with(env.send(&[create_pool_ix_sched(&c, &c, &mint, X0, 0, L0, 100, true, start, decay)], &[&creator]), "BadParameters");
    }
    env.send(&[create_pool_ix_sched(&c, &c, &mint, X0, 0, L0, 25, true, 2_500, 3_600)], &[&creator]).expect("the widest schedule is allowed");
}

#[test]
fn fees_can_be_sent_to_another_wallet_even_when_locked() {
    let mut l = launch(100, true);
    let c = l.creator.pubkey();
    let treasury = Address::new_unique();
    l.env.make_wsol(&treasury, 0);
    let buyer = trader(&mut l, 1000, 0);
    for _ in 0..3 {
        l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 20 * SOL, 0)], &[&buyer]).unwrap();
    }
    assert_eq!(l.env.position(&l.mint, &c).recipient, c, "the owner until told otherwise");
    // Only the owner may name a recipient.
    let stranger = l.env.user(2);
    assert!(l.env.send(&[set_recipient_ix(&stranger.pubkey(), &l.mint, &treasury)], &[&stranger]).is_err());
    l.env.send(&[set_recipient_ix(&c, &l.mint, &treasury)], &[&l.creator]).expect("set recipient on a locked position");
    assert_eq!(l.env.position(&l.mint, &c).recipient, treasury);
    let p = l.env.pool(&l.mint);
    let want = pool_math::pending_fee(L0, p.acc, 0).unwrap();
    // The old payee, or any other account, is refused.
    assert!(l.env.send(&[claim_ix_to(&c, &l.mint, &c, &c)], &[&l.creator]).is_err());
    assert!(l.env.send(&[claim_ix_to(&c, &l.mint, &c, &Address::new_unique())], &[&l.creator]).is_err());
    // Only the owner can call claim, whoever the recipient is.
    assert!(l.env.send(&[claim_ix_to(&stranger.pubkey(), &l.mint, &c, &treasury)], &[&stranger]).is_err());
    let (own_before, t_before) = (l.env.wsol(&c), l.env.wsol(&treasury));
    l.env.send(&[claim_ix_to(&c, &l.mint, &c, &treasury)], &[&l.creator]).expect("claim to the treasury");
    assert_eq!(l.env.wsol(&treasury) - t_before, want);
    assert_eq!(l.env.wsol(&c), own_before, "the owner gets nothing");
    assert_vault_exact(&l, 0, 0);
    // The locked liquidity is still locked.
    assert_fails_with(l.env.send(&[remove_ix(&c, &l.mint, 1_000, 0, 0)], &[&l.creator]), "Locked");
}

#[test]
fn opening_a_pool_costs_the_fee_and_the_deposits_and_nothing_hidden() {
    let mut env = Env::new();
    let creator = env.user(100);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    let c = creator.pubkey();
    let before = env.lamports(&c);
    env.send(&[create_pool_ix(&c, &c, &mint, X0, 0, L0, 25, true)], &[&creator]).unwrap();
    let spent = before - env.lamports(&c);
    let pool = pool_pda(&mint);
    // The creator's whole outlay: the 0.05 SOL fee plus the rent of the four accounts the pool needs.
    let rents: u64 = [env.lamports(&pool), env.lamports(&position_pda(&pool, &c)), env.lamports(&ata(&pool, &mint, &TOKEN_2022)), env.lamports(&sol_vault_pda(&pool))].iter().sum();
    assert_eq!(spent, CREATE_FEE + rents);
    eprintln!("opening cost: fee {} + rent {} = {} lamports", CREATE_FEE, rents, spent);
    assert!(rents < 8_000_000, "rent for the whole pool stays under 0.008 SOL, was {rents}");
}

// ---------------------------------------------------------------- the scripted random run

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    /// Log-uniform in [lo, hi].
    fn log(&mut self, lo: u64, hi: u64) -> u64 {
        let (a, b) = ((lo.max(1) as f64).ln(), (hi.max(lo + 1) as f64).ln());
        let u = (self.next() >> 11) as f64 / (1u64 << 53) as f64;
        ((a + (b - a) * u).exp() as u64).clamp(lo, hi)
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct ModelPos {
    shares: u64,
    locked: u64,
    checkpoint: u128,
    pending: u64,
    exists: bool,
}

fn settled(p: &pool_math::Pool, mut pos: ModelPos) -> ModelPos {
    pos.pending += pool_math::pending_fee(pos.shares, p.acc, pos.checkpoint).unwrap();
    pos.checkpoint = p.acc;
    pos
}

/// A seeded random run of buys, sells, adds, removes, claims, locks and donations by five wallets. A model made from the
/// pool maths and plain accounting predicts every balance and the whole pool state; each step is compared with the chain.
/// Operations the model says must fail are sent too and must fail.
#[test]
fn a_scripted_random_run_matches_the_model() {
    random_run(0, 0x00C0_FFEE_1234_5678);
}

/// The same run on a pool with a price range (a virtual token reserve of a third of the tokens: the top price is 16 times the start).
#[test]
fn a_scripted_random_run_on_a_ranged_pool_matches_the_model() {
    random_run(X0 / 3, 0x0BAD_5EED_9999_1111);
}

fn random_run(vx0: u64, seed: u64) {
    let mut l = launch_ranged(X0, 0, L0, 100, false, vx0);
    l.env.make_wsol(&l.creator.pubkey(), 4_000 * SOL);
    let names = ["creator", "lp_a", "lp_b", "t1", "t2"];
    let mut keys: Vec<Keypair> = vec![];
    for (i, _) in names.iter().enumerate() {
        if i == 0 {
            keys.push(Keypair::try_from(&l.creator.to_bytes()[..]).unwrap());
        } else {
            keys.push(trader(&mut l, 5000, 40_000_000_000_000));
        }
    }
    let ata_of = |k: &Keypair, mint: &Address| ata(&k.pubkey(), mint, &TOKEN_2022);
    let mut model = l.env.pool(&l.mint).math();
    let mut pos: Vec<ModelPos> = vec![ModelPos { shares: L0, locked: 0, checkpoint: 0, pending: 0, exists: true }, ModelPos::default(), ModelPos::default(), ModelPos::default(), ModelPos::default()];
    let (mut donated_sol, mut donated_tok) = (0u64, 0u64);
    let mut fee_wallet_expect = l.env.wsol(&FEE_WALLET);
    let mut rng = Rng(seed);
    let mint = l.mint;
    let (mut ok_count, mut err_count) = ([0u32; 8], [0u32; 8]);

    for step in 0..400 {
        let who = rng.below(5) as usize;
        let actor = &keys[who];
        let a = actor.pubkey();
        let tok_before = l.env.token_amount(&ata_of(actor, &mint));
        let lam_before = l.env.wsol(&a);
        let op = rng.below(100);
        // (instruction, model after, position after, expected actor token delta, expected actor lamport delta, expected fee wallet delta, label)
        struct Plan { ix: solana_instruction::Instruction, next: Option<pool_math::Pool>, pos: Option<ModelPos>, tok: i128, lam: i128, fee: u64, kind: usize }
        let plan: Plan = if op < 35 {
            // buy
            let amt = rng.log(10_000, 60 * SOL).min(lam_before.saturating_sub(SOL));
            match pool_math::buy(&model, amt) {
                Some((b, n)) => Plan { ix: swap_ix(&a, &mint, true, amt, b.tokens_out), next: Some(n), pos: None, tok: b.tokens_out as i128, lam: -(amt as i128), fee: b.protocol, kind: 0 },
                None => Plan { ix: swap_ix(&a, &mint, true, amt, 0), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 0 },
            }
        } else if op < 60 {
            // sell
            let amt = rng.log(1_000, (tok_before / 2).max(1_001)).min(tok_before);
            match pool_math::sell(&model, amt) {
                Some((s, n)) if amt > 0 => Plan { ix: swap_ix(&a, &mint, false, amt, s.net), next: Some(n), pos: None, tok: -(amt as i128), lam: s.net as i128, fee: s.protocol, kind: 1 },
                _ => Plan { ix: swap_ix(&a, &mint, false, amt.max(1), 0), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 1 },
            }
        } else if op < 70 {
            // add liquidity
            let dl = rng.log(1_000, (model.l / 4).max(1_001));
            let p = settled(&model, pos[who]);
            match pool_math::add(&model, dl) {
                Some((ad, n)) if tok_before >= ad.tokens_in => {
                    let mut np = p;
                    if !np.exists { np.exists = true; np.checkpoint = model.acc; np.pending = 0; }
                    np.shares += dl;
                    let rent = if pos[who].exists { 0 } else { l.env.svm.minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 8 + 16 + 8 + 32 + 32 + 1) };
                    Plan { ix: add_ix(&a, &mint, dl, ad.tokens_in, ad.sol_in), next: Some(n), pos: Some(np), tok: -(ad.tokens_in as i128), lam: -(ad.sol_in as i128), fee: 0, kind: 2 }
                }
                _ => Plan { ix: add_ix(&a, &mint, dl, tok_before.saturating_add(1), 0), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 2 },
            }
        } else if op < 80 {
            // remove liquidity (sometimes more than is unlocked)
            let have = pos[who];
            let unlocked = have.shares - have.locked;
            let dl = if rng.below(6) == 0 { have.shares + 1 } else { rng.below(unlocked.max(1) + 1) };
            let p = settled(&model, have);
            let valid = have.exists && dl <= unlocked && pool_math::remove(&model, dl).is_some();
            if valid {
                let (r, n) = pool_math::remove(&model, dl).unwrap();
                let mut np = p;
                np.shares -= dl;
                Plan { ix: remove_ix(&a, &mint, dl, r.tokens_out, r.sol_out), next: Some(n), pos: Some(np), tok: r.tokens_out as i128, lam: r.sol_out as i128, fee: 0, kind: 3 }
            } else if have.exists {
                Plan { ix: remove_ix(&a, &mint, dl, 0, 0), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 3 }
            } else {
                // no position: the account does not exist, so the transaction must fail
                Plan { ix: remove_ix(&a, &mint, 1_000, 0, 0), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 3 }
            }
        } else if op < 90 {
            // claim
            let have = pos[who];
            if have.exists {
                let p = settled(&model, have);
                if p.pending > 0 {
                    let mut np = p;
                    let amount = np.pending;
                    np.pending = 0;
                    let mut n = model;
                    n.fee_reserve -= amount;
                    Plan { ix: claim_ix(&a, &mint), next: Some(n), pos: Some(np), tok: 0, lam: amount as i128, fee: 0, kind: 4 }
                } else {
                    Plan { ix: claim_ix(&a, &mint), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 4 }
                }
            } else {
                Plan { ix: claim_ix(&a, &mint), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 4 }
            }
        } else if op < 95 {
            // lock
            let have = pos[who];
            let amount = 1 + rng.below(have.shares.max(1));
            if have.exists && have.locked + amount <= have.shares {
                let mut np = have;
                np.locked += amount;
                Plan { ix: lock_ix(&a, &mint, amount), next: Some(model), pos: Some(np), tok: 0, lam: 0, fee: 0, kind: 5 }
            } else {
                Plan { ix: lock_ix(&a, &mint, amount), next: None, pos: None, tok: 0, lam: 0, fee: 0, kind: 5 }
            }
        } else {
            // a donation to a vault: changes nothing in the model but the vault balances
            let pool = pool_pda(&mint);
            if rng.below(2) == 0 {
                let amt = rng.log(1, 5 * SOL);
                let amt = amt.min(l.env.wsol(&a));
                if amt > 0 { l.env.donate_wsol(actor, &pool, amt); }
                donated_sol += amt;
            } else {
                let amt = rng.log(1, (tok_before / 4).max(2)).min(tok_before);
                if amt > 0 {
                    l.env.give_tokens(&mint, DECIMALS, actor, &pool, amt);
                    donated_tok += amt;
                }
            }
            continue;
        };

        let r = l.env.send(&[plan.ix], &[actor]);
        match (&plan.next, r) {
            (Some(n), Ok(_)) => {
                ok_count[plan.kind] += 1;
                model = *n;
                if let Some(p) = plan.pos { pos[who] = p; }
                fee_wallet_expect += plan.fee;
                // actor deltas: the transaction fee is paid by the test payer, so these are exact
                let tok_after = l.env.token_amount(&ata_of(actor, &mint));
                assert_eq!(tok_after as i128 - tok_before as i128, plan.tok, "step {step} kind {} token delta", plan.kind);
                assert_eq!(l.env.wsol(&a) as i128 - lam_before as i128, plan.lam, "step {step} kind {} lamport delta", plan.kind);
            }
            (None, Err(_)) => err_count[plan.kind] += 1,
            (Some(_), Err(e)) => panic!("step {step} kind {}: the model says it succeeds, but it failed: {:?} {}", plan.kind, e.err, e.meta.logs.join(" | ")),
            (None, Ok(_)) => panic!("step {step} kind {}: the model says it must fail, but it succeeded", plan.kind),
        }

        // The whole state, every step.
        let p = l.env.pool(&mint);
        assert_eq!((p.x, p.vx, p.y, p.l, p.acc, p.fee_reserve), (model.x, model.vx, model.y, model.l, model.acc, model.fee_reserve), "step {step} pool state");
        assert_eq!(l.env.wsol(&FEE_WALLET), fee_wallet_expect, "step {step} fee wallet");
        assert_vault_exact(&l, donated_sol, donated_tok);
        let mut total_shares = 0u64;
        for (i, k) in keys.iter().enumerate() {
            if pos[i].exists {
                let on = l.env.position(&mint, &k.pubkey());
                assert_eq!((on.shares, on.locked, on.checkpoint, on.pending), (pos[i].shares, pos[i].locked, pos[i].checkpoint, pos[i].pending), "step {step} position {}", names[i]);
                total_shares += on.shares;
                assert!(on.locked <= on.shares);
            }
        }
        assert_eq!(total_shares, p.l, "step {step}: positions must add up to the pool's liquidity");
        let owed: u64 = (0..5).filter(|i| pos[*i].exists).map(|i| settled(&model, pos[i]).pending).sum();
        assert!(owed <= p.fee_reserve, "step {step}: claims {owed} exceed the fee reserve {}", p.fee_reserve);
    }
    // The run must have exercised everything, successes and refusals.
    eprintln!("ok per kind {ok_count:?}, refused per kind {err_count:?}");
    for kind in 0..6 {
        assert!(ok_count[kind] > 0, "kind {kind} never succeeded in the run");
    }
}

#[test]
fn a_ranged_pool_trades_inside_its_range_and_refuses_past_the_top() {
    // A third of the tokens as a virtual reserve: s = 4, so the price can rise to 16 times the start.
    let vx0 = X0 / 3;
    let mut l = launch_ranged(X0, 0, L0, 25, true, vx0);
    let p0 = l.env.pool(&l.mint);
    assert_eq!((p0.x, p0.vx, p0.l), (X0, vx0, L0));
    let buyer = trader(&mut l, 1000, 0);
    let mut model = p0.math();
    // Buy in steps until the pool refuses: it must refuse by the maths, and must never run its real tokens out of order.
    let mut bought = 0u64;
    for i in 0..40u64 {
        let amt = (i + 1) * SOL / 2;
        match pool_math::buy(&model, amt) {
            Some((b, n)) => {
                l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, amt, b.tokens_out)], &[&buyer]).expect("buy inside the range");
                model = n;
                bought += b.tokens_out;
            }
            None => {
                assert_fails_with(l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, amt, 0)], &[&buyer]), "TradeTooSmall");
                break;
            }
        }
        let p = l.env.pool(&l.mint);
        assert_eq!((p.x, p.vx, p.y), (model.x, model.vx, model.y));
        assert!(p.x > 0 || p.vx > 0);
    }
    assert!(bought > 0 && model.x < X0);
    assert_vault_exact(&l, 0, 0);
    // The raise is bounded by the range: real SOL in the pool never exceeds l * (s - 1) = 3 l, plus rounding.
    assert!(model.y <= 3 * L0 + 10, "raised {} against a ceiling of {}", model.y, 3 * L0);
    // Selling it back works and leaves the pool whole.
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, false, bought, 1)], &[&buyer]).expect("sell back");
    assert_vault_exact(&l, 0, 0);
}

#[test]
fn bad_ranges_are_refused() {
    let mut env = Env::new();
    let creator = env.user(100);
    let c = creator.pubkey();
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    for vx in [X0 / 1_001 - 1, X0 * 1_001, u64::MAX] {
        assert_fails_with(env.send(&[create_pool_ix_full(&c, &c, &c, &mint, X0, 0, L0, 25, true, 0, 0, vx)], &[&creator]), "BadParameters");
    }
    env.send(&[create_pool_ix_full(&c, &c, &c, &mint, X0, 0, L0, 25, true, 0, 0, X0 / 1_000)], &[&creator]).expect("the widest range is allowed");
}

#[test]
fn a_position_can_be_sold_and_the_buyer_gets_everything_and_the_seller_nothing() {
    let mut l = launch(100, false);
    let a = l.creator.pubkey();
    let b = l.env.user(5);
    l.env.make_wsol(&b.pubkey(), 0);
    let buyer = trader(&mut l, 1000, 0);
    for _ in 0..3 {
        l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 20 * SOL, 0)], &[&buyer]).unwrap();
    }
    // Lock half, name a recipient, then hand the position over.
    l.env.send(&[lock_ix(&a, &l.mint, L0 / 2)], &[&l.creator]).unwrap();
    l.env.send(&[set_recipient_ix(&a, &l.mint, &Address::new_unique())], &[&l.creator]).unwrap();
    // Only the owner can transfer.
    assert!(l.env.send(&[transfer_position_ix(&b.pubkey(), &a, &l.mint, &b.pubkey())], &[&b]).is_err());
    l.env.send(&[transfer_position_ix(&a, &a, &l.mint, &b.pubkey())], &[&l.creator]).expect("transfer");
    let pos = l.env.position(&l.mint, &a);
    assert_eq!((pos.owner, pos.recipient, pos.id, pos.shares, pos.locked), (b.pubkey(), b.pubkey(), a, L0, L0 / 2), "the lock goes with it; the payee resets to the new owner");
    assert!(pos.pending > 0, "fees settled to the position go with it");
    // The seller can do nothing with it any more.
    assert!(l.env.send(&[remove_ix(&a, &l.mint, 1_000, 0, 0)], &[&l.creator]).is_err());
    assert!(l.env.send(&[claim_ix_id(&a, &a, &l.mint, &a)], &[&l.creator]).is_err());
    assert!(l.env.send(&[lock_ix_id(&a, &a, &l.mint, 1)], &[&l.creator]).is_err());
    assert!(l.env.send(&[transfer_position_ix(&a, &a, &l.mint, &a)], &[&l.creator]).is_err());
    // The buyer can claim to themselves and remove the unlocked half, not the locked half.
    let owed = l.env.position(&l.mint, &a).pending + pool_math::pending_fee(L0, l.env.pool(&l.mint).acc, l.env.position(&l.mint, &a).checkpoint).unwrap();
    let before = l.env.wsol(&b.pubkey());
    l.env.send(&[claim_ix_id(&b.pubkey(), &a, &l.mint, &b.pubkey())], &[&b]).expect("new owner claims");
    assert_eq!(l.env.wsol(&b.pubkey()) - before, owed);
    l.env.make_ata(&b.pubkey(), &l.mint);
    assert!(l.env.send(&[remove_ix_id(&b.pubkey(), &a, &l.mint, L0 / 2 + 1, 0, 0)], &[&b]).is_err(), "the locked half stays");
    l.env.send(&[remove_ix_id(&b.pubkey(), &a, &l.mint, L0 / 2, 0, 0)], &[&b]).expect("the unlocked half goes");
    assert_vault_exact(&l, 0, 0);
}

#[test]
fn position_ids_cannot_be_taken_in_advance() {
    let mut l = launch(25, true);
    let attacker = trader(&mut l, 100, 100_000_000_000_000);
    let victim = trader(&mut l, 100, 100_000_000_000_000);
    // Naming someone else's address as the id, without its signature, is refused: the victim's own slot cannot be squatted.
    let mut squat = add_ix_id(&attacker.pubkey(), &victim.pubkey(), &l.mint, 1_000_000_000, u64::MAX, u64::MAX);
    squat.accounts[9].is_signer = false; // the attacker does not hold the victim's key
    assert_fails_with(l.env.send(&[squat], &[&attacker]), "BadPositionId");
    l.env.send(&[add_ix(&victim.pubkey(), &l.mint, 1_000_000_000, u64::MAX, u64::MAX)], &[&victim]).expect("the victim's own slot is free");
    // A second position under a fresh key that signs for itself is allowed, and is the owner's own.
    let extra = Keypair::new();
    l.env.send(&[add_ix_id(&victim.pubkey(), &extra.pubkey(), &l.mint, 500_000_000, u64::MAX, u64::MAX)], &[&victim, &extra]).expect("a second position under a signing id");
    let p2 = l.env.position(&l.mint, &extra.pubkey());
    assert_eq!((p2.owner, p2.id, p2.shares), (victim.pubkey(), extra.pubkey(), 500_000_000));
    // Someone who does not own an existing position cannot add to it.
    let mut not_mine = add_ix_id(&attacker.pubkey(), &victim.pubkey(), &l.mint, 1_000_000_000, u64::MAX, u64::MAX);
    not_mine.accounts[9].is_signer = false;
    assert_fails_with(l.env.send(&[not_mine], &[&attacker]), "NotOwner");
    // After a sale the old owner's default slot is taken, and they open a new position under a signing id.
    l.env.send(&[transfer_position_ix(&victim.pubkey(), &victim.pubkey(), &l.mint, &attacker.pubkey())], &[&victim]).unwrap();
    assert_fails_with(l.env.send(&[add_ix(&victim.pubkey(), &l.mint, 1_000_000_000, u64::MAX, u64::MAX)], &[&victim]), "NotOwner");
    assert_vault_exact(&l, 0, 0);
}
