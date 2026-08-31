---
slug: verifying-a-viral-videos-authenticity-and-timeline
title: "Verifying a Viral Video's Authenticity and Timeline"
summary: "Establish whether a rapidly spreading video is genuine, when it was actually filmed, and whether it shows the event it is attached to."
difficulty: advanced
category: image-and-video-verification
estimatedMinutes: 180
tags: [video-verification, chronolocation, geolocation, disinformation, recycled-footage, provenance]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Capture the video and its context before it disappears"
    objective: "Secure the highest-quality copy available, its platform metadata, and an archived record of every post carrying it."
    doneWhen: "You hold the best-quality file, its hash, the platform metadata as JSON, and archived captures of the posts you found it on."
    tools:
      - slug: yt-dlp
        note: "Preserves the original encode plus upload timestamp, description and comments as structured JSON — a screen recording destroys all of it."
      - slug: wayback-machine
        note: "Independent third-party capture of the post page, which carries more weight than your own screenshot."
      - slug: archive-today
        note: "Renders social posts more faithfully than Wayback; use both, they fail differently."
      - slug: hunchly
        note: "Captures every page you touch with timestamps and hashes, building the chain of custody for the whole investigation."
    body: |
      Speed matters more here than in any other verification task. Viral videos are deleted,
      edited, made private and geo-restricted within hours, frequently by the person who
      benefits from them being unexaminable.

      Download the highest-quality version available with `yt-dlp --write-info-json
      --write-comments --write-thumbnail <url>`. Never screen-record. A re-encode destroys the
      compression characteristics that any later forensic work depends on, discards the
      container metadata, and produces a file whose provenance is you rather than the platform.

      Hash the file immediately and record the hash, the date, the time and the time zone.

      Capture the surrounding context, because it disappears with the video and is often more
      informative than the footage:

      - The full post text, in the original language.
      - The account: handle, display name, bio, creation date, follower count at the moment you
        looked.
      - Engagement figures at capture time.
      - **The comments.** In a substantial proportion of cases someone in the replies names the
        location, identifies the footage as old, or links the original. Comments are the single
        most under-used verification resource on the internet.
      - Quote posts and reshares, which show how the claim mutated as it spread.

      Archive every post page in two independent archives. Then work from your local copy so
      that a takedown does not end the investigation.

  - order: 2
    title: "Establish the earliest appearance"
    objective: "Find the earliest verifiable publication of this footage, which is the decisive test of a 'happening now' claim."
    doneWhen: "You have identified the earliest appearance you can verify with an archived, dated citation — or documented that you could not."
    tools:
      - slug: youtube-data-api
        note: "Returns the exact publication timestamp to the second, which the interface's relative dates ('2 years ago') will not."
      - slug: invid-weverify-plugin
        note: "Extracts keyframes and fires them at multiple reverse-image engines in one action — the core technique for video."
      - slug: tineye
        note: "Sort by oldest on each keyframe; this is the query most likely to end the investigation immediately."
      - slug: yandex-images
        note: "Frequently finds keyframe matches the others miss, particularly for Eastern European footage."
      - slug: google-lens
        note: "Semantic matching finds related coverage of the same scene rather than only exact copies."
    body: |
      Reverse image search works on stills, so verifying video means extracting keyframes and
      searching each one. The InVID plugin automates this and is the reason the workflow is
      practical rather than theoretical.

      **Choose keyframes deliberately.** Pick frames with distinctive static content — a
      building, a sign, a vehicle, a banner — rather than motion-blurred or dark frames. Extract
      from the beginning, middle and end, because reposted clips are frequently trimmed and a
      match may exist only for a section.

      Search every keyframe across all three engines. Where you find a hit, open the page,
      confirm its date independently rather than trusting the search engine's summary, and
      archive it.

      For platform-native videos, get the exact publication timestamp from the platform's API
      rather than the interface. "2 years ago" is not a timestamp; an ISO-8601 datetime is.

      **The decisive outcome.** If the footage was published before the event it is now claimed
      to depict, you have a conclusive debunk — recycled footage is by a wide margin the most
      common form of video disinformation, far more common than any synthetic manipulation.
      Establish the earlier date rigorously: open the page, check the archive's own capture
      history for it, and make sure you are not relying on a date the page itself asserts.

      **A negative result is weak.** Keyframe search has poor recall on recompressed,
      letterboxed, cropped, mirrored or overlaid video — and all of those are applied to
      recycled footage precisely to defeat this technique. Mirroring in particular is a routine
      evasion and defeats most reverse image search. Try a horizontally flipped keyframe.
      "No earlier version found" is not "this is new".

  - order: 3
    title: "Geolocate the footage"
    objective: "Establish where the video was filmed, independently of any claim attached to it."
    doneWhen: "The location is confirmed against independent imagery, or documented as unconfirmed with the candidates you eliminated."
    tools:
      - slug: overpass-turbo
        note: "Query OpenStreetMap for the combination of features visible in the frame."
      - slug: google-earth-pro
        note: "Historical imagery confirms the built environment matched at the claimed date, not just today."
      - slug: mapillary
        note: "Ground-level imagery gives you the camera's own perspective for confirming a match."
      - slug: yandex-images
        note: "Often surfaces other photographs of the same place, which is the strongest narrowing evidence."
    body: |
      Video is easier to geolocate than a still, because you get many angles and often camera
      movement that reveals features a single frame would not.

      Work through the footage systematically rather than watching it. Step frame by frame and
      note every fixed feature, every sign, every distinctive piece of infrastructure. Camera
      pans are especially valuable: they give you spatial relationships between features that a
      photograph cannot, and those relationships are what you match against imagery.

      Then follow the geolocation method — feature inventory, region narrowing, structured
      query, confirmation against independent imagery. The **Geolocating from Imagery** playbook
      covers this in full and should be run properly rather than approximated.

      Require the same standard: at least three independent features matching in correct
      relative geometry, with distances checked. Record eliminated candidates.

      **A geolocation result answers only one question.** It tells you where the footage was
      shot. It does not tell you when, and it does not tell you that the event described
      happened. Footage genuinely shot in a city can be years old and captioned with an event
      that never occurred. Keep these three claims separate on the page.

  - order: 4
    title: "Chronolocate and test against independent physical evidence"
    objective: "Constrain when the footage was filmed using shadows, weather, environment and satellite observation."
    doneWhen: "You have a candidate time window with stated uncertainty, and have checked at least one independent physical source against the claimed date."
    tools:
      - slug: suncalc
        note: "Sun azimuth and elevation for the confirmed location, which shadow geometry must be consistent with."
      - slug: copernicus-browser
        note: "Dated Sentinel imagery independently shows the state of the site — construction, damage, flooding, snow — around the claimed date."
      - slug: nasa-firms
        note: "Thermal detections corroborate or contradict claims involving fire, shelling or explosions, with timestamps and coordinates."
    body: |
      Once you have the location, the physical world becomes a set of independent checks that
      the video's publisher did not control.

      **Shadows.** Measure direction and length ratio, and use SunCalc for the confirmed
      location. This yields candidate time windows, in the plural — the sun's position repeats
      twice daily and twice annually. Express the result as a range with reasoning, never as a
      timestamp. Check the location's time zone and daylight saving status for the date in
      question; getting that wrong is the most common source of a confident wrong answer.

      **Environment.** Foliage state, snow cover, crop stage and water level constrain the
      season, often to within weeks, and are hard to fake in a video shot outdoors.

      **Weather.** If a specific date is claimed, historical weather records for that location
      are checkable. Footage showing clear skies on a day of recorded heavy rain is a serious
      inconsistency.

      **Satellite corroboration.** Sentinel-2 revisits every few days at 10-metre resolution
      and Sentinel-1 radar sees through cloud. For anything at that scale — damage, flooding,
      a burn scar, new construction, vehicles at a site — imagery from before and after the
      claimed date is powerful independent evidence. Its limit is resolution: 10 metres shows
      that something changed, not what it is, and analysts routinely over-read those pixels.

      **Thermal detections.** For claims involving fire, shelling or explosions, FIRMS gives
      dated, coordinate-tagged thermal anomalies. A detection at the right place and time is
      strong corroboration — but a detection says only that the sensor saw heat in a pixel of
      several hundred metres. It does not say what burned or why, and gas flares, industrial
      plant and agricultural burning all register. Equally, no detection is weak evidence of
      absence: satellites only see a location on overpass, and a short fire between passes
      leaves no trace.

      Note which of these checks you ran and what each returned, including the ones that
      returned nothing.

  - order: 5
    title: "Examine the file and the footage for manipulation"
    objective: "Look for evidence of editing, splicing or synthesis — while refusing to infer manipulation from artefacts alone."
    doneWhen: "You have examined the container metadata, the encoding, and the footage for internal inconsistencies, and stated what you found in specific terms."
    tools:
      - slug: exiftool
        note: "Reads video container metadata — encoder, creation dates, device strings — entirely locally."
      - slug: invid-weverify-plugin
        note: "Magnifier and frame-level analysis for examining specific regions across frames."
    body: |
      Run ExifTool on the file. Video containers carry encoder strings, creation and
      modification dates, and sometimes device identifiers. A file presented as straight from a
      phone that carries a desktop editor's encoder signature is a concrete provenance
      discrepancy that needs explaining.

      Remember that platform re-encoding overwrites almost all of this. A file downloaded from
      a platform tells you about the platform's transcoder. This is why step 1 matters: the
      earliest and highest-quality copy retains the most.

      **Look for internal inconsistency in the footage itself**, which is far more reliable than
      any filter:

      - **Audio and video coherence.** Does the audio match the scene? Is there a cut in the
        audio where the video is continuous, or vice versa? Audio is edited less carefully than
        video and gives away splices.
      - **Continuity.** Do shadows stay consistent in direction across the clip? Do people and
        vehicles move continuously across cuts? Does the weather change?
      - **Aspect ratio, letterboxing and quality changes** mid-clip, which indicate material
        from different sources spliced together.
      - **Watermarks and platform overlays** — a TikTok watermark on footage claimed to be a
        news agency's original tells you where it actually came from.

      **On synthetic media.** Detection tools for AI-generated video exist, produce confident
      numeric outputs, and have documented and substantial error rates in both directions. This
      catalogue does not list one, because none could be recommended with the accuracy standard
      the rest of the catalogue applies. Do not assert that a video is AI-generated on the basis
      of a detector score. Assert it only from provenance evidence — an established origin, an
      admission, or a demonstrable physical impossibility in the scene. And note the reverse
      error, now at least as common: dismissing genuine footage as AI-generated because it looks
      unusual. That is a failure mode with its own casualties.

  - order: 6
    title: "Assess the accounts and the spread"
    objective: "Understand who is pushing the video and whether the spread pattern is organic."
    doneWhen: "You have profiled the earliest accounts and characterised the propagation pattern, or documented why you could not."
    tools:
      - slug: social-blade
        note: "Historical account statistics distinguish an established local account from one created last week."
      - slug: x-advanced-search
        note: "Date-bounded search finds the earliest posts in the hours around the claim's emergence."
      - slug: tgstat
        note: "Telegram channel analytics and the citation graph, which show how a narrative seeded and propagated."
      - slug: meta-content-library
        note: "Sanctioned research access to Facebook and Instagram public content, if you have it — access is gated and slow."
    body: |
      For the earliest accounts you identified, establish:

      - Account creation date, and whether its history predates its interest in this subject.
      - Whether it produces original material or only reshares.
      - Consistency between claimed location, posting times and language.
      - Follower growth pattern — a sudden step change suggests amplification rather than
        organic reach.
      - Whether it has posted footage later shown to be misattributed.

      For the spread, look for coordination signals: near-simultaneous posting across
      unconnected accounts, identical caption text including identical errors, and a burst
      pattern inconsistent with organic sharing.

      Be careful here, because this is where good verification work most often overreaches.
      Coordination is a strong claim and the evidence for it is usually circumstantial.
      Identical captions are as easily explained by copy-paste from one popular post as by
      coordination. A new account is much more likely to be a new account than a sock puppet.
      State what you observed and what it is consistent with; do not assert a network without
      evidence that distinguishes coordination from ordinary virality.

      Note also that this step has degraded severely. CrowdTangle was shut down in August 2024,
      X's research access was withdrawn in 2023, and Pushshift is restricted to Reddit
      moderators. Much of what this step could have established in 2022 is no longer
      establishable, and saying so is more honest than substituting a weaker method and
      presenting the same confidence.

  - order: 7
    title: "Reconcile the evidence and rate the claim"
    objective: "Separate what the footage shows, when it was filmed, and what it is claimed to prove — and rate each independently."
    doneWhen: "You have a written finding rating location, date and claim separately, each with its evidence, and an explicit list of what remains unestablished."
    tools:
      - slug: hunchly
        note: "The full timestamped record of every source, search and page used, which is what you produce when the finding is challenged."
    body: |
      The final discipline is to resist collapsing three different questions into one verdict.
      Rate each separately:

      1. **Is the footage authentic?** Is it a genuine recording rather than synthetic or
         spliced material? Usually the easiest of the three, and usually yes.
      2. **When and where was it filmed?** Established by geolocation and chronolocation.
      3. **Does it show what is claimed?** This is the question that actually matters, and it
         very often fails while the first two pass. Genuine footage, correctly located, filmed
         four years ago, captioned as yesterday.

      Use calibrated language and mean it:

      - **Verified** — location and date independently confirmed, and the footage is consistent
        with the claim.
      - **Partly verified** — some elements confirmed, others not. Say precisely which.
      - **Unverified** — could not be established either way. This is a common and legitimate
        outcome and should be published as such rather than quietly dropped.
      - **Misattributed** — the footage is genuine but does not show the claimed event. The most
        common finding in this entire workflow.
      - **False** — the footage is fabricated, or demonstrably shows something other than
        claimed.

      Write down what remains unestablished, explicitly. On a fast-moving story the pressure to
      convert "we could not find an earlier version" into "this appears to be original" is
      enormous, and it is the mechanism by which careful verification work becomes another
      source of error.
