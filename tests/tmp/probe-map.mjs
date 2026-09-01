import { chromium } from "@playwright/test";

const base = process.env.BASE ?? "http://127.0.0.1:3300";
const path = process.argv[2] ?? "/map";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 800)));
page.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("HTTP", r.status(), r.url().slice(0, 140));
});

await page.goto(base + path, { waitUntil: "networkidle" }).catch((e) => console.log("GOTO", String(e).slice(0, 200)));
await page.waitForTimeout(4000);
const info = await page.evaluate(() => ({
  h1: [...document.querySelectorAll("h1")].map((h) => h.textContent?.trim()),
  tables: document.querySelectorAll("table").length,
  mainText: (document.querySelector("main")?.textContent ?? "").slice(0, 400),
}));
console.log(JSON.stringify(info, null, 2));
await browser.close();
