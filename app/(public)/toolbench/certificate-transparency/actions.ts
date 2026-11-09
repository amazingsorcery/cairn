"use server";

import { z } from "zod";

import { crtShDriver } from "@/lib/connectors/crtsh";
import { runConnector } from "@/lib/connectors/runtime";
import { toolbenchActor } from "@/lib/connectors/actor";
import { invalidInput, toLookupOutcome } from "@/lib/connectors/toolbench";
import type { CertificateSummary } from "@/lib/toolbench/ct";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { normaliseHostname } from "@/lib/toolbench/net-target";

/**
 * Certificate transparency lookup. A Server Action rather than a GET route so the queried
 * domain never lands in a URL (access logs, referrers, history), nothing gets cached, and
 * the transport is same-origin and CSRF-protected.
 *
 * Input is validated here for a friendly message and again in the driver's `normalise`,
 * in case another caller is added.
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

  const envelope = await runConnector(
    crtShDriver,
    { domain: domain.value, excludeExpired: parsed.data.excludeExpired },
    await toolbenchActor(),
  );
  return toLookupOutcome(envelope);
}
