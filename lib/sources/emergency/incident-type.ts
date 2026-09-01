/**
 * Classifying a live emergency-dispatch call type into a category, and — the whole reason
 * this file exists — deciding whether it is **medical**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN, TESTED, KEYWORD FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR 0033 makes one binding demand of the emergency layer: *medical dispatch is off by
 * default, because a medical call is health information about an identifiable person at an
 * address.* The layer therefore cannot render a call until it has decided whether that call
 * is medical, and that decision must be the same for Seattle Fire and San Francisco Police,
 * neither of whom describe a call the same way. So the decision lives here, once, over the
 * operator's own free-text call type, and it is tested against the **real** type strings each
 * operator publishes (captured 2026-09-01), not against invented ones.
 *
 * Two rules govern the classifier, and both come straight from ADR 0033:
 *
 *   1. **Never miss a medical call.** Medical is checked FIRST and with the widest net, so a
 *      generic word ("alarm", "response") can never shadow a medical one ("Automatic Medical
 *      Alarm" is medical, not fire). A false positive here costs a fire call being hidden
 *      until a reader opts in; a false negative leaks health data by default. The costs are
 *      not symmetric, so the net is deliberately wide.
 *   2. **Never invent a meaning.** Agency-internal codes we cannot read — Seattle's "1RED 1
 *      Unit", a bare numeric SFPD code — fall to `other` rather than being guessed into a
 *      category. `other` is shown by default; that is acceptable precisely because those
 *      codes carry no health word, and fabricating a mapping ("RED must mean medic") is the
 *      accuracy-is-the-product failure product-brief §6 forbids. The limitation is recorded
 *      in `docs/sources/seattle-fire-911.md` rather than hidden.
 *
 * The classifier reads the operator's text and nothing else. It performs **no** identity
 * resolution and no cross-referencing (ADR 0033) — it cannot, it is a string matcher.
 */

/**
 * What kind of incident a dispatch is, coarsely, for the legend and the default toggles.
 *
 * `medical` is not just another member: it is the one the UI defaults OFF, and `isMedical`
 * below is what a caller reads to enforce that. The rest ship visible (ADR 0033: "fire,
 * hazmat, rescue, road and public-order incident types").
 */
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
  /**
   * True exactly when `category === "medical"`. Carried as its own field, not re-derived at
   * every call site, because "is this health data about a person" is the single question the
   * default-off toggle turns on and a caller must never have to reconstruct it from a string
   * compare. ADR 0033.
   */
  readonly isMedical: boolean;
}

/**
 * Ordered rules. FIRST MATCH WINS, and the order is the safety property — medical before
 * everything, then the specific hazards, then fire (whose words are the most generic:
 * "alarm", "bell"), then road, then public order.
 *
 * Each token carries its OWN boundaries rather than wrapping the whole alternation in
 * `\b(...)\b`. A trailing `\b` on the group would break every prefix stem — `mental` would
 * not match "mentally", `burglar` not "burglary", `injur` not "injury" — and those are the
 * exact real strings the operators publish. So a stem meant to match longer words carries a
 * leading `\b` only (`\bmental` matches "mentally"), and a short exact word that must not
 * match inside another carries both (`\bco\b` matches "CO detector" but not "company",
 * `\bshots?\b` matches "SHOTS FIRED" while `\bfires?\b` deliberately does NOT, so a shooting
 * is public-order and not fire). Every pattern is lower-cased against a lower-cased input.
 *
 * Verified against the full captured call-type vocabularies of Seattle Fire (kzjm-xkqj) and
 * SFPD (gnap-fj3t), 2026-09-01 — see the tests in `incident-type.test.ts`.
 */
const RULES: readonly { readonly category: IncidentCategory; readonly pattern: RegExp }[] = [
  {
    // Medical / health / behavioural-health. The widest net, checked first. "injur" is here
    // on purpose: "INJURY VEH ACCIDENT" reveals a hurt person, so it is health data and
    // defaults OFF rather than being shown as a plain road incident.
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
    // Fire and premises alarms. "\balarm"/"\bbell" also catch security alarms on the police
    // feed (SFPD "AUDIBLE ALARM"), grouped here as a premises-alarm response — a coarse but
    // non-health miscategorisation, recorded in docs/sources/sf-police-911.md. "\bfires?\b"
    // is an exact word so "SHOTS FIRED" is not swept in as a fire.
    category: "fire",
    pattern:
      /\bfires?\b|\bsmoke|\bafa\b|\balarm|\bbell\b|\bburn|\barcing|\bexplos|\bflame|\bspark|\bwildland|\bbrush|\brubbish|\bdumpster/,
  },
  {
    // Motor-vehicle and traffic incidents. "Car Fire" is already `fire` above, correctly, and
    // "INJURY VEH ACCIDENT" is already `medical`. Bare "traffic" is NOT here, so "TRAFFIC
    // STOP" and "TRAF VIOLATION" fall through to public order where they belong.
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

/**
 * Classify one operator-published call type.
 *
 * Empty or unrecognised text is `other`, never medical: `other` is honest about "we could not
 * read this code", and defaulting an unreadable code to medical would hide fire calls the
 * classifier simply failed to parse. The medical net is wide enough (rule 1) that a genuine
 * medical word is caught; a code with no word at all is not health data we can identify, and
 * is labelled as unknown rather than guessed.
 */
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
