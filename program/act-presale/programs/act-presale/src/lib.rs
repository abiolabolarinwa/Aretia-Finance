//! Aretia Finance -- ACT Public Presale
//! ---------------------------------------------------------------------
//! Public presale for ACT: Oct 1 - Dec 1 2026, 100,000,000 ACT (net) at
//! $0.01/ACT, $1,000,000 hard cap, $500,000 soft cap, $10 min / $10,000
//! max per wallet, 25% unlocked at TGE with the remaining 75% vesting
//! linearly over 48 hours. Accepts USDC and USDT, plus native SOL via
//! `buy_with_sol` (see "Payment currencies" below). See
//! PRESALE_DESIGN.md for the full design record. Deployed and verified
//! on devnet; not to be deployed to mainnet without separate explicit
//! approval.
//!
//! This program is deliberately separate from act-staking: a presale
//! raises initial capital to launch ACT, the 3.5% transfer fee is the
//! recurring mechanism that funds the Climate Catalyst Fund. These two
//! concepts must never be merged.
//!
//! ACT's 3.5% Token-2022 transfer fee applies to every transfer this
//! program makes, including the ones that move ACT into and out of this
//! program's own vault. Two design choices follow directly from that:
//!
//! 1. `fund_act_reserve` uses the same balance-delta pattern act-staking
//!    already established (read the vault's balance before and after the
//!    CPI, trust that delta, not the nominal transfer amount) so funding
//!    is correct without this program hardcoding the current fee rate.
//! 2. `claim` gross-up: a buyer's vesting entitlement is tracked entirely
//!    in *net* terms (the ACT amount they were actually sold), but the
//!    vault-to-buyer transfer at claim time is itself fee-bearing. This
//!    program reads the ACT mint's live TransferFeeConfig extension and
//!    calls `calculate_pre_fee_amount` to work out the gross amount to
//!    send so the buyer receives (at least) their net entitlement, the
//!    same "how much do I send so the recipient nets X" problem the
//!    whitepaper's §14.5 management-fee gross-up already solves, applied
//!    here to per-claim vesting payouts instead of a single transfer.
//!
//! ## Payment currencies
//!
//! USDC and USDT are both handled by the *same* generic code path: both
//! are plain SPL Token, 6 decimals, $1-pegged, so the same
//! `price_micro_payment_per_act` conversion is correct for either. A
//! presale instance is configured with both accepted mints up front
//! (`PresaleConfig.accepted_mints`/`accepted_vaults`); `buy`/`refund`
//! take whichever mint/vault pair the caller is using and validate it
//! matches one of the two configured pairs by index.
//!
//! SOL is accepted via `buy_with_sol`, priced against Pyth's SOL/USD pull
//! oracle (feed ID confirmed live against Pyth's own Hermes API and the
//! `pyth-solana-receiver-sdk` crate's own doc-comment example -- not
//! guessed). The caller supplies a `PriceUpdateV2` account (posted
//! on-chain moments earlier, in the same or a preceding transaction, via
//! Pyth's standard pull-oracle flow); this program validates it against
//! the fixed `SOL_USD_FEED_ID` and rejects anything older than
//! `MAX_PRICE_STALENESS_SECONDS`. Because SOL floats against USD (unlike
//! USDC/USDT), its contribution is converted to a USD-equivalent amount
//! at the live price and folded into the *same* combined
//! `total_raised_payment`/min-buy/max-buy/hard-cap accounting USDC and
//! USDT already share -- `BuyerAccount.sol_usd_value_contributed` tracks
//! that USD-equivalent for cap purposes, while
//! `BuyerAccount.sol_lamports_contributed` separately tracks the exact
//! lamports paid, so a refund returns precisely what was paid regardless
//! of how the price has moved since. SOL is escrowed as native lamports
//! directly on the `vault_authority` PDA (no separate vault account or
//! wrapping into wSOL needed) and swept/refunded via ordinary System
//! Program transfers signed the same way every other `vault_authority`
//! CPI in this program already is.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as SplMint;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

// Generated via `solana-keygen new` on this machine (see Anchor.toml). Not yet deployed.
declare_id!("5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku");

// Real builds (devnet, mainnet) use real seconds. The `test-fast-clock` feature
// exists ONLY to make the sale-window and vesting-duration logic testable on a
// local validator without waiting real days -- see act-staking's identical
// pattern for the rationale. A build with this feature enabled must never be
// deployed anywhere but a throwaway local validator.
#[cfg(feature = "test-fast-clock")]
pub const SECONDS_PER_DAY: i64 = 2;
#[cfg(not(feature = "test-fast-clock"))]
pub const SECONDS_PER_DAY: i64 = 86_400;

pub const ACT_DECIMALS: u32 = 9;
pub const BPS_DENOMINATOR: u64 = 10_000;
/// USDC and USDT, index-matched against `PresaleConfig.accepted_mints` /
/// `accepted_vaults` / `treasury_payment_accounts`.
pub const NUM_PAYMENT_CURRENCIES: usize = 2;

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_FINALIZED: u8 = 1;
pub const STATUS_REFUNDING: u8 = 2;

/// Pyth's SOL/USD price feed ID (not an account address -- pull-oracle
/// price accounts are ephemeral). Confirmed live via Pyth's own Hermes
/// API (`GET https://hermes.pyth.network/v2/price_feeds?query=SOL/USD`,
/// description "SOLANA / US DOLLAR") and cross-checked against this
/// exact byte array appearing as `pyth-solana-receiver-sdk`'s own
/// `get_feed_id_from_hex` test fixture for "0xef0d8b6f...b56d" -- not
/// guessed or hand-typed from hex.
pub const SOL_USD_FEED_ID: [u8; 32] = [
    239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208,
    198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];
/// Reject any Pyth price update older than this. 60s is generous enough
/// that a normal pull-then-consume transaction never fails on staleness
/// under ordinary network conditions, while still rejecting a price an
/// attacker captured long ago and is replaying.
pub const MAX_PRICE_STALENESS_SECONDS: u64 = 60;

#[program]
pub mod act_presale {
    use super::*;

