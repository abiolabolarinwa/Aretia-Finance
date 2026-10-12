//! F-17: on-chain scenarios for the two-step authority handoff, written against the shared two-step handoff interface (propose / accept / cancel) so that any program that
//! adopts it can reuse them; today only act-staking does (act-presale, the other adopter, was removed).
#![allow(dead_code)]

use super::*;

pub struct Subject {
    pub chain: Chain,
    pub program: Address,
    pub config: Address,
    /// Current `config.authority`.
    pub authority: Keypair,
}

fn pending_pda(s: &Subject) -> Address {
    Address::find_program_address(&[b"pending_authority"], &s.program).0
}
/// `config.authority` is the first field after the 8-byte discriminator in both programs.
pub fn config_authority(s: &Subject) -> Address {
    Address::try_from(&s.chain.data(&s.config)[8..40]).unwrap()
}
fn pending_nominee(s: &Subject) -> Address {
    Address::try_from(&s.chain.data(&pending_pda(s))[8..40]).unwrap()
}

pub fn propose_ix(s: &Subject, authority: &Address, nominee: &Address) -> Instruction {
    ix(&s.program, "propose_config_authority", nominee.as_ref(), vec![ws(*authority), r(s.config), w(pending_pda(s)), r(a(SYSTEM))])
}
pub fn accept_ix(s: &Subject, signer: &Address, rent_receiver: &Address) -> Instruction {
    ix(&s.program, "accept_config_authority", &[], vec![rs(*signer), w(s.config), w(pending_pda(s)), w(*rent_receiver)])
}
pub fn cancel_ix(s: &Subject, authority: &Address) -> Instruction {
    ix(&s.program, "cancel_config_authority", &[], vec![ws(*authority), r(s.config), w(pending_pda(s))])
}
/// Both programs have `set_paused(bool)` with accounts [config (w), authority (signer)] — used to prove who can administer.
pub fn set_paused_ix(s: &Subject, authority: &Address, paused: bool) -> Instruction {
    ix(&s.program, "set_paused", &[paused as u8], vec![w(s.config), rs(*authority)])
}

pub fn propose_does_not_move_control(mut s: Subject) {
    let nominee = Keypair::new();
    let auth = s.authority.insecure_clone();
    let before = config_authority(&s);
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &nominee.pubkey())], &[&auth]).unwrap();
    assert_eq!(config_authority(&s), before, "control must not move on propose");
    assert_eq!(pending_nominee(&s), nominee.pubkey());
    // the current authority can still administer while a proposal is pending
    s.chain.send(&[set_paused_ix(&s, &auth.pubkey(), false)], &[&auth]).unwrap();
    // and the nominee cannot administer yet
    assert_fails_with(s.chain.send(&[set_paused_ix(&s, &nominee.pubkey(), true)], &[&nominee]), "ConstraintHasOne");
}

pub fn only_the_authority_can_propose(mut s: Subject) {
    let stranger = s.chain.funded();
    assert_fails_with(s.chain.send(&[propose_ix(&s, &stranger.pubkey(), &stranger.pubkey())], &[&stranger]), "ConstraintHasOne");
    assert!(!s.chain.exists(&pending_pda(&s)));
}

pub fn the_zero_key_is_rejected(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    assert_fails_with(s.chain.send(&[propose_ix(&s, &auth.pubkey(), &Address::default())], &[&auth]), "InvalidNewAuthority");
    assert!(!s.chain.exists(&pending_pda(&s)));
}

pub fn only_the_nominee_can_accept(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let nominee = s.chain.funded();
    let stranger = s.chain.funded();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &nominee.pubkey())], &[&auth]).unwrap();
    let before = config_authority(&s);
    assert_fails_with(s.chain.send(&[accept_ix(&s, &stranger.pubkey(), &auth.pubkey())], &[&stranger]), "NotThePendingAuthority");
    assert_fails_with(s.chain.send(&[accept_ix(&s, &auth.pubkey(), &auth.pubkey())], &[&auth]), "NotThePendingAuthority");
    assert_eq!(config_authority(&s), before);
    assert!(s.chain.exists(&pending_pda(&s)));
}

pub fn accept_moves_control_and_returns_the_rent(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let nominee = s.chain.funded();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &nominee.pubkey())], &[&auth]).unwrap();
    let pending_lamports = s.chain.lamports(&pending_pda(&s));
    assert!(pending_lamports > 0);
    let old_before = s.chain.lamports(&auth.pubkey());

    s.chain.send(&[accept_ix(&s, &nominee.pubkey(), &auth.pubkey())], &[&nominee]).unwrap();

    assert_eq!(config_authority(&s), nominee.pubkey());
    assert!(!s.chain.exists(&pending_pda(&s)), "the proposal account must be closed");
    assert_eq!(s.chain.lamports(&auth.pubkey()), old_before + pending_lamports, "rent goes back to the outgoing authority");
    // old authority lost its power, the new one has it
    assert_fails_with(s.chain.send(&[set_paused_ix(&s, &auth.pubkey(), true)], &[&auth]), "ConstraintHasOne");
    s.chain.send(&[set_paused_ix(&s, &nominee.pubkey(), true)], &[&nominee]).unwrap();
    s.chain.send(&[set_paused_ix(&s, &nominee.pubkey(), false)], &[&nominee]).unwrap();
    // the old authority can no longer propose or cancel either
    assert_fails_with(s.chain.send(&[propose_ix(&s, &auth.pubkey(), &auth.pubkey())], &[&auth]), "ConstraintHasOne");
}

