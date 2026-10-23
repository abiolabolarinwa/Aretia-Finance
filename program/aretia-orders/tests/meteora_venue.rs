#![allow(clippy::too_many_arguments)]
//! Orders filled on the pool a token graduates into: the web wallet's REAL curve sells a token out and migrates it into a REAL
//! Meteora DAMM v2 pool (the open-source program, built from source, see tests/fixtures/README.md), and the order program fills
//! orders by calling Meteora's `swap` directly. No adapter program is involved: the order's vaults are ordinary token accounts,
//! so Meteora can swap between them as long as the order signs as `payer`, which the order program does for the venue.

mod common;
use common::web::*;
use common::*;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOTAL: u64 = 1_000_000_000 * M; // 1 billion tokens, 6 decimals
const TARGET: u64 = SOL; // a 1 SOL raise: small enough to buy out in a test

struct World {
    e: Env,
    m: Market,
    pool: Pool,
    owner: Keypair,
    keeper: Keypair,
}

fn world() -> World {
    let mut e = Env::new();
    load_curve(&mut e);
    load_meteora(&mut e);
    ensure_native_mint(&mut e);
    e.curve_program = a(CURVE);
    e.curve_mint_offset = 43;

    // A real launch, sold out on the real curve and migrated into a real Meteora pool.
    let tp = a(TOKEN_2022);
    let creator = e.user();
    let mint = e.make_mint(&tp, false, false);
    let creator_ata = e.make_ata(&creator.pubkey(), &mint, &tp);
    e.mint_to(&mint, &tp, &creator_ata, TOTAL);
    e.renounce(&mint, &tp, 0);
    e.send(
        &[create_curve_ix(&creator.pubkey(), &mint, TOTAL, TARGET)],
        &creator,
        &[],
    )
    .unwrap();
    let buyer = e.user();
    e.make_ata(&buyer.pubkey(), &mint, &tp);
    e.send(
        &[curve_buy_ix(&buyer.pubkey(), &mint, 3 * SOL, 1)],
        &buyer,
        &[],
    )
    .unwrap();
    let curve = curve_pda(&mint);
    let data = e.svm.get_account(&curve).unwrap().data;
    let u = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    let (lp_tokens, real_sol, real_tok) = (u(101), u(125), u(133));
    assert_eq!(
        real_tok, 0,
        "the curve must be sold out before it can graduate"
    );
    let (liquidity, sqrt_price) = pool_args(real_sol, lp_tokens);
    let pool = Pool::new(&mint);
    let payer = e.user();
    e.send(
        &[
            compute_budget(1_400_000),
            migrate_ix(
                &payer.pubkey(),
                &mint,
                &pool,
                100_000_000,
                liquidity,
                sqrt_price,
            ),
        ],
        &payer,
        &[&pool.nft],
    )
    .unwrap();

    let m = Market {
        launch: mint,
        quote: a(NATIVE),
        lp: tp,
        qp: a(TOKEN),
        curve,
    };
    let fee = e.fee_recipient.pubkey();
    e.make_ata(&fee, &m.launch, &m.lp);
    e.make_ata(&fee, &m.quote, &m.qp);
    e.setup(&m);
    e.set_venues(&[a(METEORA)]).unwrap();
    e.set_asset(&m.quote, &m.qp, 100_000_000, true).unwrap();

    // The order owner holds wrapped SOL and launch tokens.
    let owner = e.user();
    let owner_launch = e.make_ata(&owner.pubkey(), &m.launch, &m.lp);
    let owner_wsol = e.make_ata(&owner.pubkey(), &m.quote, &m.qp);
    e.mint_to(&m.launch, &m.lp, &owner_launch, 1_000_000_000 * M);
    wrap(&mut e, &owner, &owner_wsol, 3 * SOL);
    let keeper = e.keeper(&m);
    World {
        e,
        m,
        pool,
        owner,
        keeper,
    }
}

fn wrap(e: &mut Env, payer: &Keypair, acct: &Address, lamports: u64) {
    let mut t = vec![2u8, 0, 0, 0];
    t.extend_from_slice(&lamports.to_le_bytes());
    let transfer = Instruction::new_with_bytes(a(SYSTEM), &t, vec![ws(payer.pubkey()), w(*acct)]);
    let sync = Instruction::new_with_bytes(a(TOKEN), &[17], vec![w(*acct)]);
    e.send(&[transfer, sync], payer, &[]).unwrap();
}

