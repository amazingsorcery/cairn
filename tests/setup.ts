import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * Unmount everything between tests, explicitly.
 *
 * React Testing Library registers this itself when it can find a global `afterEach`, and
 * `globals: true` is set — so in principle this is redundant. In practice it was not
 * happening: running the suite in ONE process (`--pool=forks --singleFork`) failed 18 tests
 * with "Found multiple elements with the role ..." because each render was left mounted and
 * the next test queried a document containing both.
 *
 * The default pool gives each file its own process, so the leak was invisible and every test
 * passed. That is the dangerous shape: the assertions were passing by isolation rather than
 * by being correct, and any test asserting that exactly one of something exists was not
 * really checking it. Made explicit so it cannot depend on inference again.
 */
afterEach(() => {
  cleanup();
});

// jsdom does not implement matchMedia, which the theme and reduced-motion hooks read.
// Default to "no preference / light" so components render their baseline state in tests.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
