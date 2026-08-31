---
slug: tracing-a-vessel-and-its-owner
title: "Tracing a Vessel and Its Owner"
summary: "Move from a ship's name or IMO number to its movement history, its real operator, and its sanctions exposure — and recognise AIS spoofing when you see it."
difficulty: advanced
category: transport-and-tracking
estimatedMinutes: 150
tags: [maritime, ais, imo-number, sanctions-evasion, beneficial-ownership, dark-fleet]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Fix the vessel's permanent identity"
    objective: "Resolve the vessel to its IMO number, which is the only identifier that survives renaming and reflagging."
    doneWhen: "You have an IMO number, current and former names, current flag, vessel type, gross tonnage and year of build, from an authoritative source."
    tools:
      - slug: equasis
        note: "Free with registration, and the best public source for particulars, name and flag history, and IMO company numbers."
      - slug: marinetraffic
        note: "Quick lookup by name or MMSI when you do not yet have the IMO number."
    body: |
      Ships change identity constantly and deliberately. A vessel may be renamed, reflagged and
      transferred between owners several times in a year, and in sanctions-evasion cases that is
      the entire point of the exercise. Working from a name alone guarantees you will lose the
      thread.

      Three identifiers, and you need to understand the difference:

      - **IMO number** — seven digits, assigned to the hull for its life, unchanged by renaming,
        reflagging or sale. This is the identifier you build the investigation on.
      - **MMSI** — the AIS radio identity. It changes with flag, and it is what gets spoofed.
        Useful for tracking, useless for identity.
      - **Call sign** — also changes with flag.

      Get the IMO number and then get the **history**: every previous name with dates, every
      previous flag with dates, and every recorded owner and manager change. That history is
      often the investigation in miniature. A vessel renamed three times in eighteen months and
      moved through three flags of convenience is telling you something before you have looked
      at a single position report.

      Record vessel type, gross tonnage, deadweight and year of build. Age matters: the fleets
      used for sanctioned oil trades skew heavily toward old tonnage approaching scrapping age,
      because the vessel is effectively expendable.

  - order: 2
    title: "Pull the ownership and management layers"
    objective: "Identify the registered owner, the commercial and technical managers, and the ISM manager, with their IMO company numbers."
    doneWhen: "You have each ownership and management role with its named entity, jurisdiction and IMO company number, and have noted which are shells."
    tools:
      - slug: equasis
        note: "Distinguishes registered owner, ship manager, ISM manager and beneficial owner where reported, each with an IMO company number."
      - slug: opencorporates
        note: "Take each named company into the corporate registries to find out what it actually is."
    body: |
      Maritime ownership is layered by design, and the layers have distinct legal meanings that
      you should not blur:

      - **Registered owner** — usually a single-purpose company owning exactly one ship, often in
        a flag-of-convenience jurisdiction. This is a legal shell and rarely tells you anything
        on its own.
      - **Commercial manager / operator** — who charters and trades the vessel. Frequently the
        entity that actually matters.
      - **Technical manager** — who maintains and crews it.
      - **ISM manager** — the entity accepting safety-management responsibility under the ISM
        Code, which carries real legal weight.
      - **Beneficial owner**, where reported. Often absent, which is itself informative.

      The **IMO company number** is the underused key here. It is a stable identifier for the
      company, and searching it returns every other vessel connected to the same entity. That is
      how a single ship becomes a fleet, and how the fleet becomes the story.

      Note carefully where the layers diverge. A vessel whose registered owner is in one
      jurisdiction, technical manager in a second, commercial manager in a third and flag in a
      fourth is not necessarily doing anything wrong — this is ordinary structuring in an
      international industry. But the pattern is also exactly what deliberate opacity looks
      like, and you cannot tell which from the structure alone. Say so.

      Then take each named company into the corporate registries. The **Corporate Ownership
      Tracing** playbook is the method; run it properly rather than stopping at the first shell.

  - order: 3
    title: "Reconstruct the movement history"
    objective: "Build a dated position and port-call history from AIS, using more than one provider."
    doneWhen: "You have a movement timeline from at least two independent AIS platforms, with gaps identified and their durations recorded."
    tools:
      - slug: marinetraffic
        note: "The largest AIS network, with port call records and historical playback on paid tiers."
      - slug: vesselfinder
        note: "Independent receiver network — differences between the two are informative, not alarming."
      - slug: global-fishing-watch
        note: "Adds behavioural classification: apparent fishing, encounters between vessels, loitering and AIS gaps."
    body: |
      Build the timeline: positions, port calls, and the periods between them. Then apply the
      one fact that governs everything in this step.

      **AIS position and identity are self-reported by the vessel and are straightforwardly
      spoofable.** Unlike aviation ADS-B, which is embedded in a regulated air-traffic system,
      AIS is a transponder the crew controls. Vessels broadcast false positions, broadcast
      another ship's MMSI, and switch the transponder off entirely. AIS tells you what a
      transponder transmitted, not where a ship was.

      Track **gaps** with particular care, and record each one's start, end and duration. A gap
      has several explanations and you must rank them honestly:

      - No receiver in range — the default explanation in open ocean, and by far the most
        common.
      - Equipment failure.
      - Legitimate silence, which SOLAS permits where transmitting would compromise the ship's
        safety, such as in piracy-risk waters.
      - Deliberate concealment.

      A gap becomes interesting when it is inconsistent with the innocent explanations: a gap in
      an area with dense receiver coverage; a repeated gap in the same waters; a gap whose
      duration and the vessel's position before and after imply a speed the ship cannot make; or
      a gap that ends with a significant change in draught, indicating cargo was loaded or
      discharged during the silence.

      Compare both platforms. They share the underlying broadcasts but have different receiver
      networks, so a track present in one and absent from the other is a data question to
      resolve, not a finding.

  - order: 4
    title: "Test the AIS against physical reality"
    objective: "Corroborate or contradict reported positions with independent observation."
    doneWhen: "You have checked at least one claimed position or gap against satellite imagery or another independent source, and recorded the result."
    tools:
      - slug: copernicus-browser
        note: "Sentinel-1 radar detects vessels through cloud and at night; Sentinel-2 optical confirms in clear conditions."
      - slug: global-fishing-watch
        note: "Encounter and loitering detection identifies two vessels together in a pattern consistent with a transfer."
    body: |
      This is the step that separates a movement summary from an investigation, because it is
      the only one that does not take the vessel's word for anything.

      **Radar imagery is the workhorse.** Sentinel-1 detects vessels as bright returns on water
      regardless of cloud or darkness, and it is free. Two high-value checks:

      - **Was the ship where AIS said?** Pull imagery for the claimed position and time. A
        reported position with no vessel visible in clear radar imagery is strong evidence of
        spoofing.
      - **Was the ship somewhere it did not report?** If you suspect a covert port call or
        transfer during a gap, image the suspected location for that window.

      **Ship-to-ship transfers** have a recognisable signature: two vessels stationary and
      adjacent for hours in open water, visible as a paired return in radar imagery, often with
      one or both dark on AIS, and followed by a draught change on at least one. This is the
      standard mechanism for moving sanctioned cargo and it is detectable with free imagery.

      Work within honest limits. Sentinel-1 revisits every few days, so you get snapshots, not
      continuous coverage — absence of imagery is not absence of a ship. Ten-metre resolution
      shows that a vessel is present, not which vessel it is; identifying a specific ship from
      Sentinel imagery alone is not possible and claiming it is a serious over-read. And
      distinguishing a vessel from sea clutter in radar takes practice; if you are not
      confident, say the imagery is inconclusive.

  - order: 5
    title: "Screen the vessel, the fleet and the companies against sanctions"
    objective: "Establish sanctions exposure for the vessel, its owners and managers, and any entity majority-owned by a designated person."
    doneWhen: "Vessel, IMO number, all named companies and all identified individuals have been screened and every hit confirmed against the issuing authority."
    tools:
      - slug: opensanctions
        note: "Consolidated screening across hundreds of sources — sanctions lists include vessels by IMO number, not only people and companies."
      - slug: ofac-sanctions-search
        note: "The authoritative US source, which lists vessels with IMO numbers and identifying particulars."
    body: |
      Screen everything: the vessel by name and IMO number, every company from step 2, every
      individual identified in the corporate chain, and every other vessel connected to the same
      IMO company numbers.

      Sanctions lists designate vessels directly, with IMO numbers and particulars, so this is
      not merely a corporate screening exercise.

      Confirm every hit against the issuing authority's own list before it goes anywhere near a
      conclusion, and resolve on identifying data — IMO number, date of birth, registration
      number — rather than names. Check more than one regime; OFAC, EU, UK OFSI and UN
      designations differ.

      **The ownership rule is the analytically important part.** Under OFAC's 50 percent rule
      and its EU and UK analogues, an entity majority-owned by designated persons is treated as
      blocked even though it appears on no list. A vessel owned by an unlisted company that is
      in turn majority-owned by a designated person is caught. No name search reveals this — it
      falls out of the ownership chain you built in step 2, which is the reason that step exists.

      Two cautions. Sanctions status is time-dependent: designations are added and removed, and a
      vessel clean on the date of the voyage you are examining may be listed now, or the reverse.
      Date every screening result. And screening false positives harm real people and real
      businesses — a common vessel name or a common company name is not a designation.

  - order: 6
    title: "Corroborate with port state control, casualty and commercial records"
    objective: "Test the picture against independent records of how the vessel is actually operated."
    doneWhen: "You have reviewed inspection and detention history and searched litigation and investigative corpora for the vessel and its companies."
    tools:
      - slug: equasis
        note: "Port state control inspection history and detentions — an independent record of how the ship is actually run."
      - slug: occrp-aleph
        note: "Cross-dataset search covering maritime registries, court records and leaked corporate material."
      - slug: courtlistener
        note: "Maritime litigation and arrest proceedings frequently state ownership and control directly."
    body: |
      Port state control inspection history is genuinely independent evidence. Inspectors board
      the vessel and record what they find. A pattern of detentions, serious deficiencies or
      repeated safety failures tells you about the operator regardless of what the ownership
      documents say, and it is recorded by state authorities with no interest in the story.

      Also worth searching:

      - **Casualty and incident records** — collisions, groundings, pollution events.
      - **Vessel arrest and maritime litigation**, which forces owners to identify themselves in
        court and is one of the few mechanisms that reliably pierces single-purpose ownership.
      - **Class society records** — withdrawal of class is a significant event and often precedes
        a vessel entering an opaque trade.
      - **Insurance and P&I club membership**, where discoverable. Loss of mainstream insurance
        cover is a strong signal that a vessel has moved into sanctioned trades.
      - **Charterers and cargo interests** in commercial reporting.

      Where the paper ownership and the operational record diverge, that gap is the finding. Do
      not resolve it silently in favour of whichever source supports your thesis.

  - order: 7
    title: "Assemble the finding and rate every claim"
    objective: "Produce a documented account distinguishing what AIS reported, what was independently observed, and what is inferred."
    doneWhen: "Every claim carries its source, its date and a confidence label, and the write-up states what could not be established."
    tools:
      - slug: hunchly
        note: "Timestamped, hashed capture of every record relied on — necessary if the finding is challenged by well-resourced parties."
    body: |
      Maritime investigations attract legal pushback from parties with resources, so the
      write-up standard is high.

      Categorise every claim explicitly:

      - **Reported** — what AIS transmitted. Always attribute it that way: "the vessel's AIS
        reported a position of…" and never "the vessel was at…".
      - **Observed** — what independent imagery or an inspection record shows. This is your
        strongest evidence.
      - **Documented** — what a registry, filing or court record states.
      - **Inferred** — what you deduced from a pattern. Legitimate, and labelled as inference
        every time.

      Rate the whole finding honestly. A vessel with an unexplained gap, an old hull, an opaque
      ownership chain and a flag of convenience fits a well-known pattern — and fitting a
      pattern is not evidence that this vessel did the thing. Many entirely legitimate vessels
      share every one of those characteristics. If the case rests on pattern-matching, say so,
      and say what would be needed to move it beyond that.

      State what remains unestablished: gaps you could not explain, ownership layers that went
      opaque, periods with no imagery coverage. That section is what makes the rest credible.
