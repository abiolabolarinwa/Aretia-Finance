//! Aretia Finance -- ACT Staking
//! ---------------------------------------------------------------------
//! Infrastructure for Part VIII, Section 30 of WHITEPAPER.md ("Tiered
//! Access Through ACT Staking"). This program locks ACT for a chosen
//! duration and computes a deterministic on-chain tier from the amount
//! and duration staked. It does NOT gate access to anything -- Stage Two
//! (the thing tiers were proposed to gate) does not exist yet. See
//! STAKING_DESIGN.md for the full design record, the tier formula and
//! its rationale, and the build log: compiled clean, deployed live on
//! devnet, and `initialize_config` verified correct end-to-end there.
//! `stake`/`unstake` are still pending real exercise -- see the
//! `test-fast-clock` feature below, added specifically to make that
//! testable without waiting real days.
//!
//! Two rules from Section 30 that this program must never be extended to
//! violate: no tier confers investor eligibility, and ACT's marketed
//! value must never be represented as a function of any gated project's
//! financial performance. This program only ever computes and stores a
//! number derived from amount and duration; it has no knowledge of, and
//! must never be given knowledge of, any project or its returns.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// Generated via `solana-keygen new` on 2026-09-12 (see Anchor.toml). Not yet deployed.
declare_id!("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");

// Real builds (devnet, mainnet) use real days. The `test-fast-clock` feature
// exists ONLY to make `stake`/`unstake`'s lock-duration logic testable on a
// local validator without waiting real days for a lock to mature -- it
// shrinks a "day" to 2 seconds so a 30-day lock resolves in 60 real seconds.
// This changes no logic, only this one constant's value; a build with this
// feature enabled must never be deployed anywhere but a throwaway local
// validator, and this repo's own scripts enforce that by construction (the
// devnet/mainnet build scripts never pass --features test-fast-clock).
#[cfg(feature = "test-fast-clock")]
pub const SECONDS_PER_DAY: i64 = 2;
#[cfg(not(feature = "test-fast-clock"))]
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const NUM_TIERS: usize = 5; // tier 0 (no stake) through tier 4
pub const NUM_DURATIONS: usize = 4; // 30 / 90 / 180 / 365 days

#[program]
pub mod act_staking {
    use super::*;

