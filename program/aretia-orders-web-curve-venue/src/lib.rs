//! Aretia Orders venue adapter for the web wallet's bonding curve (`aretia-curve`, Aretia-Finance `program/aretia-curve`).
//!
//! The order program lends an order's signature to a whitelisted venue during a fill. This venue fills a SOL-quoted
//! order against the curve. The curve trades in native SOL, and an order holds wrapped SOL, so the adapter moves the
//! funds through a wallet it controls (the PDA ["adapter"]) and converts at each end:
//!
//!  - buy:  order's WSOL -> temporary WSOL account -> closed into the wallet as SOL -> `curve.buy` -> launch tokens to the
//!    order's launch vault;
//!  - sell: order's launch tokens -> `curve.sell` -> SOL arrives in the wallet -> sent into the order's WSOL account and
//!    synced.
//!
//! The wallet is always left empty. Whatever it holds before a call is swept to the keeper, and a call fails unless the
//! curve took exactly what it was given. The order program re-checks everything on its side.
//!
//! The curve is called by hand-built instructions (its source lives in another repository). The two discriminators and the
//! account order are pinned by the tests, which run the curve's real compiled binary.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, SyncNative};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("5Vq3f4oT2g7sP3k3dQp8b6m1cXyCwK9Gx7B2Dn4Nn1Fh");

pub const ADAPTER_SEED: &[u8] = b"adapter";

/// The web wallet's bonding-curve program (mainnet id; the binary is built for it).
pub const CURVE_PROGRAM: Pubkey = pubkey!("CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu");
/// Aretia's fee wallet, which the curve pays its trading fee to and refuses any other.
pub const CURVE_FEE_WALLET: Pubkey = pubkey!("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
/// `sha256("global:buy")[..8]` and `sha256("global:sell")[..8]`: the curve's Anchor instruction discriminators.
pub const CURVE_BUY: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const CURVE_SELL: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

#[program]
pub mod aretia_orders_web_curve_venue {
    use super::*;

    /// Buys with `spend` lamports for the order, receiving at least `min_tokens_out`.
    pub fn buy(ctx: Context<Buy>, spend: u64, min_tokens_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(spend > 0, VenueError::ZeroAmount);
        let bump = ctx.bumps.wallet;
        let seeds: &[&[u8]] = &[ADAPTER_SEED, &[bump]];
        sweep(&a.system_program, &a.wallet, &a.sweep, seeds)?;

        // Order's wrapped SOL -> temporary wrapped-SOL account owned by the wallet.
        token_interface::transfer_checked(
            CpiContext::new(
                a.quote_token_program.key(),
                TransferChecked {
                    from: a.quote_vault.to_account_info(),
                    mint: a.native_mint.to_account_info(),
                    to: a.wallet_wsol.to_account_info(),
                    authority: a.order.to_account_info(),
                },
            ),
            spend,
            a.native_mint.decimals,
        )?;
        // Close it into the wallet: the wrapped SOL (and the account's rent) becomes lamports.
        token_interface::close_account(CpiContext::new_with_signer(
            a.quote_token_program.key(),
            CloseAccount {
                account: a.wallet_wsol.to_account_info(),
                destination: a.wallet.to_account_info(),
                authority: a.wallet.to_account_info(),
            },
            &[seeds],
        ))?;
        let before = a.wallet.lamports();
        let tokens_before = a.wallet_launch.amount;

        call_curve(a, CURVE_BUY, spend, min_tokens_out, seeds)?;

        // The curve must have taken exactly what it was given (it takes less only when the buy sells the curve out).
        // Anything left is the temporary account's rent, which goes back to the keeper who paid it.
        require!(
            a.wallet.lamports() == before - spend,
            VenueError::CurveTookLess
        );
        let mut wallet_launch = a.wallet_launch.clone();
        wallet_launch.reload()?;
        let received = wallet_launch
            .amount
            .checked_sub(tokens_before)
            .ok_or(error!(VenueError::MathOverflow))?;
        require!(received > 0, VenueError::NothingReceived);
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.launch_token_program.key(),
                TransferChecked {
                    from: a.wallet_launch.to_account_info(),
                    mint: a.launch_mint.to_account_info(),
                    to: a.launch_vault.to_account_info(),
                    authority: a.wallet.to_account_info(),
                },
                &[seeds],
            ),
            received,
            a.launch_mint.decimals,
        )?;
        sweep(&a.system_program, &a.wallet, &a.sweep, seeds)
    }

    /// Sells `tokens_in` launch tokens for the order, receiving at least `min_lamports_out` (after the curve's fee).
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_lamports_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(tokens_in > 0, VenueError::ZeroAmount);
        let bump = ctx.bumps.wallet;
        let seeds: &[&[u8]] = &[ADAPTER_SEED, &[bump]];
        sweep(&a.system_program, &a.wallet, &a.sweep, seeds)?;
        let tokens_before = a.wallet_launch.amount;

        token_interface::transfer_checked(
            CpiContext::new(
                a.launch_token_program.key(),
                TransferChecked {
                    from: a.launch_vault.to_account_info(),
                    mint: a.launch_mint.to_account_info(),
                    to: a.wallet_launch.to_account_info(),
                    authority: a.order.to_account_info(),
                },
            ),
            tokens_in,
            a.launch_mint.decimals,
        )?;
        call_curve_sell(a, tokens_in, min_lamports_out, seeds)?;
        let mut wallet_launch = a.wallet_launch.clone();
        wallet_launch.reload()?;
        require!(
            wallet_launch.amount == tokens_before,
            VenueError::CurveTookLess
        );

        // SOL in the wallet -> the order's wrapped-SOL account, then sync so its token balance shows it.
        let proceeds = a.wallet.lamports();
        require!(proceeds > 0, VenueError::NothingReceived);
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.key(),
                system_program::Transfer {
                    from: a.wallet.to_account_info(),
                    to: a.quote_vault.to_account_info(),
                },
                &[seeds],
            ),
            proceeds,
        )?;
        token::sync_native(CpiContext::new(
            a.quote_token_program.key(),
            SyncNative {
                account: a.quote_vault.to_account_info(),
            },
        ))
    }
}

