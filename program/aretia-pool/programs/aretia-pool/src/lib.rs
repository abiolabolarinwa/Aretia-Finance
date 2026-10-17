//! Aretia Finance -- constant-product swap pool for tokens made on the Launch page.
//! ---------------------------------------------------------------------------------
//! One pool per token, always against SOL. The creator can open it with tokens alone: a virtual SOL reserve sets the
//! starting price, and nobody can sell more SOL out of the pool than buyers paid in. Liquidity providers hold shares
//! equal to the pool's liquidity, trading fees accrue apart from the reserves and are claimed, and a position can be
//! locked for good. Aretia keeps a share of every trading fee.
//!
//! READ docs/ARETIA_POOL.md before changing anything here. UNAUDITED. DEVNET ONLY until an independent audit and the
//! owner's explicit go-ahead.
//!
//! Design rules this file keeps:
//!  * No admin instruction exists. Every parameter is a constant below or fixed per pool at creation. The only key with
//!    power is the program upgrade authority (see the design doc).
//!  * All pricing and splitting arithmetic is in the `pool-math` crate, which is property-tested. This file only moves money.
//!  * State is written before any CPI. The only CPIs go to the System program and Token-2022, each checked by address.
//!    Mints with a transfer hook are refused, so no third-party code ever runs in the middle of a trade.
//!  * Reserves are numbers in the pool account. Donations to the vaults are ignored.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use pool_math::Pool as Math;

// The devnet test program. A mainnet build uses its own id, made by the owner and kept outside the repo; the id is written into the program.
declare_id!("4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc");

