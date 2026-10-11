//! On-chain (LiteSVM) tests for act-presale: F-15 (finalize), F-16 (oracle confidence), F-17 (authority handoff).
//! Build first: `cd ../act-presale && cargo build-sbf`.
//! SOL purchases need no ACT reserve or token accounts, so these use plain SPL mints and a hand-built Pyth update account.
mod common;
use common::*;
use solana_account::Account;

const PROGRAM: &str = "5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku";
const PYTH_RECEIVER: &str = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/// Must equal SOL_USD_FEED_ID in the program.
const SOL_USD_FEED_ID: [u8; 32] = [
    239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208, 198, 199, 188, 15, 76, 250, 200,
    194, 128, 181, 109,
];

// PresaleConfig field offsets (after the 8-byte discriminator), from the struct order in lib.rs.
const OFF_TGE_TS: usize = 376;
const OFF_TOTAL_RAISED: usize = 426;
const OFF_TOTAL_ACT_SOLD: usize = 434;
const OFF_RESERVE: usize = 450;
const OFF_STATUS: usize = 458;
const STATUS_ACTIVE: u8 = 0;
const STATUS_FINALIZED: u8 = 1;
const STATUS_REFUNDING: u8 = 2;

const HARD_CAP: u64 = 100_000_000; // 100 USDC (6 dp)
const SOFT_CAP: u64 = 50_000_000;
const SOL_PRICE: i64 = 10_000_000_000; // $100.00000000 (expo -8) => 1 SOL = 100 USDC

struct Presale {
    chain: Chain,
    program: Address,
    authority: Keypair,
    config: Address,
    vault_authority: Address,
    usdc: Address,
    usdt: Address,
    treasury_sol: Address,
    treasury_usdc: Address,
    treasury_usdt: Address,
    price_update: Address,
    start: i64,
    end: i64,
}

impl Presale {
    fn new() -> Self {
        let mut chain = Chain::new();
        let program = a(PROGRAM);
        chain.load(&program, &so("act-presale", "act_presale.so"));
        let authority = chain.funded();
        let treasury_owner = Keypair::new();
        let (act, usdc, usdt) = (chain.create_mint(9), chain.create_mint(6), chain.create_mint(6));
        let pda = |seed: &[u8]| Address::find_program_address(&[seed], &program).0;
        let (config, vault_authority) = (pda(b"presale_config"), pda(b"vault_authority"));
        let treasury_act = chain.create_ata(&treasury_owner.pubkey(), &act);
        let treasury_usdc = chain.create_ata(&treasury_owner.pubkey(), &usdc);
        let treasury_usdt = chain.create_ata(&treasury_owner.pubkey(), &usdt);
        let treasury_sol = Keypair::new().pubkey();

        let now = chain.now();
        let (start, end) = (now - 1_000, now + 10_000);
        let mut args = Vec::new();
        args.extend_from_slice(&10_000u64.to_le_bytes()); // price: 0.01 USDC per ACT
        args.extend_from_slice(&start.to_le_bytes());
        args.extend_from_slice(&end.to_le_bytes());
        for v in [HARD_CAP, SOFT_CAP, 1_000_000u64, HARD_CAP] {
            args.extend_from_slice(&v.to_le_bytes()); // hard, soft, min, max
        }
        args.extend_from_slice(&1_000u16.to_le_bytes()); // tge_bps
        args.extend_from_slice(&30u32.to_le_bytes()); // vesting days
        let init = ix(
            &program,
            "initialize_presale",
            &args,
            vec![
                ws(authority.pubkey()),
                w(config),
                r(vault_authority),
                r(act),
                w(ata(&vault_authority, &act)),
                r(treasury_act),
                r(treasury_sol),
                r(a(TOKEN)),
                r(a(ATA)),
                r(a(SYSTEM)),
            ],
        );
        chain.send(&[init], &[&authority]).expect("initialize_presale");
        for (idx, (mint, treasury)) in [(usdc, treasury_usdc), (usdt, treasury_usdt)].into_iter().enumerate() {
            let ix = ix(
                &program,
                "initialize_payment_currency",
                &[idx as u8],
                vec![
                    ws(authority.pubkey()),
                    w(config),
                    r(vault_authority),
                    r(mint),
                    w(ata(&vault_authority, &mint)),
                    r(treasury),
                    r(a(TOKEN)),
                    r(a(ATA)),
                    r(a(SYSTEM)),
                ],
            );
            chain.send(&[ix], &[&authority]).expect("initialize_payment_currency");
        }
        let mut p = Presale {
            chain,
            program,
            authority,
            config,
            vault_authority,
            usdc,
            usdt,
            treasury_sol,
            treasury_usdc,
            treasury_usdt,
            price_update: Address::new_unique(),
            start,
            end,
        };
        p.set_price(SOL_PRICE, 0);
        p
    }