---

# Tracing a Vessel and Its Owner

Roughly nine-tenths of world trade moves by sea, in an industry built on layered ownership, flags
of convenience and single-purpose companies. That combination makes shipping both a natural
vehicle for sanctions evasion, smuggling and illegal fishing, and — because vessels are required
to broadcast their position and because their particulars are publicly registered — one of the
most tractable subjects in open-source investigation.

The work has a characteristic shape. Fix the permanent identity, peel the ownership layers,
reconstruct the movements, and then test those movements against physical observation. That last
step is what distinguishes a real investigation from a summary of what a ship's transponder
claimed, because in exactly the cases you care about the transponder is lying.

## Before you start

**Your legal footing.** AIS is a mandatory, unencrypted safety broadcast and receiving it is
lawful. Vessel registries, port state control records and sanctions lists are public. The
constraints are contractual rather than criminal: AIS platform terms restrict scraping and
redistribution, and satellite AIS in particular is licensed data with real limits on
republication. Read them before you republish tracks or build a dataset.

Sanctions work carries its own exposure. Screening is a regulated activity in many contexts, and
this playbook is not compliance advice and cannot substitute for a compliance function. If a
commercial decision depends on the outcome, it needs a qualified sanctions professional.

**Defamation is the principal legal risk.** Asserting that a named vessel, owner or manager
engaged in sanctions evasion, smuggling or illegal fishing is a serious allegation against
identifiable parties who frequently have both resources and lawyers. The distinction between
*the vessel's AIS showed a 40-hour gap in an area with good receiver coverage* and *the vessel
went dark to conceal a transfer* is the distinction between a defensible finding and a claim you
may have to defend.