    /// One-time setup. `authority` should be the treasury multisig (see
    /// TREASURY_V2.md), not a personal key, mirroring act-staking. Creates
    /// the config PDA and the ACT vault ATA, owned by this program's
    /// `vault_authority` PDA. Does not move any tokens -- see
    /// `fund_act_reserve` for that. `accepted_mints`/`accepted_vaults`/
    /// `treasury_payment_accounts` start zeroed; call
    /// `initialize_payment_currency` twice (once for USDC, once for USDT)
    /// to fill them in -- see that instruction's doc comment for why this
    /// is three instructions instead of one.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_presale(
        ctx: Context<InitializePresale>,
        price_micro_payment_per_act: u64,
        start_ts: i64,
        end_ts: i64,
        hard_cap_payment: u64,
        soft_cap_payment: u64,
        min_buy_payment: u64,
        max_buy_payment: u64,
        tge_bps: u16,
        vesting_duration_days: u32,
    ) -> Result<()> {
        require!(start_ts < end_ts, PresaleError::InvalidWindow);
        require!(
            soft_cap_payment > 0 && soft_cap_payment <= hard_cap_payment,
            PresaleError::InvalidCaps
        );
        require!(
            min_buy_payment > 0 && min_buy_payment <= max_buy_payment,
            PresaleError::InvalidBuyLimits
        );
        require!(max_buy_payment <= hard_cap_payment, PresaleError::InvalidBuyLimits);
        require!(
            tge_bps as u64 <= BPS_DENOMINATOR,
            PresaleError::InvalidVestingConfig
        );
        require!(vesting_duration_days > 0, PresaleError::InvalidVestingConfig);
        require!(price_micro_payment_per_act > 0, PresaleError::InvalidPrice);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.act_mint = ctx.accounts.act_mint.key();
        config.accepted_mints = [Pubkey::default(); NUM_PAYMENT_CURRENCIES];
        config.accepted_vaults = [Pubkey::default(); NUM_PAYMENT_CURRENCIES];
        config.treasury_payment_accounts = [Pubkey::default(); NUM_PAYMENT_CURRENCIES];
        config.act_vault = ctx.accounts.act_vault.key();
        config.treasury_act_account = ctx.accounts.treasury_act_account.key();
        config.treasury_sol_account = ctx.accounts.treasury_sol_account.key();
        config.price_micro_payment_per_act = price_micro_payment_per_act;
        config.start_ts = start_ts;
        config.end_ts = end_ts;
        config.tge_ts = 0;
        config.tge_bps = tge_bps;
        config.vesting_duration_seconds = (vesting_duration_days as i64) * SECONDS_PER_DAY;
        config.hard_cap_payment = hard_cap_payment;
        config.soft_cap_payment = soft_cap_payment;
        config.min_buy_payment = min_buy_payment;
        config.max_buy_payment = max_buy_payment;
        config.total_raised_payment = 0;
        config.total_act_sold_net = 0;
        config.total_act_claimed_net = 0;
        config.act_reserve_net = 0;
        config.status = STATUS_ACTIVE;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.vault_authority_bump = ctx.bumps.vault_authority;

        Ok(())
    }

    /// Authority-gated. Registers one accepted payment currency (USDC or
    /// USDT) at slot `index` (0 or 1) and creates its vault ATA. Called
    /// twice, once per currency -- `initialize_presale` originally tried
    /// to create the config, the ACT vault, *and* both payment vaults in
    /// one instruction, and its generated `try_accounts` function
    /// overflowed the SBF VM's 4096-byte stack frame limit (each `init`
    /// associated-token-account constraint expands into real PDA/CPI
    /// code, and three of them in one function was too much even after
    /// boxing every account). Splitting to one `init` per instruction is
    /// the fix, not a workaround -- `act-staking`'s single-vault
    /// `initialize_config` never hit this limit for the same reason.
    /// `index` must not already be set (re-registering a slot is not
    /// supported; deploy a new presale instance instead).
    pub fn initialize_payment_currency(
        ctx: Context<InitializePaymentCurrency>,
        index: u8,
    ) -> Result<()> {
        let idx = index as usize;
        require!(idx < NUM_PAYMENT_CURRENCIES, PresaleError::InvalidCurrencyIndex);
        require!(
            ctx.accounts.config.accepted_mints[idx] == Pubkey::default(),
            PresaleError::CurrencySlotAlreadySet
        );
        for i in 0..NUM_PAYMENT_CURRENCIES {
            if i != idx {
                require!(
                    ctx.accounts.config.accepted_mints[i] != ctx.accounts.mint.key(),
                    PresaleError::DuplicatePaymentMint
                );
            }
        }

        let config = &mut ctx.accounts.config;
        config.accepted_mints[idx] = ctx.accounts.mint.key();
        config.accepted_vaults[idx] = ctx.accounts.vault.key();
        config.treasury_payment_accounts[idx] = ctx.accounts.treasury_payment_account.key();

        Ok(())
    }

    /// Authority-gated. Tops up the ACT vault that vesting claims are paid
    /// from. Sized against `PRESALE_DESIGN.md`'s two-hop gross-up math:
    /// this transfer itself loses the 3.5% transfer fee, so the amount
    /// that actually lands in the vault (and is recorded here) is less
    /// than whatever the authority's wallet sent. Uses the same
    /// balance-delta pattern as act-staking's `stake` so this is correct
    /// regardless of the fee rate in effect at call time.
    pub fn fund_act_reserve(ctx: Context<FundActReserve>, amount: u64) -> Result<()> {
        require!(amount > 0, PresaleError::ZeroAmount);

        let balance_before = ctx.accounts.act_vault.amount;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.authority_act_account.to_account_info(),
            mint: ctx.accounts.act_mint.to_account_info(),
            to: ctx.accounts.act_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ACT_DECIMALS as u8)?;

        ctx.accounts.act_vault.reload()?;
        let balance_after = ctx.accounts.act_vault.amount;
        let net_received = balance_after
            .checked_sub(balance_before)
            .ok_or(PresaleError::MathOverflow)?;
        require!(net_received > 0, PresaleError::ZeroAmount);

        let config = &mut ctx.accounts.config;
        config.act_reserve_net = config
            .act_reserve_net
            .checked_add(net_received)
            .ok_or(PresaleError::MathOverflow)?;

        Ok(())
    }

    /// Public. Buys ACT with `payment_amount` of whichever accepted
    /// currency (USDC or USDT) the passed `payment_mint`/`payment_vault`
    /// pair identifies (validated against `config.accepted_mints` /
    /// `accepted_vaults` by matching index). Funds are recorded in escrow
    /// (not swept to treasury) until `finalize`, so a soft-cap miss can
    /// actually be refunded. `min_buy_payment` applies only to a wallet's
    /// first contribution *in either currency combined*; `max_buy_payment`
    /// applies to the cumulative total across both currencies.
    pub fn buy(ctx: Context<Buy>, payment_amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == STATUS_ACTIVE, PresaleError::PresaleNotActive);
        require!(!config.paused, PresaleError::PresalePaused);
        require!(payment_amount > 0, PresaleError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.start_ts, PresaleError::PresaleNotStarted);
        require!(now < config.end_ts, PresaleError::PresaleEnded);

        let idx = payment_currency_index(
            config,
            &ctx.accounts.payment_mint.key(),
            &ctx.accounts.payment_vault.key(),
        )?;

        let buyer_account = &ctx.accounts.buyer_account;
        let total_contributed_before: u64 = buyer_account
            .payment_contributed
            .iter()
            .try_fold(0u64, |acc, &v| acc.checked_add(v))
            .ok_or(PresaleError::MathOverflow)?
            .checked_add(buyer_account.sol_usd_value_contributed)
            .ok_or(PresaleError::MathOverflow)?;
        if total_contributed_before == 0 {
            require!(
                payment_amount >= config.min_buy_payment,
                PresaleError::BelowMinBuy
            );
        }

        let new_total_for_buyer = total_contributed_before
            .checked_add(payment_amount)
            .ok_or(PresaleError::MathOverflow)?;
        require!(
            new_total_for_buyer <= config.max_buy_payment,
            PresaleError::AboveMaxBuy
        );

        let new_total_raised = config
            .total_raised_payment
            .checked_add(payment_amount)
            .ok_or(PresaleError::MathOverflow)?;
        require!(
            new_total_raised <= config.hard_cap_payment,
            PresaleError::HardCapExceeded
        );

        // Balance-delta: correct even if a payment token ever carries a
        // transfer fee (neither USDC nor USDT do today -- both are plain
        // SPL Token -- but this makes no silent assumption either way).
        let balance_before = ctx.accounts.payment_vault.amount;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.buyer_payment_account.to_account_info(),
            mint: ctx.accounts.payment_mint.to_account_info(),
            to: ctx.accounts.payment_vault.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.payment_token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, payment_amount, ctx.accounts.payment_mint.decimals)?;

        ctx.accounts.payment_vault.reload()?;
        let balance_after = ctx.accounts.payment_vault.amount;
        let net_received = balance_after
            .checked_sub(balance_before)
            .ok_or(PresaleError::MathOverflow)?;
        require!(net_received > 0, PresaleError::ZeroAmount);

        // act_net = net_received * 10^ACT_DECIMALS / price_micro_payment_per_act
        let act_net: u64 = (net_received as u128)
            .checked_mul(10u128.pow(ACT_DECIMALS))
            .ok_or(PresaleError::MathOverflow)?
            .checked_div(config.price_micro_payment_per_act as u128)
            .ok_or(PresaleError::MathOverflow)?
            .try_into()
            .map_err(|_| PresaleError::MathOverflow)?;
        require!(act_net > 0, PresaleError::ZeroAmount);

        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.owner = ctx.accounts.buyer.key();
        buyer_account.payment_contributed[idx] = buyer_account.payment_contributed[idx]
            .checked_add(net_received)
            .ok_or(PresaleError::MathOverflow)?;
        buyer_account.act_allocated_net = buyer_account
            .act_allocated_net
            .checked_add(act_net)
            .ok_or(PresaleError::MathOverflow)?;
        buyer_account.bump = ctx.bumps.buyer_account;

        let config = &mut ctx.accounts.config;
        config.total_raised_payment = new_total_raised;
        config.total_act_sold_net = config
            .total_act_sold_net
            .checked_add(act_net)
            .ok_or(PresaleError::MathOverflow)?;

        Ok(())
    }

    /// Public. Buys ACT with native SOL, priced against the live Pyth
    /// SOL/USD feed the caller supplies via `price_update` (see the
    /// module-level "Payment currencies" doc comment). Applies the same
    /// window/pause/min-first-buy/max-cumulative/hard-cap rules as `buy`,
    /// combined across all three currencies via each side's USD-
    /// equivalent value.
    pub fn buy_with_sol(ctx: Context<BuyWithSol>, lamports: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == STATUS_ACTIVE, PresaleError::PresaleNotActive);
        require!(!config.paused, PresaleError::PresalePaused);
        require!(lamports > 0, PresaleError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.start_ts, PresaleError::PresaleNotStarted);
        require!(now < config.end_ts, PresaleError::PresaleEnded);

        let price = ctx
            .accounts
            .price_update
            .get_price_no_older_than(&Clock::get()?, MAX_PRICE_STALENESS_SECONDS, &SOL_USD_FEED_ID)
            .map_err(|_| PresaleError::InvalidOraclePrice)?;
        require!(price.price > 0, PresaleError::InvalidOraclePrice);

        let payment_amount = lamports_to_payment_units(lamports, price.price, price.exponent)?;
        require!(payment_amount > 0, PresaleError::ZeroAmount);

        let buyer_account = &ctx.accounts.buyer_account;
        let total_contributed_before: u64 = buyer_account
            .payment_contributed
            .iter()
            .try_fold(0u64, |acc, &v| acc.checked_add(v))
            .ok_or(PresaleError::MathOverflow)?
            .checked_add(buyer_account.sol_usd_value_contributed)
            .ok_or(PresaleError::MathOverflow)?;
        if total_contributed_before == 0 {
            require!(
                payment_amount >= config.min_buy_payment,
                PresaleError::BelowMinBuy
            );
        }

        let new_total_for_buyer = total_contributed_before
            .checked_add(payment_amount)
            .ok_or(PresaleError::MathOverflow)?;
        require!(
            new_total_for_buyer <= config.max_buy_payment,
            PresaleError::AboveMaxBuy
        );

        let new_total_raised = config
            .total_raised_payment
            .checked_add(payment_amount)
            .ok_or(PresaleError::MathOverflow)?;
        require!(
            new_total_raised <= config.hard_cap_payment,
            PresaleError::HardCapExceeded
        );

        // Balance-delta, same discipline as every other transfer in this
        // program, even though a native System transfer has no analogue
        // to a token's transfer fee -- this just confirms the CPI moved
        // exactly what was requested.
        let balance_before = ctx.accounts.vault_authority.lamports();
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault_authority.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, lamports)?;
        let balance_after = ctx.accounts.vault_authority.lamports();
        let net_received = balance_after
            .checked_sub(balance_before)
            .ok_or(PresaleError::MathOverflow)?;
        require!(net_received == lamports, PresaleError::MathOverflow);

        let act_net: u64 = (payment_amount as u128)
            .checked_mul(10u128.pow(ACT_DECIMALS))
            .ok_or(PresaleError::MathOverflow)?
            .checked_div(config.price_micro_payment_per_act as u128)
            .ok_or(PresaleError::MathOverflow)?
            .try_into()
            .map_err(|_| PresaleError::MathOverflow)?;
        require!(act_net > 0, PresaleError::ZeroAmount);

        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.owner = ctx.accounts.buyer.key();
        buyer_account.sol_lamports_contributed = buyer_account
            .sol_lamports_contributed
            .checked_add(lamports)
            .ok_or(PresaleError::MathOverflow)?;
        buyer_account.sol_usd_value_contributed = buyer_account
            .sol_usd_value_contributed
            .checked_add(payment_amount)
            .ok_or(PresaleError::MathOverflow)?;
        buyer_account.act_allocated_net = buyer_account
            .act_allocated_net
            .checked_add(act_net)
            .ok_or(PresaleError::MathOverflow)?;
        buyer_account.bump = ctx.bumps.buyer_account;

        let config = &mut ctx.accounts.config;
        config.total_raised_payment = new_total_raised;
        config.total_act_sold_net = config
            .total_act_sold_net
            .checked_add(act_net)
            .ok_or(PresaleError::MathOverflow)?;

        Ok(())
    }

    /// Buyer-callable, only once `status == Refunding`. Mirrors `refund`
    /// but for the native-SOL leg: returns exactly the lamports this
    /// wallet paid via `buy_with_sol`, regardless of how SOL/USD has
    /// moved since (the refund is sized off `sol_lamports_contributed`,
    /// never re-priced).
    pub fn refund_sol(ctx: Context<RefundSol>) -> Result<()> {
        require!(
            ctx.accounts.config.status == STATUS_REFUNDING,
            PresaleError::NotRefunding
        );
        require!(!ctx.accounts.buyer_account.sol_refunded, PresaleError::AlreadyRefunded);
        let amount = ctx.accounts.buyer_account.sol_lamports_contributed;
        require!(amount > 0, PresaleError::NothingToRefund);

        let bump = ctx.accounts.config.vault_authority_bump;
        let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault_authority.to_account_info(),
                to: ctx.accounts.buyer.to_account_info(),
            },
            signer_seeds,
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.sol_refunded = true;
        buyer_account.act_allocated_net = 0;

        Ok(())
    }

    /// Authority-gated. Callable once the sale window has ended, or
    /// earlier if the hard cap has already been reached. Soft cap met:
    /// sweeps both escrowed payment-currency vaults to their respective
    /// treasury accounts and starts vesting (`tge_ts = now`). Soft cap
    /// missed: moves to `Refunding` and moves no funds -- each buyer
    /// pulls their own refund via `refund`, once per currency they used.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == STATUS_ACTIVE, PresaleError::PresaleNotActive);

        let now = Clock::get()?.unix_timestamp;
        let hard_cap_reached = config.total_raised_payment >= config.hard_cap_payment;
        require!(
            now >= config.end_ts || hard_cap_reached,
            PresaleError::PresaleStillOpen
        );

        if config.total_raised_payment >= config.soft_cap_payment {
            let bump = config.vault_authority_bump;
            let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
            let signer_seeds: &[&[&[u8]]] = &[seeds];

            let usdc_amount = ctx.accounts.usdc_vault.amount;
            if usdc_amount > 0 {
                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury_usdc_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.payment_token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                transfer_checked(cpi_ctx, usdc_amount, ctx.accounts.usdc_mint.decimals)?;
            }

            let usdt_amount = ctx.accounts.usdt_vault.amount;
            if usdt_amount > 0 {
                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.usdt_vault.to_account_info(),
                    mint: ctx.accounts.usdt_mint.to_account_info(),
                    to: ctx.accounts.treasury_usdt_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.payment_token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                transfer_checked(cpi_ctx, usdt_amount, ctx.accounts.usdt_mint.decimals)?;
            }

            // SOL escrow lives directly on vault_authority's own lamport
            // balance (see the module-level doc comment); sweeping its
            // full balance is safe -- nothing else in this program ever
            // sends it lamports, and a fully-drained system-owned account
            // simply ceases to exist, which is fine here.
            let sol_amount = ctx.accounts.vault_authority.lamports();
            if sol_amount > 0 {
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.vault_authority.to_account_info(),
                        to: ctx.accounts.treasury_sol_account.to_account_info(),
                    },
                    signer_seeds,
                );
                anchor_lang::system_program::transfer(cpi_ctx, sol_amount)?;
            }

            let config = &mut ctx.accounts.config;
            config.status = STATUS_FINALIZED;
            config.tge_ts = now;
        } else {
            let config = &mut ctx.accounts.config;
            config.status = STATUS_REFUNDING;
        }

        Ok(())
    }

    /// Buyer-callable, only once `status == Refunding`. Refunds whatever
    /// this wallet contributed in the *specific* currency identified by
    /// the passed `payment_mint`/`payment_vault` pair -- call it once per
    /// currency actually used. Zeroes the wallet's ACT allocation on the
    /// first call regardless of currency (claim is separately blocked by
    /// `status != Finalized` the moment a presale enters `Refunding`, so
    /// this is defense in depth, not the only thing preventing a double
    /// claim).
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        require!(
            ctx.accounts.config.status == STATUS_REFUNDING,
            PresaleError::NotRefunding
        );

        let idx = payment_currency_index(
            &ctx.accounts.config,
            &ctx.accounts.payment_mint.key(),
            &ctx.accounts.payment_vault.key(),
        )?;

        require!(
            !ctx.accounts.buyer_account.refunded[idx],
            PresaleError::AlreadyRefunded
        );
        let amount = ctx.accounts.buyer_account.payment_contributed[idx];
        require!(amount > 0, PresaleError::NothingToRefund);

        let bump = ctx.accounts.config.vault_authority_bump;
        let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.payment_vault.to_account_info(),
            mint: ctx.accounts.payment_mint.to_account_info(),
            to: ctx.accounts.buyer_payment_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.payment_mint.decimals)?;

        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.refunded[idx] = true;
        buyer_account.act_allocated_net = 0;

        Ok(())
    }

    /// Buyer-callable, only once `status == Finalized` and the TGE has
    /// occurred. Pays out whatever portion of this wallet's *net*
    /// allocation has vested and hasn't yet been claimed. Reads the ACT
    /// mint's live TransferFeeConfig to gross up the actual transfer so
    /// the buyer's wallet balance increases by (at least) the net amount
    /// vested -- see the module-level doc comment.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == STATUS_FINALIZED, PresaleError::NotFinalized);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.tge_ts, PresaleError::BeforeTge);

        let buyer_account = &ctx.accounts.buyer_account;
        let vested_net = vested_amount(
            buyer_account.act_allocated_net,
            config.tge_bps,
            config.vesting_duration_seconds,
            config.tge_ts,
            now,
        )?;
        let claimable_net = vested_net
            .checked_sub(buyer_account.act_claimed_net)
            .ok_or(PresaleError::MathOverflow)?;
        require!(claimable_net > 0, PresaleError::NothingClaimable);

        // Gross up claimable_net against the mint's current transfer-fee
        // epoch so the buyer nets (at least) claimable_net after the
        // vault -> buyer transfer itself gets taxed 3.5% by the mint.
        //
        // `grossed_up_amount`'s estimate can occasionally leave a residual
        // shortfall of a few raw base units against Token-2022's actual
        // fee-rounding direction. Rather than trust the estimate blindly or
        // loosen the >= check below, top up with additional grossed-up
        // transfers -- each sized off the real balance-delta shortfall, not
        // off the first estimate -- until the buyer has actually received
        // at least claimable_net. Bounded so a genuinely broken fee config
        // can't loop forever; in practice this residual is small enough
        // that it closes within one extra iteration.
        let balance_before = ctx.accounts.buyer_act_account.amount;

        let bump = config.vault_authority_bump;
        let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        for _ in 0..4 {
            let net_received_so_far = ctx
                .accounts
                .buyer_act_account
                .amount
                .checked_sub(balance_before)
                .ok_or(PresaleError::MathOverflow)?;
            if net_received_so_far >= claimable_net {
                break;
            }
            let still_needed = claimable_net
                .checked_sub(net_received_so_far)
                .ok_or(PresaleError::MathOverflow)?;
            let gross_amount =
                grossed_up_amount(&ctx.accounts.act_mint.to_account_info(), still_needed)?;

            let cpi_accounts = TransferChecked {
                from: ctx.accounts.act_vault.to_account_info(),
                mint: ctx.accounts.act_mint.to_account_info(),
                to: ctx.accounts.buyer_act_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            transfer_checked(cpi_ctx, gross_amount, ACT_DECIMALS as u8)?;
            ctx.accounts.act_vault.reload()?;
            ctx.accounts.buyer_act_account.reload()?;
        }

        let balance_after = ctx.accounts.buyer_act_account.amount;
        let net_received = balance_after
            .checked_sub(balance_before)
            .ok_or(PresaleError::MathOverflow)?;
        require!(net_received >= claimable_net, PresaleError::GrossUpShortfall);

        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.act_claimed_net = buyer_account
            .act_claimed_net
            .checked_add(claimable_net)
            .ok_or(PresaleError::MathOverflow)?;

        let config = &mut ctx.accounts.config;
        config.total_act_claimed_net = config
            .total_act_claimed_net
            .checked_add(claimable_net)
            .ok_or(PresaleError::MathOverflow)?;

        Ok(())
    }

    /// Authority-gated, callable any time after `Finalized`. If the sale
    /// didn't reach the hard cap, `fund_act_reserve` will have left more
    /// ACT in the vault than buyers are actually owed. This sends
    /// whatever's left over the amount still needed to cover all
    /// remaining vesting claims back to the treasury, rather than
    /// leaving it stranded in the presale vault indefinitely.
    pub fn sweep_unsold_act(ctx: Context<SweepUnsoldAct>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == STATUS_FINALIZED, PresaleError::NotFinalized);

        let remaining_owed_net = config
            .total_act_sold_net
            .checked_sub(config.total_act_claimed_net)
            .ok_or(PresaleError::MathOverflow)?;
        // `grossed_up_amount`'s estimate has a confirmed (real devnet
        // transfer) residual imprecision of a few raw base units against
        // Token-2022's actual fee-rounding direction -- `claim` corrects
        // for it with a top-up retry against its own balance-delta, but
        // this instruction has no such buyer-side delta to retry against.
        // Add a fixed safety margin here instead, so an underestimate can
        // never cause this sweep to strand a future claimant short of
        // funds. GROSS_UP_SAFETY_MARGIN raw units is many orders of
        // magnitude larger than the observed residual (single-digit raw
        // units) while still being economically negligible against any
        // real reserve size.
        const GROSS_UP_SAFETY_MARGIN: u64 = 100_000;
        let needed_gross = if remaining_owed_net == 0 {
            0
        } else {
            grossed_up_amount(&ctx.accounts.act_mint.to_account_info(), remaining_owed_net)?
                .checked_add(GROSS_UP_SAFETY_MARGIN)
                .ok_or(PresaleError::MathOverflow)?
        };

        let vault_balance = ctx.accounts.act_vault.amount;
        let excess = vault_balance.saturating_sub(needed_gross);
        require!(excess > 0, PresaleError::NothingToSweep);

        let bump = config.vault_authority_bump;
        let seeds: &[&[u8]] = &[b"vault_authority", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.act_vault.to_account_info(),
            mint: ctx.accounts.act_mint.to_account_info(),
            to: ctx.accounts.treasury_act_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, excess, ACT_DECIMALS as u8)?;

        Ok(())
    }

    /// Authority-gated circuit breaker. When paused, `buy` is rejected;
    /// `claim` and `refund` are never affected by this flag.
    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Hands `config.authority` to a new key, signed by the current
    /// authority. Present from the start this time -- act-staking shipped
    /// without this and had to add it after the fact (see its
    /// `set_config_authority` doc comment).
    pub fn set_config_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
        require_keys_neq!(
            new_authority,
            Pubkey::default(),
            PresaleError::InvalidNewAuthority
        );
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }
}

