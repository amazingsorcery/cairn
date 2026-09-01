"use server";

import { z } from "zod";

import { dnsDriver } from "@/lib/connectors/dns";
import { runConnector } from "@/lib/connectors/runtime";
import { toolbenchActor } from "@/lib/connectors/actor";
import { invalidInput, toLookupOutcome } from "@/lib/connectors/toolbench";
import type { DnsLookup } from "@/lib/toolbench/dns";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { normaliseHostname } from "@/lib/toolbench/net-target";

/**
 * The DNS lookup.
 *
 * A Server Action rather than a GET route so the name being resolved never appears in a URL,
 * a browser history, a referrer or an access log. See the note in the certificate
 * transparency action for the full argument; it applies identically here and matters slightly
 * more, because "which domains did this person resolve" is close to a reading list.
 *
 * WHAT LEAVES, AND WHAT DOES NOT. The name reaches Cloudflare's resolver. The reader's IP
 * does not — the query is made from this server. Nothing about either is written to our audit
 * log, which records only that a call happened and how it ended (ADR 0013).
 */

const inputSchema = z.object({ name: z.string().max(400) });

export async function lookupDns(raw: unknown): Promise<LookupOutcome<DnsLookup>> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput("Enter a domain name, such as example.com.");

  const name = normaliseHostname(parsed.data.name);
  if (!name.ok) return invalidInput(name.error);

  const envelope = await runConnector(dnsDriver, { name: name.value }, await toolbenchActor());
  return toLookupOutcome(envelope);
}
