// PATTERSON — single-photo Gaussian splat game menu (desktop + Quest 3 WebXR)
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkXr, isOculus, isMobile } from "@sparkjsdev/spark";
import { roomEffects, textEffects, dustEffects, inkEffects, moteEffects, rimEffects, outlineSegments, outlineNearest } from "./effects.js";
import * as T from "./typography.js";

const V3 = THREE.Vector3;
const params = new URLSearchParams(location.search);
const IS_QUEST = isOculus();
const IS_PHONE = !IS_QUEST && isMobile();
const TIER = params.get("tier") || (IS_QUEST || IS_PHONE ? "quest" : "high");
const NO_HOVER = matchMedia("(hover: none)").matches;   // touch-first device
const ASSETS = new URL("../public/assets/", import.meta.url).href;
const ui = {
  loading: document.getElementById("loading"), bar: document.getElementById("bar"), pct: document.getElementById("pct"),
  hint: document.getElementById("hint"), vr: document.getElementById("vr"), fade: document.getElementById("fade"),
};
const settings = { flicker: true, dof: true, pointerLight: true };
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp, damp = THREE.MathUtils.damp;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// ------------------------------------------------------------------ scene data
// Binary assets may be shipped as base64 text (*.b64.txt) for hosts that only serve text/data types.
function decodeBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text.trim());
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const asBytes = (name, buf) => (name.endsWith(".b64.txt") ? decodeBase64(new TextDecoder().decode(buf)) : new Uint8Array(buf));
const info = await (await fetch(`${ASSETS}scene-${TIER}.json`)).json();
const gridBytes = asBytes(info.depth_grid.file, await (await fetch(ASSETS + info.depth_grid.file)).arrayBuffer());
const grid = new Float32Array(gridBytes.buffer, gridBytes.byteOffset, gridBytes.byteLength / 4);
const GW = info.depth_grid.width, GH = info.depth_grid.height;
const PW = info.photo.width, PH = info.photo.height, F = info.photo.focal_px;
const MR = info.camera.world_from_cam_rows;
const col = (i) => new V3(MR[0][i], MR[1][i], MR[2][i]);
const CAM = { pos: new V3().fromArray(info.camera.position), right: col(0), down: col(1), fwd: col(2) };
CAM.up = CAM.down.clone().negate();

function unproject(u, v, z) {
  return CAM.pos.clone().addScaledVector(CAM.right, ((u - PW / 2) / F) * z)
    .addScaledVector(CAM.down, ((v - PH / 2) / F) * z).addScaledVector(CAM.fwd, z);
}
function project(p) {
  const d = new V3().subVectors(p, CAM.pos);
  const z = d.dot(CAM.fwd);
  return { u: (F * d.dot(CAM.right)) / z + PW / 2, v: (F * d.dot(CAM.down)) / z + PH / 2, z };
}
function depthAt(u, v) {
  const gx = clamp(Math.floor((u / PW) * GW), 0, GW - 1), gy = clamp(Math.floor((v / PH) * GH), 0, GH - 1);
  return grid[gy * GW + gx];
}
const surface = (u, v) => unproject(u, v, depthAt(u, v));

/** Fit a plane to the photographed surface inside an image rect → oriented frame. */
function planeFrame(u0, v0, u1, v1, { floor = false } = {}) {
  const pts = [];
  for (let v = v0; v <= v1; v += 8) for (let u = u0; u <= u1; u += 8) pts.push(surface(u, v));
  const c = pts.reduce((a, p) => a.add(p), new V3()).divideScalar(pts.length);
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  const n = smallestEigenvector(C);
  if (n.dot(new V3().subVectors(CAM.pos, c)) < 0) n.negate();
  const worldUp = new V3(0, 1, 0);
  let right;
  if (floor || Math.abs(n.dot(worldUp)) > 0.8) {
    right = CAM.right.clone().addScaledVector(n, -CAM.right.dot(n)).normalize();
  } else {
    right = new V3().crossVectors(worldUp, n).normalize();
  }
  const up = new V3().crossVectors(n, right).normalize();
  return { center: c, normal: n, right, up };
}
function smallestEigenvector(C) {
  // inverse power iteration on (C + eps I)
  const m = new THREE.Matrix3().set(C[0], C[1], C[2], C[3], C[4], C[5], C[6], C[7], C[8]);
  const tr = C[0] + C[4] + C[8];
  const e = m.clone(); e.elements[0] += tr * 1e-6; e.elements[4] += tr * 1e-6; e.elements[8] += tr * 1e-6;
  const inv = e.invert();
  let x = new V3(0.3, 0.5, 0.8);
  for (let i = 0; i < 40; i++) x.applyMatrix3(inv).normalize();
  return x;
}
/** Ray ∩ plane. */
function rayPlane(u, v, frame) {
  const dir = unproject(u, v, 1).sub(CAM.pos).normalize();
  const t = new V3().subVectors(frame.center, CAM.pos).dot(frame.normal) / dir.dot(frame.normal);
  return CAM.pos.clone().addScaledVector(dir, t);
}
function placeOn(group, frame, pos, lift = 0) {
  group.position.copy(pos).addScaledVector(frame.normal, lift);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.right, frame.up, frame.normal));
}
/** March a room-local ray against the depth photo. */
function roomHit(origin, dir, maxDist = 8) {
  let prevInside = false;
  for (let t = 0.05; t < maxDist; t += 0.02 + t * 0.012) {
    const p = origin.clone().addScaledVector(dir, t);
    const pr = project(p);
    if (pr.z <= 0.05) continue;
    const inside = pr.u >= 0 && pr.u < PW && pr.v >= 0 && pr.v < PH;
    if (!inside) { if (prevInside) return null; continue; }
    prevInside = true;
    if (pr.z >= depthAt(pr.u, pr.v)) return p;
  }
  return null;
}

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
// phones get a sharper start and step down if the frame rate can't keep up (see adaptResolution)
let pixelRatio = Math.min(devicePixelRatio, IS_PHONE ? 1.5 : TIER === "quest" ? 1 : 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x050403, 1);
document.getElementById("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
const spark = new SparkRenderer({ renderer });
scene.add(spark);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 60);
scene.add(camera);
const worldRoot = new THREE.Group();     // re-anchored to the head in VR
scene.add(worldRoot);

// ------------------------------------------------------------------ room
const CRT_LIFT = 3;   // lifts 0-2: the game's clipboards; 3-4: the terminal (one outline per quad, photo px)
const CRT_QUADS = [
  [[398, 869], [567, 865], [592, 996], [380, 1046]],
  [[356, 927], [400, 869], [400, 1044], [372, 1046]],
];
const room = roomEffects(3, { lifts: CRT_LIFT + CRT_QUADS.length, cam: { pos: CAM.pos, right: CAM.right, down: CAM.down, fwd: CAM.fwd, focal: F, width: PW, height: PH } });
const showProgress = (p) => { ui.bar.style.transform = `scaleX(${p})`; ui.pct.textContent = `${Math.round(p * 100)}%`; };
// Hosts with a per-file size cap get the splat as parts: window.PATTERSON_SPLAT_PARTS = { high: [...], quest: [...] }
async function fetchParts(names) {
  const res = await Promise.all(names.map((n) => fetch(ASSETS + n)));
  const sizes = res.map((r) => +(r.headers.get("content-length") || 0));
  const total = sizes.reduce((a, b) => a + b, 0);
  const chunks = [];
  let loaded = 0;
  for (const [i, r] of res.entries()) {
    if (!r.ok) throw new Error(`splat part ${r.url}: ${r.status}`);
    const reader = r.body.getReader();
    const raw = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw.push(value);
      loaded += value.length;
      if (total) showProgress(Math.min(1, loaded / total));
    }
    const joined = new Uint8Array(raw.reduce((a, c) => a + c.length, 0));
    let k = 0;
    for (const c of raw) { joined.set(c, k); k += c.length; }
    chunks.push(asBytes(names[i], joined.buffer));
  }
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
const parts = window.PATTERSON_SPLAT_PARTS?.[TIER];
const roomMesh = parts
  ? new SplatMesh({ fileBytes: await fetchParts(parts), fileName: `patterson-${TIER}.spz`, lod: false })
  : new SplatMesh({
    url: `${ASSETS}patterson-${TIER}.spz`,
    lod: false,
    onProgress: (e) => { if (e.lengthComputable) showProgress(e.loaded / e.total); },
  });
roomMesh.objectModifier = room.modifier;
worldRoot.add(roomMesh);
const fontsReady = T.loadFonts();

// ------------------------------------------------------------------ dust
const dust = dustEffects();
const dustMesh = new SplatMesh({
  constructSplats: (splats) => {
    const c = new V3(), s = new V3(), q = new THREE.Quaternion(), color = new THREE.Color();
    let seed = 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (TIER === "quest" ? 500 : 1100); i++) {
      // concentrate motes in the window light shaft, sprinkle the rest
      const shaft = r() < 0.6;
      const p = shaft ? unproject(900 + r() * 260, 520 + r() * 700, 1.4 + r() * 2.6) : unproject(r() * PW, r() * PH * 0.8, 0.9 + r() * 3.0);
      c.copy(p);
      s.setScalar(0.0012 + r() * 0.0022);
      color.setRGB(1.0, 0.93, 0.8);
      splats.pushSplat(c, s, q, 0.35 + r() * 0.5, color);
    }
  },
});
dustMesh.objectModifier = dust.modifier;
worldRoot.add(dustMesh);

// ------------------------------------------------------------------ menu objects
const items = [];          // selectable things
let state = "intro";       // intro | main | play | card | busy | ended
let focus = 0;             // keyboard/gamepad index into active list
let hovered = null;
let signHover = false;
// escape game ("clock out"): while active, the room's selectable layer is "play" instead of "main"
const game = { active: false, step: 0, entry: "", t0: 0, won: false, busy: false, hasCard: false, readRP: false, sawDigit: false, penalty: 0 };
const GAME_RESET = { step: 0, entry: "", won: false, busy: false, hasCard: false, readRP: false, sawDigit: false, penalty: 0 };
const baseLayer = () => (game.active ? "play" : "main");
const pickables = () => items.filter((it) => it.enabled && it.layer === (state === "card" ? "card" : baseLayer()));

// extra: selfLit (ignores the room light), hoverReveal (shows only while hovered), torchAt (keyboard torch target)
function makeItem({ id, mesh, fx, group, w, h, light, color = new V3(1, 0.85, 0.6), layer = "main", onSelect, order = 0, hitLift = 0.01, ...extra }) {
  mesh.objectModifier = fx.modifier;
  group.add(mesh);
  const hit = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.z = hitLift;
  group.add(hit);
  worldRoot.add(group);
  const it = { id, mesh, fx, group, hit, light: light ?? group.position.clone(), color, layer, onSelect, order, hover: 0, press: 0, reveal: 0, revealTarget: 0, enabled: true, ...extra };
  hit.userData.item = it;
  items.push(it);
  return it;
}

let crt, signRig, drawerFrames, cabFrame;
const labelSpots = [];
const options = { quality: TIER };
await Promise.all([roomMesh.initialized, fontsReady]);

