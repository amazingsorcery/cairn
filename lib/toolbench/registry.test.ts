import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DATA_HANDLING_DETAIL,
  DATA_HANDLING_LABEL,
  TOOLBENCH_ENTRIES,
  TOOL_GROUPS,
  findTool,
  toolsInGroup,
} from "./registry";

/** Every index entry must have a route, and every route an entry. */
describe("the index only lists routes that exist", () => {
  const routeDirectory = join(process.cwd(), "app", "(public)", "toolbench");

  it("has a page directory for every entry", () => {
    const built = readdirSync(routeDirectory, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
    const listed = TOOLBENCH_ENTRIES.map((entry) => entry.slug).sort();
    expect(listed).toEqual(built);
  });

  it("has an entry for every page directory, so nothing ships unreachable", () => {
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(findTool(entry.slug), entry.slug).not.toBeNull();
    }
    expect(findTool("not-a-tool")).toBeNull();
  });
});

describe("every entry carries what the brief requires of a tool", () => {
  it("names the playbook it belongs to, and says which step", () => {
    const playbookDirectory = join(process.cwd(), "content", "playbooks");
    const playbooks = readdirSync(playbookDirectory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));

    for (const entry of TOOLBENCH_ENTRIES) {
      expect(playbooks, entry.slug).toContain(entry.playbook.slug);
      expect(entry.playbook.step.length, entry.slug).toBeGreaterThan(60);
    }
  });

  it("states how the tool handles data", () => {
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(
        ["inBrowser", "opensThirdParty", "onOurServer", "viaOurServer", "clientToSource"],
        entry.slug,
      ).toContain(entry.dataHandling);
    }
    // Pinned lists: adding a tool to any of these should require editing the test.
    const thirdParty = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "opensThirdParty");
    expect(thirdParty.map((entry) => entry.slug)).toEqual(["reverse-image-search"]);

    // `onOurServer`: the query reaches a third party via us because the source can't be
    // called from a browser.
    const serverSide = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "onOurServer");
    expect(serverSide.map((entry) => entry.slug).sort()).toEqual([
      "certificate-transparency",
      "dns-lookup",
      "ip-intelligence",
      "wayback-explorer",
    ]);

    // `viaOurServer`: callable from a browser, but proxied so the upstream doesn't see the reader.
    const routedByChoice = TOOLBENCH_ENTRIES.filter(
      (entry) => entry.dataHandling === "viaOurServer",
    );
    expect(routedByChoice.map((entry) => entry.slug).sort()).toEqual([
      "broadcast-finder",
      "overpass-builder",
    ]);

    // `clientToSource`: the browser fetches media directly (we don't relay media), so the
    // source sees the reader's IP.
    const directMedia = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "clientToSource");
    expect(directMedia.map((entry) => entry.slug)).toEqual(["imagery-comparator"]);
  });

  it("gives every data-handling value a label and a detailed explanation", () => {
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(DATA_HANDLING_LABEL[entry.dataHandling], entry.slug).toBeTruthy();
      // A full explanation, not a caption.
      expect(DATA_HANDLING_DETAIL[entry.dataHandling].length, entry.slug).toBeGreaterThan(120);
    }
  });

  it("belongs to a declared group", () => {
    const groupIds = TOOL_GROUPS.map((group) => group.id);
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(groupIds, entry.slug).toContain(entry.group);
    }
    // No empty group headings on the index page.
    for (const group of TOOL_GROUPS) {
      expect(toolsInGroup(group.id).length, group.id).toBeGreaterThan(0);
    }
  });

  it("has a unique slug and a real summary", () => {
    const slugs = TOOLBENCH_ENTRIES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(entry.summary.length, entry.slug).toBeGreaterThan(40);
      expect(entry.name.length, entry.slug).toBeGreaterThan(4);
    }
  });
});
