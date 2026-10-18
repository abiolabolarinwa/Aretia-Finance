//! Aretia Finance -- bonding curve that graduates into an ARETIA POOL (docs/ARETIA_POOL.md section 12).
//! A copy of program/aretia-curve whose `migrate` opens an Aretia Pool instead of a Meteora pool. The shipped curve is untouched.
//! ---------------------------------------------------------------------
//! One curve per token. The creator hands the program a block of a fixed-supply Token-2022 token and picks how
//! much SOL the curve should raise; buyers then buy and sell against a constant-product curve. When the last
//! curve token is sold the curve closes and `migrate` moves everything raised, plus the tokens set aside for
//! it, into a Meteora DAMM v2 pool whose liquidity is locked for good.
//!
//! READ docs/BONDING_CURVE.md before changing anything here. UNAUDITED. DEVNET ONLY until an independent
//! audit and the owner's explicit go-ahead.
//!
//! Design rules this file keeps:
//!  * No admin instruction exists. Every parameter is a constant below or fixed per curve at creation.
//!    The only key with power is the program upgrade authority (see the design doc).
//!  * All pricing arithmetic is in the `curve-math` crate, which is property-tested. This file only moves money.
//!  * State is written before any CPI. The only CPIs go to the System program, Token-2022, the legacy Token
//!    program (wrapped SOL) and Meteora, each checked by address. Mints with a transfer hook are refused, so no
//!    third-party code ever runs in the middle of a trade.
//!  * The curve vault's SOL is its own lamports above rent, tracked by `real_sol`. Donations are ignored.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey,
};
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use curve_math::Curve as Math;

// The mainnet program id: its own key, made by the owner and kept outside the repo. The devnet test program (9HVuUHU4mm6PYZFRnY7KzuGsHVSZ8QUVavarJLpJt5f4)
// was built before this change and keeps running its old build; it cannot be upgraded from this source, because the id is written into the program.
declare_id!("Ak12tX3J3m5rSmWLXUttyDpVAsniszkfvVG1GgWmnuBm");

