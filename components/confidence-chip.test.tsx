import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "@/db/schema";
import { ConfidenceChip, confidenceLabel, confidenceMeaning } from "./confidence-chip";

describe("ConfidenceChip", () => {
  it.each(CONFIDENCE_LEVELS)("renders a visible word for %s, not colour alone", (level) => {
    render(<ConfidenceChip level={level} />);
    expect(screen.getByText(confidenceLabel(level))).toBeInTheDocument();
  });

  it.each(CONFIDENCE_LEVELS)("explains what %s actually claims, for screen readers", (level) => {
    const { container } = render(<ConfidenceChip level={level} />);
    expect(container.textContent).toContain(confidenceMeaning(level));
  });

  it("renders a four-segment meter so the level is countable without colour", () => {
    render(<ConfidenceChip level="medium" />);
    expect(screen.getByTestId("confidence-meter").children).toHaveLength(4);
  });

  it("hides the meter on request but never the label", () => {
    render(<ConfidenceChip level="verified" showMeter={false} />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByTestId("confidence-meter")).toBeNull();
  });

  it("gives needsReview the two structural signals, since it is the quietest colour step", () => {
    const { container } = render(<ConfidenceChip level="needsReview" />);
    const chip = container.firstElementChild;
    expect(chip?.className).toContain("border-dashed");
    expect(chip?.className).toContain("bg-confidence-review-surface");
  });

  it("gives the other three levels neither a dashed border nor a fill", () => {
    for (const level of ["verified", "high", "medium"] as const) {
      const { container } = render(<ConfidenceChip level={level} />);
      const chip = container.firstElementChild;
      expect(chip?.className).not.toContain("border-dashed");
      expect(chip?.className).not.toContain("-surface");
    }
  });

  it("covers exactly the stored enum, so a fifth value cannot be invented in the UI", () => {
    const handled: ConfidenceLevel[] = ["verified", "high", "medium", "needsReview"];
    expect([...CONFIDENCE_LEVELS].sort()).toEqual([...handled].sort());
  });

  it("uses the displayed spelling, never the stored one", () => {
    render(<ConfidenceChip level="needsReview" />);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.queryByText("needsReview")).toBeNull();
  });
});
