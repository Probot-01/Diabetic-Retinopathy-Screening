-- Up Migration
-- =============================================================================
-- Design doc §10.5: "An undeliverable SMS flips the referral straight into the
-- manual-follow-up state on the Referral Tracker."
--
-- That state did not exist. A failed SMS left the referral sitting in
-- 'referred', indistinguishable from one where the patient was told -- so the
-- one case that most needs a human phone call looked exactly like the ones
-- that need nothing.
--
-- 'manual_follow_up' is a starting state, not a terminal one: the tracker moves
-- it on to contacted / attended / lost as normal once someone reaches the
-- patient.
-- =============================================================================
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('referred', 'manual_follow_up', 'contacted', 'attended', 'lost'));

-- Down Migration
UPDATE referrals SET status = 'referred' WHERE status = 'manual_follow_up';
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('referred', 'contacted', 'attended', 'lost'));