/// `curve.buy(gross_in, min_tokens_out)` with the wallet as the buyer. Account order is the curve's `Buy` struct.
fn call_curve<'info>(
    a: &Buy<'info>,
    discriminator: [u8; 8],
    amount: u64,
    min_out: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let mut data = discriminator.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let metas = vec![
        AccountMeta::new(a.wallet.key(), true),
        AccountMeta::new(a.curve.key(), false),
        AccountMeta::new(a.sol_vault.key(), false),
        AccountMeta::new_readonly(a.launch_mint.key(), false),
        AccountMeta::new(a.curve_vault.key(), false),
        AccountMeta::new(a.wallet_launch.key(), false),
        AccountMeta::new(a.fee_wallet.key(), false),
        AccountMeta::new_readonly(a.launch_token_program.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
    ];
    let infos = [
        a.wallet.to_account_info(),
        a.curve.to_account_info(),
        a.sol_vault.to_account_info(),
        a.launch_mint.to_account_info(),
        a.curve_vault.to_account_info(),
        a.wallet_launch.to_account_info(),
        a.fee_wallet.to_account_info(),
        a.launch_token_program.to_account_info(),
        a.system_program.to_account_info(),
        a.curve_program.to_account_info(),
    ];
    invoke_signed(
        &Instruction {
            program_id: CURVE_PROGRAM,
            accounts: metas,
            data,
        },
        &infos,
        &[seeds],
    )?;
    Ok(())
}

