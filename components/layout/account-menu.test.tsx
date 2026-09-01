import * as React from "react";
import { render, screen } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./account-menu";

/**
 * The account control in a deployment with no sign-in method.
 *
 * A "sign in" button that leads to a 404 is worse than no button: it tells the reader the
 * product is broken rather than that this deployment is public. The control renders nothing
 * at all, and — as in `site-nav.test.tsx` — it does so without a `SessionProvider`, which is
 * how we know it is not reading a session that cannot exist.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/directory" }));

describe("public-only mode", () => {
  it("renders no sign-in control and no account menu", () => {
    const { container } = render(<AccountMenu signInEnabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders without a SessionProvider, so it cannot be reading the session", () => {
    expect(() => render(<AccountMenu signInEnabled={false} />)).not.toThrow();
  });
});

describe("with a sign-in method configured", () => {
  it("offers sign-in to a signed-out reader, carrying them back to where they were", () => {
    render(
      <SessionProvider session={null}>
        <AccountMenu signInEnabled />
      </SessionProvider>,
    );
    const link = screen.getByRole("link", { name: "sign in" });
    expect(link).toHaveAttribute("href", "/signin?callbackUrl=%2Fdirectory");
  });
});
