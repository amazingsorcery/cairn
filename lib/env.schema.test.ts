import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.schema";

const base = {
  NODE_ENV: "test",
  APP_URL: "https://example.test",
  AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  DATABASE_URL: "postgresql://user:pass@db:5432/app",
} satisfies NodeJS.ProcessEnv;

const smtp = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "hunter2hunter2",
  SMTP_FROM: "no-reply@example.test",
} satisfies NodeJS.ProcessEnv;

describe("parseEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = parseEnv({ ...base });
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.AUTH_TRUST_HOST).toBe(false);
    expect(env.ADMIN_EMAILS).toBe("");
  });

  it("coerces AUTH_TRUST_HOST to a boolean", () => {
    expect(parseEnv({ ...base, AUTH_TRUST_HOST: "true" }).AUTH_TRUST_HOST).toBe(true);
    expect(parseEnv({ ...base, AUTH_TRUST_HOST: "false" }).AUTH_TRUST_HOST).toBe(false);
  });

  it("rejects a short AUTH_SECRET with an actionable message", () => {
    expect(() => parseEnv({ ...base, AUTH_SECRET: "tooshort" })).toThrow(/openssl rand -base64 32/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: "mysql://user@host/db" })).toThrow(
      /postgres/i,
    );
  });

  it("rejects a relative APP_URL", () => {
    expect(() => parseEnv({ ...base, APP_URL: "/app" })).toThrow(/APP_URL/);
  });

  it("rejects half-configured GitHub OAuth", () => {
    expect(() => parseEnv({ ...base, AUTH_GITHUB_ID: "abc" })).toThrow(/half-configured/);
  });

  it("accepts fully configured GitHub OAuth", () => {
    const env = parseEnv({ ...base, AUTH_GITHUB_ID: "abc", AUTH_GITHUB_SECRET: "def" });
    expect(env.AUTH_GITHUB_ID).toBe("abc");
  });

  it("rejects half-configured SMTP", () => {
    expect(() => parseEnv({ ...base, SMTP_HOST: "smtp.example.test" })).toThrow(
      /half-configured/,
    );
  });

  it("coerces SMTP_PORT to a number", () => {
    expect(parseEnv({ ...base, ...smtp }).SMTP_PORT).toBe(587);
  });

  it("refuses production with no sign-in method at all", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/nobody can log in/);
  });

  it("allows production when at least one sign-in method is configured", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production", ...smtp })).not.toThrow();
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        AUTH_GITHUB_ID: "abc",
        AUTH_GITHUB_SECRET: "def",
      }),
    ).not.toThrow();
  });

  it("reports every problem at once rather than one at a time", () => {
    let message = "";
    try {
      parseEnv({ NODE_ENV: "test" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("APP_URL");
    expect(message).toContain("AUTH_SECRET");
    expect(message).toContain("DATABASE_URL");
  });
});