/// Finds which of `config.accepted_mints`/`accepted_vaults` the passed
/// mint/vault pair matches. Errors if neither slot matches, or if the
/// mint matches one slot but the vault matches a different one (a
/// mismatched pair, which would otherwise let a caller move funds
/// through the wrong vault for the mint they claim to be using).
fn payment_currency_index(
    config: &PresaleConfig,
    mint: &Pubkey,
    vault: &Pubkey,
) -> Result<usize> {
    for i in 0..NUM_PAYMENT_CURRENCIES {
        if config.accepted_mints[i] == *mint {
            require!(
                config.accepted_vaults[i] == *vault,
                PresaleError::MismatchedPaymentVault
            );
            return Ok(i);
        }
    }
    err!(PresaleError::UnsupportedPaymentMint)
}

/// TGE unlocks `tge_bps` of `allocated_net` immediately; the remainder
/// vests linearly from `tge_ts` over `vesting_duration_seconds`. Returns
/// the *cumulative* amount vested as of `now`, not a per-period delta.
fn vested_amount(
    allocated_net: u64,
    tge_bps: u16,
    vesting_duration_seconds: i64,
    tge_ts: i64,
    now: i64,
) -> Result<u64> {
    if now < tge_ts {
        return Ok(0);
    }

    let tge_amount: u64 = (allocated_net as u128)
        .checked_mul(tge_bps as u128)
        .ok_or(PresaleError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(PresaleError::MathOverflow)?
        .try_into()
        .map_err(|_| PresaleError::MathOverflow)?;

    let elapsed = now.saturating_sub(tge_ts);
    if elapsed >= vesting_duration_seconds {
        return Ok(allocated_net);
    }

    let remaining = allocated_net
        .checked_sub(tge_amount)
        .ok_or(PresaleError::MathOverflow)?;
    let linear_vested: u64 = (remaining as u128)
        .checked_mul(elapsed as u128)
        .ok_or(PresaleError::MathOverflow)?
        .checked_div(vesting_duration_seconds as u128)
        .ok_or(PresaleError::MathOverflow)?
        .try_into()
        .map_err(|_| PresaleError::MathOverflow)?;

    tge_amount
        .checked_add(linear_vested)
        .ok_or(PresaleError::MathOverflow.into())
}

/// Reads the ACT mint's live TransferFeeConfig extension and returns the
/// gross amount that must be sent so a transfer nets (at least)
/// `net_amount` after the current epoch's fee is withheld. This is
/// intentionally read live rather than hardcoding 3.5%/9965bps: correct
/// even if governance ever recalibrates the fee (see MINT_V2.md), with
/// no program redeploy required, the same principle behind act-staking's
/// balance-delta approach applied to the "how much do I send" direction
/// instead.
fn grossed_up_amount(mint_account_info: &AccountInfo, net_amount: u64) -> Result<u64> {
    let mint_data = mint_account_info.try_borrow_data()?;
    let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
        .map_err(|_| PresaleError::InvalidMint)?;
    let fee_config = mint_state
        .get_extension::<TransferFeeConfig>()
        .map_err(|_| PresaleError::MissingTransferFeeConfig)?;

    let epoch = Clock::get()?.epoch;
    // `TransferFee::calculate_pre_fee_amount` is the actual inverse of the
    // fee function: given a target net amount, it returns the gross
    // (pre-fee) amount that nets exactly that after the current epoch's
    // fee is withheld.
    let gross = fee_config
        .get_epoch_fee(epoch)
        .calculate_pre_fee_amount(net_amount)
        .ok_or(PresaleError::MathOverflow)?;
    Ok(gross)
}

/// Converts a lamport amount to the same USD-equivalent 6-decimal unit
/// USDC/USDT payments already use, given a Pyth `Price` (`price *
/// 10^exponent` is the real USD price of 1 SOL). Read generically off
/// whatever `exponent` the live feed reports rather than assuming the
/// commonly-seen -8, mirroring this program's own policy elsewhere of
/// reading live state instead of hardcoding an assumption about it.
fn lamports_to_payment_units(lamports: u64, price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, PresaleError::InvalidOraclePrice);
    let price_u128 = price as u128;
    let lamports_u128 = lamports as u128;
    // usd_6dp = lamports * price * 10^expo * 10^6 / 10^9
    //         = lamports * price * 10^(expo - 3)
    let total_expo = expo - 3;
    let value: u128 = if total_expo >= 0 {
        lamports_u128
            .checked_mul(price_u128)
            .ok_or(PresaleError::MathOverflow)?
            .checked_mul(
                10u128
                    .checked_pow(total_expo as u32)
                    .ok_or(PresaleError::MathOverflow)?,
            )
            .ok_or(PresaleError::MathOverflow)?
    } else {
        lamports_u128
            .checked_mul(price_u128)
            .ok_or(PresaleError::MathOverflow)?
            .checked_div(
                10u128
                    .checked_pow((-total_expo) as u32)
                    .ok_or(PresaleError::MathOverflow)?,
            )
            .ok_or(PresaleError::MathOverflow)?
    };
    u64::try_from(value).map_err(|_| PresaleError::MathOverflow.into())
}