impl World {
    /// A fill through Meteora: `data` and the accounts are Meteora's own, with the order as payer.
    fn fill(
        &mut self,
        order: &Address,
        slice: u64,
        data: Vec<u8>,
        output: Option<Address>,
    ) -> Result<(), String> {
        let m = self.m.clone();
        let (in_vault, out_vault) = (ata(order, &m.quote, &m.qp), ata(order, &m.launch, &m.lp));
        // A buy pays wrapped SOL (the quote) and receives the launch token; a sell is the reverse.
        let buy = self.e.order_is_buy(order);
        let (input, default_out) = if buy {
            (in_vault, out_vault)
        } else {
            (out_vault, in_vault)
        };
        let swap = meteora_swap_accounts(
            &m.launch,
            &self.pool,
            order,
            &input,
            &output.unwrap_or(default_out),
            false,
        );
        let kp = self.keeper.pubkey();
        let fill = self.e.fill_ix(
            &m,
            &kp,
            order,
            &self.owner.pubkey(),
            &a(METEORA),
            slice,
            data,
            swap,
        );
        let keeper = dup(&self.keeper);
        self.e.send(&[compute_budget(600_000), fill], &keeper, &[])
    }
    fn vault_a(&self) -> u64 {
        self.e.bal(&self.pool.vault_a)
    }
    fn vault_b(&self) -> u64 {
        self.e.bal(&self.pool.vault_b)
    }
}

#[test]
fn a_buy_fills_on_the_graduated_pool_and_everyone_is_paid_exactly() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let fee_wsol = ata(&wd.e.fee_recipient.pubkey(), &m.quote, &m.qp);
    let (owner_l, keeper_l) = (
        ata(&owner.pubkey(), &m.launch, &m.lp),
        ata(&wd.keeper.pubkey(), &m.launch, &m.lp),
    );

    // Spend 0.3 SOL for at least one token (any real price beats that).
    let slice = 300_000_000u64;
    let order = wd.e.create(&m, &owner, 0, 1, slice, M).unwrap();
    let fee = ceil_bps(slice, BUY_FEE);
    let swap_in = slice - fee;
    let (a0, b0) = (wd.vault_a(), wd.vault_b());
    let (ol0, kl0, f0) = (wd.e.bal(&owner_l), wd.e.bal(&keeper_l), wd.e.bal(&fee_wsol));
    wd.fill(&order, slice, meteora_swap_data(swap_in, 1), None)
        .unwrap();
    eprintln!("meteora buy fill used {} compute units", wd.e.last_cu);

    let out = a0 - wd.vault_a(); // what the pool paid out, read from the pool itself
    assert!(out > 0);
    assert_eq!(
        wd.vault_b() - b0,
        swap_in,
        "the pool received exactly the swap amount"
    );
    let reward = ((out - M) * KEEPER_SHARE) / 10_000;
    assert_eq!(wd.e.bal(&keeper_l) - kl0, reward);
    assert_eq!(wd.e.bal(&owner_l) - ol0, out - reward);
    assert_eq!(wd.e.bal(&fee_wsol) - f0, fee);
    assert!(!wd.e.exists(&order));
    assert!(!wd.e.exists(&ata(&order, &m.quote, &m.qp)));
}

#[test]
fn a_sell_fills_net_of_both_fees_on_the_graduated_pool() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let (owner_w, keeper_w) = (
        ata(&owner.pubkey(), &m.quote, &m.qp),
        ata(&wd.keeper.pubkey(), &m.quote, &m.qp),
    );
    let fee_wsol = ata(&wd.e.fee_recipient.pubkey(), &m.quote, &m.qp);

    // Sell a sixth of what the pool holds for at least 0.1 SOL.
    let tokens = wd.vault_a() / 6;
    let order = wd.e.create(&m, &owner, 1, 1, tokens, 100_000_000).unwrap();
    let (a0, b0) = (wd.vault_a(), wd.vault_b());
    let (ow0, kw0, f0) = (wd.e.bal(&owner_w), wd.e.bal(&keeper_w), wd.e.bal(&fee_wsol));
    wd.fill(&order, tokens, meteora_swap_data(tokens, 1), None)
        .unwrap();

    let got = b0 - wd.vault_b();
    assert_eq!(wd.vault_a() - a0, tokens);
    let fee = ceil_bps(got, SELL_FEE);
    let net = got - fee;
    assert!(net >= 100_000_000, "the limit was met");
    let reward = ((net - 100_000_000) * KEEPER_SHARE) / 10_000;
    assert_eq!(wd.e.bal(&fee_wsol) - f0, fee);
    assert_eq!(wd.e.bal(&keeper_w) - kw0, reward);
    assert_eq!(wd.e.bal(&owner_w) - ow0, net - reward);
    assert!(!wd.e.exists(&order));
}

