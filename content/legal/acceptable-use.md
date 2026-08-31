---
title: "Acceptable Use Policy"
slug: acceptable-use
effectiveDate: "{{POLICY_EFFECTIVE_DATE}}"
lastReviewedAt: "2026-08-31"
---

# Acceptable Use Policy

This policy governs what you may and may not do with {{BRAND_NAME}}. It forms part of the
[Terms of Service](/legal/terms) and applies to every account, whether free or paid.

It is short and it is specific, because a policy that lists everything is a policy that enforces
nothing. Where it prohibits something, we mean it and we will act on it.

**A qualified lawyer has not yet reviewed this document. See `docs/content/legal-review.md`.**

## 1. What {{BRAND_NAME}} is

{{BRAND_NAME}} is four things:

1. **A catalogue** of publicly available open-source intelligence tools and data sources, with
   editorial notes on cost, reliability, jurisdiction and legal exposure.
2. **Playbooks** — written investigative methodologies that reference catalogue entries.
3. **Workspaces** — a place for you to keep your own case notes, checklists and saved
   collections of tools.
4. **Live** — two viewing surfaces over data that operators have intentionally published: an
   aircraft map built from open ADS-B broadcasts, and a curated registry of camera feeds that
   their operators publish under a licence. Section 4 explains exactly how these work, because
   the details matter more than the description.

## 2. What {{BRAND_NAME}} is not

This matters more than the previous section, because most misunderstandings of this service are
misunderstandings of this list.

- **We are not a data source.** We hold no records about the subjects of your investigations, no
  people-search index, no breach data, no aggregated personal profiles. We tell you that a tool
  exists; we do not run it for you and we do not hold its output.
- **We do not query catalogue tools on your behalf.** Nothing you enter into a workspace is sent
  to any tool in the catalogue. Following a link from {{BRAND_NAME}} to a third-party tool is
  your action, from your device, on your account with that service. The Live surfaces are the
  single exception to our making any outbound request at all, and section 4 sets out precisely
  what those requests are.
- **Live is not access to "anything reachable".** It shows data operators chose to publish. A
  camera that is merely reachable — one on a default password, or indexed by a scanning service —
  was never published by anyone, and we will not list it. Section 4.1 explains why that is a
  legal line and not a matter of taste.
- **We do not perform facial recognition or biometric matching**, and we will not add that
  capability.
- **We do not host, mirror or make searchable any breached-credential dataset.** We catalogue
  services such as Have I Been Pwned that report the *fact* of exposure; we will never become a
  service that returns credentials.
- **Cataloguing is not endorsing.** A tool's presence in the catalogue is not a statement that it
  is lawful for you to use, appropriate for your purpose, safe, or accurate. Several entries
  exist specifically to warn you about tools you will otherwise encounter unwarned.
- **We do not provide legal advice.** The `legalNotes` on a catalogue entry are editorial
  research, not advice, and they are not a substitute for a lawyer who knows your jurisdiction
  and your facts.

## 3. Your responsibility for legality

Open-source research is lawful in most places, most of the time. Its limits differ enormously
between jurisdictions, and they depend on facts we do not know: where you are, where your subject
is, who you work for, what you intend, and what you do with what you find.

**You are responsible for the legality of your own research.** By using {{BRAND_NAME}} you
confirm that you will comply with the law applicable to you, including data protection, computer
misuse, surveillance, defamation, harassment, export control and professional regulation.

Where you use a workspace to hold notes about identifiable people, **you are the data controller
of that material**, not us. That is a deliberate design decision, and section 4 of the
[Privacy Notice](/legal/privacy) explains what it means in practice.

## 4. The Live surfaces

Live is the only part of {{BRAND_NAME}} that makes any outbound request. This section says
exactly what those requests are, because you cannot assess a privacy property you have not been
told about.

### 4.1 What Live shows, and the line it draws

Live shows **data an operator intentionally published**. That is not the same as data that
happens to be reachable, and the distinction does all the legal work here.

**In scope — intentionally published.** A transport authority that publishes its traffic cameras
through a documented API under an open licence has decided that anyone may look. Aircraft
transponders broadcast position in clear, unencrypted, by regulatory design, to be received. These
feeds exist to be used and using them is exactly what they are for.

**Out of scope — merely reachable.** A camera on a default password, or one indexed by a scanning
service, was never published by anybody. Nobody chose to make it public; it was left open.
Reachability is not publication.

We do not list such cameras, and we will not. Viewing one is unauthorised access to a computer
system under the US Computer Fraud and Abuse Act, the UK Computer Misuse Act 1990 and equivalents
across the EU, and the absence of a password is not a permission. Those cameras are also
frequently pointed at the inside of somebody's home, which makes it an intrusion on identifiable
people on top of the access offence.

Tools that enumerate such cameras remain **catalogued in the directory**, with that exposure
stated plainly. Cataloguing is not endorsing, and a directory that hides the risk is worse than
one that omits the entry. Using {{BRAND_NAME}} to find such a camera and then view it is a breach
of section 5.3.

