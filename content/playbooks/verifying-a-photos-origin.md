---
slug: verifying-a-photos-origin
title: "Verifying a Photo's Origin"
summary: "Establish where a photograph came from, when it first appeared online, and whether it depicts what it is claimed to depict."
difficulty: beginner
category: image-and-video-verification
estimatedMinutes: 45
tags: [verification, reverse-image-search, metadata, provenance, debunking]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Preserve the image before you touch it"
    objective: "Create an unaltered working copy and a record of where you found it, so that nothing you do afterwards can be said to have changed the evidence."
    doneWhen: "You hold an original-quality file, a hash of it, an archived copy of the page it appeared on, and a note of the date and time you collected it."
    tools:
      - slug: hunchly
        note: "Captures the page, screenshot and hash automatically as you browse, which is the difference between evidence and a screenshot."
      - slug: wayback-machine
        note: "Independent third-party archive of the source page — a capture you did not make yourself carries more weight than one you did."
      - slug: archive-today
        note: "Second archive that renders dynamic and social pages more faithfully; two independent captures are much stronger than one."
    body: |
      Download the largest version of the image you can obtain. On most platforms the version
      displayed inline is a re-compressed derivative; open the image in its own tab or use the
      platform's full-size view. A derivative has already lost the metadata and compression
      characteristics you may later need.

      Compute a hash of the file immediately (`sha256sum` on Linux and macOS, `certutil -hashfile
      <file> SHA256` on Windows) and write it in your notes with the date, time and time zone.
      This does not prove where the image came from. It proves that the file you analyse on day
      one and the file you publish about on day thirty are the same file, which is the claim
      most likely to be attacked.

      Archive the page the image appeared on, not just the image. Context — the caption, the
      account, the timestamp, the replies — is evidence, and it is what disappears first when a
      post is edited or deleted.

      Record where you got it in a form another person could follow: full URL, account handle,
      post identifier, and the time you saw it. "Found on Twitter" is not provenance.

  - order: 2
    title: "Read the metadata locally"
    objective: "Extract any embedded capture information — device, timestamp, GPS, editing history — without disclosing the image to a third party."
    doneWhen: "You have run a full metadata extraction and recorded either the fields present or the explicit finding that metadata is absent."
    tools:
      - slug: exiftool
        note: "Runs entirely on your own machine, so a sensitive or source-provided image is never uploaded anywhere."
      - slug: jeffreys-exif-viewer
        note: "Browser fallback when you cannot run a local tool — but it uploads the image, so never use it for sensitive material."
    body: |
      Run `exiftool -a -u -g1 image.jpg` to see every field including duplicated and unknown
      tags grouped by category. Look for capture date and time, camera make and model, lens,
      GPS coordinates, software strings, and the relationship between the various date fields.

      Interpret what you find with discipline:

      - **Metadata present and coherent** is a lead, not a conclusion. Every field can be
        written by ExifTool itself in seconds. A camera clock can be wrong, unset, or in a
        different time zone from the events depicted.
      - **Metadata absent** is the normal case and means nothing at all. Facebook, Instagram,
        X, WhatsApp and most other platforms strip metadata on upload. Absence tells you the
        image probably passed through a platform, which you already knew.
      - **Metadata that is suspiciously helpful** — a precise GPS fix and timestamp that
        exactly support the claim being made — deserves more scrutiny, not less. Ask why this
        particular file retained what almost every other file loses.

      Record the negative result explicitly. "No EXIF present" written in your notes on the
      date you checked is a finding. An empty space in your notes is an unanswered question
      that you or someone else will waste time re-asking.

  - order: 3
    title: "Reverse search across multiple engines"
    objective: "Find earlier appearances of the same image, which is the single most effective test of a 'this just happened' claim."
    doneWhen: "You have searched at least three engines and recorded, for each, either the earliest dated appearance found or an explicit null result."
    tools:
      - slug: tineye
        note: "Sort by oldest — this directly answers 'has this appeared before?' and is the highest-value single query in the whole workflow."
      - slug: google-lens
        note: "Semantic matching finds the same scene photographed differently, and reads text in signage."
      - slug: yandex-images
        note: "Frequently finds matches the others miss, particularly for Eastern European content. Weigh the operator-jurisdiction caution before using it."
      - slug: invid-weverify-plugin
        note: "Fires one image at several engines in a single action, which makes multi-engine search fast enough that you actually do it."
    body: |
      Search all three engines. They index different corpora and match on different principles,
      and the one you skip is the one that had the answer. TinEye is literal and precise;
      Google Lens is semantic and will find a different photograph of the same building;
      Yandex is aggressive and finds things the others do not.

      Two techniques materially improve results:

      **Crop and re-search.** If the image has a distinctive element — a shopfront, a vehicle,
      a banner, a building facade — crop to it and search the crop alone. This defeats the
      cropping and overlay that people apply to recycled images specifically to break reverse
      search.

      **Search the derivative and the original.** If you have both a platform-compressed copy
      and a higher-quality one, search both. They fingerprint differently and return different
      results.

      **What a negative result means.** Nothing much. Reverse image search has poor recall on
      heavily edited, cropped, re-compressed or recently published images, and none of these
      engines indexes closed platforms such as WhatsApp, Telegram or Signal, where a great deal
      of imagery actually circulates. "I could not find an earlier version" is not "this is
      original". Write it as the former.

      **What a positive result means.** If you find the image published before the event it is
      claimed to depict, you are done — that is a conclusive debunk, provided you have
      confirmed the earlier page's date independently rather than trusting a search engine's
      summary. Open the page, archive it, and check its date against the archive's own capture
      history.

  - order: 4
    title: "Test the content against the claim"
    objective: "Check whether what is visible in the image is consistent with the place, season, time and circumstances asserted."
    doneWhen: "You have listed the checkable claims the image makes and marked each as consistent, inconsistent, or untestable."
    tools:
      - slug: google-lens
        note: "Reads and translates signage, and identifies landmarks, vehicles and products."
      - slug: google-earth-pro
        note: "Historical imagery slider confirms whether the built environment matched the claimed date."
    body: |
      Write down what the image asserts, then test each assertion separately. Typical checkable
      claims:

      - **Language and script** on signs, plates and packaging. Does it match the claimed
        country? Translate it — a sign naming a business is a searchable string.
      - **Vehicles**, their registration plate formats, and which side of the road they drive
        on.
      - **Season and vegetation.** Foliage, snow cover and crop state constrain the date range,
        often to within a couple of months.
      - **Weather**, if a specific day is claimed. It is checkable against historical records.
      - **Clothing and infrastructure**, which date an image loosely but can rule out a claimed
        decade.
      - **Built environment.** If a building visible in the image was demolished in 2019, the
        photograph is not from 2024.

      The discipline that matters here is to look for what would falsify the claim, not for
      what confirms it. Confirmation bias is the dominant failure mode in verification work,
      and it is strongest when the image supports something you already believe. Before you
      finish this step, ask yourself explicitly: what would I expect to see if this image were
      genuine, and is it there? And: what would I expect to see if it were recycled, and have I
      looked for that?

  - order: 5
    title: "Use forensic filters carefully, if at all"
    objective: "Identify regions worth closer examination — while refusing to treat filter output as evidence of manipulation."
    doneWhen: "You have either found a specific anomaly you can explain in plain language, or recorded that the filters showed nothing conclusive."
    tools:
      - slug: forensically
        note: "Runs client-side in your browser, so the image is not uploaded — the safer choice for sensitive material."
      - slug: fotoforensics
        note: "Better JPEG and quantisation-table analysis, but uploads are retained and may be public. Never use it for anything confidential."
    body: |
      Read this before running anything: **error level analysis does not detect manipulation.**
      It visualises compression artefacts, which are affected by editing and equally by
      resizing, re-saving, screenshotting and every platform's own processing pipeline. Any
      image that has been through social media will show anomalies that mean nothing at all.
      ELA has a long public history of confident, wrong accusations of forgery, made by people
      who saw a bright region and stopped thinking.

      Use these tools for one purpose: to direct your attention. If clone detection highlights
      a region, go and look at that region at high magnification and ask whether the scene
      makes physical sense there — do shadows fall consistently, do edges align, does the
      perspective hold, is a repeated texture natural or pasted?

      A manipulation claim needs evidence of a different kind entirely: an earlier unmodified
      version of the image, a provable internal inconsistency in the scene, or an admission.
      If you have none of those, you have not established manipulation, however suggestive the
      filter output looked. Say so.

      The JPEG quantisation-table analysis is the more useful part of this step. If an image
      presented as straight from a phone carries the encoder signature of a desktop editor,
      that is a concrete provenance discrepancy that needs explaining — and it is a much
      stronger observation than any ELA heat map.

  - order: 6
    title: "Trace the earliest publication and the uploader"
    objective: "Identify the earliest verifiable appearance of the image and assess whether that account is a plausible original source."
    doneWhen: "You have named an earliest known appearance with an archived, dated citation, and assessed the account's history — or documented that the earliest source cannot be established."
    tools:
      - slug: wayback-machine
        note: "Confirms when a page first carried the image and whether the page was later edited."
      - slug: social-blade
        note: "Account growth history distinguishes an established local account from one created last week."
      - slug: x-advanced-search
        note: "Date-bounded search finds the earliest posts of an image in the hours around an event."
    body: |
      Work backwards. For each appearance you found, look at who posted it and when, and
      whether they credit anyone. Follow credits to their source. Repeat until the chain stops.

      Assess the earliest account you reach:

      - When was it created, and does its history predate its interest in this topic?
      - Does it post original material, or only reshare?
      - Is its stated location consistent with its posting times and language?
      - Did its follower count jump suddenly, which suggests amplification rather than
        organic reach?

      The most common outcome of this step is honest failure. Images spread through closed
      messaging apps before surfacing publicly, so the earliest public post is frequently not
      the origin and the origin is not discoverable from open sources. When that happens,
      write down the earliest verifiable appearance and state plainly that the origin is
      unestablished. That is a legitimate and complete result. Guessing at an origin because
      you need one for the story is how verification fails.

      Where you can reach an apparent original poster, consider whether contacting them is
      appropriate. That is a reporting decision with real consequences: it tells them they are
      being investigated, and in some contexts it puts them at risk. It also leaves the domain
      of open-source verification, so record it separately in your notes.
