import Link from "next/link";

import { ConfidenceChip, CONFIDENCE_ORDER, confidenceMeaning } from "@/components/confidence-chip";
import { CONFIDENCE_ANCHOR, LAST_VERIFIED_ANCHOR, RELIABILITY_ANCHOR } from "@/components/layout/methodology-anchor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { brand } from "@/config/brand";
import { pageMetadata } from "@/lib/metadata";
import { formatDate } from "@/lib/utils";

/**
 * `/methodology` — a required v1 route with real content (architecture HANDOFF §9.4,
 * ADR 0007 §4). It is the page that makes the confidence value mean something: every
 * confidence chip in the product links to an anchor on it.
 *
 * SINGLE-SOURCED DEFINITIONS. The four confidence definitions are read from
 * `confidenceMeaning()` in `components/confidence-chip.tsx` rather than retyped. If the
 * chip and this page could disagree, the product would be lying about its own standard on
 * whichever of the two the reader happened to read second.
 *
 * The anchors are read from `CONFIDENCE_ANCHOR`, the same map the chips link through, so a
 * fifth level added to the schema breaks the build here rather than producing a chip that
 * points at nothing.
 *
 * Static at build (`docs/architecture/sitemap.md` §5). It reads no data, so it has no
 * loading, empty or error state (`docs/design/states.md` §10).
 */

export const metadata = pageMetadata({
  title: "Methodology",
  description:
    "What each confidence level means, what the 1–5 reliability rating means, and what a verification date does and does not promise.",
  path: "/methodology",
});

/** The seed build. A dated historical fact, so it stays true as the catalogue is edited. */
const SEED_BUILD_DATE = "2026-08-31";
/** The model knowledge horizon that unchecked seed entries are honestly dated to. */
const KNOWLEDGE_HORIZON = "2026-05-01";

