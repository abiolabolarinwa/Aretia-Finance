//! On-chain (LiteSVM) tests for act-staking. Build first: `cd ../act-staking && cargo build-sbf`.
mod common;
use common::*;

const PROGRAM: &str = "DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH";

fn subject() -> handoff::Subject {
    let mut chain = Chain::new();
    let program = a(PROGRAM);
    chain.load(&program, &so("act-staking", "act_staking.so"));
    let authority = chain.funded();
    let mint = chain.create_mint(9);
    let pda = |seed: &[u8]| Address::find_program_address(&[seed], &program).0;
    let (config, vault_authority) = (pda(b"config"), pda(b"vault_authority"));
    let vault = ata(&vault_authority, &mint);

    let mut args = Vec::new();
    for t in [0u64, 100, 1_000, 10_000, 100_000] {
        args.extend_from_slice(&t.to_le_bytes());
    }
    for d in [30u16, 90, 180, 365] {
        args.extend_from_slice(&d.to_le_bytes());
    }
    for m in [100u16, 125, 150, 200] {
        args.extend_from_slice(&m.to_le_bytes());
    }
    let init = ix(
        &program,
        "initialize_config",
        &args,
        vec![ws(authority.pubkey()), w(config), r(vault_authority), r(mint), w(vault), r(a(TOKEN)), r(a(ATA)), r(a(SYSTEM))],
    );
    chain.send(&[init], &[&authority]).expect("initialize_config");
    handoff::Subject { chain, program, config, authority }
}

#[test]
fn propose_does_not_move_control() {
    handoff::propose_does_not_move_control(subject());
}
#[test]
fn only_the_authority_can_propose() {
    handoff::only_the_authority_can_propose(subject());
}
#[test]
fn the_zero_key_is_rejected() {
    handoff::the_zero_key_is_rejected(subject());
}
#[test]
fn only_the_nominee_can_accept() {
    handoff::only_the_nominee_can_accept(subject());
}
#[test]
fn accept_moves_control_and_returns_the_rent() {
    handoff::accept_moves_control_and_returns_the_rent(subject());
}
#[test]
fn rent_must_go_to_the_outgoing_authority() {
    handoff::rent_must_go_to_the_outgoing_authority(subject());
}
#[test]
fn accept_with_nothing_pending_fails() {
    handoff::accept_with_nothing_pending_fails(subject());
}
#[test]
fn cancel_withdraws_the_proposal() {
    handoff::cancel_withdraws_the_proposal(subject());
}
#[test]
fn a_new_proposal_replaces_the_old_one() {
    handoff::a_new_proposal_replaces_the_old_one(subject());
}
#[test]
fn a_mistyped_key_cannot_strand_control() {
    handoff::a_mistyped_key_cannot_strand_control(subject());
}
#[test]
fn the_single_step_instruction_is_gone() {
    handoff::the_single_step_instruction_is_gone(subject());
}
