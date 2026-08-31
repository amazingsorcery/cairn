---
slug: geolocating-from-imagery
title: "Geolocating from Imagery"
summary: "Work from an undated, unlabelled photograph or video frame to a confirmed location on the map, and know when you have not got there."
difficulty: intermediate
category: geospatial-and-imagery
estimatedMinutes: 120
tags: [geolocation, satellite-imagery, openstreetmap, chronolocation, verification]
lastReviewedAt: "2026-08-31"
steps:
  - order: 1
    title: "Inventory every feature in the frame"
    objective: "Convert an unstructured image into an explicit written list of searchable and constraining features before you start guessing."
    doneWhen: "You have a written feature list separating fixed landscape features, built features, transient features, and text."
    tools:
      - slug: exiftool
        note: "Check first whether the file carries GPS coordinates — it costs thirty seconds and occasionally ends the task."
      - slug: google-lens
        note: "Reads and translates signage and identifies landmarks, which is the fastest way to get a country or a name."
    body: |
      Run ExifTool first. If the file is an original with a GPS fix, you have a hypothesis in
      thirty seconds. Do not stop there — a GPS tag is a claim to be confirmed by the rest of
      this process, not an answer, because it is trivially forged and frequently wrong.

      Then build the feature list. Write it down; do not hold it in your head. Sort features
      into four groups because they do different work:

      **Fixed landscape features** — mountain profiles, ridgelines, coastlines, river bends,
      lake shapes. These are the most valuable because they cannot be moved and they are
      visible in satellite imagery and terrain models. A distinctive skyline is often the whole
      solution.

      **Fixed built features** — distinctive roof shapes, towers, chimneys, bridges, stadiums,
      pylons, road junction geometry, the relationship between a road and a railway. These are
      what you will query in OpenStreetMap.

      **Transient features** — vehicles, people, foliage, snow, temporary structures. These
      constrain time rather than place, and they will mislead you if you match on them.

      **Text** — signs, business names, plates, advertising, graffiti. A single business name
      can end the search immediately, and script alone narrows to a region.

      Then note the geometry: the sun's direction if shadows are visible, the camera's apparent
      height and angle, and how features are positioned relative to each other. Relative
      positions are what you will match against imagery, and they are what your eye will
      silently distort if you have not written them down.

  - order: 2
    title: "Narrow the search region"
    objective: "Reduce the candidate area from 'the world' to something a systematic search can cover."
    doneWhen: "You can state a candidate region and the specific evidence that bounds it."
    tools:
      - slug: google-lens
        note: "Landmark and scene recognition often returns a country or region directly — treat it as a hypothesis, not an answer."
      - slug: yandex-images
        note: "Often finds a different photograph of the same place, which is the strongest possible narrowing evidence."
      - slug: tineye
        note: "Finds earlier publications whose captions may name the location outright."
    body: |
      Region-narrowing evidence, roughly in order of strength:

      - **Language and script** on signage — narrows to a language area immediately.
      - **Vehicle registration plate format and colour**, and which side of the road traffic
        drives on.
      - **Utility infrastructure** — pylon design, road markings, kerb style, traffic light
        design, and manhole covers are all strongly regional and rarely faked because nobody
        thinks about them.
      - **Vegetation and terrain** — biome constrains latitude and climate zone.
      - **Architecture and building materials.**
      - **Uniforms, insignia, emergency-vehicle liveries.**

      Run reverse image search now, before manual work. If someone has already published this
      image with a caption naming the place, the rest of this playbook becomes confirmation
      rather than discovery — which is still necessary, because captions are wrong constantly.

      Write down the evidence for your region, not just the region. In two hours you will have
      forgotten why you excluded a country, and if your bound was wrong the whole search fails
      silently inside it. A bound you cannot justify is a bound you should widen.

  - order: 3
    title: "Query for the feature combination"
    objective: "Use structured map data to find candidate locations where your distinctive features co-occur."
    doneWhen: "You have a finite candidate list, or a documented null result and a revised query."
    tools:
      - slug: overpass-turbo
        note: "The core technique — query OpenStreetMap for places where your feature combination occurs, collapsing a country to a handful of candidates."
      - slug: openstreetmap
        note: "Inspect candidate areas and read the tags and edit history on features you match."
    body: |
      This is the step that turns geolocation from luck into method, and it is the step most
      people skip because it requires learning a query language for twenty minutes.

      Pick the two or three most distinctive **mapped** features and query for their
      co-occurrence within your candidate region. A worked example: a photograph showing a
      water tower with a football pitch and a level crossing visible. Individually these are
      everywhere. Within one province, the places where all three sit within 300 metres of each
      other may number in single digits.

      Practical guidance:

      - Start with a bounding box, not a country, and widen if you get nothing. Unbounded
        queries against the public endpoints are slow, rate-limited and antisocial.
      - Use `nwr` to catch nodes, ways and relations — a stadium may be tagged as any of them.
      - Chain constraints with `around:` to express proximity, which is where the discriminating
        power comes from.
      - Export results as GeoJSON and check them systematically against satellite imagery. Do
        not eyeball a map and pick the one that feels right.

      **What a null result means, and this is important.** It means one of four things, in
      descending order of likelihood: your query is wrong; the feature is not tagged in OSM in
      that region; your tagging assumption differs from local convention; or the feature is not
      there. Before you conclude anything from a null, test the query against a location where
      you know the feature exists. Most apparent nulls are bugs in the analyst.

  - order: 4
    title: "Confirm against satellite and street-level imagery"
    objective: "Match the candidate against independent imagery until the geometry either holds or fails."
    doneWhen: "At least three independent features match in correct relative position, or the candidate is eliminated and recorded as eliminated."
    tools:
      - slug: google-earth-pro
        note: "Historical imagery and measurement tools let you check the site as it was at the relevant date, not only as it is now."
      - slug: copernicus-browser
        note: "Dated Sentinel imagery independently confirms features and their state on a specific date."
      - slug: mapillary
        note: "Ground-level imagery gives you the camera's own perspective, which is what actually confirms a match."
      - slug: kartaview
        note: "Different contributors chose different platforms — check both, coverage genuinely differs."
    body: |
      Confirmation means matching **relative geometry**, not vibes. Three or more identifiable
      features in the correct positions relative to one another, at the correct distances and
      angles, is a match. Two features that look similar is not; there are a great many water
      towers.

      Work the geometry explicitly:

      1. Find the camera position that would produce the observed view, and stand there in
         Google Earth or a street-level platform.
      2. Compare distances between features against the ruler tool. If the photograph implies
         180 metres between two buildings and the imagery says 340, it is not the place, and no
         amount of resemblance changes that.
      3. Check elevation. If the photograph looks down on a feature and the terrain is flat,
         the camera was elevated — and you should be able to say what it was standing on.
      4. Check the date. Buildings appear and are demolished. Use the historical slider to see
         the site as it was when the photograph was taken, and note that a mismatch may prove
         your date wrong rather than your place wrong.

      **Eliminating a candidate is a result and must be recorded.** Write down which candidates
      you checked and what specifically ruled each out. Without that record you will re-check
      the same candidate in three days, and you will have no answer when someone asks why you
      rejected the location they favour.

      **The trap in this step** is that after an hour of looking you will start seeing matches
      that are not there. The human visual system is extremely good at finding correspondence
      and does not care whether it is real. Countermeasures: state each match as a specific
      falsifiable claim before you look for it; take breaks; and have a second person check the
      final match without telling them what conclusion you reached.

  - order: 5
    title: "Chronolocate if a time is claimed"
    objective: "Test whether the lighting and shadows in the image are consistent with the claimed date and time at the confirmed location."
    doneWhen: "You can state a candidate time window with its uncertainty, or state that chronolocation is not possible for this image."
    tools:
      - slug: suncalc
        note: "Gives sun azimuth and elevation for the location and date, which is what shadow direction and length must be checked against."
      - slug: copernicus-browser
        note: "Dated imagery corroborates the state of the site — snow, construction, vegetation — on and around the claimed date."
    body: |
      Once the location is fixed, shadows become a clock. Measure the direction of a shadow
      relative to true north, and the ratio of the shadow's length to the height of the object
      casting it. Feed the location and date into SunCalc and find the times at which the sun's
      azimuth and elevation would produce that geometry.

      Be honest about what this yields:

      - The sun's position **repeats**. A given elevation occurs twice a day and on two dates
        each year. Chronolocation produces candidate windows, in the plural.
      - Accuracy depends entirely on your measurement. A shadow whose tip is ambiguous, an
        object whose height you are estimating, or sloping ground each introduce error that
        compounds.
      - Time zones and daylight saving are the most common source of a confident wrong answer.
        Check which the location observed on the date in question.
      - Overcast conditions produce no usable shadow at all. Say so and move on.

      Corroborate independently where you can: satellite imagery of the site around the claimed
      date, weather records, and the state of vegetation, snow or construction all constrain
      the window without relying on your shadow measurement.

      A chronolocation result is written as a range with reasoning attached — *between roughly
      09:00 and 10:30 local time, consistent with a date in March or September* — never as a
      timestamp. Anyone who gives you a single time from a shadow is overstating.

  - order: 6
    title: "Document the match so someone else can check it"
    objective: "Produce a record that lets an independent reviewer reach the same conclusion or find your error."
    doneWhen: "You have coordinates, a stated confidence level, a numbered list of matched features with imagery references, and a record of eliminated candidates."
    tools:
      - slug: hunchly
        note: "Timestamped capture of every page and image you used, which is the chain of custody for the analysis itself."
      - slug: openstreetmap
        note: "Provides a stable, citable reference for the matched features and their tags."
    body: |
      A geolocation nobody can check is worthless, and a geolocation you cannot reproduce in
      six months is worthless to you. Record:

      - **Coordinates** of the subject and, separately, of the camera position, with the
        precision you actually achieved — six decimal places implies centimetre accuracy you do
        not have.
      - **A numbered feature match list.** For each: what it is in the photograph, where it is
        in the reference imagery, and why it is distinctive. Aim for at least three, ideally
        five.
      - **A comparison image** with matched features annotated on both the photograph and the
        satellite or street-level view.
      - **The imagery you matched against**, by source and date. Google Earth imagery from 2021
        is a different piece of evidence from Sentinel imagery from last week.
      - **Eliminated candidates and why**, which is the part that demonstrates you searched
        rather than stopped at the first plausible answer.
      - **Your confidence**, stated in words that mean something: *confirmed* (multiple
        independent features match in correct geometry), *probable* (strong match, some
        features unverifiable), *candidate* (consistent, not confirmed).

      If you reached *candidate* and not *confirmed*, publish it as *candidate*. A named
      location that turns out to be wrong does real harm — to people who live there, and to
      every subsequent finding you publish.
