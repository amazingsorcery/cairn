import * as React from "react";
import { render, screen } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { describe, expect, it, vi } from "vitest";

import { SiteNav, SiteNavStacked } from "./site-nav";

/**
 * The nav in a deployment with no sign-in method.
 *
 * "If it isn't built, it isn't linked" (product-brief §8). `tests/nav-links.test.ts` checks
 * that every entry in the route table resolves to a route *file*; it cannot check that a
 * route which exists is actually being served. In public-only mode `/workspaces` 404s, so
 * the entry must not render at all.
 *
 * THE STRONGEST ASSERTION HERE IS THAT NOTHING IS WRAPPED IN A `SessionProvider`.
 * `useSession` throws outside one, so a nav that renders without one is a nav that provably
 * did not read the session — which is the behaviour worth having, because in this mode there
 * is no session to read and `/api/auth/session` would be a request per page view for an
 * answer that is always the same.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/directory" }));

const SESSION = {
  user: { id: "u1", role: "user" as const, email: "reader@example.test" },
  expires: "2099-01-01T00:00:00.000Z",
};

describe("public-only mode", () => {
  it("renders the public sections and no workspaces entry", () => {
    render(<SiteNav signInEnabled={false} />);

    expect(screen.getByRole("link", { name: "directory" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "playbooks" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "workspaces" })).not.toBeInTheDocument();
  });

  it("renders without a SessionProvider, so it cannot be reading the session", () => {
    expect(() => render(<SiteNavStacked signInEnabled={false} />)).not.toThrow();
    expect(screen.queryByRole("link", { name: "workspaces" })).not.toBeInTheDocument();
  });

  it("ignores a session that somehow exists — a stale cookie is not a working sign-in", () => {
    // An operator who removes SMTP leaves live session cookies behind. Those readers must
    // not be shown a link to a route that now 404s.
    render(
      <SessionProvider session={SESSION}>
        <SiteNav signInEnabled={false} />
      </SessionProvider>,
    );
    expect(screen.queryByRole("link", { name: "workspaces" })).not.toBeInTheDocument();
  });
});

describe("with a sign-in method configured", () => {
  it("shows workspaces to a signed-in reader", () => {
    render(
      <SessionProvider session={SESSION}>
        <SiteNav signInEnabled />
      </SessionProvider>,
    );
    expect(screen.getByRole("link", { name: "workspaces" })).toBeInTheDocument();
  });

  it("hides workspaces from a signed-out reader, as it always has", () => {
    render(
      <SessionProvider session={null}>
        <SiteNav signInEnabled />
      </SessionProvider>,
    );
    expect(screen.getByRole("link", { name: "directory" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "workspaces" })).not.toBeInTheDocument();
  });
});