**Your ethical footing.** Crews are not owners. Seafarers on vessels in sanctioned trades are
frequently exploited, unpaid and effectively trapped, and they are the people most easily
identified and least responsible. Do not name crew members. Vessel investigation can also shade
into surveillance of individual seafarers' movements, which needs its own justification.

**Your own security.** Commercial AIS platforms log which vessels you look up against your
account, and in a sanctioned-trade investigation that query history is sensitive. Use a research
account. Be aware that some parties in this space monitor public interest in their fleets.

**Recording provenance of your own work.** Vessel data changes fast — names, flags, owners and
managers all turn over, sometimes within weeks of a vessel attracting attention. Every record you
rely on must be captured with a date. A finding citing "Equasis" without a retrieval date is not
reproducible, because the record will have changed by the time anyone checks.

## Corroboration and how not to fool yourself

1. **AIS is self-reported.** This is the single most important fact in maritime OSINT and the one
   most often forgotten in write-ups. Attribute every position to the transponder, not the ship.

2. **A gap is not a finding.** Most AIS gaps are receiver coverage. Before treating one as
   deliberate, establish that coverage in that area is normally good, that the gap is
   inconsistent with the vessel's plausible speed and route, or that it recurs in the same
   waters.

3. **Corroborate across domains.** AIS and satellite radar are genuinely independent — one is the
   vessel's claim, the other is an observation. Two AIS platforms are not independent in the same
   way, because they share the underlying broadcasts.

