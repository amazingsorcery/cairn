-- Hand-written.
--
-- `rate_limits.key` is `<action>:<HMAC-SHA256(subject)>` and must never hold a raw email or
-- IP. Enforce that in the database, matching the existing check on
-- `connector_requests.actor_key`. The action prefix is a closed vocabulary of lowercase
-- words and hyphens (`RATE_LIMIT_ACTIONS`).

-- Drop any non-conforming rows first; counters are ephemeral anyway.
DELETE FROM rate_limits WHERE key !~ '^[a-z-]+:[0-9a-f]{64}$';
--> statement-breakpoint
ALTER TABLE rate_limits
    ADD CONSTRAINT rate_limits_key_check
    CHECK (key ~ '^[a-z-]+:[0-9a-f]{64}$');
