#![allow(clippy::too_many_arguments)]
//! Order program tests with the mock venue. The shared harness is in `common`.

mod common;
use common::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

// ================================================================================================ tests

#[test]
fn discriminator_matches_the_curve_program() {
    // The proof that a mint is an Aretia Launch token depends on this constant matching the curve program's account.
    let hex: Vec<u8> = disc_account("Curve").to_vec();
    assert_eq!(hex, vec![191, 180, 249, 66, 180, 71, 51, 182]);
}

#[test]
fn buy_fills_and_pays_fee_keeper_and_owner_exactly() {
    for (lp, qp) in COMBOS {
        let mut e = Env::new();
        let m = e.market(lp, qp);
        e.setup(&m);
        let owner = e.trader(&m, 0, 5_000 * M);
        let keeper = e.keeper(&m);
        // Spend up to 1,000 Q for at least 500 L.
        let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
        let order_rent = e.lamports(&order);
        assert_eq!(e.bal(&ata(&order, &m.quote, &m.qp)), 1_000 * M);
        assert_eq!(e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)), 4_000 * M);
        let owner_lamports = e.lamports(&owner.pubkey());

        let fee = ceil_bps(1_000 * M, BUY_FEE); // 15 Q
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            1_000 * M,
            1_000 * M - fee,
            520 * M,
        )
        .unwrap();

        // 520 received, 500 owed: 20 surplus, 20% to the keeper.
        assert_eq!(e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), 516 * M);
        assert_eq!(e.bal(&ata(&keeper.pubkey(), &m.launch, &m.lp)), 4 * M);
        assert_eq!(e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)), fee);
        // The order and both vaults are closed and the rent went back to the owner.
        assert!(!e.exists(&order));
        assert!(!e.exists(&ata(&order, &m.launch, &m.lp)));
        assert!(!e.exists(&ata(&order, &m.quote, &m.qp)));
        assert!(e.lamports(&owner.pubkey()) > owner_lamports + order_rent);
    }
}

#[test]
fn sell_fills_and_pays_fee_keeper_and_owner_exactly() {
    for (lp, qp) in COMBOS {
        let mut e = Env::new();
        let m = e.market(lp, qp);
        e.setup(&m);
        let owner = e.trader(&m, 1_000 * M, 0);
        let keeper = e.keeper(&m);
        // Sell 600 L for at least 300 Q (net, after Aretia's fee).
        let order = e.create(&m, &owner, 1, 7, 600 * M, 300 * M).unwrap();
        assert_eq!(e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), 400 * M);

        e.fill(
            &m,
            &keeper,
            1,
            &order,
            &owner.pubkey(),
            600 * M,
            600 * M,
            330 * M,
        )
        .unwrap();

        let fee = ceil_bps(330 * M, SELL_FEE); // 6.6 Q
        let net = 330 * M - fee; // 323.4
        let surplus = net - 300 * M; // 23.4
        let keeper_reward = surplus * KEEPER_SHARE / 10_000; // 4.68
        assert_eq!(e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)), fee);
        assert_eq!(
            e.bal(&ata(&keeper.pubkey(), &m.quote, &m.qp)),
            keeper_reward
        );
        assert_eq!(
            e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)),
            net - keeper_reward
        );
        assert!(!e.exists(&order));
    }
}

#[test]
fn a_fill_below_the_limit_is_refused_and_changes_nothing() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let fee = ceil_bps(1_000 * M, BUY_FEE);
    // One base unit short of the 500 L the owner demanded.
    err_has(
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            1_000 * M,
            1_000 * M - fee,
            500 * M - 1,
        ),
        "LimitNotMet",
    );
    assert_eq!(e.in_remaining(&order), 1_000 * M);
    assert_eq!(e.bal(&ata(&order, &m.quote, &m.qp)), 1_000 * M);
    // Exactly the limit is fine, and the keeper earns nothing.
    e.fill(
        &m,
        &keeper,
        0,
        &order,
        &owner.pubkey(),
        1_000 * M,
        1_000 * M - fee,
        500 * M,
    )
    .unwrap();
    assert_eq!(e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), 500 * M);
    assert_eq!(e.bal(&ata(&keeper.pubkey(), &m.launch, &m.lp)), 0);
}

