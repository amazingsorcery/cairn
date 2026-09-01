"use server";

import { z } from "zod";

import { crtShDriver } from "@/lib/connectors/crtsh";
import {
  invalidInput,
  runToolConnector,
  toLookupOutcome,
  toolbenchActor,
} from "@/lib/connectors/toolbench";
import type { CertificateSummary } from "@/lib/toolbench/ct";
import type { LookupOutcome } from "@/lib/toolbench/lookup";
import { normaliseHostname } from "@/lib/toolbench/net-target";

/**
 * The certificate transparency lookup.
 *
 * A Server Action rather than a route handler, for three reasons worth stating because a
 * read through a POST is unusual:
 *
 *  1. **The query never becomes a URL.** A `GET /api/ct?domain=…` would put the reader's
 *     domain into a request line, which is the string most likely to end up in an access
 *     log, a proxy log, a referrer or a browser history. Product-brief §3.2 constraint 4 is
 *     about not leaking this audience's interest graph, and the cheapest way to keep a value
 *     out of logs is for it never to be in a URL.
 *  2. **Nothing is cacheable by accident.** No CDN, no browser and no shared cache can hold
 *     a lookup somebody else made.
 *  3. Next's Server Action transport is same-origin and CSRF-protected, which is not nothing
 *     on the one surface of this product that makes outbound requests from user input.
 *
 * VALIDATION HAPPENS TWICE, ON PURPOSE. Here, so the reader gets a sentence naming what is
 * wrong with what they typed; and again inside the driver's `normalise`, which is the last
 * point before a value reaches a query string. "The action already checked it" is exactly
 * the assumption that stops being true after somebody adds a second caller.
 */

const inputSchema = z.object({
  // 253 is the maximum length of a domain name; the slack is so an over-long paste produces
  // the specific "too long" message from `normaliseHostname` rather than a generic one.
  domain: z.string().max(400),
  excludeExpired: z.boolean(),
});

export async function lookupCertificates(raw: unknown): Promise<LookupOutcome<CertificateSummary>> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput("Enter a domain name, such as example.com.");

  const domain = normaliseHostname(parsed.data.domain);
  if (!domain.ok) return invalidInput(domain.error);

  const envelope = await runToolConnector(
    crtShDriver,
    { domain: domain.value, excludeExpired: parsed.data.excludeExpired },
    await toolbenchActor(),
  );
  return toLookupOutcome(envelope);
}
