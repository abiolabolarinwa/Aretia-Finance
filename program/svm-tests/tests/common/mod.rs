//! Shared LiteSVM helpers. Every instruction is built by hand from the Anchor discriminator and Borsh layout, so these
//! tests exercise the real on-chain interface, not the Rust types.
#![allow(dead_code)]

pub mod handoff;

use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
pub use solana_address::Address;
use solana_clock::Clock;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
use solana_transaction::Transaction;

pub const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM: &str = "11111111111111111111111111111111";
pub const SOL: u64 = 1_000_000_000;

pub fn a(s: &str) -> Address {
    s.parse().unwrap()
}
pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8].try_into().unwrap()
}
pub fn acct_disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}").as_bytes())[..8].try_into().unwrap()
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
pub fn rs(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, true)
}
pub fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), a(TOKEN).as_ref(), mint.as_ref()], &a(ATA)).0
}
/// Associated token account address for any token program (classic Token or Token-2022).
pub fn ata_with(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &a(ATA)).0
}
pub fn ix(program: &Address, name: &str, args: &[u8], metas: Vec<AccountMeta>) -> Instruction {
    let mut data = disc(name).to_vec();
    data.extend_from_slice(args);
    Instruction::new_with_bytes(*program, &data, metas)
}
pub fn so(program_dir: &str, file: &str) -> String {
    format!("{}/../{}/target/deploy/{}", env!("CARGO_MANIFEST_DIR"), program_dir, file)
}

pub struct Chain {
    pub svm: LiteSVM,
    /// Pays every transaction fee, so lamport balances of the parties under test change only by what the program does.
    pub fee_payer: Keypair,
}

