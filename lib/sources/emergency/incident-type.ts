/**
 * Classify an emergency-dispatch call type, mainly to decide whether it's medical. Medical
 * calls are health information about a person at an address, so the UI hides them by default.
 * One classifier for all operators, tested against their real call types (captured 2026-09-01).
 *
 *   1. Never miss a medical call: medical is checked first with a wide net, so "Automatic
 *      Medical Alarm" is medical, not fire. A false positive only hides a call by default.
 *   2. Never guess: unreadable internal codes (e.g. Seattle's "1RED 1 Unit") become `other`,
 *      which is shown by default. Known limitation.
 *
 * Pure string matching; no identity resolution.
 */

/** Coarse incident category. `medical` defaults off in the UI; the rest are shown. */
export const INCIDENT_CATEGORIES = [
  "medical",
  "fire",
  "hazmat",
  "rescue",
  "road",
  "publicOrder",
  "other",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** The classifier's answer: a category, and the one flag the UI reads before showing a call. */
export interface IncidentClassification {
  readonly category: IncidentCategory;
  /** True iff `category === "medical"`; its own field so callers don't re-derive it. */
  readonly isMedical: boolean;
}

/**
 * Ordered rules; first match wins. Medical first, then hazmat, rescue, fire (generic words
 * like "alarm"), road, public order.
 *
 * Boundaries are per token: stems get a leading `\b` only (`\bmental` matches "mentally");
 * short exact words get both (`\bco\b` won't match "company"; `\bfires?\b` won't match
 * "FIRED"). Input is lower-cased.
 */
const RULES: readonly { readonly category: IncidentCategory; readonly pattern: RegExp }[] = [
  {
    // Medical / behavioural health. "injur" is here so "INJURY VEH ACCIDENT" defaults off.
    category: "medical",
    pattern:
      /\baid|\bmedic|\bems\b|\bamr\b|\bambulance|\bnurse|\btriage|\bacuity|\boverdose|\bod\b|\bpoison|\bcardiac|\bbreathing|\brespirat|\bunconscious|\bunresponsive|\bseizure|\bstroke|\bh[ae]morrhage|\bmaternit|\bchildbirth|\binjur|\billness|\bsick\b|\bcasualt|\bmci\b|\bpsych|\bmental|\bbehavio|\bsuicid|\bwelfare|\bwell.?being|\b5150\b|\bperson down|\bman down|\bwoman down|\bdiabetic|\banaphyl|\ballergic/,
  },
  {
    // Hazardous materials, gas, odour, CO. Before fire because a gas leak is not a fire.
    // "\bhazardous"/"\bhazmat", never bare "hazard", so "TRAFFIC HAZARD" stays a road call.
    category: "hazmat",
    pattern:
      /\bhazmat|\bhazardous|\bchemical|\bbiohazard|\bradiolog|\bspill|\bnatural gas|\bgas (odor|odour|leak)|\bpropane|\bcarbon monoxide|\bco\b|\bodou?r|\bdecontam/,
  },
  {
    // Technical / entrapment rescue, including elevators and lock-ins.
    category: "rescue",
    pattern:
      /\brescue|\bextric|\bentrap|\bconfined space|\btrench|\bswift.?water|\bwater rescue|\bdive\b|\bcliff|\bhigh angle|\bcollaps|\belevator|\block.?in|\block.?out|\btechnical rescue/,
  },
  {
    // Fire and premises alarms. Also catches police security alarms (SFPD "AUDIBLE ALARM"),
    // a known, non-health miscategorisation.
    category: "fire",
    pattern:
      /\bfires?\b|\bsmoke|\bafa\b|\balarm|\bbell\b|\bburn|\barcing|\bexplos|\bflame|\bspark|\bwildland|\bbrush|\brubbish|\bdumpster/,
  },
  {
    // Vehicle incidents. No bare "traffic", so "TRAFFIC STOP" falls through to public order.
    category: "road",
    pattern:
      /\bmvi\b|\bmva\b|\bmotor vehicle|\bveh accident|\bvehicle (accident|incident|collision)|\bcollision|\bcrash\b|\bpedestrian struck|\btraffic (collision|accident|hazard)/,
  },
  {
    // Public order / law-enforcement. Mostly SFPD call types.
    category: "publicOrder",
    pattern:
      /\bassault|\bbattery|\bdisturb|\btheft|\bburglar|\brobber|\btrespass|\bsuspicious|\bvandal|\bweapon|\bknife|\bgun\b|\bshots?\b|\bshot ?spotter|\bstab|\bfight|\bnoise|\bprowler|\bthreat|\bharass|\bdomestic|\bwarrant|\bwanted|\btraffic stop|\btraf.{0,3}violation|\bsit.?lie|\bnarcotic|\bdrug\b|\bprostitut|\briot|\bprotest|\bcrowd|\bgraffiti|\bstolen|\bfraud|\bindecent|\bmissing/,
  },
];

/** Classify one call type. Empty or unrecognised text is `other`, not medical. */
export function classifyIncident(rawType: string | null | undefined): IncidentClassification {
  const text = (rawType ?? "").toLowerCase().trim();
  if (text === "") return { category: "other", isMedical: false };

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { category: rule.category, isMedical: rule.category === "medical" };
    }
  }
  return { category: "other", isMedical: false };
}