---

# Verifying a Viral Video's Authenticity and Timeline

A video spreads in hours attached to a claim about a place, an event and often a person. It is
reshared by people who will never see a correction, and it drives real consequences — market
moves, protests, retaliation — long before anyone establishes what it shows.

This is the hardest routine verification task, because a video carries far more checkable
information than a photograph and correspondingly more ways to be wrong about it. It is also the
one where the answer is most often not "fake" but something more specific and more interesting:
genuine footage, from a real place, showing a real thing, attached to the wrong event.

Keep that framing throughout. The most common form of video disinformation by a wide margin is
not synthesis. It is **recycled real footage**, and the technique that catches it is reverse
image search on keyframes, not forensic analysis.

## Before you start

**Your legal footing.** Downloading video from most platforms breaches their terms of service.
Several jurisdictions recognise journalistic or archival exceptions; many do not, and the terms
are breached regardless. Never use downloading tools to reach content behind authentication or
access controls — that is where a terms breach becomes a computer-misuse offence. Downloaded
footage may be copyright-protected and may contain personal data; holding it for verification is
a different act from republishing it, and the second needs its own justification.

**Your ethical footing.** Viral videos frequently depict violence, death and identifiable people
in the worst moments of their lives. Three commitments before you start. Decide what you will
publish, what you will hold but not publish, and what you will not retain. Do not identify
individuals visible in footage unless there is a clear public interest that outweighs the risk to
them — bystanders in a video of an atrocity can be targeted for having been there. And take the
psychological cost seriously: repeated exposure to graphic material causes real harm, mute the
audio, work in short sessions, use thumbnails rather than full playback where you can, and stop
when you need to.

