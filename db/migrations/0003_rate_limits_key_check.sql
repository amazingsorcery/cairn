-- Hand-written. QA finding Q-05.
--
-- `rate_limits.key` stores `<action>:<HMAC-SHA256(subject, RATE_LIMIT_SECRET)>` and must
-- NEVER contain a raw email address or IP (ADR 0009). `lib/rate-limit.ts` claimed the key was
-- "structurally incapable" of containing one. It was not: `deriveKey` was the only thing
-- stopping it, and `consume(action, subject)` takes a plain string. The auditor inserted
-- `signin-email:victim@example.com` and a dotted quad, and both succeeded.
--
-- The identical HMAC construction on `connector_requests.actor_key` HAS been constrained
-- since 0001 (`actor_key ~ '^[0-9a-f]{64}$'`) and rejected both attempts. This gives
-- `rate_limits` the same guarantee, so the privacy property is enforced by the database
-- rather than by every writer remembering to go through one function.
--
-- The action prefix is included in the pattern because it is a closed vocabulary of
-- lowercase words and hyphens (`RATE_LIMIT_ACTIONS`); anything else in that position is a
-- caller inventing a key shape, which is exactly what this is meant to stop.

-- Expired and malformed counters are deleted first. These rows are ephemeral by design — the
-- maintenance sweep removes them on `expires_at` anyway — so discarding any that would fail
-- the constraint costs nothing and is strictly better than leaving unhashed subjects in the
-- table. On a clean database this deletes nothing.
DELETE FROM rate_limits WHERE key !~ '^[a-z-]+:[0-9a-f]{64}$';
--> statement-breakpoint
ALTER TABLE rate_limits
    ADD CONSTRAINT rate_limits_key_check
    CHECK (key ~ '^[a-z-]+:[0-9a-f]{64}$');
