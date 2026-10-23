//! Aretia Orders (Solana), version 1: self-custody limit buy and limit sell for Aretia Launch tokens.
//!
//! A user escrows the asset they will pay with in a vault owned by their order. Anyone (a "keeper") may then fill the
//! order by routing a swap through a whitelisted venue program. The program, not the keeper, decides whether the fill is
//! acceptable: it measures what actually arrived and refuses unless the owner receives at least the limit rate.
//! Specification: docs/aretia-launch/adr/0007-order-program.md.
//!
//! What the program enforces on chain, so no keeper or client can skip it:
//!  - a fill delivers at least `ceil(slice * min_out_remaining / in_remaining)` to the owner, after Aretia's fee. Buy and
//!    sell are the same check, so no price oracle is needed and none exists;
//!  - the vault spends exactly the slice the fill declared, no more, and keeps its owner, with no delegate;
//!  - only venue programs on the admin whitelist can be called, and the token programs can never be on it;
//!  - the keeper's reward is a share of the price improvement above the limit and nothing else;
//!  - only the owner can cancel, and a cancel always works (pauses never block it);
//!  - fees are copied into the order when it is created and cannot change afterwards; each has a hard cap.
//!
//! Not enforced here: that a pool exists for the pair (the app lists only pairs with a pool), and the USD minimum is a
//! per-asset minimum amount that the admin keeps current.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::{AccountState, Mint as Mint2022State};
use anchor_spl::token_2022::ID as TOKEN_2022_PROGRAM_ID;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub mod math;
use math::{fee_ceil, required_out, share_floor, slice_allowed};

// Development placeholder. The real program id is the address the release keypair deploys to; replace it (and rebuild)
// at deployment. Nothing is deployed under this id.
declare_id!("Fnb5FELt2BGQLzXdKc1pFTJThdYuZQwaamLVpc8pGPKH");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ASSET_SEED: &[u8] = b"asset";
pub const ORDER_SEED: &[u8] = b"order";

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

pub const STATUS_OPEN: u8 = 1;
/// Written before the venue is called, so a venue that calls back into this program finds the order busy.
pub const STATUS_FILLING: u8 = 2;

pub const MAX_VENUES: usize = 8;

/// Hard caps. Even the admin cannot set a fee above these.
pub const MAX_CANCEL_FEE_BPS: u16 = 100;
pub const MAX_BUY_FEE_BPS: u16 = 300;
pub const MAX_SELL_FEE_BPS: u16 = 300;
pub const MAX_KEEPER_SHARE_BPS: u16 = 5_000;

/// `sha256("account:Curve")[..8]`: the Anchor discriminator of the bonding-curve program's `Curve` account. A test pins it.
pub const CURVE_DISCRIMINATOR: [u8; 8] = [191, 180, 249, 66, 180, 71, 51, 182];

#[program]
pub mod aretia_orders {
    use super::*;

