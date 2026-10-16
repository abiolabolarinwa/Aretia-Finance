//! Test harness: builds a LiteSVM with the compiled curve program (and, if available, Meteora's), makes Token-2022
//! mints the way the Launch page does, and builds every instruction by hand, so these tests do not share code with
//! the program they check.
#![allow(dead_code)]

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
pub use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use sha2::{Digest, Sha256};

pub const PROGRAM_ID: Address = Address::from_str_const("9HVuUHU4mm6PYZFRnY7KzuGsHVSZ8QUVavarJLpJt5f4");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const WSOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
pub const FEE_WALLET: Address = Address::from_str_const("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
pub const METEORA: Address = Address::from_str_const("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const METEORA_POOL_AUTHORITY: Address = Address::from_str_const("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const SOL: u64 = 1_000_000_000;
pub const FEE_BPS: u16 = 58;

pub type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn program_so() -> String {
    std::env::var("ARETIA_CURVE_SO").unwrap_or_else(|_| "C:/cargo-target/aretia-curve/deploy/aretia_curve.so".to_string())
}

/// Meteora's mainnet program binary, dumped with `solana program dump`. Tests that need it skip when it is absent.
pub fn meteora_so() -> Option<String> {
    let p = std::env::var("METEORA_CP_AMM_SO").unwrap_or_else(|_| "C:/cargo-target/fixtures/meteora_cp_amm.so".to_string());
    std::path::Path::new(&p).exists().then_some(p)
}

pub fn disc(name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("global:{name}"));
    h[..8].try_into().unwrap()
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

pub fn ata(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}

pub fn curve_pda(mint: &Address) -> Address {
    pda(&[b"curve", mint.as_ref()], &PROGRAM_ID)
}
pub fn sol_vault_pda(curve: &Address) -> Address {
    pda(&[b"sol_vault", curve.as_ref()], &PROGRAM_ID)
}
pub fn migrator_pda(curve: &Address) -> Address {
    pda(&[b"migrator", curve.as_ref()], &PROGRAM_ID)
}

fn m(a: Address, w: bool, s: bool) -> AccountMeta {
    if w { AccountMeta::new(a, s) } else { AccountMeta::new_readonly(a, s) }
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub has_meteora: bool,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_so()).expect("build the program first: cargo build-sbf");
        let has_meteora = match meteora_so() {
            Some(p) => {
                svm.add_program_from_file(METEORA, p).unwrap();
                true
            }
            None => false,
        };
        // The wrapped-SOL mint exists on every real cluster; a bare LiteSVM has to be given it.
        let mut native = vec![0u8; 82];
        native[44] = 9; // decimals
        native[45] = 1; // initialised
        svm.set_account(
            WSOL,
            solana_account::Account { lamports: 1_461_600, data: native, owner: TOKEN, executable: false, rent_epoch: 0 },
        )
        .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000 * SOL).unwrap();
        // The fee wallet exists on mainnet; give it a balance so a small fee does not trip the rent rule.
        svm.airdrop(&FEE_WALLET, SOL).unwrap();
        Env { svm, payer, has_meteora }
    }

    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Sent {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.payer.pubkey()), &signers, bh);
        // A legacy transaction must fit one packet. Check here so a flow that works in the VM but could never be sent fails the test.
        let size = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
        assert!(size <= 1232, "transaction is {size} bytes, over the 1232-byte limit");
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }

    pub fn lamports(&self, a: &Address) -> u64 {
        self.svm.get_balance(a).unwrap_or(0)
    }

    pub fn token_amount(&self, a: &Address) -> u64 {
        match self.svm.get_account(a) {
            Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub fn curve(&self, mint: &Address) -> CurveState {
        CurveState::parse(&self.svm.get_account(&curve_pda(mint)).expect("curve exists").data)
    }

    pub fn warp_seconds(&mut self, secs: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp += secs;
        self.svm.set_sysvar(&c);
    }
}

#[derive(Debug, Clone)]
pub struct CurveState {
    pub bump: u8,
    pub status: u8,
    pub creator: Address,
    pub mint: Address,
    pub fee_bps: u16,
    pub target: u64,
    pub v_sol0: u64,
    pub curve_tokens: u64,
    pub lp_tokens: u64,
    pub v_sol: u64,
    pub v_tok: u64,
    pub real_sol: u64,
    pub real_tok: u64,
    pub created_at: i64,
    pub sold_out_at: i64,
    pub pool: Address,
}

pub const TRADING: u8 = 0;
pub const SOLD_OUT: u8 = 1;
pub const MIGRATED: u8 = 2;
pub const ABORTED: u8 = 3;

impl CurveState {
    pub fn parse(d: &[u8]) -> Self {
        let mut at = 8;
        let u8_ = |at: &mut usize| { let v = d[*at]; *at += 1; v };
        let u16_ = |at: &mut usize| { let v = u16::from_le_bytes(d[*at..*at + 2].try_into().unwrap()); *at += 2; v };
        let u64_ = |at: &mut usize| { let v = u64::from_le_bytes(d[*at..*at + 8].try_into().unwrap()); *at += 8; v };
        let i64_ = |at: &mut usize| { let v = i64::from_le_bytes(d[*at..*at + 8].try_into().unwrap()); *at += 8; v };
        let key = |at: &mut usize| { let v = Address::new_from_array(d[*at..*at + 32].try_into().unwrap()); *at += 32; v };
        let bump = u8_(&mut at);
        let _sol_bump = u8_(&mut at);
        let status = u8_(&mut at);
        let creator = key(&mut at);
        let mint = key(&mut at);
        let fee_bps = u16_(&mut at);
        let target = u64_(&mut at);
        let v_sol0 = u64_(&mut at);
        let curve_tokens = u64_(&mut at);
        let lp_tokens = u64_(&mut at);
        let v_sol = u64_(&mut at);
        let v_tok = u64_(&mut at);
        let real_sol = u64_(&mut at);
        let real_tok = u64_(&mut at);
        let created_at = i64_(&mut at);
        let sold_out_at = i64_(&mut at);
        let pool = key(&mut at);
        CurveState { bump, status, creator, mint, fee_bps, target, v_sol0, curve_tokens, lp_tokens, v_sol, v_tok, real_sol, real_tok, created_at, sold_out_at, pool }
    }
    pub fn math(&self) -> curve_math::Curve {
        curve_math::Curve { v_sol: self.v_sol, v_tok: self.v_tok, real_sol: self.real_sol, real_tok: self.real_tok }
    }
}

// ---------------------------------------------------------------- token setup, by hand

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MintKind {
    /// What the Launch page makes: fixed supply, no freeze, metadata pointer.
    Launch,
    /// No extension at all.
    Plain,
    MintAuthorityKept,
    FreezeKept,
    /// An extension the curve must refuse.
    NonTransferable,
}

pub fn create_account_ix(from: &Address, new: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
    let mut d = vec![0, 0, 0, 0];
    d.extend_from_slice(&lamports.to_le_bytes());
    d.extend_from_slice(&space.to_le_bytes());
    d.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(SYSTEM, &d, vec![m(*from, true, true), m(*new, true, true)])
}

pub fn ata_ix(payer: &Address, owner: &Address, mint: &Address, token_program: &Address) -> Instruction {
    Instruction::new_with_bytes(
        ATA_PROGRAM,
        &[1],
        vec![m(*payer, true, true), m(ata(owner, mint, token_program), true, false), m(*owner, false, false), m(*mint, false, false), m(SYSTEM, false, false), m(*token_program, false, false)],
    )
}

pub fn token_transfer_ix(from: &Address, to: &Address, authority: &Address, amount: u64, mint: &Address, decimals: u8) -> Instruction {
    let mut d = vec![12];
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(decimals);
    Instruction::new_with_bytes(TOKEN_2022, &d, vec![m(*from, true, false), m(*mint, false, false), m(*to, true, false), m(*authority, false, true)])
}

impl Env {
    /// Makes a Token-2022 mint with `supply` raw tokens, all in `holder`'s associated account.
    pub fn make_mint(&mut self, kind: MintKind, decimals: u8, supply: u64, holder: &Keypair) -> Address {
        let mint = Keypair::new();
        let payer = self.payer.pubkey();
        let space: u64 = match kind {
            MintKind::Launch => 166 + 4 + 64,
            MintKind::NonTransferable => 166 + 4,
            _ => 82,
        };
        let rent = self.svm.minimum_balance_for_rent_exemption(space as usize);
        let mut ixs = vec![create_account_ix(&payer, &mint.pubkey(), rent, space, &TOKEN_2022)];
        match kind {
            MintKind::Launch => {
                let mut d = vec![39, 0];
                d.extend_from_slice(&[0u8; 32]); // no authority over the pointer
                d.extend_from_slice(mint.pubkey().as_ref()); // metadata lives on the mint itself
                ixs.push(Instruction::new_with_bytes(TOKEN_2022, &d, vec![m(mint.pubkey(), true, false)]));
            }
            MintKind::NonTransferable => ixs.push(Instruction::new_with_bytes(TOKEN_2022, &[32], vec![m(mint.pubkey(), true, false)])),
            _ => {}
        }
        // InitializeMint2: decimals, mint authority = payer, freeze authority = payer for FreezeKept.
        let mut d = vec![20, decimals];
        d.extend_from_slice(payer.as_ref());
        if kind == MintKind::FreezeKept {
            d.push(1);
            d.extend_from_slice(payer.as_ref());
        } else {
            d.push(0);
        }
        ixs.push(Instruction::new_with_bytes(TOKEN_2022, &d, vec![m(mint.pubkey(), true, false)]));
        ixs.push(ata_ix(&payer, &holder.pubkey(), &mint.pubkey(), &TOKEN_2022));
        let holder_ata = ata(&holder.pubkey(), &mint.pubkey(), &TOKEN_2022);
        let mut mt = vec![7];
        mt.extend_from_slice(&supply.to_le_bytes());
        ixs.push(Instruction::new_with_bytes(TOKEN_2022, &mt, vec![m(mint.pubkey(), true, false), m(holder_ata, true, false), m(payer, false, true)]));
        if kind != MintKind::MintAuthorityKept {
            // SetAuthority(MintTokens) -> None: the supply is fixed.
            ixs.push(Instruction::new_with_bytes(TOKEN_2022, &[6, 0, 0], vec![m(mint.pubkey(), true, false), m(payer, false, true)]));
        }
        self.send(&ixs, &[&mint]).expect("mint setup");
        mint.pubkey()
    }

    pub fn make_ata(&mut self, owner: &Address, mint: &Address) -> Address {
        let payer = self.payer.pubkey();
        self.send(&[ata_ix(&payer, owner, mint, &TOKEN_2022)], &[]).expect("ata");
        ata(owner, mint, &TOKEN_2022)
    }
}

// ---------------------------------------------------------------- the program's instructions

pub fn create_curve_ix(creator: &Address, mint: &Address, total: u64, target: u64) -> Instruction {
    let curve = curve_pda(mint);
    let mut d = disc("create_curve").to_vec();
    d.extend_from_slice(&total.to_le_bytes());
    d.extend_from_slice(&target.to_le_bytes());
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*creator, true, true),
            m(*mint, false, false),
            m(ata(creator, mint, &TOKEN_2022), true, false),
            m(curve, true, false),
            m(sol_vault_pda(&curve), true, false),
            m(ata(&curve, mint, &TOKEN_2022), true, false),
            m(TOKEN_2022, false, false),
            m(ATA_PROGRAM, false, false),
            m(SYSTEM, false, false),
        ],
    )
}

