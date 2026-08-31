import Link from "next/link";
import { Camera, Plane, PowerOff } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { brand } from "@/config/brand";
import { pageMetadata } from "@/lib/metadata";
import { listPublishedConnectors } from "@/lib/queries/live";
import { buildSafe } from "@/lib/static-params";
import { isoDay } from "@/components/live/live-format";
import { formatDate } from "@/lib/utils";

/**
 * `/live` — the landing page for the fourth pillar. sitemap.md §3.
 *
 * ISR:3600, not dynamic. It is our own prose plus the list of published connectors; nothing
 * upstream is touched to render it, so there is no `fetchedAt` on this page and no freshness
 * bar. The two surfaces it links to are the dynamic ones.
 *
 * THE DISTINCTION BELOW IS THE POINT OF THE PAGE. "Anything public" hides a distinction that
 * is doing all the legal work: intentionally published is not the same as merely reachable
 * (ADR 0011). Saying so plainly, and naming what we deliberately do not carry, is a
 * credibility statement for an audience that will check — not a disclaimer.
 */

export const revalidate = 3600;

export const metadata = pageMetadata({
  title: "Live",
  description:
    "Views of data that operators have intentionally published: open ADS-B aircraft positions and a registry of officially published cameras. What that means, and what is deliberately absent.",
  path: "/live",
});

type ConnectorSummary = Awaited<ReturnType<typeof listPublishedConnectors>>[number];

export default async function LivePage() {
  /*
   * ISR means this page is prerendered at build time, and `docker build` deliberately carries
   * no `DATABASE_URL` (ADR 0018). `buildSafe` substitutes the empty list DURING THE BUILD ONLY
   * and rethrows at runtime — which is the behaviour we want in both directions. At runtime a
   * page that cannot reach the database should fail so `error.tsx` renders and the health check
   * notices; a Live section that quietly claims there are no cameras would be the product
   * telling its most important truth backwards.
   *
   * The empty branch below is therefore a real state, not a blank region: the page's prose is
   * the point of `/live` and stands on its own, and the source list says plainly that nothing
   * is configured yet. That is what a first visitor sees before the first revalidation, and it
   * is a page worth shipping.
   */
  const connectors = await buildSafe("live-index", () => listPublishedConnectors(), []);
  const flights = connectors.filter((c) => c.kind === "flights");
  const cameras = connectors.filter((c) => c.kind === "cameras");

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb items={[{ label: "live" }]} />

      <div className="mt-4 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Live</h1>
        <p className="mt-3 text-lg text-foreground-secondary">
          Two views of data that operators have chosen to publish: open ADS-B aircraft
          positions, and a registry of officially published traffic, transport and tourism
          cameras.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <SurfaceCard
          href="/live/flights"
          icon={<Plane className="size-5" aria-hidden="true" />}
          title="Flights"
          body="Aircraft positions from an open ADS-B aggregator, as a sortable table with an opt-in map. Every request goes through our server, so the aggregator sees us rather than you."
        />
        <SurfaceCard
          href="/live/cameras"
          icon={<Camera className="size-5" aria-hidden="true" />}
          title="Cameras"
          body="A curated registry of camera feeds their operators publish deliberately. Nothing loads until you choose it, and we never proxy or store an image."
        />
      </div>

      <section aria-labelledby="published-heading" className="mt-12 max-w-[68ch]">
        <h2 id="published-heading" className="text-xl font-semibold tracking-tight">
          Intentionally published, not merely reachable
        </h2>
        <div className="mt-3 space-y-4 text-base leading-relaxed text-foreground-secondary">
          <p>
            All of this section rests on one distinction, and it is not a distinction about
            whether something can be reached.
          </p>
          <p>
            <strong className="text-foreground">Intentionally published</strong> means an
            operator chose to publish the feed — usually with a licence, often through an API
            built for the purpose. A transport authority&rsquo;s traffic cameras, a national
            roads agency&rsquo;s open data, an aircraft broadcasting its position in the clear
            for air traffic control to hear. Using these is what they exist for.
          </p>
          <p>
            <strong className="text-foreground">Merely reachable</strong> means a camera on a
            default password that nobody ever chose to publish — the kind indexed by a device
            search engine such as Shodan, or collected into a browsable list on a site such as
            Insecam. Reachability is not publication. Viewing one is unauthorised access to a
            computer system under the US Computer Fraud and Abuse Act, the UK Computer Misuse
            Act 1990 s.1 and equivalents across the EU, irrespective of the absent password —
            and it is frequently a domestic interior, which makes it a privacy intrusion on
            identifiable people on top of the access offence.
          </p>
          <p>
            So {brand.name} carries none of the second kind. Not a curated subset, not behind a
            warning: none. Those tools remain{" "}
            <Link href="/directory" className="underline underline-offset-4 hover:text-foreground">
              catalogued in the directory
            </Link>{" "}
            with the legal exposure stated, because a directory that hides the risk is worse
            than one that omits the entry.
          </p>
        </div>
      </section>

      <section aria-labelledby="rules-heading" className="mt-12 max-w-[68ch]">
        <h2 id="rules-heading" className="text-xl font-semibold tracking-tight">
          What we do and do not do with these feeds
        </h2>
        <ul className="mt-3 space-y-3 text-base leading-relaxed text-foreground-secondary">
          <li>
            <strong className="text-foreground">Aircraft data is fetched by our server</strong>,
            never by your browser. A direct fetch would hand the aggregator your IP address and
            the patch of the world you are looking at.
          </li>
          <li>
            <strong className="text-foreground">Camera images are not proxied</strong>, so
            loading one connects your browser to the operator directly. Nothing loads until you
            click, and we say so before you do.
          </li>
          <li>
            <strong className="text-foreground">Nothing is stored.</strong> There is no table of
            aircraft positions and no store of camera imagery, and there will not be one. A
            fetched payload rests in a shared cache for a bounded time with no user attached.
          </li>
          <li>
            <strong className="text-foreground">We do not record who looked at what.</strong>{" "}
            The outbound log records that a call happened, what it cost and how it ended. It has
            no column for what was asked.
          </li>
          <li>
            <strong className="text-foreground">Every surface states its own age.</strong> Live
            data is stale the instant it is fetched, so each page says how old what you are
            looking at is, and shows nothing rather than something out of date.
          </li>
        </ul>
      </section>

      <section aria-labelledby="sources-heading" className="mt-12">
        <h2 id="sources-heading" className="text-xl font-semibold tracking-tight">
          The sources we draw on
        </h2>
        <p className="mt-3 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
          Every source below carries a recorded operator, the terms that permit our use, and the
          attribution we are obliged to render. A source with no recorded basis does not ship.
        </p>

        {connectors.length === 0 ? (
          <Alert variant="info" className="mt-6 max-w-[68ch]">
            <AlertTitle>No sources are published yet</AlertTitle>
            <AlertDescription>
              A source appears here once an operator has recorded its terms and legal basis.
              Until then both surfaces render their switched-off state.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-6 space-y-8">
            <ConnectorGroup heading="Aircraft positions" connectors={flights} />
            <ConnectorGroup heading="Cameras" connectors={cameras} />
          </div>
        )}
      </section>
    </div>
  );
}

