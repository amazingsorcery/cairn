---
slug: corporate-ownership-tracing
title: "Corporate Ownership Tracing"
summary: "Move from a company name to the people who actually own and control it, through registries, filings and sanctions data — and recognise when the chain has genuinely gone dark."
difficulty: intermediate
category: corporate-and-financial
estimatedMinutes: 180
tags: [due-diligence, beneficial-ownership, company-registry, aml, sanctions, offshore]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Fix the entity's identity precisely"
    objective: "Establish exactly which legal entity you are investigating, in which jurisdiction, with which registration number."
    doneWhen: "You hold a jurisdiction, a registration number, an exact legal name and an incorporation date from an official source."
    tools:
      - slug: opencorporates
        note: "Searches across roughly 140 jurisdictions at once, which is how you find the entity when you do not yet know where it is registered."
      - slug: gleif-lei
        note: "If the entity has an LEI, that code is a globally unique identifier and may also give you its reported parent."
    body: |
      Almost every failed ownership trace fails here, at the beginning, by investigating a
      different company from the one that matters.

      Company names are not unique. "Meridian Holdings Ltd" may exist in a dozen jurisdictions
      with no relationship between them. Groups routinely operate entities with near-identical
      names in different countries. Trading names differ from legal names. And an entity that
      was struck off and re-registered has two records that look like one.

      What you need before proceeding:

      - **Exact legal name** including the suffix, which is part of the name.
      - **Jurisdiction of incorporation** — not where it operates, which is often different and
        is the second most common error.
      - **Registration number** in that jurisdiction. This is the identifier you will use
        everywhere; names are for searching, numbers are for citing.
      - **Incorporation date and current status** — active, dissolved, struck off, in
        liquidation.

      Start at OpenCorporates to find the entity across jurisdictions, then go to the official
      registry of the jurisdiction it names and confirm every field there. OpenCorporates is a
      mirror, and mirrors lag. From this point on, cite the registry.

      If you cannot pin the entity to a registration number, stop and say so. Everything
      downstream inherits this uncertainty, and a chain of ownership built on the wrong entity
      is worse than no chain at all.

  - order: 2
    title: "Pull the full official record"
    objective: "Obtain the registry's complete holdings on the entity — officers, ownership disclosures, filings, addresses, charges — from the source of record."
    doneWhen: "You have the officer list with appointment and resignation dates, any beneficial-ownership disclosure, the registered address, and the filing history."
    tools:
      - slug: uk-companies-house
        note: "For UK entities: free filing history, cross-linked officer appointments and the Persons with Significant Control register."
      - slug: sec-edgar
        note: "For entities with US filing obligations: subsidiary lists, related-party transactions and beneficial-ownership filings above threshold."
      - slug: opencorporates
        note: "Use to locate the official registry for jurisdictions you do not know, then follow through to that registry."
    body: |
      Read the filings, not just the summary page. The summary tells you who the directors are
      now; the filings tell you the history, and the history is where the story is.

      Extract systematically:

      - **Every officer, with appointment and resignation dates.** Officer turnover around a
        significant event is itself a finding.
      - **Beneficial ownership disclosure** where the jurisdiction has a regime — the UK's PSC
        register, the EU member states' UBO registers, and equivalents elsewhere.
      - **Registered address**, and whether it is a real place of business or a formation
        agent's address serving thousands of companies. The latter tells you the entity is
        administered rather than operated there.
      - **Shareholders**, where the jurisdiction publishes them. Many do not.
      - **Charges and security interests**, which name lenders and reveal financial
        relationships that appear nowhere else.
      - **Accounts**, including whether they were filed at all, filed late, or filed as dormant.

      Two things to hold in mind throughout. First, registry data is **what was filed**, not
      what is true. Several major registries, including the UK's, historically did no meaningful
      verification of filings, which is why fictitious directors and addresses appear on them.
      Second, an **absence** in a registry is ambiguous: it may mean no such thing exists, or
      that the jurisdiction does not require its disclosure. Know which before you draw an
      inference.

  - order: 3
    title: "Follow the chain upward"
    objective: "Trace each corporate shareholder or parent to its own registry record, recursively, until you reach natural persons or a genuine dead end."
    doneWhen: "Every branch of the ownership tree terminates in a natural person, a listed company, a state body, or a documented opacity point."
    tools:
      - slug: opencorporates
        note: "Cross-jurisdiction search finds the parent when it is registered somewhere you were not looking."
      - slug: gleif-lei
        note: "Level 2 data reports direct and ultimate accounting-consolidation parents where entities have filed them."
      - slug: sec-edgar
        note: "Subsidiary exhibits and ownership filings often disclose group structure that no individual registry shows."
    body: |
      Treat this as a tree traversal and keep the tree written down. Ownership chains branch,
      re-converge and loop, and an unwritten chain becomes unmanageable at about the fourth
      level.

      For every corporate shareholder or parent, repeat steps 1 and 2. Record for each edge:
      the percentage held, the date the holding was recorded, and the source document.
      Percentages matter — control thresholds in most beneficial-ownership regimes sit at 25%,
      and sanctions ownership rules commonly bite at 50%.

      **Patterns worth noticing as you go:**

      - **Circular ownership**, where entities own each other. Sometimes ordinary group
        structuring, sometimes deliberate obfuscation.
      - **A nominee layer** — the same handful of directors appearing across hundreds of
        unrelated companies is the signature of a formation agent, not a business empire.
      - **Jurisdiction hopping**, where each level sits in a different country, each chosen for
        a different disclosure gap.
      - **A trust in the chain.** Trusts are the most effective opacity structure in common use
        because most jurisdictions do not publish beneficiaries. When you hit one, note the
        trustee and the governing law, and expect the trail to stop.

      **Where the chain goes dark**, name the opacity point precisely: "the chain terminates at
      a company registered in [jurisdiction], which does not publish shareholder information."
      That is a real, publishable finding and it is often the story — the structure was built
      to produce exactly that sentence. What is not acceptable is inferring who is behind it and
      presenting the inference as the answer.

  - order: 4
    title: "Search leak and investigative corpora"
    objective: "Check whether the entities and individuals in your chain appear in offshore leaks or investigative datasets that fill registry gaps."
    doneWhen: "You have searched every entity name, individual name and address in your chain against the major investigative corpora and recorded hits and nulls."
    tools:
      - slug: icij-offshore-leaks
        note: "Publishes the entity-relationship layer of Panama, Paradise and Pandora Papers — structures that appear in no public registry."
      - slug: occrp-aleph
        note: "Cross-searches hundreds of datasets at once: registries, court records, procurement, leaks."
      - slug: littlesis
        note: "Relationship mapping for the individuals you identify — board seats and affiliations registries do not show."
    body: |
      Offshore jurisdictions exist to not maintain public registries, so registry work alone
      cannot penetrate them. Leak-derived corpora are frequently the only route.

      Search every name in your chain — entities, directors, shareholders, and the **addresses**
      too. Address searches are underused and productive: a registered address shared with a
      known structure is a strong link, and it is a link that name changes do not break.

      Handle results with care, because this is where corporate research most often becomes
      defamation:

      - **A name match is not an identification.** Common names collide constantly across
        jurisdictions. Confirm with a second identifier — date of birth, address, a shared
        entity — before treating a hit as your subject.
      - **Appearing in a leak is not evidence of wrongdoing.** The ICIJ database says so
        explicitly, and it is true: offshore entities have entirely legitimate uses. Reporting
        an appearance with an implication of criminality is defamatory.
      - **Leaks are dated snapshots.** An officer listed in a 2016 leak may have resigned in
        2017. Never write a leak record in the present tense.
      - **Know your legal footing on leak-derived material.** The ICIJ database is deliberately
        published in the public interest, which is a different position from handling raw
        leaked material yourself. If you are working with the latter, take legal advice on your
        jurisdiction before you do anything with it.

  - order: 5
    title: "Screen everyone against sanctions and PEP data"
    objective: "Determine whether any entity or individual in the chain is designated, controlled by a designated person, or politically exposed."
    doneWhen: "Every entity and natural person in the chain has been screened, and every hit has been confirmed against the issuing authority's own list."
    tools:
      - slug: opensanctions
        note: "Consolidated screening across hundreds of sources in one pass — use as the screening layer, never as the authority."
      - slug: ofac-sanctions-search
        note: "The authoritative US source. Any OFAC hit must be confirmed here before it goes anywhere near a decision."
    body: |
      Screen every name — entities and natural persons, at every level of the chain, including
      names that appear only as historical officers.

      Method:

      1. Run the full list through OpenSanctions to find candidates efficiently.
      2. **Confirm every hit against the issuing authority's own list.** An aggregator hit is a
         prompt to check, not a finding. Screening false positives cause real harm to real
         people who share a name.
      3. Use the identifying data — date of birth, passport number, address, registration
         number — to resolve the hit. Never resolve on name alone.
      4. Check more than one regime. OFAC, EU, UK OFSI and UN lists differ, and an entity clean
         under one may be designated under another.

      **The ownership rule that catches people out.** Under OFAC's 50 percent rule and analogous
      EU and UK provisions, an entity majority-owned by designated persons is itself treated as
      blocked **even though it does not appear on any list**. No name search will tell you this.
      It is precisely why you built the ownership chain, and applying that rule to your chain is
      the highest-value analytical act in this playbook.

      **PEP status is not an allegation.** A politically exposed person designation means
      enhanced scrutiny is warranted, not that anyone did anything wrong. Reporting it as an
      accusation is both wrong and actionable.

  - order: 6
    title: "Corroborate with litigation, filings and the record"
    objective: "Test the paper structure against independent evidence of who actually controls the entity."
    doneWhen: "You have searched litigation, regulatory and press records for the entities and individuals, and reconciled what they show against the registry chain."
    tools:
      - slug: courtlistener
        note: "Court filings frequently state ownership and control directly, in a party's own words and under oath."
      - slug: propublica-nonprofit-explorer
        note: "Where a nonprofit is in the structure, Form 990 discloses officers, compensation and grant relationships."
      - slug: occrp-aleph
        note: "Cross-dataset search surfaces procurement records, court documents and registries in one pass."
    body: |
      Registry ownership and actual control diverge often, and the divergence is usually the
      point of the structure. Corroborate from outside the registries:

      - **Litigation.** A complaint or a deposition routinely states who controls a company more
        plainly than any filing, because a party had to explain it to a judge. Search every
        entity and individual name.
      - **Regulatory filings and enforcement actions** in any sector the entity operates in.
      - **Procurement and contract awards**, which name signatories and beneficial owners in
        many jurisdictions.
      - **Press and company statements.** People describe themselves as owning things that the
        registry attributes to a nominee, and that contradiction is evidence.
      - **The entity's own website, archived over time** — staff pages and 'about' text often
        state relationships that were later scrubbed.

      Where the paper chain and the real-world evidence disagree, that gap is the finding. Do
      not smooth it over, and do not silently prefer the source that fits your thesis. Write
      both down and say which is better evidenced.

  - order: 7
    title: "Assemble, rate and stress-test the chain"
    objective: "Produce a documented ownership structure with per-link sourcing and an explicit confidence rating, and attack it before anyone else does."
    doneWhen: "Every link cites a dated primary source, every unresolved branch is labelled, and you have written down what would refute the conclusion."
    tools:
      - slug: hunchly
        note: "A timestamped, hashed record of every registry page and filing you relied on — which is what you will need if the finding is challenged."
      - slug: opencorporates
        note: "Provides stable, citable references for each entity in the final structure."
    body: |
      Draw the structure as a diagram, and beneath it list every edge with:

      - the source document and its date,
      - the percentage or nature of the interest,
      - the date the interest was recorded,
      - a confidence rating.

      Rate each link honestly:

      - **Confirmed** — stated in an official filing from the entity's own registry.
      - **Reported** — stated in a secondary source such as an aggregator or press report.
      - **Inferred** — deduced from shared addresses, common officers or timing. Inference is
        legitimate evidence and must be labelled as inference every single time.
      - **Unresolved** — the branch goes into an opaque jurisdiction or a trust.

      A chain is only as strong as its weakest link, and the weakest link is usually one people
      stopped labelling because they had grown confident. If any link is inferred, the ultimate
      beneficial owner is not established, and the write-up must say so in those words.

      Then stress-test it. Give the diagram to someone else and ask them to break it. Ask what
      the most innocent explanation of the structure is — because ordinary tax planning,
      liability ring-fencing and financing requirements produce structures that look exactly
      like concealment, and confusing the two is the most common way this work goes wrong.
