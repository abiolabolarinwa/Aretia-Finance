#![allow(dead_code, clippy::too_many_arguments)]
//! LiteSVM tests: the REAL compiled order program (`cargo build-sbf` first) plus a test-only mock venue
//! (`../aretia-orders-mock-venue`, `cargo build-sbf` there too) and LiteSVM's bundled Token, Token-2022 and
//! associated-token programs. Every instruction is built by hand from the Anchor discriminators and Borsh layout, so this
//! exercises the on-chain interface exactly as a client would.
//!
//! Money in these tests: both tokens have 6 decimals. Launch token = "L", payment asset = "Q" (a USDC-like asset that
//! has a freeze authority, which the program must accept).

pub mod web;

use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const ORDERS: &str = "Fnb5FELt2BGQLzXdKc1pFTJThdYuZQwaamLVpc8pGPKH";
pub const VENUE: &str = "9npegSLYYqdF6ugKsXVnCsEHBV1XDAtsA8dXQEQnDxNn";
pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM: &str = "11111111111111111111111111111111";
pub const LOADER_V3: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
pub const SOL: u64 = 1_000_000_000;
pub const M: u64 = 1_000_000; // one whole token

pub fn dup(k: &Keypair) -> Keypair {
    Keypair::new_from_array(k.to_bytes()[..32].try_into().unwrap())
}
pub fn a(s: &str) -> Address {
    s.parse().unwrap()
}
pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}
pub fn w(k: Address) -> AccountMeta {
    AccountMeta::new(k, false)
}
pub fn r(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
pub fn ws(k: Address) -> AccountMeta {
    AccountMeta::new(k, true)
}
pub fn ata(owner: &Address, mint: &Address, tp: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), tp.as_ref(), mint.as_ref()], &a(ATA)).0
}
pub fn config_pda() -> Address {
    Address::find_program_address(&[b"config"], &a(ORDERS)).0
}
pub fn asset_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"asset", mint.as_ref()], &a(ORDERS)).0
}
pub fn order_pda(owner: &Address, nonce: u64) -> Address {
    Address::find_program_address(
        &[b"order", owner.as_ref(), &nonce.to_le_bytes()],
        &a(ORDERS),
    )
    .0
}
pub fn venue_authority() -> Address {
    Address::find_program_address(&[b"venue"], &a(VENUE)).0
}
pub fn body(name: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut d = disc(name).to_vec();
    for x in args {
        d.extend_from_slice(x);
    }
    d
}
pub fn vec_bytes(b: &[u8]) -> Vec<u8> {
    let mut v = (b.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(b);
    v
}

/// A token pair with its programs. `lp`/`qp` are the token programs of the launch and payment mints.
#[derive(Clone)]
pub struct Market {
    pub launch: Address,
    pub quote: Address,
    pub lp: Address,
    pub qp: Address,
    pub curve: Address,
}

pub struct Env {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub admin: Keypair,
    pub fee_recipient: Keypair,
    pub curve_program: Address,
    /// Where the curve account stores its mint: 9 for the planted test layout, 43 for the web wallet's curve.
    pub curve_mint_offset: u16,
    pub mint_auth: Keypair,
    /// Replaces the fee recipient's address in instruction builders (for golden files with fixed addresses).
    pub fee_override: Option<Address>,
    /// Program logs of the last transaction, successful or not.
    pub last_logs: Vec<String>,
    /// Compute units the last successful transaction used.
    pub last_cu: u64,
}

pub const BUY_FEE: u64 = 150;
pub const SELL_FEE: u64 = 200;
pub const CANCEL_FEE: u64 = 58;
pub const KEEPER_SHARE: u64 = 2_000;

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let dir = env!("CARGO_MANIFEST_DIR");
        svm.add_program_from_file(a(ORDERS), format!("{dir}/target/deploy/aretia_orders.so"))
            .expect("run `cargo build-sbf` before `cargo test`");
        svm.add_program_from_file(
            a(VENUE),
            format!("{dir}/../aretia-orders-mock-venue/target/deploy/aretia_orders_mock_venue.so"),
        )
        .expect("run `cargo build-sbf` in programs/aretia-orders-mock-venue first");
        let mut e = Env {
            svm,
            upgrade_authority: Keypair::new(),
            admin: Keypair::new(),
            fee_recipient: Keypair::new(),
            curve_program: Keypair::new().pubkey(),
            curve_mint_offset: 9,
            mint_auth: Keypair::new(),
            fee_override: None,
            last_logs: Vec::new(),
            last_cu: 0,
        };
        for k in [&e.upgrade_authority, &e.admin, &e.mint_auth] {
            e.svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
        }
        // LiteSVM deploys with no upgrade authority; write one into ProgramData (loader v3: u32 tag, u64 slot, Option<Pubkey>).
        let pd = Address::find_program_address(&[a(ORDERS).as_ref()], &a(LOADER_V3)).0;
        let mut acc = e.svm.get_account(&pd).unwrap();
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(e.upgrade_authority.pubkey().as_ref());
        e.svm.set_account(pd, acc).unwrap();
        e
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(m) => {
                self.last_logs = m.logs;
                self.last_cu = m.compute_units_consumed;
                Ok(())
            }
            Err(e) => {
                self.last_logs = e.meta.logs.clone();
                Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
            }
        }
    }
    pub fn fee_addr(&self) -> Address {
        self.fee_override.unwrap_or(self.fee_recipient.pubkey())
    }
    pub fn user(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
        k
    }
    pub fn lamports(&self, k: &Address) -> u64 {
        self.svm.get_account(k).map(|x| x.lamports).unwrap_or(0)
    }
    pub fn exists(&self, k: &Address) -> bool {
        self.svm
            .get_account(k)
            .map(|x| x.lamports > 0)
            .unwrap_or(false)
    }
    pub fn bal(&self, k: &Address) -> u64 {
        self.svm
            .get_account(k)
            .map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap()))
            .unwrap_or(0)
    }
    pub fn order_field(&self, order: &Address, off: usize) -> u64 {
        let d = self.svm.get_account(order).unwrap().data;
        u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
    }
    // order layout: 8 disc | owner | launch | quote | ltp | qtp (5 x 32) | side u8 | nonce | in_total | in_rem | min_out_rem | fee_base | fee_paid
    pub fn in_remaining(&self, o: &Address) -> u64 {
        self.order_field(o, 185)
    }
    pub fn min_out_remaining(&self, o: &Address) -> u64 {
        self.order_field(o, 193)
    }
    pub fn fee_paid(&self, o: &Address) -> u64 {
        self.order_field(o, 209)
    }

    // ------------------------------------------------------------------------------------------ tokens

    /// `ext`: add a Token-2022 TransferFeeConfig extension (a mint the program must refuse).
    pub fn make_mint(&mut self, tp: &Address, freeze: bool, ext: bool) -> Address {
        let mint = Keypair::new();
        let c = self.mint_auth.pubkey();
        let space: u64 = if ext { 278 } else { 82 };
        let rent = self.svm.minimum_balance_for_rent_exemption(space as usize);
        let mut create = vec![0u8, 0, 0, 0];
        create.extend_from_slice(&rent.to_le_bytes());
        create.extend_from_slice(&space.to_le_bytes());
        create.extend_from_slice(tp.as_ref());
        let mut ixs = vec![Instruction::new_with_bytes(
            a(SYSTEM),
            &create,
            vec![ws(c), ws(mint.pubkey())],
        )];
        if ext {
            let mut d = vec![26u8, 0, 1];
            d.extend_from_slice(c.as_ref());
            d.push(1);
            d.extend_from_slice(c.as_ref());
            d.extend_from_slice(&100u16.to_le_bytes());
            d.extend_from_slice(&u64::MAX.to_le_bytes());
            ixs.push(Instruction::new_with_bytes(*tp, &d, vec![w(mint.pubkey())]));
        }
        let mut init = vec![20u8, 6];
        init.extend_from_slice(c.as_ref());
        if freeze {
            init.push(1);
            init.extend_from_slice(c.as_ref());
        } else {
            init.push(0);
        }
        ixs.push(Instruction::new_with_bytes(
            *tp,
            &init,
            vec![w(mint.pubkey())],
        ));
        let payer = dup(&self.mint_auth);
        self.send(&ixs, &payer, &[&mint]).unwrap();
        mint.pubkey()
    }
    pub fn make_ata(&mut self, owner: &Address, mint: &Address, tp: &Address) -> Address {
        let addr = ata(owner, mint, tp);
        let payer = dup(&self.mint_auth);
        let ix = Instruction::new_with_bytes(
            a(ATA),
            &[1],
            vec![
                ws(payer.pubkey()),
                w(addr),
                r(*owner),
                r(*mint),
                r(a(SYSTEM)),
                r(*tp),
            ],
        );
        self.send(&[ix], &payer, &[]).unwrap();
        addr
    }
    /// Credits a token account directly (the launch mints have their mint authority renounced at creation, as in real life,
    /// so supply is written into the account state instead of minted).
    pub fn mint_to(&mut self, mint: &Address, _tp: &Address, dest: &Address, amount: u64) {
        let mut acc = self.svm.get_account(dest).unwrap();
        let cur = u64::from_le_bytes(acc.data[64..72].try_into().unwrap());
        acc.data[64..72].copy_from_slice(&(cur + amount).to_le_bytes());
        self.svm.set_account(*dest, acc).unwrap();
        let mut m = self.svm.get_account(mint).unwrap();
        let sup = u64::from_le_bytes(m.data[36..44].try_into().unwrap());
        m.data[36..44].copy_from_slice(&(sup + amount).to_le_bytes());
        self.svm.set_account(*mint, m).unwrap();
    }
    pub fn renounce(&mut self, mint: &Address, tp: &Address, kind: u8) {
        let payer = dup(&self.mint_auth);
        let ix = Instruction::new_with_bytes(
            *tp,
            &[6u8, kind, 0],
            vec![w(*mint), AccountMeta::new_readonly(payer.pubkey(), true)],
        );
        self.send(&[ix], &payer, &[]).unwrap();
    }
    pub fn plant_curve(&mut self, mint: &Address, tp: &Address, owner: &Address) -> Address {
        let k = Keypair::new().pubkey();
        let mut data = disc_account("Curve").to_vec();
        data.push(1);
        data.extend_from_slice(mint.as_ref());
        data.extend_from_slice(Keypair::new().pubkey().as_ref());
        data.extend_from_slice(tp.as_ref());
        data.extend_from_slice(&[0u8; 200]);
        self.svm
            .set_account(
                k,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: *owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        k
    }

    /// A launch token (renounced) and a payment asset, a planted curve account, and a funded venue and fee recipient.
    pub fn market(&mut self, lp: &str, qp: &str) -> Market {
        let (lp, qp) = (a(lp), a(qp));
        let launch = self.make_mint(&lp, false, false);
        self.renounce(&launch, &lp, 0);
        let quote = self.make_mint(&qp, true, false);
        let curve = self.plant_curve(&launch, &lp, &self.curve_program.clone());
        let m = Market {
            launch,
            quote,
            lp,
            qp,
            curve,
        };
        let fee = self.fee_recipient.pubkey();
        self.make_ata(&fee, &m.launch, &m.lp);
        self.make_ata(&fee, &m.quote, &m.qp);
        let va = venue_authority();
        for (mint, tp) in [(m.launch, m.lp), (m.quote, m.qp)] {
            let acct = self.make_ata(&va, &mint, &tp);
            self.mint_to(&mint, &tp, &acct, 10_000_000 * M);
        }
        m
    }

    // ------------------------------------------------------------------------------------------ program instructions

    /// Initialises the config as the program's upgrade authority.
    pub fn init_config(&mut self) -> Result<(), String> {
        let ua = dup(&self.upgrade_authority);
        let ix = init_config_ix(
            ua.pubkey(),
            self.admin.pubkey(),
            self.fee_recipient.pubkey(),
            self.curve_program,
            self.curve_mint_offset,
            [CANCEL_FEE as u16, BUY_FEE as u16, SELL_FEE as u16, KEEPER_SHARE as u16],
        );
        self.send(&[ix], &ua, &[])
    }
    pub fn setup(&mut self, m: &Market) {
        self.init_config().unwrap();
        self.set_venues(&[a(VENUE)]).unwrap();
        self.set_asset(&m.quote, &m.qp, 50 * M, true).unwrap();
    }
    pub fn admin_kp(&self) -> Keypair {
        dup(&self.admin)
    }
    pub fn set_venues(&mut self, venues: &[Address]) -> Result<(), String> {
        let adm = self.admin_kp();
        let ix = set_venues_ix(adm.pubkey(), venues);
        self.send(&[ix], &adm, &[])
    }
    pub fn set_asset(
        &mut self,
        mint: &Address,
        tp: &Address,
        min: u64,
        enabled: bool,
    ) -> Result<(), String> {
        let _ = tp;
        let adm = self.admin_kp();
        let ix = set_asset_ix(adm.pubkey(), mint, min, enabled);
        self.send(&[ix], &adm, &[])
    }
    pub fn update_config(
        &mut self,
        signer: &Keypair,
        cancel: u16,
        buy: u16,
        sell: u16,
        keeper: u16,
        paused: bool,
    ) -> Result<(), String> {
        let ix = update_config_ix(
            signer.pubkey(),
            self.fee_recipient.pubkey(),
            [cancel, buy, sell, keeper],
            paused,
        );
        self.send(&[ix], signer, &[])
    }

    /// A funded trader with token accounts for both mints.
    pub fn trader(&mut self, m: &Market, launch: u64, quote: u64) -> Keypair {
        let u = self.user();
        let ul = self.make_ata(&u.pubkey(), &m.launch, &m.lp);
        let uq = self.make_ata(&u.pubkey(), &m.quote, &m.qp);
        self.mint_to(&m.launch, &m.lp, &ul, launch);
        self.mint_to(&m.quote, &m.qp, &uq, quote);
        u
    }

    pub fn create_ix(
        &self,
        m: &Market,
        owner: &Address,
        curve: &Address,
        side: u8,
        nonce: u64,
        amount_in: u64,
        min_out: u64,
    ) -> Instruction {
        let order = order_pda(owner, nonce);
        Instruction::new_with_bytes(
            a(ORDERS),
            &body(
                "create_order",
                &[
                    &[side],
                    &nonce.to_le_bytes(),
                    &amount_in.to_le_bytes(),
                    &min_out.to_le_bytes(),
                ],
            ),
            vec![
                ws(*owner),
                r(config_pda()),
                r(asset_pda(&m.quote)),
                w(order),
                r(m.launch),
                r(m.quote),
                r(*curve),
                w(ata(owner, &m.launch, &m.lp)),
                w(ata(owner, &m.quote, &m.qp)),
                w(ata(&order, &m.launch, &m.lp)),
                w(ata(&order, &m.quote, &m.qp)),
                r(m.lp),
                r(m.qp),
                r(a(ATA)),
                r(a(SYSTEM)),
            ],
        )
    }
    pub fn create(
        &mut self,
        m: &Market,
        owner: &Keypair,
        side: u8,
        nonce: u64,
        amount_in: u64,
        min_out: u64,
    ) -> Result<Address, String> {
        let ix = self.create_ix(
            m,
            &owner.pubkey(),
            &m.curve,
            side,
            nonce,
            amount_in,
            min_out,
        );
        self.send(&[ix], owner, &[])?;
        Ok(order_pda(&owner.pubkey(), nonce))
    }

    /// Venue data for the mock `swap`.
    pub fn swap_data(spend: u64, out: u64) -> Vec<u8> {
        body("swap", &[&spend.to_le_bytes(), &out.to_le_bytes()])
    }
    /// The accounts the mock venue needs for a swap on this order, in its order.
    pub fn swap_accounts(m: &Market, side: u8, order: &Address) -> Vec<AccountMeta> {
        let va = venue_authority();
        let (l_vault, q_vault) = (ata(order, &m.launch, &m.lp), ata(order, &m.quote, &m.qp));
        let (l_venue, q_venue) = (ata(&va, &m.launch, &m.lp), ata(&va, &m.quote, &m.qp));
        if side == 0 {
            // buy: pay quote, receive launch
            vec![
                r(*order),
                w(q_vault),
                w(q_venue),
                w(l_venue),
                w(l_vault),
                r(va),
                r(m.quote),
                r(m.launch),
                r(m.qp),
                r(m.lp),
            ]
        } else {
            vec![
                r(*order),
                w(l_vault),
                w(l_venue),
                w(q_venue),
                w(q_vault),
                r(va),
                r(m.launch),
                r(m.quote),
                r(m.lp),
                r(m.qp),
            ]
        }
    }
    pub fn fill_ix(
        &self,
        m: &Market,
        keeper: &Address,
        order: &Address,
        owner: &Address,
        venue_prog: &Address,
        slice: u64,
        data: Vec<u8>,
        rest: Vec<AccountMeta>,
    ) -> Instruction {
        let fee = self.fee_addr();
        let mut accounts = vec![
            AccountMeta::new_readonly(*keeper, true),
            r(config_pda()),
            w(*order),
            w(*owner),
            r(m.launch),
            r(m.quote),
            w(ata(order, &m.launch, &m.lp)),
            w(ata(order, &m.quote, &m.qp)),
            w(ata(owner, &m.launch, &m.lp)),
            w(ata(owner, &m.quote, &m.qp)),
            w(ata(keeper, &m.launch, &m.lp)),
            w(ata(keeper, &m.quote, &m.qp)),
            w(ata(&fee, &m.quote, &m.qp)),
            r(*venue_prog),
            r(m.lp),
            r(m.qp),
        ];
        accounts.extend(rest);
        Instruction::new_with_bytes(
            a(ORDERS),
            &body("fill_order", &[&slice.to_le_bytes(), &vec_bytes(&data)]),
            accounts,
        )
    }
    /// A keeper with token accounts, who fills `slice` through the mock venue, which delivers `out`.
    pub fn fill(
        &mut self,
        m: &Market,
        keeper: &Keypair,
        side: u8,
        order: &Address,
        owner: &Address,
        slice: u64,
        spend: u64,
        out: u64,
    ) -> Result<(), String> {
        let ix = self.fill_ix(
            m,
            &keeper.pubkey(),
            order,
            owner,
            &a(VENUE),
            slice,
            Self::swap_data(spend, out),
            Self::swap_accounts(m, side, order),
        );
        self.send(&[ix], keeper, &[])
    }
    pub fn keeper(&mut self, m: &Market) -> Keypair {
        let k = self.user();
        self.make_ata(&k.pubkey(), &m.launch, &m.lp);
        self.make_ata(&k.pubkey(), &m.quote, &m.qp);
        k
    }
    pub fn cancel_ix(&self, m: &Market, owner: &Address, order: &Address) -> Instruction {
        self.cancel_ix_named("cancel_order", m, owner, order)
    }
    pub fn cancel_ix_named(
        &self,
        name: &str,
        m: &Market,
        owner: &Address,
        order: &Address,
    ) -> Instruction {
        let fee = self.fee_addr();
        Instruction::new_with_bytes(
            a(ORDERS),
            &body(name, &[]),
            vec![
                ws(*owner),
                r(config_pda()),
                w(*order),
                r(m.launch),
                r(m.quote),
                w(ata(order, &m.launch, &m.lp)),
                w(ata(order, &m.quote, &m.qp)),
                w(ata(owner, &m.launch, &m.lp)),
                w(ata(owner, &m.quote, &m.qp)),
                w(ata(&fee, &m.quote, &m.qp)),
                w(ata(&fee, &m.launch, &m.lp)),
                r(m.lp),
                r(m.qp),
            ],
        )
    }
    pub fn cancel(&mut self, m: &Market, owner: &Keypair, order: &Address) -> Result<(), String> {
        let ix = self.cancel_ix(m, &owner.pubkey(), order);
        self.send(&[ix], owner, &[])
    }
}

