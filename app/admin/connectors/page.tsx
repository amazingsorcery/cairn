import { ActionButton } from "@/components/admin/action-button";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireAdminPage } from "@/components/admin/guard";
import { KillSwitch } from "@/components/admin/kill-switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { publishConnector, recheckConnector } from "@/lib/actions/connectors";
import { getAuditLogSize, getConnectorHealth, listConnectorsForAdmin } from "@/lib/queries/admin";
import { AUDIT_RETENTION_DAYS } from "@/lib/connectors/audit";
import { cn, formatDate, formatTimestamp } from "@/lib/utils";
import { CONNECTOR_KINDS, type ConnectorKind } from "@/db/schema";

/**
 * `/admin/connectors` — the health board and the kill-switch. **admin only**, not editor
 * (sitemap.md §8): this page carries the kill-switch, the quota envelope and the recorded
 * legal basis, which are operator responsibilities rather than editorial ones. A non-admin
 * gets 404.
 *
 * THE LINE ABOUT WHAT THIS BOARD CANNOT SHOW IS RENDERED PERMANENTLY, not as a tooltip
 * (states.md §11.5). It is the visible half of ADR 0013: the audit log answers "is this
 * connector failing, how often are we quota-denied, how slow is upstream" and deliberately
 * cannot answer "who looked at what", because there is no column for the request content and
 * no index on the hashed actor. An operator who assumed otherwise would be wrong about what
 * this product retains, and that is a dangerous thing to be wrong about in front of a source.
 *
 * NOT BUILT IN THIS PASS: `/admin/connectors/[id]`, the edit form for the quota envelope and
 * the recorded legal basis. It is in sitemap.md §8 and is therefore not linked from here
 * (product-brief §8). Recorded in `docs/frontend/HANDOFF-live.md`.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Connectors",
      description: "Live source health, quotas and the kill-switch.",
      path: "/admin/connectors",
    },
    "admin",
  );
}

/**
 * Which reader-facing surface each connector kind feeds. Used in the kill-switch dialog, so
 * an operator about to disable a source can see what goes dark.
 *
 * Explicit entries first, then every remaining kind defaults to the map — which is true, and
 * is where all the v2 layers render. Derived from `CONNECTOR_KINDS` rather than hand-written
 * because a hand-written map is exactly what broke when the enum grew: `getConnectorHealth`
 * had one, adding an outcome silently dropped a row from the board, and a connector being
 * refused upstream was counted nowhere. A map built from its own vocabulary cannot fall
 * behind it.
 */
const EXPLICIT_SURFACE: Partial<Record<ConnectorKind, string>> = {
  flights: "/live/flights",
  cameras: "/live/cameras",
  radio: "/toolbench/broadcast-finder",
};

const SURFACE: Record<ConnectorKind, string> = Object.fromEntries(
  CONNECTOR_KINDS.map((kind) => [kind, EXPLICIT_SURFACE[kind] ?? "/map"]),
) as Record<ConnectorKind, string>;

