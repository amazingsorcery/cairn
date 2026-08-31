---
slug: investigating-a-domain-and-its-infrastructure
title: "Investigating a Domain and Its Infrastructure"
summary: "Map what sits behind a domain — DNS, certificates, hosting, history and related infrastructure — using passive sources that never touch the target."
difficulty: intermediate
category: domain-and-infrastructure
estimatedMinutes: 90
tags: [domain, dns, passive-recon, certificates, pivoting, phishing, attribution]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Decide your posture before you touch anything"
    objective: "Establish whether this investigation is passive-only, and set up so that no tool silently makes an active request to the target."
    doneWhen: "You have written down your posture, and configured your browser and tools accordingly."
    tools:
      - slug: tor-browser
        note: "If the target must not learn you are looking, every direct fetch of their site should be through Tor, or not at all."
      - slug: hunchly
        note: "Start capture before the first lookup — evidence you collect from the second query onward has a gap in front of it."
    body: |
      This decision comes first because it cannot be taken back. Once the target's logs contain
      your address, no later care undoes it.

      **Passive** means you only query third-party datasets that already collected the
      information: certificate transparency logs, passive DNS, scan indexes, archives. The
      target learns nothing.

      **Active** means you send traffic that reaches the target's infrastructure: resolving
      their DNS, loading their website, running a scanner, submitting a URL to a service that
      fetches it. This appears in their logs.

      Two things people get wrong constantly:

      - **urlscan.io and similar services are active.** The scan is performed from the
        service's infrastructure, but the request still reaches the target and appears in its
        logs with a recognisable signature and a timestamp. An attentive operator sees it.
      - **Automated toolkits blur the line.** Amass and SpiderFoot both offer passive profiles
        and both will happily run active enumeration if you pass the wrong flags. Know which
        mode you are in before you run them, not afterwards.

      There is also a legal dimension. Passive lookups are unambiguously lawful. Active
      scanning, brute-force subdomain resolution and probing of a target you have no
      authorisation to test can engage the UK Computer Misuse Act, the US CFAA and their
      equivalents. If you have no authorisation, stay passive. That is not timidity; it is the
      line the law actually draws.

      Start your evidence capture now, before the first query.

  - order: 2
    title: "Establish registration facts and history"
    objective: "Record the domain's current registration and, critically, what it used to say before privacy protection was applied."
    doneWhen: "You have current registrar, nameservers, creation and expiry dates, and have searched for historical registrant records."
    tools:
      - slug: securitytrails
        note: "Historical WHOIS is the single most common route to attributing a domain that is now privacy-protected."
      - slug: viewdns-info
        note: "Quick reverse-WHOIS and IP-history pivots without an account."
    body: |
      Current WHOIS on most gTLDs is redacted under GDPR, so the current record usually tells
      you little beyond registrar, nameservers and dates. Those dates still matter: a domain
      created three days before the campaign that uses it is a finding in itself.

      **The history is where the value is.** Operators very frequently register a domain with
      real details and enable privacy later, and the original record persists in historical
      datasets. This is how a large proportion of anonymous domains get attributed.

      Look for, and record with dates:

      - Registrant name, organisation, email, phone and address at each historical point.
      - Nameserver changes, which often mark a change of operator or hosting.
      - Registrar changes, which sometimes follow an abuse complaint.
      - Gaps in registration, indicating the domain lapsed and was re-registered — possibly by
        an entirely different party, which is a trap when reading old data.

      Then pivot on anything you find. A registrant email or a distinctive organisation string
      can be run through reverse-WHOIS to find every other domain registered with it, which is
      frequently how a single domain becomes a network.

      **Caution that must not be skipped.** Registrant details are self-asserted at
      registration and are routinely fabricated. A name in historical WHOIS is a lead requiring
      corroboration, never an identification. It is also personal data: under GDPR you are
      processing it, and publishing a registrant's home address is a separate and higher-risk
      decision from using it as a lead.

  - order: 3
    title: "Enumerate the DNS and certificate surface"
    objective: "Discover the hostnames associated with the domain, including those never intended to be public."
    doneWhen: "You have a deduplicated hostname list from at least two independent passive sources, with each name's resolution status recorded."
    tools:
      - slug: crt-sh
        note: "Certificate transparency is append-only and public — a wildcard query returns every hostname ever certificated, with first-seen dates."
      - slug: subfinder
        note: "Passive-only by design, aggregating many sources without ever touching the target."
      - slug: dnsdumpster
        note: "Fast orienting view of records and hosting relationships."
      - slug: owasp-amass
        note: "The most thorough option — but run it in passive mode unless you have authorisation to test."
    body: |
      Certificate transparency first. A search for `%.example.com` on crt.sh returns every
      hostname that has appeared in a publicly trusted certificate for that domain: staging
      servers, admin panels, VPN endpoints, internal-sounding hosts and development
      environments that nobody meant to publish.

      Two properties make CT especially valuable. It is append-only, so it is a historical
      record — the first-seen date of a hostname tells you when infrastructure was stood up,
      which is often how an operation gets dated. And it cannot be retrospectively cleaned;
      removing a DNS record does not remove the certificate log entry.

      Cross-check with at least one other passive source, because CT misses anything that never
      got a public certificate — internal CAs, self-signed hosts, and names that never had TLS.

      Then **resolve every discovered name and record the result**. CT and passive DNS both
      return large numbers of hostnames that no longer resolve or never did. A hostname is not
      a host. Stating "the organisation has 340 subdomains" on the strength of an unresolved
      enumeration list is a common and embarrassing error.

      Record the negative results too: names found but not resolving, and sources that returned
      nothing. A source returning nothing may mean the source is broken rather than the data
      absent — check it against a domain you know it covers.

  - order: 4
    title: "Map the hosting and look at what is exposed"
    objective: "Identify where the infrastructure sits and what services it presents, using scan indexes rather than your own scanner."
    doneWhen: "You have IPs, ASNs, hosting providers and observed services with the dates those observations were made."
    tools:
      - slug: shodan
        note: "Searchable index of banners, certificates and favicon hashes — the primary passive pivot surface."
      - slug: censys-search
        note: "Stronger structured certificate search; use as an independent second observation."
      - slug: zoomeye
        note: "Different scanner, different vantage points — sometimes holds records the others missed. Weigh the operator-jurisdiction caution."
    body: |
      Query the scan indexes rather than scanning yourself. You get the same information
      without generating traffic to the target and without the legal exposure.

      For each IP, record the ASN and hosting provider, the observed open ports and service
      banners, TLS certificate details, HTTP response headers and any server-identifying
      strings, and — this is the part people omit — **the date each observation was made**.
      Every scan record is a statement about a past moment. Presenting a three-month-old banner
      as the current state of a host is simply wrong.

      Watch for the structural facts that shape everything downstream:

      - **A CDN or reverse proxy in front** means the IP you see is the CDN's, not the origin's,
        and most of what follows tells you about the CDN. Note it explicitly.
      - **Shared hosting**, where hundreds of unrelated sites share the address. On shared
        hosting, co-location proves nothing.
      - **A dedicated host with a small number of thematically related domains.** This is the
        interesting case and is a genuine lead.
      - **Bulletproof or abuse-tolerant hosting**, which is itself a finding about the
        operator's intent.

      Look at more than one index. Different scanners have different schedules and vantage
      points, and agreement between them across an overlapping window is much stronger than any
      single observation.

  - order: 5
    title: "Pivot to related infrastructure"
    objective: "Find other infrastructure operated by the same party through shared technical artefacts."
    doneWhen: "You have a candidate set of related hosts and domains, each with the specific shared artefact that links it and an assessment of how discriminating that artefact is."
    tools:
      - slug: shodan
        note: "Pivot on favicon hash, certificate fingerprint, or a distinctive banner string to find every host sharing it."
      - slug: censys-search
        note: "Certificate-led pivoting: find every host that ever presented the same certificate or self-signed CA."
      - slug: urlscan-io
        note: "Search the historical scan archive for pages sharing a script, form action or favicon — the standard way to map a phishing campaign."
      - slug: securitytrails
        note: "Reverse lookups: every domain that ever resolved to this IP, or was registered to this email or nameserver."
    body: |
      Pivoting is where infrastructure investigation earns its keep, and where it most often
      goes wrong. The whole game is the **discriminating power** of the artefact you pivot on.

      **Strong pivots** — a specific and unusual artefact:

      - A shared TLS certificate or a self-signed CA with a distinctive subject.
      - A favicon hash, where the favicon is custom rather than a framework default.
      - An unusual banner string, a specific software build, or a distinctive HTTP header.
      - A shared registrant email in historical WHOIS.
      - A tracking or analytics identifier shared across sites.

      **Weak pivots** — something millions of hosts share:

      - Same hosting provider or ASN.
      - Same nameservers, when they are a large registrar's default.
      - Same country, same CDN, same common software version.
      - A default favicon shipped with a framework. This one catches people constantly: pivoting
        on a stock WordPress or Bootstrap favicon returns millions of unrelated hosts.

      For each candidate link, write down the artefact and ask: **how many hosts on the internet
      share this?** If the answer is large or unknown, it is not a link, and you can usually
      check by counting the result set. Two sites sharing a certificate with a unique
      fingerprint is strong evidence of common operation. Two sites on Cloudflare is not
      evidence of anything.

      Corroborate a candidate link with a second independent artefact before you assert a
      relationship. One shared artefact is a hypothesis; two unrelated ones is a finding.

  - order: 6
    title: "Reconstruct the history"
    objective: "Establish what the domain hosted over time and when it changed, using archives and historical data."
    doneWhen: "You have a dated timeline of registration, DNS, hosting and content changes, with each entry sourced."
    tools:
      - slug: wayback-machine
        note: "The CDX API exposes the full capture history, which shows when content changed without reading every snapshot."
      - slug: archive-today
        note: "Renders dynamic pages more faithfully; useful where Wayback captured only a shell."
      - slug: securitytrails
        note: "Historical DNS shows when hosting moved, which frequently coincides with a change of operator."
    body: |
      Build one timeline combining every dated fact you have gathered:

      - Domain creation, expiry, lapse and re-registration.
      - Registrant changes from historical WHOIS.
      - Nameserver and A-record changes from historical DNS.
      - First-seen dates of hostnames from certificate transparency.
      - Content changes from web archive captures.
      - First and last observation dates from scan indexes.

      Convergence across these is what makes a finding solid. If the registrant changed, the
      nameservers changed, and the site content changed within the same fortnight, that is a
      change of operator with three independent supporting sources. Any one alone is
      suggestive; together they are close to conclusive.

      Use the Wayback CDX API rather than clicking through snapshots — it lists every capture
      with timestamps and content digests, so you can see immediately when the page actually
      changed rather than when it happened to be crawled.

      **Read the gaps carefully.** No captures for a period does not mean the site was down; it
      usually means nobody crawled it. Absence of evidence in archives is weak evidence of
      anything, and it is the most frequently over-read signal in this whole workflow.

  - order: 7
    title: "Check reputation and known-campaign data"
    objective: "Determine whether the infrastructure is already documented as malicious, and by whom, without over-reading community reports."
    doneWhen: "You have searched the major reputation and threat-intelligence sources and traced any attribution claim back to its original source."
    tools:
      - slug: virustotal
        note: "Relationship data — files that contacted the domain, other domains on the IP — is the real value. Search by indicator; never upload files casually."
      - slug: urlhaus
        note: "Whether the domain has been reported distributing malware, with dates."
      - slug: threatfox
        note: "Whether it is a reported indicator of compromise for a named campaign, with an explicit confidence level."
      - slug: levelblue-otx
        note: "Community pulses may already document the campaign — but check who wrote them and whether their references are real."
    body: |
      Search the domain, each IP and each hostname across the reputation sources. Record hits
      with their dates and confidence values, and record clean results too.

      Then apply the scepticism this data requires:

      - **Trace attribution to its origin.** Threat intelligence copies itself relentlessly.
        Five sources naming the same actor commonly derive from one original report, and that
        gives a false impression of corroboration. Follow references until you reach the
        primary claim, then assess that one.
      - **Malware family names are inconsistent** across vendors. Two names may be the same
        thing; one name may cover two things.
      - **Indicators go stale fast.** Infrastructure is reused, and an IP that hosted a
        command-and-control server last year may be an innocent shared host today. Always read
        the first-seen date and ask what has changed since.
      - **Compromise is not complicity.** A legitimate business whose server was hacked appears
        in these datasets identically to a criminal operator. Publishing that a company's server
        "was malware infrastructure" without establishing which of those it was is defamatory
        and unfair.
      - **A clean result means very little.** These sources are samples, not censuses. Absence
        is not exoneration.

      On VirusTotal specifically: search by domain, IP and hash. Do not upload files. Uploaded
      files are shared with the security industry and have repeatedly caused confidential-data
      exposure.