pub fn disc_account(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}

pub fn err_has(r: Result<(), String>, needle: &str) {
    let e = r.expect_err("expected the transaction to fail");
    assert!(
        e.contains(needle),
        "expected error containing {needle:?}, got:\n{e}"
    );
}

pub fn ceil_bps(x: u64, bps: u64) -> u64 {
    (x * bps).div_ceil(10_000)
}

/// All four combinations of token program for the launch and payment mints.
pub const COMBOS: [(&str, &str); 4] = [
    (TOKEN, TOKEN),
    (TOKEN_2022, TOKEN),
    (TOKEN, TOKEN_2022),
    (TOKEN_2022, TOKEN_2022),
];

impl Env {
    /// Freezes a token account, as a token issuer can (state byte 2 at offset 108).
    pub fn freeze_account(&mut self, acct: &Address) {
        let mut a = self.svm.get_account(acct).unwrap();
        a.data[108] = 2;
        self.svm.set_account(*acct, a).unwrap();
    }
}

impl Env {
    /// True if the order account at `order` is a buy (side byte 0 after the 160 bytes of keys).
    pub fn order_is_buy(&self, order: &Address) -> bool {
        self.svm.get_account(order).unwrap().data[8 + 160] == 0
    }
}

// ---------------------------------------------------------------------------------------------- admin instruction builders
// Shared by the Env helpers (which execute them against the compiled program) and the golden file the TypeScript client is
// checked against, so the two cannot drift apart.