#[test]
fn the_sell_limit_is_checked_after_the_fee() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 1_000 * M, 0);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 1, 1, 600 * M, 300 * M).unwrap();
    // 300 gross is 294 after the 2% fee: not enough.
    err_has(
        e.fill(
            &m,
            &keeper,
            1,
            &order,
            &owner.pubkey(),
            600 * M,
            600 * M,
            300 * M,
        ),
        "LimitNotMet",
    );
    // The gross that nets exactly 300 after the fee passes.
    let gross = (300 * M * 10_000).div_ceil(10_000 - SELL_FEE) + 1;
    assert!(gross - ceil_bps(gross, SELL_FEE) >= 300 * M);
    e.fill(
        &m,
        &keeper,
        1,
        &order,
        &owner.pubkey(),
        600 * M,
        600 * M,
        gross,
    )
    .unwrap();
}

#[test]
fn partial_fills_keep_the_rate_and_charge_the_fee_once() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e
        .create(&m, &owner, 0, 1, 1_000 * M + 3, 500 * M + 1)
        .unwrap();
    let total = 1_000 * M + 3;
    // A sliver (under 5%) is refused.
    err_has(
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            10 * M,
            10 * M,
            5 * M,
        ),
        "SliceNotAllowed",
    );

    let mut filled = 0u64;
    let mut owner_got = 0u64;
    for slice in [400 * M, 333_333_333u64] {
        let rem = e.in_remaining(&order);
        let mo = e.min_out_remaining(&order);
        let required = (slice as u128 * mo as u128).div_ceil(rem as u128) as u64;
        let fee_due = ceil_bps(filled + slice, BUY_FEE);
        let fee_now = fee_due - e.fee_paid(&order);
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            slice,
            slice - fee_now,
            required + 10,
        )
        .unwrap();
        filled += slice;
        owner_got += required + 10 - (10 * KEEPER_SHARE / 10_000);
        assert_eq!(e.in_remaining(&order), total - filled);
        assert_eq!(e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), owner_got);
    }
    // Fill the rest: the last slice owes exactly what is left, and the whole fee is the ceiling on the total.
    let rest = e.in_remaining(&order);
    let owed = e.min_out_remaining(&order);
    let fee_now = ceil_bps(total, BUY_FEE) - e.fee_paid(&order);
    e.fill(
        &m,
        &keeper,
        0,
        &order,
        &owner.pubkey(),
        rest,
        rest - fee_now,
        owed,
    )
    .unwrap();
    assert_eq!(
        e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)),
        ceil_bps(total, BUY_FEE)
    );
    assert!(!e.exists(&order));
}

#[test]
fn cancel_refunds_all_but_the_cancel_fee() {
    let mut e = Env::new();
    let m = e.market(TOKEN_2022, TOKEN);
    e.setup(&m);
    // Buy: the fee is in the payment asset.
    let owner = e.trader(&m, 1_000 * M, 5_000 * M);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
    let fee = ceil_bps(1_000 * M, CANCEL_FEE); // 5.8 Q
    assert_eq!(e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)), fee);
    assert_eq!(
        e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)),
        5_000 * M - fee
    );
    assert!(!e.exists(&order));
    assert!(!e.exists(&ata(&order, &m.quote, &m.qp)));
    // Sell: the fee is in the launch token, because that is what was escrowed.
    let order = e.create(&m, &owner, 1, 2, 600 * M, 300 * M).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
    let fee_l = ceil_bps(600 * M, CANCEL_FEE);
    assert_eq!(
        e.bal(&ata(&e.fee_recipient.pubkey(), &m.launch, &m.lp)),
        fee_l
    );
    assert_eq!(
        e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)),
        1_000 * M - fee_l
    );
}

#[test]
fn cancelling_after_a_partial_fill_charges_only_the_remainder() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let fee_fill = ceil_bps(400 * M, BUY_FEE);
    e.fill(
        &m,
        &keeper,
        0,
        &order,
        &owner.pubkey(),
        400 * M,
        400 * M - fee_fill,
        200 * M,
    )
    .unwrap();
    let before = e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp));
    e.cancel(&m, &owner, &order).unwrap();
    let fee_cancel = ceil_bps(600 * M, CANCEL_FEE);
    assert_eq!(
        e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)),
        before + fee_cancel
    );
    assert_eq!(
        e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)),
        4_000 * M + 600 * M - fee_cancel
    );
}

