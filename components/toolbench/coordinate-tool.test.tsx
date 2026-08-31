import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CoordinateTool } from "./coordinate-tool";

/**
 * A smoke test that the client component actually computes, and that the accessibility
 * contract in `docs/frontend/HANDOFF-shell.md` section 10.1 holds.
 *
 * The conversions themselves are covered exhaustively in `lib/toolbench/*.test.ts` against
 * published reference values. What is tested here is the wiring: that typing produces
 * output, that the output is labelled, and that the page has exactly one live region.
 */
describe("the coordinate tool", () => {
  it("converts what a reader types into every notation", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);

    await user.type(screen.getByLabelText("Coordinate"), "51.477928, -0.001545");

    const results = screen.getByRole("heading", { name: "Every notation" }).closest("div");
    expect(results).not.toBeNull();
    if (results === null) return;

    // The same point verified against Snyder's worked example and the Open Location Code
    // specification in lib/toolbench/*.test.ts, arriving here through the UI.
    expect(within(results).getByText("51°28'40.54\"N 000°00'05.56\"W")).toBeInTheDocument();
    expect(within(results).getByText("30U 708210mE 5707239mN")).toBeInTheDocument();
    expect(within(results).getByText("30U YC 08210 07238")).toBeInTheDocument();
    expect(within(results).getByText("9C3XFXHX+59G")).toBeInTheDocument();
    expect(within(results).getByText("geo:51.477928,-0.001545")).toBeInTheDocument();
  });

  it("echoes back which notation it read, so a misread is visible rather than silent", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);

    await user.type(screen.getByLabelText("Coordinate"), "51 28 40.54 N, 0 0 5.56 W");
    expect(await screen.findByText(/degrees, minutes and seconds/i)).toBeInTheDocument();
  });

  it("says how large an area a box notation actually named", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);

    // Two digits per axis is a 1 km box, not a point. Reporting its centre to six decimal
    // places without saying so would invent three orders of magnitude of precision.
    await user.type(screen.getByLabelText("Coordinate"), "30U YC 08 07");
    // The number and its unit are separate text nodes inside one <strong>, so match on the
    // element's whole text rather than on a fragment of it.
    expect(
      await screen.findByText(
        (_content, element) => element?.tagName === "STRONG" && element.textContent === "1000 m",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/names a box about/)).toBeInTheDocument();
  });

  it("reports a bad coordinate in an alert rather than showing nothing", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);

    await user.type(screen.getByLabelText("Coordinate"), "91, 0");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Latitude must be between -90 and 90/);
    expect(screen.getByLabelText("Coordinate")).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps exactly one polite live region, as the shell handoff requires", async () => {
    const user = userEvent.setup();
    const { container } = render(<CoordinateTool />);

    // In the DOM before any content arrives — a region created alongside its content
    // announces nothing.
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);

    await user.type(screen.getByLabelText("Coordinate"), "51.477928, -0.001545");

    // Still one, after the copy buttons for every output row have mounted.
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Copy /}).length).toBeGreaterThan(5);
  });

  it("does not load a map until the reader asks for one", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);
    await user.type(screen.getByLabelText("Coordinate"), "51.477928, -0.001545");

    // The gate states the cost before the click, because opening the map tells a third
    // party which coordinate is being investigated.
    expect(
      await screen.findByRole("button", { name: /show this point on a map/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Map showing/ })).not.toBeInTheDocument();
  });

  it("says on the page that what3words is absent, and why", () => {
    render(<CoordinateTool />);
    const note = screen.getByRole("heading", { name: /what3words is not here/i });
    expect(note).toBeInTheDocument();
    expect(screen.getByText(/wordlist is proprietary/i)).toBeInTheDocument();
  });
});
