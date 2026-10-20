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
use anchor_lang::solana_program::pubkey;
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
/// Largest duration multiplier a config may set, in hundredths: 10.00x (I-18).
/// The design table tops out at 2.00x; this bound only stops a typo or a
/// compromised authority from making one lock length dwarf every other.
pub const MAX_DURATION_MULTIPLIER: u16 = 1_000;
/// Longest lock a config may offer: ten years.
pub const MAX_DURATION_DAYS: u16 = 3_650;

/// The only mint `initialize_config` accepts (M-10): real ACT, the
/// Token-2022 mint in TOKENOMICS.md. A `test-mint` build (which
/// `test-fast-clock` turns on) accepts act-presale's throwaway devnet test
/// mint instead, so the throwaway test deployments can still be set up; such
/// a build must never be deployed anywhere real.
#[cfg(not(feature = "test-mint"))]
pub const ACT_MINT: Pubkey = pubkey!("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
#[cfg(feature = "test-mint")]
pub const ACT_MINT: Pubkey = pubkey!("DByy9CGFgXAEGeaufeA275y8tP9aiXWZkjRanNMd4pEr");

#[program]
pub mod act_staking {
    use super::*;

    /// One-time setup. Only the program's upgrade authority may call it
    /// (checked against the program's ProgramData account), and only for the
    /// ACT mint, so nobody can front-run the deployer and take the config or
    /// bind it to another mint (M-10). The vault is opened idempotently, so
    /// an associated account someone opened in advance cannot block it.
    /// `authority` becomes `config.authority`; hand it to the treasury
    /// multisig's vault PDA afterwards with `set_config_authority` (see
    /// TREASURY_V2.md) -- Squads' own 2-of-3 threshold is what then gates
    /// `update_tier_config` and `set_paused`; this program only checks a
    /// single signer against whatever `authority` is set to.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        tiers: [u64; NUM_TIERS],
        duration_days: [u16; NUM_DURATIONS],
        duration_multiplier: [u16; NUM_DURATIONS],
    ) -> Result<()> {
        validate_tables(&tiers, &duration_days, &duration_multiplier)?;

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
        validate_tables(&tiers, &duration_days, &duration_multiplier)?;

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

    /// Hands `config.authority` off to a new key, signed by the current
    /// authority. Lets the authority move from an initial deployer key
    /// onto the treasury multisig (or any other durable key) without a
    /// program redeploy. Deliberately narrow: it changes nothing else
    /// about the account.
    pub fn set_config_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
        require_keys_neq!(
            new_authority,
            Pubkey::default(),
            StakingError::InvalidNewAuthority
        );
        ctx.accounts.config.authority = new_authority;
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

        // `lock_days` must be one of the configured options.
        config
            .duration_days
            .iter()
            .position(|&d| d == lock_days)
            .ok_or(StakingError::InvalidLockDuration)?;

        let now = Clock::get()?.unix_timestamp;
        let user_stake = &ctx.accounts.user_stake;
        let has_existing = user_stake.amount > 0;

        if has_existing {
            // Ceiling division, not floor: with ~29 days 23 hours actually
            // remaining, floor division reads 29 and would let lock_days=29
            // pass the check below even though the resulting unlock_at lands
            // nearly a full day earlier than the one already in force --
            // shortening the lock by exactly the amount "cannot shorten"
            // exists to prevent. Rounding the remaining time up to a whole
            // day closes that gap.
            let remaining_seconds = (user_stake.unlock_at.saturating_sub(now)).max(0);
            let remaining_days = remaining_seconds
                .checked_add(SECONDS_PER_DAY - 1)
                .ok_or(StakingError::MathOverflow)?
                / SECONDS_PER_DAY;
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

        // The stored tier is a snapshot of the tier right now, recomputed
        // from scratch on every stake (never carried over). It goes stale
        // when the lock expires or the config changes: anything that reads
        // a tier must use `effective_tier` (or the SDK's `effectiveTier`)
        // at the time it reads, never this field (L-30).
        user_stake.tier = effective_tier(new_amount, lock_days, user_stake.unlock_at, now, config)?;

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

/// Checks a tier/duration table: thresholds start at 0 and strictly rise;
/// every duration is between 1 day and `MAX_DURATION_DAYS` and appears only
/// once; every multiplier is between 1.00x and `MAX_DURATION_MULTIPLIER`
/// (I-18).
fn validate_tables(
    tiers: &[u64; NUM_TIERS],
    duration_days: &[u16; NUM_DURATIONS],
    duration_multiplier: &[u16; NUM_DURATIONS],
) -> Result<()> {
    require!(tiers[0] == 0, StakingError::InvalidTierTable);
    for i in 1..NUM_TIERS {
        require!(tiers[i] > tiers[i - 1], StakingError::InvalidTierTable);
    }
    for i in 0..NUM_DURATIONS {
        require!(
            duration_days[i] > 0 && duration_days[i] <= MAX_DURATION_DAYS,
            StakingError::InvalidDurationTable
        );
        require!(
            duration_multiplier[i] >= 100 && duration_multiplier[i] <= MAX_DURATION_MULTIPLIER,
            StakingError::InvalidDurationTable
        );
        require!(
            !duration_days[..i].contains(&duration_days[i]),
            StakingError::InvalidDurationTable
        );
    }
    Ok(())
}

/// The tier a stake has at `now` under `config`, worked out from scratch
/// (L-30). The lock multiplier applies only while the lock runs
/// (`now < unlock_at`) and only if `lock_days` is still one of the
/// configured durations; an expired lock, or one whose duration the config
/// no longer offers, counts at 1.00x.
pub fn effective_tier(
    amount: u64,
    lock_days: u16,
    unlock_at: i64,
    now: i64,
    config: &StakeConfig,
) -> Result<u8> {
    let multiplier = if now < unlock_at {
        config
            .duration_days
            .iter()
            .position(|&d| d == lock_days)
            .map(|i| config.duration_multiplier[i])
            .unwrap_or(100)
    } else {
        100
    } as u128;
    let cas = (amount as u128)
        .checked_mul(multiplier)
        .ok_or(StakingError::MathOverflow)?
        / 100;
    Ok(tier_for_cas(cas, &config.tiers))
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
#[derive(InitSpace, Debug)]
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

    #[account(address = ACT_MINT @ StakingError::WrongMint)]
    pub mint: InterfaceAccount<'info, Mint>,

    // `init_if_needed`, not `init`: anyone may open an associated account
    // for any owner, so a stranger opening the vault first must not block
    // initialisation for good (M-10). Anchor still checks an existing one
    // is the vault authority's account for this mint and token program.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// This program, to find its ProgramData account.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ StakingError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::ActStaking>,

    /// The program's ProgramData: `authority` must be its upgrade authority.
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ StakingError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
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
    #[msg("Duration options must be distinct, between 1 and 3,650 days, with multipliers between 1.00x and 10.00x.")]
    InvalidDurationTable,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("New authority cannot be the default (all-zero) pubkey.")]
    InvalidNewAuthority,
    #[msg("Only the program's upgrade authority may initialise the config.")]
    NotUpgradeAuthority,
    #[msg("The config can only be initialised for the ACT mint.")]
    WrongMint,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> StakeConfig {
        StakeConfig {
            authority: Pubkey::default(),
            mint: ACT_MINT,
            vault: Pubkey::default(),
            total_staked: 0,
            tiers: [0, 1_000, 5_000, 20_000, 100_000],
            duration_days: [30, 90, 180, 365],
            duration_multiplier: [100, 125, 150, 200],
            paused: false,
            bump: 0,
            vault_authority_bump: 0,
        }
    }

    #[test]
    fn duplicate_durations_and_huge_multipliers_are_refused() {
        let c = config();
        assert!(validate_tables(&c.tiers, &c.duration_days, &c.duration_multiplier).is_ok());
        assert!(validate_tables(&c.tiers, &[30, 90, 90, 365], &c.duration_multiplier).is_err(), "duplicate duration");
        assert!(validate_tables(&c.tiers, &[30, 30, 30, 30], &c.duration_multiplier).is_err());
        assert!(validate_tables(&c.tiers, &c.duration_days, &[100, 125, 150, MAX_DURATION_MULTIPLIER + 1]).is_err(), "multiplier above the bound");
        assert!(validate_tables(&c.tiers, &c.duration_days, &[100, 125, 150, MAX_DURATION_MULTIPLIER]).is_ok());
        assert!(validate_tables(&c.tiers, &c.duration_days, &[99, 125, 150, 200]).is_err());
        assert!(validate_tables(&c.tiers, &[0, 90, 180, 365], &c.duration_multiplier).is_err());
        assert!(validate_tables(&c.tiers, &[30, 90, 180, MAX_DURATION_DAYS + 1], &c.duration_multiplier).is_err());
        assert!(validate_tables(&[1, 2, 3, 4, 5], &c.duration_days, &c.duration_multiplier).is_err());
        assert!(validate_tables(&[0, 2, 2, 4, 5], &c.duration_days, &c.duration_multiplier).is_err());
    }

    #[test]
    fn an_expired_lock_counts_at_one_times() {
        let c = config();
        // 4,000 staked for 365 days at 2.00x is 8,000: tier 2 while locked.
        assert_eq!(effective_tier(4_000, 365, 1_000, 999, &c).unwrap(), 2);
        // Once the lock has run out it is 4,000 at 1.00x: tier 1.
        assert_eq!(effective_tier(4_000, 365, 1_000, 1_000, &c).unwrap(), 1);
        assert_eq!(effective_tier(4_000, 365, 1_000, 5_000, &c).unwrap(), 1);
        // A duration the config no longer offers also counts at 1.00x.
        let mut changed = c.clone();
        changed.duration_days = [30, 90, 180, 360];
        assert_eq!(effective_tier(4_000, 365, 1_000, 0, &changed).unwrap(), 1);
        // And a change of thresholds is read at once, not from a stored value.
        changed.tiers = [0, 10_000, 20_000, 30_000, 40_000];
        assert_eq!(effective_tier(4_000, 90, 1_000, 0, &changed).unwrap(), 0);
        assert_eq!(effective_tier(0, 30, 1_000, 0, &c).unwrap(), 0);
    }
}