    /// Writes a `PriceUpdateV2` account (Anchor discriminator, Full verification) published "now".
    fn set_price_full(&mut self, feed: [u8; 32], price: i64, conf: u64, publish_time: i64) {
        let mut d = acct_disc("PriceUpdateV2").to_vec();
        d.extend_from_slice(&[0u8; 32]); // write_authority
        d.push(1); // VerificationLevel::Full
        d.extend_from_slice(&feed);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&(-8i32).to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes()); // publish_time
        d.extend_from_slice(&(publish_time - 1).to_le_bytes()); // prev_publish_time
        d.extend_from_slice(&price.to_le_bytes()); // ema_price
        d.extend_from_slice(&conf.to_le_bytes()); // ema_conf
        d.extend_from_slice(&1u64.to_le_bytes()); // posted_slot
        d.push(0); // PriceUpdateV2::LEN reserves 2 bytes for the verification level
        let lamports = self.chain.rent(d.len());
        self.chain
            .svm
            .set_account(self.price_update, Account { lamports, data: d, owner: a(PYTH_RECEIVER), executable: false, rent_epoch: 0 })
            .unwrap();
    }
    fn set_price(&mut self, price: i64, conf: u64) {
        let now = self.chain.now();
        self.set_price_full(SOL_USD_FEED_ID, price, conf, now);
    }

    fn buy_with_sol(&mut self, buyer: &Keypair, lamports: u64) -> Result<(), String> {
        let buyer_account = Address::find_program_address(&[b"presale_buyer", buyer.pubkey().as_ref()], &self.program).0;
        let ix = ix(
            &self.program,
            "buy_with_sol",
            &lamports.to_le_bytes(),
            vec![ws(buyer.pubkey()), w(self.config), w(buyer_account), w(self.vault_authority), r(self.price_update), r(a(SYSTEM))],
        );
        self.chain.send(&[ix], &[buyer])
    }
    fn refund_sol(&mut self, buyer: &Keypair) -> Result<(), String> {
        let buyer_account = Address::find_program_address(&[b"presale_buyer", buyer.pubkey().as_ref()], &self.program).0;
        let ix = ix(
            &self.program,
            "refund_sol",
            &[],
            vec![ws(buyer.pubkey()), r(self.config), w(buyer_account), r(buyer.pubkey()), w(self.vault_authority), r(a(SYSTEM))],
        );
        self.chain.send(&[ix], &[buyer])
    }
    fn finalize(&mut self, caller: &Keypair) -> Result<(), String> {
        let ix = ix(
            &self.program,
            "finalize",
            &[],
            vec![
                rs(caller.pubkey()),
                w(self.config),
                w(self.vault_authority),
                w(self.treasury_sol),
                r(a(SYSTEM)),
                r(self.usdc),
                r(self.usdt),
                w(ata(&self.vault_authority, &self.usdc)),
                w(ata(&self.vault_authority, &self.usdt)),
                w(self.treasury_usdc),
                w(self.treasury_usdt),
                r(a(TOKEN)),
            ],
        );
        self.chain.send(&[ix], &[caller])
    }
    fn u64_at(&self, off: usize) -> u64 {
        u64::from_le_bytes(self.chain.data(&self.config)[8 + off..16 + off].try_into().unwrap())
    }
    fn status(&self) -> u8 {
        self.chain.data(&self.config)[8 + OFF_STATUS]
    }
    fn go_past_the_end(&mut self) {
        let t = self.end + 1;
        self.chain.set_time(t);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// F-15: who may finalize
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn nobody_can_finalize_while_the_window_is_open_and_the_cap_is_not_reached() {
    let mut p = Presale::new();
    let stranger = p.chain.funded();
    let authority = p.authority.insecure_clone();
    assert_fails_with(p.finalize(&stranger), "PresaleStillOpen");
    assert_fails_with(p.finalize(&authority), "PresaleStillOpen");
    assert_eq!(p.status(), STATUS_ACTIVE);
}

#[test]
fn a_stranger_can_finalize_after_the_end_and_buyers_can_then_refund() {
    // The point of F-15: buyers must be able to get out without depending on the authority key.
    let mut p = Presale::new();
    let (buyer, stranger) = (p.chain.funded(), p.chain.funded());
    let spend = SOL / 10; // 0.1 SOL = 10 USDC, below the 50 USDC soft cap
    let before = p.chain.lamports(&buyer.pubkey());
    p.buy_with_sol(&buyer, spend).unwrap();
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), 10_000_000);
    assert!(p.chain.lamports(&buyer.pubkey()) < before);

    p.go_past_the_end();
    assert_fails_with(p.refund_sol(&buyer), "NotRefunding"); // nothing is refundable until someone finalizes
    p.finalize(&stranger).expect("anyone may finalize after the end");
    assert_eq!(p.status(), STATUS_REFUNDING, "soft cap missed => Refunding");

    let after_finalize = p.chain.lamports(&buyer.pubkey());
    p.refund_sol(&buyer).expect("buyer refund");
    assert_eq!(p.chain.lamports(&buyer.pubkey()), after_finalize + spend, "the buyer gets back exactly what they paid");
    assert_fails_with(p.refund_sol(&buyer), "AlreadyRefunded");
}