/// Aretia's management-fee wallet (the same one the Launch page, the swap fee and the curve use).
pub const FEE_WALLET: Pubkey = pubkey!("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
/// The flat fee for opening a pool: 0.05 SOL, taken inside `create_pool`.
pub const CREATE_FEE_LAMPORTS: u64 = 50_000_000;

/// Token-2022 extension types a pool token may carry: metadata pointer (18) and token metadata (19).
const ALLOWED_EXTENSIONS: [u16; 2] = [18, 19];

#[program]
pub mod aretia_pool {
    use super::*;

    /// Opens the pool for `mint`. `x0` tokens leave the creator's account for the pool's vault, `y0` lamports (usually
    /// none) go into the SOL vault, and `l0` is the opening liquidity: the virtual SOL reserve that sets the price.
    /// The position is opened for `owner`, locked in full when `lock`. The creator pays the flat creation fee.
    /// Launch protection: `sniper_bps` and `decay_secs` give a fee that starts at `sniper_bps` and falls in a straight line to `fee_bps`
    /// over `decay_secs` (at most 25% and one hour); both zero means none. Fixed for good at creation.
    pub fn create_pool(ctx: Context<CreatePool>, x0: u64, y0: u64, l0: u64, fee_bps: u16, lock: bool, sniper_bps: u16, decay_secs: u32) -> Result<()> {
        let mint_info = ctx.accounts.mint.to_account_info();
        require_keys_eq!(*mint_info.owner, anchor_spl::token_2022::ID, PoolError::MintNotAllowed);
        check_mint(&mint_info.try_borrow_data()?)?;
        require!(ctx.accounts.creator_token.amount >= x0, PoolError::NotEnoughTokens);

        let m = Math::open(x0, y0, l0, fee_bps).ok_or(PoolError::BadParameters)?;
        require!(pool_math::schedule_ok(fee_bps, sniper_bps, decay_secs), PoolError::BadParameters);
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.sol_bump = ctx.bumps.sol_vault;
        pool.mint = ctx.accounts.mint.key();
        pool.creator = ctx.accounts.creator.key();
        pool.set_math(&m);
        pool.created_at = now;
        pool.fee_start_bps = sniper_bps;
        pool.decay_secs = decay_secs;

        let pos = &mut ctx.accounts.position;
        pos.pool = pool.key();
        pos.owner = ctx.accounts.owner.key();
        pos.shares = l0;
        pos.locked = if lock { l0 } else { 0 };
        pos.checkpoint = 0;
        pos.pending = 0;
        pos.recipient = ctx.accounts.owner.key();

        let pool_key = pool.key();
        // The creation fee, then the SOL vault: it must hold the rent-exempt minimum to exist, and the creator pays that once.
        system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.fee_wallet.to_account_info() }),
            CREATE_FEE_LAMPORTS,
        )?;
        system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.sol_vault.to_account_info() }),
            Rent::get()?.minimum_balance(0).checked_add(y0).ok_or(PoolError::BadParameters)?,
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
            x0,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before + x0, PoolError::UnexpectedBalance);
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), &ctx.accounts.pool)?;

        emit!(Created { pool: pool_key, mint: ctx.accounts.mint.key(), creator: ctx.accounts.creator.key(), owner: ctx.accounts.owner.key(), x: x0, y: y0, l: l0, fee_bps, locked: lock, ts: now });
        Ok(())
    }

    /// Exact-input swap. Buy: `amount_in` lamports for tokens. Sell: `amount_in` tokens for lamports. Reverts unless at
    /// least `min_out` comes back (tokens on a buy; lamports after the fee on a sell).
    pub fn swap(ctx: Context<Swap>, is_buy: bool, amount_in: u64, min_out: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let now = Clock::get()?.unix_timestamp;
        // The fee in force now: the creator's launch schedule while it lasts, then the base fee.
        let base_fee = pool.fee_bps;
        let mut m = pool.math();
        m.fee_bps = pool_math::effective_fee_bps(base_fee, pool.fee_start_bps, pool.decay_secs, pool.created_at, now);
        let (out, fee, protocol, mut next) = if is_buy {
            let (b, n) = pool_math::buy(&m, amount_in).ok_or(PoolError::TradeTooSmall)?;
            (b.tokens_out, b.fee, b.protocol, n)
        } else {
            let (s, n) = pool_math::sell(&m, amount_in).ok_or(PoolError::TradeTooSmall)?;
            (s.net, s.fee, s.protocol, n)
        };
        require!(out >= min_out, PoolError::Slippage);

        // Effects first. The stored fee stays the base fee.
        next.fee_bps = base_fee;
        pool.set_math(&next);
        let (pool_key, mint_key, bump, sol_bump) = (pool.key(), pool.mint, pool.bump, pool.sol_bump);
        let sys = ctx.accounts.system_program.to_account_info();
        let before = ctx.accounts.vault.amount;

        // Interactions.
        if is_buy {
            if protocol > 0 {
                system_program::transfer(CpiContext::new(sys.clone(), Transfer { from: ctx.accounts.trader.to_account_info(), to: ctx.accounts.fee_wallet.to_account_info() }), protocol)?;
            }
            system_program::transfer(CpiContext::new(sys, Transfer { from: ctx.accounts.trader.to_account_info(), to: ctx.accounts.sol_vault.to_account_info() }), amount_in - protocol)?;
            let seeds: &[&[u8]] = &[b"pool", mint_key.as_ref(), &[bump]];
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked { from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.trader_token.to_account_info(), authority: ctx.accounts.pool.to_account_info() },
                    &[seeds],
                ),
                out,
                ctx.accounts.mint.decimals,
            )?;
            ctx.accounts.vault.reload()?;
            require!(ctx.accounts.vault.amount == before - out, PoolError::UnexpectedBalance);
        } else {
            transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked { from: ctx.accounts.trader_token.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.trader.to_account_info() },
                ),
                amount_in,
                ctx.accounts.mint.decimals,
            )?;
            ctx.accounts.vault.reload()?;
            require!(ctx.accounts.vault.amount == before + amount_in, PoolError::UnexpectedBalance);
            let sol_seeds: &[&[u8]] = &[b"sol_vault", pool_key.as_ref(), &[sol_bump]];
            system_program::transfer(CpiContext::new_with_signer(sys.clone(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.trader.to_account_info() }, &[sol_seeds]), out)?;
            if protocol > 0 {
                system_program::transfer(CpiContext::new_with_signer(sys, Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.fee_wallet.to_account_info() }, &[sol_seeds]), protocol)?;
            }
        }
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), &ctx.accounts.pool)?;

        emit!(Swapped { pool: pool_key, trader: ctx.accounts.trader.key(), is_buy, amount_in, amount_out: out, fee, protocol, x: next.x, y: next.y, l: next.l, ts: now });
        Ok(())
    }

    /// Adds `dl` of liquidity at the pool's current price. Pays tokens and SOL in proportion, rounded up, and reverts if either
    /// would be more than the caps. Opens the owner's position if they have none.
    pub fn add_liquidity(ctx: Context<AddLiquidity>, dl: u64, max_tokens: u64, max_sol: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        if pos.owner == Pubkey::default() {
            pos.pool = pool.key();
            pos.owner = ctx.accounts.owner.key();
            pos.checkpoint = pool.acc;
            pos.recipient = ctx.accounts.owner.key();
        }
        settle(pos, pool)?;
        let (a, next) = pool_math::add(&pool.math(), dl).ok_or(PoolError::BadParameters)?;
        require!(a.tokens_in <= max_tokens && a.sol_in <= max_sol, PoolError::Slippage);
        pool.set_math(&next);
        pos.shares = pos.shares.checked_add(dl).ok_or(PoolError::BadParameters)?;
        let (pool_key, now) = (pool.key(), Clock::get()?.unix_timestamp);

        if a.sol_in > 0 {
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.sol_vault.to_account_info() }),
                a.sol_in,
            )?;
        }
        let before = ctx.accounts.vault.amount;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked { from: ctx.accounts.owner_token.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.owner.to_account_info() },
            ),
            a.tokens_in,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before + a.tokens_in, PoolError::UnexpectedBalance);
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), &ctx.accounts.pool)?;

        emit!(LiquidityChanged { pool: pool_key, owner: ctx.accounts.owner.key(), added: true, dl, tokens: a.tokens_in, sol: a.sol_in, x: next.x, y: next.y, l: next.l, ts: now });
        Ok(())
    }

    /// Removes `dl` of the position's unlocked liquidity. Reverts unless at least `min_tokens` and `min_sol` come back.
    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, dl: u64, min_tokens: u64, min_sol: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        settle(pos, pool)?;
        require!(dl <= pos.shares - pos.locked, PoolError::Locked);
        let (r, next) = pool_math::remove(&pool.math(), dl).ok_or(PoolError::BadParameters)?;
        require!(r.tokens_out >= min_tokens && r.sol_out >= min_sol, PoolError::Slippage);
        pool.set_math(&next);
        pos.shares -= dl;
        let (pool_key, mint_key, bump, sol_bump, now) = (pool.key(), pool.mint, pool.bump, pool.sol_bump, Clock::get()?.unix_timestamp);

        let before = ctx.accounts.vault.amount;
        let seeds: &[&[u8]] = &[b"pool", mint_key.as_ref(), &[bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked { from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.owner_token.to_account_info(), authority: ctx.accounts.pool.to_account_info() },
                &[seeds],
            ),
            r.tokens_out,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == before - r.tokens_out, PoolError::UnexpectedBalance);
        if r.sol_out > 0 {
            let sol_seeds: &[&[u8]] = &[b"sol_vault", pool_key.as_ref(), &[sol_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.owner.to_account_info() }, &[sol_seeds]),
                r.sol_out,
            )?;
        }
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), &ctx.accounts.pool)?;

        emit!(LiquidityChanged { pool: pool_key, owner: ctx.accounts.owner.key(), added: false, dl, tokens: r.tokens_out, sol: r.sol_out, x: next.x, y: next.y, l: next.l, ts: now });
        Ok(())
    }

    /// Pays the position's fees to its recipient (the owner unless the owner has named another wallet). Only the owner may call it.
    /// Works on locked positions. The recipient must be able to hold the amount: a wallet with no SOL needs at least the rent minimum.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        settle(pos, pool)?;
        let amount = pos.pending;
        require!(amount > 0, PoolError::NothingToClaim);
        pos.pending = 0;
        pool.fee_reserve = pool.fee_reserve.checked_sub(amount).ok_or(PoolError::Insolvent)?;
        let (pool_key, sol_bump) = (pool.key(), pool.sol_bump);

        let sol_seeds: &[&[u8]] = &[b"sol_vault", pool_key.as_ref(), &[sol_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.recipient.to_account_info() }, &[sol_seeds]),
            amount,
        )?;
        require_solvent(&ctx.accounts.sol_vault.to_account_info(), &ctx.accounts.pool)?;
        emit!(Claimed { pool: pool_key, owner: ctx.accounts.owner.key(), amount, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// Names the wallet that `claim_fees` pays. Owner only, any time, even on a locked position: the lock covers the liquidity, not
    /// where the fees go.
    pub fn set_recipient(ctx: Context<SetRecipient>, recipient: Pubkey) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.recipient = recipient;
        emit!(RecipientSet { pool: pos.pool, owner: pos.owner, recipient, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// Locks `amount` more of the position's shares for good. Nothing in this program lowers `locked`.
    pub fn lock_liquidity(ctx: Context<LockLiquidity>, amount: u64) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(amount > 0, PoolError::BadParameters);
        let locked = pos.locked.checked_add(amount).ok_or(PoolError::BadParameters)?;
        require!(locked <= pos.shares, PoolError::BadParameters);
        pos.locked = locked;
        emit!(Locked { pool: pos.pool, owner: pos.owner, locked, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

/// Credits the position with the fees accrued since its checkpoint.
fn settle(pos: &mut Position, pool: &Pool) -> Result<()> {
    let owed = pool_math::pending_fee(pos.shares, pool.acc, pos.checkpoint).ok_or(PoolError::BadParameters)?;
    pos.pending = pos.pending.checked_add(owed).ok_or(PoolError::BadParameters)?;
    pos.checkpoint = pool.acc;
    Ok(())
}

/// The SOL vault must always hold the rent-exempt minimum plus the real SOL reserve plus every unclaimed fee.
fn require_solvent(sol_vault: &AccountInfo, pool: &Pool) -> Result<()> {
    let min = Rent::get()?.minimum_balance(0);
    let owed = (pool.y as u128) + (pool.fee_reserve as u128) + (min as u128);
    require!(sol_vault.lamports() as u128 >= owed, PoolError::Insolvent);
    Ok(())
}

/// Accepts only a fixed-supply Token-2022 mint with no freeze power and no extension beyond name/symbol metadata.
/// Reads the raw account so no library's idea of "known extension" can wave anything through.
pub fn check_mint(data: &[u8]) -> Result<()> {
    require!(data.len() >= 82, PoolError::MintNotAllowed);
    require!(u32::from_le_bytes(data[0..4].try_into().unwrap()) == 0, PoolError::MintNotAllowed); // no mint authority
    require!(data[45] == 1, PoolError::MintNotAllowed); // initialised
    require!(u32::from_le_bytes(data[46..50].try_into().unwrap()) == 0, PoolError::MintNotAllowed); // no freeze authority
    if data.len() == 82 {
        return Ok(());
    }
    require!(data.len() >= 166 && data[165] == 1, PoolError::MintNotAllowed); // account type: mint
    let mut at = 166usize;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if ty == 0 {
            // Uninitialised padding: only zeros may follow.
            require!(data[at..].iter().all(|b| *b == 0), PoolError::MintNotAllowed);
            return Ok(());
        }
        require!(ALLOWED_EXTENSIONS.contains(&ty), PoolError::MintNotAllowed);
        at = at.checked_add(4 + len).ok_or(PoolError::MintNotAllowed)?;
    }
    require!(at == data.len(), PoolError::MintNotAllowed);
    Ok(())
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub bump: u8,
    /// Bump of the SOL vault, a system-owned account at ["sol_vault", pool] that holds every lamport the pool owes.
    pub sol_bump: u8,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub fee_bps: u16,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub acc: u128,
    pub fee_reserve: u64,
    pub created_at: i64,
    /// Launch protection: the fee starts here and falls in a line to `fee_bps` over `decay_secs`. Zero means none.
    pub fee_start_bps: u16,
    pub decay_secs: u32,
}

impl Pool {
    fn math(&self) -> Math {
        Math { x: self.x, y: self.y, l: self.l, fee_bps: self.fee_bps, acc: self.acc, fee_reserve: self.fee_reserve }
    }
    fn set_math(&mut self, m: &Math) {
        self.x = m.x;
        self.y = m.y;
        self.l = m.l;
        self.fee_bps = m.fee_bps;
        self.acc = m.acc;
        self.fee_reserve = m.fee_reserve;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub locked: u64,
    pub checkpoint: u128,
    pub pending: u64,
    /// Where `claim_fees` pays. The owner until the owner says otherwise.
    pub recipient: Pubkey,
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: whoever will own the position. Any address; it gets no power over anything but its own position.
    pub owner: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = creator, token::token_program = token_program)]
    pub creator_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = creator, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    /// The system account that holds the pool's SOL.
    #[account(mut, seeds = [b"sol_vault", pool.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = creator, space = 8 + Position::INIT_SPACE, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    /// CHECK: address-checked; receives the creation fee.
    #[account(mut, address = FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.bump, has_one = mint)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"sol_vault", pool.key().as_ref()], bump = pool.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = trader, token::token_program = token_program)]
    pub trader_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: address-checked; receives Aretia's share of the fee.
    #[account(mut, address = FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.bump, has_one = mint)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"sol_vault", pool.key().as_ref()], bump = pool.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, space = 8 + Position::INIT_SPACE, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool", mint.key().as_ref()], bump = pool.bump, has_one = mint)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"sol_vault", pool.key().as_ref()], bump = pool.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump, has_one = pool, has_one = owner)]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"sol_vault", pool.key().as_ref()], bump = pool.sol_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump, has_one = pool, has_one = owner)]
    pub position: Account<'info, Position>,
    /// The wallet the position names to receive its fees.
    #[account(mut, address = position.recipient)]
    pub recipient: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRecipient<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"pool", pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump, has_one = pool, has_one = owner)]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct LockLiquidity<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"pool", pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), owner.key().as_ref()], bump, has_one = pool, has_one = owner)]
    pub position: Account<'info, Position>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct Created {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub owner: Pubkey,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub fee_bps: u16,
    pub locked: bool,
    pub ts: i64,
}