---

# Corporate Ownership Tracing

Behind every company is a question that company law makes surprisingly hard to answer: who
actually owns and controls it. Answering it is the core of due diligence, sanctions compliance,
procurement integrity work and most investigative reporting about money.

The method is a recursive traversal — find the entity, pull its record, identify its owners,
repeat — punctuated by the moments where public registries stop and you must either find another
route or state honestly that the trail ends. Both of those are legitimate outcomes. What is not
legitimate is guessing at the far end of an opaque structure and presenting the guess as a
finding.

## Before you start

**Your legal footing.** Company registries are public by law and searching them is unambiguously
lawful. Three real constraints. Officer and beneficial-ownership records contain personal data of
natural persons, and some jurisdictions restrict republication of registry-sourced personal data
even though the registry is public — the residential addresses in older UK filings being the
standard example. Aggregator licences differ sharply between public-benefit and commercial use,
and using OpenCorporates or OpenSanctions data commercially without the right licence is a real
breach that people commit routinely. And leak-derived material carries jurisdiction-specific
exposure that a public-interest purpose does not universally cure.

**Defamation is the dominant legal risk in this work**, well ahead of data protection. Publishing
that a named person owns or controls an entity, when the evidence supports only that their name
appears in a document, is actionable in most jurisdictions and is the single most common way
corporate investigations end badly. The discipline of labelling every link *confirmed*,
*reported* or *inferred* is not bureaucracy — it is the thing that keeps the finding defensible.

