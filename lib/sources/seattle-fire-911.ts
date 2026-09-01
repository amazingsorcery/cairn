import { z } from "zod";

import { defineEmergencyCity, type EmergencyFeature } from "./emergency/socrata";
import type { SourceAdapter } from "./types";

/**
 * Seattle Fire Department real-time 911 dispatch — the reference live emergency feed (ADR 0033).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-09-01. Full record in `docs/sources/seattle-fire-911.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Operator     City of Seattle / Seattle Fire Department, via data.seattle.gov (Socrata).
 * Dataset      "Seattle Real Time Fire 911 Calls" (kzjm-xkqj). Refresh frequency published
 *              on the dataset itself as **"Near Realtime"**, and a live fetch on 2026-09-01
 *              returned dispatches timestamped minutes earlier.
 * Licence      Public Domain (declared in the dataset metadata: `license.name = "Public
 *              Domain"`, attribution "City of Seattle"). No key gate on the data.
 * Attribution  Rendered anyway: "Seattle Fire Department real-time 911 (City of Seattle)".
 * Key          None required. An OPTIONAL Socrata `X-App-Token` raises the throttle; the
 *              layer boots without it, so it is not an `apiKeyEnvVar`.
 * Rate limit   Socrata throttles per IP without a token and does not throttle reasonable use
 *              with one. We poll once per TTL from the worker — far inside either limit.
 * Access ctrl  None circumvented: a documented public SODA endpoint, no auth, no scraping.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MEDICAL IS THE POINT. Seattle Fire is overwhelmingly medical — "Aid Response" and "Medic
 * Response" are the two largest call types by a wide margin. Every feature carries
 * `properties.category` and `properties.isMedical`, classified from the `type` string by
 * `emergency/incident-type.ts`, so the UI can keep medical OFF by default (ADR 0033). Medical
 * calls are never dropped and never shown by default.
 *
 * NOTHING PERSISTED, NO IDENTITY RESOLUTION. The adapter returns features and stops; the row
 * the operator published is mapped to a point and nothing is cross-referenced (ADR 0033).
 */

const SEATTLE_FIRE_911_SLUG = "seattle-fire-911";

/**
 * The SODA endpoint, a module constant. The 500 most recent dispatches by time — a live
 * snapshot, not the full history — ordered so a quiet night still shows the latest calls.
 * `$order`/`$limit` are ours; nothing from a request is interpolated (ADR 0019's top risk).
 */
const RESOURCE_URL =
  "https://data.seattle.gov/resource/kzjm-xkqj.json?$order=datetime%20DESC&$limit=500";

/**
 * A coordinate that SODA serves as a STRING (`"47.60975"`). Tolerant of one bad value (→
 * `null`, and the row is dropped for want of a position) but the KEY must be present — a
 * payload whose shape lost `latitude` fails the parse and degrades honestly, rather than
 * mapping every dispatch to null island.
 */
const numericString = z.string().transform((value) => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
});

/**
 * One dispatch row. `.passthrough()` so an added upstream column cannot break us — only a
 * removed or retyped one we actually read. `type` and the coordinates are required; the rest
 * are nullish, because a real payload omits `incident_number` on the occasional row.
 */
const seattleRowSchema = z
  .object({
    type: z.string(),
    latitude: numericString,
    longitude: numericString,
    address: z.string().nullish(),
    datetime: z.string().nullish(),
    incident_number: z.string().nullish(),
  })
  .passthrough();

const city = defineEmergencyCity({
  slug: SEATTLE_FIRE_911_SLUG,
  name: "Seattle Fire 911 dispatch",
  homepage: "https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj",
  agency: "Seattle Fire Department",
  city: "Seattle, WA",
  attribution: {
    text: "Seattle Fire Department real-time 911 (City of Seattle)",
    href: "https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj",
    licence: "Public Domain (City of Seattle open data)",
  },
  resourceUrl: RESOURCE_URL,
  /**
   * 60 seconds. The dataset is "Near Realtime" and dispatches arrive continuously; a minute
   * matches the cadence without hammering Socrata. Far inside the anonymous throttle at one
   * poll per minute from the worker.
   */
  ttlSeconds: 60,
  /**
   * Ten minutes. A live dispatch board ages fast — an incident twenty minutes stale is no
   * longer "live" in any useful sense — so the stale window is short, and after it the layer
   * says it is unavailable rather than showing a frozen board.
   */
  staleWhileRevalidateSeconds: 600,
  rowSchema: seattleRowSchema,
  toRecord: (row) => {
    const latitude = row.latitude;
    const longitude = row.longitude;
    if (latitude === null || longitude === null) return null;
    return {
      // The incident number is unique and stable across polls; it is the natural id. A row
      // without one (rare) falls back to a time-and-place key, still stable for that call.
      id: row.incident_number ?? `${latitude.toFixed(5)},${longitude.toFixed(5)}@${row.datetime ?? "?"}`,
      incidentType: row.type,
      latitude,
      longitude,
      incidentNumber: row.incident_number ?? null,
      address: row.address ?? null,
      // Seattle publishes no priority or disposition on this feed.
      priority: null,
      // The operator's local timestamp, verbatim — it carries no timezone offset and is not
      // ours to reinterpret as UTC. `docs/sources/seattle-fire-911.md` records that it is
      // agency-local (Pacific).
      dispatchedAt: row.datetime ?? null,
      disposition: null,
    };
  },
});

export const seattleFire911: SourceAdapter<EmergencyFeature> = city.adapter;
export const seattleFire911ResponseSchema = city.responseSchema;
export const normaliseSeattleFire911 = city.normalise;
export { SEATTLE_FIRE_911_SLUG };