#[event]
pub struct Swapped {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
    pub protocol: u64,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub ts: i64,
}

#[event]
pub struct LiquidityChanged {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub added: bool,
    pub dl: u64,
    pub tokens: u64,
    pub sol: u64,
    pub x: u64,
    pub y: u64,
    pub l: u64,
    pub ts: i64,
}

#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct RecipientSet {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub recipient: Pubkey,
    pub ts: i64,
}

#[event]
pub struct Locked {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub locked: u64,
    pub ts: i64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum PoolError {
    #[msg("This token is not allowed: it must be a Token-2022 token with a fixed supply, no freeze power and no features beyond its name and symbol.")]
    MintNotAllowed,
    #[msg("An amount, the liquidity or the trading fee is outside what a pool can use.")]
    BadParameters,
    #[msg("The creator's account does not hold that many tokens.")]
    NotEnoughTokens,
    #[msg("That trade is too small, too large, or would pay out SOL the pool does not hold.")]
    TradeTooSmall,
    #[msg("The price moved past the limit you set.")]
    Slippage,
    #[msg("A token balance did not change by exactly the amount moved.")]
    UnexpectedBalance,
    #[msg("The pool vault would be left short.")]
    Insolvent,
    #[msg("That liquidity is locked for good.")]
    Locked,
    #[msg("There are no fees to claim.")]
    NothingToClaim,
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
        // transfer fee (1), hook (14), permanent delegate (12), non-transferable (9), confidential (4), default account state (6)...
        for ty in [1u16, 3, 4, 6, 9, 12, 14, 20, 26] {
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
}