---

# Verifying a Photo's Origin

A photograph arrives attached to a claim: this is a strike on that city, this is the aftermath of
that protest, this is the person who did it. The claim travels faster than anyone can check it,
and by the time it is checked the claim has been repeated by people who will not read the
correction.

This playbook is the standard sequence for establishing what can actually be known about a still
image. It will frequently not tell you where the photograph came from. It will very often tell
you whether it came from where someone says it did, and that is usually the question that
matters.

The method rests on one distinction that separates open-source verification from informed
guessing: **what the evidence establishes** and **what you believe**. Those diverge constantly.
This process is designed to keep them apart on the page.

## Before you start

**Your legal footing.** Everything in this playbook operates on material that was published to
you or that you already hold. Reading metadata from a file in your possession, searching public
indexes, and consulting archives are ordinary lawful acts. Two things change that character:
uploading someone else's image to a third-party service is a disclosure you are responsible for,
and using facial similarity search to identify a person in a photograph engages biometric
data-protection law in the EU, the UK and several US states. This platform does not do face
matching and this playbook does not include it. If identifying a person is your objective, take
legal advice before you start, not after.

**Your ethical footing.** Photographs contain bystanders. Verifying an image of an atrocity may
mean handling material depicting identifiable victims who never consented to being evidence.
Decide before you begin what you will publish, what you will hold but not publish, and what you
will not retain at all. Decide it in advance, because the pull toward publishing everything you
found is strongest at the end.