function buildMenu() {
  // CONTINUE — on the CRT glass
  const screen = planeFrame(462, 898, 566, 984);
  const scrPos = rayPlane(512, 940, screen);
  const crtGroup = new THREE.Group();
  placeOn(crtGroup, screen, scrPos, 0.012);
  const crtFx = textEffects("crt");
  crt = makeItem({
    id: "continue", group: crtGroup, fx: crtFx, w: 0.21, h: 0.16, order: 0, color: new V3(0.3, 1, 0.45),
    mesh: crtLines("idle"), light: scrPos.clone(),
    onSelect: () => doContinue(),
  });
  crt.basePos = crtGroup.position.clone();
  // the whole monitor (case and bezel) cut out of the photo, so it can float up to you to be read.
  // Two quads trace its outline: the front, and the sloped left side of the case (the wall above it stays put).
  // The outline hugs the monitor, so the depth window can reach far: the splat build snapped the bezel's
  // edge pixels back onto the calendar / wall behind (≈ 2.5-2.8 m), and those must come along too.
  CRT_QUADS.forEach((q, k) => {
    const L = room.uniforms.lifts[CRT_LIFT + k];
    L.ab.value.set(...q[0], ...q[1]);
    L.cd.value.set(...q[2], ...q[3]);
    L.z.value.set(2.15, 2.95);
  });

  // drawer labels: NEW GAME / LOAD GAME / OPTIONS on the black cabinet
  const cab = cabFrame = planeFrame(1320, 1400, 1520, 1760);
  // drawer quads (photo px): top edge, bottom edge as [uL,vL,uR,vR]
  const edges = [
    [1300, 1355, 1536, 1450], [1295, 1458, 1536, 1560], [1275, 1565, 1536, 1675], [1255, 1740, 1536, 1850],
  ];
  drawerFrames = [];
  for (let k = 0; k < 3; k++) {
    const top = edges[k], bot = edges[k + 1];
    const pts = [rayPlane(top[0], top[1], cab), rayPlane(top[2], top[3], cab), rayPlane(bot[0], bot[1], cab), rayPlane(bot[2], bot[3], cab)];
    const c = pts.reduce((a, p) => a.add(p), new V3()).divideScalar(4);
    let hx = 0, hy = 0;
    for (const p of pts) {
      const d = new V3().subVectors(p, c);
      hx = Math.max(hx, Math.abs(d.dot(cab.right)));
      hy += Math.abs(d.dot(cab.up)) / 4;
    }
    const D = room.uniforms.drawers[k];
    D.c.value.copy(c).addScaledVector(cab.normal, -0.01);
    D.x.value.copy(cab.right); D.y.value.copy(cab.up); D.z.value.copy(cab.normal);
    D.h.value.set(hx * 1.08, hy * 0.92, 0.075);
    drawerFrames.push({ center: c, frame: cab, half: new THREE.Vector2(hx, hy), open: 0, target: 0 });
  }
  const labels = [
    { id: "new", text: "NEW GAME", tape: "#b3201c", at: [1390, 1415], onSelect: () => startGame() },
    { id: "load", text: "LOAD GAME", tape: "#1b1b1d", at: [1385, 1520], onSelect: () => openCard("load", 1) },
    { id: "options", text: "OPTIONS", tape: "#1f4f9c", at: [1372, 1632], onSelect: () => openCard("options", 2) },
  ];
  labels.forEach((L, k) => {
    const g = new THREE.Group();
    // whichever is nearer: fitted cabinet plane or the measured drawer surface at this pixel
    const onPlane = rayPlane(L.at[0], L.at[1], cab);
    const measured = Math.min(...[[-10, 0], [10, 0], [0, -6], [0, 6], [0, 0]].map(([du, dv]) => depthAt(L.at[0] + du, L.at[1] + dv)));
    const onSurface = unproject(L.at[0], L.at[1], measured);
    const pos = onSurface.distanceTo(CAM.pos) < onPlane.distanceTo(CAM.pos) ? onSurface : onPlane;
    labelSpots[k] = pos.clone();
    placeOn(g, cab, pos, 0.012);
    const it = makeItem({
      id: L.id, group: g, fx: textEffects("plain"), w: 0.26, h: 0.05, order: k + 1,
      mesh: T.dymoTape(L.text, { tape: L.tape, seed: 3 + k * 17, heightM: 0.048 }),
      light: drawerFrames[k].center.clone().addScaledVector(cab.normal, 0.05), onSelect: L.onSelect,
    });
    it.drawer = k;
  });

  // QUIT — stencilled on the floor
  const floor = planeFrame(1010, 1480, 1230, 1640, { floor: true });
  const fg = new THREE.Group();
  placeOn(fg, floor, rayPlane(1112, 1560, floor), 0.003);
  makeItem({
    id: "quit", group: fg, fx: textEffects("plain"), w: 0.6, h: 0.62, order: 4, color: new V3(1, 0.8, 0.2),
    mesh: T.floorStencil("QUIT", "EXIT TO DESKTOP"), onSelect: () => doQuit(),
  });

  // title: enamel sign hanging from the ceiling, facing the viewer
  const ceilingY = surface(700, 150).y;
  const signPos = new V3(0.0, 1.86, CAM.pos.z - 2.35);
  const pivot = new V3(signPos.x, ceilingY - 0.01, signPos.z);
  const rig = new THREE.Group();
  rig.position.copy(pivot);
  const toCam = new V3(CAM.pos.x - pivot.x, 0, CAM.pos.z - pivot.z).normalize();
  rig.rotation.y = Math.atan2(toCam.x, toCam.z) - 0.12;
  const swing = new THREE.Group();
  rig.add(swing);
  const sign = T.enamelSign("PATTERSON", "SERVICE  ·  PARTS  ·  REPAIR");
  const drop = pivot.y - signPos.y;
  const signGroup = new THREE.Group();
  signGroup.position.set(0, -drop, 0);
  swing.add(signGroup);
  const signFx = textEffects("plain");
  sign.mesh.objectModifier = signFx.modifier;
  signGroup.add(sign.mesh);
  for (const sx of [-1, 1]) {
    const ch = T.chain(new V3(sx * sign.width * 0.4, 0, 0.0), new V3(sx * sign.width * 0.4, -drop + sign.height / 2 - 0.004, 0.0));
    swing.add(ch);
  }
  const signHit = new THREE.Mesh(new THREE.PlaneGeometry(sign.width, sign.height), new THREE.MeshBasicMaterial({ visible: false }));
  signGroup.add(signHit);
  worldRoot.add(rig);
  signRig = { rig, swing, fx: signFx, hit: signHit, angle: 0, vel: 0, roll: 0, rollVel: 0, hover: 0, reveal: 0, pos: signPos };
  signHit.userData.sign = true;
}

function crtLines(mode, progress = 0) {
  if (mode === "loading") {
    const bars = 14, n = Math.round(progress * bars);
    return T.crtScreen([
      { text: "C:\\PATTERSON> RUN", size: 0.13, y: 0.18 },
      { text: "LOADING BAY 2...", size: 0.16, y: 0.42 },
      { text: "[" + "#".repeat(n) + ".".repeat(bars - n) + "]", size: 0.15, y: 0.64 },
      { text: `${Math.round(progress * 100)}%`, size: 0.13, y: 0.84 },
    ]);
  }
  return T.crtScreen([
    { text: "C:\\PATTERSON>", size: 0.12, y: 0.16 },
    { text: "CONTINUE", size: 0.34, y: 0.47, x: 0.05 },
    { text: "BAY 2 · WORK ORDER 0417", size: 0.10, y: 0.76 },
    { text: "_", size: 0.12, y: 0.9 },
  ]);
}
function swapMesh(it, mesh) {
  it.group.remove(it.mesh);
  it.mesh.dispose?.();
  mesh.objectModifier = it.fx.modifier;
  it.mesh = mesh;
  it.group.add(mesh);
}

// ------------------------------------------------------------------ sub-menu card
let card = null;
function openCard(kind, drawerIndex) {
  drawerFrames.forEach((d, k) => (d.target = k === drawerIndex ? 0.16 : 0));
  const d = drawerFrames[drawerIndex];
  const lines = kind === "options" ? [
    { label: () => `LIGHT FLICKER ....... ${settings.flicker ? "ON " : "OFF"}`, act: () => { settings.flicker = !settings.flicker; } },
    { label: () => `DEPTH OF FIELD ...... ${settings.dof ? "ON " : "OFF"}`, act: () => { settings.dof = !settings.dof; } },
    { label: () => `POINTER LIGHT ....... ${settings.pointerLight ? "ON " : "OFF"}`, act: () => { settings.pointerLight = !settings.pointerLight; } },
    { label: () => `QUALITY ............. ${options.quality.toUpperCase()}`, act: () => {
      if (renderer.xr.isPresenting) return;
      const next = options.quality === "high" ? "quest" : "high";
      params.set("tier", next); location.search = params.toString();
    } },
    { label: () => "< BACK", act: () => closeCard() },
  ] : [
    { label: () => "SLOT 1 ..... BAY 2, WORK ORDER 0417", act: () => { closeCard(); doContinue(); } },
    { label: () => "SLOT 2 ..... -- EMPTY --", act: null },
    { label: () => "SLOT 3 ..... -- EMPTY --", act: null },
    { label: () => "< BACK", act: () => closeCard() },
  ];
  spawnCard({
    kind, title: kind === "options" ? "OPTIONS" : "LOAD GAME", lines,
    from: d.center.clone().addScaledVector(d.frame.normal, 0.05),
    anchor: CAM.pos.clone().lerp(d.center, 0.52).add(new V3(-0.08, 0.2, 0)),   // ~1 m away, handed out of the drawer
  });
}
/**
 * A hand-held card that flies from `from` to `anchor`. lines: [{ label(), act, x, y, w, h, style, selfLit, keep }]
 * (default layout: one typed line per row). `keep` skips re-typing the line after it's used.
 */
function spawnCard({ kind, title, lines, from, anchor, mesh = T.indexCard(), onClose, fixed = false }) {
  closeCard(true);
  state = "card";
  let pos = anchor.clone();
  // small screens: hold the card closer, in the middle of the view, so its lines are big enough to read and tap
  // (fixed: the caller already laid it out up close, e.g. beside the zoomed terminal)
  const near = !fixed && !renderer.xr.isPresenting && cardDistance(pos.distanceTo(CAM.pos));
  if (near) pos = camera.position.clone().addScaledVector(camera.getWorldDirection(new V3()), near);
  const group = new THREE.Group();
  group.position.copy(pos);
  const cardFx = textEffects("plain");
  mesh.objectModifier = cardFx.modifier;
  group.add(mesh);
  worldRoot.add(group);
  worldRoot.updateMatrixWorld(true);
  if (near) { group.up.copy(camera.up); group.lookAt(camera.position); }
  else group.lookAt(worldRoot.localToWorld(CAM.pos.clone()));   // +z faces the photo viewpoint
  if (title) {
    const head = T.typedLine(title, { color: "#8a1c1c" });
    head.objectModifier = cardFx.modifier;
    head.position.set(0, 0.078, 0.001);
    group.add(head);
  }
  const lineMesh = (L) => T.typedLine(L.label(), L.style);
  const cardItems = lines.map((L, i) => {
    const g = new THREE.Group();
    // items are parented to the card group; makeItem adds them to worldRoot, so they're re-added below
    const it = makeItem({
      id: `card-${i}`, group: g, fx: textEffects("ink"), w: L.w ?? 0.29, h: L.h ?? 0.026, layer: "card", order: i,
      mesh: lineMesh(L), light: pos.clone(), hitLift: 0.002, selfLit: L.selfLit,
      onSelect: () => {
        if (!L.act) return;
        L.act();
        if (!L.keep && card && it.group.parent) swapMesh(it, lineMesh(L));
      },
    });
    g.position.set(L.x ?? 0, L.y ?? 0.035 - i * 0.026, 0.001);
    group.add(g);
    it.enabled = !!L.act;
    it.revealTarget = 1;
    it.refresh = () => swapMesh(it, lineMesh(L));
    return it;
  });
  card = { kind, group, cardFx, items: cardItems, reveal: 0, near: !!near || fixed, from: from.clone(), to: pos.clone(), onClose };
  group.position.copy(card.from);
  focus = 0;
  return card;
}
function closeCard(immediate = false) {
  if (!card) return;
  const was = card;
  for (const it of card.items) { items.splice(items.indexOf(it), 1); }
  worldRoot.remove(card.group);
  card.group.traverse((o) => o.dispose?.());
  card = null;
  if (!game.active) drawerFrames.forEach((d) => (d.target = 0));
  was.onClose?.();
  if (!immediate) {
    state = game.active ? "play" : "main";
    if (!game.active) focus = items.filter((i) => i.layer === "main").findIndex((i) => i.id === "options");
  }
}