#[test]
fn a_frozen_fee_account_cannot_trap_an_owner_s_money() {
    // A stablecoin issuer can freeze Aretia's fee account. A frozen account cannot receive, so the ordinary cancel fails; the
    // owner must still be able to get everything back, but only when the account really is frozen.
    for side in [0u8, 1] {
        let mut e = Env::new();
        let m = e.market(TOKEN, TOKEN);
        e.setup(&m);
        let owner = e.trader(&m, 1_000 * M, 5_000 * M);
        let order = e.create(&m, &owner, side, 1, 600 * M, 300 * M).unwrap();
        let fee_acct = if side == 0 {
            ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)
        } else {
            ata(&e.fee_recipient.pubkey(), &m.launch, &m.lp)
        };
        let waiver = e.cancel_ix_named("cancel_order_fee_frozen", &m, &owner.pubkey(), &order);
        // Not frozen: the waiver is refused.
        err_has(
            e.send(std::slice::from_ref(&waiver), &owner, &[]),
            "FeeAccountNotFrozen",
        );
        e.freeze_account(&fee_acct);
        // Frozen: the ordinary cancel cannot pay the fee, so it fails ...
        assert!(e.cancel(&m, &owner, &order).is_err());
        // ... and the waiver returns everything.
        e.send(&[waiver], &owner, &[]).unwrap();
        assert!(!e.exists(&order));
        let (launch_back, quote_back) = (
            e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)),
            e.bal(&ata(&owner.pubkey(), &m.quote, &m.qp)),
        );
        assert_eq!((launch_back, quote_back), (1_000 * M, 5_000 * M));
        assert_eq!(e.bal(&fee_acct), 0);
    }
}

#[test]
fn only_the_owner_can_cancel_and_a_pause_never_blocks_it() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let thief = e.trader(&m, 0, 0);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    // A different signer cannot cancel by naming the owner's order.
    let ix = {
        let mut ix = e.cancel_ix(&m, &owner.pubkey(), &order);
        ix.accounts[0] = ws(thief.pubkey());
        ix
    };
    assert!(e.send(&[ix], &thief, &[]).is_err());
    let adm = e.admin_kp();
    e.update_config(&adm, 58, 150, 200, 2_000, true).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
}

#[test]
fn the_curve_mint_offset_must_point_past_the_discriminator() {
    let mut e = Env::new();
    e.curve_mint_offset = 7;
    err_has(e.init_config(), "BadCurveLayout");
}

#[test]
fn pause_stops_new_orders_and_fills() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let adm = e.admin_kp();
    e.update_config(&adm, 58, 150, 200, 2_000, true).unwrap();
    err_has(
        e.create(&m, &owner, 0, 2, 1_000 * M, 500 * M).map(|_| ()),
        "Paused",
    );
    let fee = ceil_bps(1_000 * M, BUY_FEE);
    err_has(
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            1_000 * M,
            1_000 * M - fee,
            520 * M,
        ),
        "Paused",
    );
}

#[test]
fn admin_controls_are_admin_only_and_fees_are_capped() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let rando = e.user();
    assert!(e.update_config(&rando, 58, 150, 200, 2_000, false).is_err());
    let adm = e.admin_kp();
    err_has(
        e.update_config(&adm, 101, 150, 200, 2_000, false),
        "FeeAboveCap",
    );
    err_has(
        e.update_config(&adm, 58, 301, 200, 2_000, false),
        "FeeAboveCap",
    );
    err_has(
        e.update_config(&adm, 58, 150, 301, 2_000, false),
        "FeeAboveCap",
    );
    err_has(
        e.update_config(&adm, 58, 150, 200, 5_001, false),
        "FeeAboveCap",
    );
    // The token programs and this program can never be venues: they would let a keeper move the escrow anywhere.
    for bad in [
        a(TOKEN),
        a(TOKEN_2022),
        a(ATA),
        a(SYSTEM),
        a(ORDERS),
        Address::default(),
    ] {
        err_has(e.set_venues(&[bad]), "ForbiddenVenue");
    }
    err_has(e.set_venues(&vec![a(VENUE); 9]), "TooManyVenues");
}