**Your own security.** Reverse image searches disclose keyframes to search operators. Downloading
from a platform is a request from your address. Comment threads on contested footage are actively
monitored by interested parties. Use a research browser profile, consider Tor, and be aware that
in fast-moving conflict stories the people who published the video are sometimes actively
watching who is examining it.

**Recording provenance of your own work.** Speed is the enemy of documentation and viral
verification is always done at speed. Set up capture before the first query, not after. Record
every search you run and what it returned — including nothing. When the story is contested a week
later, the difference between a defensible finding and an assertion is whether you can show your
working.

## Corroboration and how not to fool yourself

1. **Separate the three claims.** Authenticity, place-and-time, and what-it-shows are independent
   and fail independently. Collapsing them is the characteristic error of viral verification.

2. **Require independent corroboration in different domains.** A geolocation confirmed by
   satellite imagery and a chronolocation confirmed by weather records are genuinely independent.
   Three social posts saying the same thing are one source.

3. **Record negative results.** "TinEye returned nothing on five keyframes", "no FIRMS detections
   within 5 km on that date", "no earlier upload found". These define the boundary of what you
   established and stop the same searches being repeated.

4. **Watch for the pull toward the story.** On a breaking story there is intense pressure to
   produce a verdict. The honest answers "unverified" and "we could not establish this" are
   correct results and should be publishable in your organisation. If they are not, that is a
   process problem worth naming.