---

# Investigating a Domain and Its Infrastructure

A domain is the most common starting point in a technical investigation. A phishing site, a
disinformation outlet, a scam storefront, a company whose real operator you need to establish —
all of them begin as a name, and behind that name sits a technical footprint that its operator
usually managed less carefully than the front-facing content.

This playbook works that footprint from the outside in, using passive sources by default. The
central skill is not running the tools; it is judging how much any given observation actually
supports, and being willing to say "these two things are on the same hosting provider, which
means nothing."

## Before you start

**Your legal footing.** Passive lookups against third-party datasets — certificate transparency,
passive DNS, scan indexes, archives — are unambiguously lawful and invisible to the target.
Active reconnaissance is a different act. Resolving a target's hosts at volume, brute-forcing
subdomains, port scanning, or probing an application sends traffic to infrastructure you do not
own, and depending on jurisdiction and effect can engage the UK Computer Misuse Act, the US
Computer Fraud and Abuse Act, or their equivalents. Intent is not always the test; effect matters
too. **If you do not have written authorisation to test the infrastructure, stay passive.**

The same principle applies to anything you fetch: respect robots.txt, honour published rate
limits, and do not circumvent access controls. That is the line between open-source intelligence
and computer misuse, and it does not move because the target is unsympathetic.

**Your ethical footing.** Historical WHOIS contains real people's names, addresses and phone
numbers. Domain registration data can identify an individual behind a pseudonymous site,
including people with legitimate reasons for pseudonymity — dissidents, whistleblowers, abuse
survivors. Before you unmask anyone, be clear about the public interest, and be clear that a name
in a WHOIS record is an unverified self-assertion, not an identification.

