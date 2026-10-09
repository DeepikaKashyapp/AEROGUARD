/**
 * Smoke test for the static preview page (scripts/build_preview.sh): loads it
 * under a no-network CSP, flies a mission through the UI, and visits every
 * page, including a phone-width check of the home page.
 *
 *   CHROMIUM=/path/to/chromium node web/e2e/preview.mjs build/preview/aeroguard-preview.html [out_dir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { fly } from "./player.mjs";

const src = resolve(process.argv[2] ?? "build/preview/aeroguard-preview.html");
const out = process.argv[3] ?? ".";
// The artifact host serves the page with no network access; emulate that.
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:";
const wrapped = `${out}/preview-under-test.html`;
writeFileSync(wrapped, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">\n${readFileSync(src, "utf8")}`);
const url = `file://${resolve(wrapped)}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const fail = async (msg) => {
  console.error("FAIL:", msg, errors);
  await page.screenshot({ path: `${out}/preview-failure.png` });
  await browser.close();
  process.exit(1);
};
// Played missions and new trainees live in memory: move by hash, never reload.
const nav = (hash) => page.evaluate((h) => (location.hash = h), hash);
const step = async (what, fn) => {
  try {
    await fn();
    console.log("ok  ", what);
  } catch (e) {
    await fail(`${what}: ${e.message}`);
  }
};

await step("home lists the synthetic course", async () => {
  await page.goto(`${url}?e2e&speed=${process.env.SPEED ?? 4}#/`);
  await page.waitForSelector("text=SYNTHETIC", { timeout: 15_000 });
});
await step("create a trainee in memory", async () => {
  await page.click("text=+ New trainee");
  await page.fill('input[placeholder="e.g. A. Sharma"]', "Preview Tester");
  await page.fill('input[placeholder="e.g. DSSC Course 82, Syndicate 4"]', "Preview course");
  await page.click("text=Create trainee");
  await page.waitForSelector("text=Start adaptive mission");
});
await step("fly the familiarisation mission through the UI", async () => {
  await page.locator(".card.click", { hasText: "Familiarisation" }).first().click();
  await page.click("text=Begin mission");
  await page.waitForSelector("text=Start mission");
  await page.screenshot({ path: `${out}/preview-console.png` });
  await page.keyboard.press("Space");
  await fly(page, (u) => u.includes("#/summary/"));
  await page.waitForSelector("text=Threats stopped");
  const stopped = await page.locator(".stat-tile", { hasText: "Threats stopped" }).locator(".v").textContent();
  console.log("     summary: threats stopped", stopped);
  await page.screenshot({ path: `${out}/preview-summary.png`, fullPage: true });
});
await step("open the recorded full AAR", async () => {
  await page.click("text=a recorded full after-action review");
  await page.waitForSelector(".grade.big", { timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/preview-aar.png` });
});
await step("adaptive mission issues a pre-generated drill", async () => {
  await nav("#/");
  await page.locator(".card.click", { hasText: "Preview Tester" }).first().click();
  await page.click("text=Start adaptive mission");
  await page.waitForSelector("text=Begin mission");
});
await step("unit dashboard", async () => {
  await nav("#/unit");
  await page.waitForSelector(".recharts-surface", { timeout: 15_000 });
  await page.screenshot({ path: `${out}/preview-unit.png` });
});
await step("instructor page", async () => {
  await nav("#/instructor");
  await page.waitForSelector("text=Preview", { timeout: 15_000 });
});
await step("synthetic trainee progress page", async () => {
  await nav("#/");
  await page.locator(".card.click").first().click();
  await page.click("text=Progress & trends");
  await page.waitForSelector(".recharts-surface", { timeout: 15_000 });
});
await step("home fits a phone screen", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("#/");
  await page.waitForSelector("text=Trainees");
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`page is ${w}px wide at a 390px viewport`);
  await page.screenshot({ path: `${out}/preview-phone.png` });
});
if (errors.length) await fail("browser errors");
console.log("PASS: preview page works with no network");
await browser.close();