#[account]
#[derive(InitSpace)]
pub struct PresaleConfig {
    pub authority: Pubkey,
    pub act_mint: Pubkey,
    /// [USDC mint, USDT mint].
    pub accepted_mints: [Pubkey; NUM_PAYMENT_CURRENCIES],
    /// [USDC vault, USDT vault], index-matched to `accepted_mints`.
    pub accepted_vaults: [Pubkey; NUM_PAYMENT_CURRENCIES],
    /// [treasury USDC account, treasury USDT account], index-matched.
    pub treasury_payment_accounts: [Pubkey; NUM_PAYMENT_CURRENCIES],
    pub act_vault: Pubkey,
    pub treasury_act_account: Pubkey,
    /// Destination for swept SOL contributions on a successful `finalize`.
    pub treasury_sol_account: Pubkey,
    /// Price in the payment token's smallest unit, per whole ACT (1e9 raw
    /// units). E.g. USDC/USDT (6 decimals) at $0.01/ACT = 10_000.
    pub price_micro_payment_per_act: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    /// Set by `finalize`; 0 until then.
    pub tge_ts: i64,
    pub tge_bps: u16,
    pub vesting_duration_seconds: i64,
    /// All payment-related caps/totals are combined across both accepted
    /// currencies, in the smallest unit of either (they share the same
    /// 6 decimals, so this is a simple sum, not a weighted one).
    pub hard_cap_payment: u64,
    pub soft_cap_payment: u64,
    pub min_buy_payment: u64,
    pub max_buy_payment: u64,
    pub total_raised_payment: u64,
    /// Sum of every buyer's net ACT entitlement (pre-vesting, pre-fee).
    pub total_act_sold_net: u64,
    /// Sum of net ACT actually paid out across all claims so far.
    pub total_act_claimed_net: u64,
    /// Sum of net ACT actually received into act_vault via
    /// `fund_act_reserve` (i.e. already net of that transfer's own fee).
    pub act_reserve_net: u64,
    pub status: u8,
    pub paused: bool,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BuyerAccount {
    pub owner: Pubkey,
    /// Index-matched to `PresaleConfig.accepted_mints`: [USDC, USDT].
    pub payment_contributed: [u64; NUM_PAYMENT_CURRENCIES],
    pub act_allocated_net: u64,
    pub act_claimed_net: u64,
    /// Index-matched to `PresaleConfig.accepted_mints`.
    pub refunded: [bool; NUM_PAYMENT_CURRENCIES],
    /// Exact lamports paid via `buy_with_sol`, summed across every call --
    /// used for `refund_sol` so a refund returns precisely what was paid
    /// regardless of how SOL/USD has moved since.
    pub sol_lamports_contributed: u64,
    /// USD-equivalent value of `sol_lamports_contributed`, computed from
    /// the live oracle price *at the time of each contribution* and
    /// summed -- this, not the lamports figure, is what counts toward the
    /// combined min-buy/max-buy/hard-cap accounting shared with USDC/USDT.
    pub sol_usd_value_contributed: u64,
    pub sol_refunded: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializePresale<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PresaleConfig::INIT_SPACE,
        seeds = [b"presale_config"],
        bump
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    /// CHECK: PDA used only as the vaults' token authority; holds no data
    /// of its own, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub act_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = act_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub act_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: destination for unsold ACT via `sweep_unsold_act`; not
    /// touched by this instruction.
    pub treasury_act_account: UncheckedAccount<'info>,

    /// CHECK: destination for swept SOL contributions on a successful
    /// `finalize`; not touched by this instruction.
    pub treasury_sol_account: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// See `initialize_payment_currency`'s doc comment for why this is its
/// own instruction rather than folded into `InitializePresale`.
#[derive(Accounts)]
pub struct InitializePaymentCurrency<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    /// CHECK: PDA used only as the vault's token authority; holds no data
    /// of its own, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = payment_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: destination for this currency's swept proceeds on a
    /// successful finalize; not touched by this instruction.
    pub treasury_payment_account: UncheckedAccount<'info>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundActReserve<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = authority,
        has_one = act_mint,
        has_one = act_vault
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    pub act_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub act_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = act_mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program
    )]
    pub authority_act_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerAccount::INIT_SPACE,
        seeds = [b"presale_buyer", buyer.key().as_ref()],
        bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,

    /// Must be one of `config.accepted_mints`; checked at runtime in
    /// `payment_currency_index` rather than via `has_one`, since either
    /// of two mints is valid here.
    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payment_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = payment_mint,
        associated_token::authority = buyer,
        associated_token::token_program = payment_token_program
    )]
    pub buyer_payment_account: InterfaceAccount<'info, TokenAccount>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyWithSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerAccount::INIT_SPACE,
        seeds = [b"presale_buyer", buyer.key().as_ref()],
        bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,

    /// CHECK: escrows native SOL contributions directly as this PDA's own
    /// lamport balance -- the same authority PDA the token vaults use,
    /// verified by seeds; holds no data of its own.
    #[account(mut, seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// Pyth price update for SOL/USD, posted by the caller (or their
    /// frontend) immediately before this instruction. Anchor's
    /// `Account<'info, PriceUpdateV2>` already checks the discriminator
    /// and that it's owned by the real Pyth receiver program; this
    /// instruction additionally validates the feed ID and staleness.
    pub price_update: Account<'info, PriceUpdateV2>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [b"presale_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    #[account(
        mut,
        seeds = [b"presale_buyer", buyer.key().as_ref()],
        bump = buyer_account.bump,
        has_one = owner @ PresaleError::InvalidBuyerAccount
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: only used for the has_one check above via `owner`; the real
    /// authority check is `buyer` being the transaction signer.
    #[account(constraint = owner.key() == buyer.key() @ PresaleError::InvalidBuyerAccount)]
    pub owner: UncheckedAccount<'info>,

    /// CHECK: PDA holding the escrowed SOL, verified by seeds.
    #[account(mut, seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    /// CHECK: PDA signer for the payment vaults -> treasury transfers, and
    /// for the SOL escrow -> treasury sweep; verified by seeds.
    #[account(mut, seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: destination for swept SOL contributions on a successful
    /// finalize; verified directly against `config.treasury_sol_account`.
    #[account(
        mut,
        address = config.treasury_sol_account @ PresaleError::MismatchedPaymentVault
    )]
    pub treasury_sol_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    // Boxed throughout, same reason as InitializePresale: too many typed
    // accounts for one unboxed try_accounts stack frame under the SBF
    // VM's 4096-byte limit.
    #[account(address = config.accepted_mints[0] @ PresaleError::UnsupportedPaymentMint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.accepted_mints[1] @ PresaleError::UnsupportedPaymentMint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        address = config.accepted_vaults[0] @ PresaleError::MismatchedPaymentVault
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = config.accepted_vaults[1] @ PresaleError::MismatchedPaymentVault
    )]
    pub usdt_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        address = config.treasury_payment_accounts[0] @ PresaleError::MismatchedPaymentVault
    )]
    pub treasury_usdc_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = config.treasury_payment_accounts[1] @ PresaleError::MismatchedPaymentVault
    )]
    pub treasury_usdt_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [b"presale_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    #[account(
        mut,
        seeds = [b"presale_buyer", buyer.key().as_ref()],
        bump = buyer_account.bump,
        has_one = owner @ PresaleError::InvalidBuyerAccount
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: only used for the has_one check above via `owner`; the real
    /// authority check is `buyer` being the transaction signer.
    #[account(constraint = owner.key() == buyer.key() @ PresaleError::InvalidBuyerAccount)]
    pub owner: UncheckedAccount<'info>,

    /// CHECK: PDA signer for the payment_vault -> buyer transfer, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payment_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = payment_mint,
        associated_token::authority = buyer,
        associated_token::token_program = payment_token_program
    )]
    pub buyer_payment_account: InterfaceAccount<'info, TokenAccount>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = act_mint,
        has_one = act_vault
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    #[account(
        mut,
        seeds = [b"presale_buyer", buyer.key().as_ref()],
        bump = buyer_account.bump,
        has_one = owner @ PresaleError::InvalidBuyerAccount
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: only used for the has_one check above via `owner`; the real
    /// authority check is `buyer` being the transaction signer.
    #[account(constraint = owner.key() == buyer.key() @ PresaleError::InvalidBuyerAccount)]
    pub owner: UncheckedAccount<'info>,

    /// CHECK: PDA signer for the act_vault -> buyer transfer, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub act_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub act_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = act_mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program
    )]
    pub buyer_act_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SweepUnsoldAct<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = authority,
        has_one = act_mint,
        has_one = act_vault,
        has_one = treasury_act_account
    )]
    pub config: Box<Account<'info, PresaleConfig>>,

    /// CHECK: PDA signer for the act_vault -> treasury transfer, verified by seeds.
    #[account(seeds = [b"vault_authority"], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub act_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub act_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_act_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"presale_config"],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Box<Account<'info, PresaleConfig>>,
    pub authority: Signer<'info>,
}

