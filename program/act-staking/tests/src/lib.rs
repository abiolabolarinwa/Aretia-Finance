//! Test harness for act-staking: a LiteSVM with the compiled program loaded as an upgradeable program (so its ProgramData
//! account exists and names an upgrade authority), a Token-2022 mint written at the ACT address, and every instruction built
//! by hand, so these tests share no code with the program they check. Complements tests/full-suite.mjs, which needs devnet.
#![allow(dead_code)]

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
pub use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use sha2::{Digest, Sha256};

pub const PROGRAM_ID: Address = Address::from_str_const("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
pub const ACT_MINT: Address = Address::from_str_const("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const UPGRADEABLE_LOADER: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const SOL: u64 = 1_000_000_000;
pub const DECIMALS: u8 = 6;

pub type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn program_so() -> String {
    std::env::var("ACT_STAKING_SO").unwrap_or_else(|_| "target/deploy/act_staking.so".to_string())
}

pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}"))[..8].try_into().unwrap()
}
pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}
pub fn ata(owner: &Address, mint: &Address) -> Address {
    pda(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}
pub fn config_pda() -> Address {
    pda(&[b"config"], &PROGRAM_ID)
}
pub fn vault_authority() -> Address {
    pda(&[b"vault_authority"], &PROGRAM_ID)
}
pub fn user_stake_pda(owner: &Address) -> Address {
    pda(&[b"user_stake", owner.as_ref()], &PROGRAM_ID)
}
pub fn program_data() -> Address {
    pda(&[PROGRAM_ID.as_ref()], &UPGRADEABLE_LOADER)
}
fn m(a: Address, w: bool, s: bool) -> AccountMeta {
    if w { AccountMeta::new(a, s) } else { AccountMeta::new_readonly(a, s) }
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    /// The program's upgrade authority, as its ProgramData account records it.
    pub upgrader: Keypair,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = std::fs::read(program_so()).expect("build the program first: cargo-build-sbf, then set ACT_STAKING_SO");
        svm.add_program(PROGRAM_ID, &bytes).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).unwrap();
        let upgrader = Keypair::new();
        svm.airdrop(&upgrader.pubkey(), 10 * SOL).unwrap();
        let mut env = Env { svm, payer, upgrader };
        let u = env.upgrader.pubkey();
        env.set_upgrade_authority(Some(&u));
        env.write_mint(&ACT_MINT);
        env
    }

    /// Rewrites the upgrade authority in the ProgramData header: tag (4 bytes), slot (8), Option<Pubkey> (1 + 32).
    pub fn set_upgrade_authority(&mut self, who: Option<&Address>) {
        let pd = program_data();
        let mut acc = self.svm.get_account(&pd).expect("program data");
        match who {
            Some(k) => {
                acc.data[12] = 1;
                acc.data[13..45].copy_from_slice(k.as_ref());
            }
            None => {
                acc.data[12] = 0;
                acc.data[13..45].copy_from_slice(&[0u8; 32]);
            }
        }
        self.svm.set_account(pd, acc).unwrap();
    }

    /// A plain Token-2022 mint at `address`, mint authority = the test payer.
    pub fn write_mint(&mut self, address: &Address) {
        let mut d = vec![0u8; 82];
        d[0] = 1; // COption::Some(mint authority)
        d[4..36].copy_from_slice(self.payer.pubkey().as_ref());
        d[44] = DECIMALS;
        d[45] = 1; // initialised
        let lamports = self.svm.minimum_balance_for_rent_exemption(82);
        self.svm.set_account(*address, solana_account::Account { lamports, data: d, owner: TOKEN_2022, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Sent {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.payer.pubkey()), &signers, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }

    pub fn token_amount(&self, a: &Address) -> u64 {
        match self.svm.get_account(a) {
            Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    /// Opens `owner`'s token account for `mint` and mints `amount` into it.
    pub fn fund(&mut self, owner: &Address, mint: &Address, amount: u64) -> Address {
        let payer = self.payer.pubkey();
        let mut mt = vec![7];
        mt.extend_from_slice(&amount.to_le_bytes());
        let to = ata(owner, mint);
        let ixs = [ata_ix(&payer, owner, mint), Instruction::new_with_bytes(TOKEN_2022, &mt, vec![m(*mint, true, false), m(to, true, false), m(payer, false, true)])];
        self.send(&ixs, &[]).expect("fund");
        to
    }

    pub fn set_time(&mut self, unix: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        self.svm.set_sysvar(&c);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp
    }

    pub fn config(&self) -> Config {
        Config::parse(&self.svm.get_account(&config_pda()).expect("config exists").data)
    }
    pub fn user_stake(&self, owner: &Address) -> Option<UserStake> {
        self.svm.get_account(&user_stake_pda(owner)).filter(|a| !a.data.is_empty()).map(|a| UserStake::parse(&a.data))
    }
}

pub fn ata_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction::new_with_bytes(ATA_PROGRAM, &[1], vec![m(*payer, true, true), m(ata(owner, mint), true, false), m(*owner, false, false), m(*mint, false, false), m(SYSTEM, false, false), m(TOKEN_2022, false, false)])
}

#[derive(Debug, Clone)]
pub struct Config {
    pub authority: Address,
    pub mint: Address,
    pub vault: Address,
    pub total_staked: u64,
    pub tiers: [u64; 5],
    pub duration_days: [u16; 4],
    pub duration_multiplier: [u16; 4],
    pub paused: bool,
}
impl Config {
    pub fn parse(d: &[u8]) -> Self {
        let key = |at: usize| Address::new_from_array(d[at..at + 32].try_into().unwrap());
        let u64_ = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().unwrap());
        let u16_ = |at: usize| u16::from_le_bytes(d[at..at + 2].try_into().unwrap());
        let tiers = [u64_(112), u64_(120), u64_(128), u64_(136), u64_(144)];
        Config {
            authority: key(8),
            mint: key(40),
            vault: key(72),
            total_staked: u64_(104),
            tiers,
            duration_days: [u16_(152), u16_(154), u16_(156), u16_(158)],
            duration_multiplier: [u16_(160), u16_(162), u16_(164), u16_(166)],
            paused: d[168] != 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UserStake {
    pub owner: Address,
    pub amount: u64,
    pub lock_days: u16,
    pub staked_at: i64,
    pub unlock_at: i64,
    pub tier: u8,
}
impl UserStake {
    pub fn parse(d: &[u8]) -> Self {
        UserStake {
            owner: Address::new_from_array(d[8..40].try_into().unwrap()),
            amount: u64::from_le_bytes(d[40..48].try_into().unwrap()),
            lock_days: u16::from_le_bytes(d[48..50].try_into().unwrap()),
            staked_at: i64::from_le_bytes(d[50..58].try_into().unwrap()),
            unlock_at: i64::from_le_bytes(d[58..66].try_into().unwrap()),
            tier: d[66],
        }
    }
}

fn tables(tiers: &[u64; 5], days: &[u16; 4], mult: &[u16; 4]) -> Vec<u8> {
    let mut d = vec![];
    for t in tiers { d.extend_from_slice(&t.to_le_bytes()); }
    for x in days { d.extend_from_slice(&x.to_le_bytes()); }
    for x in mult { d.extend_from_slice(&x.to_le_bytes()); }
    d
}

pub fn init_ix(authority: &Address, mint: &Address, tiers: &[u64; 5], days: &[u16; 4], mult: &[u16; 4]) -> Instruction {
    let mut d = disc("initialize_config").to_vec();
    d.extend(tables(tiers, days, mult));
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*authority, true, true),
            m(config_pda(), true, false),
            m(vault_authority(), false, false),
            m(*mint, false, false),
            m(ata(&vault_authority(), mint), true, false),
            m(TOKEN_2022, false, false),
            m(ATA_PROGRAM, false, false),
            m(SYSTEM, false, false),
            m(PROGRAM_ID, false, false),
            m(program_data(), false, false),
        ],
    )
}

pub fn update_ix(authority: &Address, tiers: &[u64; 5], days: &[u16; 4], mult: &[u16; 4]) -> Instruction {
    let mut d = disc("update_tier_config").to_vec();
    d.extend(tables(tiers, days, mult));
    Instruction::new_with_bytes(PROGRAM_ID, &d, vec![m(config_pda(), true, false), m(*authority, false, true)])
}

pub fn stake_ix(owner: &Address, amount: u64, lock_days: u16) -> Instruction {
    let mut d = disc("stake").to_vec();
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&lock_days.to_le_bytes());
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &d,
        vec![
            m(*owner, true, true),
            m(config_pda(), true, false),
            m(user_stake_pda(owner), true, false),
            m(ACT_MINT, false, false),
            m(ata(&vault_authority(), &ACT_MINT), true, false),
            m(ata(owner, &ACT_MINT), true, false),
            m(TOKEN_2022, false, false),
            m(SYSTEM, false, false),
        ],
    )
}

pub fn unstake_ix(owner: &Address) -> Instruction {
    Instruction::new_with_bytes(
        PROGRAM_ID,
        &disc("unstake"),
        vec![
            m(*owner, true, true),
            m(config_pda(), true, false),
            m(user_stake_pda(owner), true, false),
            m(vault_authority(), false, false),
            m(ACT_MINT, false, false),
            m(ata(&vault_authority(), &ACT_MINT), true, false),
            m(ata(owner, &ACT_MINT), true, false),
            m(TOKEN_2022, false, false),
        ],
    )
}
