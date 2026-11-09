import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

/**
 * XSS tests for user-authored content. Note bodies and playbook/tool copy all render
 * through this component, so these render hostile input and assert on the DOM rather than
 * trusting react-markdown's default escaping (one `rehypePlugins` prop could undo it).
 */

describe("Markdown — raw HTML in user input is inert", () => {
  it("does not execute or inject a raw <script> tag", () => {
    const { container } = render(
      <Markdown>{`Before\n\n<script>window.__pwned = true;</script>\n\nAfter`}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("does not create an <img onerror> element", () => {
    const { container } = render(<Markdown>{`<img src=x onerror="alert(1)">`}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not create an <iframe>, which frame-src 'none' would only catch at the edge", () => {
    const { container } = render(
      <Markdown>{`<iframe src="https://evil.test/"></iframe>`}</Markdown>,
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("does not honour an inline style attribute smuggled through HTML", () => {
    const { container } = render(
      <Markdown>{`<div style="position:fixed;inset:0;z-index:9999">overlay</div>`}</Markdown>,
    );
    expect(container.querySelector("div[style]")).toBeNull();
  });

  it("renders raw HTML as visible text rather than dropping it silently", () => {
    // Pasted evidence containing angle brackets must still show up in the note.
    render(<Markdown>{`<script>x</script>`}</Markdown>);
    expect(screen.getByText(/<script>x<\/script>/)).toBeInTheDocument();
  });
});

describe("Markdown — link URLs", () => {
  it("neutralises a javascript: URL in link syntax", () => {
    const { container } = render(<Markdown>{`[click me](javascript:alert(1))`}</Markdown>);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });

  it("neutralises a data: URL in link syntax", () => {
    const { container } = render(
      <Markdown>{`[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`}</Markdown>,
    );
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/^data:/i);
  });

  it("neutralises a vbscript: URL in link syntax", () => {
    const { container } = render(<Markdown>{`[x](vbscript:msgbox(1))`}</Markdown>);
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^vbscript:/i);
  });

  it("marks an external link noopener noreferrer nofollow ugc and target=_blank", () => {
    const { container } = render(<Markdown>{`[OpenCorporates](https://opencorporates.com)`}</Markdown>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    const rel = anchor?.getAttribute("rel") ?? "";
    for (const token of ["noopener", "noreferrer", "nofollow", "ugc"]) {
      expect(rel).toContain(token);
    }
  });

  it("announces that an external link opens in a new tab", () => {
    render(<Markdown>{`[OpenCorporates](https://opencorporates.com)`}</Markdown>);
    expect(screen.getByText(/opens in a new tab/i)).toBeInTheDocument();
  });

  it("leaves an internal link without target=_blank", () => {
    const { container } = render(<Markdown>{`[the directory](/directory)`}</Markdown>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/directory");
    expect(anchor?.getAttribute("target")).toBeNull();
  });
});

describe("Markdown — document outline", () => {
  it("demotes a level-one heading so the page keeps exactly one h1", () => {
    const { container } = render(<Markdown>{`# A heading in a note`}</Markdown>);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("A heading in a note");
  });

  it("renders GFM tables, so remark-gfm is actually wired up", () => {
    const { container } = render(
      <Markdown>{`| a | b |\n| --- | --- |\n| 1 | 2 |`}</Markdown>,
    );
    expect(container.querySelector("table")).not.toBeNull();
  });
});
