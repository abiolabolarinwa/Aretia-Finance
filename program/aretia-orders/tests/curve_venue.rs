#![allow(clippy::too_many_arguments)]
//! Orders filled against the web wallet's REAL bonding-curve program (the binary in `tests/fixtures`, built for its mainnet
//! program id) through the web-curve venue adapter. SOL is wrapped and unwrapped on the way. Build first:
//! `cargo build-sbf` in `programs/aretia-orders` and `programs/aretia-orders-web-curve-venue`.

mod common;
use common::*;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const CURVE: &str = "CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu";
const ADAPTER: &str = "5Vq3f4oT2g7sP3k3dQp8b6m1cXyCwK9Gx7B2Dn4Nn1Fh";
const NATIVE: &str = "So11111111111111111111111111111111111111112";
const CURVE_FEE_WALLET: &str = "2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2";
const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";

/// The curve stores its mint after: discriminator 8, bump 1, sol_bump 1, status 1, creator 32.
const CURVE_MINT_OFFSET: u16 = 43;
const CURVE_FEE_BPS: u64 = 58;
const TOTAL_TOKENS: u64 = 1_000_000_000 * M; // 1 billion tokens, 6 decimals
const TARGET: u64 = 85 * SOL;

fn curve_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"curve", mint.as_ref()], &a(CURVE)).0
}
fn sol_vault_pda(curve: &Address) -> Address {
    Address::find_program_address(&[b"sol_vault", curve.as_ref()], &a(CURVE)).0
}
fn wallet_pda() -> Address {
    Address::find_program_address(&[b"adapter"], &a(ADAPTER)).0
}
fn budget() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&1_000_000u32.to_le_bytes());
    Instruction::new_with_bytes(a(COMPUTE_BUDGET), &d, vec![])
}
fn create_ata_idempotent(
    payer: &Address,
    owner: &Address,
    mint: &Address,
    tp: &Address,
) -> Instruction {
    Instruction::new_with_bytes(
        a(ATA),
        &[1],
        vec![
            ws(*payer),
            w(ata(owner, mint, tp)),
            r(*owner),
            r(*mint),
            r(a(SYSTEM)),
            r(*tp),
        ],
    )
}

// ---- an independent replica of the curve's arithmetic (curve-math), so the tests predict every number

#[derive(Clone, Copy)]
struct Cv {
    v_sol: u64,
    v_tok: u64,
    real_sol: u64,
    real_tok: u64,
    curve_tokens: u64,
}
fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}
fn fee_up(amount: u64, bps: u64) -> u64 {
    ceil_div(amount as u128 * bps as u128, 10_000) as u64
}
/// (fee, net into the vault, tokens out, next state) for an offer that does not sell the curve out.
fn replica_buy(c: &Cv, offer: u64) -> (u64, u64, u64, Cv) {
    let fee = fee_up(offer, CURVE_FEE_BPS).min(offer);
    let net = offer - fee;
    let k = c.v_sol as u128 * c.v_tok as u128;
    let new_vt = ceil_div(k, c.v_sol as u128 + net as u128);
    let out = (c.v_tok as u128 - new_vt) as u64;
    assert!(out < c.real_tok, "test offer must not sell the curve out");
    let next = Cv {
        v_sol: c.v_sol + net,
        v_tok: c.v_tok - out,
        real_sol: c.real_sol + net,
        real_tok: c.real_tok - out,
        ..*c
    };
    (fee, net, out, next)
}
/// (gross, fee, net to the seller, next state)
fn replica_sell(c: &Cv, tokens_in: u64) -> (u64, u64, u64, Cv) {
    let k = c.v_sol as u128 * c.v_tok as u128;
    let new_vt = c.v_tok as u128 + tokens_in as u128;
    let new_vs = ceil_div(k, new_vt);
    let gross = (c.v_sol as u128 - new_vs) as u64;
    let fee = fee_up(gross, CURVE_FEE_BPS).min(gross);
    let next = Cv {
        v_sol: new_vs as u64,
        v_tok: new_vt as u64,
        real_sol: c.real_sol - gross,
        real_tok: c.real_tok + tokens_in,
        ..*c
    };
    (gross, fee, gross - fee, next)
}
fn read_curve(e: &Env, curve: &Address) -> Cv {
    let d = e.svm.get_account(curve).unwrap().data;
    let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    Cv {
        v_sol: u(109),
        v_tok: u(117),
        real_sol: u(125),
        real_tok: u(133),
        curve_tokens: u(93),
    }
}