#[test]
fn a_limit_the_pool_cannot_meet_is_refused_and_nothing_moves() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let slice = 300_000_000u64;
    // A thousand times more tokens than the whole pool holds: no swap can deliver that, even though Meteora is told to accept 1.
    let order =
        wd.e.create(&m, &owner, 0, 2, slice, wd.vault_a() * 1000)
            .unwrap();
    let swap_in = slice - ceil_bps(slice, BUY_FEE);
    let (a0, b0) = (wd.vault_a(), wd.vault_b());
    let err = wd
        .fill(&order, slice, meteora_swap_data(swap_in, 1), None)
        .expect_err("must fail");
    assert!(err.contains("LimitNotMet"), "{err}");
    assert_eq!((wd.vault_a(), wd.vault_b()), (a0, b0));
    assert_eq!(wd.e.bal(&ata(&order, &m.quote, &m.qp)), slice);
    wd.e.cancel(&m, &owner, &order).unwrap();
}

#[test]
fn a_keeper_cannot_send_the_swap_output_to_itself() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let slice = 300_000_000u64;
    let order = wd.e.create(&m, &owner, 0, 3, slice, M).unwrap();
    let swap_in = slice - ceil_bps(slice, BUY_FEE);
    // The keeper names ITS OWN launch-token account as the swap's output. Meteora is happy to pay it; the order sees nothing arrive.
    let keeper_launch = ata(&wd.keeper.pubkey(), &m.launch, &m.lp);
    let err = wd
        .fill(
            &order,
            slice,
            meteora_swap_data(swap_in, 1),
            Some(keeper_launch),
        )
        .expect_err("must fail");
    assert!(err.contains("LimitNotMet"), "{err}");
    assert_eq!(wd.e.bal(&keeper_launch), 0);
    assert_eq!(wd.e.bal(&ata(&order, &m.quote, &m.qp)), slice);
}

#[test]
fn a_swap_for_a_different_amount_than_declared_is_refused() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let slice = 300_000_000u64;
    let order = wd.e.create(&m, &owner, 0, 4, slice, M).unwrap();
    let swap_in = slice - ceil_bps(slice, BUY_FEE);
    let err = wd
        .fill(&order, slice, meteora_swap_data(swap_in - 1, 1), None)
        .expect_err("must fail");
    assert!(err.contains("WrongAmountSpent"), "{err}");
    assert_eq!(wd.e.bal(&ata(&order, &m.quote, &m.qp)), slice);
}

#[test]
fn only_meteora_can_be_called_when_meteora_is_the_whitelisted_venue() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let slice = 300_000_000u64;
    let order = wd.e.create(&m, &owner, 0, 5, slice, M).unwrap();
    wd.e.set_venues(&[]).unwrap();
    let swap_in = slice - ceil_bps(slice, BUY_FEE);
    let err = wd
        .fill(&order, slice, meteora_swap_data(swap_in, 1), None)
        .expect_err("must fail");
    assert!(err.contains("VenueNotAllowed"), "{err}");
}

/// The TypeScript client builds Meteora's swap data and accounts too; both must match what the real program was driven with here.
#[test]
fn golden_meteora_fill_matches_the_checked_in_file() {
    let k = |s: &str| -> Address { a(s) };
    let mint = k("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
    let order = k("7JUS7QjF2tR3fxD1RotQ3JHCzH9MAXECCaDXkWfqKLKb");
    let m = Market {
        launch: mint,
        quote: a(NATIVE),
        lp: a(TOKEN_2022),
        qp: a(TOKEN),
        curve: k("DvvccGEr3tn116hLZWPporfreqhSstWNQMsKLq8x7kqX"),
    };
    let pool = Pool::new(&mint);
    let (in_vault, out_vault) = (ata(&order, &m.quote, &m.qp), ata(&order, &m.launch, &m.lp));
    let cases: Vec<serde_json::Value> = [
        ("buy", in_vault, out_vault),
        ("sell", out_vault, in_vault),
    ]
    .iter()
    .map(|(name, input, output)| {
        let metas = meteora_swap_accounts(&mint, &pool, &order, input, output, false);
        let data = meteora_swap_data(985_000_000, 123_456);
        serde_json::json!({
            "name": name,
            "pool": pool.pool.to_string(),
            "dataHex": data.iter().map(|x| format!("{x:02x}")).collect::<String>(),
            "accounts": metas.iter().map(|m| serde_json::json!({
                "pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable
            })).collect::<Vec<_>>(),
        })
    })
    .collect();
    let actual = serde_json::Value::Array(cases);
    let path = format!(
        "{}/tests/golden-meteora-venue.json",
        env!("CARGO_MANIFEST_DIR")
    );
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("run once with UPDATE_GOLDEN=1"),
    )
    .unwrap();
    assert_eq!(actual, expected);
}
