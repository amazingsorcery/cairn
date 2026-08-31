import pino from "pino";
import { env } from "./env";

/**
 * Structured JSON logging.
 *
 * One line per event, JSON in production so the Docker json-file driver and any later log
 * shipper can parse it without a regex. Pretty-printing is deliberately NOT enabled in
 * production: it costs CPU on a 2 GB box and breaks machine parsing.
 *
 * Redaction is allow-list-hostile by design — anything that looks like a credential is
 * removed before serialisation. Never log a session token, a magic-link token, an
 * AUTH_SECRET, or a full email address.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "web" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "sessionToken",
      "*.sessionToken",
      "authorization",
      "*.authorization",
      "cookie",
      "*.cookie",
      "req.headers.cookie",
      "req.headers.authorization",
      "DATABASE_URL",
      "AUTH_SECRET",
      "SMTP_PASSWORD",
      "AUTH_GITHUB_SECRET",
    ],
    censor: "[redacted]",
  },
});

/**
 * Reduce an email address to something safe to log: enough to correlate two events from
 * the same account, not enough to identify the person if the logs leak. Journalists and
 * human-rights researchers are the audience — their address in a log line is a real risk.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "[invalid-email]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** A child logger tagged with a request or action name, for correlating a unit of work. */
export function scoped(scope: string, extra?: Record<string, unknown>) {
  return logger.child({ scope, ...extra });
}