// ------------------------------------------------------------------ actions
const anim = { pulseAge: -1, pulseOrigin: new V3(), dissolve: 0, light: 1, push: 0, intro: 0, torch: 0, seat: 0, seatTarget: 0 };
// terminal brought up close (see zoomTerminal): off = how far the monitor moves, aim = where the camera looks
const zoom = { amt: 0, target: 0, off: new V3(), aim: new V3() };
function pulseFrom(p, color) { anim.pulseAge = 0; anim.pulseOrigin.copy(p); room.uniforms.pulseColor.value.copy(color); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function tween(ms, fn) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const x = clamp((performance.now() - t0) / ms, 0, 1);
      fn(x);
      if (x < 1) requestAnimationFrame(step); else resolve();
    };
    // rAF pauses during XR; drive with an interval as well
    const id = setInterval(() => { const x = clamp((performance.now() - t0) / ms, 0, 1); fn(x); if (x >= 1) { clearInterval(id); resolve(); } }, 16);
    step();
  });
}

async function doContinue() {
  state = "busy";
  pulseFrom(crt.light, new V3(0.3, 1, 0.5));
  for (let i = 0; i <= 14; i++) { swapMesh(crt, crtLines("loading", i / 14)); await wait(90 + Math.random() * 120); }
  await tween(900, (x) => { anim.push = ease(x); anim.light = 1 - 0.85 * ease(x); });
  ui.hint.textContent = "This is where the game would start.";
  await wait(1200);
  swapMesh(crt, crtLines("idle"));
  await tween(1100, (x) => { anim.push = 1 - ease(x); anim.light = 0.15 + 0.85 * ease(x); });
  setHint();
  state = "main";
}
async function doNewGame() {
  state = "busy";
  const it = items.find((i) => i.id === "new");
  drawerFrames[0].target = 0.12;
  pulseFrom(it.light, new V3(1, 0.4, 0.3));
  signRig.vel += 2.5;
  await wait(500);
  await tween(1800, (x) => { anim.dissolve = ease(x) * 0.75; });
  await wait(250);
  await tween(2200, (x) => { anim.dissolve = 0.75 * (1 - ease(x)); });
  drawerFrames[0].target = 0;
  state = "main";
}
async function doQuit() {
  state = "busy";
  const it = items.find((i) => i.id === "quit");
  pulseFrom(it.light, new V3(1, 0.8, 0.2));
  await wait(300);
  items.forEach((i) => (i.revealTarget = 0));
  await tween(2600, (x) => { anim.dissolve = ease(x); anim.light = 1 - 0.3 * x; });
  endWords.visible = true;
  endFx.uniforms.reveal.value = 0;
  await tween(1500, (x) => (endFx.uniforms.reveal.value = ease(x)));
  state = "ended";
  ui.hint.textContent = renderer.xr.isPresenting ? "Pull the trigger to return" : NO_HOVER ? "Tap to return" : "Click or press Enter to return";
}
async function unQuit() {
  if (game.won) return leaveGame();
  state = "busy";
  await tween(800, (x) => (endFx.uniforms.reveal.value = 1 - x));
  endWords.visible = false;
  await tween(2600, (x) => { anim.dissolve = 1 - ease(x); anim.light = 0.7 + 0.3 * x; });
  items.forEach((i) => (i.revealTarget = i.layer === "main" ? 1 : 0));
  setHint();
  state = "main";
}
const endFx = textEffects("neon");
const endWords = T.glowWords("THANKS FOR STOPPING BY", { widthM: 1.4, heightM: 0.2 });
endWords.objectModifier = endFx.modifier;
endWords.position.copy(CAM.pos).addScaledVector(CAM.fwd.clone().setY(0).normalize(), 2.2).add(new V3(0, -0.05, 0));
endWords.lookAt(CAM.pos.x, endWords.position.y, CAM.pos.z);
endWords.visible = false;
worldRoot.add(endWords);

// controls hint that floats just above the desk edge, VR only (HTML overlays don't show in a headset)
const xrHint = T.glowWords("POINT + TRIGGER TO SELECT   ·   STICK TO BROWSE   ·   GRIP TO RECENTER",
  { widthM: 0.62, heightM: 0.03, mpp: 0.0008, color: "#e6d3ad", font: T.FONTS.tape });
xrHint.position.copy(CAM.pos).addScaledVector(CAM.fwd.clone().setY(0).normalize(), 0.62).add(new V3(0, -0.42, 0));
xrHint.lookAt(CAM.pos);
xrHint.visible = false;
worldRoot.add(xrHint);

function select(it) {
  if (!it || !it.enabled) return;
  if (state === "ended") return unQuit();
  if (state !== "main" && state !== "card" && state !== "play") return;
  it.press = 1;
  it.onSelect?.();
}
function back() {
  if (state === "card") closeCard();
  else if (state === "ended") unQuit();
  else if (state === "play") { if (anim.seatTarget) standUp(); else leaveGame(); }
}