4. **Record negative results.** "No Sentinel-1 coverage for that window", "no port state control
   detentions on record", "no sanctions hits as of this date". These bound your conclusion and
   stop repeated work.

5. **Pattern is not proof.** Old tonnage, a flag of convenience, an opaque owner and an AIS gap
   describe a great many entirely legitimate vessels. The pattern justifies investigation; it
   does not conclude it.

## Writing it up

Lead with the vessel's permanent identity — IMO number, current and former names, flag history —
because that is what lets another researcher follow you.

Present the movement history as a dated timeline, distinguishing AIS-reported positions from
independently observed ones. Where you have satellite corroboration, show the imagery with its
acquisition date and state its resolution, so a reader can judge what it can support.

Present the ownership chain as a diagram with per-link sourcing and confidence labels, as in the
corporate playbook.

Attribute precisely. "According to AIS data from [platform], retrieved [date], the vessel
reported…" is defensible. "The vessel sailed to…" may not be.

Apply your right-of-reply process to named owners, managers and companies.

## What would falsify this

- The AIS positions you built on were spoofed, making the whole track fictitious.
- The gap you treated as deliberate was a receiver coverage hole or a documented equipment
  failure.
- The paired vessels you read as a ship-to-ship transfer were two ships that happened to be in
  proximity, or a single return misread in radar.
- The vessel was sold or reflagged mid-timeline and you attributed one operator's voyages to
  another.
- The registered owner is a nominee arrangement and the real controller is elsewhere entirely —
  which is invisible in registries and is the standard defeater for maritime ownership work.
- The company name match in sanctions screening was a different company sharing a common name.

If you have not checked these, you have a pattern consistent with a hypothesis. Publish it as
that, and say what would settle it.
