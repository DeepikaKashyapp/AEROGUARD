import { describe, expect, it } from "vitest";
import { Rng, streamSeed } from "../src/rng.ts";
import { bearing, elevation, v3 } from "../src/vec.ts";
import { emptySky, fixture, inject, makeSim, trackOf, until } from "./helpers.ts";

describe("determinism (PLAN.md non-negotiable 5)", () => {
  it("same scenario + seed gives an identical event log", () => {
    const a = makeSim(fixture());
    const b = makeSim(fixture());
    a.advance(150);
    b.advance(150);
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
    expect(a.events.length).toBeGreaterThan(50);
  });

  it("a different seed gives a different mission", () => {
    const sc = fixture();
    const a = makeSim(sc);
    const b = makeSim({ ...sc, seed: sc.seed + 1 });
    a.advance(120);
    b.advance(120);
    expect(JSON.stringify(a.events)).not.toEqual(JSON.stringify(b.events));
  });

  it("named RNG streams are independent", () => {
    expect(streamSeed(1, "radar")).not.toEqual(streamSeed(1, "birds"));
    const r = new Rng(42);
    const xs = Array.from({ length: 1000 }, () => r.next());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("a passive defence loses", () => {
  it("undefended strikes reach the base", () => {
    const sim = makeSim(fixture());
    while (!sim.ended) sim.step();
    const leakers = sim.events.filter((e) => e.type === "leaker");
    expect(leakers.length).toBeGreaterThan(2);
    expect(Math.min(...sim.assetHealth.values())).toBeLessThan(100);
    expect(sim.events.some((e) => e.type === "neutralised")).toBe(false);
  });
});

describe("radar weaknesses", () => {
  it("MTI filters a hovering drone and sees it once it moves", () => {
    const sim = makeSim(emptySky());
    const e = inject(sim, "recon_quad", v3(800, 800), { agl: 120 });
    e.role = "recon";
    e.phase = "hover";
    e.holdUntil = 1e9; // hovers in place forever
    sim.advance(10);
    expect(trackOf(sim, e)).toBeUndefined();
    // now let it fly in
    e.role = "strike";
    e.phase = "ingress";
    expect(until(sim, () => !!trackOf(sim, e)?.displayed, 20)).toBe(true);
  });

  it("birds become radar tracks (false alarms)", () => {
    const sc = emptySky();
    sc.clutter.bird_flocks = 4;
    const sim = makeSim(sc);
    sim.advance(60);
    const birdTracks = sim.tracks.filter((t) => sim.byId.get(t.entityId)!.cls === "bird");
    expect(birdTracks.length).toBeGreaterThan(0);
  });

  it("a radar outage stops new radar tracks", () => {
    const sc = emptySky();
    sc.sensors = sc.sensors.map((s) => (s.type === "d4_radar" ? { ...s, events: [{ t: 0.5, state: "down" as const, for_s: 500 }] } : s));
    const sim = makeSim(sc);
    inject(sim, "loitering_munition", v3(3000, 3000), { agl: 200 });
    sim.advance(30);
    expect(sim.tracks.length).toBe(0);
    expect(sim.events.some((e) => e.type === "sensor_state" && e.data.state === "down")).toBe(true);
  });
});

describe("RF detection only sees emitters", () => {
  it("strobes an RF FPV but never a fiber FPV", () => {
    const sim = makeSim(emptySky());
    const rf = inject(sim, "fpv_rf", v3(2500, 0));
    const fiber = inject(sim, "fpv_fiber", v3(-2500, 0));
    sim.advance(5);
    expect(sim.strobes.has(`rf:${rf.id}`)).toBe(true);
    expect(sim.strobes.has(`rf:${fiber.id}`)).toBe(false);
  });
});

describe("soft kill", () => {
  it("RF jamming downs an RF FPV but has no effect on a fiber FPV", () => {
    const sim = makeSim(emptySky());
    const rf = inject(sim, "fpv_rf", v3(2000, 600));
    const fiber = inject(sim, "fpv_fiber", v3(-2000, -600));
    expect(until(sim, () => !!trackOf(sim, rf)?.displayed && !!trackOf(sim, fiber)?.displayed, 60)).toBe(true);
    expect(sim.engage(trackOf(sim, rf)!.id, "JAM").ok).toBe(true);
    until(sim, () => sim.effectorReady("JAM"), 20);
    expect(rf.linkLost).toBe(true);
    expect(rf.outcome).toBe("link_lost");
    expect(sim.engage(trackOf(sim, fiber)!.id, "JAM").ok).toBe(true);
    until(sim, () => sim.effectorReady("JAM"), 20);
    expect(fiber.outcome).toBe("active");
    const results = sim.events.filter((e) => e.type === "engage_result").map((e) => e.data.result);
    expect(results).toEqual(["link_lost", "no_effect"]);
  });

  it("jamming a sector also cuts the link of a friendly UAV inside it", () => {
    const sim = makeSim(emptySky());
    const hostile = inject(sim, "recon_quad", v3(1500, 1500), { agl: 150 });
    const own = inject(sim, "friendly_uav", v3(1800, 1700), { toward: v3(2400, 2300), agl: 400 });
    expect(until(sim, () => !!trackOf(sim, hostile)?.displayed, 60)).toBe(true);
    expect(sim.engage(trackOf(sim, hostile)!.id, "JAM").ok).toBe(true);
    const order = sim.events.find((e) => e.type === "engage_order")!;
    expect(order.data.friendlies_in_sector).toBe(1);
    until(sim, () => sim.effectorReady("JAM"), 20);
    expect(own.linkLost).toBe(true);
    expect(sim.events.some((e) => e.type === "friendly_affected" && e.entity === own.id)).toBe(true);
  });

  it("GNSS spoofing diverts a GNSS-only decoy", () => {
    const sim = makeSim(emptySky());
    const d = inject(sim, "decoy", v3(1800, -1800), { agl: 200 });
    expect(until(sim, () => !!trackOf(sim, d)?.displayed, 60)).toBe(true);
    expect(sim.engage(trackOf(sim, d)!.id, "GNS").ok).toBe(true);
    until(sim, () => sim.effectorReady("GNS"), 25);
    // 0.9 success per the effect matrix; this seed succeeds
    expect(d.outcome).toBe("diverted");
  });
});

describe("hard kill", () => {
  it("the laser burns down a quad inside 1.25 km and is out of range beyond", () => {
    const sim = makeSim(emptySky());
    const far = inject(sim, "recon_quad", v3(2500, 0), { agl: 150, speed: 15 });
    expect(until(sim, () => !!trackOf(sim, far)?.displayed, 60)).toBe(true);
    const r = sim.engage(trackOf(sim, far)!.id, "LSR");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/out of range/);
    expect(until(sim, () => sim.engage(trackOf(sim, far)!.id, "LSR").ok, 120)).toBe(true);
    expect(until(sim, () => far.outcome === "neutralised", 20)).toBe(true);
    expect(far.outcomeBy).toBe("LSR");
  });

  it("a SAM kills a cheap quad and books the full cost", () => {
    const sim = makeSim(emptySky());
    const q = inject(sim, "recon_quad", v3(2000, 1000), { agl: 150 });
    expect(until(sim, () => !!trackOf(sim, q)?.displayed, 60)).toBe(true);
    expect(sim.engage(trackOf(sim, q)!.id, "SAM").ok).toBe(true);
    until(sim, () => sim.events.some((e) => e.type === "engage_result"), 30);
    const res = sim.events.find((e) => e.type === "engage_result")!;
    expect(res.data.spent).toBe(15000000);
  });

  it("rockets aimed at a tight group can take out several drones in one salvo", () => {
    let multi = false;
    for (let seed = 1; seed <= 8 && !multi; seed++) {
      const sim = makeSim(emptySky({ seed }));
      const group = [0, 1, 2].map((k) => inject(sim, "fpv_fiber", v3(2200 + k * 6, 2200 + k * 6)));
      for (const g of group) g.groupId = "pack";
      until(sim, () => !!trackOf(sim, group[0])?.displayed, 60);
      const tr = trackOf(sim, group[0]);
      if (!tr) continue;
      if (!until(sim, () => sim.engage(tr.id, "RKT").ok, 60)) continue;
      until(sim, () => sim.effectorReady("RKT"), 20);
      multi = group.filter((g) => g.outcome === "neutralised").length >= 2;
    }
    expect(multi).toBe(true);
  });

  it("gunfire over a no-fire zone is logged as collateral", () => {
    const sc = emptySky();
    sc.map.no_fire_zones = [{ id: "TOWN", name: "Town", center: [600, 0], radius_m: 500 }];
    const sim = makeSim(sc);
    // flies radially (away from the radar) so MTI keeps it; slowly, so it stays over the town
    const q = inject(sim, "civil_drone", v3(650, 0), { toward: v3(2000, 0), agl: 60, speed: 4 });
    expect(until(sim, () => !!trackOf(sim, q)?.displayed, 40)).toBe(true);
    expect(sim.engage(trackOf(sim, q)!.id, "ZU").ok).toBe(true);
    until(sim, () => sim.events.some((e) => e.type === "collateral"), 10);
    expect(sim.events.some((e) => e.type === "collateral")).toBe(true);
    expect(sim.events.find((e) => e.type === "engage_order")!.data.over_nfz).toBe(true);
  });
});

describe("camera", () => {
  it("can only designate what is in its field of view, and a lock makes a track", () => {
    const sim = makeSim(emptySky());
    const e = inject(sim, "fpv_fiber", v3(900, 900), { agl: 40, speed: 1 });
    sim.cameraSlew(225, 0); // looking the wrong way
    sim.advance(6);
    expect(sim.cameraDesignate(e.id).ok).toBe(false);
    sim.cameraSlew(45, 2.5);
    sim.cameraZoom(4);
    sim.advance(6);
    const r = sim.cameraDesignate(e.id);
    expect(r.ok).toBe(true);
    expect(r.track).toBe(trackOf(sim, e)!.id);
    expect(sim.camera.lockTrack).toBe(r.track);
    sim.step();
    expect(trackOf(sim, e)!.displayed).toBe(true);
  });

  it("EO is useless at night beyond short range; IR still sees a hot target", () => {
    const sc = emptySky();
    sc.environment.time_of_day = "night";
    const sim = makeSim(sc);
    const e = inject(sim, "loitering_munition", v3(2100, 0), { agl: 150, speed: 1 });
    sim.cameraZoom(2);
    sim.advance(1);
    sim.cameraSlew(bearing(sim.cameraPos(), e.pos), elevation(sim.cameraPos(), e.pos));
    sim.advance(5);
    const eo = sim.cameraDesignate(e.id);
    expect(eo.ok).toBe(false);
    expect(eo.reason).toMatch(/dark/);
    sim.cameraMode("ir");
    expect(sim.cameraDesignate(e.id).ok).toBe(true);
  });
});

describe("ROE, end of mission, outputs", () => {
  it("authority requests are granted after the configured delay", () => {
    const sim = makeSim(emptySky());
    const q = inject(sim, "recon_quad", v3(1500, 0), { agl: 150 });
    until(sim, () => !!trackOf(sim, q)?.displayed, 60);
    const tr = trackOf(sim, q)!;
    sim.requestAuthority(tr.id);
    sim.advance(7);
    expect(tr.authority).toBe("requested");
    sim.advance(2);
    expect(tr.authority).toBe("granted");
  });

  it("ends early once every hostile is resolved, and the result is well formed", () => {
    const sim = makeSim(emptySky());
    const q = inject(sim, "fpv_rf", v3(1800, 0));
    until(sim, () => !!trackOf(sim, q)?.displayed, 60);
    sim.engage(trackOf(sim, q)!.id, "JAM");
    until(sim, () => sim.ended, 60);
    expect(sim.endReason).toBe("all_resolved");
    const r = sim.result();
    expect(r.truth.find((t) => t.id === q.id)!.outcome).toBe("link_lost");
    expect(r.replay!.frames.length).toBeGreaterThan(5);
    expect(r.events.at(-1)!.type).toBe("session_end");
  });

  it("the view never exposes ground truth", () => {
    const sim = makeSim(fixture());
    sim.advance(120);
    const json = JSON.stringify(sim.view());
    expect(json).not.toMatch(/fpv_fiber|loitering_munition|recon_quad|entityId|"cls"/);
  });
});

describe("camera video tracker", () => {
  it("locks the visible object nearest the crosshair, not one outside the inner field of view", () => {
    const sc = emptySky();
    const sim = makeSim(sc);
    const e = inject(sim, "recon_quad", v3(0, 1200), { agl: 100, speed: 1 });
    sim.cameraZoom(6);
    sim.advance(1);
    sim.cameraSlew(bearing(sim.cameraPos(), e.pos) + 1.2, elevation(sim.cameraPos(), e.pos));
    sim.advance(3);
    expect(sim.cameraTrackCentre().ok).toBe(true); // 1.2 deg off in a 6 deg view: inside the inner 60%
    sim.cameraUnlock();
    sim.cameraSlew(bearing(sim.cameraPos(), e.pos) + 2.5, elevation(sim.cameraPos(), e.pos));
    sim.advance(3);
    expect(sim.cameraTrackCentre().ok).toBe(false);
  });
});

describe("classification aid", () => {
  it("suggests from sensor features only, and the unreliable mode is confidently wrong on a fixed subset", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { makeAid } = await import("../src/aid.ts");
    const model = JSON.parse(readFileSync(fileURLToPath(new URL("../../content/aid/model.json", import.meta.url)), "utf8"));
    const honest = makeAid(model, "honest");
    const sim = makeSim(emptySky(), { aidMode: "honest", aid: honest });
    const e = inject(sim, "fpv_rf", v3(2400, 0));
    expect(until(sim, () => !!trackOf(sim, e)?.aid, 60)).toBe(true);
    const s = trackOf(sim, e)!.aid!;
    expect(s.label).toBe("fpv");
    expect(s.p).toBeGreaterThan(0.5);
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(sim.events.some((x) => x.type === "ai_suggestion")).toBe(true);
    // unreliable: over many tracks, about a third get a confident wrong answer
    const unreliable = makeAid(model, "unreliable");
    const sim2 = makeSim(fixture(), { aidMode: "unreliable", aid: unreliable });
    sim2.advance(200);
    const judged = sim2.tracks.filter((t) => t.aid);
    const wrong = judged.filter((t) => t.aid!.label !== sim2.byId.get(t.entityId)!.spec.label);
    expect(wrong.length / judged.length).toBeGreaterThan(0.2);
  });
});
