/**
 * Reading the magic-link email via Mailpit's HTTP API (`127.0.0.1:8025`). Without Docker,
 * run `node tests/e2e/helpers/smtp-sink.mjs`, which serves the same endpoints.
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

/** Empty the shared mailbox before each send so "the latest message" is unambiguous. */
export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILBOX}/api/v1/messages`, { method: "DELETE" });
}

/** Poll (with a deadline) for a message addressed to `to`. */
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

/** The sign-in URL, from the text part (HTML is entity-encoded), falling back to HTML. */
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
