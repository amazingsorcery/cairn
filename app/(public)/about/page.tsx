import Link from "next/link";

import { brand } from "@/config/brand";
import { pageMetadata } from "@/lib/metadata";

/**
 * `/about` — what this is, who it is for, where the scope boundary sits, and what the
 * product deliberately does not do.
 *
 * Sources: `docs/brand/positioning.md` §4–§7, `docs/product-brief.md` §3–§4,
 * `docs/brand/voice.md`. Static at build (`docs/architecture/sitemap.md` §5).
 *
 * Two rules bind this page harder than any other:
 *
 *   - No hero banner making a claim about the reader's abilities (positioning §8.1). The
 *     page opens with what the thing *is*, not with what it will do for you.
 *   - No security or anonymity promise, in any form (voice.md rule 4). The "what we do not
 *     do" section says what is true and then says what is still visible, in the same breath.
 */

export const metadata = pageMetadata({
  title: "About",
  description:
    "What this catalogue is, who it is for, where the scope boundary sits between published and merely reachable, and what it deliberately does not do.",
  path: "/about",
});

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

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <article className="mx-auto max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          About {brand.name}
        </h1>
        <p className="mt-3 text-lg text-foreground-secondary">{brand.pitch}</p>

        <Section id="what" title="What this is">
          <p>
            A catalogue of open-source intelligence tools and data sources, the step-by-step
            playbooks that use them, views of data that operators publish on purpose, and a
            private workspace to run a case in.
          </p>
          <p>
            Every tool in it is already public — that is what open source means. You could
            find all of them yourself with enough hours. What is on offer here is the hours,
            and the judgement inside them: somebody competent looked at this tool, wrote down
            what it costs, which jurisdiction its data sits in, what it can and cannot do, how
            much we trust our own entry, and the date they checked.
          </p>
          <p>
            It is short on purpose. A long unmaintained list is worse than a short dated one,
            because the long one rots silently and you find out at the moment you were relying
            on it. Read{" "}
            <Link
              href="/methodology"
              className="font-medium text-primary underline underline-offset-4"
            >
              the methodology
            </Link>{" "}
            for what each confidence value and each date actually promises.
          </p>
        </Section>

        <Section id="who" title="Who it is for">
          <p>
            Investigative journalists, trust-and-safety and SOC analysts, human-rights
            researchers, due-diligence and anti-money-laundering analysts, and students
            learning the discipline.
          </p>
          <p>
            The register is meant to be sayable in a newsroom and in a SOC: precise, sober,
            and uninterested in sounding impressive. If a sentence would embarrass us inside a
            catalogue entry, it does not appear on this page either.
          </p>
        </Section>

        <Section id="scope" title="The boundary: published, not merely reachable">
          <p>
            The live surfaces show data that an operator{" "}
            <strong className="text-foreground">intentionally published</strong> — open ADS-B
            aircraft broadcasts, and cameras that a transport authority or a tourism board put
            on the public web on purpose, under a licence that permits it.
          </p>
          <p>
            Intentionally published is not the same as reachable. An unsecured camera that
            happens to answer on the open internet, indexed by a scanning service, is not
            published; viewing it is unauthorised access under the Computer Fraud and Abuse Act
            and the Computer Misuse Act. Those cameras are not shown here.
          </p>
          <p>
            They are still <strong className="text-foreground">catalogued</strong>, with the
            exposure stated. That distinction runs through the whole product: cataloguing is
            not endorsing, and a directory that hides a risk is worse than one that omits the
            entry. Some tools listed here carry real legal or ethical hazard. The entry says so
            plainly, names the instrument that is engaged, and tells you a qualified person has
            to answer it. We describe and we flag. We do not authorise, and nothing here is
            legal advice.
          </p>
        </Section>

        <Section id="not" title="What this deliberately does not do">
          <p>Some of these are legal exposure. Some are the reason the audience would leave.</p>
          <ul className="ml-5 list-disc space-y-3">
            <li>
              <strong className="text-foreground">No face matching.</strong> No facial
              recognition against identifiable people, in any form, ever. A face-search result
              is a similarity score and never an identity, and building it would engage
              biometric special-category rules in several jurisdictions at once.
            </li>
            <li>
              <strong className="text-foreground">
                No breached-credential search.
              </strong>{" "}
              Nothing here hosts, mirrors or searches credential dumps. Cataloguing a service
              that reports the <em>fact</em> of an exposure is fine; becoming a plaintext
              credential lookup is not.
            </li>
            <li>
              <strong className="text-foreground">
                No records about the people you investigate.
              </strong>{" "}
              There are no dossiers and no entity records about named private individuals in
              this system. A workspace holds your own notes; you are the controller of your
              case file, not us.
            </li>
            <li>
              <strong className="text-foreground">
                No third-party analytics, ad networks or session recording.
              </strong>{" "}
              None are loaded on any page. There is no behavioural profiling and no
              &ldquo;recommended for you&rdquo; ranking anywhere in the product.
            </li>
            <li>
              <strong className="text-foreground">No user reviews or star ratings.</strong> The
              1–5 reliability number is an editorial assessment against a written rubric, not a
              vote.
            </li>
            <li>
              <strong className="text-foreground">
                No requests to a third party on your behalf without disclosure.
              </strong>{" "}
              Camera embeds and map tiles load only when you click, and what the outbound
              connection reveals is stated before it happens.
            </li>
            <li>
              <strong className="text-foreground">
                No circumvention of robots.txt, terms of service or rate limits
              </strong>{" "}
              on anything fetched from here. That is the line between open-source research and
              a computer-misuse offence.
            </li>
          </ul>
          <p>
            What that adds up to is narrower than it sounds, so here is the limit stated
            plainly: no third-party analytics, ad network or session recorder runs on this
            site. Your connection to it is still visible to your network operator, and to us in
            server logs. Reference content is readable without an account; an account exists
            only so a workspace has somewhere to live.
          </p>
        </Section>

        <Section id="stands" title="Where this stands">
          <p>
            This is a pre-launch build and several things a finished product would have are
            genuinely missing rather than merely unfinished. No company is incorporated behind
            it: {brand.legalEntity} is what appears in the policies because it is what is true.
            No domain has been registered and no contact address or account exists, which is
            why none is linked anywhere on this site.
          </p>
          <p>
            No qualified lawyer has reviewed the{" "}
            <Link
              href="/legal/terms"
              className="font-medium text-primary underline underline-offset-4"
            >
              terms
            </Link>
            ,{" "}
            <Link
              href="/legal/privacy"
              className="font-medium text-primary underline underline-offset-4"
            >
              privacy notice
            </Link>{" "}
            or{" "}
            <Link
              href="/legal/acceptable-use"
              className="font-medium text-primary underline underline-offset-4"
            >
              acceptable use policy
            </Link>
            . Each of those pages says so at the top, and each shows an unresolved fact as a
            visible marker rather than as prose that reads as settled.
          </p>
        </Section>
      </article>
    </div>
  );
}