    /// One-time setup. `authority` should be the treasury multisig's vault
    /// PDA (see TREASURY_V2.md), not a personal key -- Squads' own 2-of-3
    /// threshold is what actually gates calls to `update_tier_config` and
    /// `set_paused`; this program only checks a single signer against
    /// whatever `authority` is set to.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        tiers: [u64; NUM_TIERS],
        duration_days: [u16; NUM_DURATIONS],
        duration_multiplier: [u16; NUM_DURATIONS],
    ) -> Result<()> {
        require!(tiers[0] == 0, StakingError::InvalidTierTable);
        for i in 1..NUM_TIERS {
            require!(tiers[i] > tiers[i - 1], StakingError::InvalidTierTable);
        }
        for i in 0..NUM_DURATIONS {
            require!(duration_days[i] > 0, StakingError::InvalidDurationTable);
            require!(
                duration_multiplier[i] >= 100,
                StakingError::InvalidDurationTable
            );
        }

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.vault = ctx.accounts.vault.key();
        config.total_staked = 0;
        config.tiers = tiers;
        config.duration_days = duration_days;
        config.duration_multiplier = duration_multiplier;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.vault_authority_bump = ctx.bumps.vault_authority;

        Ok(())
    }

    /// Authority-gated. Replaces the tier thresholds and/or duration
    /// multipliers without a program redeploy -- this is how the
    /// illustrative starting values in STAKING_DESIGN.md get recalibrated
    /// once real holder-distribution data exists.
    pub fn update_tier_config(
        ctx: Context<UpdateConfig>,
        tiers: [u64; NUM_TIERS],
        duration_days: [u16; NUM_DURATIONS],
        duration_multiplier: [u16; NUM_DURATIONS],
    ) -> Result<()> {
        require!(tiers[0] == 0, StakingError::InvalidTierTable);
        for i in 1..NUM_TIERS {
            require!(tiers[i] > tiers[i - 1], StakingError::InvalidTierTable);
        }
        for i in 0..NUM_DURATIONS {
            require!(duration_days[i] > 0, StakingError::InvalidDurationTable);
            require!(
                duration_multiplier[i] >= 100,
                StakingError::InvalidDurationTable
            );
        }

        let config = &mut ctx.accounts.config;
        config.tiers = tiers;
        config.duration_days = duration_days;
        config.duration_multiplier = duration_multiplier;

        Ok(())
    }

    /// Authority-gated circuit breaker. When paused, `stake` is rejected
    /// but `unstake` still works -- a bug freezes new deposits without
    /// trapping anyone's existing funds.
    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Lock `amount` (gross, pre-fee) ACT for `lock_days`. `lock_days`
    /// must match one of the four configured options. Topping up an
    /// existing, still-locked position blends the stake's age by a
    /// weighted average (see STAKING_DESIGN.md) and requires the new
    /// `lock_days` to be at least the days remaining on the existing
    /// lock -- a commitment can be extended, never shortened.
    pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u16) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, StakingError::StakingPaused);
        require!(amount > 0, StakingError::ZeroAmount);

        let duration_idx = config
            .duration_days
            .iter()
            .position(|&d| d == lock_days)
            .ok_or(StakingError::InvalidLockDuration)?;

        let now = Clock::get()?.unix_timestamp;
        let user_stake = &ctx.accounts.user_stake;
        let has_existing = user_stake.amount > 0;

        if has_existing {
            let remaining_days =
                (user_stake.unlock_at.saturating_sub(now)).max(0) / SECONDS_PER_DAY;
            require!(
                (lock_days as i64) >= remaining_days,
                StakingError::CannotShortenLock
            );
        }

        // Balance-delta fee handling: read the vault's balance before and
        // after the CPI rather than trusting `amount` or hardcoding the
        // current fee rate. Correct under a changing fee rate with no
        // program update required -- see STAKING_DESIGN.md, "Fee handling."
        let balance_before = ctx.accounts.vault.amount;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        ctx.accounts.vault.reload()?;
        let balance_after = ctx.accounts.vault.amount;
        let net_received = balance_after
            .checked_sub(balance_before)
            .ok_or(StakingError::MathOverflow)?;
        require!(net_received > 0, StakingError::ZeroAmount);

        let user_stake = &mut ctx.accounts.user_stake;
        let old_amount = user_stake.amount;

        let new_staked_at = if old_amount == 0 {
            now
        } else {
            let old_age = now.saturating_sub(user_stake.staked_at).max(0) as u128;
            let old_amount_u128 = old_amount as u128;
            let total_u128 = (old_amount as u128)
                .checked_add(net_received as u128)
                .ok_or(StakingError::MathOverflow)?;
            let blended_age = (old_amount_u128 * old_age) / total_u128;
            now.saturating_sub(blended_age as i64)
        };

        let new_amount = old_amount
            .checked_add(net_received)
            .ok_or(StakingError::MathOverflow)?;

        user_stake.owner = ctx.accounts.owner.key();
        user_stake.amount = new_amount;
        user_stake.lock_days = lock_days;
        user_stake.staked_at = new_staked_at;
        user_stake.unlock_at = now + (lock_days as i64) * SECONDS_PER_DAY;
        user_stake.bump = ctx.bumps.user_stake;

        let multiplier = config.duration_multiplier[duration_idx] as u128;
        let cas = (new_amount as u128)
            .checked_mul(multiplier)
            .ok_or(StakingError::MathOverflow)?
            / 100;
        user_stake.tier = tier_for_cas(cas, &config.tiers);

        let config = &mut ctx.accounts.config;
        config.total_staked = config
            .total_staked
            .checked_add(net_received)
            .ok_or(StakingError::MathOverflow)?;

        Ok(())
    }

    /// Withdraws the full staked position. Only callable once the lock
    /// has matured. The return transfer is itself subject to ACT's
    /// transfer fee like any other transfer -- the wallet receives net of
    /// that fee, not the gross `amount` recorded here.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let user_stake = &ctx.accounts.user_stake;
        require!(user_stake.amount > 0, StakingError::NothingStaked);
        require!(now >= user_stake.unlock_at, StakingError::StillLocked);

        let amount = user_stake.amount;
        let bump = ctx.accounts.config.vault_authority_bump;
        let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        let config = &mut ctx.accounts.config;
        config.total_staked = config
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::MathOverflow)?;

        // user_stake account closes to `owner` via the `close` constraint,
        // refunding rent. Nothing further to zero out.

        Ok(())
    }
}

/// Highest tier whose threshold `cas` meets or exceeds. `tiers[0]` is
/// always 0, so this always returns at least tier 0.
fn tier_for_cas(cas: u128, tiers: &[u64; NUM_TIERS]) -> u8 {
    let mut tier: u8 = 0;
    for (i, &threshold) in tiers.iter().enumerate() {
        if cas >= threshold as u128 {
            tier = i as u8;
        }
    }
    tier
}

#[account]
#[derive(InitSpace)]
pub struct StakeConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub total_staked: u64,
    pub tiers: [u64; NUM_TIERS],
    pub duration_days: [u16; NUM_DURATIONS],
    pub duration_multiplier: [u16; NUM_DURATIONS],
    pub paused: bool,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_days: u16,
    pub staked_at: i64,
    pub unlock_at: i64,
    pub tier: u8,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + StakeConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, StakeConfig>,

    /// CHECK: PDA used only as the vault ATA's token authority; holds no
    /// data of its own, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, StakeConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = mint,
        has_one = vault
    )]
    pub config: Account<'info, StakeConfig>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [b"user_stake", owner.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = mint,
        has_one = vault
    )]
    pub config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [b"user_stake", owner.key().as_ref()],
        bump = user_stake.bump,
        has_one = owner,
        close = owner
    )]
    pub user_stake: Account<'info, UserStake>,

    /// CHECK: PDA signer for the vault->user transfer, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum StakingError {
    #[msg("Staking is currently paused.")]
    StakingPaused,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("lock_days does not match a configured duration option.")]
    InvalidLockDuration,
    #[msg("A new lock must be at least as long as the time remaining on the existing lock.")]
    CannotShortenLock,
    #[msg("Nothing is staked for this wallet.")]
    NothingStaked,
    #[msg("This position's lock has not yet matured.")]
    StillLocked,
    #[msg("Tier thresholds must start at 0 and strictly increase.")]
    InvalidTierTable,
    #[msg("Duration options must be non-zero days with a multiplier of at least 1.00x.")]
    InvalidDurationTable,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
