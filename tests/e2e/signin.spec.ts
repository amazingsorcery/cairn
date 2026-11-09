import { expect, test } from "@playwright/test";

import { databaseAvailable, expireVerificationToken } from "./helpers/db";
import { clearMailbox, magicLinkFrom, mailboxAvailable, waitForMessage } from "./helpers/mail";

/**
 * Magic-link sign-in end to end: request a link, read it from a real inbox, follow it, and use
 * the session.
 *
 * Needs a server started with SMTP_HOST, SMTP_PORT and SMTP_FROM, and a mailbox on
 * 127.0.0.1:8025 (Mailpit, or `node tests/e2e/helpers/smtp-sink.mjs`). Tests skip otherwise.
 *
 * Serial, because all tests share one inbox.
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

    // The link must point at this app's host.
    expect(new URL(link).host).toBe(new URL(page.url()).host);

    await page.goto(link);

    // Signed in: a session-gated route renders instead of redirecting to /signin.
    await page.goto("/workspaces");
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole("heading", { level: 1, name: /your cases/i })).toBeVisible();
  });

  /**
   * Links are single-use. Auth.js reports "expired" and "already used" the same way
   * (`error=Verification`), so this asserts the second use creates no session.
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
   * The link expires after `maxAge` (15 min in `lib/auth.ts`). Expiry is checked server-side,
   * so the token is aged in the database rather than moving the browser clock.
   */
  test("the link is dead once its configured lifetime has passed", async ({ page, context }) => {
    test.skip(!databaseAvailable(), "DATABASE_URL is not set; the token cannot be aged");

    const email = address();

    await page.goto("/signin");
    await page.getByLabel("email", { exact: true }).fill(email);
    await page.getByRole("button", { name: /email a sign-in link/i }).click();

    const link = magicLinkFrom(await waitForMessage(email));
    const origin = new URL(page.url()).origin;

    const aged = await expireVerificationToken(email);
    expect(aged, "no verification token was found to age — the test proved nothing").toBe(1);

    // A clean browser, i.e. somebody opening the link for the first time, too late.
    const late = await context.browser()!.newContext({ baseURL: origin });
    const latePage = await late.newPage();

    await latePage.goto(link);
    await latePage.goto("/workspaces");

    await expect(
      latePage,
      "the link still worked after its lifetime had passed",
    ).toHaveURL(/[/]signin[?]callbackUrl=/);

    await late.close();
  });
});

test.describe("magic-link sign-in — the surrounding surface", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ isMobile }) => isMobile === true, "one engine is enough for a credential path");

  test.beforeEach(async () => {
    test.skip(
      !(await mailboxAvailable()),
      "no mailbox on 127.0.0.1:8025 — start Mailpit or `node tests/e2e/helpers/smtp-sink.mjs`",
    );
    await clearMailbox();
  });

  /**
   * `/signin/check-email` reads the address from an httpOnly cookie, so it never lands in
   * browser history or access logs.
   */
  test("the address is carried in an httpOnly cookie, never in the URL", async ({
    page,
    context,
  }) => {
    const email = address();

    await page.goto("/signin");
    await page.getByLabel("email", { exact: true }).fill(email);
    await page.getByRole("button", { name: /email a sign-in link/i }).click();

    await expect(page).toHaveURL(/\/signin\/check-email/);
    expect(page.url(), "the address must not be in the address bar").not.toContain(email);
    expect(page.url()).not.toMatch(/address=|email=/);

    // The page still knows it, from the cookie.
    await expect(page.getByText(email)).toBeVisible();

    const cookie = (await context.cookies()).find((one) => one.name === "signin-address");
    expect(cookie, "no signin-address cookie was set").toBeDefined();
    expect(cookie?.httpOnly, "the address cookie must be httpOnly").toBe(true);
  });

  /**
   * Sending is limited (5 per 15 minutes), and the refusal must not reveal whether the
   * address is known. Last in the file because it exhausts the window.
   */
  test("sending is rate limited, and the refusal enumerates nothing", async ({ page }) => {
    const limited = page.getByText("Too many sign-in links requested");

    // Same address each time: the limiter is keyed on the recipient, not the client.
    const target = address();

    // Eight attempts is enough to pass a limit of 5 from anywhere in the window.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await limited.isVisible().catch(() => false)) break;
      await page.goto("/signin");
      await page.getByLabel("email", { exact: true }).fill(target);
      await page.getByRole("button", { name: /email a sign-in link/i }).click();
      await page.waitForLoadState("load");
    }

    await expect(limited, "the sender was never refused").toBeVisible();
    await expect(page.getByText(/Wait \d+ minutes? before asking for another/)).toBeVisible();

    const body = await page.locator("main").innerText();
    expect(
      /no account|not registered|unknown address|doesn't exist|does not exist/i.test(body),
      "the refusal must not reveal whether the address is known to us",
    ).toBe(false);
  });
});