function SurfaceCard({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {icon}
          <Link
            href={href}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-foreground-secondary">{body}</p>
      </CardContent>
    </Card>
  );
}

function ConnectorGroup({
  heading,
  connectors,
}: {
  heading: string;
  connectors: readonly ConnectorSummary[];
}) {
  if (connectors.length === 0) return null;

  return (
    <div>
      <h3 className="text-base font-semibold tracking-tight">{heading}</h3>
      <ul className="mt-3 grid gap-4 md:grid-cols-2">
        {connectors.map((connector) => (
          <li key={connector.slug}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle className="text-base">{connector.name}</CardTitle>
                <p className="text-sm text-foreground-secondary">{connector.operatorName}</p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    The kill-switch state is public, because a reader who finds an empty
                    surface deserves to know it is a decision rather than an outage. The
                    REASON is not published: `connectors.notes` is operator-facing and may be
                    a live legal matter (ADR 0012), and a public reason we cannot keep current
                    is worse than none.
                  */}
                  {connector.enabled ? (
                    <Badge variant="success">enabled</Badge>
                  ) : (
                    <Badge variant="muted">
                      <PowerOff className="size-3" aria-hidden="true" />
                      switched off
                    </Badge>
                  )}
                  {connector.attributionRequired ? (
                    <Badge variant="outline">attribution required</Badge>
                  ) : null}
                </div>

                {connector.attribution ? (
                  <p className="font-medium text-foreground">{connector.attribution}</p>
                ) : null}

                <ul className="space-y-1">
                  <li>
                    <a
                      href={connector.homepageUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      operator&rsquo;s site
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                  {connector.termsUrl ? (
                    <li>
                      <a
                        href={connector.termsUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="underline underline-offset-4 hover:text-foreground"
                      >
                        licence and terms
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  ) : null}
                </ul>

                {connector.lastCheckedAt ? (
                  <p className="tabular text-foreground-secondary">
                    Terms last read{" "}
                    <time dateTime={isoDay(connector.lastCheckedAt)}>
                      {formatDate(connector.lastCheckedAt)}
                    </time>
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
