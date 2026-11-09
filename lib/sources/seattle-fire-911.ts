import { z } from "zod";

import { defineEmergencyCity, type EmergencyFeature } from "./emergency/socrata";
import type { SourceAdapter } from "./types";

/**
 * Seattle Fire Department real-time 911 dispatch.
 *
 * Terms (checked 2026-09-01):
 * Dataset      "Seattle Real Time Fire 911 Calls" (kzjm-xkqj) on data.seattle.gov,
 *              "Near Realtime".
 * Licence      Public Domain (dataset metadata), attribution "City of Seattle".
 * Key          None. Optional Socrata `X-App-Token` raises the throttle.
 * Rate limit   Per-IP throttle without a token; one poll per TTL is far inside it.
 *
 * Mostly medical calls ("Aid Response", "Medic Response"); `isMedical` lets the UI hide them
 * by default. Nothing persisted, no identity resolution.
 */

const SEATTLE_FIRE_911_SLUG = "seattle-fire-911";

/** The 500 most recent dispatches. Constant URL; nothing from a request is interpolated. */
const RESOURCE_URL =
  "https://data.seattle.gov/resource/kzjm-xkqj.json?$order=datetime%20DESC&$limit=500";

/**
 * SODA serves coordinates as strings. A bad value becomes `null` (row dropped); a missing key
 * fails the parse.
 */
const numericString = z.string().transform((value) => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
});

/** One dispatch row. `type` and coordinates required; real rows occasionally lack `incident_number`. */
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
  /** Matches the near-realtime cadence. */
  ttlSeconds: 60,
  /** Short: a dispatch board ages fast. */
  staleWhileRevalidateSeconds: 600,
  rowSchema: seattleRowSchema,
  toRecord: (row) => {
    const latitude = row.latitude;
    const longitude = row.longitude;
    if (latitude === null || longitude === null) return null;
    return {
      // Incident number, else a stable time-and-place key.
      id: row.incident_number ?? `${latitude.toFixed(5)},${longitude.toFixed(5)}@${row.datetime ?? "?"}`,
      incidentType: row.type,
      latitude,
      longitude,
      incidentNumber: row.incident_number ?? null,
      address: row.address ?? null,
      // Seattle publishes no priority or disposition on this feed.
      priority: null,
      // Verbatim agency-local (Pacific) time with no offset; not reinterpreted as UTC.
      dispatchedAt: row.datetime ?? null,
      disposition: null,
    };
  },
});

export const seattleFire911: SourceAdapter<EmergencyFeature> = city.adapter;
export const seattleFire911ResponseSchema = city.responseSchema;
export const normaliseSeattleFire911 = city.normalise;
export { SEATTLE_FIRE_911_SLUG };