---

# Geolocating from Imagery

Geolocation is the discipline of establishing where a photograph or video was taken using only
what is visible in it and publicly available reference data. It underpins conflict monitoring,
human-rights documentation and most serious verification work, because a claim about a place is
usually the load-bearing part of a claim about an event.

It is also slow, and the honest description of the work is that most of it is elimination. You
will spend far more time ruling candidates out than confirming one, and a substantial fraction of
attempts end without an answer. That is normal. An unsolved geolocation, documented properly, is
a legitimate outcome and is infinitely better than a wrong one.

## Before you start

**Your legal footing.** The techniques here use published imagery and open map data, and are
lawful essentially everywhere. Three edges to be aware of. Imagery licensing is real: Google
Earth screenshots are not free to republish, while Copernicus and USGS products largely are —
check before publishing, not after. A small number of jurisdictions restrict the publication of
detailed imagery of specific sites. And geolocating a photograph to a private individual's home
is a different act from geolocating an event, with a different legal and ethical character; be
clear which one you are doing before you start.

**Your ethical footing.** Publishing a precise location can endanger people. Locating a
protester's position, a source's home, a shelter or a field hospital can get people killed, and
the fact that the information was derivable from open sources is not a defence for having derived
and published it. Decide in advance what precision you will publish. Sometimes the correct
finding is *this town* when you know the building, and sometimes the correct finding is one you
do not publish at all.

