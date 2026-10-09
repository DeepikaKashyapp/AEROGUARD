/**
 * EO/IR camera (PLAN.md 6.6): the only 3D in the product, because it is where
 * classification happens. Renders ground truth as pixels: the trainee has to
 * slew, zoom, switch to IR at night and look. Clicking an object locks the
 * turret on it (laser rangefinder -> precise track in the sim).
 */
import type { DroneClass, Renderable, Sim } from "@cuas/sim";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const DEG = Math.PI / 180;

interface Props {
  sim: Sim;
  onMessage?: (text: string, kind?: "info" | "warn") => void;
}

export default function CameraView({ sim, onMessage }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hud = useRef<{ tl: HTMLDivElement | null; tr: HTMLDivElement | null; bl: HTMLDivElement | null }>({ tl: null, tr: null, bl: null });
  const [msg, setMsg] = useState<string | null>(null);
  const [mode, setMode] = useState(sim.camera.mode);
  const say = useRef(onMessage);
  say.current = onMessage;

  useEffect(() => {
    const wrap = wrapRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    wrap.prepend(renderer.domElement);
    const world = buildWorld(sim);
    const post = buildPost();
    const camera = new THREE.PerspectiveCamera(sim.camera.fov, 16 / 10, 1, 30000);
    if (import.meta.env.DEV) (window as unknown as { __cam: unknown }).__cam = { camera, world, THREE };
    let raf = 0;
    let w = 0;
    let h = 0;
    let lastMode = "";
    const startT = performance.now();

    const frame = () => {
      const rect = wrap.getBoundingClientRect();
      if (Math.round(rect.width) !== w || Math.round(rect.height) !== h) {
        w = Math.max(2, Math.round(rect.width));
        h = Math.max(2, Math.round(rect.height));
        renderer.setSize(w, h, false);
        post.target.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
        post.uniforms.res.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
        camera.aspect = w / h;
      }
      const cam = sim.camera;
      const ir = cam.mode === "ir";
      if (cam.mode !== lastMode) {
        lastMode = cam.mode;
        world.setMode(ir);
      }
      const from = sim.cameraPos();
      camera.position.set(from.x, from.z, -from.y);
      const dir = new THREE.Vector3(Math.sin(cam.az * DEG) * Math.cos(cam.el * DEG), Math.sin(cam.el * DEG), -Math.cos(cam.az * DEG) * Math.cos(cam.el * DEG));
      camera.lookAt(camera.position.clone().add(dir));
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
      world.update(sim.renderables(), camera, h, ir, sim.t);

      const available = sim.cameraAvailable();
      post.uniforms.time.value = (performance.now() - startT) / 1000;
      post.uniforms.ir.value = ir ? 1 : 0;
      post.uniforms.noise.value = world.noise(ir) + (available ? 0 : 0.6);
      post.uniforms.blur.value = world.blur(ir);
      post.uniforms.gain.value = available ? 1 : 0.15;
      renderer.setRenderTarget(post.target);
      renderer.render(world.scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(post.scene, post.camera);

      const H = hud.current;
      if (H.tl) H.tl.textContent = `${ir ? "IR WHITE-HOT" : "EO"}  FOV ${cam.fov.toFixed(1)}°`;
      if (H.tr) H.tr.textContent = `AZ ${cam.az.toFixed(1).padStart(5, "0")}  EL ${cam.el.toFixed(1)}`;
      if (H.bl)
        H.bl.textContent = !available
          ? "CAMERA DOWN"
          : cam.lockTrack
            ? `LOCK ${cam.lockTrack} · LRF`
            : cam.cueTrack
              ? `CUED ${cam.cueTrack}`
              : "MANUAL · click a target or press V to lock";
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // --- interaction ---------------------------------------------------------
    const el = renderer.domElement;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag = { x: e.clientX, y: e.clientY, moved: true };
      const fov = sim.camera.fov;
      sim.cameraNudge((dx / w) * fov * (w / h) * 1.2, (-dy / h) * fov * 1.2);
    };
    const onUp = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const b = el.getBoundingClientRect();
        const id = world.pick(camera, e.clientX - b.left, e.clientY - b.top, w, h);
        if (!id) flash("Nothing there to lock");
        else {
          const r = sim.cameraDesignate(id);
          flash(r.ok ? `Locked ${r.track} · laser rangefinder` : `No lock: ${r.reason}`);
        }
      }
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sim.cameraZoom(sim.camera.fov * (e.deltaY < 0 ? 0.8 : 1.25));
    };
    let msgTimer = 0;
    const flash = (text: string) => {
      setMsg(text);
      clearTimeout(msgTimer);
      msgTimer = window.setTimeout(() => setMsg(null), 1800);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    const modeTimer = window.setInterval(() => setMode(sim.camera.mode), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(modeTimer);
      clearTimeout(msgTimer);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      world.dispose();
      post.target.dispose();
      renderer.dispose();
      el.remove();
    };
  }, [sim]);

  return (
    <div className="camera" ref={wrapRef}>
      <div className="cam-hud">
        <div className="tl" ref={(e) => { hud.current.tl = e; }} />
        <div className="tr" ref={(e) => { hud.current.tr = e; }} />
        <div className="bl" ref={(e) => { hud.current.bl = e; }} />
        <svg className="reticle" viewBox="0 0 46 46" aria-hidden="true">
          <path d="M0 23h9M37 23h9M23 0v9M23 37v9" stroke="#9ef0c9" strokeWidth="1.2" fill="none" />
          <path d="M12 16v-4h4M30 12h4v4M34 30v4h-4M16 34h-4v-4" stroke="#9ef0c9" strokeWidth="0.9" fill="none" />
        </svg>
        {msg && <div className="msg">{msg}</div>}
        <div className="cam-tools">
          <button onClick={() => { sim.cameraMode(mode === "ir" ? "eo" : "ir"); setMode(sim.camera.mode); }} title="Toggle EO / IR (T)">
            {mode === "ir" ? "→ EO" : "→ IR"}
          </button>
          <button onClick={() => sim.cameraZoom(sim.camera.fov * 0.6)} title="Zoom in (+)">＋</button>
          <button onClick={() => sim.cameraZoom(sim.camera.fov / 0.6)} title="Zoom out (−)">－</button>
          <button onClick={() => { const r = sim.cameraTrackCentre(); setMsg(r.ok ? `Locked ${r.track} · laser rangefinder` : `No lock: ${r.reason}`); }} title="Lock the object nearest the crosshair (V)">lock V</button>
          <button onClick={() => sim.cameraUnlock()} title="Release lock">free</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

interface Visual {
  group: THREE.Group;
  dot: THREE.Sprite;
  wings: THREE.Object3D[];
  heat: number;
  cls: DroneClass;
  size: number;
}

function buildWorld(sim: Sim) {
  const sc = sim.sc;
  const env = sc.environment;
  const wx = sim.weatherFx();
  const scene = new THREE.Scene();
  const night = env.time_of_day === "night";
  const dusk = env.time_of_day === "dusk";
  const light = night ? 0.12 : dusk ? 0.55 : 1;

  const skyEO = new THREE.Color(night ? 0x05070b : dusk ? 0x8d6b5c : env.weather === "clear" ? 0x9fc6ea : 0xa9b4bd);
  const skyIR = new THREE.Color(0x101214);
  const hemi = new THREE.HemisphereLight(night ? 0x223044 : dusk ? 0xffc8a0 : 0xdfefff, 0x2a2a20, night ? 0.08 : dusk ? 0.6 : 1.1);
  const sun = new THREE.DirectionalLight(dusk ? 0xffa060 : 0xffffff, night ? 0.04 : dusk ? 0.7 : 1.4);
  sun.position.set(-3000, dusk ? 1200 : 6000, 2000);
  scene.add(hemi, sun);

  // terrain
  const t = sim.terrain;
  const geo = new THREE.PlaneGeometry(t.size, t.size, t.n - 1, t.n - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, t.height(pos.getX(i), -pos.getZ(i)));
  geo.computeVertexNormals();
  const groundEO = new THREE.MeshLambertMaterial({ color: dusk ? 0x4a4432 : 0x46553a });
  const groundIR = new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(night ? 0.16 : 0.3) });
  const ground = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geo, groundEO);
  scene.add(ground);

  // base structures (so the picture has scale)
  const blocks: THREE.Mesh[] = [];
  for (const a of sc.map.assets) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(a.radius_m, 8, a.radius_m * 0.6), new THREE.MeshLambertMaterial({ color: 0x5b5f60 }));
    m.position.set(a.pos[0], t.height(a.pos[0], a.pos[1]) + 4, -a.pos[1]);
    m.userData.heat = 0.42;
    scene.add(m);
    blocks.push(m);
  }

  const visuals = new Map<string, Visual>();
  const dotTex = makeDotTexture();
  const geoms = makeGeometries();
  const eoMats: Record<string, THREE.Material> = {
    dark: new THREE.MeshLambertMaterial({ color: 0x23262a }),
    white: new THREE.MeshLambertMaterial({ color: 0xd8dade }),
    grey: new THREE.MeshLambertMaterial({ color: 0x8a9096 }),
    brown: new THREE.MeshLambertMaterial({ color: 0x3d3128 }),
  };
  const irCache = new Map<number, THREE.MeshBasicMaterial>();
  const irMat = (heat: number) => {
    const k = Math.round(heat * 20) / 20;
    let m = irCache.get(k);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(0.18 + 0.82 * k) });
      irCache.set(k, m);
    }
    return m;
  };
  let irOn = false;

  const visFor = (r: Renderable): Visual => {
    let v = visuals.get(r.id);
    if (v) return v;
    const { group, wings } = makeModel(r.cls, geoms, eoMats);
    group.scale.setScalar(r.size);
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.heat = r.thermal;
    });
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: true }));
    scene.add(group, dot);
    v = { group, dot, wings, heat: r.thermal, cls: r.cls, size: r.size };
    visuals.set(r.id, v);
    applyMode(v.group, irOn);
    return v;
  };

  const applyMode = (root: THREE.Object3D, ir: boolean) => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.eo === undefined) m.userData.eo = m.material;
      m.material = ir ? irMat(m.userData.heat ?? 0.3) : (m.userData.eo as THREE.Material);
    });
  };

  const fogEO = new THREE.Fog(skyEO, 200, Math.max(600, wx.eo_vis_km * 1000));
  const fogIR = new THREE.Fog(skyIR, 1500, Math.max(2500, wx.ir_vis_km * 1000 * 2));

  const setMode = (ir: boolean) => {
    irOn = ir;
    scene.background = ir ? skyIR : skyEO;
    scene.fog = ir ? fogIR : fogEO;
    ground.material = ir ? groundIR : groundEO;
    for (const b of blocks) applyMode(b, ir);
    for (const v of visuals.values()) applyMode(v.group, ir);
  };

  const update = (rs: Renderable[], camera: THREE.PerspectiveCamera, heightPx: number, ir: boolean, simT: number) => {
    const seen = new Set<string>();
    const tanHalf = Math.tan((camera.fov * DEG) / 2);
    for (const r of rs) {
      seen.add(r.id);
      const v = visFor(r);
      v.group.position.set(r.x, r.z, -r.y);
      v.group.rotation.set(r.flying ? r.pitch * DEG * 0.6 : 0.9, -r.heading * DEG, r.flying ? 0 : 0.6, "YXZ");
      for (const [i, w] of v.wings.entries()) w.rotation.z = (i ? -1 : 1) * Math.sin(r.flap) * 0.7;
      // the sub-pixel "glint" a real sensor shows for a distant target
      const d = camera.position.distanceTo(v.group.position);
      const px = (r.size / (2 * d * tanHalf)) * heightPx;
      // same visibility rule the sim uses for designation, so "I can see it" and "I can lock it" agree
      const visRange = ir ? wx.ir_vis_km * 1000 * (0.5 + 0.7 * r.thermal) : wx.eo_vis_km * 1000 * light;
      const fade = Math.min(1, Math.max(0, 1.15 - d / Math.max(1, visRange)));
      const contrast = ir ? 0.45 + 0.55 * r.thermal : light * 0.85;
      const mat = v.dot.material as THREE.SpriteMaterial;
      mat.color.setScalar(ir ? 0.65 + 0.35 * r.thermal : 0.08);
      // thin airframes seen edge-on rasterise to almost nothing below ~12 px: the glint carries them
      mat.opacity = r.flying ? Math.min(1, Math.sqrt(fade) * contrast * (px < 12 ? 1 : 0.3)) : 0;
      const dotPx = Math.min(5, Math.max(ir ? 2.4 : 1.8, px * 0.45));
      v.dot.scale.setScalar((dotPx * 2 * tanHalf) / heightPx);
      v.dot.position.copy(v.group.position);
      v.group.visible = true;
      if (!r.flying) v.group.position.y -= 0.2 * Math.max(0, simT % 1);
    }
    for (const [id, v] of visuals) {
      if (!seen.has(id)) {
        v.group.visible = false;
        (v.dot.material as THREE.SpriteMaterial).opacity = 0;
      }
    }
  };

  const pick = (camera: THREE.PerspectiveCamera, x: number, y: number, w: number, h: number): string | null => {
    let best: string | null = null;
    let bd = 16;
    const p = new THREE.Vector3();
    for (const [id, v] of visuals) {
      if (!v.group.visible) continue;
      p.copy(v.group.position).project(camera);
      if (p.z > 1 || p.z < -1) continue;
      const sx = ((p.x + 1) / 2) * w;
      const sy = ((1 - p.y) / 2) * h;
      const dd = Math.hypot(sx - x, sy - y);
      if (dd < bd) {
        bd = dd;
        best = id;
      }
    }
    return best;
  };

  setMode(false);
  return {
    visuals,
    scene,
    setMode,
    update,
    pick,
    noise: (ir: boolean) => (ir ? 0.07 : night ? 0.12 : dusk ? 0.05 : 0.03) + (env.weather === "rain" ? 0.03 : 0),
    blur: (ir: boolean) => (ir ? 0.35 : 0.1) + (env.weather === "fog" ? 0.3 : env.weather === "haze" ? 0.1 : 0),
    dispose: () => {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      dotTex.dispose();
    },
  };
}

function makeDotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function makeGeometries() {
  const deltaShape = new THREE.Shape();
  deltaShape.moveTo(0, -0.45);
  deltaShape.lineTo(0.5, 0.25);
  deltaShape.lineTo(-0.5, 0.25);
  deltaShape.closePath();
  return {
    box: new THREE.BoxGeometry(1, 1, 1),
    rotor: new THREE.CylinderGeometry(0.5, 0.5, 0.02, 16),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
    delta: new THREE.ExtrudeGeometry(deltaShape, { depth: 0.03, bevelEnabled: false }).rotateX(Math.PI / 2),
    sphere: new THREE.SphereGeometry(0.5, 12, 8),
    wing: new THREE.PlaneGeometry(1, 0.35).rotateX(-Math.PI / 2),
  };
}

function makeModel(cls: DroneClass, g: ReturnType<typeof makeGeometries>, m: Record<string, THREE.Material>) {
  const group = new THREE.Group();
  const wings: THREE.Object3D[] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, s: [number, number, number], p: [number, number, number], r: [number, number, number] = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(...s);
    mesh.position.set(...p);
    mesh.rotation.set(...r);
    group.add(mesh);
    return mesh;
  };
  if (cls === "recon_quad" || cls === "civil_drone" || cls === "fpv_rf" || cls === "fpv_fiber") {
    const mat = cls === "civil_drone" ? m.white : m.dark;
    add(g.box, mat, [0.35, 0.12, 0.35], [0, 0, 0]);
    for (const [x, z] of [[0.38, 0.38], [-0.38, 0.38], [0.38, -0.38], [-0.38, -0.38]]) {
      add(g.box, mat, [0.5, 0.04, 0.05], [x / 2, 0, z / 2], [0, Math.atan2(z, x), 0]);
      add(g.rotor, m.grey, [0.42, 1, 0.42], [x, 0.05, z]);
    }
    if (cls !== "civil_drone") add(g.box, m.grey, [0.08, 0.08, 0.12], [0, -0.02, -0.22]);
  } else if (cls === "loitering_munition" || cls === "decoy") {
    add(g.delta, m.dark, [1, 1, 1], [0, 0, 0]);
    add(g.cyl, m.dark, [0.09, 0.8, 0.09], [0, 0.02, -0.05], [Math.PI / 2, 0, 0]);
    add(g.box, m.dark, [0.02, 0.14, 0.15], [0.48, 0.07, 0.2]);
    add(g.box, m.dark, [0.02, 0.14, 0.15], [-0.48, 0.07, 0.2]);
  } else if (cls === "friendly_uav") {
    add(g.box, m.grey, [1, 0.03, 0.11], [0, 0, -0.05]);
    add(g.cyl, m.grey, [0.07, 0.55, 0.07], [0, 0, 0], [Math.PI / 2, 0, 0]);
    add(g.box, m.grey, [0.32, 0.02, 0.07], [0, 0.05, 0.26], [0, 0, 0.3]);
  } else {
    add(g.sphere, m.brown, [0.22, 0.16, 0.42], [0, 0, 0]);
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.08, 0, 0);
      const wing = new THREE.Mesh(g.wing, m.brown);
      wing.scale.set(0.5, 1, 1);
      wing.position.set(side * 0.25, 0, 0);
      pivot.add(wing);
      group.add(pivot);
      wings.push(pivot);
    }
  }
  return { group, wings };
}