    /// One-time setup. Only the program's upgrade authority can call it, so nobody can front-run deployment.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        admin: Pubkey,
        fee_recipient: Pubkey,
        curve_program: Pubkey,
        curve_mint_offset: u16,
        cancel_fee_bps: u16,
        buy_fee_bps: u16,
        sell_fee_bps: u16,
        keeper_share_bps: u16,
    ) -> Result<()> {
        check_fees(cancel_fee_bps, buy_fee_bps, sell_fee_bps, keeper_share_bps)?;
        require!(
            (curve_mint_offset as usize) >= 8,
            OrdersError::BadCurveLayout
        );
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.fee_recipient = fee_recipient;
        c.curve_program = curve_program;
        c.curve_mint_offset = curve_mint_offset;
        c.cancel_fee_bps = cancel_fee_bps;
        c.buy_fee_bps = buy_fee_bps;
        c.sell_fee_bps = sell_fee_bps;
        c.keeper_share_bps = keeper_share_bps;
        c.paused = false;
        c.venue_count = 0;
        c.venues = [Pubkey::default(); MAX_VENUES];
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Changes what NEW orders are created with. Open orders keep the fees they were created with.
    pub fn update_config(
        ctx: Context<AdminConfig>,
        fee_recipient: Pubkey,
        cancel_fee_bps: u16,
        buy_fee_bps: u16,
        sell_fee_bps: u16,
        keeper_share_bps: u16,
        paused: bool,
    ) -> Result<()> {
        check_fees(cancel_fee_bps, buy_fee_bps, sell_fee_bps, keeper_share_bps)?;
        let c = &mut ctx.accounts.config;
        c.fee_recipient = fee_recipient;
        c.cancel_fee_bps = cancel_fee_bps;
        c.buy_fee_bps = buy_fee_bps;
        c.sell_fee_bps = sell_fee_bps;
        c.keeper_share_bps = keeper_share_bps;
        c.paused = paused;
        Ok(())
    }

    /// Replaces the venue whitelist. A venue receives the order's signature during a fill, so this is the most
    /// sensitive setting in the program: the admin is a multisig, and the token programs are refused outright.
    pub fn set_venues(ctx: Context<AdminConfig>, venues: Vec<Pubkey>) -> Result<()> {
        require!(venues.len() <= MAX_VENUES, OrdersError::TooManyVenues);
        for v in &venues {
            require!(!is_forbidden_venue(v), OrdersError::ForbiddenVenue);
        }
        let c = &mut ctx.accounts.config;
        c.venues = [Pubkey::default(); MAX_VENUES];
        for (i, v) in venues.iter().enumerate() {
            c.venues[i] = *v;
        }
        c.venue_count = venues.len() as u8;
        Ok(())
    }

    /// Lists a payment asset and its minimum order amount (the USD 50 floor, expressed in the asset's base units).
    pub fn set_asset(ctx: Context<SetAsset>, min_amount: u64, enabled: bool) -> Result<()> {
        let a = &mut ctx.accounts.asset;
        a.mint = ctx.accounts.mint.key();
        a.min_amount = min_amount;
        a.enabled = enabled;
        a.bump = ctx.bumps.asset;
        Ok(())
    }

    /// Escrows `amount_in` and opens an order. Buy: pay `amount_in` of the payment asset for at least `min_out` of the
    /// launch token. Sell: sell `amount_in` of the launch token for at least `min_out` of the payment asset.
    /// The limit is what the owner ends up holding, after Aretia's fee.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        side: u8,
        nonce: u64,
        amount_in: u64,
        min_out: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrdersError::Paused);
        require!(side == SIDE_BUY || side == SIDE_SELL, OrdersError::BadSide);
        require!(amount_in > 0 && min_out > 0, OrdersError::ZeroAmount);
        let asset = &ctx.accounts.asset;
        require!(asset.enabled, OrdersError::AssetNotEnabled);
        let floor_value = if side == SIDE_BUY { amount_in } else { min_out };
        require!(floor_value >= asset.min_amount, OrdersError::BelowMinimum);

        require_launch_token(
            &ctx.accounts.curve,
            &config.curve_program,
            config.curve_mint_offset as usize,
            &ctx.accounts.launch_mint.key(),
        )?;
        require!(
            ctx.accounts.launch_mint.mint_authority.is_none()
                && ctx.accounts.launch_mint.freeze_authority.is_none(),
            OrdersError::LaunchTokenNotFixed
        );
        require_no_dangerous_extensions(&ctx.accounts.launch_mint.to_account_info())?;
        require_no_dangerous_extensions(&ctx.accounts.quote_mint.to_account_info())?;

        let o = &mut ctx.accounts.order;
        o.owner = ctx.accounts.owner.key();
        o.launch_mint = ctx.accounts.launch_mint.key();
        o.quote_mint = ctx.accounts.quote_mint.key();
        o.launch_token_program = ctx.accounts.launch_token_program.key();
        o.quote_token_program = ctx.accounts.quote_token_program.key();
        o.side = side;
        o.nonce = nonce;
        o.in_total = amount_in;
        o.in_remaining = amount_in;
        o.min_out_remaining = min_out;
        o.fee_base_cum = 0;
        o.fee_paid = 0;
        o.cancel_fee_bps = config.cancel_fee_bps;
        o.buy_fee_bps = config.buy_fee_bps;
        o.sell_fee_bps = config.sell_fee_bps;
        o.keeper_share_bps = config.keeper_share_bps;
        o.status = STATUS_OPEN;
        o.bump = ctx.bumps.order;
        o.created_slot = Clock::get()?.slot;

        if side == SIDE_BUY {
            transfer(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.owner_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_vault,
                &ctx.accounts.owner.to_account_info(),
                amount_in,
                &[],
            )?;
        } else {
            transfer(
                &ctx.accounts.launch_token_program,
                &ctx.accounts.owner_launch,
                &ctx.accounts.launch_mint,
                &ctx.accounts.launch_vault,
                &ctx.accounts.owner.to_account_info(),
                amount_in,
                &[],
            )?;
        }
        emit!(OrderCreated {
            order: o.key(),
            owner: o.owner,
            launch_mint: o.launch_mint,
            quote_mint: o.quote_mint,
            side,
            nonce,
            amount_in,
            min_out,
        });
        Ok(())
    }

    /// Fills `slice` of the order's remaining input through a whitelisted venue. Callable by anyone. `venue_data` is the
    /// venue's own instruction data and `ctx.remaining_accounts` are its accounts; the order signs for its vaults.
    pub fn fill_order<'info>(
        ctx: Context<'info, FillOrder<'info>>,
        slice: u64,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrdersError::Paused);
        require!(
            ctx.accounts.order.status == STATUS_OPEN,
            OrdersError::OrderBusy
        );
        require!(
            config.venues[..config.venue_count as usize]
                .contains(&ctx.accounts.venue_program.key())
                && ctx.accounts.venue_program.executable,
            OrdersError::VenueNotAllowed
        );
        let o = &ctx.accounts.order;
        require!(
            slice_allowed(slice, o.in_remaining, o.in_total),
            OrdersError::SliceNotAllowed
        );
        let required = required_out(slice, o.in_remaining, o.min_out_remaining)
            .ok_or(error!(OrdersError::MathOverflow))?;
        let buy = o.side == SIDE_BUY;

        let owner_key = o.owner;
        let nonce_bytes = o.nonce.to_le_bytes();
        let bump = [o.bump];
        let seeds: &[&[u8]] = &[ORDER_SEED, owner_key.as_ref(), &nonce_bytes, &bump];
        let order_info = ctx.accounts.order.to_account_info();

        // Buy: the fee leaves the payment asset before the swap, so the venue is only given what is really being spent.
        let mut buy_fee = 0u64;
        let mut swap_in = slice;
        if buy {
            let filled_after = o
                .fee_base_cum
                .checked_add(slice)
                .ok_or(error!(OrdersError::MathOverflow))?;
            let due =
                fee_ceil(filled_after, o.buy_fee_bps).ok_or(error!(OrdersError::MathOverflow))?;
            buy_fee = due.saturating_sub(o.fee_paid);
            require!(buy_fee < slice, OrdersError::AmountTooSmall);
            swap_in = slice - buy_fee;
            transfer(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.quote_vault,
                &ctx.accounts.quote_mint,
                &ctx.accounts.fee_quote,
                &order_info,
                buy_fee,
                &[seeds],
            )?;
            ctx.accounts.quote_vault.reload()?;
        }

        let (in_before, out_before) = if buy {
            (
                ctx.accounts.quote_vault.amount,
                ctx.accounts.launch_vault.amount,
            )
        } else {
            (
                ctx.accounts.launch_vault.amount,
                ctx.accounts.quote_vault.amount,
            )
        };
        // Lock the order on chain before handing the signature to the venue.
        ctx.accounts.order.status = STATUS_FILLING;
        ctx.accounts.order.exit(&crate::ID)?;

        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer || *a.key == order_info.key(),
                is_writable: a.is_writable,
            })
            .collect();
        let mut infos: Vec<AccountInfo<'info>> = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.venue_program.to_account_info());
        infos.push(order_info.clone());
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.venue_program.key(),
                accounts: metas,
                data: venue_data,
            },
            &infos,
            &[seeds],
        )?;

        ctx.accounts.launch_vault.reload()?;
        ctx.accounts.quote_vault.reload()?;
        let order_key = order_info.key();
        for v in [&ctx.accounts.launch_vault, &ctx.accounts.quote_vault] {
            require!(
                v.owner == order_key && v.delegate.is_none() && v.close_authority.is_none(),
                OrdersError::VaultTampered
            );
        }
        let (in_after, out_after) = if buy {
            (
                ctx.accounts.quote_vault.amount,
                ctx.accounts.launch_vault.amount,
            )
        } else {
            (
                ctx.accounts.launch_vault.amount,
                ctx.accounts.quote_vault.amount,
            )
        };
        require!(
            in_before.checked_sub(in_after) == Some(swap_in),
            OrdersError::WrongAmountSpent
        );
        let received = out_after
            .checked_sub(out_before)
            .ok_or(error!(OrdersError::MathOverflow))?;

        // What the owner is owed: the received amount, less Aretia's sell fee, must meet the limit.
        let mut sell_fee = 0u64;
        let mut fee_base_after = ctx.accounts.order.fee_base_cum;
        let net = if buy {
            fee_base_after += slice;
            received
        } else {
            fee_base_after = fee_base_after
                .checked_add(received)
                .ok_or(error!(OrdersError::MathOverflow))?;
            let due = fee_ceil(fee_base_after, ctx.accounts.order.sell_fee_bps)
                .ok_or(error!(OrdersError::MathOverflow))?;
            sell_fee = due.saturating_sub(ctx.accounts.order.fee_paid);
            require!(sell_fee <= received, OrdersError::AmountTooSmall);
            received - sell_fee
        };
        require!(net >= required, OrdersError::LimitNotMet);
        let surplus = net - required;
        let keeper_reward = share_floor(surplus, ctx.accounts.order.keeper_share_bps)
            .ok_or(error!(OrdersError::MathOverflow))?;
        let to_owner = net - keeper_reward;

        if buy {
            // The output is the launch token.
            pay_out(
                &ctx.accounts.launch_token_program,
                &ctx.accounts.launch_vault,
                &ctx.accounts.launch_mint,
                &ctx.accounts.keeper_launch,
                &ctx.accounts.owner_launch,
                keeper_reward,
                to_owner,
                &order_info,
                seeds,
            )?;
        } else {
            transfer(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.quote_vault,
                &ctx.accounts.quote_mint,
                &ctx.accounts.fee_quote,
                &order_info,
                sell_fee,
                &[seeds],
            )?;
            pay_out(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.quote_vault,
                &ctx.accounts.quote_mint,
                &ctx.accounts.keeper_quote,
                &ctx.accounts.owner_quote,
                keeper_reward,
                to_owner,
                &order_info,
                seeds,
            )?;
        }

        let o = &mut ctx.accounts.order;
        o.in_remaining -= slice;
        o.min_out_remaining -= required;
        o.fee_base_cum = fee_base_after;
        o.fee_paid += if buy { buy_fee } else { sell_fee };
        o.status = STATUS_OPEN;
        let remaining = o.in_remaining;
        emit!(OrderFilled {
            order: order_info.key(),
            keeper: ctx.accounts.keeper.key(),
            venue: ctx.accounts.venue_program.key(),
            input_used: slice,
            received,
            aretia_fee: buy_fee + sell_fee,
            keeper_reward,
            to_owner,
            remaining,
        });

        if remaining == 0 {
            ctx.accounts.launch_vault.reload()?;
            ctx.accounts.quote_vault.reload()?;
            close_vault(
                &ctx.accounts.launch_token_program,
                &ctx.accounts.launch_vault,
                &ctx.accounts.launch_mint,
                &ctx.accounts.owner_launch,
                &ctx.accounts.owner.to_account_info(),
                &order_info,
                seeds,
            )?;
            close_vault(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.quote_vault,
                &ctx.accounts.quote_mint,
                &ctx.accounts.owner_quote,
                &ctx.accounts.owner.to_account_info(),
                &order_info,
                seeds,
            )?;
            ctx.accounts
                .order
                .close(ctx.accounts.owner.to_account_info())?;
        }
        Ok(())
    }

    /// Returns what is left of the escrow to the owner, less the cancel fee, and closes the order. Only the owner can
    /// call it, and neither a pause nor a missing keeper can stop it. The fee is in the asset that was escrowed: the
    /// payment asset for a buy, the launch token for a sell.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        cancel_impl(ctx, false)
    }

    /// The same cancel, with no fee, for one case only: the token account Aretia's fee would go to has been FROZEN by the
    /// token's issuer (a stablecoin issuer can do this). A frozen account cannot receive, so the ordinary cancel would fail and the
    /// owner could not get their money back. The program checks the account really is frozen; it cannot be used to skip the fee
    /// otherwise.
    pub fn cancel_order_fee_frozen(ctx: Context<CancelOrder>) -> Result<()> {
        cancel_impl(ctx, true)
    }
}

