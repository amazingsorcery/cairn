"use server";

import { z } from "zod";

import { ripeStatDriver } from "@/lib/connectors/ripestat";
import { runConnector } from "@/lib/connectors/runtime";
import { toolbenchActor } from "@/lib/connectors/actor";
import { invalidInput, toLookupOutcome } from "@/lib/connectors/toolbench";
import type { IpIntelligence } from "@/lib/toolbench/ip-intel";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { normalisePublicIp } from "@/lib/toolbench/net-target";

/**
 * The IP intelligence lookup.
 *
 * `normalisePublicIp` is the SSRF guard *and* the useful-error path. An address in a private,
 * loopback, link-local, carrier-grade-NAT, documentation or multicast range is refused with a
 * sentence naming the range and why nothing public can answer for it — which is a better
 * result than sending 10.0.0.1 to a routing registry and rendering an empty panel.
 *
 * It also refuses every alternative encoding of an address: `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `127.1`, `::ffff:127.0.0.1`, `2002:7f00:1::1`. Those are filter bypasses
 * rather than things a person types, and the tests in `lib/toolbench/net-target.test.ts`
 * assert each one is refused.
 */

const inputSchema = z.object({ resource: z.string().max(100) });

export async function lookupIp(raw: unknown): Promise<LookupOutcome<IpIntelligence>> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput("Enter an IP address, such as 193.0.6.139.");

  const ip = normalisePublicIp(parsed.data.resource);
  if (!ip.ok) return invalidInput(ip.error);

  const envelope = await runConnector(
    ripeStatDriver,
    { resource: ip.value.address },
    await toolbenchActor(),
  );
  return toLookupOutcome(envelope);
}
