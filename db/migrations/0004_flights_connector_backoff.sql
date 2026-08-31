-- Hand-written. QA finding Q-02.
--
-- The `adsb-lol` row shipped with a quota envelope roughly ten times looser than the upstream
-- actually tolerates: 20/user/min and 60/min global, against a limiter that refused the 3rd
-- request of a 25-request burst. The audit log recorded 57 HTTP 429s and one 420 — 29% of
-- every outbound call refused.
--
-- Worse than the rate itself, the row's own `legal_basis` stated that we call "at a rate
-- bounded by the columns on this row", and the audit log proved that false. For a product
-- whose thesis is that its records are accurate, a false statement in the connector registry
-- is the more serious defect.
--
-- `db/seed.ts` deliberately does NOT overwrite the quota columns on re-seed — they are
-- operator-tunable under ADR 0012 — so a corrected default cannot reach an existing database
-- through seeding. It has to be a migration.
--
-- The code half of this fix is in `lib/connectors/runtime.ts`: a 429 or 420 now opens a
-- per-connector cooldown, honouring `Retry-After` when sent, and the surface returns a
-- `rate-limited` reason that stops the client polling.

UPDATE connectors
SET
    -- Measured 2026-08-31: a 25-request burst was refused from the 3rd request; a smooth 10
    -- requests/minute still drew 2 refusals in 8; after ~20s idle, back-to-back requests
    -- succeeded. So the limiter is a refilling token bucket with no published number, and
    -- 6/min (one call per 10s) sits below the lowest rate at which refusals were observed.
    per_user_quota = 3,
    global_ceiling = 6,
    -- One viewport now costs at most 1 upstream call per minute instead of 4.
    cache_ttl_seconds = 60,
    -- While backed off, show clearly-aged positions rather than a blank page.
    stale_while_revalidate_seconds = 600,
    -- Fail closed after a legal-exposure finding. ADR 0012 §1 seeded this connector
    -- disabled for exactly this reason; an operator must read the corrected legal basis and
    -- turn it back on deliberately, not inherit it from a migration.
    enabled = false,
    notes = 'Quota envelope tightened and backoff added after QA finding Q-02 (57 logged 429s under the previous settings). Re-enable only after reading the corrected legal_basis.',
    updated_at = now()
WHERE slug = 'adsb-lol';