// ------------------------------------------------------------------ escape game: "clock out"
// The tube light dies after closing. The terminal wants the last day worked (calendar on the wall)
// and the supervisor's PIN (scrawled on the timing-belt poster, only visible under the torch).
// That releases the locked drawer with R.P.'s timecard, and wakes the monitor on the back shelf.
// R.P.'s slot number is on his last work order (the clipboards lift out of the photo): "sit in
// my chair and read the dust". From his chair, floating motes line up into the slot number.
// File the card in that slot on the rack to clock out.
const CODES = ["1120", "7391"];
const SLOT = 4;
const BEST_KEY = "patterson.clockout.best";
const readBest = () => { try { return +localStorage.getItem(BEST_KEY) || 0; } catch { return 0; } };
const saveBest = (ms) => { try { localStorage.setItem(BEST_KEY, String(Math.round(ms))); } catch { /* storage blocked */ } };
const fmtTime = (ms) => { const s = Math.round(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const DARK = 0.16;
// R.P.'s chair: a little left of and lower than the photo's viewpoint
const SEAT = CAM.right.clone().multiplyScalar(-0.2).addScaledVector(CAM.up, -0.12);
let ink = null, winWords = null, monitor = null, cardProp = null, lockTape = null, digit = null;
const clips = [];
const winFx = textEffects("neon");

/** Image rect → centre and size (m) on a fitted plane. */
function rectOn(frame, u0, v0, u1, v1) {
  const pts = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].map(([u, v]) => rayPlane(u, v, frame));
  const c = rayPlane((u0 + u1) / 2, (v0 + v1) / 2, frame);
  let w = 0, h = 0;
  for (const p of pts) { const d = new V3().subVectors(p, c); w = Math.max(w, Math.abs(d.dot(frame.right))); h = Math.max(h, Math.abs(d.dot(frame.up))); }
  return { center: c, w: w * 2, h: h * 2 };
}
/** A frame at a room point that faces the photo's viewpoint (for things with no flat face, like the chair). */
function facingFrame(c) {
  const normal = new V3().subVectors(CAM.pos, c).normalize();
  const right = CAM.right.clone().addScaledVector(normal, -CAM.right.dot(normal)).normalize();
  return { center: c.clone(), normal, right, up: new V3().crossVectors(normal, right) };
}
const pxSize = (px, z) => (px / F) * z;

// work orders on the hanging clipboards; quad = the board's outline in the photo (px)
const WORK_ORDERS = [
  { id: "g-clip-a", quad: [[800, 1340], [985, 1268], [1003, 1372], [795, 1452]], no: "0412", lines: [
    "BAY 1 ...... BRAKE PADS + ROTORS", "'98 CIVIC   CUST: GARZA", "TECH: J. LOPEZ", "STATUS: DONE - PAID CASH"] },
  { id: "g-clip-d", quad: [[630, 1720], [848, 1592], [905, 1690], [640, 1785]], no: "0417", rp: true, lines: [
    "BAY 2 ...... TIMING BELT", "'04 ODYSSEY   CUST: KIM", "TECH: R. PATTERSON", { text: "MY LAST JOB. MY CARD GOES", note: true },
    { text: "IN MY SLOT. SIT IN MY CHAIR", note: true }, { text: "AND READ THE DUST.  - R.P.", note: true }] },
  { id: "g-clip-e", quad: [[790, 1780], [960, 1665], [985, 1750], [830, 1862]], no: "0416", lines: [
    "BAY 5 ...... A/C RECHARGE", "'11 F-150   CUST: OKAFOR", "TECH: D. NGUYEN", "STATUS: WAITING ON PARTS"] },
];
const MONITOR = {
  wake: { gist: "DRAWER 3", log: ["21:47  POWER FAULT, BAY 2", "21:48  DRAWER 3 RELEASED", "R.P. LEFT YOUR TIME CARD", "IN THE DRAWER."] },
  card: { gist: "FILE CARD", log: ["TIME CARDS GO IN THE RACK", "ON THE FRONT OF THE DESK.", "R.P.'S SLOT NUMBER IS ON", "HIS LAST WORK ORDER."] },
  rp: { gist: "SIT DOWN", log: ["R.P. ALWAYS SAID:", "\"SIT IN MY CHAIR", "AND READ THE DUST.\"", "(HIS CHAIR IS ON THE LEFT)"] },
  dust: { gist: "SLOT ?", log: ["YOU SAW IT.", "FILE THE CARD IN THAT", "SLOT ON THE RACK."] },
};
const monitorMode = () => (!game.hasCard ? "wake" : !game.readRP ? "card" : !game.sawDigit ? "rp" : "dust");
const monitorScreen = (gist) => T.crtScreen([
  { text: "BAY CAM 2", size: 0.16, y: 0.16 },
  { text: gist ?? MONITOR[monitorMode()].gist, size: 0.36, y: 0.55 },
  { text: "_", size: 0.2, y: 0.85 },
], { widthM: monitor.w, heightM: monitor.h, mpp: 0.0009, color: [170, 210, 255] });

function buildGame() {
  // wall calendar (November 2026), half hidden behind the CRT; fit the plane on the car picture above it
  const calWall = planeFrame(520, 775, 612, 860);
  const cal = rectOn(calWall, 556, 862, 618, 946);
  const cg = new THREE.Group();
  placeOn(cg, calWall, cal.center, 0.008);
  makeItem({
    id: "g-calendar", layer: "play", group: cg, fx: textEffects("plain"), w: cal.w + 0.03, h: cal.h + 0.03, order: 1,
    mesh: T.bracket(cal.w, cal.h, "CALENDAR"), light: cal.center.clone(), torchAt: cal.center.clone(), hoverReveal: true, selfLit: true,
    onSelect: () => openCalendar(cal.center),
  });

  // timing-belt poster on the front of the desk (always in view), and the hidden marker ink across its diagram
  const belt = planeFrame(100, 1460, 560, 1900);
  const beltR = rectOn(belt, 90, 1510, 530, 1850);   // the poster is tilted, so keep this inside its face
  const bg = new THREE.Group();
  placeOn(bg, belt, beltR.center, 0.008);
  makeItem({
    id: "g-belt", layer: "play", group: bg, fx: textEffects("plain"), w: beltR.w + 0.03, h: beltR.h + 0.03, order: 2,
    mesh: T.bracket(beltR.w, beltR.h, "TIMING BELT"), light: beltR.center.clone(), hoverReveal: true, selfLit: true,
    onSelect: () => pulseFrom(beltR.center, new V3(1, 0.85, 0.6)),
  });
  const inkR = rectOn(belt, 60, 1585, 400, 1810);
  items.find((i) => i.id === "g-belt").torchAt = inkR.center.clone();
  const inkGroup = new THREE.Group();
  placeOn(inkGroup, belt, inkR.center, 0.006);
  const inkFx = inkEffects();
  const inkMesh = T.inkScrawl([
    { text: "SUPV PIN", size: 0.13, x: 0.46, y: 0.22, rot: -0.1 },
    { text: "7 3 9 1", size: 0.3, x: 0.5, y: 0.55, rot: -0.07, underline: 0.62 },
    { text: "- R.P.", size: 0.09, x: 0.78, y: 0.86, rot: -0.04 },
  ], { widthM: inkR.w, heightM: inkR.h });
  inkMesh.objectModifier = inkFx.modifier;
  inkGroup.add(inkMesh);
  worldRoot.add(inkGroup);
  inkGroup.updateMatrix();
  ink = { group: inkGroup, mesh: inkMesh, fx: inkFx, inv: inkGroup.matrix.clone().invert(), reveal: 0, rect: inkR };

  // the locked bottom drawer (where OPTIONS is in the menu)
  const dg = new THREE.Group();
  placeOn(dg, cabFrame, labelSpots[2], 0.012);
  lockTape = makeItem({
    id: "g-drawer", layer: "play", group: dg, fx: textEffects("plain"), w: 0.26, h: 0.05, order: 3,
    mesh: T.dymoTape("LOCKED", { tape: "#6b1612", seed: 41, heightM: 0.048 }),
    light: drawerFrames[2].center.clone().addScaledVector(cabFrame.normal, 0.05),
    onSelect: () => rattleDrawer(),
  });

  // R.P.'s timecard, standing up in the drawer once it's released
  const dr = drawerFrames[2];
  const cardAt = dr.center.clone().addScaledVector(dr.frame.normal, 0.13).addScaledVector(dr.frame.up, dr.half.y + 0.03).addScaledVector(dr.frame.right, -dr.half.x * 0.35);
  const tg = new THREE.Group();
  placeOn(tg, facingFrame(cardAt), cardAt, 0);
  tg.rotateZ(0.12);
  cardProp = makeItem({
    id: "g-timecard", layer: "play", group: tg, fx: textEffects("plain"), w: 0.1, h: 0.14, order: 5,
    mesh: T.timeCard(), light: cardAt.clone(), torchAt: cardAt.clone(), hidden: true, enabled: false,
    onSelect: () => takeCard(),
  });

  // the flat monitor on the back shelf: dead until the PIN goes in, then it guides you
  const scr = planeFrame(968, 690, 1056, 786);
  const mr = rectOn(scr, 966, 688, 1058, 788);
  const mg = new THREE.Group();
  placeOn(mg, scr, mr.center, 0.01);
  const size = { w: mr.w * 0.92, h: mr.h * 0.9 };
  monitor = Object.assign(makeItem({
    id: "g-monitor", layer: "play", group: mg, fx: textEffects("crt"), w: mr.w, h: mr.h, order: 4, color: new V3(0.6, 0.8, 1),
    mesh: T.crtScreen([{ text: "", size: 0.1, y: 0.5 }], { widthM: 0.05, heightM: 0.05 }), light: mr.center.clone(), torchAt: mr.center.clone(),
    selfLit: true, hidden: true, enabled: false, onSelect: () => openMonitor(),
  }), size);

  // hanging clipboards: each board is cut out of the photo by its outline and floats toward you
  WORK_ORDERS.forEach((W, k) => {
    const [a, b, c, d] = W.quad;
    const L = room.uniforms.lifts[k];
    L.ab.value.set(a[0], a[1], b[0], b[1]);
    L.cd.value.set(c[0], c[1], d[0], d[1]);
    const zs = [], pts = [];
    for (let s = 0.1; s < 0.95; s += 0.2) for (let r = 0.1; r < 0.95; r += 0.2) {
      const top = [lerp(a[0], b[0], s), lerp(a[1], b[1], s)], bot = [lerp(d[0], c[0], s), lerp(d[1], c[1], s)];
      const u = lerp(top[0], bot[0], r), v = lerp(top[1], bot[1], r);
      zs.push(depthAt(u, v)); pts.push(surface(u, v));
    }
    zs.sort((x, y) => x - y);
    L.z.value.set(zs[Math.floor(zs.length * 0.1)] - 0.06, zs[Math.floor(zs.length * 0.9)] + 0.05);
    const center = pts.reduce((acc, p) => acc.add(p), new V3()).divideScalar(pts.length);
    const us = W.quad.map((q) => q[0]), vs = W.quad.map((q) => q[1]);
    const z = project(center).z;
    const w = pxSize(Math.max(...us) - Math.min(...us), z), h = pxSize(Math.max(...vs) - Math.min(...vs), z);
    const g = new THREE.Group();
    placeOn(g, facingFrame(center), center, 0.02);
    const it = makeItem({
      id: W.id, layer: "play", group: g, fx: textEffects("plain"), w, h, order: 6 + k,
      mesh: T.bracket(w * 0.9, h * 0.8, "CLIPBOARD"), light: center.clone(), torchAt: center.clone(), hoverReveal: true, selfLit: true,
      onSelect: () => openWorkOrder(clips[k]),
    });
    clips.push({ ...W, item: it, center, lift: L, dir: new V3().subVectors(CAM.pos, center).normalize(), amt: 0, open: false });
  });

  // R.P.'s chair, at the left edge of the photo
  const chairAt = surface(75, 1235);
  const chairZ = project(chairAt).z;
  const chg = new THREE.Group();
  placeOn(chg, facingFrame(chairAt), chairAt, 0.02);
  makeItem({
    id: "g-chair", layer: "play", group: chg, fx: textEffects("plain"), w: pxSize(110, chairZ) + 0.03, h: pxSize(150, chairZ) + 0.03, order: 9,
    mesh: T.bracket(pxSize(100, chairZ), pxSize(140, chairZ), "CHAIR"), light: chairAt.clone(), torchAt: chairAt.clone(), hoverReveal: true, selfLit: true,
    onSelect: () => (anim.seatTarget ? standUp() : sitDown()),
  });

  // timecard rack slots (front of the desk), labelled 1-5 with embosser tape
  const rack = planeFrame(655, 1330, 785, 1600);
  [1345, 1393, 1441, 1489, 1537].forEach((v, k) => {
    const g = new THREE.Group();
    const at = rayPlane(712, v, rack);
    placeOn(g, rack, at, 0.006);
    makeItem({
      id: `g-slot-${k + 1}`, layer: "play", group: g, fx: textEffects("plain"), w: 0.07, h: 0.034, order: 10 + k,
      mesh: T.dymoTape(String(k + 1), { tape: "#1d1d1f", widthM: 0.034, heightM: 0.019, mpp: 0.00035, seed: 70 + k }),
      light: at.clone(), torchAt: at.clone(), selfLit: true, onSelect: () => trySlot(k + 1, at),
    });
  });

  // the slot number, made of floating motes that only line up from R.P.'s chair
  const E = CAM.pos.clone().add(SEAT);
  const P = surface(1100, 1330);
  const fwd = new V3().subVectors(P, E);
  const dist = fwd.length();
  fwd.normalize();
  const right = CAM.right.clone().addScaledVector(fwd, -CAM.right.dot(fwd)).normalize();
  const up = new V3().crossVectors(right, fwd);
  const glyph = T.glyphSamples(String(SLOT), { step: 2 });
  const fx = moteEffects();
  const mesh = new SplatMesh({
    constructSplats: (splats) => {
      let seed = 17;
      const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const c = new V3(), s = new V3(), q = new THREE.Quaternion(), color = new THREE.Color();
      for (const [gx, gy] of glyph) {
        const dir = fwd.clone().addScaledVector(right, gx * 0.21).addScaledVector(up, gy * 0.21).normalize();
        // spread along the line of sight: near motes swing the most when you're not in the seat
        const along = dist * (0.16 + 0.74 * r() * r());
        c.copy(E).addScaledVector(dir, along);
        s.setScalar(along * (0.0015 + r() * 0.0005));
        color.setRGB(1.0, 0.84 + r() * 0.08, 0.58 + r() * 0.1);
        splats.pushSplat(c, s, q, 0.75 + r() * 0.25, color);
      }
    },
  });
  mesh.objectModifier = fx.modifier;
  worldRoot.add(mesh);
  digit = { mesh, fx, eye: E, target: P, reveal: 0, align: 0 };
}

const entryText = () => (game.entry + "____").slice(0, 4).split("").join(" ");
function gameScreen(mode = "prompt") {
  const head = { text: "C:\\PATTERSON> CLOCKOUT", size: 0.1, y: 0.13 };
  if (mode === "denied") return T.crtScreen([head, { text: "ACCESS DENIED", size: 0.2, y: 0.45 }, { text: "TRY AGAIN", size: 0.13, y: 0.72 }]);
  if (mode === "ok") return T.crtScreen([head, { text: "CODE ACCEPTED", size: 0.19, y: 0.47 }, { text: "...", size: 0.13, y: 0.72 }]);
  if (mode === "locked") return T.crtScreen([head, { text: "DRAWER 3: LOCKED", size: 0.14, y: 0.42 }, { text: "RELEASE AT TERMINAL", size: 0.11, y: 0.66 }]);
  if (mode === "released") return T.crtScreen([head, { text: "PIN ACCEPTED", size: 0.15, y: 0.36 }, { text: "DRAWER 3 RELEASED", size: 0.12, y: 0.58 }, { text: "TAKE YOUR TIME CARD", size: 0.11, y: 0.8 }]);
  if (mode === "won") return T.crtScreen([head, { text: "CARD FILED", size: 0.15, y: 0.36 }, { text: "CLOCKED OUT", size: 0.15, y: 0.58 }, { text: "GOOD NIGHT.", size: 0.13, y: 0.8 }]);
  return game.step === 0
    ? T.crtScreen([head, { text: "POWER FAULT - BAY 2", size: 0.11, y: 0.32 }, { text: "LAST DAY WORKED?", size: 0.13, y: 0.53 }, { text: `MMDD  ${entryText()}`, size: 0.17, y: 0.78 }])
    : T.crtScreen([head, { text: "DATE OK  11/20", size: 0.11, y: 0.32 }, { text: "SUPERVISOR PIN?", size: 0.13, y: 0.5 }, { text: "SEE: TIMING BELT", size: 0.11, y: 0.66 }, { text: `PIN   ${entryText()}`, size: 0.15, y: 0.84 }]);
}
function refreshEntry() {
  swapMesh(crt, gameScreen());
  if (card?.kind === "keypad") card.items[0].refresh();
}
let hintTimer = 0;
function flashHint(text, ms = 1800) {
  ui.hint.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(setHint, ms);
}

/**
 * Float the terminal up to the viewer to be read: the monitor's own splats slide toward the eye along
 * their line of sight (so it looks exactly as photographed, only closer), and the keypad is laid out beside it.
 * Returns where the keypad card goes.
 */
function zoomTerminal() {
  anim.seatTarget = 0;
  const inXr = renderer.xr.isPresenting;
  const eye = inXr ? worldRoot.worldToLocal(new V3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld)) : CAM.pos.clone();
  const wide = inXr || innerWidth / innerHeight >= 1.15;
  const toCrt = new V3().subVectors(crt.basePos, eye);
  const dir = toCrt.clone().normalize();
  const right = CAM.right.clone().addScaledVector(dir, -CAM.right.dot(dir)).normalize();
  const up = new V3().crossVectors(right, dir);
  const near = wide ? 0.62 : 0.7;
  zoom.off.copy(dir).multiplyScalar(near - toCrt.length());
  const at = eye.clone().addScaledVector(dir, near);
  // wide screens: terminal left of centre, keypad on the right; upright screens: terminal above, keypad below
  zoom.aim.copy(at).addScaledVector(wide ? right : up, wide ? 0.17 : -0.13);
  zoom.target = 1;
  return wide ? eye.clone().addScaledVector(dir, 0.58).addScaledVector(right, 0.36).addScaledVector(up, -0.03)
    : eye.clone().addScaledVector(dir, 0.5).addScaledVector(up, -0.235);
}