function percent(part: number, total: number): string {
  if (total === 0) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export default async function AdminConnectorsPage() {
  await requireAdminPage();

  const [connectors, health, audit] = await Promise.all([
    listConnectorsForAdmin(),
    getConnectorHealth(24),
    getAuditLogSize(),
  ]);

  const healthBySlug = new Map(health.map((h) => [h.slug, h]));
  const today = formatDate(new Date());

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Connectors</h1>
      <p className="mt-3 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
        Every outbound request this product makes goes through one of these. Each carries the
        operator, the terms that permit our use, the attribution we owe, a per-user quota, a
        global ceiling that protects the upstream from all of our users combined, and a switch.
      </p>

      <Alert variant="info" className="mt-6 max-w-[80ch]">
        <AlertTitle>This board cannot show who made any request</AlertTitle>
        <AlertDescription>
          That data isn&rsquo;t collected. The outbound log records that a call happened, what it
          cost and how it ended; there is no column for what was asked and no index on the hashed
          actor. Rows are swept after {AUDIT_RETENTION_DAYS} days.
        </AlertDescription>
      </Alert>

      <p className="mt-3 tabular text-sm text-foreground-secondary">
        {audit.rows} audit {audit.rows === 1 ? "row" : "rows"} retained
        {audit.oldest ? <> · oldest {formatTimestamp(audit.oldest)}</> : null}
      </p>

      <div className="mt-8 space-y-6">
        {connectors.map((connector) => {
          const stats = healthBySlug.get(connector.slug);
          const total = stats?.total ?? 0;
          /**
           * Not the same number as `total`, and the difference is the point. One governed
           * attempt is one row; several drivers fan out inside it — six DoH queries per DNS
           * lookup, four RIPEstat endpoints, two Wayback captures plus redirects. The board
           * showed attempts and an operator read them as requests, so a recorded ceiling of
           * 20 lookups a minute was really 120 requests a minute against Cloudflare. QV-09.
           */
          const outbound = stats?.outboundRequests ?? 0;
          const errors = (stats?.byOutcome.upstreamError ?? 0) + (stats?.byOutcome.timeout ?? 0);
          const denied = stats?.byOutcome.quotaDenied ?? 0;
          /**
           * Shown SEPARATELY from quota denials, and it is not a presentation nicety. A quota
           * denial is our ceiling refusing the caller; a rate limit is the upstream refusing
           * us. They point at opposite fixes — lower our ceiling versus back off from theirs —
           * and an operator reading this board at 3am must not have to reconstruct which is
           * which from `upstream_status`. QA finding Q-02.
           */
          const rateLimited = stats?.byOutcome.rateLimited ?? 0;

          return (
            <Card key={connector.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                  {connector.name}
                  {connector.enabled ? (
                    <Badge variant="success">enabled</Badge>
                  ) : (
                    <Badge variant="muted">switched off</Badge>
                  )}
                  {connector.status === "published" ? (
                    <Badge variant="outline">published</Badge>
                  ) : (
                    <Badge variant="warning">draft</Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-foreground-secondary">
                  {connector.operatorName} · feeds{" "}
                  <span className="font-mono">{SURFACE[connector.kind]}</span>
                </p>
              </CardHeader>

              <CardContent className="space-y-5 text-sm">
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-4">
                  <Stat label={`attempts (24 h)`} value={String(total)} />
                  <Stat
                    label="outbound requests (24 h)"
                    value={outbound === total ? String(outbound) : `${outbound} · ${(outbound / Math.max(total, 1)).toFixed(1)}x`}
                  />
                  <Stat label="error rate" value={percent(errors, total)} />
                  <Stat label="quota denials" value={`${denied} · ${percent(denied, total)}`} />
                  <Stat
                    label="rate limited by source"
                    value={`${rateLimited} · ${percent(rateLimited, total)}`}
                    tone={rateLimited > 0 ? "warning" : undefined}
                  />
                  <Stat
                    label="p95 latency"
                    value={stats?.p95DurationMs === null || stats === undefined ? "—" : `${stats.p95DurationMs} ms`}
                  />
                  <Stat
                    label="per-user quota"
                    value={`${connector.perUserQuota} / ${connector.windowSeconds}s`}
                  />
                  <Stat
                    label="global ceiling"
                    value={`${connector.globalCeiling} / ${connector.windowSeconds}s`}
                  />
                  <Stat
                    label="cache · stale window"
                    value={`${connector.cacheTtlSeconds}s · ${connector.staleWhileRevalidateSeconds}s`}
                  />
                  <Stat label="timeout" value={`${connector.timeoutMs} ms`} />
                </dl>

                <div className="space-y-2 border-t border-border pt-4">
                  <p>
                    <span className="text-muted-foreground">terms last read </span>
                    {connector.lastCheckedAt ? (
                      <time
                        dateTime={connector.lastCheckedAt.toISOString().slice(0, 10)}
                        className="tabular"
                      >
                        {formatDate(connector.lastCheckedAt)}
                      </time>
                    ) : (
                      <span className="font-medium text-warning">never</span>
                    )}
                  </p>
                  {connector.termsUrl ? (
                    <p>
                      <a
                        href={connector.termsUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="underline underline-offset-4 hover:text-foreground"
                      >
                        licence and terms
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </p>
                  ) : (
                    <p className="font-medium text-warning">
                      No terms URL recorded. This connector cannot be published.
                    </p>
                  )}
                  {connector.attribution ? (
                    <p>
                      <span className="text-muted-foreground">attribution rendered · </span>
                      <span className="font-medium">{connector.attribution}</span>
                    </p>
                  ) : null}
                  {connector.requiresApiKey ? (
                    <p>
                      <span className="text-muted-foreground">credential from </span>
                      <span className="font-mono">{connector.apiKeyEnvVar}</span>
                    </p>
                  ) : null}
                </div>

                {connector.legalBasis ? (
                  <details className="rounded-md border border-border p-3">
                    <summary className="min-h-11 cursor-pointer py-2 font-medium">
                      recorded legal basis
                    </summary>
                    <p className="mt-2 max-w-[80ch] leading-relaxed text-foreground-secondary">
                      {connector.legalBasis}
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Not a legal opinion. See <span className="font-mono">docs/content/legal-review.md</span>.
                    </p>
                  </details>
                ) : (
                  <p className="font-medium text-warning">
                    No legal basis recorded. The database will refuse to publish this connector.
                  </p>
                )}

                <div className="flex flex-wrap items-start gap-3 border-t border-border pt-4">
                  <KillSwitch
                    id={connector.id}
                    name={connector.name}
                    enabled={connector.enabled}
                    surface={SURFACE[connector.kind]}
                  />
                  <ConfirmAction
                    action={recheckConnector}
                    id={connector.id}
                    triggerLabel="confirm terms unchanged"
                    triggerVariant="secondary"
                    title={`Confirm ${connector.name}'s terms are unchanged?`}
                    description={
                      <>
                        This records that you read the licence or terms of service today, {today},
                        and found them unchanged. It does not enable or publish the connector.
                      </>
                    }
                    confirmLabel="confirm"
                  />
                  {connector.status === "draft" ? (
                    <ActionButton action={publishConnector} id={connector.id} label="publish" />
                  ) : null}
                </div>

                <p className="text-xs text-muted-foreground">
                  Publishing does not enable. The two axes are separate so that re-publishing
                  cannot silently re-enable something an operator switched off (ADR 0012 §1).
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {connectors.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">No connectors</h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            Both Live surfaces render their switched-off state until a connector exists with a
            recorded terms URL and legal basis.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `tone="warning"` is used only where a non-zero value is itself the finding — a source
 * refusing us is not a number to read past. It is never used for a value that is merely
 * large, because everything coloured is a claim that something needs attention.
 */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("tabular font-medium", tone === "warning" && "text-warning")}>{value}</dd>
    </div>
  );
}