#[test]
fn a_fee_change_does_not_touch_open_orders() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let adm = e.admin_kp();
    e.update_config(&adm, 100, 300, 300, 5_000, false).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
    // Charged at the 0.58% in force when the order was created, not the 1% now.
    assert_eq!(
        e.bal(&ata(&e.fee_recipient.pubkey(), &m.quote, &m.qp)),
        ceil_bps(1_000 * M, CANCEL_FEE)
    );
}

#[test]
fn minimum_order_size_is_enforced_per_side() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m); // minimum is 50 Q
    let owner = e.trader(&m, 1_000 * M, 5_000 * M);
    err_has(
        e.create(&m, &owner, 0, 1, 49 * M, 10 * M).map(|_| ()),
        "BelowMinimum",
    );
    e.create(&m, &owner, 0, 2, 50 * M, 10 * M).unwrap();
    // A sell is measured by what it must deliver in the payment asset.
    err_has(
        e.create(&m, &owner, 1, 3, 500 * M, 49 * M).map(|_| ()),
        "BelowMinimum",
    );
    e.create(&m, &owner, 1, 4, 500 * M, 50 * M).unwrap();
    err_has(
        e.create(&m, &owner, 0, 5, 0, 10 * M).map(|_| ()),
        "ZeroAmount",
    );
    err_has(
        e.create(&m, &owner, 2, 6, 100 * M, 10 * M).map(|_| ()),
        "BadSide",
    );
}

#[test]
fn disabled_assets_and_foreign_tokens_are_refused() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 1_000 * M, 5_000 * M);

    // 1. The payment asset is switched off.
    e.set_asset(&m.quote, &m.qp, 50 * M, false).unwrap();
    err_has(
        e.create(&m, &owner, 0, 1, 100 * M, 10 * M).map(|_| ()),
        "AssetNotEnabled",
    );
    e.set_asset(&m.quote, &m.qp, 50 * M, true).unwrap();

    // 2. A curve account owned by the wrong program does not prove anything.
    let fake = e.plant_curve(&m.launch, &m.lp, &Keypair::new().pubkey());
    let ix = e.create_ix(&m, &owner.pubkey(), &fake, 0, 2, 100 * M, 10 * M);
    err_has(e.send(&[ix], &owner, &[]), "NotALaunchToken");

    // 3. A real curve account, but for a different mint.
    let other = e.make_mint(&a(TOKEN), false, false);
    e.renounce(&other, &a(TOKEN), 0);
    let other_curve = e.plant_curve(&other, &a(TOKEN), &e.curve_program.clone());
    let ix = e.create_ix(&m, &owner.pubkey(), &other_curve, 0, 3, 100 * M, 10 * M);
    err_has(e.send(&[ix], &owner, &[]), "NotALaunchToken");

    // 4. A token whose mint authority was not renounced is refused even with a proof.
    let live = e.make_mint(&a(TOKEN), false, false);
    let live_curve = e.plant_curve(&live, &a(TOKEN), &e.curve_program.clone());
    let m2 = Market {
        launch: live,
        curve: live_curve,
        ..m.clone()
    };
    let fee = e.fee_recipient.pubkey();
    e.make_ata(&fee, &live, &a(TOKEN));
    let ix = e.create_ix(&m2, &owner.pubkey(), &live_curve, 0, 4, 100 * M, 10 * M);
    err_has(e.send(&[ix], &owner, &[]), "LaunchTokenNotFixed");
}

#[test]
fn a_payment_asset_with_a_transfer_fee_extension_is_refused() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let fee_mint = e.make_mint(&a(TOKEN_2022), false, true);
    e.set_asset(&fee_mint, &a(TOKEN_2022), 1, true).unwrap();
    let m2 = Market {
        quote: fee_mint,
        qp: a(TOKEN_2022),
        ..m.clone()
    };
    let owner = e.user();
    e.make_ata(&owner.pubkey(), &fee_mint, &a(TOKEN_2022));
    let ix = e.create_ix(&m2, &owner.pubkey(), &m.curve, 0, 1, 100 * M, 10 * M);
    err_has(e.send(&[ix], &owner, &[]), "UnsupportedMintExtension");
}

