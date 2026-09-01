import { z } from "zod";

import { defineEmergencyCity, type EmergencyFeature } from "./emergency/socrata";
import type { SourceAdapter } from "./types";

/**
 * San Francisco Police real-time dispatched calls for service (ADR 0033).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY POLICE, NOT FIRE, FOR SAN FRANCISCO
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR 0033 names San Francisco, and the binding rule is **live-only**. SF's *fire/EMS*
 * dataset (nuek-vuh3) publishes **daily** with a multi-hour lag — it is a historical extract,
 * not a live board, and putting it on a live map as "live" would be a false claim about a
 * timestamp. SF's genuinely live dispatch is its **Law Enforcement Dispatched Calls for
 * Service: Real-Time** (gnap-fj3t), published "Multiple times per hour". So San Francisco's
 * live layer is police CAD, which ADR 0033 covers ("US municipal open-data CAD/911"), and the
 * fire dataset is recorded as rejected-for-live in `docs/sources/sf-police-911.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-09-01. Full record in `docs/sources/sf-police-911.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Operator     City & County of San Francisco / SFPD, via data.sfgov.org (Socrata).
 * Licence      Open Data Commons Public Domain Dedication and License (PDDL 1.0), declared in
 *              the dataset metadata. No key gate on the data.
 * Attribution  Rendered anyway: "San Francisco Police real-time dispatch (DataSF, PDDL)".
 * Key          None required. OPTIONAL Socrata `X-App-Token` raises the throttle; the layer
 *              boots without it.
 * Rate limit   Socrata per-IP throttle without a token; unthrottled reasonable use with one.
 *              We poll once per TTL from the worker.
 * Access ctrl  None circumvented: a documented public SODA endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PUBLISHER ALREADY REDACTS SENSITIVE CALLS — WE HONOUR IT, NEVER UNDO IT
 * ─────────────────────────────────────────────────────────────────────────────
 * SFPD sets `sensitive_call = true` on calls it judges sensitive and WITHHOLDS their
 * location. On a live fetch (2026-09-01), 52 of 150 rows were sensitive and carried no
 * `intersection_point`. This adapter DROPS every `sensitive_call` row outright — it does not
 * attempt to place it, and it performs no identity resolution to recover what the operator
 * withheld (ADR 0033). What the operator hid stays hidden.
 *
 * MEDICAL. Police CAD includes health/behavioural-health calls — welfare checks, "person
 * down", overdoses, 5150 (involuntary psychiatric hold). The classifier catches these and
 * marks them `isMedical`, so the UI keeps them OFF by default exactly as it does Seattle's
 * medic responses. Never dropped, never shown by default.
 */

const SF_POLICE_911_SLUG = "sf-police-911";

/**
 * The SODA endpoint, a module constant. The 500 most recent calls by receive time — a live
 * snapshot. `$order`/`$limit` are ours; nothing from a request is interpolated.
 */
const RESOURCE_URL =
  "https://data.sfgov.org/resource/gnap-fj3t.json?$order=received_datetime%20DESC&$limit=500";

/** SF serves `intersection_point` as GeoJSON with numeric coordinates. */
const pointSchema = z
  .object({
    type: z.literal("Point"),
    coordinates: z.array(z.number()),
  })
  .nullish();

/**
 * One dispatched call. `.passthrough()` so an added column cannot break us. `sensitive_call`
 * is required — it is the flag we drop on, and defaulting a missing one to `false` would
 * start plotting calls the operator may have meant to withhold.
 */
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
  /** 120s: the data changes "multiple times per hour", so two minutes loses nothing. */
  ttlSeconds: 120,
  /** Ten minutes stale, then unavailable — a live dispatch board must not freeze silently. */
  staleWhileRevalidateSeconds: 600,
  rowSchema: sfRowSchema,
  toRecord: (row) => {
    // The operator withheld this call's location deliberately. Drop it; do not reconstruct.
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
