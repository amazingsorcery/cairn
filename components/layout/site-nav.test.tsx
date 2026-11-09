import * as React from "react";
import { render, screen } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { describe, expect, it, vi } from "vitest";

import { SiteNav, SiteNavStacked } from "./site-nav";

/**
 * Nav behaviour with no sign-in method. In public-only mode `/workspaces` 404s, so the
 * entry must not render.
 *
 * Rendering without a `SessionProvider` proves the nav doesn't read the session
 * (`useSession` throws outside one), avoiding a `/api/auth/session` request per page view.
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
    // Removing SMTP leaves live session cookies behind; don't link them to a 404.
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