/// Aretia's management-fee wallet (the same one the Launch page and the swap fee use).
pub const FEE_WALLET: Pubkey = pubkey!("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
/// Fee taken on every trade, in basis points of the SOL leg: 0.58%, as set by the owner.
pub const FEE_BPS: u16 = 58;
/// Smallest raise a curve may target: 0.1 SOL.
pub const MIN_TARGET_LAMPORTS: u64 = 100_000_000;
/// How long a sold-out curve may wait for its migration before holders can unwind it (7 days).
pub const ABORT_AFTER_SECS: i64 = 7 * 24 * 60 * 60;
/// The most SOL a caller may lend the migrator to pay the pool's rent; whatever is left is sent straight back.
pub const MAX_RENT_BUDGET: u64 = 200_000_000;

/// The Aretia Pool program this curve graduates into (the DEVNET test program: a mainnet build needs the mainnet pool program id).
pub const ARETIA_POOL_PROGRAM: Pubkey = pubkey!("4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc");
/// The pool's trading fee when it graduates: 0.25%, the same as the Meteora route.
pub const POOL_FEE_BPS: u16 = 25;
/// The virtual SOL the pool opens with (its smallest allowed liquidity, 0.01 SOL). The pool opens at (SOL raised + this) / tokens, a premium
/// over the curve's last price of this / SOL raised: 0.01 SOL on an 85 SOL raise is 0.012%, on the smallest 0.1 SOL raise it is 10%.
pub const POOL_VIRTUAL_SOL: u64 = 10_000_000;
/// Anchor's tag for the pool program's `create_pool`: sha256("global:create_pool")[0..8].
const CREATE_POOL_DISCRIMINATOR: [u8; 8] = [233, 146, 209, 142, 207, 104, 64, 188];

/// Token-2022 extension types a curve token may carry: metadata pointer (18) and token metadata (19).
const ALLOWED_EXTENSIONS: [u16; 2] = [18, 19];

#[program]
pub mod aretia_curve_grad {
    use super::*;

    /// Opens the curve for `mint`. `total_tokens` leave the creator's account for the curve's vault; the program splits
    /// them between the curve and the pool so the pool opens at the price the curve ends at. The creator may buy in
    /// the same transaction (that is the only way to be first).
    pub fn create_curve(ctx: Context<CreateCurve>, total_tokens: u64, target_lamports: u64) -> Result<()> {
        let mint_info = ctx.accounts.mint.to_account_info();
        require_keys_eq!(*mint_info.owner, anchor_spl::token_2022::ID, CurveError::MintNotAllowed);
        check_mint(&mint_info.try_borrow_data()?)?;
        require!(ctx.accounts.creator_token.amount >= total_tokens, CurveError::NotEnoughTokens);

        let d = curve_math::derive(total_tokens, target_lamports, MIN_TARGET_LAMPORTS).ok_or(CurveError::BadParameters)?;
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.curve;
        c.bump = ctx.bumps.curve;
        c.sol_bump = ctx.bumps.sol_vault;
        c.status = Status::Trading;
        c.creator = ctx.accounts.creator.key();
        c.mint = ctx.accounts.mint.key();
        c.fee_bps = FEE_BPS;
        c.target_lamports = target_lamports;
        c.v_sol0 = d.v_sol0;
        c.curve_tokens = d.curve_tokens;
        c.lp_tokens = d.lp_tokens;
        c.v_sol = d.v_sol0;
        c.v_tok = d.v_tok0;
        c.real_sol = 0;
        c.real_tok = d.curve_tokens;
        c.created_at = now;
        c.sold_out_at = 0;
        c.pool = Pubkey::default();

        // The SOL vault is a bare system account: it must hold the rent-exempt minimum to exist, and the creator
        // pays that once.
        system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.sol_vault.to_account_info() }),
            Rent::get()?.minimum_balance(0),
        )?;

        let before = ctx.accounts.vault.amount;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.creator_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            total_tokens,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before + total_tokens, CurveError::UnexpectedBalance);

        emit!(Created { curve: c.key(), mint: c.mint, creator: c.creator, curve_tokens: c.curve_tokens, lp_tokens: c.lp_tokens, target_lamports, v_sol0: d.v_sol0, v_tok0: d.v_tok0, ts: now });
        Ok(())
    }

    /// Offers up to `gross_in` lamports for tokens. The fee comes out of the offer first. If the offer would buy
    /// more than is left, only what is left is bought and charged. Reverts unless at least `min_tokens_out` result.
    pub fn buy(ctx: Context<Buy>, gross_in: u64, min_tokens_out: u64) -> Result<()> {
        let c = &mut ctx.accounts.curve;
        require!(c.status == Status::Trading, CurveError::NotTrading);
        let (b, next) = curve_math::buy(&c.math(), gross_in, c.fee_bps).ok_or(CurveError::TradeTooSmall)?;
        require!(b.tokens_out >= min_tokens_out, CurveError::Slippage);

        // Effects first.
        c.set_math(&next);
        let now = Clock::get()?.unix_timestamp;
        if b.sold_out {
            c.status = Status::SoldOut;
            c.sold_out_at = now;
        }
        let (curve_key, mint_key, bump) = (c.key(), c.mint, c.bump);
        let (v_sol, v_tok, real_sol) = (c.v_sol, c.v_tok, c.real_sol);

        // Interactions.
        if b.fee > 0 {
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.fee_wallet.to_account_info() }),
                b.fee,
            )?;
        }
        system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.sol_vault.to_account_info() }),
            b.net,
        )?;
        let before = ctx.accounts.vault.amount;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[seeds],
            ),
            b.tokens_out,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before - b.tokens_out, CurveError::UnexpectedBalance);
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), real_sol)?;

        emit!(Traded { curve: curve_key, trader: ctx.accounts.buyer.key(), is_buy: true, lamports: b.gross, fee: b.fee, tokens: b.tokens_out, v_sol, v_tok, real_sol, ts: now });
        Ok(())
    }

    /// Sells `tokens_in` back to the curve. Reverts unless at least `min_lamports_out` reach the seller after the fee.
    /// Open while the curve is trading, and again if an unfinished migration was aborted.
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_lamports_out: u64) -> Result<()> {
        let c = &mut ctx.accounts.curve;
        require!(c.status == Status::Trading || c.status == Status::Aborted, CurveError::NotTrading);
        let (s, next) = curve_math::sell(&c.math(), c.curve_tokens, tokens_in, c.fee_bps).ok_or(CurveError::TradeTooSmall)?;
        require!(s.net >= min_lamports_out, CurveError::Slippage);

        c.set_math(&next);
        let (curve_key, sol_bump) = (c.key(), c.sol_bump);
        let (v_sol, v_tok, real_sol) = (c.v_sol, c.v_tok, c.real_sol);
        let now = Clock::get()?.unix_timestamp;

        let before = ctx.accounts.vault.amount;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.seller_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            tokens_in,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before + tokens_in, CurveError::UnexpectedBalance);

        // The SOL vault pays out: the seller first, then the Aretia fee.
        let sol_seeds: &[&[u8]] = &[b"sol_vault", curve_key.as_ref(), &[sol_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.seller.to_account_info() }, &[sol_seeds]),
            s.net,
        )?;
        if s.fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.fee_wallet.to_account_info() }, &[sol_seeds]),
                s.fee,
            )?;
        }
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), real_sol)?;

        emit!(Traded { curve: curve_key, trader: ctx.accounts.seller.key(), is_buy: false, lamports: s.gross, fee: s.fee, tokens: tokens_in, v_sol, v_tok, real_sol, ts: now });
        Ok(())
    }

    /// Anyone may call this once the curve has sold out. Opens an Aretia Pool, locked for good, with the tokens set aside for it and
    /// all the SOL raised, owned by the curve's creator (who can claim its fees). Either all of it happens or none.
    pub fn migrate(ctx: Context<Migrate>, rent_budget: u64) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        require!(curve.status == Status::SoldOut && curve.real_tok == 0, CurveError::NotSoldOut);
        require!(rent_budget <= MAX_RENT_BUDGET, CurveError::BadParameters);

        let mint_key = curve.mint;
        let pool_expected = pool_address(&mint_key);
        require_keys_eq!(ctx.accounts.pool.key(), pool_expected, CurveError::WrongAccount);
        let owner = curve.creator;
        require_keys_eq!(ctx.accounts.pool_owner.key(), owner, CurveError::WrongAccount);
        require_keys_eq!(ctx.accounts.position.key(), position_address(&pool_expected, &owner), CurveError::WrongAccount);

        let sol_to_move = curve.real_sol;
        let tokens_to_move = curve.lp_tokens;
        let (curve_key, curve_bump, sol_bump) = (curve.key(), curve.bump, curve.sol_bump);

        // Effects first: after this nothing can sell, buy, or migrate again.
        curve.status = Status::Migrated;
        curve.real_sol = 0;
        curve.pool = pool_expected;

        let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve_bump]];
        let migrator_seeds: &[&[u8]] = &[b"migrator", curve_key.as_ref(), &[ctx.bumps.migrator]];
        let migrator = ctx.accounts.migrator.to_account_info();

        // 1. The caller lends the migrator enough for the pool's creation fee and rent. What is left comes back at the end.
        if rent_budget > 0 {
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.payer.to_account_info(), to: migrator.clone() }),
                rent_budget,
            )?;
        }

        // 2. The pool tokens go to the migrator's token account, and the SOL raised to the migrator itself (the pool takes SOL from its creator).
        //    Balances before are remembered so a donation can neither block the migration nor hide a shortfall.
        let tok_pre = ctx.accounts.migrator_token.amount;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                TransferChecked { from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.migrator_token.to_account_info(), authority: ctx.accounts.curve.to_account_info() },
                &[curve_seeds],
            ),
            tokens_to_move,
            ctx.accounts.mint.decimals,
        )?;
        let sol_seeds: &[&[u8]] = &[b"sol_vault", curve_key.as_ref(), &[sol_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: migrator.clone() }, &[sol_seeds]),
            sol_to_move,
        )?;
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), 0)?;
        ctx.accounts.migrator_token.reload()?;
        require!(ctx.accounts.migrator_token.amount == tok_pre + tokens_to_move, CurveError::UnexpectedBalance);

        // 3. Open the pool. The migrator is the creator and pays the pool's fee and rent; the position belongs to the curve's creator and is locked.
        let init = create_pool_ix(&ctx.accounts, migrator.key(), owner, tokens_to_move, sol_to_move);
        let infos = [
            migrator.clone(),
            ctx.accounts.pool_owner.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.migrator_token.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.pool_sol_vault.to_account_info(),
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.fee_wallet.to_account_info(),
            ctx.accounts.token_program_2022.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.pool_program.to_account_info(),
        ];
        invoke_signed(&init, &infos, &[migrator_seeds])?;

        // 4. The pool must have taken every token and every lamport, at exactly the amounts sent.
        ctx.accounts.migrator_token.reload()?;
        require!(ctx.accounts.migrator_token.amount == tok_pre, CurveError::PoolPriceMismatch);
        {
            let data = ctx.accounts.pool.try_borrow_data()?;
            require!(*ctx.accounts.pool.owner == ARETIA_POOL_PROGRAM && data.len() >= 100, CurveError::PoolPriceMismatch);
            // Pool layout after the 8-byte tag: bumps (2), mint (32), creator (32), fee (2), then x, y, l as u64.
            let x = u64::from_le_bytes(data[76..84].try_into().unwrap());
            let y = u64::from_le_bytes(data[84..92].try_into().unwrap());
            let l = u64::from_le_bytes(data[92..100].try_into().unwrap());
            require!(x == tokens_to_move && y == sol_to_move && l == POOL_VIRTUAL_SOL, CurveError::PoolPriceMismatch);
        }

        // 5. Send back what is left of the rent budget.
        let remaining = migrator.lamports();
        if remaining > 0 {
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::transfer(&migrator.key(), &ctx.accounts.payer.key(), remaining),
                &[migrator.clone(), ctx.accounts.payer.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[migrator_seeds],
            )?;
        }

        emit!(Migrated { curve: curve_key, pool: pool_expected, lamports: sol_to_move, tokens: tokens_to_move, owner, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// If a sold-out curve has waited `ABORT_AFTER_SECS` without migrating (for example because someone opened a
    /// pool for the same token first), anyone may unwind it: selling reopens, buying stays closed.
    pub fn abort_migration(ctx: Context<AbortMigration>) -> Result<()> {
        let c = &mut ctx.accounts.curve;
        require!(c.status == Status::SoldOut, CurveError::NotSoldOut);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= c.sold_out_at.checked_add(ABORT_AFTER_SECS).ok_or(CurveError::BadParameters)?, CurveError::TooEarly);
        c.status = Status::Aborted;
        emit!(Aborted { curve: c.key(), ts: now });
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

/// The SOL vault must always hold the rent-exempt minimum plus every lamport the curve owes holders.
fn require_solvent(sol_vault: &AccountInfo, real_sol: u64) -> Result<()> {
    let min = Rent::get()?.minimum_balance(0);
    require!(sol_vault.lamports() >= min.checked_add(real_sol).ok_or(CurveError::BadParameters)?, CurveError::Insolvent);
    Ok(())
}

/// Accepts only a fixed-supply Token-2022 mint with no freeze power and no extension beyond name/symbol metadata.
/// Reads the raw account so no library's idea of "known extension" can wave anything through.
pub fn check_mint(data: &[u8]) -> Result<()> {
    require!(data.len() >= 82, CurveError::MintNotAllowed);
    require!(u32::from_le_bytes(data[0..4].try_into().unwrap()) == 0, CurveError::MintNotAllowed); // no mint authority
    require!(data[45] == 1, CurveError::MintNotAllowed); // initialised
    require!(u32::from_le_bytes(data[46..50].try_into().unwrap()) == 0, CurveError::MintNotAllowed); // no freeze authority
    if data.len() == 82 {
        return Ok(());
    }
    require!(data.len() >= 166 && data[165] == 1, CurveError::MintNotAllowed); // account type: mint
    let mut at = 166usize;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if ty == 0 {
            // Uninitialised padding: only zeros may follow.
            require!(data[at..].iter().all(|b| *b == 0), CurveError::MintNotAllowed);
            return Ok(());
        }
        require!(ALLOWED_EXTENSIONS.contains(&ty), CurveError::MintNotAllowed);
        at = at.checked_add(4 + len).ok_or(CurveError::MintNotAllowed)?;
    }
    require!(at == data.len(), CurveError::MintNotAllowed);
    Ok(())
}

/// The Aretia Pool address for a token: seeds "pool", the mint, under the pool program.
pub fn pool_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool", mint.as_ref()], &ARETIA_POOL_PROGRAM).0
}

