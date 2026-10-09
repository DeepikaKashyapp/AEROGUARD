/**
 * Scripted e2e "player": reads ground truth from window.__sim (exposed with
 * ?e2e) to decide what to do, but acts only through the UI like a trainee.
 */

const KEY = { bird: "1", friendly_uav: "2", civil_drone: "3", recon_quad: "4", fpv_rf: "5", fpv_fiber: "5", loitering_munition: "6", decoy: "7" };
export async function fly(page, done, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!done(page.url())) {
    if (Date.now() > deadline) throw new Error("mission did not finish in time");
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
}