### 4.2 Cameras: click-to-load, and what that means for you

**We do not proxy, re-host, cache or record camera imagery.** No image from any camera passes
through our servers.

The consequence is a real privacy property that you are entitled to understand:

- Camera pages load **nothing** from any operator until you click. We render the camera's name,
  operator and location from our own database, and make no outbound connection.
- **When you click to load a feed, your browser connects directly to that operator.** That
  operator — and its hosting provider or CDN — will see your IP address, and because the URL
  identifies one camera, they will see which location you chose to look at.
- We tell you this on the page, before you click, naming the operator. Not buried here.
- We send no referrer with the request, so the operator learns that someone loaded the image but
  not which page you came from.
- Because the request never touches us, **we do not and cannot know which cameras you viewed.**
  There is no viewing record to subpoena, sell or leak, because none is created.

If a camera's licence does not permit embedding, we link out instead. That is the same disclosure
in a more obvious form: you knowingly navigate to the operator.

Weigh this before you click. If your interest in a particular location is itself sensitive, a
direct connection to that location's camera operator is a disclosure, and access logs kept by
transport authorities and their CDNs are obtainable.

### 4.3 Aircraft: aggregation, not identification

The flights surface aggregates ADS-B position broadcasts that aircraft transmit in clear, by
regulatory design, and that anyone with a receiver can pick up. We fetch this server-side and
cache it, so your interest in a particular aircraft is not disclosed to the upstream aggregator.

**We add no identity resolution.** We do not link a tail number to an owner, a company or a
person, and we hold no registry of who flies what. If you want that, the directory catalogues the
aircraft registries and ownership sources — and following that trail is your act, subject to your
own legal position.

**Where we stand on the private-jet tracking argument.** There is a genuine public debate about
whether publishing aircraft movements endangers the people aboard, and it is not a frivolous
objection. Our position, stated rather than avoided:

- The underlying broadcasts are public by regulatory design. We are not obtaining them; we are
  displaying what is already being transmitted in clear.
- Aircraft movement data underpins a large body of legitimate reporting — sanctions evasion,
  state surveillance flights, rendition, environmental accountability, conflict monitoring — and
  removing it would remove that work, not the risk.
- The genuine hazard is not aggregate movement data. It is **tying an aircraft to a named
  individual and inferring where that person is now.** That is the step we do not take and will
  not add, and it is prohibited for you under section 5.5.
- We publish no real-time location of any identified individual, because we do not know who is
  aboard anything.

If you think we have this balance wrong, tell us at {{BRAND_CONTACT_LEGAL}}. We would rather
argue about it than pretend the question is not being asked.

### 4.4 We keep no record of what you looked at

Across both Live surfaces:

- We do not log which aircraft, area or camera any user viewed.
- We retain no imagery and no position history beyond a short operational cache used to stay
  inside upstream rate limits.
- Our outbound request log records that a connector was called and whether it succeeded. It does
  not record you, your query, a bounding box, a camera identifier, or any response body.

**Live means live.** There is no archive here, by design.

### 4.5 Third-party terms bind you too

Every Live source belongs to someone else. Where a source requires attribution, we render it.
Where an operator changes its terms or asks us to stop, we can disable that source without a
deploy, and we will.

When you click to load a camera, you are making a request to that operator and their terms apply
to you as well as to us.

## 5. Prohibited uses

You must not use {{BRAND_NAME}} — including its catalogue, its playbooks and its workspaces — for
any of the following.

### 5.1 Harassment, stalking and targeting individuals

- Researching, monitoring or compiling information about a person in order to harass, intimidate,
  threaten, humiliate, dox or stalk them.
- Locating or attempting to locate a person who has taken steps to avoid you, including a former
  partner, a person protected by a restraining or non-molestation order, a survivor of domestic
  abuse, or a person in a witness-protection or safeguarding arrangement.
- Compiling a dossier on a private individual without a legitimate investigative, journalistic,
  academic, safeguarding or compliance purpose.
- Any research about a person for the purpose of, or that is reasonably likely to result in,
  physical harm to them.

This is the first prohibition in the list because it is the one that matters most. The techniques
in our playbooks work as well for an abuser as for a journalist, and we will not knowingly serve
the former.

### 5.2 Unlawful surveillance

- Surveillance or monitoring of individuals in breach of applicable surveillance, interception,
  privacy or data protection law.
- Covert monitoring of employees, tenants, students or others in breach of the law or of a duty
  you owe them.
- Use by or on behalf of a state actor to identify, locate or build profiles of journalists,
  human-rights defenders, dissidents, activists, lawyers or their sources.
- Biometric identification of individuals, including facial recognition and face matching, where
  that processing is unlawful in your jurisdiction or the subject's.

### 5.3 Circumventing access controls

- Using {{BRAND_NAME}} to plan, coordinate or document unauthorised access to any computer
  system, network, account or data.