/// The position's address: seeds "position", the pool, and its id (the owner's own address).
pub fn position_address(pool: &Pubkey, id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", pool.as_ref(), id.as_ref()], &ARETIA_POOL_PROGRAM).0
}

fn meta(key: Pubkey, writable: bool, signer: bool) -> AccountMeta {
    if writable { AccountMeta::new(key, signer) } else { AccountMeta::new_readonly(key, signer) }
}

/// The pool program's `create_pool(x0, y0, l0, fee_bps, lock, sniper_bps, decay_secs, vx0)`: both sides deposited, locked, no launch
/// schedule, no price range, owned by the curve's creator.
fn create_pool_ix(a: &Migrate<'_>, migrator: Pubkey, owner: Pubkey, tokens: u64, sol: u64) -> Instruction {
    let mut data = Vec::with_capacity(49);
    data.extend_from_slice(&CREATE_POOL_DISCRIMINATOR);
    data.extend_from_slice(&tokens.to_le_bytes());
    data.extend_from_slice(&sol.to_le_bytes());
    data.extend_from_slice(&POOL_VIRTUAL_SOL.to_le_bytes());
    data.extend_from_slice(&POOL_FEE_BPS.to_le_bytes());
    data.push(1); // lock
    data.extend_from_slice(&0u16.to_le_bytes()); // no launch schedule
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // no price range
    debug_assert_eq!(data.len(), 49);
    Instruction {
        program_id: ARETIA_POOL_PROGRAM,
        accounts: vec![
            meta(migrator, true, true),                    // creator: pays and signs
            meta(owner, false, false),                     // owner of the position: the curve's creator
            meta(a.mint.key(), false, false),
            meta(a.migrator_token.key(), true, false),     // the creator's token account: the migrator's
            meta(a.pool.key(), true, false),
            meta(a.pool_sol_vault.key(), true, false),
            meta(a.pool_vault.key(), true, false),
            meta(a.position.key(), true, false),
            meta(FEE_WALLET, true, false),
            meta(anchor_spl::token_2022::ID, false, false),
            meta(anchor_spl::associated_token::ID, false, false),
            meta(system_program::ID, false, false),
            meta(owner, false, false),                     // position id: the owner's address, no signature needed
        ],
        data,
    }
}

