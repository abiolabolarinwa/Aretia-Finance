//! Test harness: builds a LiteSVM with the compiled pool program, makes Token-2022 mints the way the Launch page does, and
//! builds every instruction by hand, so these tests do not share code with the program they check.
#![allow(dead_code)]

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
pub use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use sha2::{Digest, Sha256};

pub const PROGRAM_ID: Address = Address::from_str_const("4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const FEE_WALLET: Address = Address::from_str_const("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
pub const SOL: u64 = 1_000_000_000;
pub const CREATE_FEE: u64 = 50_000_000;

pub type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn program_so() -> String {
    std::env::var("ARETIA_POOL_SO").unwrap_or_else(|_| "C:/cargo-target/aretia-pool/deploy/aretia_pool.so".to_string())
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

pub fn pool_pda(mint: &Address) -> Address {
    pda(&[b"pool", mint.as_ref()], &PROGRAM_ID)
}
pub fn sol_vault_pda(pool: &Address) -> Address {
    pda(&[b"sol_vault", pool.as_ref()], &PROGRAM_ID)
}
pub fn position_pda(pool: &Address, owner: &Address) -> Address {
    pda(&[b"position", pool.as_ref(), owner.as_ref()], &PROGRAM_ID)
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

    pub fn pool(&self, mint: &Address) -> PoolState {
        PoolState::parse(&self.svm.get_account(&pool_pda(mint)).expect("pool exists").data)
    }

    pub fn position(&self, mint: &Address, owner: &Address) -> PositionState {
        let pool = pool_pda(mint);
        PositionState::parse(&self.svm.get_account(&position_pda(&pool, owner)).expect("position exists").data)
    }
}

#[derive(Debug, Clone)]
pub struct PoolState {
    pub mint: Address,
    pub creator: Address,
    pub fee_bps: u16,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub acc: u128,
    pub fee_reserve: u64,
    pub created_at: i64,
}

impl PoolState {
    pub fn parse(d: &[u8]) -> Self {
        let mut at = 8 + 2;
        let key = |at: &mut usize| { let v = Address::new_from_array(d[*at..*at + 32].try_into().unwrap()); *at += 32; v };
        let mint = key(&mut at);
        let creator = key(&mut at);
        let fee_bps = u16::from_le_bytes(d[at..at + 2].try_into().unwrap());
        at += 2;
        let u64_ = |at: &mut usize| { let v = u64::from_le_bytes(d[*at..*at + 8].try_into().unwrap()); *at += 8; v };
        let (x, y, l) = (u64_(&mut at), u64_(&mut at), u64_(&mut at));
        let acc = u128::from_le_bytes(d[at..at + 16].try_into().unwrap());
        at += 16;
        let fee_reserve = u64_(&mut at);
        let created_at = u64_(&mut at) as i64;
        PoolState { mint, creator, fee_bps, x, y, l, acc, fee_reserve, created_at }
    }
    pub fn math(&self) -> pool_math::Pool {
        pool_math::Pool { x: self.x, y: self.y, l: self.l, fee_bps: self.fee_bps, acc: self.acc, fee_reserve: self.fee_reserve }
    }
}

#[derive(Debug, Clone)]
pub struct PositionState {
    pub pool: Address,
    pub owner: Address,
    pub shares: u64,
    pub locked: u64,
    pub checkpoint: u128,
    pub pending: u64,
}

impl PositionState {
    pub fn parse(d: &[u8]) -> Self {
        let pool = Address::new_from_array(d[8..40].try_into().unwrap());
        let owner = Address::new_from_array(d[40..72].try_into().unwrap());
        let shares = u64::from_le_bytes(d[72..80].try_into().unwrap());
        let locked = u64::from_le_bytes(d[80..88].try_into().unwrap());
        let checkpoint = u128::from_le_bytes(d[88..104].try_into().unwrap());
        let pending = u64::from_le_bytes(d[104..112].try_into().unwrap());
        PositionState { pool, owner, shares, locked, checkpoint, pending }
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
    /// An extension the pool must refuse (non-transferable).
    NonTransferable,
    /// A transfer-fee mint: extension type 1, which the pool must refuse.
    TransferFee,
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

impl Env {
    /// Makes a Token-2022 mint with `supply` raw tokens, all in `holder`'s associated account.
    pub fn make_mint(&mut self, kind: MintKind, decimals: u8, supply: u64, holder: &Keypair) -> Address {
        let mint = Keypair::new();
        let payer = self.payer.pubkey();
        let space: u64 = match kind {
            MintKind::Launch => 166 + 4 + 64,
            MintKind::NonTransferable => 166 + 4,
            MintKind::TransferFee => 166 + 4 + 108,
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
            MintKind::TransferFee => {
                // InitializeTransferFeeConfig: option(config authority), option(withdraw authority), fee bps, maximum fee.
                let mut d = vec![26, 0, 0, 0];
                d.extend_from_slice(&[0, 0, 0, 0]);
                d.extend_from_slice(&0u16.to_le_bytes());
                d.extend_from_slice(&0u64.to_le_bytes());
                ixs.push(Instruction::new_with_bytes(TOKEN_2022, &d, vec![m(mint.pubkey(), true, false)]));
            }
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

    /// Moves tokens between two wallets of a mint (the holder signs), creating the receiver's account if needed.
    pub fn give_tokens(&mut self, mint: &Address, decimals: u8, from: &Keypair, to: &Address, amount: u64) {
        let payer = self.payer.pubkey();
        let to_ata = ata(to, mint, &TOKEN_2022);
        let mut d = vec![12];
        d.extend_from_slice(&amount.to_le_bytes());
        d.push(decimals);
        let t = Instruction::new_with_bytes(TOKEN_2022, &d, vec![m(ata(&from.pubkey(), mint, &TOKEN_2022), true, false), m(*mint, false, false), m(to_ata, true, false), m(from.pubkey(), false, true)]);
        self.send(&[ata_ix(&payer, to, mint, &TOKEN_2022), t], &[from]).expect("give tokens");
    }
}

// ---------------------------------------------------------------- the program's instructions

pub fn create_pool_ix(creator: &Address, owner: &Address, mint: &Address, x0: u64, y0: u64, l0: u64, fee_bps: u16, lock: bool) -> Instruction {
    let pool = pool_pda(mint);
    let mut d = disc("create_pool").to_vec();
    d.extend_from_slice(&x0.to_le_bytes());
    d.extend_from_slice(&y0.to_le_bytes());
    d.extend_from_slice(&l0.to_le_bytes());
    d.extend_from_slice(&fee_bps.to_le_bytes());
    d.push(lock as u8);
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*creator, true, true),
            m(*owner, false, false),
            m(*mint, false, false),
            m(ata(creator, mint, &TOKEN_2022), true, false),
            m(pool, true, false),
            m(sol_vault_pda(&pool), true, false),
            m(ata(&pool, mint, &TOKEN_2022), true, false),
            m(position_pda(&pool, owner), true, false),
            m(FEE_WALLET, true, false),
            m(TOKEN_2022, false, false),
            m(ATA_PROGRAM, false, false),
            m(SYSTEM, false, false),
        ],
    )
}

pub fn swap_ix(trader: &Address, mint: &Address, is_buy: bool, amount_in: u64, min_out: u64) -> Instruction {
    swap_ix_with(trader, mint, &ata(trader, mint, &TOKEN_2022), &FEE_WALLET, is_buy, amount_in, min_out)
}
pub fn swap_ix_with(trader: &Address, mint: &Address, trader_token: &Address, fee_wallet: &Address, is_buy: bool, amount_in: u64, min_out: u64) -> Instruction {
    let pool = pool_pda(mint);
    let mut d = disc("swap").to_vec();
    d.push(is_buy as u8);
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*trader, true, true),
            m(pool, true, false),
            m(sol_vault_pda(&pool), true, false),
            m(*mint, false, false),
            m(ata(&pool, mint, &TOKEN_2022), true, false),
            m(*trader_token, true, false),
            m(*fee_wallet, true, false),
            m(TOKEN_2022, false, false),
            m(SYSTEM, false, false),
        ],
    )
}