function openKeypad() {
  if (game.busy) return;
  if (game.step >= CODES.length) { pulseFrom(crt.light, new V3(0.3, 1, 0.5)); return; }
  game.entry = "";
  const keypadAt = zoomTerminal();
  const key = (text, x, y, w, act) => ({ label: () => text, x, y, w, h: 0.03, keep: true, act, style: { widthM: w, heightM: 0.03, align: "center" } });
  const lines = [{ label: () => `${game.step ? "PIN " : "MMDD"}   ${entryText()}`, y: 0.045, selfLit: true, style: { heightM: 0.03, align: "center" } }];
  "1234567890".split("").forEach((d, k) => lines.push(key(d, -0.11 + (k % 5) * 0.055, 0.004 - Math.floor(k / 5) * 0.036, 0.045, () => keypadPress(d))));
  lines.push(key("CLEAR", -0.075, -0.074, 0.1, () => { if (!game.busy) { game.entry = ""; refreshEntry(); } }));
  lines.push(key("< BACK", 0.075, -0.074, 0.1, () => closeCard()));
  spawnCard({
    kind: "keypad", title: game.step ? "SUPERVISOR PIN" : "LAST DAY WORKED (MMDD)", lines, from: crt.light,
    anchor: keypadAt, fixed: true, onClose: () => { zoom.target = 0; },
  });
  focus = 1;
}
function keypadPress(d) {
  if (game.busy || game.entry.length >= 4 || game.step >= CODES.length) return;
  game.entry += d;
  refreshEntry();
  if (game.entry.length === 4) submitCode();
}
function keypadDelete() {
  if (game.busy || !game.entry) return;
  game.entry = game.entry.slice(0, -1);
  refreshEntry();
}
async function submitCode() {
  game.busy = true;
  await wait(250);
  if (game.entry !== CODES[game.step]) {
    pulseFrom(crt.light, new V3(1, 0.25, 0.2));
    swapMesh(crt, gameScreen("denied"));
    await wait(1000);
    game.entry = "";
    refreshEntry();
    game.busy = false;
    return;
  }
  pulseFrom(crt.light, new V3(0.3, 1, 0.5));
  game.step++;
  game.entry = "";
  if (game.step >= CODES.length) { closeCard(); game.busy = false; return releaseDrawer(); }
  swapMesh(crt, gameScreen("ok"));
  await wait(1100);
  if (card?.kind === "keypad") closeCard();
  refreshEntry();
  game.busy = false;
}

function openCalendar(at) {
  spawnCard({
    kind: "calendar", mesh: T.calendarPage(), from: at,
    anchor: CAM.pos.clone().lerp(at, 0.33).addScaledVector(CAM.right, 0.05).addScaledVector(CAM.up, 0.02),
    lines: [{ label: () => "< BACK", x: 0.1, y: -0.095, w: 0.09, h: 0.024, keep: true, style: { widthM: 0.09, align: "center" }, act: () => closeCard() }],
  });
}
async function rattleDrawer() {
  if (game.step >= CODES.length) return;
  const d = drawerFrames[2];
  swapMesh(crt, gameScreen("locked"));
  for (const o of [0.03, 0, 0.025, 0, 0.015, 0]) { d.target = o; await wait(110); }
  await wait(1200);
  if (game.active && game.step < CODES.length && !game.busy) swapMesh(crt, gameScreen());
}
const show = (it, on) => { it.hidden = !on; it.enabled = on; };

async function releaseDrawer() {
  swapMesh(crt, gameScreen("released"));
  show(lockTape, false);
  drawerFrames[2].target = 0.18;
  pulseFrom(drawerFrames[2].center, new V3(1, 0.85, 0.4));
  await wait(700);
  if (!game.active) return;
  show(cardProp, true);
  await wait(900);
  if (!game.active) return;
  // the shelf monitor stutters awake
  swapMesh(monitor, monitorScreen("NO SIGNAL"));
  show(monitor, true);
  pulseFrom(monitor.light, new V3(0.5, 0.7, 1));
  await wait(900);
  if (game.active) swapMesh(monitor, monitorScreen());
}
const refreshMonitor = () => { if (game.active && !monitor.hidden) swapMesh(monitor, monitorScreen()); };
function openMonitor() {
  const m = MONITOR[monitorMode()];
  const lines = m.log.map((text) => ({ label: () => text, act: null, selfLit: true, style: { color: "#1d2c5e" } }));
  lines.push({ label: () => "< BACK", act: () => closeCard(), keep: true });
  spawnCard({
    kind: "monitor", title: "BAY CAM 2  -  LOG", lines, from: monitor.light,
    anchor: CAM.pos.clone().lerp(monitor.light, 0.3).addScaledVector(CAM.up, -0.02),
  });
}
function takeCard() {
  game.hasCard = true;
  show(cardProp, false);
  pulseFrom(cardProp.light, new V3(1, 0.9, 0.6));
  const lines = [
    "NAME ........ R. PATTERSON", "WEEK ENDING .. 11/20/26", "MON-THU  ....  7:00 - 4:30", "FRI  ........  7:04 - __:__",
    { text: "FILE IN RACK  -  SLOT: ?", note: true },
  ].map((L) => ({ label: () => L.text ?? L, act: null, selfLit: true, style: L.note ? { color: "#8f1710" } : undefined }));
  lines.push({ label: () => "< KEEP IT", act: () => closeCard(), keep: true });
  spawnCard({
    kind: "timecard", title: "TIME CARD", lines, from: cardProp.light,
    anchor: CAM.pos.clone().lerp(cardProp.light, 0.5).addScaledVector(CAM.up, 0.12).addScaledVector(CAM.right, -0.1),
    onClose: () => { refreshMonitor(); setHint(); },
  });
}
function openWorkOrder(c) {
  c.open = true;
  const lines = c.lines.map((L, k) => ({
    label: () => L.text ?? L, act: null, selfLit: true, y: 0.045 - k * 0.023,
    style: L.note ? { color: "#8f1710", heightM: 0.022 } : { heightM: 0.022 },
  }));
  lines.push({ label: () => "< HANG IT BACK", act: () => closeCard(), keep: true, y: -0.088, x: 0.07, w: 0.15, style: { widthM: 0.15, heightM: 0.022 } });
  spawnCard({
    kind: "workorder", title: `WORK ORDER ${c.no}`, lines, from: c.center.clone().addScaledVector(c.dir, 0.09),
    anchor: CAM.pos.clone().lerp(c.center, 0.42).addScaledVector(CAM.up, 0.1),
    onClose: () => {
      c.open = false;
      if (c.rp && !game.readRP) { game.readRP = true; refreshMonitor(); }
    },
  });
}
function sitDown() { anim.seatTarget = 1; setHint(); }
function standUp() { anim.seatTarget = 0; setHint(); }
function trySlot(n, at) {
  if (!game.hasCard) { pulseFrom(at, new V3(0.7, 0.7, 0.7)); flashHint(`Slot ${n} is empty. Time cards go here.`); return; }
  if (n !== SLOT) {
    game.penalty += 15000;
    pulseFrom(at, new V3(1, 0.25, 0.2));
    flashHint("Wrong slot - that's not R.P.'s.  +15 s");
    return;
  }
  fileCard(at);
}
async function fileCard(at) {
  state = "busy";
  anim.seatTarget = 0;
  // the card leaves your hand and slides into the slot
  const g = new THREE.Group();
  const fx = textEffects("plain");
  const m = T.timeCard();
  m.objectModifier = fx.modifier;
  g.add(m);
  worldRoot.add(g);
  const rack = planeFrame(655, 1330, 785, 1600);
  const from = CAM.pos.clone().lerp(at, 0.35).addScaledVector(CAM.up, -0.05);
  const to = at.clone().addScaledVector(rack.normal, 0.02);
  const q0 = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(CAM.right, CAM.up, CAM.fwd.clone().negate()));
  const q1 = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(rack.right, rack.normal.clone().negate(), rack.up));
  fx.uniforms.reveal.value = 1;
  await tween(1000, (x) => {
    const e = ease(x);
    g.position.lerpVectors(from, to, e);
    g.quaternion.slerpQuaternions(q0, q1, e);
    fx.uniforms.time.value = t;
    fx.uniforms.reveal.value = 1 - Math.max(0, x - 0.75) / 0.25;
    m.updateVersion();
  });
  worldRoot.remove(g);
  m.dispose?.();
  pulseFrom(at, new V3(1, 0.85, 0.4));
  winGame();
}

