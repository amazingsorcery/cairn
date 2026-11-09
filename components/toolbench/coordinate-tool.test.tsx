import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CoordinateTool } from "./coordinate-tool";

/**
 * Wiring smoke test: typing produces labelled output and the page has one live region.
 * Conversions are covered in `lib/toolbench/*.test.ts`.
 */
describe("the coordinate tool", () => {
  it("converts what a reader types into every notation", async () => {
    const user = userEvent.setup();
    render(<CoordinateTool />);

    await user.type(screen.getByLabelText("Coordinate"), "51.477928, -0.001545");

    const results = screen.getByRole("heading", { name: "Every notation" }).closest("div");
    expect(results).not.toBeNull();
    if (results === null) return;

    // Same reference point as the lib tests (Snyder, Open Location Code spec).
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

    // Two digits per axis is a 1 km box, not a point.
    await user.type(screen.getByLabelText("Coordinate"), "30U YC 08 07");
    // Number and unit are separate text nodes in one <strong>; match the whole text.
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

  it("keeps exactly one polite live region", async () => {
    const user = userEvent.setup();
    const { container } = render(<CoordinateTool />);

    // Present before any content, since a region created with its content announces nothing.
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

    // Opening the map tells the tile server which coordinate is being looked at.
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
