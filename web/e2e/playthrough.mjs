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

const KEY = { bird: "1", friendly_uav: "2", civil_drone: "3", recon_quad: "4", fpv_rf: "5", fpv_fiber: "5", loitering_munition: "6", decoy: "7" };
const deadline = Date.now() + 180_000;
while (!page.url().includes("#/aar/")) {
  if (Date.now() > deadline) await fail("mission did not finish in time");
  const plans = await page.evaluate(() => {
    const s = window.__sim;
    if (!s || s.ended) return [];
    const out = [];
    const used = new Set();
    const order = [...s.tracks].sort((a, b) => (s.tti(a) ?? 1e9) - (s.tti(b) ?? 1e9));
    for (const t of order) {
      if (out.length >= 4) break;
      if (!t.displayed || t.down) continue;
      const e = s.byId.get(t.entityId);
      const busy = s.effectors.some((f) => f.targetTrack === t.id && (f.status === "active" || f.status === "slewing"));
      const wantLabel = { bird: "bird", friendly_uav: "friendly", civil_drone: "civil", recon_quad: "recon", fpv_rf: "fpv", fpv_fiber: "fpv", loitering_munition: "loitering", decoy: "decoy" }[e.cls];
      if (t.label !== wantLabel) {
        out.push({ id: t.id, act: "classify", cls: e.cls });
        continue;
      }
      if (!e.spec.hostile || e.cls === "decoy" || e.outcome !== "active" || busy) continue;
      const p = s.predicted(t);
      const ready = (kind) => s.effectors.find((f) => !used.has(f.id) && f.spec.kind === kind && s.effectorReady(f.id) && Math.hypot(f.pos.x - p.x, f.pos.y - p.y) < f.spec.range_m * 0.9);
      const f = (e.spec.link === "rf" && ready("rf_jam")) || ready("laser") || ready("gun") || ready("rocket");
      const key = f && { rf_jam: "J", laser: "L", gun: "U", rocket: "K" }[f.spec.kind];
      if (key) {
        used.add(f.id);
        out.push({ id: t.id, act: "engage", key });
      }
    }
    return out;
  });
  for (const plan of plans) {
    const row = page.locator(`.tracktable td:text-is("${plan.id}")`);
    if (!(await row.count())) continue;
    await row.click();
    await page.keyboard.press(plan.act === "classify" ? KEY[plan.cls] : plan.key);
  }
  await page.waitForTimeout(120);
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