impl Chain {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let fee_payer = Keypair::new();
        svm.airdrop(&fee_payer.pubkey(), 1_000 * SOL).unwrap();
        let mut c = Chain { svm, fee_payer };
        c.set_time(1_800_000_000);
        c
    }
    pub fn load(&mut self, program: &Address, path: &str) {
        self.svm
            .add_program_from_file(*program, path)
            .unwrap_or_else(|e| panic!("cannot load {path}: {e:?} -- run `cargo build-sbf` in the program directory first"));
    }
    pub fn set_time(&mut self, t: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = t;
        self.svm.set_sysvar(&clock);
    }
    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }
    /// Sends one transaction. `Err` carries the program logs so tests can match on Anchor's `Error Code: <Name>`.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut all: Vec<&Keypair> = vec![&self.fee_payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.fee_payer.pubkey()), &all, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }
    pub fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 50 * SOL).unwrap();
        k
    }
    pub fn lamports(&self, k: &Address) -> u64 {
        self.svm.get_account(k).map(|x| x.lamports).unwrap_or(0)
    }
    pub fn exists(&self, k: &Address) -> bool {
        self.svm.get_account(k).map(|x| x.lamports > 0).unwrap_or(false)
    }
    pub fn data(&self, k: &Address) -> Vec<u8> {
        self.svm.get_account(k).unwrap_or_else(|| panic!("missing account {k}")).data
    }
    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    /// Classic SPL Token mint (no extensions), authority = `fee_payer`.
    pub fn create_mint(&mut self, decimals: u8) -> Address {
        let mint = Keypair::new();
        let auth = self.fee_payer.pubkey();
        let mut create = vec![0u8, 0, 0, 0];
        create.extend_from_slice(&self.rent(82).to_le_bytes());
        create.extend_from_slice(&82u64.to_le_bytes());
        create.extend_from_slice(a(TOKEN).as_ref());
        let mut init = vec![20u8, decimals];
        init.extend_from_slice(auth.as_ref());
        init.push(0);
        let ixs = [
            Instruction::new_with_bytes(a(SYSTEM), &create, vec![ws(auth), ws(mint.pubkey())]),
            Instruction::new_with_bytes(a(TOKEN), &init, vec![w(mint.pubkey())]),
        ];
        self.send(&ixs, &[&mint]).unwrap();
        mint.pubkey()
    }
    /// Associated token account for `owner` (idempotent create is not needed: callers create each once).
    pub fn create_ata(&mut self, owner: &Address, mint: &Address) -> Address {
        let addr = ata(owner, mint);
        let payer = self.fee_payer.pubkey();
        let ix = Instruction::new_with_bytes(
            a(ATA),
            &[1],
            vec![ws(payer), w(addr), r(*owner), r(*mint), r(a(SYSTEM)), r(a(TOKEN))],
        );
        self.send(&[ix], &[]).unwrap();
        addr
    }

    /// Token-2022 mint with a TransferFeeConfig (`fee_bps`, no max-fee cap), config/withdraw authority = `fee_payer`.
    /// Mirrors how ACT is configured (3.5% fee), so fee-on-transfer paths run for real.
    pub fn create_fee_mint(&mut self, decimals: u8, fee_bps: u16) -> Address {
        let mint = Keypair::new();
        let auth = self.fee_payer.pubkey();
        let tp = a(TOKEN_2022);
        let space: u64 = 278; // 165 base + 1 account type + TLV(2+2+108) for TransferFeeConfig
        let mut create = vec![0u8, 0, 0, 0];
        create.extend_from_slice(&self.rent(space as usize).to_le_bytes());
        create.extend_from_slice(&space.to_le_bytes());
        create.extend_from_slice(tp.as_ref());
        // InitializeTransferFeeConfig: [26, 0, Some(auth), Some(auth), bps, max_fee]
        let mut fee = vec![26u8, 0, 1];
        fee.extend_from_slice(auth.as_ref());
        fee.push(1);
        fee.extend_from_slice(auth.as_ref());
        fee.extend_from_slice(&fee_bps.to_le_bytes());
        fee.extend_from_slice(&u64::MAX.to_le_bytes());
        let mut init = vec![20u8, decimals];
        init.extend_from_slice(auth.as_ref());
        init.push(0);
        let ixs = [
            Instruction::new_with_bytes(a(SYSTEM), &create, vec![ws(auth), ws(mint.pubkey())]),
            Instruction::new_with_bytes(tp, &fee, vec![w(mint.pubkey())]),
            Instruction::new_with_bytes(tp, &init, vec![w(mint.pubkey())]),
        ];
        self.send(&ixs, &[&mint]).unwrap();
        mint.pubkey()
    }
    pub fn create_ata_with(&mut self, owner: &Address, mint: &Address, token_program: &Address) -> Address {
        let addr = ata_with(owner, mint, token_program);
        let payer = self.fee_payer.pubkey();
        let ix = Instruction::new_with_bytes(
            a(ATA),
            &[1],
            vec![ws(payer), w(addr), r(*owner), r(*mint), r(a(SYSTEM)), r(*token_program)],
        );
        self.send(&[ix], &[]).unwrap();
        addr
    }
    /// MintTo (authority = `fee_payer`). Works for both token programs.
    pub fn mint_to(&mut self, mint: &Address, dest: &Address, token_program: &Address, amount: u64) {
        let mut d = vec![7u8];
        d.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction::new_with_bytes(*token_program, &d, vec![w(*mint), w(*dest), rs(self.fee_payer.pubkey())]);
        self.send(&[ix], &[]).unwrap();
    }
    /// Token balance of a (classic or Token-2022) token account.
    pub fn token_amount(&self, k: &Address) -> u64 {
        u64::from_le_bytes(self.data(k)[64..72].try_into().unwrap())
    }
}

/// `true` when a failed transaction's logs/error mention `needle` (an Anchor error name, e.g. `ConstraintHasOne`).
pub fn failed_with(res: &Result<(), String>, needle: &str) -> bool {
    matches!(res, Err(m) if m.contains(needle))
}
#[track_caller]
pub fn assert_fails_with(res: Result<(), String>, needle: &str) {
    match res {
        Ok(()) => panic!("expected failure containing `{needle}`, but the transaction succeeded"),
        Err(m) => assert!(m.contains(needle), "expected failure containing `{needle}`, got:\n{m}"),
    }
}
