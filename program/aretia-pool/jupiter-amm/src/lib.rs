//! Aretia Pool as a Jupiter AMM. UNAUDITED. The pool program exists on devnet only; the id below is the devnet test program.
//!
//! What this is: the quote (exact, with the same integer maths as the program: `pool-math`) and the account list for the pool's `swap`
//! instruction, behind `jupiter_amm_interface::Amm`. What it is not: the integration itself. Jupiter owns the `Swap` enum its router
//! CPIs with and the instruction data it builds for it, so `Swap::TokenSwap` below is a PLACEHOLDER; Jupiter replaces it with the
//! variant they add for Aretia Pool. See docs/ARETIA_POOL_INTEGRATION.md.
//!
//! The pool's SOL side is a wrapped-SOL token account, so Jupiter's ordinary wrap and unwrap of SOL works: the user's source or
//! destination token account is simply their wrapped-SOL account.
//!
//! Account order of the pool's `swap` (data: tag, is_buy: bool, amount_in: u64, min_out: u64):
//!   trader (signer, writable), pool (w), sol_vault (w), mint, token vault (w), trader token (w), trader wrapped SOL (w),
//!   fee wrapped SOL (w), Token-2022 program, Token program.
use anyhow::{anyhow, bail, ensure, Result};
use jupiter_amm_interface::{AccountMap, Amm, AmmContext, ClockRef, KeyedAccount, Quote, QuoteParams, Swap, SwapAndAccountMetas, SwapMode, SwapParams};
use rust_decimal::Decimal;
use solana_instruction::AccountMeta;
use solana_pubkey::{pubkey, Pubkey};

