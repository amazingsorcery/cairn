import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlaybookCardItem } from "./playbook-card";

/**
 * Regression guard for a heading-order defect found by Lighthouse against a production
 * build: the card hardcoded `h3` while the index renders these directly under the page
 * `h1`, so a populated `/playbooks` went h1 -> h3 and skipped a level.
 *
 * A screen-reader user navigating by heading experiences a skipped level as a missing
 * section — they look for the h2 that introduces the list and there isn't one.
 */

const playbook = {
  slug: "verifying-a-photos-origin",
  title: "Verifying a Photo's Origin",
  summary: "Establish where an image came from and when it was first published.",
  difficulty: "intermediate",
  estimatedMinutes: 90,
  stepCount: 7,
  categoryName: "Image and video verification",
  categorySlug: "image-and-video-verification",
  confidence: "needsReview",
  lastVerifiedAt: new Date("2026-05-01T00:00:00.000Z"),
} as unknown as Parameters<typeof PlaybookCardItem>[0]["playbook"];

describe("PlaybookCardItem", () => {
  it("renders an h2 by default, so a list under the page h1 does not skip a level", () => {
    render(<PlaybookCardItem playbook={playbook} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Verifying a Photo's Origin");
  });

  it("never renders an h3 by default", () => {
    render(<PlaybookCardItem playbook={playbook} />);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("lets a caller nest it under a section heading", () => {
    render(<PlaybookCardItem playbook={playbook} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("keeps the title a link to the playbook", () => {
    render(<PlaybookCardItem playbook={playbook} />);
    expect(screen.getByRole("link", { name: /Verifying a Photo/ })).toHaveAttribute(
      "href",
      "/playbooks/verifying-a-photos-origin",
    );
  });

  it("always shows confidence and last-verified, which are not optional on any entry view", () => {
    const { container } = render(<PlaybookCardItem playbook={playbook} />);
    expect(container.textContent).toMatch(/Needs review/i);
    expect(container.textContent).toMatch(/Last verified/i);
  });
});
