//! TEST ONLY. Never deploy. A swap venue that exchanges at whatever amounts the caller names, so tests can drive the
//! order program through good fills, bad prices and hostile behaviour. The venue's own liquidity sits in token accounts
//! owned by the PDA ["venue"].

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{
    self, Mint, SetAuthority, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("9npegSLYYqdF6ugKsXVnCsEHBV1XDAtsA8dXQEQnDxNn");

#[program]
pub mod aretia_orders_mock_venue {
    use super::*;

    /// Takes `spend` from the user's input account and pays `amount_out` from the venue's liquidity.
    pub fn swap(ctx: Context<Swap>, spend: u64, amount_out: u64) -> Result<()> {
        do_swap(&ctx, spend, amount_out)
    }

    /// Hostile: spends `extra` more than it was told to.
    pub fn swap_overspend(
        ctx: Context<Swap>,
        spend: u64,
        amount_out: u64,
        extra: u64,
    ) -> Result<()> {
        do_swap(&ctx, spend + extra, amount_out)
    }

    /// Hostile: hands the user's input account to another owner using the signature it was lent.
    pub fn steal_ownership(ctx: Context<Swap>, new_owner: Pubkey) -> Result<()> {
        token_interface::set_authority(
            CpiContext::new(
                ctx.accounts.in_token_program.key(),
                SetAuthority {
                    current_authority: ctx.accounts.user_authority.to_account_info(),
                    account_or_mint: ctx.accounts.user_in.to_account_info(),
                },
            ),
            anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::AccountOwner,
            Some(new_owner),
        )
    }

    /// Hostile: calls another program (for example the order program again) with the signature it was lent.
    pub fn reenter<'info>(ctx: Context<'info, Reenter<'info>>, data: Vec<u8>) -> Result<()> {
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.target.to_account_info());
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.target.key(),
                accounts: metas,
                data,
            },
            &infos,
            &[],
        )?;
        Ok(())
    }
}

fn do_swap(ctx: &Context<Swap>, spend: u64, amount_out: u64) -> Result<()> {
    let a = &ctx.accounts;
    token_interface::transfer_checked(
        CpiContext::new(
            a.in_token_program.key(),
            TransferChecked {
                from: a.user_in.to_account_info(),
                mint: a.in_mint.to_account_info(),
                to: a.venue_in.to_account_info(),
                authority: a.user_authority.to_account_info(),
            },
        ),
        spend,
        a.in_mint.decimals,
    )?;
    let bump = ctx.bumps.venue_authority;
    let seeds: &[&[u8]] = &[b"venue", &[bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.out_token_program.key(),
            TransferChecked {
                from: a.venue_out.to_account_info(),
                mint: a.out_mint.to_account_info(),
                to: a.user_out.to_account_info(),
                authority: a.venue_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount_out,
        a.out_mint.decimals,
    )
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user_authority: Signer<'info>,
    #[account(mut)]
    pub user_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub venue_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub venue_out: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_out: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA that owns the venue's liquidity accounts.
    #[account(seeds = [b"venue"], bump)]
    pub venue_authority: UncheckedAccount<'info>,
    pub in_mint: InterfaceAccount<'info, Mint>,
    pub out_mint: InterfaceAccount<'info, Mint>,
    pub in_token_program: Interface<'info, TokenInterface>,
    pub out_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Reenter<'info> {
    /// CHECK: the program to call.
    pub target: UncheckedAccount<'info>,
}
