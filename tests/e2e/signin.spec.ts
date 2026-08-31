import { expect, test } from "@playwright/test";

import { clearMailbox, magicLinkFrom, mailboxAvailable, waitForMessage } from "./helpers/mail";

/**
 * The magic-link sign-in path, end to end.
 *
 * THIS WAS THE LARGEST UNTESTED SURFACE IN THE PRODUCT. Everything the suite could previously
 * say about magic links was a claim about copy; nothing exercised the credential itself. It is
 * exercised here: a link is requested, read out of a real inbox, followed, and the resulting
 * session is used to reach a page that requires one.
 *
 * REQUIREMENTS — `docs/qa/e2e.md` §1 has the recipes. A server started with `SMTP_HOST`,
 * `SMTP_PORT` and `SMTP_FROM` set (otherwise `authProviders.email` is false and there is no
 * provider to drive), and a mailbox on `127.0.0.1:8025` — Mailpit from `docker-compose.yml`,
 * or `tests/e2e/helpers/smtp-sink.mjs` where Docker is not available. Each test skips with a
 * stated reason when either is missing, so an ordinary run is not red for want of a container.
 *
 * SERIAL, and sharing one inbox. `clearMailbox()` before each send is what makes "the latest
 * message" unambiguous; two workers sending concurrently would each be able to pick up the
 * other's token, which would *pass* against the wrong credential and be very hard to explain.
 */

test.describe.configure({ mode: "serial" });

/** A fresh address per run: sign-in creates a user, and reuse would test a different path. */
const address = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

test.describe("magic-link sign-in", () => {
  test.skip(({ isMobile }) => isMobile === true, "one engine is enough for a credential path");

  test.beforeEach(async () => {
    test.skip(
      !(await mailboxAvailable()),
      "no mailbox on 127.0.0.1:8025 — start Mailpit (`docker compose up -d mailpit`) or " +
        "`node tests/e2e/helpers/smtp-sink.mjs`",
    );
    await clearMailbox();
  });

  /**
   * DEFECT THIS CATCHES: the whole path breaking anywhere along its length — the send failing
   * silently, the link being built against the wrong origin, the callback not establishing a
   * session, or the session not being accepted by the routes it exists to unlock. Every one of
   * those renders a plausible-looking page and none of them is visible to a unit test.
   */
  test("a requested link signs the reader in", async ({ page }) => {
    const email = address();

    await page.goto("/signin");
    const field = page.getByLabel("email", { exact: true });
    await expect(
      field,
      "no email field — the server was started without SMTP_HOST/SMTP_FROM",
    ).toBeVisible();

    await field.fill(email);
    await page.getByRole("button", { name: /email a sign-in link/i }).click();

    const message = await waitForMessage(email);
    const link = magicLinkFrom(message);

    // The link must point at this application, not at a configured public origin that
    // happens to be stale. A link to the wrong host is a link that silently never works.
    expect(new URL(link).host).toBe(new URL(page.url()).host);

    await page.goto(link);

    // Signed in: a session-gated route renders instead of redirecting to /signin.
    await page.goto("/workspaces");
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole("heading", { level: 1, name: /your cases/i })).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: a single-use credential that is not single-use.
   *
   * The token row is deleted on redemption, so a second use must fail. If it ever stops
   * failing, a magic link becomes a reusable bearer credential sitting in an inbox — for an
   * audience (product-brief §4) whose email is specifically worth compromising, that is the
   * difference between a session and a permanent key.
   *
   * Auth.js cannot distinguish "expired" from "already used" — the row is gone either way and
   * both arrive as `error=Verification` — so this asserts what is knowable: the second use
   * does not sign anyone in, and it lands on the error page rather than succeeding quietly.
   */
  test("the same link cannot be used twice", async ({ page, context }) => {
    const email = address();

    await page.goto("/signin");
    await page.getByLabel("email", { exact: true }).fill(email);
    await page.getByRole("button", { name: /email a sign-in link/i }).click();

    const link = magicLinkFrom(await waitForMessage(email));

    await page.goto(link);
    await page.goto("/workspaces");
    await expect(page, "the first use must work, or this test proves nothing").toHaveURL(
      /\/workspaces$/,
    );

    // A different browser, i.e. somebody who found the link in a forwarded mail.
    const second = await context.browser()!.newContext({ baseURL: new URL(page.url()).origin });
    const otherPage = await second.newPage();
    await otherPage.goto(link);

    expect(
      new URL(otherPage.url()).pathname,
      "a second redemption must not land in the application",
    ).toContain("/signin");

    await otherPage.goto("/workspaces");
    await expect(
      otherPage,
      "and it must not have established a session",
    ).toHaveURL(/\/signin\?callbackUrl=/);

    await second.close();
  });

  /**
   * DEFECT THIS CATCHES: **the link outliving the lifetime the product claims for it** —
   * asserted by the clock, which is the only way it can be asserted.
   *
   * This is the assertion the earlier copy-reading version of this test could never make, and
   * it is the one that matters: `lib/auth.ts` sets `maxAge: 15 * 60`, and the bug that
   * prompted all of this was Auth.js hiding the caller's `maxAge` under `options` so the
   * configured value was silently ignored. A test that reads the page's wording cannot tell
   * whether the token honours it. This one advances the browser's clock past the window and
   * redeems the link: if the credential still works, the configured lifetime is a fiction.
   *
   * The clock is moved with CDP rather than by waiting: a test that genuinely slept for
   * fifteen minutes would never be run.
   */
  test("the link is dead once its configured lifetime has passed", async ({ page, context }) => {
    const email = address();

    await page.goto("/signin");
    await page.getByLabel("email", { exact: true }).fill(email);
    await page.getByRole("button", { name: /email a sign-in link/i }).click();

    const link = magicLinkFrom(await waitForMessage(email));
    const origin = new URL(page.url()).origin;

    // A clean context whose clock starts sixteen minutes from now — one minute past the
    // fifteen `lib/auth.ts` configures. The token was minted against the real clock.
    const future = await context.browser()!.newContext({ baseURL: origin });
    await future.clock.setFixedTime(new Date(Date.now() + 16 * 60 * 1000));
    const futurePage = await future.newPage();

    await futurePage.goto(link);
    await futurePage.goto("/workspaces");

    await expect(
      futurePage,
      "the link still worked after its 15-minute lifetime had passed",
    ).toHaveURL(/\/signin\?callbackUrl=/);

    await future.close();
  });
});
