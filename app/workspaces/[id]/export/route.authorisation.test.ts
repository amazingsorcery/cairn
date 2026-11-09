import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { closeDb } from "@/lib/db";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit";
import {
  requireDatabaseOrFailInCI,
  createActor,
  createCaseFile,
  createCatalogue,
  describeWithDatabase,
  unknownId,
  type Actor,
  type Catalogue,
  type CaseFile,
} from "@/tests/db/harness";
import { sessionStore } from "@/tests/db/session";
import { GET } from "./route";

/**
 * `GET /workspaces/[id]/export` against a real database. This returns the whole case file,
 * so it's the most sensitive read in the app.
 *
 * Asserts the order: session, id shape, ownership in SQL, then content. A non-owner gets
 * exactly what anyone gets for a nonexistent id.
 */

vi.mock("next-auth", async () => {
  const { sessionStore: store } = await import("@/tests/db/session");
  // No `importOriginal()`; see tests/db/session.ts.
  return { default: () => store.authModule() };
});

const ORIGIN = "http://localhost:3000";

function request(id: string, format?: string): Request {
  const query = format === undefined ? "" : `?format=${encodeURIComponent(format)}`;
  return new Request(`${ORIGIN}/workspaces/${id}/export${query}`);
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

requireDatabaseOrFailInCI("GET /workspaces/[id]/export");

describeWithDatabase("GET /workspaces/[id]/export — ownership before a single byte", () => {
  let catalogue: Catalogue;
  let owner: Actor;
  let stranger: Actor;
  let ownersCase: CaseFile;

  beforeAll(async () => {
    catalogue = await createCatalogue();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    // Fresh users per test so the per-user export limiter doesn't leak 429s between tests.
    owner = await createActor();
    stranger = await createActor();
    ownersCase = await createCaseFile(owner.id, catalogue, "Owner case");
    sessionStore.signedOut();
  });

  /* ---------------------------------------------------------------- *
   * 1. Session
   * ---------------------------------------------------------------- */

  it("redirects a signed-out caller to sign-in and returns no case content", async () => {
    sessionStore.signedOut();

    const response = await GET(request(ownersCase.workspaceId), params(ownersCase.workspaceId));

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/signin");
    // Callback is the case page, not the export.
    expect(location).toContain(encodeURIComponent(`/workspaces/${ownersCase.workspaceId}`));
    expect(await response.text()).not.toContain(ownersCase.noteBody);
  });

  /* ---------------------------------------------------------------- *
   * 2 and 3. Shape, then ownership
   * ---------------------------------------------------------------- */

  it("answers a signed-in stranger with 404 and nothing of the case", async () => {
    sessionStore.signedInAs(stranger);

    const response = await GET(request(ownersCase.workspaceId), params(ownersCase.workspaceId));
    const body = await response.text();

    expect(response.status).toBe(404);
    // Not 403. A 403 confirms the case exists.
    expect(response.status).not.toBe(403);
    expect(body).toBe("Not found");
    expect(body).not.toContain(ownersCase.title);
    expect(body).not.toContain(ownersCase.noteBody);
  });

  it("gives a stranger byte-identical answers for a real case and an imaginary one", async () => {
    sessionStore.signedInAs(stranger);

    const real = await GET(request(ownersCase.workspaceId), params(ownersCase.workspaceId));
    const imaginary = await GET(request(unknownId()), params(unknownId()));

    expect(real.status).toBe(imaginary.status);
    expect(await real.text()).toBe(await imaginary.text());
    expect(real.headers.get("cache-control")).toBe(imaginary.headers.get("cache-control"));
  });

  it("answers an admin who is not the owner with the same 404", async () => {
    // `role` gates the editorial surface only, never case files.
    const admin = await createActor("admin");
    sessionStore.signedInAs(admin);

    const response = await GET(request(ownersCase.workspaceId), params(ownersCase.workspaceId));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("answers a malformed id with 404 rather than a 500 out of the uuid parser", async () => {
    sessionStore.signedInAs(owner);

    const response = await GET(request("not-a-uuid"), params("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("keeps the refusal out of every cache", async () => {
    sessionStore.signedInAs(stranger);

    const response = await GET(request(ownersCase.workspaceId), params(ownersCase.workspaceId));

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  /* ---------------------------------------------------------------- *
   * The owner's own case
   * ---------------------------------------------------------------- */

  it("returns the owner's case as Markdown, with everything in it", async () => {
    sessionStore.signedInAs(owner);

    const response = await GET(
      request(ownersCase.workspaceId, "md"),
      params(ownersCase.workspaceId),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain(".md");
    expect(response.headers.get("cache-control")).toContain("no-store");

    expect(body).toContain(ownersCase.title);
    expect(body).toContain(ownersCase.noteBody);
    expect(body).toContain(catalogue.toolName);
    // Saved features keep their attribution and licence.
    expect(body).toContain("Fixture attribution");
    expect(body).toContain("Fixture licence");
  });

  it("falls back to Markdown for a junk format rather than erroring", async () => {
    // `exportFormatSchema` is `.catch("md")`.
    sessionStore.signedInAs(owner);

    const response = await GET(
      request(ownersCase.workspaceId, "exe"),
      params(ownersCase.workspaceId),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
  });

  it("returns a real PDF for the owner", async () => {
    sessionStore.signedInAs(owner);

    const response = await GET(
      request(ownersCase.workspaceId, "pdf"),
      params(ownersCase.workspaceId),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(".pdf");
    // Check the magic number, not just the header.
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  it("refuses a stranger's PDF request without rendering one", async () => {
    // The expensive render is behind the ownership check.
    sessionStore.signedInAs(stranger);

    const response = await GET(
      request(ownersCase.workspaceId, "pdf"),
      params(ownersCase.workspaceId),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("application/pdf");
  });

  /* ---------------------------------------------------------------- *
   * The limiter, which must not become an existence oracle
   * ---------------------------------------------------------------- */

  it("throttles the owner after the export budget is spent, and says when to retry", async () => {
    /*
     * Windows are fixed and epoch-aligned, so the loop may straddle a boundary and get a
     * fresh budget. Assert a 429 arrives within `limit`..`2 * limit` successes rather than
     * at an exact index.
     */
    sessionStore.signedInAs(owner);
    const budget = RATE_LIMIT_POLICIES["workspace-export"].limit;

    const statuses: number[] = [];
    for (let attempt = 0; attempt < budget * 2 + 2; attempt += 1) {
      const response = await GET(
        request(ownersCase.workspaceId, "md"),
        params(ownersCase.workspaceId),
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("cache-control")).toContain("no-store");
        break;
      }
      expect(response.status).toBe(200);
    }

    const refusedAt = statuses.indexOf(429);
    expect(refusedAt, `no export was ever refused: ${statuses.join(",")}`).toBeGreaterThan(-1);
    expect(statuses.slice(0, refusedAt).every((status) => status === 200)).toBe(true);
    expect(refusedAt).toBeLessThanOrEqual(budget * 2);
    expect(refusedAt).toBeGreaterThanOrEqual(budget);
  });

  it("does not spend a stranger's budget on a case they cannot read", async () => {
    // The limiter runs after the ownership check, so refused probes cost nothing.
    sessionStore.signedInAs(stranger);
    const strangersCase = await createCaseFile(stranger.id, catalogue, "Stranger case");
    const budget = RATE_LIMIT_POLICIES["workspace-export"].limit;

    for (let attempt = 0; attempt < budget * 2; attempt += 1) {
      const probe = await GET(
        request(ownersCase.workspaceId, "md"),
        params(ownersCase.workspaceId),
      );
      expect(probe.status).toBe(404);
    }

    const own = await GET(
      request(strangersCase.workspaceId, "md"),
      params(strangersCase.workspaceId),
    );
    expect(own.status).toBe(200);
  });
});