/// Cancel, shared by the ordinary and the fee-frozen instruction.
fn cancel_impl(ctx: Context<CancelOrder>, waive_fee: bool) -> Result<()> {
    let o = &ctx.accounts.order;
    let buy = o.side == SIDE_BUY;
    let owner_key = o.owner;
    let nonce_bytes = o.nonce.to_le_bytes();
    let bump = [o.bump];
    let seeds: &[&[u8]] = &[ORDER_SEED, owner_key.as_ref(), &nonce_bytes, &bump];
    let order_info = ctx.accounts.order.to_account_info();
    let fee = if waive_fee {
        // Only when the fee's destination really is frozen.
        let fee_account = if buy {
            &ctx.accounts.fee_quote
        } else {
            &ctx.accounts.fee_launch
        };
        require!(
            fee_account.state == AccountState::Frozen,
            OrdersError::FeeAccountNotFrozen
        );
        0
    } else {
        fee_ceil(o.in_remaining, o.cancel_fee_bps)
            .ok_or(error!(OrdersError::MathOverflow))?
            .min(o.in_remaining)
    };

    if buy {
        transfer(
            &ctx.accounts.quote_token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.quote_mint,
            &ctx.accounts.fee_quote,
            &order_info,
            fee,
            &[seeds],
        )?;
    } else {
        transfer(
            &ctx.accounts.launch_token_program,
            &ctx.accounts.launch_vault,
            &ctx.accounts.launch_mint,
            &ctx.accounts.fee_launch,
            &order_info,
            fee,
            &[seeds],
        )?;
    }
    ctx.accounts.launch_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let refunded = if buy {
        ctx.accounts.quote_vault.amount
    } else {
        ctx.accounts.launch_vault.amount
    };
    // Everything left in either vault goes back to the owner, including any stray deposit.
    close_vault(
        &ctx.accounts.launch_token_program,
        &ctx.accounts.launch_vault,
        &ctx.accounts.launch_mint,
        &ctx.accounts.owner_launch,
        &ctx.accounts.owner.to_account_info(),
        &order_info,
        seeds,
    )?;
    close_vault(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.quote_vault,
        &ctx.accounts.quote_mint,
        &ctx.accounts.owner_quote,
        &ctx.accounts.owner.to_account_info(),
        &order_info,
        seeds,
    )?;
    emit!(OrderCancelled {
        order: order_info.key(),
        owner: owner_key,
        refunded,
        fee,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------------------------ helpers

fn check_fees(cancel: u16, buy: u16, sell: u16, keeper: u16) -> Result<()> {
    require!(
        cancel <= MAX_CANCEL_FEE_BPS
            && buy <= MAX_BUY_FEE_BPS
            && sell <= MAX_SELL_FEE_BPS
            && keeper <= MAX_KEEPER_SHARE_BPS,
        OrdersError::FeeAboveCap
    );
    Ok(())
}

/// A venue receives the order's signature. The token programs would let a keeper move the vault anywhere, so they and
/// the other programs that can move or reassign funds on behalf of a signer are refused.
fn is_forbidden_venue(key: &Pubkey) -> bool {
    let forbidden: [Pubkey; 6] = [
        anchor_spl::token::ID,
        TOKEN_2022_PROGRAM_ID,
        anchor_spl::associated_token::ID,
        anchor_lang::system_program::ID,
        anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        crate::ID,
    ];
    *key == Pubkey::default() || forbidden.contains(key)
}

/// The mint must be one Aretia Launch created: an account of the Aretia bonding-curve program that names this mint at the
/// offset the config records (the curve stores its mint at a fixed place after the 8-byte discriminator). Anyone can make
/// such an account only by running the curve program's `create_curve`, which also checks the mint itself.
fn require_launch_token(
    curve: &AccountInfo,
    curve_program: &Pubkey,
    mint_offset: usize,
    mint: &Pubkey,
) -> Result<()> {
    require!(curve.owner == curve_program, OrdersError::NotALaunchToken);
    let data = curve.try_borrow_data()?;
    require!(data.len() >= mint_offset + 32, OrdersError::NotALaunchToken);
    require!(
        data[..8] == CURVE_DISCRIMINATOR,
        OrdersError::NotALaunchToken
    );
    require!(
        data[mint_offset..mint_offset + 32] == mint.to_bytes(),
        OrdersError::NotALaunchToken
    );
    Ok(())
}

/// Token-2022 mints may carry extensions that let someone take or block tokens. Only metadata is allowed.
fn require_no_dangerous_extensions(mint: &AccountInfo) -> Result<()> {
    if mint.owner != &TOKEN_2022_PROGRAM_ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint2022State>::unpack(&data)
        .map_err(|_| error!(OrdersError::UnsupportedMint))?;
    for ext in state
        .get_extension_types()
        .map_err(|_| error!(OrdersError::UnsupportedMint))?
    {
        require!(
            matches!(
                ext,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ),
            OrdersError::UnsupportedMintExtension
        );
    }
    Ok(())
}

fn transfer<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn pay_out<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    keeper: &InterfaceAccount<'info, TokenAccount>,
    owner: &InterfaceAccount<'info, TokenAccount>,
    keeper_reward: u64,
    to_owner: u64,
    order: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    transfer(
        token_program,
        vault,
        mint,
        keeper,
        order,
        keeper_reward,
        &[seeds],
    )?;
    transfer(token_program, vault, mint, owner, order, to_owner, &[seeds])
}

/// Sends whatever is in the vault to the owner's account and closes the vault, returning its rent to the owner.
fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    owner_token: &InterfaceAccount<'info, TokenAccount>,
    owner: &AccountInfo<'info>,
    order: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    transfer(
        token_program,
        vault,
        mint,
        owner_token,
        order,
        vault.amount,
        &[seeds],
    )?;
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: owner.clone(),
            authority: order.clone(),
        },
        &[seeds],
    ))
}