struct World {
    e: Env,
    m: Market,
    creator: Keypair,
    owner: Keypair,
    keeper: Keypair,
    cv: Cv,
}

fn world() -> World {
    let mut e = Env::new();
    let dir = env!("CARGO_MANIFEST_DIR");
    // The checksum published beside the binary must match the file we load.
    let so = std::fs::read(format!("{dir}/tests/fixtures/aretia_curve.so")).unwrap();
    let sum =
        std::fs::read_to_string(format!("{dir}/tests/fixtures/aretia_curve.so.sha256")).unwrap();
    let got: String = Sha256::digest(&so)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        sum.split_whitespace().next().unwrap(),
        got,
        "tests/fixtures/aretia_curve.so is stale"
    );
    e.svm
        .add_program_from_file(a(CURVE), format!("{dir}/tests/fixtures/aretia_curve.so"))
        .unwrap();
    e.svm
        .add_program_from_file(
            a(ADAPTER),
            format!("{dir}/../aretia-orders-web-curve-venue/target/deploy/aretia_orders_web_curve_venue.so"),
        )
        .expect("build the web-curve venue first");
    e.curve_program = a(CURVE);
    e.curve_mint_offset = CURVE_MINT_OFFSET;
    // LiteSVM does not ship the wrapped-SOL mint; on mainnet it is a plain classic mint with 9 decimals.
    if e.svm.get_account(&a(NATIVE)).is_none() {
        let mut data = vec![0u8; 82];
        data[44] = 9; // decimals
        data[45] = 1; // initialised
        let lamports = e.svm.minimum_balance_for_rent_exemption(82);
        e.svm
            .set_account(
                a(NATIVE),
                solana_account::Account {
                    lamports,
                    data,
                    owner: a(TOKEN),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    // A real launch: a Token-2022 mint (the curve accepts nothing else) with its authorities renounced, then a real curve.
    let tp = a(TOKEN_2022);
    let creator = e.user();
    let mint = e.make_mint(&tp, false, false);
    let creator_ata = e.make_ata(&creator.pubkey(), &mint, &tp);
    e.mint_to(&mint, &tp, &creator_ata, TOTAL_TOKENS);
    e.renounce(&mint, &tp, 0);
    let curve = curve_pda(&mint);
    let mut d = disc("create_curve").to_vec();
    d.extend_from_slice(&TOTAL_TOKENS.to_le_bytes());
    d.extend_from_slice(&TARGET.to_le_bytes());
    let ix = Instruction::new_with_bytes(
        a(CURVE),
        &d,
        vec![
            ws(creator.pubkey()),
            r(mint),
            w(creator_ata),
            w(curve),
            w(sol_vault_pda(&curve)),
            w(ata(&curve, &mint, &tp)),
            r(tp),
            r(a(ATA)),
            r(a(SYSTEM)),
        ],
    );
    e.send(&[ix], &creator, &[]).unwrap();

    let m = Market {
        launch: mint,
        quote: a(NATIVE),
        lp: tp,
        qp: a(TOKEN),
        curve,
    };
    let fee = e.fee_recipient.pubkey();
    e.svm.airdrop(&fee, SOL).unwrap();
    e.make_ata(&fee, &m.launch, &m.lp);
    e.make_ata(&fee, &m.quote, &m.qp);
    e.setup(&m);
    e.set_venues(&[a(ADAPTER)]).unwrap();
    e.set_asset(&m.quote, &m.qp, 100_000_000, true).unwrap();

    let owner = e.user();
    e.make_ata(&owner.pubkey(), &m.launch, &m.lp);
    let owner_wsol = e.make_ata(&owner.pubkey(), &m.quote, &m.qp);
    wrap(&mut e, &owner, &owner_wsol, 2 * SOL);
    let keeper = e.keeper(&m);
    let cv = read_curve(&e, &curve);
    World {
        e,
        m,
        creator,
        owner,
        keeper,
        cv,
    }
}

/// Puts `lamports` of wrapped SOL into `acct` (transfer, then SyncNative).
fn wrap(e: &mut Env, payer: &Keypair, acct: &Address, lamports: u64) {
    let mut t = vec![2u8, 0, 0, 0];
    t.extend_from_slice(&lamports.to_le_bytes());
    let transfer = Instruction::new_with_bytes(a(SYSTEM), &t, vec![ws(payer.pubkey()), w(*acct)]);
    let sync = Instruction::new_with_bytes(a(TOKEN), &[17], vec![w(*acct)]);
    e.send(&[transfer, sync], payer, &[]).unwrap();
}

/// The accounts the web-curve venue takes, in its order. Pure, so the golden file can use fixed addresses.
fn venue_accounts(m: &Market, order: &Address, keeper: &Address, buy: bool) -> Vec<AccountMeta> {
    let wallet = wallet_pda();
    let mut v = vec![
        r(*order),
        w(ata(order, &m.quote, &m.qp)),
        w(ata(order, &m.launch, &m.lp)),
        w(wallet),
    ];
    if buy {
        v.push(w(ata(&wallet, &m.quote, &m.qp)));
    }
    v.extend([
        w(ata(&wallet, &m.launch, &m.lp)),
        w(*keeper),
        r(m.quote),
        r(m.launch),
        w(m.curve),
        w(sol_vault_pda(&m.curve)),
        w(ata(&m.curve, &m.launch, &m.lp)),
        w(a(CURVE_FEE_WALLET)),
        r(a(CURVE)),
        r(m.qp),
        r(m.lp),
    ]);
    if buy {
        v.push(r(a(ATA)));
    }
    v.push(r(a(SYSTEM)));
    v
}

/// The TypeScript client builds the venue's data and accounts too; both must match what the venue really takes.
#[test]
fn golden_venue_fill_matches_the_checked_in_file() {
    let k = |s: &str| -> Address { a(s) };
    let m = Market {
        launch: k("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG"),
        quote: a(NATIVE),
        lp: a(TOKEN_2022),
        qp: a(TOKEN),
        curve: k("DvvccGEr3tn116hLZWPporfreqhSstWNQMsKLq8x7kqX"),
    };
    let order = k("7JUS7QjF2tR3fxD1RotQ3JHCzH9MAXECCaDXkWfqKLKb");
    let keeper = k("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
    let cases: Vec<serde_json::Value> = [(true, "buy"), (false, "sell")]
        .iter()
        .map(|(buy, name)| {
            let metas = venue_accounts(&m, &order, &keeper, *buy);
            let data = body(name, &[&985_000_000u64.to_le_bytes(), &123_456u64.to_le_bytes()]);
            serde_json::json!({
                "name": name,
                "dataHex": data.iter().map(|x| format!("{x:02x}")).collect::<String>(),
                "accounts": metas.iter().map(|m| serde_json::json!({
                    "pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let actual = serde_json::Value::Array(cases);
    let path = format!(
        "{}/tests/golden-curve-venue.json",
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

impl World {
    fn fill_via_curve(
        &mut self,
        order: &Address,
        slice: u64,
        buy: bool,
        venue_amounts: (u64, u64),
    ) -> Result<(), String> {
        let m = self.m.clone();
        let kp = self.keeper.pubkey();
        let wallet = wallet_pda();
        let data = body(
            if buy { "buy" } else { "sell" },
            &[
                &venue_amounts.0.to_le_bytes(),
                &venue_amounts.1.to_le_bytes(),
            ],
        );
        let rest = venue_accounts(&m, order, &kp, buy);
        let fill = self.e.fill_ix(
            &m,
            &kp,
            order,
            &self.owner.pubkey(),
            &a(ADAPTER),
            slice,
            data,
            rest,
        );
        let mut ixs = vec![
            budget(),
            create_ata_idempotent(&kp, &wallet, &m.launch, &m.lp),
        ];
        if buy {
            ixs.push(create_ata_idempotent(&kp, &wallet, &m.quote, &m.qp));
        }
        ixs.push(fill);
        let keeper = dup(&self.keeper);
        self.e.send(&ixs, &keeper, &[])
    }
}

#[test]
fn a_buy_fills_against_the_real_curve_and_a_sell_sells_back() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let fee_wsol = ata(&wd.e.fee_recipient.pubkey(), &m.quote, &m.qp);
    let curve_fee_before = wd.e.lamports(&a(CURVE_FEE_WALLET));

    // ---- buy: spend 1 SOL (Aretia's fee included) for at least T minus a thousand units
    let slice = SOL;
    let aretia_fee = ceil_bps(slice, BUY_FEE);
    let swap_in = slice - aretia_fee;
    let (curve_fee, net, t, next) = replica_buy(&wd.cv, swap_in);
    let order = wd.e.create(&m, &owner, 0, 1, slice, t - 1_000).unwrap();
    wd.fill_via_curve(&order, slice, true, (swap_in, t))
        .unwrap();
    eprintln!("web-curve buy fill used {} compute units", wd.e.last_cu);
    assert!(
        wd.e.last_cu < 600_000,
        "buy fill used {} units",
        wd.e.last_cu
    );

    // 1,000 units of surplus; 20% to the keeper.
    assert_eq!(wd.e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), t - 200);
    assert_eq!(wd.e.bal(&ata(&wd.keeper.pubkey(), &m.launch, &m.lp)), 200);
    assert_eq!(wd.e.bal(&fee_wsol), aretia_fee);
    assert_eq!(wd.e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)), SOL); // 2 wrapped, 1 escrowed and spent
    assert_eq!(
        wd.e.lamports(&a(CURVE_FEE_WALLET)) - curve_fee_before,
        curve_fee
    );
    assert_eq!(
        wd.e.lamports(&sol_vault_pda(&m.curve)) - wd.e.svm.minimum_balance_for_rent_exemption(0),
        net
    );
    assert_eq!(
        wd.e.lamports(&wallet_pda()),
        0,
        "the adapter wallet must end empty"
    );
    assert!(
        !wd.e.exists(&ata(&wallet_pda(), &m.quote, &m.qp)),
        "the temporary wrapped-SOL account is closed"
    );
    assert!(!wd.e.exists(&order));
    wd.cv = read_curve(&wd.e, &m.curve);
    assert_eq!(
        (wd.cv.v_sol, wd.cv.v_tok, wd.cv.real_sol, wd.cv.real_tok),
        (next.v_sol, next.v_tok, next.real_sol, next.real_tok),
        "the replica and the real curve agree"
    );

    // ---- sell: 10 million tokens back for at least the proceeds less Aretia's fee, minus a thousand units
    let tokens = 10_000_000 * M;
    let (_gross, _fee, curve_net, after) = replica_sell(&wd.cv, tokens);
    let sell_fee = ceil_bps(curve_net, SELL_FEE);
    let order =
        wd.e.create(&m, &owner, 1, 2, tokens, curve_net - sell_fee - 1_000)
            .unwrap();
    let before = wd.e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp));
    let keeper_before = wd.e.bal(&ata(&wd.keeper.pubkey(), &m.quote, &m.qp));
    wd.fill_via_curve(&order, tokens, false, (tokens, curve_net))
        .unwrap();
    eprintln!("web-curve sell fill used {} compute units", wd.e.last_cu);
    assert!(
        wd.e.last_cu < 600_000,
        "sell fill used {} units",
        wd.e.last_cu
    );
    assert_eq!(
        wd.e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)),
        before + curve_net - sell_fee - 200
    );
    assert_eq!(
        wd.e.bal(&ata(&wd.keeper.pubkey(), &m.quote, &m.qp)),
        keeper_before + 200
    );
    assert_eq!(wd.e.bal(&fee_wsol), aretia_fee + sell_fee);
    assert_eq!(wd.e.lamports(&wallet_pda()), 0);
    assert!(!wd.e.exists(&order));
    let cv = read_curve(&wd.e, &m.curve);
    assert_eq!(
        (cv.v_sol, cv.v_tok, cv.real_sol, cv.real_tok),
        (after.v_sol, after.v_tok, after.real_sol, after.real_tok)
    );
    let _ = (wd.creator.pubkey(), after.curve_tokens);
}

#[test]
fn the_curve_price_must_meet_the_orders_limit() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let swap_in = SOL - ceil_bps(SOL, BUY_FEE);
    let (_, _, t, _) = replica_buy(&wd.cv, swap_in);
    // The owner demands one unit more than the curve will give.
    let order = wd.e.create(&m, &owner, 0, 1, SOL, t + 1).unwrap();
    let err = wd
        .fill_via_curve(&order, SOL, true, (swap_in, 1))
        .expect_err("must fail");
    assert!(err.contains("LimitNotMet"), "{err}");
    // And the order is untouched and can be cancelled.
    assert_eq!(wd.e.bal(&ata(&order, &m.quote, &m.qp)), SOL);
    wd.e.cancel(&m, &owner, &order).unwrap();
}

#[test]
fn the_curve_itself_refuses_a_buy_below_the_minimum_the_keeper_names() {
    // Even if a keeper lied to the venue about the least tokens, the order program's own limit check is the last word; and if the
    // keeper names a high minimum the curve refuses first. Both leave the order untouched.
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let swap_in = SOL - ceil_bps(SOL, BUY_FEE);
    let (_, _, t, _) = replica_buy(&wd.cv, swap_in);
    let order = wd.e.create(&m, &owner, 0, 1, SOL, t - 1_000).unwrap();
    let err = wd
        .fill_via_curve(&order, SOL, true, (swap_in, t + 1))
        .expect_err("must fail");
    assert!(err.contains("Slippage") || err.contains("Error"), "{err}");
    assert_eq!(wd.e.in_remaining(&order), SOL);
}

#[test]
fn dust_sent_to_the_adapter_wallet_cannot_block_fills() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    // Someone sends a few lamports to the adapter's wallet: below the rent minimum, which would break a plain transfer.
    let donor = wd.e.user();
    let mut t = vec![2u8, 0, 0, 0];
    t.extend_from_slice(&5_000_000u64.to_le_bytes());
    let ix = Instruction::new_with_bytes(a(SYSTEM), &t, vec![ws(donor.pubkey()), w(wallet_pda())]);
    wd.e.send(&[ix], &donor, &[]).unwrap();
    let swap_in = SOL - ceil_bps(SOL, BUY_FEE);
    let (_, _, t, _) = replica_buy(&wd.cv, swap_in);
    let order = wd.e.create(&m, &owner, 0, 1, SOL, t - 1_000).unwrap();
    wd.fill_via_curve(&order, SOL, true, (swap_in, t)).unwrap();
    assert_eq!(wd.e.lamports(&wallet_pda()), 0);
}

#[test]
fn the_adapter_only_talks_to_the_curve_program_it_was_built_for() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let swap_in = SOL - ceil_bps(SOL, BUY_FEE);
    let (_, _, t, _) = replica_buy(&wd.cv, swap_in);
    let order = wd.e.create(&m, &owner, 0, 1, SOL, t - 1_000).unwrap();
    let kp = wd.keeper.pubkey();
    let wallet = wallet_pda();
    let mut rest = venue_accounts(&m, &order, &kp, true);
    let idx = rest.iter().position(|x| x.pubkey == a(CURVE)).unwrap();
    rest[idx] = r(a(TOKEN));
    let data = body("buy", &[&swap_in.to_le_bytes(), &t.to_le_bytes()]);
    let fill = wd.e.fill_ix(
        &m,
        &kp,
        &order,
        &owner.pubkey(),
        &a(ADAPTER),
        SOL,
        data,
        rest,
    );
    let ixs = vec![
        budget(),
        create_ata_idempotent(&kp, &wallet, &m.launch, &m.lp),
        create_ata_idempotent(&kp, &wallet, &m.quote, &m.qp),
        fill,
    ];
    let keeper = dup(&wd.keeper);
    assert!(wd.e.send(&ixs, &keeper, &[]).is_err());
}

#[test]
fn the_fee_wallet_cannot_be_swapped_for_the_keepers() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    let swap_in = SOL - ceil_bps(SOL, BUY_FEE);
    let (_, _, t, _) = replica_buy(&wd.cv, swap_in);
    let order = wd.e.create(&m, &owner, 0, 1, SOL, t - 1_000).unwrap();
    let kp = wd.keeper.pubkey();
    let wallet = wallet_pda();
    let mut rest = venue_accounts(&m, &order, &kp, true);
    let idx = rest
        .iter()
        .position(|x| x.pubkey == a(CURVE_FEE_WALLET))
        .unwrap();
    rest[idx] = w(kp);
    let data = body("buy", &[&swap_in.to_le_bytes(), &t.to_le_bytes()]);
    let fill = wd.e.fill_ix(
        &m,
        &kp,
        &order,
        &owner.pubkey(),
        &a(ADAPTER),
        SOL,
        data,
        rest,
    );
    let ixs = vec![
        budget(),
        create_ata_idempotent(&kp, &wallet, &m.launch, &m.lp),
        create_ata_idempotent(&kp, &wallet, &m.quote, &m.qp),
        fill,
    ];
    let keeper = dup(&wd.keeper);
    assert!(wd.e.send(&ixs, &keeper, &[]).is_err());
}

#[test]
fn a_token_without_a_web_curve_cannot_have_orders() {
    let mut wd = world();
    let m = wd.m.clone();
    let owner = dup(&wd.owner);
    // A different token that has no curve: naming this token's curve for it proves nothing.
    let other = wd.e.make_mint(&m.lp, false, false);
    wd.e.renounce(&other, &m.lp, 0);
    let m2 = Market {
        launch: other,
        ..m.clone()
    };
    wd.e.make_ata(&owner.pubkey(), &other, &m.lp);
    let ix =
        wd.e.create_ix(&m2, &owner.pubkey(), &m.curve, 0, 9, SOL, 1_000);
    let err = wd.e.send(&[ix], &owner, &[]).expect_err("must fail");
    assert!(err.contains("NotALaunchToken"), "{err}");
}