async function startGame() {
  state = "busy";
  const it = items.find((i) => i.id === "new");
  drawerFrames[0].target = 0.12;
  pulseFrom(it.light, new V3(1, 0.4, 0.3));
  signRig.vel += 2.5;
  await wait(500);
  await tween(1800, (x) => { anim.dissolve = ease(x) * 0.75; });
  // swap the menu for the game while the room is in pieces
  items.forEach((i) => { if (i.layer === "main" && i !== crt) i.revealTarget = 0; });
  Object.assign(game, GAME_RESET, { active: true });
  show(lockTape, true); show(cardProp, false); show(monitor, false);
  crt.layer = "play";
  crt.onSelect = () => openKeypad();
  swapMesh(crt, gameScreen());
  await wait(250);
  await tween(2200, (x) => { anim.dissolve = 0.75 * (1 - ease(x)); });
  drawerFrames[0].target = 0;
  // the tube light dies
  for (const lvl of [0.4, 1, 0.25, 0.85, 0.12, 0.55]) { anim.light = lvl; await wait(70 + Math.random() * 130); }
  await tween(900, (x) => { anim.light = lerp(0.5, DARK, ease(x)); anim.torch = ease(x); });
  game.t0 = performance.now();
  state = "play";
  setHint();
}
async function winGame() {
  state = "busy";
  game.won = true;
  const ms = performance.now() - game.t0 + game.penalty;
  const best = readBest();
  if (!best || ms < best) saveBest(ms);
  swapMesh(crt, gameScreen("won"));
  show(monitor, false);
  await wait(900);
  await tween(1800, (x) => { anim.light = lerp(DARK, 1, ease(x)); anim.torch = 1 - ease(x); });
  winWords = T.glowWords(`CLOCKED OUT  -  ${fmtTime(ms)}`, { widthM: 1.3, heightM: 0.2 });
  winWords.objectModifier = winFx.modifier;
  winWords.position.copy(endWords.position);
  winWords.quaternion.copy(endWords.quaternion);
  worldRoot.add(winWords);
  winFx.uniforms.reveal.value = 0;
  await tween(1500, (x) => (winFx.uniforms.reveal.value = ease(x)));
  state = "ended";
  const record = !best || ms < best ? "New best time" : `Best ${fmtTime(best)}`;
  const extra = game.penalty ? ` (incl. +${game.penalty / 1000} s for wrong slots)` : "";
  ui.hint.textContent = `${record}${extra} · ${renderer.xr.isPresenting ? "Pull the trigger to return" : NO_HOVER ? "Tap to return" : "Click or press Enter to return"}`;
}
async function leaveGame() {
  state = "busy";
  closeCard(true);
  anim.seatTarget = 0;
  if (winWords) {
    await tween(700, (x) => (winFx.uniforms.reveal.value = 1 - x));
    worldRoot.remove(winWords);
    winWords.dispose?.();
    winWords = null;
  }
  Object.assign(game, GAME_RESET, { active: false });
  show(cardProp, false); show(monitor, false);
  crt.layer = "main";
  crt.onSelect = () => doContinue();
  swapMesh(crt, crtLines("idle"));
  drawerFrames.forEach((d) => (d.target = 0));
  const l0 = anim.light, t0 = anim.torch;
  await tween(900, (x) => { anim.light = lerp(l0, 1, ease(x)); anim.torch = t0 * (1 - ease(x)); });
  items.forEach((i) => { if (i.layer === "main") i.revealTarget = 1; });
  cursorRoom.target = 0;
  state = "main";
  setHint();
}

// ------------------------------------------------------------------ input: pointer / keys / gamepad
const raycaster = new THREE.Raycaster();
const pointer = { ndc: new THREE.Vector2(0, 0), active: false, moved: 0 };
const cursorRoom = { pos: new V3(), amt: 0, target: 0 };
let inputMode = "pointer";

function pickFromRay(origin, dir) {
  raycaster.set(origin, dir);
  const targets = pickables().map((i) => i.hit);
  if (signRig) targets.push(signRig.hit);
  const hit = raycaster.intersectObjects(targets, false)[0];
  // room cursor in worldRoot-local coordinates
  const inv = new THREE.Matrix4().copy(worldRoot.matrixWorld).invert();
  const o = origin.clone().applyMatrix4(inv);
  const d = dir.clone().transformDirection(inv);
  const rp = roomHit(o, d);
  if (rp) { cursorRoom.pos.copy(rp); cursorRoom.target = settings.pointerLight || game.active ? 1 : 0; } else cursorRoom.target = 0;
  if (!hit) return { item: null, point: rp, sign: false };
  if (hit.object.userData.sign) return { item: null, point: rp, sign: true };
  return { item: hit.object.userData.item, point: rp, sign: false, distance: hit.distance };
}

// Mouse: hover follows the cursor, click selects.
// Touch / pen: pressing highlights what's under the finger, a tap selects it, dragging looks around
// (and the finger works as the flashlight while it's down).
const touch = { id: null, x0: 0, y0: 0, x: 0, y: 0, dragged: false, lastUp: -1e9 };
const setNdc = (e) => pointer.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
const swingSign = () => { signRig.vel += 1.6; pulseFrom(signRig.pos, new V3(1, 0.85, 0.55)); };

addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") { setNdc(e); pointer.active = true; inputMode = "pointer"; return; }
  if (e.pointerId !== touch.id) return;
  const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
  touch.x = e.clientX; touch.y = e.clientY;
  if (!touch.dragged && Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) > 10) { touch.dragged = true; hovered = null; }
  if (touch.dragged) dragView(dx, dy);
  setNdc(e);
});
document.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse" && !e.relatedTarget) pointer.active = false; });   // left the window
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" || touch.id !== null) return;
  Object.assign(touch, { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dragged: false });
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  setNdc(e);
  pointer.active = true;
  inputMode = "touch";
});
function endTouch(e, tapped) {
  if (e.pointerId !== touch.id) return;
  touch.id = null;
  touch.lastUp = performance.now();
  pointer.active = false;
  // in the game the torch stays where the finger left it
  if (!tapped || touch.dragged) { if (!game.active) cursorRoom.target = 0; hovered = null; return; }
  setNdc(e);
  raycaster.setFromCamera(pointer.ndc, camera);
  const res = pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
  if (!game.active) cursorRoom.target = 0;
  if (state === "ended") return unQuit();
  if (res.item) { hovered = res.item; select(res.item); } else if (res.sign) swingSign();
  // let the glow linger a moment after the finger lifts
  const tappedItem = res.item;
  setTimeout(() => { if (touch.id === null && inputMode === "touch" && hovered === tappedItem) hovered = null; }, 900);
}
renderer.domElement.addEventListener("pointerup", (e) => endTouch(e, true));
renderer.domElement.addEventListener("pointercancel", (e) => endTouch(e, false));
renderer.domElement.addEventListener("click", () => {
  if (performance.now() - touch.lastUp < 800) return;   // already handled as a tap
  if (state === "ended") return unQuit();
  if (hovered) select(hovered);
  else if (signHover) swingSign();
});
function navigate(dir) {
  const list = pickables().sort((a, b) => a.order - b.order);
  if (!list.length) return;
  inputMode = "keys";
  const cur = list.indexOf(hovered);
  focus = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
  hovered = list[focus];
  if (!renderer.xr.isPresenting && !card?.near) lookToward(hovered.light ?? hovered.group.getWorldPosition(new V3()));
}
addEventListener("keydown", (e) => {
  // digits type straight into the terminal during the game
  if (/^[0-9]$/.test(e.key) && game.active && game.step < CODES.length && (state === "play" || card?.kind === "keypad")) {
    if (!card) openKeypad();
    keypadPress(e.key);
    return;
  }
  if (e.key === "Backspace" && card?.kind === "keypad") { keypadDelete(); e.preventDefault(); return; }
  if (["ArrowUp", "w", "W"].includes(e.key)) { navigate(-1); e.preventDefault(); }
  else if (["ArrowDown", "s", "S", "Tab"].includes(e.key)) { navigate(e.shiftKey && e.key === "Tab" ? -1 : 1); e.preventDefault(); }
  else if (["Enter", " "].includes(e.key)) { if (state === "ended") unQuit(); else select(hovered); e.preventDefault(); }
  else if (["Escape", "Backspace"].includes(e.key)) back();
});
const padPrev = {};
function pollGamepads() {
  if (renderer.xr.isPresenting) return;
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp) continue;
    const prev = padPrev[gp.index] ?? {};
    const now = {
      up: gp.buttons[12]?.pressed || gp.axes[1] < -0.6, down: gp.buttons[13]?.pressed || gp.axes[1] > 0.6,
      a: gp.buttons[0]?.pressed, b: gp.buttons[1]?.pressed,
    };
    if (now.up && !prev.up) navigate(-1);
    if (now.down && !prev.down) navigate(1);
    if (now.a && !prev.a) { if (state === "ended") unQuit(); else select(hovered); }
    if (now.b && !prev.b) back();
    padPrev[gp.index] = now;
  }
}

// ------------------------------------------------------------------ XR
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const geo = new THREE.BufferGeometry().setFromPoints([new V3(0, 0, 0), new V3(0, 0, -1)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.55 }));
  line.scale.z = 3;
  c.add(line);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe2b0 }));
  dot.visible = false;
  scene.add(dot);
  const ctl = { obj: c, line, dot, hovered: null, sign: false, stickLatch: 0 };
  c.addEventListener("select", () => {
    if (state === "ended") return unQuit();
    if (ctl.hovered) select(ctl.hovered);
    else if (ctl.sign) { signRig.vel += 1.6; pulseFrom(signRig.pos, new V3(1, 0.85, 0.55)); }
  });
  c.addEventListener("squeeze", () => (state === "card" || state === "ended" ? back() : recenter()));
  c.addEventListener("connected", (e) => { c.userData.source = e.data; line.visible = e.data.targetRayMode !== "screen"; });
  scene.add(c);
  return ctl;
});
let needRecenter = 0, xrBase = null;
function recenter() { needRecenter = 2; }
function applyRecenter() {
  // put the photo's camera exactly where the viewer's head is, facing the same way (yaw only)
  const xrCam = renderer.xr.getCamera();
  const head = new V3().setFromMatrixPosition(xrCam.matrixWorld);
  const fwd = new V3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(xrCam.matrixWorld));
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  const photoFwd = CAM.fwd.clone().setY(0).normalize();
  const photoYaw = Math.atan2(-photoFwd.x, -photoFwd.z);
  worldRoot.rotation.set(0, yaw - photoYaw, 0);
  const rotated = CAM.pos.clone().applyQuaternion(worldRoot.quaternion);
  worldRoot.position.copy(head).sub(rotated);
  xrBase = worldRoot.position.clone();
  worldRoot.updateMatrixWorld(true);
}
const xr = new SparkXr({
  renderer, element: ui.vr, mode: "vr", referenceSpaceType: "local-floor", enableHands: true,
  frameBufferScaleFactor: IS_QUEST ? 0.9 : 1, fixedFoveation: 0.6,
  onReady: (ok) => {
    ui.vr.textContent = ok ? "ENTER VR" : "VR UNAVAILABLE";
    ui.vr.classList.toggle("off", !ok);
    ui.vr.style.display = ok || !NO_HOVER ? "" : "none";   // phones without VR don't need the button
  },
  onEnterXr: () => { ui.vr.textContent = "EXIT VR"; needRecenter = 12; spark.apertureAngle = 0; xrHint.visible = true; setHint(); },
  onExitXr: () => { ui.vr.textContent = "ENTER VR"; xrBase = null; worldRoot.position.set(0, 0, 0); worldRoot.rotation.set(0, 0, 0); xrHint.visible = false; setHint(); },
});

function updateXrInput() {
  const session = renderer.xr.getSession();
  let anyHover = null;
  for (const ctl of controllers) {
    const c = ctl.obj;
    if (!c.userData.source || !c.visible) { ctl.dot.visible = false; continue; }
    const origin = new V3().setFromMatrixPosition(c.matrixWorld);
    const dir = new V3(0, 0, -1).transformDirection(c.matrixWorld);
    const res = pickFromRay(origin, dir);
    ctl.hovered = res.item;
    ctl.sign = res.sign;
    let dist = 3;
    if (res.item) dist = res.distance;
    else if (res.point) dist = res.point.clone().applyMatrix4(worldRoot.matrixWorld).distanceTo(origin);
    ctl.line.scale.z = dist;
    ctl.dot.visible = !!(res.item || res.point);
    ctl.dot.position.copy(origin).addScaledVector(dir, dist);
    if (res.item) anyHover = res.item;
    if (ctl.sign) signHover = true;
    // thumbstick: up/down walks the menu like a d-pad
    const gp = c.userData.source.gamepad;
    if (gp && gp.axes.length >= 4) {
      const y = gp.axes[3];
      if (Math.abs(y) > 0.7 && !ctl.stickLatch) { navigate(y > 0 ? 1 : -1); ctl.stickLatch = 1; }
      if (Math.abs(y) < 0.3) ctl.stickLatch = 0;
      if (gp.buttons[5]?.pressed && !ctl.bLatch) { back(); }
      ctl.bLatch = gp.buttons[5]?.pressed;
    }
  }
  if (anyHover) { hovered = anyHover; inputMode = "pointer"; }
  else if (inputMode === "pointer") hovered = null;
  if (session && needRecenter > 0 && --needRecenter === 0) applyRecenter();
}