// ------------------------------------------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ OrdersError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::AretiaOrders>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ OrdersError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OrdersError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OrdersError::NotAdmin)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8, nonce: u64)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ASSET_SEED, quote_mint.key().as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [ORDER_SEED, owner.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(mint::token_program = launch_token_program)]
    pub launch_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: proven to be an Aretia curve account for `launch_mint` in `require_launch_token`.
    pub curve: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = launch_mint, associated_token::authority = owner, associated_token::token_program = launch_token_program
    )]
    pub owner_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = quote_mint, associated_token::authority = owner, associated_token::token_program = quote_token_program
    )]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init, payer = owner,
        associated_token::mint = launch_mint, associated_token::authority = order, associated_token::token_program = launch_token_program
    )]
    pub launch_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init, payer = owner,
        associated_token::mint = quote_mint, associated_token::authority = order, associated_token::token_program = quote_token_program
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub launch_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [ORDER_SEED, order.owner.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump,
        has_one = launch_mint @ OrdersError::WrongAccount,
        has_one = quote_mint @ OrdersError::WrongAccount,
        has_one = launch_token_program @ OrdersError::WrongAccount,
        has_one = quote_token_program @ OrdersError::WrongAccount,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: pinned to the order's owner; receives the rent back when the order completes.
    #[account(mut, address = order.owner @ OrdersError::WrongAccount)]
    pub owner: SystemAccount<'info>,
    pub launch_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = order, associated_token::token_program = launch_token_program)]
    pub launch_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = order, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = owner, associated_token::token_program = launch_token_program)]
    pub owner_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = owner, associated_token::token_program = quote_token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = launch_mint, token::token_program = launch_token_program)]
    pub keeper_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::token_program = quote_token_program)]
    pub keeper_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.fee_recipient, token::token_program = quote_token_program)]
    pub fee_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: checked against the whitelist and for `executable` in the handler.
    pub venue_program: UncheckedAccount<'info>,
    pub launch_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = owner, seeds = [ORDER_SEED, owner.key().as_ref(), &order.nonce.to_le_bytes()], bump = order.bump,
        has_one = owner @ OrdersError::NotOwner,
        has_one = launch_mint @ OrdersError::WrongAccount,
        has_one = quote_mint @ OrdersError::WrongAccount,
        has_one = launch_token_program @ OrdersError::WrongAccount,
        has_one = quote_token_program @ OrdersError::WrongAccount,
        constraint = order.status == STATUS_OPEN @ OrdersError::OrderBusy,
    )]
    pub order: Box<Account<'info, Order>>,
    pub launch_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = order, associated_token::token_program = launch_token_program)]
    pub launch_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = order, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = launch_mint, associated_token::authority = owner, associated_token::token_program = launch_token_program)]
    pub owner_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = owner, associated_token::token_program = quote_token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.fee_recipient, token::token_program = quote_token_program)]
    pub fee_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = launch_mint, token::authority = config.fee_recipient, token::token_program = launch_token_program)]
    pub fee_launch: Box<InterfaceAccount<'info, TokenAccount>>,
    pub launch_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------------------------------------------ state

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Controls fees for NEW orders, the pause, the venue whitelist and the asset list. A multisig in production.
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    /// The Aretia bonding-curve program whose accounts prove a token is an Aretia Launch token.
    pub curve_program: Pubkey,
    pub cancel_fee_bps: u16,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub keeper_share_bps: u16,
    pub paused: bool,
    pub venue_count: u8,
    pub venues: [Pubkey; MAX_VENUES],
    /// Where the curve program's account stores its mint (bytes from the start, after the 8-byte discriminator).
    pub curve_mint_offset: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub mint: Pubkey,
    /// Smallest order, in base units: the payment amount for a buy, the least proceeds for a sell.
    pub min_amount: u64,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub owner: Pubkey,
    pub launch_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub launch_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub side: u8,
    pub nonce: u64,
    /// Input escrowed at creation, and what is still unspent.
    pub in_total: u64,
    pub in_remaining: u64,
    /// Output still owed to the owner for the remaining input.
    pub min_out_remaining: u64,
    /// Buy: input filled so far. Sell: gross output received so far. The fee is the cumulative ceiling on this, less
    /// `fee_paid`, so slicing an order into many fills cannot inflate the fee.
    pub fee_base_cum: u64,
    pub fee_paid: u64,
    pub cancel_fee_bps: u16,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub keeper_share_bps: u16,
    pub status: u8,
    pub bump: u8,
    pub created_slot: u64,
}