#[test]
fn finalize_cannot_be_repeated() {
    let mut p = Presale::new();
    let stranger = p.chain.funded();
    let authority = p.authority.insecure_clone();
    p.go_past_the_end();
    p.finalize(&stranger).unwrap();
    assert_fails_with(p.finalize(&stranger), "PresaleNotActive");
    assert_fails_with(p.finalize(&authority), "PresaleNotActive");
}

#[test]
fn a_stranger_finalizing_after_a_successful_sale_sweeps_funds_only_to_the_configured_treasury() {
    let mut p = Presale::new();
    let (buyer, stranger) = (p.chain.funded(), p.chain.funded());
    p.buy_with_sol(&buyer, SOL / 2).unwrap(); // 0.5 SOL = 50 USDC = soft cap
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), SOFT_CAP);
    let stranger_before = p.chain.lamports(&stranger.pubkey());

    p.go_past_the_end();
    let now = p.chain.now();
    p.finalize(&stranger).unwrap();

    assert_eq!(p.status(), STATUS_FINALIZED);
    assert_eq!(p.u64_at(OFF_TGE_TS) as i64, now, "TGE starts at finalize time (also for a stranger's call)");
    assert_eq!(p.chain.lamports(&p.treasury_sol), SOL / 2, "all escrowed SOL goes to the configured treasury");
    assert_eq!(p.chain.lamports(&p.vault_authority), 0);
    assert_eq!(p.chain.lamports(&stranger.pubkey()), stranger_before, "the caller gains nothing");
}

#[test]
fn a_stranger_cannot_redirect_the_sweep_to_an_account_of_their_choosing() {
    let mut p = Presale::new();
    let (buyer, stranger) = (p.chain.funded(), p.chain.funded());
    p.buy_with_sol(&buyer, SOL / 2).unwrap();
    p.go_past_the_end();
    let thief = Keypair::new().pubkey();
    // same instruction as `finalize`, but with the SOL treasury swapped for the attacker's address
    let ix = ix(
        &p.program,
        "finalize",
        &[],
        vec![
            rs(stranger.pubkey()),
            w(p.config),
            w(p.vault_authority),
            w(thief),
            r(a(SYSTEM)),
            r(p.usdc),
            r(p.usdt),
            w(ata(&p.vault_authority, &p.usdc)),
            w(ata(&p.vault_authority, &p.usdt)),
            w(p.treasury_usdc),
            w(p.treasury_usdt),
            r(a(TOKEN)),
        ],
    );
    assert_fails_with(p.chain.send(&[ix], &[&stranger]), "MismatchedPaymentVault");
    assert_eq!(p.chain.lamports(&thief), 0);
    assert_eq!(p.status(), STATUS_ACTIVE);
}

#[test]
fn at_the_hard_cap_only_the_authority_may_finalize_early() {
    let mut p = Presale::new();
    let (buyer, stranger) = (p.chain.funded(), p.chain.funded());
    let authority = p.authority.insecure_clone();
    p.buy_with_sol(&buyer, SOL).unwrap(); // 1 SOL = 100 USDC = hard cap
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), HARD_CAP);

    assert_fails_with(p.finalize(&stranger), "FinalizeNotPermitted");
    assert_eq!(p.status(), STATUS_ACTIVE);
    p.finalize(&authority).expect("authority may finalize early at the hard cap");
    assert_eq!(p.status(), STATUS_FINALIZED);
}

// ---------------------------------------------------------------------------------------------------------------------
// F-16: oracle confidence
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_tight_confidence_interval_is_accepted() {
    let mut p = Presale::new();
    let buyer = p.chain.funded();
    p.set_price(SOL_PRICE, SOL_PRICE as u64 / 2_000); // 0.05%
    p.buy_with_sol(&buyer, SOL / 10).expect("tight interval");
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), 10_000_000);
}