// ------------------------------------------------------------------ screen camera (desktop, tablet, phone)
// The photo is portrait (1536×2048 px). Wide screens see every menu item at once. Upright phones fill
// their height with the photo and pan sideways (finger drag, or the mouse in a narrow window).
// Panning only turns the camera, so the room stays as sharp as the photo.
// view.u / view.v: [centre, swing either way] of the view centre, in photo px.
const view = { hHalf: 720, vHalf: 730, u: [PW / 2, 50], v: [1150, 33], home: new THREE.Vector2(), target: new THREE.Vector2() };
const desk = { look: new THREE.Vector2(), lean: new V3() };   // look = current pan, -1..1 on each axis
const MENU_CENTER_U = 930;   // between the CRT and the drawer labels
function fitFov() {
  const aspect = innerWidth / innerHeight;
  let vHalf = 730;
  // upright screens: widen until the CRT and the drawer labels both fit, letting the (faded) photo edges show a little
  if (vHalf * aspect < 720) vHalf = Math.min(720 / aspect, Math.max(1024, 550 / aspect));
  const hHalf = vHalf * aspect;
  const uLo = Math.min(hHalf, PW / 2 - 50), uHi = Math.max(PW - hHalf, PW / 2 + 50);
  Object.assign(view, { hHalf, vHalf, u: [(uLo + uHi) / 2, (uHi - uLo) / 2], v: [vHalf >= PH / 2 ? PH / 2 : clamp(1150, vHalf, PH - vHalf), 33] });
  // narrow screens start on the middle of the menu; wide ones on the middle of the photo
  view.home.set(view.u[1] > 60 ? clamp((MENU_CENTER_U - view.u[0]) / view.u[1], -1, 1) : 0, 0);
  view.target.copy(view.home);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(vHalf / F));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}
fitFov();
desk.look.copy(view.home);
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); fitFov(); setHint(); });
/** Finger drag in CSS px → pan; the room follows the finger. */
function dragView(dx, dy) {
  if (card?.near) return;   // the card is held in front of you; keep it there
  view.target.x = clamp(view.target.x - (dx * 2 * view.hHalf) / innerWidth / view.u[1], -1, 1);
  view.target.y = clamp(view.target.y + (dy * 2 * view.vHalf) / innerHeight / view.v[1], -1, 1);
}
/** Pan (on narrow screens) so a room point comes into view. */
function lookToward(p) {
  if (view.u[1] <= 60) return;
  view.target.x = clamp((project(p).u - view.u[0]) / view.u[1], -1, 1);
}
/** Closer card distance for small screens (lines ≥ ~30 px apart, card fits on screen), or 0 to keep the default. */
function cardDistance(defaultDist) {
  if (!NO_HOVER && Math.min(innerWidth, innerHeight) >= 600) return 0;   // desktop keeps the card beside the drawer
  const linePx = 30, line = 0.026, cardW = 0.30, cardH = 0.20;
  const d = Math.max((line * F * innerHeight) / (2 * view.vHalf * linePx), (cardW * F) / (2 * 0.92 * view.hHalf), (cardH * F) / (2 * 0.85 * view.vHalf));
  return d < defaultDist * 0.9 ? d : 0;
}

function updateDesktopCamera(dt) {
  if (inputMode === "pointer" && !card?.near) view.target.copy(pointer.active ? pointer.ndc : view.home);
  const rate = touch.dragged && touch.id !== null ? 14 : 3;
  desk.look.x = damp(desk.look.x, view.target.x, rate, dt);
  desk.look.y = damp(desk.look.y, view.target.y, rate, dt);
  const leanTarget = new V3();
  if (hovered && state !== "busy") {
    const toItem = new V3().subVectors(hovered.light ?? hovered.group.getWorldPosition(new V3()), CAM.pos);
    leanTarget.copy(toItem).multiplyScalar(0.05).clampLength(0, 0.1);
  }
  if (anim.push > 0) leanTarget.lerp(new V3().subVectors(crt.light, CAM.pos).multiplyScalar(0.55), anim.push);
  desk.lean.x = damp(desk.lean.x, leanTarget.x, 2.5, dt);
  desk.lean.y = damp(desk.lean.y, leanTarget.y, 2.5, dt);
  desk.lean.z = damp(desk.lean.z, leanTarget.z, 2.5, dt);
  const se = ease(clamp(anim.seat, 0, 1)), ze = ease(clamp(zoom.amt, 0, 1)), free = (1 - se) * (1 - ze);
  camera.position.copy(CAM.pos)
    .addScaledVector(CAM.right, desk.look.x * 0.07 * free)
    .addScaledVector(CAM.up, desk.look.y * 0.045 * free)
    .addScaledVector(desk.lean, free)
    .addScaledVector(SEAT, se);
  const aim = unproject(view.u[0] + desk.look.x * view.u[1], view.v[0] - desk.look.y * view.v[1], 3.0);
  if (anim.push > 0) aim.lerp(crt.light, anim.push * 0.6);
  if (se > 0 && digit) aim.lerp(digit.target, se * 0.35);
  if (ze > 0) aim.lerp(zoom.aim, ze);
  camera.up.copy(CAM.up);
  camera.lookAt(aim);
  // depth of field focuses on the hovered object, or the open card
  const focusDist = hovered && !card ? camera.position.distanceTo(hovered.light ?? hovered.group.position)
    : card ? camera.position.distanceTo(card.group.position) : 2.4;
  spark.focalDistance = damp(spark.focalDistance || 2.4, focusDist, 4, dt);
  spark.apertureAngle = settings.dof && se < 0.3 ? 0.0012 : 0;
}

// ------------------------------------------------------------------ hints
function setHint() {
  if (game.active && !game.won && anim.seatTarget) {
    ui.hint.textContent = `Sitting in R.P.'s chair · ${renderer.xr.isPresenting ? "lean around · B" : NO_HOVER ? "tap the chair" : "click the chair or press Esc"} to stand up`;
    return;
  }
  if (game.active && !game.won && game.hasCard) {
    ui.hint.textContent = renderer.xr.isPresenting ? "You have R.P.'s time card · file it in the right rack slot · B to leave"
      : "You have R.P.'s time card · file it in the right slot on the rack · Esc leaves";
    return;
  }
  if (game.active && !game.won) {
    ui.hint.textContent = renderer.xr.isPresenting ? "The power's out · point to shine the torch · trigger to use · B to leave"
      : NO_HOVER ? "The power's out · drag to shine the torch · tap things to use them"
        : "The power's out · the mouse is your torch · click things · type digits at the terminal · Esc leaves";
    return;
  }
  ui.hint.textContent = renderer.xr.isPresenting
    ? "Point and pull the trigger · thumbstick to browse · grip to recenter"
    : IS_QUEST ? "Press ENTER VR, then point and pull the trigger"
      : NO_HOVER ? (view.u[1] > 60 ? "Tap to select · Drag to look around" : "Tap the screen, drawers, floor or sign")
        : "Mouse or ↑ ↓ to browse · Click / Enter to select · Esc to go back · Gamepad works too";
}

// ------------------------------------------------------------------ phone frame rate guard
// Phones start at up to 1.5× resolution and step down (to 0.75×) while the frame rate stays under ~28 fps.
const perf = { t0: 0, last: 0, frames: 0 };
function adaptResolution() {
  if (!IS_PHONE || renderer.xr.isPresenting || state === "intro") return;
  const now = performance.now();
  if (now - perf.last > 250) { perf.t0 = now; perf.frames = 0; }   // tab was hidden or stalled: start a fresh window
  perf.last = now;
  perf.frames++;
  if (now - perf.t0 < 2500) return;
  const fps = (perf.frames * 1000) / (now - perf.t0);
  perf.t0 = now; perf.frames = 0;
  if (fps < 28 && pixelRatio > 0.75) {
    pixelRatio = Math.max(0.75, pixelRatio - 0.25);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(innerWidth, innerHeight);
  }
}

// ------------------------------------------------------------------ flicker
const flick = { next: 4 + Math.random() * 5, t: -1, seq: [] };
function flickerLevel(dt) {
  if (!settings.flicker) return 1;
  flick.next -= dt;
  if (flick.next <= 0 && flick.t < 0) { flick.t = 0; flick.seq = Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () => [Math.random() * 0.06 + 0.02, 0.45 + Math.random() * 0.35]); }
  if (flick.t >= 0) {
    flick.t += dt;
    let acc = 0;
    for (const [len, lvl] of flick.seq) {
      if (flick.t < acc + len) return lvl;
      acc += len;
      if (flick.t < acc + len * 0.8) return 1;
      acc += len * 0.8;
    }
    flick.t = -1;
    flick.next = 6 + Math.random() * 10;
  }
  return 1;
}

// ------------------------------------------------------------------ terminal rim motes
// While the terminal floats up to be read, copies of the gaussians along its outline come alive:
// streaming round the rim, coiling round the bezel and peeling off as embers (rimEffects).
const CRT_OUTLINE = [[356, 927], [400, 869], [567, 865], [592, 996], [380, 1046], [372, 1046]];   // outer outline of CRT_QUADS
const CRT_DEPTH = [2.15, 2.95];
const rim = { fx: null, mesh: null, amt: 0, clock: 0 };
function buildRim() {
  const outline = outlineSegments(CRT_OUTLINE);
  const edge = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const inQuad = (p, q) => {
    const e = [0, 1, 2, 3].map((k) => edge(q[k], q[(k + 1) % 4], p));
    return e.every((x) => x >= 0) || e.every((x) => x <= 0);
  };
  const BAND = 15;   // px inside the outline
  const BINS = 96;   // depth profile round the outline
  const bins = Array.from({ length: BINS }, () => []);
  const picked = [];
  const d = new V3();
  roomMesh.packedSplats.forEachSplat((i, c, s, q, o, color) => {
    if (o < 0.05) return;
    d.subVectors(c, CAM.pos);
    const z = d.dot(CAM.fwd);
    if (z < CRT_DEPTH[0] || z > CRT_DEPTH[1]) return;
    const p = [(F * d.dot(CAM.right)) / z + PW / 2, (F * d.dot(CAM.down)) / z + PH / 2];
    if (p[0] < 340 || p[0] > 610 || p[1] < 850 || p[1] > 1060) return;
    if (!CRT_QUADS.some((qd) => inQuad(p, qd))) return;
    const near = outlineNearest(outline, p);
    if (near.d > BAND) return;
    if (near.d < 8 && o > 0.4) bins[Math.floor((near.s / outline.per) * BINS) % BINS].push(z);
    picked.push({ c: c.clone(), s: s.clone(), q: q.clone(), o, color: color.clone() });
  });
  // near-surface depth per bin (20th percentile: the rim's own edge, not the wall the build snapped behind it);
  // empty bins borrow from the nearest filled neighbour
  const med = bins.map((b) => (b.length ? b.sort((x, y) => x - y)[Math.floor(b.length * 0.2)] : NaN));
  const depth = med.map((v, k) => {
    for (let r = 0; Number.isNaN(v) && r < BINS / 2; r++) v = [med[(k + r) % BINS], med[(k - r + BINS) % BINS]].find((x) => !Number.isNaN(x)) ?? NaN;
    return Number.isNaN(v) ? (CRT_DEPTH[0] + CRT_DEPTH[1]) / 2 : v;
  });
  const fx = rimEffects({ cam: { pos: CAM.pos, right: CAM.right, down: CAM.down, fwd: CAM.fwd, focal: F, width: PW, height: PH }, poly: CRT_OUTLINE, depth });
  // keep it light: a capped random sample, plus pure phosphor sparks seeded on the rim
  const cap = TIER === "quest" ? 2200 : 5500;
  let seed = 11;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = picked.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [picked[k], picked[j]] = [picked[j], picked[k]]; }
  const keep = picked.slice(0, cap);
  const sparks = picked.length ? (TIER === "quest" ? 160 : 350) : 0;
  const mesh = new SplatMesh({
    constructSplats: (splats) => {
      for (const p of keep) splats.pushSplat(p.c, p.s, p.q, p.o, p.color);
      const green = new THREE.Color(0.45, 1, 0.6), sc = new V3(), q0 = new THREE.Quaternion();
      for (let k = 0; k < sparks; k++) {
        const src = keep[Math.floor(r() * keep.length)];
        sc.setScalar(0.0008 + r() * 0.0012);
        splats.pushSplat(src.c, sc, q0, 0.6 + r() * 0.4, green);
      }
    },
  });
  mesh.objectModifier = fx.modifier;
  mesh.visible = false;
  worldRoot.add(mesh);
  Object.assign(rim, { fx, mesh, count: keep.length + sparks, found: picked.length });
}

