-- Test accounts and sessions for the Playwright suite.
--
-- Verbatim from `docs/frontend/HANDOFF-workspaces.md` §10, extended with the `editor` and
-- `admin` rows `docs/frontend/HANDOFF-live.md` §6 used for the role gate. It writes only to
-- `users` and `sessions` and touches nothing seeded.
--
-- Apply before running the suite:
--
--   export PATH="$PATH:/c/Program Files/PostgreSQL/17/bin"
--   psql "$DATABASE_URL" -f tests/e2e/helpers/seed-sessions.sql
--
-- The suite itself never writes these rows. A test suite that repairs its own fixtures
-- cannot tell you that the fixtures are wrong.

insert into users (id, name, email, email_verified, role) values
  ('11111111-1111-4111-8111-111111111111', 'Owner Tester',  'owner@example.test',  now(), 'user'),
  ('22222222-2222-4222-8222-222222222222', 'Other Tester',  'other@example.test',  now(), 'user'),
  ('33333333-3333-4333-8333-333333333333', 'Editor Tester', 'editor@example.test', now(), 'editor'),
  ('44444444-4444-4444-8444-444444444444', 'Admin Tester',  'admin@example.test',  now(), 'admin')
on conflict (email) do update set role = excluded.role;

insert into sessions (session_token, user_id, expires) values
  ('dev-owner-session-token-000000000001',  '11111111-1111-4111-8111-111111111111', now() + interval '30 days'),
  ('dev-other-session-token-000000000002',  '22222222-2222-4222-8222-222222222222', now() + interval '30 days'),
  ('dev-editor-session-token-00000000003',  '33333333-3333-4333-8333-333333333333', now() + interval '30 days'),
  ('dev-admin-session-token-000000000004',  '44444444-4444-4444-8444-444444444444', now() + interval '30 days')
on conflict (session_token) do update set expires = excluded.expires;
