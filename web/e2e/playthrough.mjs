/**
 * End-to-end browser playthrough: create a trainee, fly a whole mission
 * through the real UI (hotkeys and clicks), and check the after-action review.
 *
 *   BASE=http://127.0.0.1:8000 CHROMIUM=/path/to/chromium node web/e2e/playthrough.mjs [mission_id] [out_dir]
 *
 * The "player" reads ground truth from window.__sim (exposed with ?e2e) to
 * decide what to do, but acts only through the UI like a trainee would.
 * Needs playwright-core (npm i -D playwright-core) and a Chromium binary.
 */
import { chromium } from "playwright-core";
import { fly } from "./player.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8000";
const mission = process.argv[2] ?? "familiarisation";
const out = process.argv[3] ?? ".";
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
  await page.screenshot({ path: `${out}/e2e-failure.png` });
  await browser.close();
  process.exit(1);
};

await page.goto(`${BASE}/?e2e&speed=${process.env.SPEED ?? 4}#/`);
await page.click("text=+ New trainee");
const name = `E2E ${Date.now() % 100000}`;
await page.fill('input[placeholder="e.g. A. Sharma"]', name);
await page.fill('input[placeholder="e.g. DSSC Course 82, Syndicate 4"]', "E2E course");
await page.click("text=Create trainee");
await page.waitForSelector(`text=${name}`);
const card = await page.locator(".card.click", { hasText: (await page.evaluate(async (m) => (await (await fetch("/api/missions")).json()).find((x) => x.id === m).name, mission)) });
await card.first().click();
await page.waitForSelector("text=Begin mission");
await page.click("text=Begin mission");
await page.waitForSelector("text=Start mission");
await page.keyboard.press("Space");

try {
  await fly(page, (url) => url.includes("#/aar/"));
} catch (e) {
  await fail(e.message);
}
await page.waitForSelector(".grade.big", { timeout: 30_000 });
await page.waitForTimeout(1500);
const grade = (await page.locator(".grade.big").textContent())?.trim();
const total = await page.locator("h1 + div b.mono").first().textContent();
await page.screenshot({ path: `${out}/e2e-aar.png` });
if (!["A", "B"].includes(grade)) await fail(`expected a good grade from the scripted player, got ${grade} (${total})`);
if (errors.length) await fail("browser errors");
console.log(`PASS: ${mission} flown through the UI, scored ${total} grade ${grade}`);
await browser.close();