#[test]
fn a_confidence_interval_of_exactly_one_percent_is_accepted_and_just_above_is_rejected() {
    let mut p = Presale::new();
    let buyer = p.chain.funded();
    p.set_price(SOL_PRICE, SOL_PRICE as u64 / 100); // exactly 1%
    p.buy_with_sol(&buyer, SOL / 10).expect("boundary is inclusive");
    p.set_price(SOL_PRICE, SOL_PRICE as u64 / 100 + 1);
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "OracleConfidenceTooWide");
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), 10_000_000, "the rejected purchase changed nothing");
}

#[test]
fn a_wide_confidence_interval_is_rejected_and_no_funds_move() {
    let mut p = Presale::new();
    let buyer = p.chain.funded();
    p.set_price(SOL_PRICE, SOL_PRICE as u64 / 10); // 10%
    let (sol_before, vault_before) = (p.chain.lamports(&buyer.pubkey()), p.chain.lamports(&p.vault_authority));
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "OracleConfidenceTooWide");
    assert_eq!(p.chain.lamports(&buyer.pubkey()), sol_before);
    assert_eq!(p.chain.lamports(&p.vault_authority), vault_before);
    assert_eq!(p.u64_at(OFF_TOTAL_RAISED), 0);
}

#[test]
fn the_existing_oracle_checks_still_hold() {
    let mut p = Presale::new();
    let buyer = p.chain.funded();
    let now = p.chain.now();
    // stale (older than 60 s)
    p.set_price_full(SOL_USD_FEED_ID, SOL_PRICE, 0, now - 61);
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "InvalidOraclePrice");
    // exactly at the staleness limit is still fine
    p.set_price_full(SOL_USD_FEED_ID, SOL_PRICE, 0, now - 60);
    p.buy_with_sol(&buyer, SOL / 10).expect("60 s old is accepted");
    // wrong feed id
    p.set_price_full([7u8; 32], SOL_PRICE, 0, now);
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "InvalidOraclePrice");
    // non-positive price
    p.set_price(0, 0);
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "InvalidOraclePrice");
    p.set_price(-5, 0);
    assert_fails_with(p.buy_with_sol(&buyer, SOL / 10), "InvalidOraclePrice");
}

// ---------------------------------------------------------------------------------------------------------------------
// Characterization of CURRENT behaviour found while writing these tests (finding F-20; NOT a fix)
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn characterization_f20_sales_are_not_limited_by_the_funded_act_reserve() {
    // `act_reserve_net` is only ever increased by `fund_act_reserve`; neither `buy` nor `buy_with_sol` compares it with
    // `total_act_sold_net`. With nothing funded, a purchase still succeeds and allocates ACT that the vault does not hold.
    // If this test starts failing because a guard was added, that is the fix landing: update/replace it then.
    let mut p = Presale::new();
    let buyer = p.chain.funded();
    assert_eq!(p.u64_at(OFF_RESERVE), 0);
    p.buy_with_sol(&buyer, SOL / 10).expect("purchase succeeds with an empty ACT reserve");
    assert_eq!(p.u64_at(OFF_RESERVE), 0);
    assert!(p.u64_at(OFF_TOTAL_ACT_SOLD) > 0, "ACT was allocated without any reserve backing it");
}

// ---------------------------------------------------------------------------------------------------------------------
// F-17: two-step authority handoff (shared scenarios, run against act-presale)
// ---------------------------------------------------------------------------------------------------------------------

fn subject() -> handoff::Subject {
    let p = Presale::new();
    handoff::Subject { chain: p.chain, program: p.program, config: p.config, authority: p.authority }
}
#[test]
fn propose_does_not_move_control() {
    handoff::propose_does_not_move_control(subject());
}
#[test]
fn only_the_authority_can_propose() {
    handoff::only_the_authority_can_propose(subject());
}
#[test]
fn the_zero_key_is_rejected() {
    handoff::the_zero_key_is_rejected(subject());
}
#[test]
fn only_the_nominee_can_accept() {
    handoff::only_the_nominee_can_accept(subject());
}
#[test]
fn accept_moves_control_and_returns_the_rent() {
    handoff::accept_moves_control_and_returns_the_rent(subject());
}
#[test]
fn rent_must_go_to_the_outgoing_authority() {
    handoff::rent_must_go_to_the_outgoing_authority(subject());
}
#[test]
fn accept_with_nothing_pending_fails() {
    handoff::accept_with_nothing_pending_fails(subject());
}
#[test]
fn cancel_withdraws_the_proposal() {
    handoff::cancel_withdraws_the_proposal(subject());
}
#[test]
fn a_new_proposal_replaces_the_old_one() {
    handoff::a_new_proposal_replaces_the_old_one(subject());
}
#[test]
fn a_mistyped_key_cannot_strand_control() {
    handoff::a_mistyped_key_cannot_strand_control(subject());
}
#[test]
fn the_single_step_instruction_is_gone() {
    handoff::the_single_step_instruction_is_gone(subject());
}