pub fn rent_must_go_to_the_outgoing_authority(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let nominee = s.chain.funded();
    let thief = Keypair::new();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &nominee.pubkey())], &[&auth]).unwrap();
    assert_fails_with(s.chain.send(&[accept_ix(&s, &nominee.pubkey(), &thief.pubkey())], &[&nominee]), "ConstraintAddress");
    assert_eq!(config_authority(&s), auth.pubkey());
}

pub fn accept_with_nothing_pending_fails(mut s: Subject) {
    let anyone = s.chain.funded();
    let auth = s.authority.insecure_clone();
    assert!(s.chain.send(&[accept_ix(&s, &anyone.pubkey(), &auth.pubkey())], &[&anyone]).is_err());
    assert_eq!(config_authority(&s), auth.pubkey());
}

pub fn cancel_withdraws_the_proposal(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let nominee = s.chain.funded();
    let stranger = s.chain.funded();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &nominee.pubkey())], &[&auth]).unwrap();
    assert_fails_with(s.chain.send(&[cancel_ix(&s, &stranger.pubkey())], &[&stranger]), "ConstraintHasOne");
    assert_fails_with(s.chain.send(&[cancel_ix(&s, &nominee.pubkey())], &[&nominee]), "ConstraintHasOne");
    let before = s.chain.lamports(&auth.pubkey());
    let pending_lamports = s.chain.lamports(&pending_pda(&s));
    s.chain.send(&[cancel_ix(&s, &auth.pubkey())], &[&auth]).unwrap();
    assert!(!s.chain.exists(&pending_pda(&s)));
    assert_eq!(s.chain.lamports(&auth.pubkey()), before + pending_lamports);
    // the nominee can no longer take control, and nothing is left to cancel
    assert!(s.chain.send(&[accept_ix(&s, &nominee.pubkey(), &auth.pubkey())], &[&nominee]).is_err());
    assert!(s.chain.send(&[cancel_ix(&s, &auth.pubkey())], &[&auth]).is_err());
    assert_eq!(config_authority(&s), auth.pubkey());
}

pub fn a_new_proposal_replaces_the_old_one(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let bob = s.chain.funded();
    let eve = s.chain.funded();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &bob.pubkey())], &[&auth]).unwrap();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &eve.pubkey())], &[&auth]).unwrap();
    assert_eq!(pending_nominee(&s), eve.pubkey());
    assert_fails_with(s.chain.send(&[accept_ix(&s, &bob.pubkey(), &auth.pubkey())], &[&bob]), "NotThePendingAuthority");
    s.chain.send(&[accept_ix(&s, &eve.pubkey(), &auth.pubkey())], &[&eve]).unwrap();
    assert_eq!(config_authority(&s), eve.pubkey());
}

/// The F-17 scenario itself: a key nobody can sign with is nominated by mistake.
pub fn a_mistyped_key_cannot_strand_control(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let typo = Address::new_unique(); // no private key exists for this address
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &typo)], &[&auth]).unwrap();
    assert_eq!(config_authority(&s), auth.pubkey(), "the real authority still holds control");
    s.chain.send(&[set_paused_ix(&s, &auth.pubkey(), false)], &[&auth]).unwrap();
    // recover: cancel (or simply re-propose the right key)
    s.chain.send(&[cancel_ix(&s, &auth.pubkey())], &[&auth]).unwrap();
    let right = s.chain.funded();
    s.chain.send(&[propose_ix(&s, &auth.pubkey(), &right.pubkey())], &[&auth]).unwrap();
    s.chain.send(&[accept_ix(&s, &right.pubkey(), &auth.pubkey())], &[&right]).unwrap();
    assert_eq!(config_authority(&s), right.pubkey());
}

/// The removed single-step instruction must not exist any more.
pub fn the_single_step_instruction_is_gone(mut s: Subject) {
    let auth = s.authority.insecure_clone();
    let old = ix(&s.program, "set_config_authority", Address::new_unique().as_ref(), vec![w(s.config), rs(auth.pubkey())]);
    assert!(s.chain.send(&[old], &[&auth]).is_err());
    assert_eq!(config_authority(&s), auth.pubkey());
}