**Your own security.** Repeated queries and page fetches leave a footprint, and a distinctive
pattern of searching around one small area can itself disclose your interest to anyone watching.
For sensitive work use a research browser profile and consider routing through Tor.

**Recording provenance of your own work.** Geolocation is uniquely dependent on a good log,
because the process is long and iterative. Record every candidate considered, every query run,
every elimination and why. The eliminations are not filler — they are the evidence that you
searched systematically rather than settling on the first thing that looked right.

## Corroboration and how not to fool yourself

Geolocation has a specific failure mode, and it is worth naming precisely: **apophenia**. After
an hour of comparing images, your visual system will manufacture matches. You will see a
correspondence that is not there and feel certain about it.

The countermeasures are procedural, not attitudinal:

1. **Match at least three independent features**, in correct relative geometry, at correct
   distances. Not one striking feature; three ordinary ones in the right places.
2. **Predict before you look.** State what you expect to find and where, then check. A match you
   discovered after the fact is much weaker than one you predicted.
3. **Measure.** Distances and angles are objective and your eye is not. The ruler in Google Earth
   is the most under-used tool in geolocation.
4. **Get a second pair of eyes without priming them.** Show the images, not your conclusion.
5. **Record eliminations**, so your process is visibly a search and not a justification.

## Writing it up

State the coordinates, the confidence level, and the evidence in that order. Annotate a
comparison image with numbered matched features. List which reference imagery you used and its
date. List the candidates you eliminated. Say what remains unconfirmed.

Distinguish clearly between the three claims people conflate: *this image was taken here*, *this
image is consistent with here*, and *the event described happened here*. The third does not
follow from the first — an image can be genuinely from a location and still be captioned with the
wrong event.

## What would falsify this

- Another location with the same feature combination that you did not search — the reason your
  region bound needs to be justified, not assumed.
- Reference imagery from a different date than you assumed, making a feature match spurious.
- A feature you matched that is common in the region rather than distinctive, which you would
  discover by querying for how many instances exist.
- Terrain or elevation inconsistent with the camera position your match requires.
- A local person who knows the place and says it is not there. Weight that heavily; local
  knowledge routinely beats remote analysis.

If you cannot name a specific observation that would overturn your conclusion, you have not
finished testing it.
