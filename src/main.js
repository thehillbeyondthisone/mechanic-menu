// PATTERSON — single-photo Gaussian splat game menu (desktop + Quest 3 WebXR)
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkXr, isOculus, isMobile } from "@sparkjsdev/spark";
import { roomEffects, textEffects, dustEffects } from "./effects.js";
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
const room = roomEffects(3);
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
let state = "intro";       // intro | main | card | busy | ended
let focus = 0;             // keyboard/gamepad index into active list
let hovered = null;
let signHover = false;
const pickables = () => items.filter((it) => it.enabled && it.layer === (state === "card" ? "card" : "main"));

function makeItem({ id, mesh, fx, group, w, h, light, color = new V3(1, 0.85, 0.6), layer = "main", onSelect, order = 0, hitLift = 0.01 }) {
  mesh.objectModifier = fx.modifier;
  group.add(mesh);
  const hit = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.z = hitLift;
  group.add(hit);
  worldRoot.add(group);
  const it = { id, mesh, fx, group, hit, light: light ?? group.position.clone(), color, layer, onSelect, order, hover: 0, press: 0, reveal: 0, revealTarget: 0, enabled: true };
  hit.userData.item = it;
  items.push(it);
  return it;
}

let crt, signRig, drawerFrames;
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

  // drawer labels: NEW GAME / LOAD GAME / OPTIONS on the black cabinet
  const cab = planeFrame(1320, 1400, 1520, 1760);
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
    { id: "new", text: "NEW GAME", tape: "#b3201c", at: [1390, 1415], onSelect: () => doNewGame() },
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
  closeCard(true);
  state = "card";
  drawerFrames.forEach((d, k) => (d.target = k === drawerIndex ? 0.16 : 0));
  const d = drawerFrames[drawerIndex];
  let pos = CAM.pos.clone().lerp(d.center, 0.52).add(new V3(-0.08, 0.2, 0));   // ~1 m away, handed out of the drawer
  // small screens: hold the card closer, in the middle of the view, so its lines are big enough to read and tap
  const near = !renderer.xr.isPresenting && cardDistance(pos.distanceTo(CAM.pos));
  if (near) pos = camera.position.clone().addScaledVector(camera.getWorldDirection(new V3()), near);
  const group = new THREE.Group();
  group.position.copy(pos);
  const cardMesh = T.indexCard();
  const cardFx = textEffects("plain");
  cardMesh.objectModifier = cardFx.modifier;
  group.add(cardMesh);
  worldRoot.add(group);
  worldRoot.updateMatrixWorld(true);
  if (near) { group.up.copy(camera.up); group.lookAt(camera.position); }
  else group.lookAt(worldRoot.localToWorld(CAM.pos.clone()));   // +z faces the photo viewpoint
  const title = kind === "options" ? "OPTIONS" : "LOAD GAME";
  const head = T.typedLine(title, { color: "#8a1c1c" });
  head.objectModifier = cardFx.modifier;
  head.position.set(0, 0.078, 0.001);
  group.add(head);
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
  const cardItems = lines.map((L, i) => {
    const g = new THREE.Group();
    g.position.set(0.0, 0.035 - i * 0.026, 0.001);
    group.add(g);
    // items are parented to the card group; reparent bookkeeping so worldRoot.add in makeItem doesn't steal them
    const it = makeItem({
      id: `card-${i}`, group: g, fx: textEffects("ink"), w: 0.29, h: 0.026, layer: "card", order: i,
      mesh: T.typedLine(L.label()), light: pos.clone(), hitLift: 0.002,
      onSelect: () => {
        if (!L.act) return;
        L.act();
        if (card && it.group.parent) swapMesh(it, T.typedLine(L.label()));
      },
    });
    group.add(g);
    it.enabled = !!L.act;
    it.revealTarget = 1;
    return it;
  });
  card = { group, cardFx, items: cardItems, reveal: 0, near: !!near, from: d.center.clone().addScaledVector(d.frame.normal, 0.05), to: pos.clone() };
  group.position.copy(card.from);
  focus = 0;
}
function closeCard(immediate = false) {
  if (!card) return;
  for (const it of card.items) { items.splice(items.indexOf(it), 1); }
  worldRoot.remove(card.group);
  card.group.traverse((o) => o.dispose?.());
  card = null;
  drawerFrames.forEach((d) => (d.target = 0));
  if (!immediate) { state = "main"; focus = items.filter((i) => i.layer === "main").findIndex((i) => i.id === "options"); }
}