**Your ethical footing.** Owning an offshore company is lawful. Being a politically exposed
person is not an accusation. Using a nominee director is standard practice in many jurisdictions
for reasons that have nothing to do with concealment. If your write-up implies wrongdoing from
structure alone, you have not made an argument, you have made an insinuation.

**Your own security.** Most registry searches are anonymous, but not all — some registries log
searches, some jurisdictions notify companies of searches against them, and paid services
associate queries with your account. In a sensitive matter, know which registries you are using
and what they record before you search.

**Recording provenance of your own work.** Every link in the chain must cite a specific document,
retrieved on a specific date, from a specific source. Registries change: officers resign, filings
are amended, entities are struck off. A finding that was true in March may not be in September,
and only a dated citation makes that visible. Capture the actual filing, not a link to it.

## Corroboration and how not to fool yourself

1. **Registry data is what was filed.** It is a claim made to a state body, not an adjudicated
   fact, and in several major jurisdictions nobody checked it. Corroborate identity
   independently before naming a person.

2. **Confirm identity with more than a name.** Common names, transliteration variants and
   father-and-son pairs sharing a name have produced serious published errors. Require a second
   identifier before you treat two records as the same person.

3. **Record negative results.** "Jurisdiction X does not publish shareholders" and "no litigation
   found naming this entity as of this date" are findings. They define the boundary of what is
   knowable, and without them a reader cannot tell whether you searched or gave up.

