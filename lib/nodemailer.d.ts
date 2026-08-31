/**
 * Minimal ambient types for `nodemailer`.
 *
 * WHY THIS FILE EXISTS: `nodemailer` ships no types of its own and `@types/nodemailer` is
 * not in `package.json`. Without a declaration, `import { createTransport } from
 * "nodemailer"` is an implicit `any`, which this codebase forbids (product-brief §8).
 *
 * This declares only the slice `lib/auth.ts` actually uses, typed honestly — no `any`, no
 * `@ts-ignore`. It is deliberately narrow so it cannot quietly diverge from the real API in
 * code we do not write.
 *
 * DELETE THIS FILE when `@types/nodemailer` is added to devDependencies. Keeping both would
 * be a duplicate-declaration conflict. The backend handoff records the request.
 *
 * `@auth/core/providers/nodemailer` also imports types from this module, but `skipLibCheck`
 * is on, so its own `.d.ts` is not checked against this declaration.
 */
declare module "nodemailer" {
  export interface SentMessageInfo {
    messageId: string;
    accepted: Array<string | { address: string }>;
    rejected: Array<string | { address: string }>;
    pending: Array<string | { address: string }>;
    response: string;
  }

  export interface SendMailOptions {
    to?: string | undefined;
    from?: string | undefined;
    subject?: string | undefined;
    text?: string | undefined;
    html?: string | undefined;
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
    close(): void;
  }

  /**
   * The real signature accepts a connection URL or one of a dozen transport option shapes.
   * `unknown` is correct here rather than lax: the value we pass comes from
   * `NodemailerConfig["server"]`, which `@auth/core` has already typed at its own boundary.
   */
  export function createTransport(transport?: unknown, defaults?: unknown): Transporter;

  /** Referenced by `@auth/core`'s own declarations; unused by this codebase. */
  export interface Transport<T = unknown> {
    name?: string;
    version?: string;
    send?: T;
  }
  export interface TransportOptions {
    [key: string]: unknown;
  }
}
