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
 * DNS lookup. A Server Action rather than a GET route so the name never lands in a URL,
 * history, referrer or access log.
 *
 * The name reaches Cloudflare's resolver; the reader's IP doesn't. The audit log records only
 * that a call happened and how it ended.
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
