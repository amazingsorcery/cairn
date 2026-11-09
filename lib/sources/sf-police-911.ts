import { z } from "zod";

import { defineEmergencyCity, type EmergencyFeature } from "./emergency/socrata";
import type { SourceAdapter } from "./types";

/**
 * San Francisco Police real-time dispatched calls for service.
 *
 * Police rather than fire: SF's fire/EMS dataset (nuek-vuh3) is published daily with hours of
 * lag, so it isn't live. The police dataset (gnap-fj3t) updates multiple times per hour.
 *
 * Terms (checked 2026-09-01):
 * Licence      ODC PDDL 1.0 (dataset metadata). No key gate.
 * Key          None. Optional Socrata `X-App-Token` raises the throttle.
 * Rate limit   Per-IP throttle without a token; one poll per TTL.
 *
 * SFPD flags `sensitive_call` rows and withholds their location (52 of 150 in one fetch).
 * Those rows are dropped; nothing is reconstructed.
 *
 * Health/behavioural-health calls (welfare checks, overdoses, 5150) are marked `isMedical`
 * and hidden by default.
 */

const SF_POLICE_911_SLUG = "sf-police-911";

/** The 500 most recent calls. Constant URL; nothing from a request is interpolated. */
const RESOURCE_URL =
  "https://data.sfgov.org/resource/gnap-fj3t.json?$order=received_datetime%20DESC&$limit=500";

/** SF serves `intersection_point` as GeoJSON with numeric coordinates. */
const pointSchema = z
  .object({
    type: z.literal("Point"),
    coordinates: z.array(z.number()),
  })
  .nullish();

/** One call. `sensitive_call` is required: defaulting it to false could plot withheld calls. */
const sfRowSchema = z
  .object({
    id: z.string(),
    sensitive_call: z.boolean(),
    call_type_final_desc: z.string().nullish(),
    call_type_original_desc: z.string().nullish(),
    cad_number: z.string().nullish(),
    received_datetime: z.string().nullish(),
    priority_final: z.string().nullish(),
    disposition: z.string().nullish(),
    intersection_name: z.string().nullish(),
    intersection_point: pointSchema,
  })
  .passthrough();

const city = defineEmergencyCity({
  slug: SF_POLICE_911_SLUG,
  name: "San Francisco Police 911 dispatch",
  homepage:
    "https://data.sfgov.org/Public-Safety/Law-Enforcement-Dispatched-Calls-for-Service-Real-T/gnap-fj3t",
  agency: "San Francisco Police Department",
  city: "San Francisco, CA",
  attribution: {
    text: "San Francisco Police real-time dispatch (DataSF, PDDL)",
    href: "https://data.sfgov.org/Public-Safety/Law-Enforcement-Dispatched-Calls-for-Service-Real-T/gnap-fj3t",
    licence: "ODC Public Domain Dedication and License (PDDL) 1.0",
  },
  resourceUrl: RESOURCE_URL,
  /** Data updates multiple times per hour. */
  ttlSeconds: 120,
  /** Then unavailable, rather than a frozen board. */
  staleWhileRevalidateSeconds: 600,
  rowSchema: sfRowSchema,
  toRecord: (row) => {
    // Location withheld by the operator: drop.
    if (row.sensitive_call) return null;

    const coordinates = row.intersection_point?.coordinates ?? [];
    const longitude = coordinates[0];
    const latitude = coordinates[1];
    if (typeof longitude !== "number" || typeof latitude !== "number") return null;

    const incidentType = row.call_type_final_desc ?? row.call_type_original_desc ?? "";
    if (incidentType.trim() === "") return null;

    return {
      id: row.id,
      incidentType,
      latitude,
      longitude,
      incidentNumber: row.cad_number ?? null,
      address: row.intersection_name ?? null,
      priority: row.priority_final ?? null,
      dispatchedAt: row.received_datetime ?? null,
      disposition: row.disposition ?? null,
    };
  },
});

export const sfPolice911: SourceAdapter<EmergencyFeature> = city.adapter;
export const sfPolice911ResponseSchema = city.responseSchema;
export const normaliseSfPolice911 = city.normalise;
export { SF_POLICE_911_SLUG };
