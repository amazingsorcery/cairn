import "@testing-library/jest-dom/vitest";

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