#[test]
fn only_whitelisted_venues_can_be_called() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    e.set_venues(&[]).unwrap();
    let fee = ceil_bps(1_000 * M, BUY_FEE);
    err_has(
        e.fill(
            &m,
            &keeper,
            0,
            &order,
            &owner.pubkey(),
            1_000 * M,
            1_000 * M - fee,
            520 * M,
        ),
        "VenueNotAllowed",
    );
    // Naming the token program as the venue, to move the escrow directly, is refused.
    let ix = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(TOKEN),
        1_000 * M,
        vec![3, 0, 0, 0, 0, 0, 0, 0, 0],
        vec![],
    );
    err_has(e.send(&[ix], &keeper, &[]), "VenueNotAllowed");
}

#[test]
fn a_venue_that_spends_more_than_declared_is_refused() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    // Half the order is filled, so the vault still holds more than the fill declared; the venue quietly takes 1 base
    // unit more than the swap amount it was given.
    let slice = 500 * M;
    let swap_in = slice - ceil_bps(slice, BUY_FEE);
    let data = body(
        "swap_overspend",
        &[
            &swap_in.to_le_bytes(),
            &(300 * M).to_le_bytes(),
            &1u64.to_le_bytes(),
        ],
    );
    let ix = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        slice,
        data,
        Env::swap_accounts(&m, 0, &order),
    );
    err_has(e.send(&[ix], &keeper, &[]), "WrongAmountSpent");
    assert_eq!(e.bal(&ata(&order, &m.quote, &m.qp)), 1_000 * M);
}

#[test]
fn a_venue_that_reassigns_the_vault_is_refused() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let attacker = Keypair::new().pubkey();
    let data = body("steal_ownership", &[attacker.as_ref()]);
    let ix = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        1_000 * M,
        data,
        Env::swap_accounts(&m, 0, &order),
    );
    let err = e.send(&[ix], &keeper, &[]).expect_err("must fail");
    assert!(
        err.contains("VaultTampered") || err.contains("Error"),
        "{err}"
    );
    assert_eq!(e.bal(&ata(&order, &m.quote, &m.qp)), 1_000 * M);
}

#[test]
fn a_venue_cannot_call_back_into_the_order_program() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    // The venue is asked to fill the same order again from inside the first fill.
    let inner = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        1_000 * M,
        Env::swap_data(1, 1),
        Env::swap_accounts(&m, 0, &order),
    );
    let mut rest = vec![r(a(ORDERS))];
    rest.extend(inner.accounts.iter().map(|m| AccountMeta {
        pubkey: m.pubkey,
        is_signer: m.is_signer,
        is_writable: m.is_writable,
    }));
    let data = body("reenter", &[&vec_bytes(&inner.data)]);
    let outer = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        1_000 * M,
        data,
        rest,
    );
    // The runtime itself refuses a program being re-entered through another program, before the order's own busy flag
    // (which is the second line of defence) is ever reached.
    let err = e.send(&[outer], &keeper, &[]).expect_err("must fail");
    assert!(
        err.contains("ReentrancyNotAllowed") || err.contains("OrderBusy"),
        "{err}"
    );
}

#[test]
fn stray_deposits_into_a_vault_go_back_to_the_owner() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    // Someone sends launch tokens straight into the order's launch vault.
    let donor = e.trader(&m, 77 * M, 0);
    let mut d = vec![12u8];
    d.extend_from_slice(&(77 * M).to_le_bytes());
    d.push(6);
    let ix = Instruction::new_with_bytes(
        m.lp,
        &d,
        vec![
            w(ata(&donor.pubkey(), &m.launch, &m.lp)),
            r(m.launch),
            w(ata(&order, &m.launch, &m.lp)),
            AccountMeta::new_readonly(donor.pubkey(), true),
        ],
    );
    e.send(&[ix], &donor, &[]).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
    assert_eq!(e.bal(&ata(&owner.pubkey(), &m.launch, &m.lp)), 77 * M);
    assert!(!e.exists(&ata(&order, &m.launch, &m.lp)));
}

