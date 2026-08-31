/**
 * Reading the magic-link email.
 *
 * Talks to **Mailpit's HTTP API** (`docker-compose.yml`, `127.0.0.1:8025`). Where Docker is
 * not available, `tests/e2e/helpers/smtp-sink.mjs` serves the same three endpoints in the
 * same shapes on the same port, so there is one code path here and the tests cannot tell the
 * difference. `docs/qa/e2e.md` §1 has both recipes.
 *
 * This is what turns the sign-in path from reasoned-about into exercised. Everything the
 * suite previously said about magic links was a claim about copy; with a real inbox it can
 * assert behaviour — that the link works, that it works **once**, and that it dies on the
 * clock rather than when the page says it does.
 */

const MAILBOX = process.env.E2E_MAILBOX_URL ?? "http://127.0.0.1:8025";

/** Mailpit's list entry. Only the fields the suite reads are described. */
interface MailboxSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

interface MailboxMessage {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
}

/** Is there a mailbox to read? Lets a spec skip with a reason rather than fail obscurely. */
export async function mailboxAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILBOX}/api/v1/messages`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Empty the mailbox.
 *
 * Called before each send so "the latest message" is unambiguous. Tests share one inbox, so
 * without this a parallel worker's mail can be picked up as this test's — which would pass,
 * against the wrong token, and be very hard to explain.
 */
export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILBOX}/api/v1/messages`, { method: "DELETE" });
}

/**
 * Wait for a message addressed to `to`, and return it.
 *
 * A bounded poll rather than a fixed sleep: mail arrives when the transport finishes, which
 * is not a duration anybody can name in advance. The deadline is what makes it terminate.
 */
export async function waitForMessage(to: string, timeoutMs = 15_000): Promise<MailboxMessage> {
  const deadline = Date.now() + timeoutMs;
  const wanted = to.toLowerCase();

  for (;;) {
    const listed = await fetch(`${MAILBOX}/api/v1/messages`).then(
      (response) => response.json() as Promise<{ messages: MailboxSummary[] }>,
    );
    const match = listed.messages.find((message) =>
      message.To.some((recipient) => recipient.Address.toLowerCase() === wanted),
    );
    if (match) {
      return (await fetch(`${MAILBOX}/api/v1/message/${match.ID}`).then((response) =>
        response.json(),
      )) as MailboxMessage;
    }
    if (Date.now() > deadline) {
      const addresses = listed.messages.flatMap((message) =>
        message.To.map((recipient) => recipient.Address),
      );
      throw new Error(
        `No message for ${to} within ${timeoutMs}ms. Mailbox held: ${
          addresses.length ? addresses.join(", ") : "nothing"
        }.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The sign-in URL out of the email body.
 *
 * Taken from the **text** part in preference to the HTML: the HTML part is what a mail client
 * renders and is entity-encoded, and a token that survives an `&amp;` round trip by accident
 * is not something to rely on. Falls back to the HTML with entities decoded.
 */
export function magicLinkFrom(message: MailboxMessage): string {
  const CALLBACK = /https?:\/\/[^\s"'<>]*\/api\/auth\/callback\/[^\s"'<>]+/;

  const fromText = CALLBACK.exec(message.Text ?? "")?.[0];
  if (fromText) return fromText;

  const decoded = (message.HTML ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&quot;/g, '"');
  const fromHtml = CALLBACK.exec(decoded)?.[0];
  if (fromHtml) return fromHtml;

  throw new Error(
    `No sign-in link in the message. Subject: ${message.Subject}. Text began: ${(
      message.Text ?? ""
    ).slice(0, 200)}`,
  );
}