fn lp_accounts(owner: &Address, mint: &Address) -> Vec<AccountMeta> {
    let pool = pool_pda(mint);
    vec![
        m(*owner, true, true),
        m(pool, true, false),
        m(sol_vault_pda(&pool), true, false),
        m(*mint, false, false),
        m(ata(&pool, mint, &TOKEN_2022), true, false),
        m(ata(owner, mint, &TOKEN_2022), true, false),
        m(position_pda(&pool, owner), true, false),
        m(TOKEN_2022, false, false),
        m(SYSTEM, false, false),
    ]
}

pub fn add_ix(owner: &Address, mint: &Address, dl: u64, max_tokens: u64, max_sol: u64) -> Instruction {
    let mut d = disc("add_liquidity").to_vec();
    d.extend_from_slice(&dl.to_le_bytes());
    d.extend_from_slice(&max_tokens.to_le_bytes());
    d.extend_from_slice(&max_sol.to_le_bytes());
    Instruction::new_with_bytes(PROGRAM_ID, &d, lp_accounts(owner, mint))
}

pub fn remove_ix(owner: &Address, mint: &Address, dl: u64, min_tokens: u64, min_sol: u64) -> Instruction {
    let mut d = disc("remove_liquidity").to_vec();
    d.extend_from_slice(&dl.to_le_bytes());
    d.extend_from_slice(&min_tokens.to_le_bytes());
    d.extend_from_slice(&min_sol.to_le_bytes());
    Instruction::new_with_bytes(PROGRAM_ID, &d, lp_accounts(owner, mint))
}

pub fn claim_ix(owner: &Address, mint: &Address) -> Instruction {
    claim_ix_for(owner, mint, owner)
}
/// `signer` signs; `position_owner` names whose position is claimed.
pub fn claim_ix_for(signer: &Address, mint: &Address, position_owner: &Address) -> Instruction {
    let pool = pool_pda(mint);
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &disc("claim_fees"),
        vec![m(*signer, true, true), m(pool, true, false), m(sol_vault_pda(&pool), true, false), m(position_pda(&pool, position_owner), true, false), m(SYSTEM, false, false)],
    )
}

pub fn lock_ix(owner: &Address, mint: &Address, amount: u64) -> Instruction {
    let pool = pool_pda(mint);
    let mut d = disc("lock_liquidity").to_vec();
    d.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(PROGRAM_ID, &d, vec![m(*owner, false, true), m(pool, false, false), m(position_pda(&pool, owner), true, false)])
}