#[test]
fn the_fee_and_keeper_accounts_must_be_the_right_ones() {
    let mut e = Env::new();
    let m = e.market(TOKEN, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 1, 1_000 * M, 500 * M).unwrap();
    let fee = ceil_bps(1_000 * M, BUY_FEE);
    // The keeper tries to route Aretia's fee to its own account.
    let mut ix = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        1_000 * M,
        Env::swap_data(1_000 * M - fee, 520 * M),
        Env::swap_accounts(&m, 0, &order),
    );
    ix.accounts[12] = w(ata(&keeper.pubkey(), &m.quote, &m.qp));
    assert!(e.send(&[ix], &keeper, &[]).is_err());
    // The keeper tries to send the owner's proceeds to a different account.
    let thief_acct = ata(&keeper.pubkey(), &m.launch, &m.lp);
    let mut ix = e.fill_ix(
        &m,
        &keeper.pubkey(),
        &order,
        &owner.pubkey(),
        &a(VENUE),
        1_000 * M,
        Env::swap_data(1_000 * M - fee, 520 * M),
        Env::swap_accounts(&m, 0, &order),
    );
    ix.accounts[8] = w(thief_acct);
    assert!(e.send(&[ix], &keeper, &[]).is_err());
}

// ================================================================================================ golden files for the client

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn golden_path(name: &str) -> String {
    format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Compares `actual` with the checked-in file, or rewrites it with `UPDATE_GOLDEN=1`. Files built from random keys (a real
/// account and real logs) are only written, never compared: the client tests read them, and CI checks they exist.
fn check_golden(name: &str, actual: serde_json::Value, compare: bool) {
    let path = golden_path(name);
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let text = std::fs::read_to_string(&path).expect("run once with UPDATE_GOLDEN=1");
    if !compare {
        return;
    }
    let expected: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        actual, expected,
        "{name} differs; if the interface changed on purpose, run with UPDATE_GOLDEN=1"
    );
}

/// The TypeScript client (`packages/launch-solana/src/orders.ts`) must produce byte-identical instructions. Fixed addresses.
#[test]
fn golden_instructions_match_the_checked_in_file() {
    let k = |s: &str| -> Address { a(s) };
    let owner = k("4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX");
    let keeper = k("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
    let launch = k("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
    let quote = k("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    let curve = k("DvvccGEr3tn116hLZWPporfreqhSstWNQMsKLq8x7kqX");
    let fee = k("DWkwVbRZ3WUPSxLdmLdnNeq3rAkrev5vusjkpwrjU4fw");
    let venue = k("5Vq3f4oT2g7sP3k3dQp8b6m1cXyCwK9Gx7B2Dn4Nn1Fh");
    let m = Market {
        launch,
        quote,
        lp: a(TOKEN_2022),
        qp: a(TOKEN),
        curve,
    };
    let mut e = Env::new();
    e.fee_override = Some(fee);
    let order = order_pda(&owner, 7);
    let rest = vec![
        r(order),
        w(k("7JUS7QjF2tR3fxD1RotQ3JHCzH9MAXECCaDXkWfqKLKb")),
        r(k("11111111111111111111111111111111")),
    ];
    let cases: Vec<(&str, Instruction)> = vec![
        (
            "create_order_buy",
            e.create_ix(&m, &owner, &curve, 0, 7, 1_000_000_000, 500_000_000),
        ),
        (
            "create_order_sell",
            e.create_ix(&m, &owner, &curve, 1, 8, 600_000_000, 300_000_000),
        ),
        ("cancel_order", e.cancel_ix(&m, &owner, &order)),
        (
            "cancel_order_fee_frozen",
            e.cancel_ix_named("cancel_order_fee_frozen", &m, &owner, &order),
        ),
        (
            "fill_order",
            e.fill_ix(
                &m,
                &keeper,
                &order,
                &owner,
                &venue,
                400_000_000,
                vec![1, 2, 3, 4],
                rest,
            ),
        ),
    ];
    let actual: Vec<serde_json::Value> = cases
        .iter()
        .map(|(name, ix)| {
            serde_json::json!({
                "name": name,
                "programId": ix.program_id.to_string(),
                "dataHex": hex(&ix.data),
                "accounts": ix.accounts.iter().map(|m| serde_json::json!({
                    "pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    check_golden(
        "golden-instructions.json",
        serde_json::Value::Array(actual),
        true,
    );
}

/// A real `Order` account and the real events, written by the compiled program, for the client's decoders.
#[test]
fn the_order_account_and_events_are_what_the_client_expects() {
    let mut e = Env::new();
    let m = e.market(TOKEN_2022, TOKEN);
    e.setup(&m);
    let owner = e.trader(&m, 0, 5_000 * M);
    let keeper = e.keeper(&m);
    let order = e.create(&m, &owner, 0, 7, 1_000 * M, 500 * M).unwrap();
    let create_logs = e.last_logs.clone();
    let acc = e.svm.get_account(&order).unwrap();
    assert_eq!(
        acc.data.len(),
        235,
        "8-byte discriminator + 227 bytes of fields"
    );
    assert_eq!(&acc.data[..8], &disc_account("Order"));

    let slice = 400 * M;
    let fee = ceil_bps(slice, BUY_FEE);
    e.fill(
        &m,
        &keeper,
        0,
        &order,
        &owner.pubkey(),
        slice,
        slice - fee,
        210 * M,
    )
    .unwrap();
    let fill_logs = e.last_logs.clone();
    let after_fill = e.svm.get_account(&order).unwrap();
    e.cancel(&m, &owner, &order).unwrap();
    let cancel_logs = e.last_logs.clone();

    let strs = |v: &[String]| serde_json::json!(v);
    check_golden(
        "golden-order.json",
        serde_json::json!({
            "programId": ORDERS,
            "order": order.to_string(),
            "owner": owner.pubkey().to_string(),
            "launchMint": m.launch.to_string(),
            "quoteMint": m.quote.to_string(),
            "launchTokenProgram": m.lp.to_string(),
            "quoteTokenProgram": m.qp.to_string(),
            "keeper": keeper.pubkey().to_string(),
            "venue": VENUE,
            "createdDataHex": hex(&acc.data),
            "configDataHex": hex(&e.svm.get_account(&config_pda()).unwrap().data),
            "feeRecipient": e.fee_recipient.pubkey().to_string(),
            "curveProgram": e.curve_program.to_string(),
            "curveMintOffset": e.curve_mint_offset,
            "afterFillDataHex": hex(&after_fill.data),
            "createLogs": strs(&create_logs),
            "fillLogs": strs(&fill_logs),
            "cancelLogs": strs(&cancel_logs),
            "fill": { "slice": slice.to_string(), "aretiaFee": fee.to_string() },
        }),
        false,
    );
}

/// The mainnet set-up instructions (`ordersAdmin.ts`), built by the same functions the tests above execute against the compiled
/// program. Fixed addresses, so the TypeScript builders can be compared byte for byte.
#[test]
fn golden_admin_instructions_match_the_checked_in_file() {
    let k = |s: &str| -> Address { a(s) };
    let deployer = k("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
    let admin = k("4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG");
    let fee = k("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
    let curve_program = k("CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu");
    let usdc = k("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    let venues = [
        k("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
        k("5Vq3f4oT2g7sP3k3dQp8b6m1cXyCwK9Gx7B2Dn4Nn1Fh"),
    ];
    let ixs = [
        (
            "initialize_config",
            init_config_ix(deployer, admin, fee, curve_program, 43, [58, 150, 200, 2000]),
        ),
        ("set_venues", set_venues_ix(admin, &venues)),
        ("set_asset", set_asset_ix(admin, &usdc, 50_000_000, true)),
        ("update_config", update_config_ix(admin, fee, [58, 150, 200, 2000], true)),
    ];
    let actual: Vec<_> = ixs
        .iter()
        .map(|(name, ix)| {
            serde_json::json!({
                "name": name,
                "programId": ix.program_id.to_string(),
                "dataHex": hex(&ix.data),
                "accounts": ix.accounts.iter().map(|m| serde_json::json!({
                    "pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    check_golden(
        "golden-admin-instructions.json",
        serde_json::Value::Array(actual),
        true,
    );
}