// ---------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Status {
    /// Buying and selling are open.
    Trading,
    /// Every curve token is sold. Waiting for `migrate`.
    SoldOut,
    /// The pool exists and its liquidity is locked.
    Migrated,
    /// Migration did not happen in time. Selling is open, buying is not.
    Aborted,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub bump: u8,
    /// Bump of the SOL vault, a system-owned account at ["sol_vault", curve] that holds every lamport the curve owes.
    pub sol_bump: u8,
    pub status: Status,
    pub creator: Pubkey,
    pub mint: Pubkey,
    /// Fee in force for this curve, fixed at creation.
    pub fee_bps: u16,
    pub target_lamports: u64,
    pub v_sol0: u64,
    pub curve_tokens: u64,
    pub lp_tokens: u64,
    pub v_sol: u64,
    pub v_tok: u64,
    /// Lamports owed to holders, net of fees.
    pub real_sol: u64,
    /// Tokens still for sale.
    pub real_tok: u64,
    pub created_at: i64,
    pub sold_out_at: i64,
    pub pool: Pubkey,
}

impl Curve {
    fn math(&self) -> Math {
        Math { v_sol: self.v_sol, v_tok: self.v_tok, real_sol: self.real_sol, real_tok: self.real_tok }
    }
    fn set_math(&mut self, m: &Math) {
        self.v_sol = m.v_sol;
        self.v_tok = m.v_tok;
        self.real_sol = m.real_sol;
        self.real_tok = m.real_tok;
    }
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct CreateCurve<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = creator, token::token_program = token_program)]
    pub creator_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = creator, space = 8 + Curve::INIT_SPACE, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve: Account<'info, Curve>,
    /// The system account that holds the curve SOL.
    #[account(mut, seeds = [b"sol_vault", curve.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = curve, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Account<'info, Curve>,
    /// The system account that holds the curve SOL.
    #[account(mut, seeds = [b"sol_vault", curve.key().as_ref()], bump = curve.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: address-checked; receives the fee.
    #[account(mut, address = FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Account<'info, Curve>,
    /// The system account that holds the curve SOL.
    #[account(mut, seeds = [b"sol_vault", curve.key().as_ref()], bump = curve.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: address-checked; receives the fee.
    #[account(mut, address = FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AbortMigration<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,
}