**Your own security.** Reverse image search discloses the image to the search operator. Fetching
a page discloses your interest to its host. If the subject of your investigation would react
badly to knowing you are looking, use a research browser profile, consider Tor, and prefer local
tools over hosted ones. The Tradecraft & OPSEC category in the directory covers this properly.

**Recording provenance of your own work.** Your notes are evidence too, and they will be read by
an editor, a lawyer, or a hostile party. From the first minute, record for every step: what you
did, which tool and version, what you searched for, what came back, the date and time, and — this
is the part people skip — **what did not come back**. A verification log full of positive
findings and silent about the dead ends is not a record of an investigation. It is a record of an
argument.

## Corroboration and how not to fool yourself

Three rules that make the difference between verification and confident error:

1. **Two independent sources, genuinely independent.** Three websites repeating one agency wire
   is one source. Before counting a corroboration, trace it back and ask where it originally
   came from.

2. **Negative results are results.** "TinEye returned nothing" and "no EXIF present" belong in
   your notes with dates. They constrain the conclusion, they stop the same ground being covered
   twice, and they are what an editor needs to see to know how thorough you were.

3. **State your confidence in the language of what you actually established.** There is a real
   difference between *this image was published in 2019 and therefore does not show yesterday's
   event*, *this image is consistent with the claimed location but I could not confirm the date*,
   and *I could not establish anything about this image*. All three are publishable. Only the
   first is a debunk.

## Writing it up

Structure the finding so a reader can check you rather than trust you:

- **The claim**, stated exactly as it was made, with an archived link.
- **What you established**, each point with its evidence, its source, and the date you obtained
  it.
- **What you could not establish**, listed explicitly. This is the section that earns the rest
  its credibility.
- **Your conclusion**, in calibrated language — *verified*, *consistent with*, *unverified*, or
  *false* — with the reasoning that separates it from the alternatives.
- **Method**, briefly: which tools, which searches, so another researcher can reproduce it.

## What would falsify this

Before publishing, write down what would prove you wrong, and check whether you looked for it:

- An earlier publication of the image that your searches missed — which is likely, because
  reverse image search has poor recall.
- An original file with metadata contradicting your conclusion, held by someone you have not
  spoken to.
- A photographer or agency who can account for the image directly.
- A mundane explanation for the anomaly you built your case on: a re-save, a crop, a platform
  transcode.

If you cannot name what would falsify your conclusion, you have not tested it. Go back.
