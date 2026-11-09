-- Hand-written.
--
-- Tighten the `adsb-lol` quota: the previous 20/user/min and 60/min global drew frequent
-- 429s. Seeding doesn't overwrite operator-tunable quota columns, so this needs a migration.
-- The matching 429/420 cooldown lives in `lib/connectors/runtime.ts`.

UPDATE connectors
SET
    -- Measured 2026-08-31: refusals appear even at 10/min (token bucket, no published
    -- limit). 6/min sits below the lowest refused rate.
    per_user_quota = 3,
    global_ceiling = 6,
    cache_ttl_seconds = 60,
    -- Serve aged positions while backed off.
    stale_while_revalidate_seconds = 600,
    -- Fail closed; an operator re-enables after reviewing the legal basis.
    enabled = false,
    notes = 'Quota envelope tightened and backoff added after QA finding Q-02 (57 logged 429s under the previous settings). Re-enable only after reading the corrected legal_basis.',
    updated_at = now()
WHERE slug = 'adsb-lol';