// ------------------------------------------------------------------ actions
const anim = { pulseAge: -1, pulseOrigin: new V3(), dissolve: 0, light: 1, push: 0, intro: 0 };
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
  if (state !== "main" && state !== "card") return;
  it.press = 1;
  it.onSelect?.();
}
function back() {
  if (state === "card") closeCard();
  else if (state === "ended") unQuit();
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
  if (rp) { cursorRoom.pos.copy(rp); cursorRoom.target = settings.pointerLight ? 1 : 0; } else cursorRoom.target = 0;
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
  if (!tapped || touch.dragged) { cursorRoom.target = 0; hovered = null; return; }
  setNdc(e);
  raycaster.setFromCamera(pointer.ndc, camera);
  const res = pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
  cursorRoom.target = 0;
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
let needRecenter = 0;
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
  onExitXr: () => { ui.vr.textContent = "ENTER VR"; worldRoot.position.set(0, 0, 0); worldRoot.rotation.set(0, 0, 0); xrHint.visible = false; setHint(); },
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
  camera.position.copy(CAM.pos)
    .addScaledVector(CAM.right, desk.look.x * 0.07)
    .addScaledVector(CAM.up, desk.look.y * 0.045)
    .add(desk.lean);
  const aim = unproject(view.u[0] + desk.look.x * view.u[1], view.v[0] - desk.look.y * view.v[1], 3.0);
  if (anim.push > 0) aim.lerp(crt.light, anim.push * 0.6);
  camera.up.copy(CAM.up);
  camera.lookAt(aim);
  // depth of field focuses on the hovered object, or the open card
  const focusDist = hovered && !card ? camera.position.distanceTo(hovered.light ?? hovered.group.position)
    : card ? camera.position.distanceTo(card.group.position) : 2.4;
  spark.focalDistance = damp(spark.focalDistance || 2.4, focusDist, 4, dt);
  spark.apertureAngle = settings.dof ? 0.0012 : 0;
}

// ------------------------------------------------------------------ hints
function setHint() {
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

// ------------------------------------------------------------------ boot
buildMenu();
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
  else if (pointer.active && (state === "main" || state === "card" || state === "ended")) {
    raycaster.setFromCamera(pointer.ndc, camera);
    const res = pickFromRay(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
    if (inputMode === "pointer" || (inputMode === "touch" && !touch.dragged)) hovered = res.item;
    signHover = res.sign;
    document.body.style.cursor = res.item || res.sign ? "pointer" : "default";
  }
  if (hovered && !pickables().includes(hovered)) hovered = null;
  if (!inXr) updateDesktopCamera(dt);
  else for (const c of controllers) c.line.visible = !!c.obj.userData.source && c.obj.userData.source.targetRayMode !== "screen";

  // item animation
  for (const i of items) {
    i.hover = damp(i.hover, i === hovered ? 1 : 0, 9, dt);
    i.press = damp(i.press, 0, 5, dt);
    i.reveal = damp(i.reveal, i.revealTarget, 2.2, dt);
    const u = i.fx.uniforms;
    u.time.value = t; u.hover.value = i.hover; u.press.value = i.press; u.reveal.value = i.reveal;
    u.light.value = (i.enabled ? 1 : 0.55) * (i.id === "continue" ? 1 : anim.light * 0.85 + 0.15);
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
  roomMesh.updateVersion();
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
  navigate, back, tier: TIER, splats: roomMesh.packedSplats?.numSplats, project, surface,
  settings, spark, signRig, camera, room, anim, xrHint, view, desk, get pixelRatio() { return pixelRatio; },
};
