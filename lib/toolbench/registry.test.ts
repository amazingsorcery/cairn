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
      expect(
        ["inBrowser", "opensThirdParty", "onOurServer", "viaOurServer", "clientToSource"],
        entry.slug,
      ).toContain(entry.dataHandling);
    }
    // Only the reverse image launcher may claim to send anything anywhere. If a second tool
    // ever does, that is a decision someone should have to make deliberately.
    const thirdParty = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "opensThirdParty");
    expect(thirdParty.map((entry) => entry.slug)).toEqual(["reverse-image-search"]);

    /**
     * The same lock on the server-side tools, and for a stronger reason: `onOurServer` means
     * the reader's query leaves their machine and reaches a third party. Four tools do that
     * today, every one of them because the source cannot be called from a browser at all.
     * Adding a fifth must be a deliberate act with this list edited to say so, not something
     * that happens because a client-side tool grew a fetch.
     */
    const serverSide = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "onOurServer");
    expect(serverSide.map((entry) => entry.slug).sort()).toEqual([
      "certificate-transparency",
      "dns-lookup",
      "ip-intelligence",
      "wayback-explorer",
    ]);

    /**
     * `viaOurServer` is the same lock again, and the distinction from `onOurServer` is the
     * reason it is a separate value: these two sources CAN be called from a browser, and we
     * route them through the server anyway so the upstream never learns which place or
     * language a reader was searching for. Describing a choice as an inability would
     * misdescribe the trade the reader is being asked to accept.
     */
    const routedByChoice = TOOLBENCH_ENTRIES.filter(
      (entry) => entry.dataHandling === "viaOurServer",
    );
    expect(routedByChoice.map((entry) => entry.slug).sort()).toEqual([
      "broadcast-finder",
      "overpass-builder",
    ]);

    /**
     * `clientToSource` is the ONLY value that means the reader's own browser reaches a third
     * party, so it is the one that most needs to stay deliberate. It exists for media, which
     * product-brief §2b forbids us to relay — and the corollary, which the copy states, is
     * that the source sees the reader's address.
     */
    const directMedia = TOOLBENCH_ENTRIES.filter((entry) => entry.dataHandling === "clientToSource");
    expect(directMedia.map((entry) => entry.slug)).toEqual(["imagery-comparator"]);
  });

  it("gives every data-handling value a label and a detailed explanation", () => {
    for (const entry of TOOLBENCH_ENTRIES) {
      expect(DATA_HANDLING_LABEL[entry.dataHandling], entry.slug).toBeTruthy();
      // The detail is what a reader actually decides on, so it has to be a paragraph rather
      // than a badge caption.
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