#[error_code]
pub enum PresaleError {
    #[msg("start_ts must be before end_ts.")]
    InvalidWindow,
    #[msg("Soft cap must be greater than zero and no more than the hard cap.")]
    InvalidCaps,
    #[msg("min_buy_payment must be greater than zero and no more than max_buy_payment.")]
    InvalidBuyLimits,
    #[msg("tge_bps must be 10000 or less, and vesting_duration_days must be greater than zero.")]
    InvalidVestingConfig,
    #[msg("price_micro_payment_per_act must be greater than zero.")]
    InvalidPrice,
    #[msg("USDC and USDT mints must be different accounts.")]
    DuplicatePaymentMint,
    #[msg("index must be 0 or 1.")]
    InvalidCurrencyIndex,
    #[msg("This currency slot has already been initialized.")]
    CurrencySlotAlreadySet,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("The presale is not currently active.")]
    PresaleNotActive,
    #[msg("The presale is paused.")]
    PresalePaused,
    #[msg("The presale has not started yet.")]
    PresaleNotStarted,
    #[msg("The presale has already ended.")]
    PresaleEnded,
    #[msg("This purchase is below the minimum first-time contribution.")]
    BelowMinBuy,
    #[msg("This purchase would exceed the maximum per-wallet contribution.")]
    AboveMaxBuy,
    #[msg("This purchase would exceed the presale hard cap.")]
    HardCapExceeded,
    #[msg("The presale window is still open and the hard cap has not been reached.")]
    PresaleStillOpen,
    #[msg("The presale is not in a refunding state.")]
    NotRefunding,
    #[msg("This wallet has already been refunded for this currency.")]
    AlreadyRefunded,
    #[msg("There is nothing to refund for this wallet in this currency.")]
    NothingToRefund,
    #[msg("The presale has not been finalized.")]
    NotFinalized,
    #[msg("The token generation event has not occurred yet.")]
    BeforeTge,
    #[msg("Nothing is currently claimable for this wallet.")]
    NothingClaimable,
    #[msg("There is no unsold ACT to sweep.")]
    NothingToSweep,
    #[msg("This buyer account does not belong to the signer.")]
    InvalidBuyerAccount,
    #[msg("Could not read the ACT mint's account data.")]
    InvalidMint,
    #[msg("The ACT mint has no TransferFeeConfig extension.")]
    MissingTransferFeeConfig,
    #[msg("The grossed-up transfer amount still fell short of the net entitlement.")]
    GrossUpShortfall,
    #[msg("This mint is not an accepted presale payment currency.")]
    UnsupportedPaymentMint,
    #[msg("This vault does not match the configured vault for this payment mint.")]
    MismatchedPaymentVault,
    #[msg("The SOL/USD oracle price is invalid, stale, or for the wrong feed.")]
    InvalidOraclePrice,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("New authority cannot be the default (all-zero) pubkey.")]
    InvalidNewAuthority,
}
