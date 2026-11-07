// Typography as physical splat objects: canvases rasterised into Gaussian splats
// with real thickness (layered relief), so menu text sits in the room like objects.
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

export const FONTS = {
  slab: '"Alfa Slab One", "Rockwell Extra Bold", Rockwell, Georgia, serif',
  crt: '"VT323", "Lucida Console", "Courier New", monospace',
  stencil: '"Black Ops One", Impact, "Arial Black", sans-serif',
  tape: '"Oswald", "Arial Narrow", "Roboto Condensed", Arial, sans-serif',
  type: '"Special Elite", "Courier New", Courier, monospace',
};

export async function loadFonts() {
  const specs = ['64px "Alfa Slab One"', '64px "VT323"', '64px "Black Ops One"', '600 64px "Oswald"', '64px "Special Elite"'];
  try {
    await Promise.race([Promise.all(specs.map((s) => document.fonts.load(s))), new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* system fallbacks are fine */ }
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return c;
}

// deterministic noise so labels look worn but stable between reloads
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Rasterise layered canvases into one SplatMesh. Local frame: x right, y up, z out of surface.
 * layers: [{ canvas, z, shade = 1, alphaCut = 0.08, every = 1 }]
 */
export function layersToSplats(layers, widthM, { splatScale = 0.62, opacityBoost = 1 } = {}) {
  const w = layers[0].canvas.width, h = layers[0].canvas.height;
  const mpp = widthM / w;
  const pixels = layers.map((L) => L.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data);
  return new SplatMesh({
    constructSplats: (splats) => {
      const c = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion(), col = new THREE.Color();
      layers.forEach((L, li) => {
        const px = pixels[li], cut = (L.alphaCut ?? 0.08) * 255, every = L.every ?? 1, shade = L.shade ?? 1;
        const sz = mpp * every * splatScale;
        s.set(sz, sz, mpp * 0.25);
        for (let y = 0; y < h; y += every) {
          for (let x = 0; x < w; x += every) {
            const k = (y * w + x) * 4, a = px[k + 3];
            if (a <= cut) continue;
            c.set((x - w / 2 + 0.5) * mpp, (h / 2 - y - 0.5) * mpp, L.z);
            col.setRGB((px[k] / 255) * shade, (px[k + 1] / 255) * shade, (px[k + 2] / 255) * shade);
            splats.pushSplat(c, s, q, Math.min(1, (a / 255) * opacityBoost), col);
          }
        }
      });
    },
  });
}

/** Text with a stack of darker copies behind it = extruded / embossed relief. */
function reliefLayers(textCanvas, base, depthM, steps, sideShade = 0.45) {
  const out = [];
  for (let i = steps; i >= 1; i--) out.push({ canvas: textCanvas, z: base + (depthM * (i - 1)) / steps, shade: sideShade });
  out.push({ canvas: textCanvas, z: base + depthM, shade: 1 });
  return out;
}

// ---------------------------------------------------------------- designs

/** Label-maker tape (embossed white letters on coloured vinyl). */
export function dymoTape(text, { tape = "#1d1d1f", widthM = 0.26, heightM = 0.042, mpp = 0.0011, seed = 1 } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const bg = canvas(W, H), fg = canvas(W, H);
  const r = rng(seed);
  let g = bg.getContext("2d");
  // vinyl strip with slightly ragged cut ends and a glossy band
  g.fillStyle = tape;
  g.beginPath();
  g.moveTo(H * 0.08, H * 0.06); g.lineTo(W - H * 0.1, 0); g.lineTo(W, H * 0.5); g.lineTo(W - H * 0.08, H);
  g.lineTo(H * 0.05, H * 0.96); g.lineTo(0, H * 0.45); g.closePath(); g.fill();
  const gl = g.createLinearGradient(0, 0, 0, H);
  gl.addColorStop(0, "rgba(255,255,255,0.20)"); gl.addColorStop(0.35, "rgba(255,255,255,0.03)"); gl.addColorStop(1, "rgba(0,0,0,0.25)");
  g.globalCompositeOperation = "source-atop"; g.fillStyle = gl; g.fillRect(0, 0, W, H);
  // letters: raised plastic, each slightly misaligned like a real hand-cranked embosser
  g = fg.getContext("2d");
  const size = H * 0.62;
  g.font = `600 ${size}px ${FONTS.tape}`;
  g.textBaseline = "middle";
  const letters = text.split("");
  const spacing = size * 0.13;
  const total = letters.reduce((acc, ch) => acc + g.measureText(ch).width + spacing, -spacing);
  const scale = Math.min(1, (W - H * 0.9) / total);
  let x = (W - total * scale) / 2;
  g.save();
  g.scale(scale, 1);
  x /= scale;
  for (const ch of letters) {
    const cw = g.measureText(ch).width;
    g.save();
    g.translate(x + cw / 2, H / 2 + (r() - 0.5) * H * 0.07);
    g.rotate((r() - 0.5) * 0.06);
    g.fillStyle = `rgba(${240 + r() * 15},${238 + r() * 15},${230 + r() * 15},1)`;
    g.fillText(ch, -cw / 2, 0);
    g.restore();
    x += cw + spacing;
  }
  g.restore();
  return layersToSplats([{ canvas: bg, z: 0 }, ...reliefLayers(fg, 0.0004, 0.0016, 2, 0.7)], widthM);
}

/** Green-phosphor CRT text with bloom halo. lines: [{text, size(0..1 of height), y}] */
export function crtScreen(lines, { widthM = 0.21, heightM = 0.16, mpp = 0.0008, color = [120, 255, 140] } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const fg = canvas(W, H), glow = canvas(W, H);
  const g = fg.getContext("2d");
  g.textBaseline = "middle";
  g.textAlign = "left";
  for (const L of lines) {
    g.font = `${H * L.size}px ${FONTS.crt}`;
    g.fillStyle = `rgb(${color.join(",")})`;
    g.fillText(L.text, W * (L.x ?? 0.06), H * L.y);
  }
  const gg = glow.getContext("2d");
  gg.filter = `blur(${H * 0.035}px)`;
  gg.globalAlpha = 0.55;
  gg.drawImage(fg, 0, 0);
  return layersToSplats([{ canvas: glow, z: 0, shade: 0.55, alphaCut: 0.04, every: 2 }, { canvas: fg, z: 0.0015, alphaCut: 0.12 }], widthM, { splatScale: 0.7 });
}

/** Spray-painted floor stencil (letters stretched in depth like real road markings). */
export function floorStencil(text, sub, { widthM = 0.62, heightM = 0.62, mpp = 0.0026, seed = 7 } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const fg = canvas(W, H);
  const g = fg.getContext("2d");
  const r = rng(seed);
  g.fillStyle = "#f2c230";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.save();
  g.translate(W / 2, H * 0.42);
  g.scale(1, 1.9);
  g.font = `${H * 0.27}px ${FONTS.stencil}`;
  g.fillText(text, 0, 0);
  g.restore();
  g.font = `${H * 0.085}px ${FONTS.stencil}`;
  g.fillText(sub, W / 2, H * 0.86);
  // hazard bar
  g.save();
  g.beginPath(); g.rect(W * 0.08, H * 0.93, W * 0.84, H * 0.05); g.clip();
  for (let x = -H; x < W; x += H * 0.08) {
    g.beginPath(); g.moveTo(x, H); g.lineTo(x + H * 0.04, H); g.lineTo(x + H * 0.1, H * 0.9); g.lineTo(x + H * 0.06, H * 0.9); g.fill();
  }
  g.restore();
  // wear: knock out flecks + overspray
  const img = g.getImageData(0, 0, fg.width, fg.height);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] > 0) {
      const n = r();
      if (n < 0.16) img.data[i + 3] = 0;
      else img.data[i + 3] *= 0.55 + 0.45 * r();
      img.data[i] *= 0.85 + 0.15 * r();
    }
  }
  g.putImageData(img, 0, 0);
  return layersToSplats([{ canvas: fg, z: 0.002, alphaCut: 0.05 }], widthM, { splatScale: 0.8, opacityBoost: 0.95 });
}

