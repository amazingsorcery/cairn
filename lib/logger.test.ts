import { describe, expect, it } from "vitest";
import { maskEmail } from "./logger";

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("reporter@newsroom.example")).toBe("r*******@newsroom.example");
  });

  it("does not leak the length of a one-character local part", () => {
    expect(maskEmail("a@example.com")).toBe("a*@example.com");
  });

  it("handles subdomains and plus-addressing without exposing the tag", () => {
    expect(maskEmail("desk+leaks@mail.newsroom.example")).toBe(
      "d*********@mail.newsroom.example",
    );
  });

  it("uses the last @ so quoted local parts do not confuse it", () => {
    expect(maskEmail("odd@name@example.com")).toBe("o*******@example.com");
  });

  it("refuses to echo a malformed value back into the log", () => {
    expect(maskEmail("not-an-email")).toBe("[invalid-email]");
    expect(maskEmail("@example.com")).toBe("[invalid-email]");
  });
});
