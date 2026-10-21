use act_staking_it::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const TIERS: [u64; 5] = [0, 1_000_000_000, 5_000_000_000, 20_000_000_000, 100_000_000_000];
const DAYS: [u16; 4] = [30, 90, 180, 365];
const MULT: [u16; 4] = [100, 125, 150, 200];
const DAY: i64 = 86_400;

fn text(r: &Sent) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => format!("{:?} {}", e.err, e.meta.logs.join(" | ")),
    }
}
fn fails_with(r: Sent, needle: &str) {
    assert!(r.is_err(), "expected failure containing {needle:?}, but it succeeded");
    let t = text(&r);
    assert!(t.contains(needle), "expected {needle:?} in: {t}");
}

fn initialised() -> Env {
    let mut env = Env::new();
    let u = env.upgrader.insecure_clone();
    env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]).expect("initialize_config by the upgrade authority");
    env
}

/// M-10: a stranger cannot initialise first and take the config; only the upgrade authority can.
#[test]
fn m10_only_the_upgrade_authority_can_initialise() {
    let mut env = Env::new();
    let stranger = env.user(10);
    fails_with(env.send(&[init_ix(&stranger.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&stranger]), "NotUpgradeAuthority");
    // An immutable program (no upgrade authority) cannot be initialised by anyone either.
    env.set_upgrade_authority(None);
    let u = env.upgrader.insecure_clone();
    fails_with(env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]), "NotUpgradeAuthority");
    env.set_upgrade_authority(Some(&u.pubkey()));
    env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]).expect("the upgrade authority can");
    let c = env.config();
    assert_eq!((c.authority, c.mint, c.vault), (u.pubkey(), ACT_MINT, ata(&vault_authority(), &ACT_MINT)));
    assert_eq!((c.tiers, c.duration_days, c.duration_multiplier, c.paused), (TIERS, DAYS, MULT, false));
    // and only once
    assert!(env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]).is_err());
}

/// M-10: the config can only be bound to the ACT mint.
#[test]
fn m10_only_the_act_mint() {
    let mut env = Env::new();
    let other = Keypair::new().pubkey();
    env.write_mint(&other);
    let u = env.upgrader.insecure_clone();
    fails_with(env.send(&[init_ix(&u.pubkey(), &other, &TIERS, &DAYS, &MULT)], &[&u]), "WrongMint");
}

/// M-10: a vault account opened in advance by a stranger no longer blocks initialisation.
#[test]
fn m10_a_pre_opened_vault_does_not_block() {
    let mut env = Env::new();
    let stranger = env.user(10);
    env.send(&[ata_ix(&stranger.pubkey(), &vault_authority(), &ACT_MINT)], &[&stranger]).expect("stranger opens the vault ATA");
    let u = env.upgrader.insecure_clone();
    env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]).expect("initialise anyway");
}

/// I-18: duplicate durations and out-of-range multipliers are refused at initialisation and on update.
#[test]
fn i18_tables_are_checked() {
    let mut env = Env::new();
    let u = env.upgrader.insecure_clone();
    fails_with(env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &[30, 90, 90, 365], &MULT)], &[&u]), "InvalidDurationTable");
    fails_with(env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &[100, 125, 150, 1_001])], &[&u]), "InvalidDurationTable");
    env.send(&[init_ix(&u.pubkey(), &ACT_MINT, &TIERS, &DAYS, &MULT)], &[&u]).expect("init");
    fails_with(env.send(&[update_ix(&u.pubkey(), &TIERS, &[30, 30, 180, 365], &MULT)], &[&u]), "InvalidDurationTable");
    fails_with(env.send(&[update_ix(&u.pubkey(), &TIERS, &DAYS, &[100, 125, 150, u16::MAX])], &[&u]), "InvalidDurationTable");
    env.send(&[update_ix(&u.pubkey(), &TIERS, &DAYS, &[100, 125, 150, 1_000])], &[&u]).expect("10.00x is the most");
}

/// L-30: the tier is recomputed from scratch on every stake, so a top-up after the lock has expired and the config has changed
/// stores the tier under the current config, not a value carried over; and unstake still works.
#[test]
fn l30_the_tier_is_recomputed_on_every_stake() {
    let mut env = initialised();
    let alice = env.user(10);
    let a = alice.pubkey();
    env.fund(&a, &ACT_MINT, 100_000_000_000);
    env.set_time(1_000_000);
    // 3,000 ACT for 365 days at 2.00x = 6,000: tier 2.
    env.send(&[stake_ix(&a, 3_000_000_000, 365)], &[&alice]).expect("stake");
    assert_eq!(env.user_stake(&a).unwrap().tier, 2);
    // The authority raises the thresholds; a new stake must use them, not the old tier.
    let u = env.upgrader.insecure_clone();
    env.send(&[update_ix(&u.pubkey(), &[0, 1_000_000_000, 7_000_000_000, 20_000_000_000, 100_000_000_000], &DAYS, &MULT)], &[&u]).expect("update");
    env.set_time(1_000_000 + 400 * DAY);
    // After the lock ran out: a 30-day top-up of 1 ACT. 4,000 ACT at 1.00x for 30 days = 4,000: tier 1.
    env.send(&[stake_ix(&a, 1_000_000_000, 30)], &[&alice]).expect("top-up");
    let s = env.user_stake(&a).unwrap();
    assert_eq!((s.amount, s.lock_days, s.tier), (4_000_000_000, 30, 1));
    env.set_time(1_000_000 + 431 * DAY);
    env.send(&[unstake_ix(&a)], &[&alice]).expect("unstake");
    assert!(env.user_stake(&a).is_none());
    assert_eq!(env.token_amount(&ata(&a, &ACT_MINT)), 100_000_000_000);
}
