import { describe, expect, it } from "vitest";

import brand from "@/config/brand";
import { magicLinkEmail } from "./auth-mail";
import { safeRedirect } from "./auth-redirect";

/**
 * The two parts of `lib/auth.ts` that are testable without a database or a mail server, and
 * both are security-relevant: the redirect allow-list and the fact that the magic-link email
 * never hardcodes a brand string.
 */

describe("safeRedirect", () => {
  const base = "https://app.example";

  it("allows a same-origin relative path", () => {
    expect(safeRedirect("/workspaces", base)).toBe("/workspaces");
    expect(safeRedirect("/workspaces?tab=notes#top", base)).toBe("/workspaces?tab=notes#top");
  });

  it("allows a same-origin absolute URL and returns it relative", () => {
    expect(safeRedirect("https://app.example/workspaces/1", base)).toBe("/workspaces/1");
  });

  it("rejects a different origin", () => {
    expect(safeRedirect("https://evil.test/steal", base)).toBe(base);
  });

  it("rejects a protocol-relative URL", () => {
    // The classic bypass: looks relative to a naive `startsWith("/")` check, resolves to
    // another origin in every browser.
    expect(safeRedirect("//evil.test/steal", base)).toBe(base);
    expect(safeRedirect("///evil.test/steal", base)).toBe(base);
  });

  it("rejects backslash variants that browsers normalise to //", () => {
    expect(safeRedirect("/\\evil.test/steal", base)).toBe(base);
    expect(safeRedirect("\\\\evil.test/steal", base)).toBe(base);
    expect(safeRedirect("\\/evil.test/steal", base)).toBe(base);
  });

  it("rejects a leading-whitespace protocol-relative URL", () => {
    expect(safeRedirect("  //evil.test", base)).toBe(base);
    expect(safeRedirect("\t//evil.test", base)).toBe(base);
  });

  it("rejects a host that merely has our origin as a prefix", () => {
    expect(safeRedirect("https://app.example.evil.test/x", base)).toBe(base);
    expect(safeRedirect("https://app.example.evil.test", base)).toBe(base);
  });

  it("rejects a foreign host carrying our origin in the query string", () => {
    expect(safeRedirect("https://evil.test/?next=https://app.example/workspaces", base)).toBe(base);
  });

  it("rejects userinfo tricks", () => {
    expect(safeRedirect("https://app.example@evil.test/x", base)).toBe(base);
  });

  it("rejects a scheme change on the same host", () => {
    // Origin includes the scheme, so http:// against an https:// base is a different origin
    // — which matters behind Caddy, where a downgrade would strip the Secure cookie.
    expect(safeRedirect("http://app.example/workspaces", base)).toBe(base);
  });

  it("rejects non-http schemes", () => {
    expect(safeRedirect("javascript:alert(1)", base)).toBe(base);
    expect(safeRedirect("data:text/html,<script>1</script>", base)).toBe(base);
    expect(safeRedirect("file:///etc/passwd", base)).toBe(base);
  });

  it("rejects unparseable input rather than passing it through", () => {
    expect(safeRedirect("http://[", base)).toBe(base);
    expect(safeRedirect("", base)).toBe("/");
  });

  it("honours a base URL with a port", () => {
    const local = "http://localhost:3000";
    expect(safeRedirect("http://localhost:3000/signin", local)).toBe("/signin");
    expect(safeRedirect("http://localhost:3001/signin", local)).toBe(local);
  });
});

describe("magicLinkEmail", () => {
  const url = "https://app.example/api/auth/callback/nodemailer?token=abc&email=a%40b.test";
  const mail = magicLinkEmail({ url, host: "app.example" });

  it("uses the brand config for every brand string", () => {
    expect(mail.subject).toContain(brand.name);
    expect(mail.text).toContain(brand.name);
    expect(mail.html).toContain(brand.name);
    expect(mail.html).toContain(brand.tagline);
    expect(mail.text).toContain(brand.copyright);
  });

  it("ships a real plain-text alternative containing the link", () => {
    // Terminal mail clients and remote-content-disabled setups are common in this audience;
    // a text part that only says "view in HTML" is a broken sign-in for them.
    expect(mail.text).toContain(url);
    expect(mail.text.length).toBeGreaterThan(200);
    expect(mail.text).not.toContain("<");
  });

  it("puts the link in the HTML as a button and as copyable text", () => {
    expect(mail.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
  });

  it("references no remote asset, so opening the mail is not a tracking event", () => {
    // No <img>, no <link>, no external stylesheet or web font: an image in a sign-in email
    // reports when and roughly where the recipient opened it.
    expect(mail.html).not.toMatch(/<img/i);
    expect(mail.html).not.toMatch(/<link/i);
    expect(mail.html).not.toMatch(/https?:\/\/(?!app\.example)/);
  });

  it("escapes the URL so a crafted callback cannot inject markup", () => {
    const crafted = magicLinkEmail({
      url: 'https://app.example/cb?t="><script>alert(1)</script>',
      host: "app.example",
    });
    expect(crafted.html).not.toContain("<script>");
    expect(crafted.html).toContain("&lt;script&gt;");
  });

  it("states the single-use and expiry properties in both parts", () => {
    expect(mail.text).toMatch(/works once/i);
    expect(mail.html).toMatch(/works once/i);
  });
});