**Your own security.** Your queries reveal your interest. Commercial services log lookups against
your account. Fetching the target's site puts your address in its logs. urlscan.io scans on
public visibility are permanently searchable by anyone — including the target. If discretion
matters, use a research browser profile, prefer passive sources, use non-public scan visibility,
and consider Tor for any direct fetch.

**Recording provenance of your own work.** Infrastructure changes daily. A finding without a
timestamp is not reproducible and may be actively misleading three weeks later. For every
observation record the source, the query, the result and the date and time. Capture the page.
When you eventually write "as of 12 August 2026, the domain resolved to…", that sentence is only
defensible if you have the capture behind it.

## Corroboration and how not to fool yourself

Infrastructure investigation has a characteristic failure: **the confident graph**. Pivoting
produces a large connected component very quickly, it looks like a discovery, and most of the
edges are shared hosting.

1. **Weigh every pivot by how many hosts share the artefact.** A unique certificate fingerprint
   is strong. A default framework favicon is worthless. Where you can, count the result set
   before you rely on the link.

2. **Require two independent artefacts** before asserting that two pieces of infrastructure share
   an operator.

3. **Date every observation.** Scan data, DNS records and reputation entries are all snapshots.
   Two hosts sharing an IP six months apart were not necessarily ever related.

4. **Record negatives.** "No historical WHOIS available", "CT returned nothing for this domain",
   "not present in URLhaus as of this date" — all findings, all worth writing down, all things
   you will otherwise re-check.

