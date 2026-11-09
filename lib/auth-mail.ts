import brand from "@/config/brand";

/* ------------------------------------------------------------------ *
 * The magic-link email
 * ------------------------------------------------------------------ */

/**
 * Brand strings come from `config/brand.ts`. Sends a full plain-text part for text-only
 * clients. The HTML has inline styles and no remote assets, so opening it reveals nothing.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function magicLinkEmail(params: { url: string; host: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const { url, host } = params;
  const safeUrl = escapeHtml(url);
  const safeHost = escapeHtml(host);

  const subject = `Sign in to ${brand.name}`;

  const text = [
    `Sign in to ${brand.name}`,
    "",
    `Open this link to sign in at ${host}:`,
    url,
    "",
    "The link works once and expires in 24 hours.",
    "",
    `If you did not ask to sign in to ${brand.name}, no account action has been taken and`,
    "you can ignore this message. Do not forward this email: anyone holding the link can",
    "sign in as you.",
    "",
    brand.copyright,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#0b0d10;color:#e6e8eb;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;">
      <tr>
        <td style="padding-bottom:8px;font-size:20px;font-weight:600;">${escapeHtml(brand.name)}</td>
      </tr>
      <tr>
        <td style="padding-bottom:24px;color:#9aa4b2;font-size:14px;">${escapeHtml(brand.tagline)}</td>
      </tr>
      <tr>
        <td style="padding-bottom:16px;">Open the link below to sign in at <strong>${safeHost}</strong>.</td>
      </tr>
      <tr>
        <td style="padding-bottom:24px;">
          <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#e6e8eb;color:#0b0d10;text-decoration:none;border-radius:6px;font-weight:600;">Sign in</a>
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:24px;color:#9aa4b2;font-size:14px;word-break:break-all;">
          If the button does not work, paste this into your browser:<br />${safeUrl}
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:16px;color:#9aa4b2;font-size:14px;">
          The link works once and expires in 24 hours.
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:24px;color:#9aa4b2;font-size:14px;">
          If you did not ask to sign in to ${escapeHtml(brand.name)}, no account action has been
          taken and you can ignore this message. Do not forward this email: anyone holding the
          link can sign in as you.
        </td>
      </tr>
      <tr>
        <td style="border-top:1px solid #23262b;padding-top:16px;color:#6b7280;font-size:12px;">
          ${escapeHtml(brand.copyright)}
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