// ------------------------------------------------------------------ boot
buildMenu();
buildGame();
buildRim();
room.uniforms.introOrigin.value.copy(crt.light);
setHint();
ui.loading.classList.add("done");
setTimeout(() => (ui.loading.style.display = "none"), 1600);
const clock = new THREE.Clock();
let t = 0;
const introStart = performance.now();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  const inXr = renderer.xr.isPresenting;
  signHover = false;
  if (inXr && xrBase) worldRoot.position.copy(xrBase).addScaledVector(SEAT.clone().applyQuaternion(worldRoot.quaternion), -ease(clamp(anim.seat, 0, 1)));
  worldRoot.updateMatrixWorld(true);

  // intro sequence
  const it0 = (performance.now() - introStart) / 1000;
  if (state === "intro") {
    anim.intro = clamp(it0 / 3.6, 0, 1);
    items.forEach((i) => { if (i.layer === "main" && it0 > 1.4 + i.order * 0.18) i.revealTarget = 1; });
    if (it0 > 1.2) signRig.reveal = Math.min(1, signRig.reveal + dt * 0.7);
    if (anim.intro >= 1 && it0 > 3.8) state = "main";
  }

  // input
  pollGamepads();
  if (inXr) updateXrInput();
  else if (pointer.active && (state === "main" || state === "card" || state === "play" || state === "ended")) {
    raycaster.setFromCamera(pointer.ndc, camera);
    const res = pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
    if (inputMode === "pointer" || (inputMode === "touch" && !touch.dragged)) hovered = res.item;
    signHover = res.sign;
    document.body.style.cursor = res.item || res.sign ? "pointer" : "default";
  }
  if (hovered && !pickables().includes(hovered)) hovered = null;
  // keyboard / gamepad players: the torch jumps to whatever is selected
  if (game.active && inputMode === "keys" && hovered?.torchAt) { cursorRoom.pos.copy(hovered.torchAt); cursorRoom.target = 1; }
  if (!inXr) updateDesktopCamera(dt);
  else for (const c of controllers) c.line.visible = !!c.obj.userData.source && c.obj.userData.source.targetRayMode !== "screen";

  // item animation
  for (const i of items) {
    if (i.layer === "play" && i !== crt) i.revealTarget = game.active && !i.hidden ? (i.hoverReveal ? (i === hovered ? 1 : 0) : 1) : 0;
    i.hover = damp(i.hover, i === hovered ? 1 : 0, 9, dt);
    i.press = damp(i.press, 0, 5, dt);
    i.reveal = damp(i.reveal, i.revealTarget, 2.2, dt);
    const u = i.fx.uniforms;
    u.time.value = t; u.hover.value = i.hover; u.press.value = i.press; u.reveal.value = i.reveal;
    u.light.value = (i.enabled || i.selfLit ? 1 : 0.55) * (i.id === "continue" || i.selfLit || i.layer === "card" ? 1 : anim.light * 0.85 + 0.15);
    i.mesh.updateVersion();
  }
  // drawers slide (hover nudges the drawer open a little, selection opens it)
  drawerFrames.forEach((d, k) => {
    const label = items.find((i) => i.drawer === k);
    const want = Math.max(d.target, label && label === hovered ? 0.03 : 0);
    d.open = damp(d.open, want, 6, dt);
    room.uniforms.drawers[k].o.value = d.open;
  });
  // sign pendulum
  const s = signRig;
  s.hover = damp(s.hover, signHover ? 1 : 0, 6, dt);
  if (signHover) s.vel += Math.sin(t * 2.1) * dt * 0.6;
  s.vel += (-9.0 * s.angle - 0.55 * s.vel) * dt;
  s.angle += s.vel * dt;
  s.swing.rotation.x = s.angle * 0.12 + Math.sin(t * 0.9) * 0.012;
  s.swing.rotation.z = Math.sin(t * 0.63) * 0.01 + s.angle * 0.03;
  s.fx.uniforms.time.value = t; s.fx.uniforms.hover.value = s.hover * 0.5; s.fx.uniforms.reveal.value = s.reveal;
  s.fx.uniforms.light.value = anim.light;
  s.fx.uniforms.press.value = 0;

  // room uniforms
  const lightLvl = flickerLevel(dt) * anim.light;
  const R = room.uniforms;
  R.time.value = t;
  R.intro.value = anim.intro;
  const hoverLight = hovered?.light ?? (hovered ? hovered.group.getWorldPosition(new V3()) : null);
  const hw = damp(R.hover.value.w, hovered && state !== "busy" ? 1 : 0, 6, dt);
  if (hoverLight) R.hover.value.set(hoverLight.x, hoverLight.y, hoverLight.z, hw);
  else R.hover.value.w = hw;
  if (hovered) R.hoverColor.value.copy(hovered.color);
  cursorRoom.amt = damp(cursorRoom.amt, state === "busy" ? 0 : cursorRoom.target, 5, dt);
  R.cursor.value.set(cursorRoom.pos.x, cursorRoom.pos.y, cursorRoom.pos.z, cursorRoom.amt);
  if (anim.pulseAge >= 0) { anim.pulseAge += dt; if (anim.pulseAge > 3) anim.pulseAge = -1; }
  R.pulse.value.set(anim.pulseOrigin.x, anim.pulseOrigin.y, anim.pulseOrigin.z, anim.pulseAge);
  R.dissolve.value = anim.dissolve;
  R.light.value = lightLvl;
  R.torch.value.set(anim.torch * 1.8, 0.06, 0, 0);
  roomMesh.updateVersion();
  if (ink) {
    ink.reveal = damp(ink.reveal, game.active ? 1 : 0, 3, dt);
    const lp = cursorRoom.pos.clone().applyMatrix4(ink.inv);
    ink.fx.uniforms.cursor.value.set(lp.x, lp.y, lp.z, cursorRoom.amt * anim.torch);
    ink.fx.uniforms.time.value = t;
    ink.fx.uniforms.reveal.value = ink.reveal;
    ink.mesh.visible = ink.reveal > 0.01;
    if (ink.mesh.visible) ink.mesh.updateVersion();
  }
  // clipboards float out of the photo when hovered / read
  clips.forEach((c) => {
    c.amt = damp(c.amt, game.active ? (c.open ? 1 : c.item === hovered ? 0.2 : 0) : 0, 5, dt);
    c.lift.o.value.set(c.dir.x * 0.09 * c.amt, c.dir.y * 0.09 * c.amt + 0.01 * c.amt, c.dir.z * 0.09 * c.amt, Math.min(1, c.amt * 1.4));
  });
  // the terminal floats up to you while the keypad is open
  zoom.amt = damp(zoom.amt, zoom.target, 3.2, dt);
  {
    const ze = ease(clamp(zoom.amt, 0, 1)), off = zoom.off.clone().multiplyScalar(ze);
    CRT_QUADS.forEach((_, k) => room.uniforms.lifts[CRT_LIFT + k].o.value.set(off.x, off.y, off.z, 0.55 * ze));
    crt.group.position.copy(crt.basePos).add(off);
    // rim motes: their own clock runs while in focus, and restarts once they have faded away
    rim.amt = damp(rim.amt, zoom.target ? ze : 0, zoom.target ? 2 : 4, dt);
    rim.clock = rim.amt < 0.002 && !zoom.target ? 0 : rim.clock + dt * (0.35 + 0.65 * ze);
    rim.mesh.visible = rim.amt > 0.002;
    if (rim.mesh.visible) {
      const u = rim.fx.uniforms;
      u.time.value = t; u.clock.value = rim.clock; u.rim.value = rim.amt; u.light.value = lightLvl;
      u.off.value.copy(off);
      rim.mesh.updateVersion();
    }
  }
  // R.P.'s chair: the dust digit lines up as your eye reaches his seat
  anim.seat = damp(anim.seat, game.active && state !== "ended" ? anim.seatTarget : 0, 2.4, dt);
  if (digit) {
    digit.reveal = damp(digit.reveal, game.active && !game.won && !card ? 1 : 0, card ? 6 : 2, dt);   // out of the way of hand-held cards
    const eye = (inXr ? new V3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld) : camera.position.clone());
    worldRoot.worldToLocal(eye);
    digit.align = 1 - THREE.MathUtils.smoothstep(eye.distanceTo(digit.eye), 0.02, 0.1);
    if (digit.align > 0.8 && game.active && !game.sawDigit) { game.sawDigit = true; refreshMonitor(); }
    const u = digit.fx.uniforms;
    u.time.value = t; u.reveal.value = digit.reveal; u.align.value = digit.align;
    digit.mesh.visible = digit.reveal > 0.01;
    if (digit.mesh.visible) digit.mesh.updateVersion();
  }
  if (winWords) { winFx.uniforms.time.value = t; winWords.updateVersion(); }
  dust.uniforms.time.value = t;
  dust.uniforms.light.value = lightLvl;
  dustMesh.updateVersion();
  endFx.uniforms.time.value = t;
  if (endWords.visible) endWords.updateVersion();
  if (card) { card.cardFx.uniforms.time.value = t; card.reveal = damp(card.reveal, 1, 3, dt); card.cardFx.uniforms.reveal.value = card.reveal; card.group.position.lerpVectors(card.from, card.to, ease(Math.min(1, card.reveal * 1.15))); card.group.children.forEach((c) => c.updateVersion?.()); }

  renderer.render(scene, camera);
  adaptResolution();
}
renderer.setAnimationLoop(frame);
// debug: hidden preview panes throttle rAF; ?drive=1 renders on a timer instead
if (params.has("drive")) setInterval(() => { if (!renderer.xr.isPresenting) frame(); }, 40);

// test / debug hooks
window.__menu = {
  get state() { return state; }, get hovered() { return hovered?.id ?? null; }, items, select: (id) => select(items.find((i) => i.id === id)),
  navigate, back, tier: TIER, game, startGame, ink, clips, digit, sitDown, standUp, splats: roomMesh.packedSplats?.numSplats, project, surface,
  settings, spark, signRig, camera, room, anim, zoom, rim, xrHint, view, desk, get pixelRatio() { return pixelRatio; },
};
