//! Two-step authority handoff, as a pure state machine (no Anchor), so the rules are unit-tested on the host.
//! On-chain mapping (lib.rs): `authority` = `config.authority`; `pending` = the `PendingAuthority` PDA (absent = None).
//! The signer/ownership rules below are enforced on-chain by account constraints, which these tests do NOT exercise
//! (see docs/audit/TEST_EVIDENCE.md); `check_new_authority` is shared with the handlers.

// The `Handoff` state machine is the unit-tested specification of the on-chain rules; the program itself uses only
// `check_new_authority` (the signer/PDA rules are account constraints). Hence dead code in non-test builds, by design.
#![cfg_attr(not(test), allow(dead_code))]

pub type Key = [u8; 32];
pub const ZERO_KEY: Key = [0u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffError {
    Unauthorized,
    InvalidNewAuthority,
    NothingPending,
    NotThePendingAuthority,
}

/// The all-zero key is never a valid authority (same rule the single-step instruction had).
pub fn check_new_authority(new: &Key) -> Result<(), HandoffError> {
    if *new == ZERO_KEY {
        Err(HandoffError::InvalidNewAuthority)
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    pub authority: Key,
    pub pending: Option<Key>,
}

impl Handoff {
    pub fn new(authority: Key) -> Self {
        Self { authority, pending: None }
    }

    /// Current authority nominates `new`. Control does NOT move: a mistyped or unsignable key therefore cannot strand it.
    /// A later proposal replaces an earlier one.
    pub fn propose(&mut self, caller: Key, new: Key) -> Result<(), HandoffError> {
        if caller != self.authority {
            return Err(HandoffError::Unauthorized);
        }
        check_new_authority(&new)?;
        self.pending = Some(new);
        Ok(())
    }

    /// Only the nominated key, by signing, takes control (proving it can sign). Clears the proposal.
    pub fn accept(&mut self, caller: Key) -> Result<(), HandoffError> {
        match self.pending {
            None => Err(HandoffError::NothingPending),
            Some(p) if p != caller => Err(HandoffError::NotThePendingAuthority),
            Some(p) => {
                self.authority = p;
                self.pending = None;
                Ok(())
            }
        }
    }

    /// Current authority withdraws an outstanding proposal.
    pub fn cancel(&mut self, caller: Key) -> Result<(), HandoffError> {
        if caller != self.authority {
            return Err(HandoffError::Unauthorized);
        }
        if self.pending.take().is_none() {
            return Err(HandoffError::NothingPending);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: Key = [1; 32]; // current authority
    const BOB: Key = [2; 32]; // intended new authority
    const EVE: Key = [3; 32]; // anyone else

    fn started() -> Handoff {
        Handoff::new(ALICE)
    }

    #[test]
    fn only_the_current_authority_can_propose() {
        let mut h = started();
        assert_eq!(h.propose(EVE, EVE), Err(HandoffError::Unauthorized));
        assert_eq!(h.propose(BOB, BOB), Err(HandoffError::Unauthorized));
        assert_eq!(h, started());
    }
    #[test]
    fn the_zero_key_is_rejected() {
        let mut h = started();
        assert_eq!(h.propose(ALICE, ZERO_KEY), Err(HandoffError::InvalidNewAuthority));
        assert_eq!(h, started());
    }
    #[test]
    fn proposing_changes_nothing_until_accepted() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        assert_eq!(h.authority, ALICE, "control must not move on propose");
        assert_eq!(h.pending, Some(BOB));
    }
    #[test]
    fn the_pending_authority_can_accept_and_becomes_the_authority() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        h.accept(BOB).unwrap();
        assert_eq!(h.authority, BOB);
        assert_eq!(h.pending, None);
    }
    #[test]
    fn nobody_else_can_accept_including_the_old_authority() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        let before = h.clone();
        assert_eq!(h.accept(EVE), Err(HandoffError::NotThePendingAuthority));
        assert_eq!(h.accept(ALICE), Err(HandoffError::NotThePendingAuthority));
        assert_eq!(h, before);
    }
    #[test]
    fn accept_with_nothing_pending_fails() {
        let mut h = started();
        assert_eq!(h.accept(BOB), Err(HandoffError::NothingPending));
        assert_eq!(h.accept(ALICE), Err(HandoffError::NothingPending));
    }
    #[test]
    fn after_accepting_the_old_authority_has_no_power() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        h.accept(BOB).unwrap();
        assert_eq!(h.propose(ALICE, ALICE), Err(HandoffError::Unauthorized));
        assert_eq!(h.cancel(ALICE), Err(HandoffError::Unauthorized));
        assert!(h.propose(BOB, EVE).is_ok());
    }
    #[test]
    fn the_authority_can_cancel_and_the_proposal_then_cannot_be_accepted() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        assert_eq!(h.cancel(EVE), Err(HandoffError::Unauthorized));
        assert_eq!(h.cancel(BOB), Err(HandoffError::Unauthorized));
        h.cancel(ALICE).unwrap();
        assert_eq!(h.pending, None);
        assert_eq!(h.accept(BOB), Err(HandoffError::NothingPending));
        assert_eq!(h.cancel(ALICE), Err(HandoffError::NothingPending));
    }
    #[test]
    fn a_new_proposal_replaces_the_old_one() {
        let mut h = started();
        h.propose(ALICE, BOB).unwrap();
        h.propose(ALICE, EVE).unwrap();
        assert_eq!(h.accept(BOB), Err(HandoffError::NotThePendingAuthority));
        h.accept(EVE).unwrap();
        assert_eq!(h.authority, EVE);
    }
    #[test]
    fn a_mistyped_key_cannot_strand_control() {
        // The F-17 scenario: the proposed key is one nobody can sign with.
        let typo: Key = [9; 32];
        let mut h = started();
        h.propose(ALICE, typo).unwrap();
        assert_eq!(h.authority, ALICE, "the current authority still holds control");
        h.cancel(ALICE).unwrap(); // or simply re-propose the right key
        h.propose(ALICE, BOB).unwrap();
        h.accept(BOB).unwrap();
        assert_eq!(h.authority, BOB);
    }
}
