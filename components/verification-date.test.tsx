import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationDate } from "./verification-date";

describe("VerificationDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows both an absolute date and a relative age", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2026-08-01T12:00:00.000Z" />);
    expect(container.textContent).toContain("1 Aug 2026");
    expect(container.textContent).toContain("30 days ago");
  });

  it("says today rather than 0 days ago", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2026-08-31T09:00:00.000Z" />);
    expect(container.textContent).toContain("today");
  });

  it("switches to months once past a month", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2026-05-01T12:00:00.000Z" />);
    expect(container.textContent).toContain("4 months ago");
  });

  it("switches to years past two", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2023-08-31T12:00:00.000Z" />);
    expect(container.textContent).toContain("3 years ago");
  });

  it("escalates styling as the record ages, rather than ageing quietly", () => {
    const { container: fresh } = render(<VerificationDate lastVerifiedAt="2026-08-01" />);
    expect(fresh.firstElementChild?.className).toContain("text-muted-foreground");

    const { container: ageing } = render(<VerificationDate lastVerifiedAt="2026-01-01" />);
    expect(ageing.firstElementChild?.className).toContain("text-warning");

    const { container: stale } = render(<VerificationDate lastVerifiedAt="2024-01-01" />);
    expect(stale.firstElementChild?.className).toContain("text-destructive");
  });

  it("states plainly when an entry has never been verified", () => {
    render(<VerificationDate lastVerifiedAt={null} />);
    expect(screen.getByText(/Never verified/)).toBeInTheDocument();
  });

  it("frames the claim as being about our record, not about the tool", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2026-08-01" />);
    // A stale entry must never read as a warning that the tool itself is bad.
    expect(container.textContent).toContain("Our record was last confirmed accurate on");
  });

  it("warns screen-reader users when the record is over a year old", () => {
    const { container } = render(<VerificationDate lastVerifiedAt="2024-01-01" />);
    expect(container.textContent).toContain("over a year old");
  });
});
