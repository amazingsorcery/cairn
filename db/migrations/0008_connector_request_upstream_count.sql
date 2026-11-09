-- Trimmed from `drizzle-kit generate`: 0006 and 0007 are hand-written, so generate re-emitted
-- their objects. `meta/0008_snapshot.json` has the full end state. Review generate output
-- before committing it.
--
-- One attempt can make several upstream requests (DNS: one per record type, RIPEstat: four,
-- etc.), so record the count. This is volume only; never store what was asked for.
-- DEFAULT 1; app code passes 0 for refusals that made no request.
ALTER TABLE "connector_requests" ADD COLUMN "upstream_requests" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_requests" ADD CONSTRAINT "connector_requests_upstream_requests_check" CHECK (upstream_requests >= 0);
