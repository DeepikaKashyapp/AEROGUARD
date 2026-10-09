/**
 * Run a bot over one or more scenarios and write SessionResult JSON.
 *
 *   node bots/src/cli.ts --bot oracle --scenario s.json [--out result.json]
 *   node bots/src/cli.ts --bot oracle --scenarios dir/ --out-dir results/
 *   node bots/src/cli.ts --bot synthetic_trainee --skill 0.4 --seed 7 --scenario s.json
 *   node bots/src/cli.ts --bot synthetic_trainee --skill-json '{"S1":0.3,...}' ...
 *
 * --no-replay drops replay frames (smaller output for batch scoring).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sim, type Catalogue, type Scenario } from "@cuas/sim";
import { flatSkill, makeBot, play, type SkillProfile } from "./bots.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const catPath = arg("catalogue") ?? fileURLToPath(new URL("../../schemas/catalogue.json", import.meta.url));
const catalogue: Catalogue = JSON.parse(readFileSync(catPath, "utf8"));
const botName = arg("bot") ?? "oracle";
const seed = Number(arg("seed") ?? "1");
const skill: SkillProfile = arg("skill-json") ? JSON.parse(arg("skill-json")!) : flatSkill(Number(arg("skill") ?? "0.5"));
const record = !process.argv.includes("--no-replay");

function runOne(sc: Scenario) {
  const sim = new Sim({ scenario: sc, catalogue, actor: "bot", bot: botName, record });
  play(sim, makeBot(botName, { skill, seed }));
  return sim.result();
}

const single = arg("scenario");
const dir = arg("scenarios");
if (single) {
  const res = runOne(JSON.parse(readFileSync(single, "utf8")));
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify(res));
  else process.stdout.write(JSON.stringify(res));
} else if (dir) {
  const outDir = arg("out-dir") ?? "bot-results";
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const res = runOne(JSON.parse(readFileSync(join(dir, f), "utf8")));
    writeFileSync(join(outDir, `${basename(f, ".json")}.${botName}.json`), JSON.stringify(res));
  }
} else {
  console.error("usage: cli.ts --bot NAME (--scenario FILE [--out FILE] | --scenarios DIR [--out-dir DIR])");
  process.exit(2);
}