#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    /// The system account that holds the curve SOL.
    #[account(mut, seeds = [b"sol_vault", curve.key().as_ref()], bump = curve.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve, associated_token::token_program = token_program_2022)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: a program-derived system account that creates the pool and holds the money in transit.
    #[account(mut, seeds = [b"migrator", curve.key().as_ref()], bump)]
    pub migrator: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = migrator, associated_token::token_program = token_program_2022)]
    pub migrator_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: must equal the pool address for this token (checked in the handler); created by the pool program.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's SOL vault; derived and created by the pool program.
    #[account(mut)]
    pub pool_sol_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's token vault; derived and created by the pool program.
    #[account(mut)]
    pub pool_vault: UncheckedAccount<'info>,
    /// CHECK: must equal the position address for the curve's creator (checked in the handler); created by the pool program.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the curve's creator, who will own the position (checked in the handler).
    pub pool_owner: UncheckedAccount<'info>,
    /// CHECK: address-checked; receives the pool's creation fee.
    #[account(mut, address = FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// CHECK: the Aretia Pool program, by address.
    #[account(address = ARETIA_POOL_PROGRAM)]
    pub pool_program: UncheckedAccount<'info>,
    pub token_program_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct Created {
    pub curve: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub curve_tokens: u64,
    pub lp_tokens: u64,
    pub target_lamports: u64,
    pub v_sol0: u64,
    pub v_tok0: u64,
    pub ts: i64,
}

