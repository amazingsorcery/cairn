"use server";

import { z } from "zod";

import { runConnector } from "@/lib/connectors/runtime";
import { toolbenchActor } from "@/lib/connectors/actor";
import { invalidInput, toLookupOutcome } from "@/lib/connectors/toolbench";
import { waybackCapturesDriver, waybackTimelineDriver, type CapturePair } from "@/lib/connectors/wayback";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { normaliseLookupUrl } from "@/lib/toolbench/net-target";
import { parseWaybackTimestamp, type Timeline } from "@/lib/toolbench/wayback";

/**
 * The two Wayback lookups.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE HIGHEST-RISK INPUT IN THE PRODUCT, AND IT IS WORTH BEING EXPLICIT
 * ─────────────────────────────────────────────────────────────────────────────
 * `fetchCaptures` is the only place in the Toolbench where a value the reader supplied
 * influences the *path* of an outbound request. Everywhere else the user's value goes into a
 * query parameter of a URL whose host and path we built. Five things stand between that and a
 * server-side request forgery, and none of them is a blocklist of bad strings:
 *
 *  1. The host is the constant `web.archive.org`. It is not read from user input and it is
 *     not read from the registry row either — `lib/toolbench/wayback.ts` holds it as
 *     `WAYBACK_HOST` and `snapshotUrl` refuses to return a URL on any other host.
 *  2. The timestamps must be exactly fourteen digits AND round-trip through a real calendar
 *     date, so `20261301000000` is refused rather than silently rolling into 2027.
 *  3. The URL is normalised by `normaliseLookupUrl`, which refuses a non-http(s) scheme,
 *     credentials before the host, an explicit port, and every private, loopback, link-local,
 *     carrier-grade-NAT, unique-local, documentation, multicast and cloud-metadata address in
 *     both IP versions — including the alternative encodings (`2130706433`, `0x7f000001`,
 *     `127.1`, `::ffff:127.0.0.1`, `2002:7f00:1::1`) that defeat naive filters.
 *  4. `upstreamGet` uses `redirect: "manual"` and re-checks the pinned host on every hop. The
 *     archive genuinely redirects between capture timestamps, so redirects cannot simply be
 *     banned; they are walked with the pin re-applied, at most three times.
 *  5. The response is never rendered as HTML. It is reduced to text server-side and diffed.
 *
 * `lib/toolbench/net-target.test.ts` and `lib/toolbench/wayback.test.ts` assert each of these
 * as refusals, case by case, because QA will attack this first.
 */

const timelineInput = z.object({ url: z.string().max(2100) });

export async function lookupTimeline(raw: unknown): Promise<LookupOutcome<Timeline>> {
  const parsed = timelineInput.safeParse(raw);
  if (!parsed.success) return invalidInput("Enter a URL, such as example.com/news.");

  const url = normaliseLookupUrl(parsed.data.url);
  if (!url.ok) return invalidInput(url.error);

  const envelope = await runConnector(
    waybackTimelineDriver,
    { url: url.value.href },
    await toolbenchActor(),
  );
  return toLookupOutcome(envelope);
}

const capturesInput = z.object({
  url: z.string().max(2100),
  before: z.string().max(20),
  after: z.string().max(20),
});

export async function fetchCaptures(raw: unknown): Promise<LookupOutcome<CapturePair>> {
  const parsed = capturesInput.safeParse(raw);
  if (!parsed.success) return invalidInput("Choose two captures to compare.");

  const url = normaliseLookupUrl(parsed.data.url);
  if (!url.ok) return invalidInput(url.error);

  if (
    parseWaybackTimestamp(parsed.data.before) === null ||
    parseWaybackTimestamp(parsed.data.after) === null
  ) {
    return invalidInput(
      "A capture is identified by a fourteen-digit timestamp, YYYYMMDDhhmmss. Pick two from the timeline above.",
    );
  }
  if (parsed.data.before === parsed.data.after) {
    return invalidInput("Those are the same capture. Pick two different ones.");
  }

  const envelope = await runConnector(
    waybackCapturesDriver,
    { url: url.value.href, before: parsed.data.before, after: parsed.data.after },
    await toolbenchActor(),
  );
  return toLookupOutcome(envelope);
}