- Bypassing authentication, paywalls, rate limits, robots.txt directives, IP blocks, CAPTCHAs or
  any other access control on a third-party system.
- Scraping, mirroring or automated collection from any system in breach of that system's terms of
  service or published access rules.
- Any activity that would constitute an offence under the US Computer Fraud and Abuse Act, the UK
  Computer Misuse Act 1990, EU Directive 2013/40/EU as implemented, or an equivalent law
  applicable to you.

The line between open-source intelligence and computer misuse is access control. We take it
seriously, and so should you.

### 5.4 Misuse of the service itself

- Automated scraping of the {{BRAND_NAME}} catalogue or playbooks, or systematic extraction of
  the content, other than through an interface we provide for that purpose.
- Republishing the catalogue or playbooks in substantial part as your own product.
- Attempting to access another user's workspace, notes or account.
- Probing, scanning or testing the security of {{BRAND_NAME}} infrastructure without our prior
  written permission. Good-faith security research is welcome under section 6.
- Uploading to a workspace any material that is unlawful for you to possess, including
  breached-credential dumps, child sexual abuse material, or material whose possession is
  prohibited in your jurisdiction.

### 5.5 Misuse of the Live surfaces

The Live surfaces show places and vehicles. They must not be used to watch people.

- **Do not use Live to monitor, locate or track an identifiable individual**, or to infer where a
  specific person is, has been, or will be. That includes tying an aircraft to a named person and
  following it, and it includes watching a camera that overlooks a particular person's home,
  workplace, place of worship, or a location they are known to attend.
- **Do not use Live to build a movement history of any person.** We keep no such history and you
  must not construct one from what we display.
- **Do not use Live to support harassment, stalking or intimidation** of anyone, whether or not
  they are identifiable from the imagery itself. Section 5.1 applies in full here.
- **Do not use Live to observe an individual in a place where they have a reasonable expectation
  of privacy**, even if a published camera happens to overlook it. That a feed is lawfully
  published does not make every use of it lawful.
- **Do not attempt to reach a camera we did not list**, including by modifying a feed URL,
  enumerating identifiers, or using a scanning service to find unpublished devices. Section 5.3
  governs this and it is the same offence whether or not the device has a password.
- **Do not scrape, re-host, archive or redistribute** imagery or aircraft data obtained through
  Live. Those feeds belong to their operators and their licences bind you.

Aggregate, place-based use — checking conditions at a junction, corroborating weather at a time,
observing traffic state, watching an airport's movements — is what these surfaces are for. The
moment the object of interest becomes a person rather than a place, you are outside this policy.

### 5.6 Storing what we will not hold

Workspaces are for **your own notes, your own analysis and your own tool selections**. You must
not use a workspace as a database of investigation subjects — a structured collection of records
about identified private individuals maintained as an ongoing resource rather than as notes on a
specific piece of work.

This is not squeamishness about your research. If our systems become the store of record for
dossiers on people who never contacted us, we acquire controller obligations toward those people
that we cannot discharge, and so do you.

## 6. Enforcement

We may suspend or terminate access, with or without notice depending on severity, where we
reasonably believe this policy has been breached. Where the breach involves a credible risk of
harm to a person, we will act immediately and will not wait for a response from you.

Reports of misuse go to {{BRAND_CONTACT_LEGAL}}. Include the account or content concerned and
enough detail for us to assess it. We investigate every report we can act on.

We are a small operation and we do not run automated surveillance of workspace contents to detect
breaches — see the [Privacy Notice](/legal/privacy) for what we do and do not look at. In
practice we act on reports, on legal process, and on what is visible from ordinary operation of
the service.

Where we terminate an account for a breach of section 5.1, 5.2 or 5.5, we may decline to provide
an export of the account's contents where doing so would facilitate further harm.

Enforcement against Live misuse has a practical limit we should state honestly rather than imply
otherwise: because we keep no record of which cameras or aircraft anyone viewed (section 4.4), we
generally cannot detect a breach of section 5.5 from our own systems. We act on reports and on
legal process. We consider that trade worth making — a viewing log would be a far greater danger
to the many lawful users of this service than its absence is a shield for the few unlawful ones.

## 7. Security research

We welcome good-faith security research on {{BRAND_NAME}}. If you intend to test our systems,
contact {{BRAND_CONTACT_SECURITY}} first and follow the coordinated-disclosure terms set out in
the [Terms of Service](/legal/terms). Research conducted within those terms is not a breach of
section 4.4.

## 8. Changes

We will update this policy as the service changes or as our understanding improves. Material
changes will be notified to registered users by email at least 14 days before they take effect,
and the effective date above will be updated. Continued use after the effective date constitutes
acceptance.

## 9. Contact

- Misuse reports and policy questions: {{BRAND_CONTACT_LEGAL}}
- Privacy and data protection: {{BRAND_CONTACT_PRIVACY}}
- Security: {{BRAND_CONTACT_SECURITY}}
