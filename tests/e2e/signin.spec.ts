import { expect, test } from "@playwright/test";

import { databaseAvailable, expireVerificationToken } from "./helpers/db";
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
   * DEFECT THIS CATCHES: **a magic link that outlives the lifetime the product claims for it.**
   *
   * This is the assertion the copy-reading version of this test could never make. `lib/auth.ts`
   * sets `maxAge: 15 * 60`, and the bug that prompted all of this was Auth.js hiding the
   * caller's `maxAge` under `options` so the configured value was silently ignored while the
   * page cheerfully stated it. Reading the page cannot tell you whether the token honours it.
   *
   * HOW IT IS DONE, AND WHY NOT THE OBVIOUS WAY. The first version of this test moved the
   * *browser's* clock past the window and redeemed the link. It failed — and the test was
   * wrong, not the product: expiry is checked on the **server**, against the server's clock
   * and the `expires` column, so the browser's idea of the time is irrelevant. That version
   * would have reported a false finding on a system behaving correctly, which is worse than
   * no test.
   *
   * So the token is aged in the database instead. That reaches the real code path — the
   * server comparing `expires` against `now()` — without waiting fifteen real minutes, and it
   * fails loudly if there was no token to age rather than passing because the link happened
   * not to work.
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
   * DEFECT THIS CATCHES: the address reaching a URL.
   *
   * `/signin/check-email` names the address it just wrote to, and it reads it from an
   * **httpOnly cookie** rather than `?address=…` precisely so it never enters browser history
   * or any access log between the reader and us. `HANDOFF-workspaces.md` §8.2 puts that in
   * the same class as writing a case note to `localStorage`, which `states.md` §7.4 rules out
   * by name: on a shared machine both leak who was investigating what.
   *
   * `?address=` would render an identical-looking page, which is exactly why this is a test.
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
   * DEFECT THIS CATCHES: an unmetered mail sender. Each request sends an email, so an open
   * form is an open relay — it burns the sending domain's reputation and makes the product a
   * tool for mailbombing a third party. `RATE_LIMIT_POLICIES["signin-email"]` is 5 per 15
   * minutes; this drives past it and asserts the refusal is stated.
   *
   * It also checks what the refusal does NOT say. The copy must not confirm whether the
   * address is one we know: a rate-limit message that reads differently for a registered and
   * an unregistered address is an account-enumeration oracle on the one page that is
   * reachable without a session.
   *
   * LAST IN THE FILE, deliberately. It exhausts a window keyed on this client, so anything
   * after it would be refused for reasons of its own.
   */
  test("sending is rate limited, and the refusal enumerates nothing", async ({ page }) => {
    const limited = page.getByText("Too many sign-in links requested");

    /*
     * THE SAME ADDRESS EVERY TIME. `consumeSafely("signin-email", address)` in `lib/auth.ts`
     * keys the limiter on the **recipient**, not on the client — so a loop using a fresh
     * address each time never accumulates and the limiter never fires. Writing it the other
     * way first is how that was established, and it is worth knowing before changing this.
     */
    const target = address();

    // Bounded: the policy is 5 per 15 minutes, so eight attempts reaches it from any starting
    // point inside the window.
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
