import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "./breadcrumb";

const trail = [
  { label: "Directory", href: "/directory" },
  { label: "Domain and infrastructure", href: "/directory/domain-and-infrastructure" },
  { label: "Shodan" },
];

describe("Breadcrumb", () => {
  it("renders nothing when there is no trail", () => {
    const { container } = render(<Breadcrumb items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes itself as a distinct landmark, not part of the primary nav", () => {
    render(<Breadcrumb items={trail} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("links the ancestors", () => {
    render(<Breadcrumb items={trail} />);
    expect(screen.getByRole("link", { name: "Directory" })).toHaveAttribute("href", "/directory");
  });

  it("does not link the current page", () => {
    render(<Breadcrumb items={trail} />);
    // A link to the page you are already on is noise for keyboard and screen-reader users.
    expect(screen.queryByRole("link", { name: "Shodan" })).toBeNull();
    expect(screen.getByText("Shodan")).toHaveAttribute("aria-current", "page");
  });

  it("hides the separators from assistive technology", () => {
    const { container } = render(<Breadcrumb items={trail} />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(trail.length - 1);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses a list so the nesting is conveyed structurally", () => {
    const { container } = render(<Breadcrumb items={trail} />);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("treats a crumb with no href as plain text even mid-trail", () => {
    render(<Breadcrumb items={[{ label: "Archived" }, { label: "Item" }]} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