const RELIABILITY_SCALE: readonly { score: number; meaning: string }[] = [
  {
    score: 5,
    meaning:
      "A primary or authoritative source. The data is the record — a statutory register, a government filing archive, an agency's own dataset. A finding can rest on it directly, with interpretive caveats only.",
  },
  {
    score: 4,
    meaning:
      "High quality, with documented provenance and known, bounded limitations. Coverage gaps or a freshness lag exist and are understood. Safe to rely on when you state those limitations alongside the finding.",
  },
  {
    score: 3,
    meaning:
      "Genuinely useful, and needing corroboration before anything rests on it. Partial coverage, variable contributor quality, self-reported data, or output that is easy to misread. Most of the catalogue sits here, and that is the honest position.",
  },
  {
    score: 2,
    meaning:
      "A lead generator or a triage signal only. High false-positive rate, unverified crowd input, or an output that invites more reliance than it can carry. Do not cite it as evidence.",
  },
  {
    score: 1,
    meaning:
      "Output that is not usable as evidence at all. Kept in the catalogue for warning or completeness.",
  },
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="mt-12 first:mt-0">
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-4 text-base leading-relaxed text-foreground-secondary">
        {children}
      </div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <article className="mx-auto max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Methodology</h1>
        <p className="mt-3 text-lg text-foreground-secondary">
          Every entry in the catalogue carries two numbers and a date: how sure we are about
          the entry, how much weight a result from the tool should carry, and when a person
          last confirmed it. This page says exactly what each of those means.
        </p>

        <Section id="confidence" title="Confidence — how sure we are about the entry">
          <p>
            Confidence describes <strong className="text-foreground">our own entry</strong>,
            not the quality of the tool it describes. A tool can be excellent and our note
            about it uncertain, and the reverse. Quality is the reliability rating below.
          </p>
          <p>
            There are four values and there will never be a fifth. They are written in the
            interface exactly as they are written here.
          </p>

          <dl className="mt-6 space-y-6">
            {CONFIDENCE_ORDER.map((level) => (
              <div
                key={level}
                id={CONFIDENCE_ANCHOR[level]}
                className="rounded-lg border border-border bg-card p-4"
              >
                {/*
                  The chip is the term. It already renders the word, so no separate label
                  sits beside it — a definition list whose term is printed twice reads as a
                  mistake, and the chip is the exact object the reader will meet on an entry.
                */}
                <dt className="flex flex-wrap items-center gap-3">
                  <ConfidenceChip level={level} />
                </dt>
                <dd className="mt-2 text-sm leading-relaxed text-foreground-secondary">
                  {confidenceMeaning(level)}
                </dd>
              </div>
            ))}
          </dl>

          <p>
            Where an entry is <em>medium</em> or <em>needs review</em>, it must also say what
            specifically is in doubt. An uncertain entry that does not name its uncertainty
            reads as a hedge rather than as information, so the content schema refuses to
            accept one.
          </p>
          <p>
            The chip is never the only signal. The verification date sits beside it
            everywhere, because the two answer different questions.
          </p>
        </Section>

        <Section id={RELIABILITY_ANCHOR} title="Reliability — how much weight a result carries">
          <p>
            Reliability is a 1–5 editorial assessment of how much weight a result from the
            tool should carry in a finding. It is assigned by whoever wrote the entry, against
            a written rubric.
          </p>
          <Alert variant="info">
            <AlertTitle>This is not a user rating</AlertTitle>
            <AlertDescription>
              <p>
                Nobody votes on it, no average is computed, and it is not a popularity score.{" "}
                {brand.name} publishes no user reviews and displays no aggregate ratings.
              </p>
            </AlertDescription>
          </Alert>
          <p>
            It is also not a judgement of the software. Two entries in the seed catalogue are
            rated below what their engineering deserves because their output is systematically
            misread — the rating describes the risk of relying on a result, which is the thing
            you need before you cite one.
          </p>

          <dl className="mt-6 space-y-4">
            {RELIABILITY_SCALE.map(({ score, meaning }) => (
              <div key={score} className="flex gap-4">
                <dt className="tabular w-12 shrink-0 font-mono text-sm font-semibold text-foreground">
                  {score}/5
                </dt>
                <dd className="text-sm leading-relaxed text-foreground-secondary">{meaning}</dd>
              </div>
            ))}
          </dl>

          <p>
            Every rating is accompanied by a note stating the tool&rsquo;s failure mode: what
            goes wrong, and what a null result actually means. Almost every tool in this
            catalogue has a null result that means far less than people assume.
          </p>
        </Section>

        <Section id={LAST_VERIFIED_ANCHOR} title="Last verified — what the date promises">
          <p>
            The verification date is the day a person last confirmed the entry against its
            source. It is <strong className="text-foreground">never back-dated or forward-dated</strong>{" "}
            to look fresher than it is. That single rule is what the date is worth.
          </p>
          <p>What it does not promise: that the tool has not changed since. It cannot.</p>
          <p>
            The date is shown in full alongside its age in days, and both are shown wherever an
            entry appears — on the card, on the detail page, in a search result, and in a
            workspace export.
          </p>
          <p>
            Past 90 days the age is marked. Past a year it is marked more strongly. That
            marking is a statement about the freshness of{" "}
            <strong className="text-foreground">our record</strong>, never a warning about the
            tool, which is why it never uses the same colour as a destructive action and never
            changes the confidence chip.
          </p>
          <p>
            How often an entry is re-checked depends on how fast its facts move: 90 days for
            anything with a price and for anything marked <em>needs review</em>, 180 days for
            entries with a known detail in doubt and for tools whose free tier or platform
            access can close without notice, a year for statutory sources and open-source
            projects. A check is also triggered outside that cycle when a reader reports an
            inaccuracy, when a tool is acquired or rebranded, when its URL starts failing, or
            when a legal development changes what the entry has to say.
          </p>
        </Section>

        <Section id="seed-catalogue" title="What the current catalogue actually rests on">
          <p>
            The honest part. The catalogue was seeded on{" "}
            <time dateTime={SEED_BUILD_DATE}>{formatDate(SEED_BUILD_DATE)}</time> with 94
            entries. <strong className="text-foreground">36 of them were looked up during that
            build</strong> — 38 lookups, some of which changed what shipped and some of which
            removed an entry entirely. Those 36 carry that date.
          </p>
          <p>
            The other 58 were not looked up. They rest on prior knowledge and are dated{" "}
            <time dateTime={KNOWLEDGE_HORIZON}>{formatDate(KNOWLEDGE_HORIZON)}</time>, the
            horizon of that knowledge. Dating them to the build date would have been a lie
            about our own process, and a lie about process is worse than a factual error: an
            error is a mistake, and that would be a misrepresentation.
          </p>
          <p>
            So: a majority of the seed catalogue has not been hand-checked against a primary
            source. Each entry states its own date and its own confidence, and those are the
            numbers to act on — not this paragraph, which describes the catalogue on the day it
            was built and will age.
          </p>
          <p>
            A number of well-known tools were deliberately left out: some are confirmed dead,
            some could not be confirmed alive, and some categories were dropped because no
            accurate entry could be written for them. Every omission is recorded with its
            reason. Omission is always allowed here. Invention never is.
          </p>
        </Section>

        <Section id="corrections" title="Corrections">
          <p>
            If an entry is wrong, it should be corrected and its date changed. Reporting a
            problem is not yet possible through the site: no contact address has been
            registered, and publishing one that does not exist would be worse than publishing
            none. The route in is{" "}
            <Link href="/about" className="font-medium text-primary underline underline-offset-4">
              about this project
            </Link>
            , which says who is building it and where it stands.
          </p>
        </Section>
      </article>
    </div>
  );
}