/// The devnet test program. A mainnet program gets its own id.
pub const PROGRAM_ID: Pubkey = pubkey!("4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Aretia's management-fee wallet: the owner of the wrapped-SOL account that receives Aretia's share of every fee.
pub const FEE_WALLET: Pubkey = pubkey!("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Anchor's tag for `Pool` accounts: sha256("account:Pool")[0..8].
pub const POOL_TAG: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const POOL_ACCOUNT_SIZE: usize = 146;
/// `swap`'s tag: sha256("global:swap")[0..8].
pub const SWAP_TAG: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

pub fn associated(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// The pool account as the program lays it out.
#[derive(Clone, Debug, PartialEq)]
pub struct PoolState {
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub acc: u128,
    pub fee_reserve: u64,
    pub created_at: i64,
    pub fee_start_bps: u16,
    pub decay_secs: u32,
    pub vx: u64,
}

pub fn parse_pool(data: &[u8]) -> Result<PoolState> {
    ensure!(data.len() == POOL_ACCOUNT_SIZE && data[..8] == POOL_TAG, "not an Aretia Pool account");
    let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    Ok(PoolState {
        mint: Pubkey::new_from_array(data[10..42].try_into().unwrap()),
        fee_bps: u16::from_le_bytes(data[74..76].try_into().unwrap()),
        x: u64_at(76),
        y: u64_at(84),
        l: u64_at(92),
        acc: u128::from_le_bytes(data[100..116].try_into().unwrap()),
        fee_reserve: u64_at(116),
        created_at: i64::from_le_bytes(data[124..132].try_into().unwrap()),
        fee_start_bps: u16::from_le_bytes(data[132..134].try_into().unwrap()),
        decay_secs: u32::from_le_bytes(data[134..138].try_into().unwrap()),
        vx: u64_at(138),
    })
}

impl PoolState {
    /// The pool's maths state with the fee in force at `now` (the creator's launch schedule while it lasts).
    pub fn math_at(&self, now: i64) -> pool_math::Pool {
        pool_math::Pool {
            x: self.x,
            vx: self.vx,
            y: self.y,
            l: self.l,
            fee_bps: pool_math::effective_fee_bps(self.fee_bps, self.fee_start_bps, self.decay_secs, self.created_at, now),
            acc: self.acc,
            fee_reserve: self.fee_reserve,
        }
    }
}

#[derive(Clone)]
pub struct AretiaPoolAmm {
    key: Pubkey,
    state: PoolState,
    clock: ClockRef,
}

impl AretiaPoolAmm {
    pub fn state(&self) -> &PoolState {
        &self.state
    }
    fn now(&self) -> i64 {
        self.clock.unix_timestamp.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// The pool's address for a token: seeds "pool" and the mint, under the pool program.
    pub fn address_for(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"pool", mint.as_ref()], &PROGRAM_ID).0
    }
}

impl Amm for AretiaPoolAmm {
    fn from_keyed_account(keyed_account: &KeyedAccount, amm_context: &AmmContext) -> Result<Self> {
        ensure!(keyed_account.account.owner == PROGRAM_ID, "the account is not owned by the Aretia Pool program");
        let state = parse_pool(&keyed_account.account.data)?;
        ensure!(keyed_account.key == Self::address_for(&state.mint), "the account is not the pool address for its token");
        Ok(Self { key: keyed_account.key, state, clock: amm_context.clock_ref.clone() })
    }

    fn label(&self) -> String {
        "Aretia Pool".to_string()
    }
    fn program_id(&self) -> Pubkey {
        PROGRAM_ID
    }
    fn key(&self) -> Pubkey {
        self.key
    }
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        vec![self.state.mint, WSOL]
    }
    /// Everything the quote needs is in the pool account (the reserves are numbers in it, not vault balances).
    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        vec![self.key]
    }
    fn update(&mut self, account_map: &AccountMap) -> Result<()> {
        let account = account_map.get(&self.key).ok_or_else(|| anyhow!("the pool account was not provided"))?;
        let state = parse_pool(&account.data)?;
        ensure!(state.mint == self.state.mint, "the pool changed token");
        self.state = state;
        Ok(())
    }

    fn quote(&self, p: &QuoteParams) -> Result<Quote> {
        ensure!(p.swap_mode == SwapMode::ExactIn, "Aretia Pool quotes exact-in only");
        let m = self.state.math_at(self.now());
        let fee_pct = Decimal::from(m.fee_bps) / Decimal::from(10_000u32);
        if p.input_mint == WSOL && p.output_mint == self.state.mint {
            let (b, _) = pool_math::buy(&m, p.amount).ok_or_else(|| anyhow!("the pool cannot fill that buy"))?;
            Ok(Quote { in_amount: p.amount, out_amount: b.tokens_out, fee_amount: b.fee, fee_mint: WSOL, fee_pct })
        } else if p.input_mint == self.state.mint && p.output_mint == WSOL {
            let (s, _) = pool_math::sell(&m, p.amount).ok_or_else(|| anyhow!("the pool cannot fill that sell"))?;
            Ok(Quote { in_amount: p.amount, out_amount: s.net, fee_amount: s.fee, fee_mint: WSOL, fee_pct })
        } else {
            bail!("the pair is not (token, wrapped SOL) for this pool")
        }
    }

    fn get_swap_and_account_metas(&self, s: &SwapParams) -> Result<SwapAndAccountMetas> {
        let mint = self.state.mint;
        let buying = s.source_mint == WSOL && s.destination_mint == mint;
        ensure!(buying || (s.source_mint == mint && s.destination_mint == WSOL), "the pair is not (token, wrapped SOL) for this pool");
        // The trader's wrapped-SOL account is the source on a buy and the destination on a sell; the token account is the other one.
        let (trader_wsol, trader_token) = if buying { (s.source_token_account, s.destination_token_account) } else { (s.destination_token_account, s.source_token_account) };
        let w = |k: Pubkey| AccountMeta::new(k, false);
        let r = |k: Pubkey| AccountMeta::new_readonly(k, false);
        let account_metas = vec![
            AccountMeta::new(s.token_transfer_authority, true),
            w(self.key),
            w(associated(&self.key, &WSOL, &TOKEN_PROGRAM)),
            r(mint),
            w(associated(&self.key, &mint, &TOKEN_2022_PROGRAM)),
            w(trader_token),
            w(trader_wsol),
            w(associated(&FEE_WALLET, &WSOL, &TOKEN_PROGRAM)),
            r(TOKEN_2022_PROGRAM),
            r(TOKEN_PROGRAM),
        ];
        // PLACEHOLDER: Jupiter assigns the variant for a new AMM.
        Ok(SwapAndAccountMetas { swap: Swap::TokenSwap, account_metas })
    }

    fn clone_amm(&self) -> Box<dyn Amm + Send + Sync> {
        Box::new(self.clone())
    }
    fn get_accounts_len(&self) -> usize {
        10
    }
    fn is_active(&self) -> bool {
        self.state.l > 0 && self.state.x as u128 + self.state.vx as u128 > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_account::Account;

    const MINT: Pubkey = pubkey!("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");

    fn bytes(s: &PoolState) -> Vec<u8> {
        let mut d = vec![0u8; POOL_ACCOUNT_SIZE];
        d[..8].copy_from_slice(&POOL_TAG);
        d[10..42].copy_from_slice(s.mint.as_ref());
        d[74..76].copy_from_slice(&s.fee_bps.to_le_bytes());
        d[76..84].copy_from_slice(&s.x.to_le_bytes());
        d[84..92].copy_from_slice(&s.y.to_le_bytes());
        d[92..100].copy_from_slice(&s.l.to_le_bytes());
        d[100..116].copy_from_slice(&s.acc.to_le_bytes());
        d[116..124].copy_from_slice(&s.fee_reserve.to_le_bytes());
        d[124..132].copy_from_slice(&s.created_at.to_le_bytes());
        d[132..134].copy_from_slice(&s.fee_start_bps.to_le_bytes());
        d[134..138].copy_from_slice(&s.decay_secs.to_le_bytes());
        d[138..146].copy_from_slice(&s.vx.to_le_bytes());
        d
    }

    fn state() -> PoolState {
        PoolState { mint: MINT, fee_bps: 100, x: 600_000_000_000_000, y: 0, l: 10_000_000_000, acc: 0, fee_reserve: 0, created_at: 1_000, fee_start_bps: 2_000, decay_secs: 600, vx: 0 }
    }

    fn account(s: &PoolState, owner: Pubkey) -> Account {
        Account { lamports: 1, data: bytes(s), owner, executable: false, rent_epoch: 0 }
    }

    fn amm(now: i64) -> AretiaPoolAmm {
        let ctx = AmmContext { clock_ref: ClockRef::default() };
        ctx.clock_ref.unix_timestamp.store(now, std::sync::atomic::Ordering::Relaxed);
        let key = AretiaPoolAmm::address_for(&MINT);
        AretiaPoolAmm::from_keyed_account(&KeyedAccount { key, account: account(&state(), PROGRAM_ID), params: None }, &ctx).unwrap()
    }

    fn q(amm: &AretiaPoolAmm, from: Pubkey, to: Pubkey, amount: u64) -> Result<Quote> {
        amm.quote(&QuoteParams { amount, input_mint: from, output_mint: to, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() })
    }

    #[test]
    fn the_layout_round_trips_and_has_the_programs_size() {
        let s = state();
        assert_eq!(parse_pool(&bytes(&s)).unwrap(), s);
        assert!(parse_pool(&bytes(&s)[..145]).is_err());
        let mut wrong = bytes(&s);
        wrong[0] ^= 1;
        assert!(parse_pool(&wrong).is_err());
    }

    #[test]
    fn a_quote_is_exactly_the_programs_maths_at_the_fee_in_force() {
        // At launch (t = 1000) the fee is 20%; after the schedule it is the base 1%.
        for (now, bps) in [(1_000i64, 2_000u16), (1_300, 1_050), (1_600, 100), (5_000, 100)] {
            let a = amm(now);
            let mut m = state().math_at(now);
            assert_eq!(m.fee_bps, bps);
            let got = q(&a, WSOL, MINT, 2_000_000_000).unwrap();
            let (b, next) = pool_math::buy(&m, 2_000_000_000).unwrap();
            assert_eq!((got.out_amount, got.fee_amount, got.fee_mint), (b.tokens_out, b.fee, WSOL), "buy at {now}");
            // Sell back against the pool as it is after the buy.
            m = next;
            let mut s = state();
            (s.x, s.y, s.acc, s.fee_reserve) = (m.x, m.y, m.acc, m.fee_reserve);
            let mut a2 = amm(now);
            let mut map = AccountMap::default();
            map.insert(a2.key(), account(&s, PROGRAM_ID));
            a2.update(&map).unwrap();
            let back = q(&a2, MINT, WSOL, b.tokens_out).unwrap();
            let (sell, _) = pool_math::sell(&m, b.tokens_out).unwrap();
            assert_eq!(back.out_amount, sell.net);
            assert!(back.out_amount < 2_000_000_000, "a round trip loses");
        }
    }

    #[test]
    fn it_refuses_what_the_pool_refuses() {
        let a = amm(5_000);
        assert!(q(&a, MINT, WSOL, 1_000).is_err(), "nothing to sell into yet");
        assert!(q(&a, WSOL, MINT, 0).is_err());
        assert!(q(&a, WSOL, Pubkey::new_unique(), 1_000_000).is_err());
        assert!(a.quote(&QuoteParams { amount: 1, input_mint: WSOL, output_mint: MINT, swap_mode: SwapMode::ExactOut, fee_mode: Default::default() }).is_err());
        // An account that is not the pool address, or not the program's, is not accepted.
        let ctx = AmmContext { clock_ref: ClockRef::default() };
        assert!(AretiaPoolAmm::from_keyed_account(&KeyedAccount { key: Pubkey::new_unique(), account: account(&state(), PROGRAM_ID), params: None }, &ctx).is_err());
        assert!(AretiaPoolAmm::from_keyed_account(&KeyedAccount { key: a.key(), account: account(&state(), Pubkey::new_unique()), params: None }, &ctx).is_err());
    }

    #[test]
    fn the_account_list_is_the_swaps_for_both_directions() {
        let a = amm(5_000);
        let (user, wsol_acc, tok_acc, auth) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let jup = Pubkey::new_unique();
        let params = |buy: bool| SwapParams {
            swap_mode: SwapMode::ExactIn,
            in_amount: 1,
            out_amount: 1,
            source_mint: if buy { WSOL } else { MINT },
            destination_mint: if buy { MINT } else { WSOL },
            source_token_account: if buy { wsol_acc } else { tok_acc },
            destination_token_account: if buy { tok_acc } else { wsol_acc },
            token_transfer_authority: auth,
            user,
            payer: user,
            quote_mint_to_referrer: None,
            jupiter_program_id: &jup,
            missing_dynamic_accounts_as_default: false,
        };
        for buy in [true, false] {
            let m = a.get_swap_and_account_metas(&params(buy)).unwrap().account_metas;
            assert_eq!(m.len(), a.get_accounts_len());
            assert_eq!((m[0].pubkey, m[0].is_signer, m[0].is_writable), (auth, true, true));
            assert_eq!(m[1].pubkey, a.key());
            assert_eq!(m[2].pubkey, associated(&a.key(), &WSOL, &TOKEN_PROGRAM));
            assert_eq!(m[4].pubkey, associated(&a.key(), &MINT, &TOKEN_2022_PROGRAM));
            assert_eq!((m[5].pubkey, m[6].pubkey), (tok_acc, wsol_acc), "token account, then wrapped-SOL account, whichever way it trades");
            assert_eq!(m[7].pubkey, associated(&FEE_WALLET, &WSOL, &TOKEN_PROGRAM));
            assert_eq!((m[8].pubkey, m[9].pubkey), (TOKEN_2022_PROGRAM, TOKEN_PROGRAM));
            assert!(m.iter().skip(1).all(|k| !k.is_signer));
        }
        let mut bad = params(true);
        bad.destination_mint = Pubkey::new_unique();
        assert!(a.get_swap_and_account_metas(&bad).is_err());
    }

    #[test]
    fn it_reports_itself() {
        let a = amm(0);
        assert_eq!((a.program_id(), a.label(), a.get_reserve_mints()), (PROGRAM_ID, "Aretia Pool".to_string(), vec![MINT, WSOL]));
        assert!(a.is_active());
    }
}