5. **Beware the symmetric error.** Over-scepticism is not safety. Dismissing genuine footage of a
   real atrocity as fake has its own victims, and "it looks AI-generated" is not evidence.

## Writing it up

State the claim as it was made, with an archived link. Then the three findings — authenticity,
place and time, and what it shows — each with its evidence and its confidence rating. Then what
you could not establish, explicitly.

Show the evidence rather than asserting it: an annotated geolocation comparison, the earliest
dated appearance with its archive URL, the satellite imagery with its dates. A reader who can
check you does not have to trust you.

Cite dates and archive URLs for everything, and note that the original may be deleted by the time
anyone reads your work — which is why step 1 exists.

## What would falsify this

- An earlier publication of the footage that keyframe search missed, which is entirely possible
  given how poorly it handles mirrored, cropped and re-encoded video.
- The original uploader providing a raw file with intact metadata contradicting your timeline.
- A second location with the same feature combination that you did not search.
- Your shadow measurement being wrong, or the time zone or daylight-saving assumption behind it
  being wrong.
- A thermal detection or satellite observation you attributed to this event having a different
  and more ordinary cause.
- Footage from the same event by a different filmer showing something inconsistent with your
  reconstruction.

If you cannot name what would overturn your finding, you have not tested it — you have assembled
support for it. Go back.
