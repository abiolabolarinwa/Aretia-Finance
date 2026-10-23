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

pub const PROGRAM_ID: Address = Address::from_str_const("Ak12tX3J3m5rSmWLXUttyDpVAsniszkfvVG1GgWmnuBm");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const WSOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
pub const FEE_WALLET: Address = Address::from_str_const("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
pub const POOL_PROGRAM: Address = Address::from_str_const("4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc");
pub const SOL: u64 = 1_000_000_000;
pub const FEE_BPS: u16 = 58;

pub type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

/// The program binary the tests load: the committed artifact by default, and that artifact must match its `.sha256` record. Another build
/// (a fresh `cargo build-sbf` output) is used only when `ARETIA_ALLOW_OTHER_BUILD=1` is set, so a test run can never silently describe a
/// different binary from the one that is deployed (audit ARETIA-INF-009).
pub fn artifact_so(env_name: &str, committed: &str) -> String {
    let path = match std::env::var(env_name) {
        Ok(p) if !p.is_empty() => p,
        _ => committed.to_string(),
    };
    let same = std::fs::canonicalize(&path).ok().is_some() && std::fs::canonicalize(&path).ok() == std::fs::canonicalize(committed).ok();
    if !same {
        assert!(
            std::env::var("ARETIA_ALLOW_OTHER_BUILD").as_deref() == Ok("1"),
            "{env_name} points at {path}, not the committed artifact {committed}; set ARETIA_ALLOW_OTHER_BUILD=1 to test another build on purpose"
        );
        return path;
    }
    let bytes = std::fs::read(committed).unwrap_or_else(|e| panic!("cannot read {committed}: {e}"));
    let record = std::fs::read_to_string(format!("{committed}.sha256")).unwrap_or_else(|e| panic!("cannot read {committed}.sha256: {e}"));
    let want = record.split_whitespace().next().unwrap_or("").to_lowercase();
    let got = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(got, want, "{committed} does not match its .sha256 record: the artifact and its record are out of step");
    path
}

pub fn program_so() -> String {
    artifact_so("ARETIA_CURVE_GRAD_SO", concat!(env!("CARGO_MANIFEST_DIR"), "/../artifacts/aretia_curve_grad.so"))
}

/// The Aretia Pool program binary the curve graduates into (built from program/aretia-pool).
pub fn pool_so() -> String {
    artifact_so("ARETIA_POOL_SO", concat!(env!("CARGO_MANIFEST_DIR"), "/../../aretia-pool/artifacts/aretia_pool.so"))
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
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_so()).expect("build the program first: cargo build-sbf");
        svm.add_program_from_file(POOL_PROGRAM, pool_so()).expect("build the pool program first (program/aretia-pool)");
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
        Env { svm, payer }
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

/// The Aretia Pool addresses a `migrate` call touches.
pub struct MigrateAccounts {
    pub pool: Address,
    pub pool_sol_vault: Address,
    pub pool_vault: Address,
    pub position: Address,
}

pub fn pool_pda(mint: &Address) -> Address {
    pda(&[b"pool", mint.as_ref()], &POOL_PROGRAM)
}

impl MigrateAccounts {
    /// The pool is opened for the curve's creator, so the position is theirs.
    pub fn new(mint: &Address, creator: &Address) -> Self {
        let pool = pool_pda(mint);
        MigrateAccounts {
            pool_sol_vault: ata(&pool, &WSOL, &TOKEN),
            pool_vault: ata(&pool, mint, &TOKEN_2022),
            position: pda(&[b"position", pool.as_ref(), creator.as_ref()], &POOL_PROGRAM),
            pool,
        }
    }
}

pub fn migrate_ix(payer: &Address, mint: &Address, creator: &Address, a: &MigrateAccounts, rent_budget: u64) -> Instruction {
    let curve = curve_pda(mint);
    let migrator = migrator_pda(&curve);
    let mut d = disc("migrate").to_vec();
    d.extend_from_slice(&rent_budget.to_le_bytes());
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
            m(a.pool, true, false),
            m(a.pool_sol_vault, true, false),
            m(a.pool_vault, true, false),
            m(a.position, true, false),
            m(*creator, false, false),
            m(FEE_WALLET, true, false),
            m(POOL_PROGRAM, false, false),
            m(WSOL, false, false),
            m(ata(&migrator, &WSOL, &TOKEN), true, false),
            m(TOKEN, false, false),
            m(TOKEN_2022, false, false),
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

