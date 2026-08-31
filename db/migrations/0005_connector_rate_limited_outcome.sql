-- Hand-written. QA finding Q-02, follow-up.
--
-- Adds `rateLimited` to the `connector_requests.outcome` vocabulary.
--
-- WHY A SIXTH OUTCOME RATHER THAN REUSING `quotaDenied`. They are different operational
-- facts. `quotaDenied` means WE refused the caller, against a ceiling we chose;
-- `rateLimited` means THEY refused us — an HTTP 429 or 420, or our own cooldown standing
-- down afterwards. An operator reading the connector health board at 3am who sees
-- `quotaDenied` will go and tune our quota, when the fix is to back off from theirs. That is
-- a real misdiagnosis with a real cost.
--
-- The pair (`upstreamError`, `upstream_status = 429`) was reconstructible before this, but
-- reconstructible is not legible, and the health board is read under pressure.
--
-- `db/schema.ts` carries the same list; the two must change together or the CHECK rejects a
-- value the application believes is valid. Migration 0001 created the original constraint and
-- is applied, so it is replaced here rather than edited.
--
-- No data migration: nothing has ever been written with this value, and existing
-- `quotaDenied` rows are left alone. Re-labelling history would be inventing a distinction
-- the code was not making at the time.

ALTER TABLE connector_requests
    DROP CONSTRAINT IF EXISTS connector_requests_outcome_check;
--> statement-breakpoint
ALTER TABLE connector_requests
    ADD CONSTRAINT connector_requests_outcome_check
    CHECK (outcome in ('ok', 'upstreamError', 'quotaDenied', 'rateLimited', 'disabled', 'timeout'));
