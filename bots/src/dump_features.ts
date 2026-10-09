/**
 * Training data for the classification aid: play scenarios headless and
 * sample (features, true label) from every displayed track every few seconds.
 *
 *   node bots/src/dump_features.ts --scenarios DIR --out features.jsonl
 *
 * Features come from sim/src/aid.ts featuresOf(), the same function the
 * browser uses at inference time. For a random 40% of samples the track is
 * treated as having been looked at in IR (its thermal signature becomes a
 * feature), as when a trainee locks the camera on it.
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rng, Sim, featuresOf, type Catalogue, type Scenario } from "@cuas/sim";
import { makeBot } from "./bots.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("scenarios")!;
const out = arg("out") ?? "features.jsonl";
const catalogue: Catalogue = JSON.parse(readFileSync(fileURLToPath(new URL("../../schemas/catalogue.json", import.meta.url)), "utf8"));
writeFileSync(out, "");
const LABEL: Record<string, string> = {
  bird: "bird", friendly_uav: "friendly", civil_drone: "civil", recon_quad: "recon",
  fpv_rf: "fpv", fpv_fiber: "fpv", loitering_munition: "loitering", decoy: "decoy",
};
let total = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const sc: Scenario = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const sim = new Sim({ scenario: sc, catalogue, actor: "bot", bot: "passive", record: false });
  const bot = makeBot("passive");
  const rng = new Rng(sc.seed);
  const lines: string[] = [];
  let next = 5;
  while (!sim.ended) {
    bot.act(sim);
    sim.step();
    if (sim.t < next) continue;
    next += 4;
    for (const tr of sim.tracks) {
      if (!tr.displayed || tr.down) continue;
      const e = sim.byId.get(tr.entityId)!;
      const saved = tr.thermalSeen;
      if (rng.chance(0.4)) tr.thermalSeen = Math.max(0, Math.min(1, e.spec.thermal + rng.gauss() * 0.05));
      const x = featuresOf(sim, tr);
      tr.thermalSeen = saved;
      if (!x) continue;
      lines.push(JSON.stringify({ x: x.map((v) => Math.round(v * 1000) / 1000), y: LABEL[e.cls], night: sc.environment.time_of_day !== "day", s: sc.id }));
    }
  }
  appendFileSync(out, lines.join("\n") + (lines.length ? "\n" : ""));
  total += lines.length;
}
console.log(`wrote ${total} samples to ${out}`);