fn trade_accounts(trader: &Address, mint: &Address, trader_token: &Address, fee_wallet: &Address) -> Vec<AccountMeta> {
    let curve = curve_pda(mint);
    vec![
        m(*trader, true, true),
        m(curve, true, false),
        m(sol_vault_pda(&curve), true, false),
        m(*mint, false, false),
        m(ata(&curve, mint, &TOKEN_2022), true, false),
        m(*trader_token, true, false),
        m(*fee_wallet, true, false),
        m(TOKEN_2022, false, false),
        m(SYSTEM, false, false),
    ]
}

pub fn buy_ix(buyer: &Address, mint: &Address, gross: u64, min_out: u64) -> Instruction {
    buy_ix_with(buyer, mint, &ata(buyer, mint, &TOKEN_2022), &FEE_WALLET, gross, min_out)
}
pub fn buy_ix_with(buyer: &Address, mint: &Address, buyer_token: &Address, fee_wallet: &Address, gross: u64, min_out: u64) -> Instruction {
    let mut d = disc("buy").to_vec();
    d.extend_from_slice(&gross.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    Instruction::new_with_bytes(PROGRAM_ID, &d, trade_accounts(buyer, mint, buyer_token, fee_wallet))
}
pub fn sell_ix(seller: &Address, mint: &Address, tokens: u64, min_out: u64) -> Instruction {
    sell_ix_with(seller, mint, &ata(seller, mint, &TOKEN_2022), &FEE_WALLET, tokens, min_out)
}
pub fn sell_ix_with(seller: &Address, mint: &Address, seller_token: &Address, fee_wallet: &Address, tokens: u64, min_out: u64) -> Instruction {
    let mut d = disc("sell").to_vec();
    d.extend_from_slice(&tokens.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    Instruction::new_with_bytes(PROGRAM_ID, &d, trade_accounts(seller, mint, seller_token, fee_wallet))
}
pub fn abort_ix(caller: &Address, mint: &Address) -> Instruction {
    Instruction::new_with_bytes(PROGRAM_ID, &disc("abort_migration"), vec![m(*caller, false, true), m(curve_pda(mint), true, false)])
}

/// Everything a `migrate` call needs, with Meteora's derived addresses.
pub struct MigrateAccounts {
    pub nft: Keypair,
    pub pool: Address,
    pub position: Address,
    pub nft_account: Address,
    pub vault_a: Address,
    pub vault_b: Address,
}

pub fn meteora_pool(mint: &Address) -> Address {
    let (first, second) = if mint.to_bytes() > WSOL.to_bytes() { (mint, &WSOL) } else { (&WSOL, mint) };
    pda(&[b"cpool", first.as_ref(), second.as_ref()], &METEORA)
}

impl MigrateAccounts {
    pub fn new(mint: &Address) -> Self {
        let nft = Keypair::new();
        let pool = meteora_pool(mint);
        MigrateAccounts {
            position: pda(&[b"position", nft.pubkey().as_ref()], &METEORA),
            nft_account: pda(&[b"position_nft_account", nft.pubkey().as_ref()], &METEORA),
            vault_a: pda(&[b"token_vault", mint.as_ref(), pool.as_ref()], &METEORA),
            vault_b: pda(&[b"token_vault", WSOL.as_ref(), pool.as_ref()], &METEORA),
            pool,
            nft,
        }
    }
}

pub fn migrate_ix(payer: &Address, mint: &Address, a: &MigrateAccounts, rent_budget: u64, liquidity: u128, sqrt_price: u128) -> Instruction {
    let curve = curve_pda(mint);
    let migrator = migrator_pda(&curve);
    let mut d = disc("migrate").to_vec();
    d.extend_from_slice(&rent_budget.to_le_bytes());
    d.extend_from_slice(&liquidity.to_le_bytes());
    d.extend_from_slice(&sqrt_price.to_le_bytes());
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*payer, true, true),
            m(curve, true, false),
            m(sol_vault_pda(&curve), true, false),
            m(*mint, false, false),
            m(ata(&curve, mint, &TOKEN_2022), true, false),
            m(migrator, true, false),
            m(ata(&migrator, mint, &TOKEN_2022), true, false),
            m(WSOL, false, false),
            m(ata(&migrator, &WSOL, &TOKEN), true, false),
            m(a.nft.pubkey(), true, true),
            m(a.nft_account, true, false),
            m(a.position, true, false),
            m(a.pool, true, false),
            m(a.vault_a, true, false),
            m(a.vault_b, true, false),
            m(METEORA_POOL_AUTHORITY, false, false),
            m(pda(&[b"__event_authority"], &METEORA), false, false),
            m(METEORA, false, false),
            m(TOKEN_2022, false, false),
            m(TOKEN, false, false),
            m(ATA_PROGRAM, false, false),
            m(SYSTEM, false, false),
        ],
    )
}

pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut d = vec![2];
    d.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(Address::from_str_const("ComputeBudget111111111111111111111111111111"), &d, vec![])
}

// ---------------------------------------------------------------- Meteora's pool maths (full range), for building migrate arguments

pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

/// sqrt(sol / tokens) in Q64.64, rounded down, and the largest liquidity both amounts can fund over the full range.
pub fn pool_args(sol: u64, tokens: u64) -> (u128, u128) {
    use num_bigint::BigUint;
    use num_traits::ToPrimitive;
    let p2 = (BigUint::from(sol) << 128u32) / BigUint::from(tokens);
    let p = p2.sqrt();
    let pmax = BigUint::from(MAX_SQRT_PRICE);
    let pmin = BigUint::from(MIN_SQRT_PRICE);
    // amount_a = L * (Pmax - P) / (P * Pmax)   =>  L <= a * P * Pmax / (Pmax - P)
    let la = BigUint::from(tokens) * &p * &pmax / (&pmax - &p);
    // amount_b = L * (P - Pmin) / 2^128       =>  L <= b * 2^128 / (P - Pmin)
    let lb = (BigUint::from(sol) << 128u32) / (&p - &pmin);
    let l = la.min(lb);
    // One unit of margin so rounding up inside Meteora cannot ask for more than is there.
    (l.to_u128().expect("liquidity fits") - 1, p.to_u128().expect("price fits"))
}
