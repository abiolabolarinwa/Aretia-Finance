//! Pure arithmetic for the order program. Everything is integer maths on u128 so nothing overflows, and every rounding
//! direction is chosen deliberately and tested.

pub const BPS: u128 = 10_000;

/// `ceil(amount * bps / 10_000)`. Fees round UP, so Aretia is never short by a unit. Over a whole order the cumulative
/// scheme in the program means the total can exceed the exact value by at most one unit.
pub fn fee_ceil(amount: u64, bps: u16) -> Option<u64> {
    let n = (amount as u128).checked_mul(bps as u128)?;
    let q = n.checked_add(BPS - 1)? / BPS;
    u64::try_from(q).ok()
}

/// `floor(amount * bps / 10_000)`. Used for the keeper's share, which rounds DOWN so the owner never loses a unit.
pub fn share_floor(amount: u64, bps: u16) -> Option<u64> {
    let n = (amount as u128).checked_mul(bps as u128)?;
    u64::try_from(n / BPS).ok()
}

/// The least output a fill of `slice` input must deliver. The order has `in_remaining` input left and still owes
/// `min_out_remaining` output, so the rate never drifts: `ceil(slice * min_out_remaining / in_remaining)`, and the
/// last slice owes exactly what is left.
pub fn required_out(slice: u64, in_remaining: u64, min_out_remaining: u64) -> Option<u64> {
    if in_remaining == 0 || slice > in_remaining {
        return None;
    }
    if slice == in_remaining {
        return Some(min_out_remaining);
    }
    let n = (slice as u128).checked_mul(min_out_remaining as u128)?;
    let d = in_remaining as u128;
    let q = n.checked_add(d - 1)? / d;
    u64::try_from(q).ok()
}

/// A fill may not be a sliver (that would let a keeper grind an order into dust): at least 5% of the original size, or
/// whatever remains.
pub fn slice_allowed(slice: u64, in_remaining: u64, in_total: u64) -> bool {
    slice > 0
        && slice <= in_remaining
        && (slice == in_remaining || (slice as u128) * 20 >= in_total as u128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_rounds_up_and_share_rounds_down() {
        assert_eq!(fee_ceil(10_000, 150), Some(150));
        assert_eq!(fee_ceil(1, 150), Some(1));
        assert_eq!(fee_ceil(0, 150), Some(0));
        assert_eq!(fee_ceil(u64::MAX, 10_000), Some(u64::MAX));
        assert_eq!(share_floor(99, 5_000), Some(49));
        assert_eq!(share_floor(u64::MAX, 10_000), Some(u64::MAX));
    }

    #[test]
    fn cumulative_fee_equals_the_ceiling_of_the_whole() {
        // Slicing an order into many fills must not inflate the fee: the program charges the difference of cumulative
        // ceilings, so the total is exactly the ceiling of the whole, not the sum of per-slice ceilings.
        let slices = [50_001u64, 100_000, 200_002, 649_997];
        let (mut filled, mut paid) = (0u64, 0u64);
        for s in slices {
            filled += s;
            paid += fee_ceil(filled, 150).unwrap() - paid;
        }
        assert_eq!(paid, fee_ceil(filled, 150).unwrap());
        let per_slice: u64 = slices.iter().map(|s| fee_ceil(*s, 150).unwrap()).sum();
        assert!(paid <= per_slice);
    }

    #[test]
    fn required_out_keeps_the_rate_and_settles_exactly() {
        let (mut rem, mut out) = (1_000u64, 333u64);
        let mut owed = 0u64;
        for s in [100u64, 250, 300, 350] {
            let r = required_out(s, rem, out).unwrap();
            owed += r;
            rem -= s;
            out -= r;
        }
        assert_eq!(rem, 0);
        assert_eq!(owed, 333); // the last slice owes exactly the remainder
    }

    #[test]
    fn required_out_rounds_in_the_owners_favour() {
        assert_eq!(required_out(1, 3, 1), Some(1)); // ceil(1/3)
        assert_eq!(required_out(4, 3, 1), None);
        assert_eq!(required_out(1, 0, 1), None);
    }

    #[test]
    fn slivers_are_refused() {
        assert!(slice_allowed(1_000, 1_000, 1_000_000)); // the remainder is always allowed
        assert!(slice_allowed(50_000, 900_000, 1_000_000));
        assert!(!slice_allowed(49_999, 900_000, 1_000_000));
        assert!(!slice_allowed(0, 10, 10));
        assert!(!slice_allowed(11, 10, 10));
    }
}
