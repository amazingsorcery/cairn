import { Client } from "pg";

/**
 * Direct database access, for the one thing a browser cannot reach: the server's own clock.
 *
 * Used by exactly one assertion — that a magic link stops working once its lifetime has
 * passed. That check runs on the **server**, against the server's clock and the `expires`
 * column, so moving the browser's clock proves nothing about it. Back-dating the row is the
 * only way to reach the code path without waiting fifteen real minutes, and a test that
 * waits fifteen minutes is a test nobody runs.
 *
 * Deliberately narrow. The suite is a black-box browser suite; this is not a licence to start
 * asserting on rows. If a second use appears, think hard about whether it belongs here or in
 * an integration test with its own transaction.
 */

const CONNECTION = process.env.DATABASE_URL;

export function databaseAvailable(): boolean {
  return Boolean(CONNECTION);
}

/**
 * Age the verification token for `identifier` so the server considers it expired.
 *
 * Returns how many rows were changed, so a caller can tell "the token was aged" from "there
 * was no token to age" — which would otherwise pass silently as a link that happens not to
 * work.
 */
export async function expireVerificationToken(identifier: string): Promise<number> {
  const client = new Client({ connectionString: CONNECTION });
  await client.connect();
  try {
    const result = await client.query(
      `update verification_tokens set expires = now() - interval '1 minute' where identifier = $1`,
      [identifier],
    );
    return result.rowCount ?? 0;
  } finally {
    await client.end();
  }
}