#[event]
pub struct OrderCreated {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub launch_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub side: u8,
    pub nonce: u64,
    pub amount_in: u64,
    pub min_out: u64,
}

#[event]
pub struct OrderFilled {
    pub order: Pubkey,
    pub keeper: Pubkey,
    pub venue: Pubkey,
    pub input_used: u64,
    pub received: u64,
    pub aretia_fee: u64,
    pub keeper_reward: u64,
    pub to_owner: u64,
    pub remaining: u64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub refunded: u64,
    pub fee: u64,
}

#[error_code]
pub enum OrdersError {
    #[msg("Only the program's upgrade authority can do this")]
    NotUpgradeAuthority,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Only the order's owner can do this")]
    NotOwner,
    #[msg("A fee is above its hard cap")]
    FeeAboveCap,
    #[msg("Too many venues")]
    TooManyVenues,
    #[msg("That program can never be a venue")]
    ForbiddenVenue,
    #[msg("New orders and fills are paused")]
    Paused,
    #[msg("The side must be buy (0) or sell (1)")]
    BadSide,
    #[msg("The amounts must be above zero")]
    ZeroAmount,
    #[msg("That payment asset is not enabled")]
    AssetNotEnabled,
    #[msg("The order is below the minimum size for this asset")]
    BelowMinimum,
    #[msg("This is not an Aretia Launch token")]
    NotALaunchToken,
    #[msg("The curve mint offset must point past the discriminator")]
    BadCurveLayout,
    #[msg("The launch token's mint or freeze authority has not been renounced")]
    LaunchTokenNotFixed,
    #[msg("This token mint cannot be read")]
    UnsupportedMint,
    #[msg("This token has a Token-2022 extension that is not allowed")]
    UnsupportedMintExtension,
    #[msg("The order is being filled or is not open")]
    OrderBusy,
    #[msg("That venue is not on the whitelist")]
    VenueNotAllowed,
    #[msg("A fill must be at least 5% of the order, or all that remains")]
    SliceNotAllowed,
    #[msg("The amount is too small to cover the fee")]
    AmountTooSmall,
    #[msg("The venue changed a vault's owner, delegate or close authority")]
    VaultTampered,
    #[msg("The venue spent a different amount than the fill declared")]
    WrongAmountSpent,
    #[msg("The fill did not deliver the owner's limit price")]
    LimitNotMet,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Wrong account")]
    WrongAccount,
    #[msg("Wrong fee recipient")]
    WrongFeeRecipient,
    #[msg("The fee account is not frozen, so the fee cannot be waived")]
    FeeAccountNotFrozen,
}