4. **Distinguish absence of disclosure from absence of the thing.** A registry with no beneficial
   owner listed may have no requirement to list one. Know the jurisdiction's rules before you
   infer anything from a blank field.

5. **Ask what the innocent explanation is**, explicitly, in writing, before you conclude. If you
   cannot articulate one, you do not understand the structure well enough to write about it.

## Writing it up

Lead with the structure diagram; it communicates more than paragraphs will. Beneath it, a table:
every link, its source document, that document's date, the nature of the interest, and the
confidence label. Then a section on what remains unresolved and why — which jurisdiction, which
trust, which non-disclosing registry.

Use the language of evidence precisely. "Companies House records list X as a person with
significant control as of [date]" is a fact you can prove. "X owns the company" is a conclusion
that may not follow from it. The first survives a legal read; the second may not.

If a natural person is named, apply your organisation's right-of-reply process. It is both the
ethical standard and, in most jurisdictions, materially relevant to your legal position.

## What would falsify this

- A nominee arrangement meaning the registered shareholder holds for someone else — which is
  invisible in registries and is the standard defeater for this entire method.
- A trust or foundation in the chain whose beneficiaries are not disclosed.
- A share transfer after the date of your most recent source document.
- A name collision: the person you identified is a different individual with the same name.
- A jurisdiction whose registry you did not search because you did not know the entity was
  registered there.
- A mundane commercial explanation for a structure you read as concealment.

If none of these has been checked, the chain is a hypothesis. Say so, and say which link is
weakest.
