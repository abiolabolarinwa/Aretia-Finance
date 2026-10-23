//! Helpers for tests that need the web wallet's real bonding curve, and Meteora's real pool program the curve graduates into.
#![allow(dead_code)]
use super::*;
use num_bigint::BigUint;
use num_traits::ToPrimitive;

pub const CURVE: &str = "CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu";
pub const METEORA: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
pub const METEORA_POOL_AUTHORITY: &str = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
pub const NATIVE: &str = "So11111111111111111111111111111111111111112";
pub const CURVE_FEE_WALLET: &str = "2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2";
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

pub fn pda_of(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}
pub fn curve_pda(mint: &Address) -> Address {
    pda_of(&[b"curve", mint.as_ref()], &a(CURVE))
}
pub fn sol_vault_pda(curve: &Address) -> Address {
    pda_of(&[b"sol_vault", curve.as_ref()], &a(CURVE))
}
pub fn migrator_pda(curve: &Address) -> Address {
    pda_of(&[b"migrator", curve.as_ref()], &a(CURVE))
}
fn meta(k: Address, writable: bool, signer: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(k, signer)
    } else {
        AccountMeta::new_readonly(k, signer)
    }
}

/// Registers LiteSVM's missing wrapped-SOL mint (on mainnet it is a plain classic mint with 9 decimals).
pub fn ensure_native_mint(e: &mut Env) {
    if e.svm.get_account(&a(NATIVE)).is_none() {
        let mut data = vec![0u8; 82];
        data[44] = 9;
        data[45] = 1;
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
}

/// Loads the web curve's real binary (checked against its published checksum) at its program id.
pub fn load_curve(e: &mut Env) {
    let dir = env!("CARGO_MANIFEST_DIR");
    let so = std::fs::read(format!("{dir}/tests/fixtures/aretia_curve.so")).unwrap();
    let want =
        std::fs::read_to_string(format!("{dir}/tests/fixtures/aretia_curve.so.sha256")).unwrap();
    assert_eq!(
        want.split_whitespace().next().unwrap(),
        sha_hex(&so),
        "tests/fixtures/aretia_curve.so is stale"
    );
    e.svm
        .add_program_from_file(a(CURVE), format!("{dir}/tests/fixtures/aretia_curve.so"))
        .unwrap();
}

/// Loads the Meteora DAMM v2 program built from source (see tests/fixtures/README.md).
pub fn load_meteora(e: &mut Env) {
    let dir = env!("CARGO_MANIFEST_DIR");
    let so = std::fs::read(format!("{dir}/tests/fixtures/meteora_cp_amm.so")).unwrap();
    let want =
        std::fs::read_to_string(format!("{dir}/tests/fixtures/meteora_cp_amm.so.sha256")).unwrap();
    assert_eq!(
        want.split_whitespace().next().unwrap(),
        sha_hex(&so),
        "tests/fixtures/meteora_cp_amm.so is stale"
    );
    e.svm
        .add_program_from_file(
            a(METEORA),
            format!("{dir}/tests/fixtures/meteora_cp_amm.so"),
        )
        .unwrap();
}

fn sha_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

pub fn create_curve_ix(creator: &Address, mint: &Address, total: u64, target: u64) -> Instruction {
    let curve = curve_pda(mint);
    let tp = a(TOKEN_2022);
    let mut d = disc("create_curve").to_vec();
    d.extend_from_slice(&total.to_le_bytes());
    d.extend_from_slice(&target.to_le_bytes());
    Instruction::new_with_bytes(
        a(CURVE),
        &d,
        vec![
            ws(*creator),
            r(*mint),
            w(ata(creator, mint, &tp)),
            w(curve),
            w(sol_vault_pda(&curve)),
            w(ata(&curve, mint, &tp)),
            r(tp),
            r(a(ATA)),
            r(a(SYSTEM)),
        ],
    )
}

pub fn curve_buy_ix(buyer: &Address, mint: &Address, gross: u64, min_out: u64) -> Instruction {
    let curve = curve_pda(mint);
    let tp = a(TOKEN_2022);
    let mut d = disc("buy").to_vec();
    d.extend_from_slice(&gross.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    Instruction::new_with_bytes(
        a(CURVE),
        &d,
        vec![
            ws(*buyer),
            w(curve),
            w(sol_vault_pda(&curve)),
            r(*mint),
            w(ata(&curve, mint, &tp)),
            w(ata(buyer, mint, &tp)),
            w(a(CURVE_FEE_WALLET)),
            r(tp),
            r(a(SYSTEM)),
        ],
    )
}

/// Everything a `migrate` call needs, with Meteora's derived addresses. Token A of the pool is the launch token, token B is wrapped SOL.
pub struct Pool {
    pub nft: Keypair,
    pub pool: Address,
    pub position: Address,
    pub nft_account: Address,
    pub vault_a: Address,
    pub vault_b: Address,
}

impl Pool {
    pub fn new(mint: &Address) -> Self {
        let nft = Keypair::new();
        let wsol = a(NATIVE);
        let (first, second) = if mint.to_bytes() > wsol.to_bytes() {
            (mint, &wsol)
        } else {
            (&wsol, mint)
        };
        let meteora = a(METEORA);
        let pool = pda_of(&[b"cpool", first.as_ref(), second.as_ref()], &meteora);
        Pool {
            position: pda_of(&[b"position", nft.pubkey().as_ref()], &meteora),
            nft_account: pda_of(&[b"position_nft_account", nft.pubkey().as_ref()], &meteora),
            vault_a: pda_of(&[b"token_vault", mint.as_ref(), pool.as_ref()], &meteora),
            vault_b: pda_of(&[b"token_vault", wsol.as_ref(), pool.as_ref()], &meteora),
            pool,
            nft,
        }
    }
}

/// sqrt(sol / tokens) in Q64.64, rounded down, and the largest liquidity both amounts can fund over the full range.
pub fn pool_args(sol: u64, tokens: u64) -> (u128, u128) {
    let p2 = (BigUint::from(sol) << 128u32) / BigUint::from(tokens);
    let p = p2.sqrt();
    let pmax = BigUint::from(MAX_SQRT_PRICE);
    let pmin = BigUint::from(MIN_SQRT_PRICE);
    let la = BigUint::from(tokens) * &p * &pmax / (&pmax - &p);
    let lb = (BigUint::from(sol) << 128u32) / (&p - &pmin);
    let l = la.min(lb);
    (
        l.to_u128().expect("liquidity fits") - 1,
        p.to_u128().expect("price fits"),
    )
}

pub fn migrate_ix(
    payer: &Address,
    mint: &Address,
    p: &Pool,
    rent_budget: u64,
    liquidity: u128,
    sqrt_price: u128,
) -> Instruction {
    let curve = curve_pda(mint);
    let migrator = migrator_pda(&curve);
    let (t22, t, wsol, meteora) = (a(TOKEN_2022), a(TOKEN), a(NATIVE), a(METEORA));
    let mut d = disc("migrate").to_vec();
    d.extend_from_slice(&rent_budget.to_le_bytes());
    d.extend_from_slice(&liquidity.to_le_bytes());
    d.extend_from_slice(&sqrt_price.to_le_bytes());
    Instruction::new_with_bytes(
        a(CURVE),
        &d,
        vec![
            meta(*payer, true, true),
            meta(curve, true, false),
            meta(sol_vault_pda(&curve), true, false),
            meta(*mint, false, false),
            meta(ata(&curve, mint, &t22), true, false),
            meta(migrator, true, false),
            meta(ata(&migrator, mint, &t22), true, false),
            meta(wsol, false, false),
            meta(ata(&migrator, &wsol, &t), true, false),
            meta(p.nft.pubkey(), true, true),
            meta(p.nft_account, true, false),
            meta(p.position, true, false),
            meta(p.pool, true, false),
            meta(p.vault_a, true, false),
            meta(p.vault_b, true, false),
            meta(a(METEORA_POOL_AUTHORITY), false, false),
            meta(pda_of(&[b"__event_authority"], &meteora), false, false),
            meta(meteora, false, false),
            meta(t22, false, false),
            meta(t, false, false),
            meta(a(ATA), false, false),
            meta(a(SYSTEM), false, false),
        ],
    )
}

/// Meteora's `swap` discriminator, and the accounts it takes for a swap by `payer` between two token accounts. The referral
/// slot is Meteora's own id, which is how an optional account is left out.
pub const METEORA_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

pub fn meteora_swap_accounts(
    mint: &Address,
    p: &Pool,
    payer: &Address,
    input: &Address,
    output: &Address,
    payer_signs: bool,
) -> Vec<AccountMeta> {
    let meteora = a(METEORA);
    vec![
        r(a(METEORA_POOL_AUTHORITY)),
        w(p.pool),
        w(*input),
        w(*output),
        w(p.vault_a),
        w(p.vault_b),
        r(*mint),
        r(a(NATIVE)),
        meta(*payer, false, payer_signs),
        r(a(TOKEN_2022)),
        r(a(TOKEN)),
        r(meteora),
        r(pda_of(&[b"__event_authority"], &meteora)),
        r(meteora),
    ]
}

pub fn meteora_swap_data(amount_in: u64, min_out: u64) -> Vec<u8> {
    let mut d = METEORA_SWAP.to_vec();
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    d
}

pub fn compute_budget(units: u32) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(a("ComputeBudget111111111111111111111111111111"), &d, vec![])
}