#[allow(clippy::too_many_arguments)]
pub fn init_config_ix(
    authority: Address,
    admin: Address,
    fee_recipient: Address,
    curve_program: Address,
    curve_mint_offset: u16,
    fees: [u16; 4],
) -> Instruction {
    let pd = Address::find_program_address(&[a(ORDERS).as_ref()], &a(LOADER_V3)).0;
    Instruction::new_with_bytes(
        a(ORDERS),
        &body(
            "initialize_config",
            &[
                admin.as_ref(),
                fee_recipient.as_ref(),
                curve_program.as_ref(),
                &curve_mint_offset.to_le_bytes(),
                &fees[0].to_le_bytes(),
                &fees[1].to_le_bytes(),
                &fees[2].to_le_bytes(),
                &fees[3].to_le_bytes(),
            ],
        ),
        vec![
            ws(authority),
            w(config_pda()),
            r(a(ORDERS)),
            r(pd),
            r(a(SYSTEM)),
        ],
    )
}

pub fn set_venues_ix(admin: Address, venues: &[Address]) -> Instruction {
    let mut v = (venues.len() as u32).to_le_bytes().to_vec();
    for x in venues {
        v.extend_from_slice(x.as_ref());
    }
    Instruction::new_with_bytes(
        a(ORDERS),
        &body("set_venues", &[&v]),
        vec![AccountMeta::new_readonly(admin, true), w(config_pda())],
    )
}

pub fn set_asset_ix(admin: Address, mint: &Address, min: u64, enabled: bool) -> Instruction {
    Instruction::new_with_bytes(
        a(ORDERS),
        &body("set_asset", &[&min.to_le_bytes(), &[enabled as u8]]),
        vec![
            ws(admin),
            r(config_pda()),
            r(*mint),
            w(asset_pda(mint)),
            r(a(SYSTEM)),
        ],
    )
}

pub fn update_config_ix(admin: Address, fee_recipient: Address, fees: [u16; 4], paused: bool) -> Instruction {
    Instruction::new_with_bytes(
        a(ORDERS),
        &body(
            "update_config",
            &[
                fee_recipient.as_ref(),
                &fees[0].to_le_bytes(),
                &fees[1].to_le_bytes(),
                &fees[2].to_le_bytes(),
                &fees[3].to_le_bytes(),
                &[paused as u8],
            ],
        ),
        vec![AccountMeta::new_readonly(admin, true), w(config_pda())],
    )
}