5. **Distinguish the operator from the infrastructure.** Compromised servers, resold IPs, shared
   CDNs and abandoned domains all produce technical links between parties with no relationship.

## Writing it up

Structure the finding as: what the domain is, what the technical evidence establishes, what it
suggests but does not establish, and what could not be determined.

For every technical claim give the observation, its source and its date. For every asserted
relationship give the shared artefact and why that artefact is discriminating — this is the part
a technically literate reader will attack, so make it explicit rather than making them ask.

Separate the technical finding from the attribution claim. "These twelve domains share a
certificate and were registered within six days of each other through the same registrar" is a
technical observation you can defend. "These domains are operated by [named party]" is an
attribution requiring a different and higher standard of evidence, usually including non-technical
corroboration.

## What would falsify this

- The shared artefact you pivoted on turns out to be a default value present on millions of
  hosts.
- The IP is shared hosting or a CDN edge, making co-location meaningless.
- The historical WHOIS registrant details were fabricated at registration — which is common and
  which you generally cannot rule out.
- The domain lapsed and was re-registered by an unrelated party, making pre-lapse and post-lapse
  data belong to different operators.
- The infrastructure was compromised rather than operated by the party you identified.
- Your observations come from different dates and were never simultaneously true.

If you have not checked these, you have a hypothesis about infrastructure, not an attribution.
Publish it as the former.