#[event]
pub struct Traded {
    pub curve: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    /// The SOL leg before the fee: what a buyer paid, what the vault gave up on a sale.
    pub lamports: u64,
    pub fee: u64,
    pub tokens: u64,
    pub v_sol: u64,
    pub v_tok: u64,
    pub real_sol: u64,
    pub ts: i64,
}

#[event]
pub struct Migrated {
    pub curve: Pubkey,
    pub pool: Pubkey,
    pub lamports: u64,
    pub tokens: u64,
    pub owner: Pubkey,
    pub ts: i64,
}

#[event]
pub struct Aborted {
    pub curve: Pubkey,
    pub ts: i64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum CurveError {
    #[msg("This token is not allowed: it must be a Token-2022 token with a fixed supply, no freeze power and no features beyond its name and symbol.")]
    MintNotAllowed,
    #[msg("The token amount or the raise target is outside what a curve can use.")]
    BadParameters,
    #[msg("The creator's account does not hold that many tokens.")]
    NotEnoughTokens,
    #[msg("The curve is not open for this.")]
    NotTrading,
    #[msg("That trade is too small to buy or sell anything.")]
    TradeTooSmall,
    #[msg("The price moved past the limit you set.")]
    Slippage,
    #[msg("A token balance did not change by exactly the amount moved.")]
    UnexpectedBalance,
    #[msg("The curve vault would be left short.")]
    Insolvent,
    #[msg("The curve has not sold out.")]
    NotSoldOut,
    #[msg("Too early to abort the migration.")]
    TooEarly,
    #[msg("An account is not the one expected.")]
    WrongAccount,
    #[msg("The pool did not take exactly what was sent, so the migration was refused.")]
    PoolPriceMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Vec<u8> {
        let mut d = vec![0u8; 82];
        d[45] = 1; // initialised, no authorities
        d
    }
    fn with_ext(exts: &[(u16, usize)]) -> Vec<u8> {
        let mut d = base();
        d.resize(165, 0);
        d.push(1); // account type: mint
        for (ty, len) in exts {
            d.extend_from_slice(&ty.to_le_bytes());
            d.extend_from_slice(&(*len as u16).to_le_bytes());
            d.extend(std::iter::repeat(7u8).take(*len));
        }
        d
    }

    #[test]
    fn accepts_what_the_launch_page_makes() {
        assert!(check_mint(&base()).is_ok());
        assert!(check_mint(&with_ext(&[(18, 64)])).is_ok());
        assert!(check_mint(&with_ext(&[(18, 64), (19, 300)])).is_ok());
    }

    #[test]
    fn refuses_authorities_and_other_extensions() {
        let mut d = base();
        d[0] = 1; // a mint authority
        assert!(check_mint(&d).is_err());
        let mut d = base();
        d[46] = 1; // a freeze authority
        assert!(check_mint(&d).is_err());
        let mut d = base();
        d[45] = 0; // not initialised
        assert!(check_mint(&d).is_err());
        for ty in [1u16, 3, 4, 9, 12, 14, 20, 26] {
            assert!(check_mint(&with_ext(&[(18, 64), (ty, 8)])).is_err(), "extension {ty} must be refused");
        }
    }

    #[test]
    fn refuses_malformed_data() {
        assert!(check_mint(&[0u8; 10]).is_err());
        let mut d = with_ext(&[(18, 64)]);
        d.truncate(d.len() - 3); // a length that runs past the end
        assert!(check_mint(&d).is_err());
        let mut d = base();
        d.resize(200, 0); // between a mint and an extended mint, with no type byte
        assert!(check_mint(&d).is_err());
        let mut d = with_ext(&[(18, 64)]);
        d.extend_from_slice(&[0, 0, 0, 0, 0, 9]); // zero padding followed by junk
        assert!(check_mint(&d).is_err());
        let mut d = with_ext(&[(18, 64)]);
        d.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // zero padding alone is fine
        assert!(check_mint(&d).is_ok());
    }

    #[test]
    fn pool_address_is_fixed_and_differs_per_mint() {
        let m = Pubkey::new_unique();
        assert_eq!(pool_address(&m), pool_address(&m));
        assert_ne!(pool_address(&m), pool_address(&Pubkey::new_unique()));
    }
}