/** Porcelain-enamel hanging shop sign with relief lettering and chains. Returns {mesh, size}. */
export function enamelSign(title, sub, { widthM = 0.92, heightM = 0.30, mpp = 0.0024 } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const board = canvas(W, H), letters = canvas(W, H), back = canvas(W, H);
  let g = board.getContext("2d");
  const R = H * 0.12;
  const rr = (ctx, x, y, w, h, rad) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); };
  g.fillStyle = "#e9dfc6"; rr(g, 0, 0, W, H, R); g.fill();                  // cream rim
  g.fillStyle = "#123b2f"; rr(g, H * 0.05, H * 0.05, W - H * 0.1, H * 0.9, R * 0.8); g.fill();   // deep green enamel
  g.strokeStyle = "#e9dfc6"; g.lineWidth = H * 0.018; rr(g, H * 0.1, H * 0.1, W - H * 0.2, H * 0.8, R * 0.6); g.stroke();
  // chips in the enamel
  const r = rng(11);
  for (let i = 0; i < 26; i++) {
    const x = r() * W, y = r() * H, s = (0.004 + r() * 0.012) * H * 3;
    g.fillStyle = r() < 0.5 ? "#3a2e25" : "#1b1712";
    g.beginPath(); g.ellipse(x, y, s, s * (0.5 + r()), r() * 3, 0, Math.PI * 2); g.fill();
  }
  const sh = g.createLinearGradient(0, 0, W * 0.4, H);
  sh.addColorStop(0, "rgba(255,255,255,0.10)"); sh.addColorStop(0.5, "rgba(255,255,255,0)"); sh.addColorStop(1, "rgba(0,0,0,0.15)");
  g.globalCompositeOperation = "source-atop"; g.fillStyle = sh; g.fillRect(0, 0, W, H);
  // relief letters
  g = letters.getContext("2d");
  g.fillStyle = "#f1e6cb";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${H * 0.44}px ${FONTS.slab}`;
  const tw = g.measureText(title).width;
  g.save(); g.translate(W / 2, H * 0.44); g.scale(Math.min(1, (W * 0.86) / tw), 1); g.fillText(title, 0, 0); g.restore();
  g.font = `${H * 0.11}px ${FONTS.slab}`;
  g.fillStyle = "#d9a441";
  g.fillText(sub.split("").join(String.fromCharCode(8202)), W / 2, H * 0.76);
  // back face (dark painted steel)
  g = back.getContext("2d");
  g.fillStyle = "#1c1a17"; rr(g, 0, 0, W, H, R); g.fill();
  const mesh = layersToSplats([
    { canvas: back, z: -0.012, shade: 1, every: 2 },
    { canvas: board, z: -0.006, shade: 0.55, every: 2 },
    { canvas: board, z: 0 },
    ...reliefLayers(letters, 0.0008, 0.004, 3, 0.5),
  ], widthM);
  return { mesh, width: widthM, height: heightM };
}

/** Chain of oval links from a to b (local coords). */
export function chain(a, b, { link = 0.018, color = "#5d574e" } = {}) {
  const d = new THREE.Vector3().subVectors(b, a);
  const n = Math.max(2, Math.round(d.length() / link));
  const col = new THREE.Color(color);
  return new SplatMesh({
    constructSplats: (splats) => {
      const c = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
      for (let i = 0; i <= n; i++) {
        c.copy(a).addScaledVector(d, i / n);
        const ring = i % 2 === 0;
        for (let k = 0; k < 10; k++) {
          const ang = (k / 10) * Math.PI * 2;
          const off = new THREE.Vector3(Math.cos(ang) * 0.004, Math.sin(ang) * link * 0.45, 0);
          if (!ring) off.set(0, off.y, off.x);
          s.setScalar(0.0016);
          const shade = 0.6 + 0.4 * Math.max(0, Math.cos(ang - 0.8));
          splats.pushSplat(c.clone().add(off), s, q, 1, col.clone().multiplyScalar(shade));
        }
      }
    },
  });
}

/** Typewritten index card for sub-menus. Each line is its own splat object so it can be picked. */
export function indexCard({ widthM = 0.30, heightM = 0.20, mpp = 0.0012 } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const c = canvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#efe6d0"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(200,60,60,0.55)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, H * 0.2); g.lineTo(W, H * 0.2); g.stroke();
  g.strokeStyle = "rgba(90,130,190,0.35)"; g.lineWidth = 1;
  for (let y = H * 0.32; y < H; y += H * 0.12) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const r = rng(5);
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) { const n = 0.94 + r() * 0.06; img.data[i] *= n; img.data[i + 1] *= n; img.data[i + 2] *= n * 0.98; }
  g.putImageData(img, 0, 0);
  return layersToSplats([{ canvas: c, z: 0 }], widthM, { splatScale: 0.7 });
}

export function typedLine(text, { widthM = 0.27, heightM = 0.024, mpp = 0.0007, color = "#1f1c1a" } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const c = canvas(W, H);
  const g = c.getContext("2d");
  g.font = `${H * 0.8}px ${FONTS.type}`;
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 2, H * 0.55, W - 6);   // squeeze long lines to fit the card instead of cutting them off
  return layersToSplats([{ canvas: c, z: 0.0008, alphaCut: 0.15 }], widthM, { splatScale: 0.7 });
}

/** Free-floating glowing words (end screen). */
export function glowWords(text, { widthM = 1.2, heightM = 0.22, mpp = 0.003, color = "#ffd28a", font = FONTS.slab } = {}) {
  const W = widthM / mpp, H = heightM / mpp;
  const fg = canvas(W, H), glow = canvas(W, H);
  const g = fg.getContext("2d");
  g.fillStyle = color; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${H * 0.7}px ${font}`;
  const tw = g.measureText(text).width;
  g.save(); g.translate(W / 2, H / 2); g.scale(Math.min(1, (W * 0.95) / tw), 1); g.fillText(text, 0, 0); g.restore();
  const gg = glow.getContext("2d"); gg.filter = `blur(${H * 0.06}px)`; gg.globalAlpha = 0.5; gg.drawImage(fg, 0, 0);
  return layersToSplats([{ canvas: glow, z: -0.004, shade: 0.6, alphaCut: 0.03, every: 2 }, { canvas: fg, z: 0 }], widthM);
}