function buildPost() {
  const target = new THREE.WebGLRenderTarget(2, 2, { samples: 4 });
  const uniforms = {
    tDiffuse: { value: target.texture },
    res: { value: new THREE.Vector2(2, 2) },
    time: { value: 0 },
    noise: { value: 0.02 },
    blur: { value: 0.1 },
    gain: { value: 1 },
    ir: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 res; uniform float time, noise, blur, gain, ir;
      varying vec2 vUv;
      float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233)) + time * 7.0) * 43758.5453); }
      void main() {
        vec2 px = 1.0 / res;
        vec3 c0 = texture2D(tDiffuse, vUv).rgb;
        vec3 cb = c0 * 0.4 + (texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb
                 + texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb) * 0.15;
        vec3 c = mix(c0, cb, clamp(blur, 0.0, 1.0));
        if (ir > 0.5) { float l = dot(c, vec3(0.299, 0.587, 0.114)); c = vec3(l * 0.95, l, l * 0.95); }
        c *= gain;
        // the scene was rendered to a linear render target: encode to sRGB for the screen,
        // then add sensor noise in display space so dark night scenes don't amplify it
        c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
        c += (rand(vUv * res) - 0.5) * noise;
        float v = smoothstep(0.85, 0.35, length(vUv - 0.5));
        c *= mix(0.72, 1.0, v);
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { target, uniforms, scene, camera };
}
