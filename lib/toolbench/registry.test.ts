import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TOOLBENCH_ENTRIES, TOOL_GROUPS, findTool, toolsInGroup } from "./registry";

/**
 * Product-brief section 8: "every route in the nav is complete (if it isn't built, it isn't
 * linked)". These tests hold that line mechanically, because the failure mode — an index
 * card pointing at a 404 — is invisible in review and immediate for a reader.
 */
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
      // A link to a playbook that does not exist is worse than no link at all.
      expect(playbooks, entry.slug).toContain(entry.playbook.slug);
      expect(entry.playbook.step.length, entry.slug).toBeGreaterThan(60);
    }
  });

  it("states how the tool handles data", () => {
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(["inBrowser", "opensThirdParty"], entry.slug).toContain(entry.dataHandling);
    }
    // Only the reverse image launcher may claim to send anything anywhere. If a second tool
    // ever does, that is a decision someone should have to make deliberately.
    const thirdParty = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "opensThirdParty");
    expect(thirdParty.map((entry) => entry.slug)).toEqual(["reverse-image-search"]);
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