/// `curve.sell(tokens_in, min_lamports_out)` with the wallet as the seller.
fn call_curve_sell<'info>(
    a: &Sell<'info>,
    tokens_in: u64,
    min_out: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let mut data = CURVE_SELL.to_vec();
    data.extend_from_slice(&tokens_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let metas = vec![
        AccountMeta::new(a.wallet.key(), true),
        AccountMeta::new(a.curve.key(), false),
        AccountMeta::new(a.sol_vault.key(), false),
        AccountMeta::new_readonly(a.launch_mint.key(), false),
        AccountMeta::new(a.curve_vault.key(), false),
        AccountMeta::new(a.wallet_launch.key(), false),
        AccountMeta::new(a.fee_wallet.key(), false),
        AccountMeta::new_readonly(a.launch_token_program.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
    ];
    let infos = [
        a.wallet.to_account_info(),
        a.curve.to_account_info(),
        a.sol_vault.to_account_info(),
        a.launch_mint.to_account_info(),
        a.curve_vault.to_account_info(),
        a.wallet_launch.to_account_info(),
        a.fee_wallet.to_account_info(),
        a.launch_token_program.to_account_info(),
        a.system_program.to_account_info(),
        a.curve_program.to_account_info(),
    ];
    invoke_signed(
        &Instruction {
            program_id: CURVE_PROGRAM,
            accounts: metas,
            data,
        },
        &infos,
        &[seeds],
    )?;
    Ok(())
}

/// Sends everything the wallet holds to `to`. The wallet must end every call empty: a system account holding a few
/// lamports (say, from someone sending dust) would otherwise be below the rent minimum and fail the next transfer.
fn sweep<'info>(
    system: &Program<'info, System>,
    wallet: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let amount = wallet.lamports();
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Transfer {
                from: wallet.to_account_info(),
                to: to.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct Buy<'info> {
    /// The order. The order program signs for it while it lends its signature.
    pub order: Signer<'info>,
    #[account(mut, token::mint = native_mint, token::authority = order, token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = launch_mint, token::authority = order, token::token_program = launch_token_program)]
    pub launch_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The adapter's own system-account wallet; it never holds data.
    #[account(mut, seeds = [ADAPTER_SEED], bump)]
    pub wallet: SystemAccount<'info>,
    #[account(mut, associated_token::mint = native_mint, associated_token::authority = wallet, associated_token::token_program = quote_token_program)]
    pub wallet_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = wallet, associated_token::token_program = launch_token_program)]
    pub wallet_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives any lamports the wallet holds; the keeper.
    #[account(mut)]
    pub sweep: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub native_mint: Box<InterfaceAccount<'info, Mint>>,
    pub launch_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked by the curve program (its address is derived from the mint).
    #[account(mut)]
    pub curve: UncheckedAccount<'info>,
    /// CHECK: the curve's SOL vault, checked by the curve program.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: pinned to Aretia's fee wallet, as the curve itself does.
    #[account(mut, address = CURVE_FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// CHECK: pinned to the curve program this adapter was built for.
    #[account(address = CURVE_PROGRAM)]
    pub curve_program: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub launch_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    pub order: Signer<'info>,
    #[account(mut, token::mint = native_mint, token::authority = order, token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = launch_mint, token::authority = order, token::token_program = launch_token_program)]
    pub launch_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The adapter's own system-account wallet; it never holds data.
    #[account(mut, seeds = [ADAPTER_SEED], bump)]
    pub wallet: SystemAccount<'info>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = wallet, associated_token::token_program = launch_token_program)]
    pub wallet_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives any lamports the wallet holds; the keeper.
    #[account(mut)]
    pub sweep: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub native_mint: Box<InterfaceAccount<'info, Mint>>,
    pub launch_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked by the curve program (its address is derived from the mint).
    #[account(mut)]
    pub curve: UncheckedAccount<'info>,
    /// CHECK: the curve's SOL vault, checked by the curve program.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: pinned to Aretia's fee wallet, as the curve itself does.
    #[account(mut, address = CURVE_FEE_WALLET)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// CHECK: pinned to the curve program this adapter was built for.
    #[account(address = CURVE_PROGRAM)]
    pub curve_program: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub launch_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum VenueError {
    #[msg("The amount must be above zero")]
    ZeroAmount,
    #[msg("The curve did not take the whole amount it was given")]
    CurveTookLess,
    #[msg("Nothing was received")]
    NothingReceived,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
