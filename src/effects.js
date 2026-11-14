// GPU splat modifiers (Spark dyno). Everything here runs per-splat on the GPU.
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

const HASH = dyno.unindent(`
  uint pm_pcg(uint v) {
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
  }
  vec3 pm_rand3(int i) {
    uint a = pm_pcg(uint(i));
    uint b = pm_pcg(a ^ 0x9e3779b9u);
    uint c = pm_pcg(b ^ 0x85ebca6bu);
    return vec3(float(a), float(b), float(c)) * (1.0 / 4294967295.0);
  }
`);

/**
 * Uniforms + modifier for the photographed room.
 * lifts: regions cut out of the photo by an outline in photo px (quad) and a depth window, which can float
 * toward the viewer (clipboards). cam: { pos, right, down, fwd, focal, width, height } of the photo.
 */
export function roomEffects(numDrawers, { lifts = 0, cam = null } = {}) {
  const u = {
    time: dyno.dynoFloat(0),
    intro: dyno.dynoFloat(0),          // 0 → 1 room assembles out of darkness
    introOrigin: dyno.dynoVec3(new THREE.Vector3()),
    hover: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 0)),   // xyz pos, w amount
    hoverColor: dyno.dynoVec3(new THREE.Vector3(1, 0.85, 0.6)),
    cursor: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 0)),
    pulse: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, -1)), // xyz origin, w age (s); <0 = off
    pulseColor: dyno.dynoVec3(new THREE.Vector3(1, 0.8, 0.5)),
    dissolve: dyno.dynoFloat(0),
    light: dyno.dynoFloat(1),          // global light level (fluorescent flicker, fades)
    torch: dyno.dynoVec4(new THREE.Vector4(0, 0.04, 0, 0)),   // x strength, y radius² (m²): pointer as a flashlight in the dark
    drawers: [],
    lifts: [],
  };
  for (let k = 0; k < numDrawers; k++) {
    u.drawers.push({
      c: dyno.dynoVec3(new THREE.Vector3()), x: dyno.dynoVec3(new THREE.Vector3(1, 0, 0)),
      y: dyno.dynoVec3(new THREE.Vector3(0, 1, 0)), z: dyno.dynoVec3(new THREE.Vector3(0, 0, 1)),
      h: dyno.dynoVec3(new THREE.Vector3()), o: dyno.dynoFloat(0),
    });
  }

  for (let k = 0; k < lifts; k++) {
    u.lifts.push({
      ab: dyno.dynoVec4(new THREE.Vector4()), cd: dyno.dynoVec4(new THREE.Vector4()),   // quad corners (photo px)
      z: dyno.dynoVec2(new THREE.Vector2(0, -1)),                                        // depth window (m along the view axis)
      o: dyno.dynoVec4(new THREE.Vector4()),                                             // xyz offset, w glow / self-light
    });
  }

  const inTypes = {
    gsplat: dyno.Gsplat, t: "float", intro: "float", introO: "vec3", hover: "vec4", hoverC: "vec3",
    cursor: "vec4", pulse: "vec4", pulseC: "vec3", dissolve: "float", light: "float", torch: "vec4",
  };
  const inputs = {
    t: u.time, intro: u.intro, introO: u.introOrigin, hover: u.hover, hoverC: u.hoverColor,
    cursor: u.cursor, pulse: u.pulse, pulseC: u.pulseColor, dissolve: u.dissolve, light: u.light, torch: u.torch,
  };
  u.drawers.forEach((d, k) => {
    Object.assign(inTypes, { [`dc${k}`]: "vec3", [`dx${k}`]: "vec3", [`dy${k}`]: "vec3", [`dz${k}`]: "vec3", [`dh${k}`]: "vec3", [`do${k}`]: "float" });
    Object.assign(inputs, { [`dc${k}`]: d.c, [`dx${k}`]: d.x, [`dy${k}`]: d.y, [`dz${k}`]: d.z, [`dh${k}`]: d.h, [`do${k}`]: d.o });
  });

  u.lifts.forEach((L, k) => {
    Object.assign(inTypes, { [`la${k}`]: "vec4", [`lb${k}`]: "vec4", [`lz${k}`]: "vec2", [`lo${k}`]: "vec4" });
    Object.assign(inputs, { [`la${k}`]: L.ab, [`lb${k}`]: L.cd, [`lz${k}`]: L.z, [`lo${k}`]: L.o });
  });
  const f = (x) => x.toFixed(6);
  const v3 = (v) => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
  const QUAD = !lifts ? "" : dyno.unindent(`
    float pm_edge(vec2 a, vec2 b, vec2 p) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
    bool pm_inQuad(vec2 p, vec4 ab, vec4 cd) {
      float e0 = pm_edge(ab.xy, ab.zw, p), e1 = pm_edge(ab.zw, cd.xy, p), e2 = pm_edge(cd.xy, cd.zw, p), e3 = pm_edge(cd.zw, ab.xy, p);
      return (e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0 && e3 >= 0.0) || (e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0 && e3 <= 0.0);
    }
  `);

  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes,
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH, QUAD],
      statements: ({ inputs: i, outputs: o }) => {
        let drawerCode = "";
        u.drawers.forEach((_, k) => {
          drawerCode += `
          {
            vec3 l = p - ${i[`dc${k}`]};
            vec3 q = vec3(dot(l, ${i[`dx${k}`]}), dot(l, ${i[`dy${k}`]}), dot(l, ${i[`dz${k}`]}));
            vec3 hh = ${i[`dh${k}`]};
            if (abs(q.x) < hh.x && abs(q.y) < hh.y && abs(q.z) < hh.z) {
              p += ${i[`dz${k}`]} * ${i[`do${k}`]};
              rgb *= 1.0 + 1.5 * ${i[`do${k}`]};
            }
          }`;
        });
        let liftCode = "";
        if (lifts) {
          liftCode = `
          {
            vec3 cv0 = p - ${v3(cam.pos)};
            float cz = dot(cv0, ${v3(cam.fwd)});
            vec2 uv = vec2(${f(cam.focal)} * dot(cv0, ${v3(cam.right)}) / cz + ${f(cam.width / 2)},
                           ${f(cam.focal)} * dot(cv0, ${v3(cam.down)}) / cz + ${f(cam.height / 2)});`;
          // else-if: a splat follows only the first region it falls in, so several quads can share one offset
          // and together outline a shape that isn't a single convex quad (the terminal)
          u.lifts.forEach((_, k) => {
            liftCode += `
            ${k ? "else " : ""}if (cz >${i[`lz${k}`]}.x && cz < ${i[`lz${k}`]}.y && pm_inQuad(uv, ${i[`la${k}`]}, ${i[`lb${k}`]})) {
              p += ${i[`lo${k}`]}.xyz;
              selfLit = max(selfLit, ${i[`lo${k}`]}.w);
              liftGrow = max(liftGrow, length(${i[`lo${k}`]}.xyz));
            }`;
          });
          liftCode += `
          }`;
        }
        return dyno.unindentLines(`
          ${o.gsplat} = ${i.gsplat};
          vec3 p = ${i.gsplat}.center;
          vec3 rgb = ${i.gsplat}.rgba.rgb;
          float a = ${i.gsplat}.rgba.a;
          vec3 sc = ${i.gsplat}.scales;
          vec3 rnd = pm_rand3(${i.gsplat}.index);
          float t = ${i.t};

          float selfLit = 0.0;
          float liftGrow = 0.0;   // metres a lifted region travelled: seen up close, grow its discs so the surfels close their gaps
          ${drawerCode}
          ${liftCode}
          sc *= 1.0 + 0.25 * liftGrow;

          // hover: warm practical light on the chosen object
          vec3 hv = p - ${i.hover}.xyz;
          float spot = ${i.hover}.w * exp(-dot(hv, hv) / 0.16);
          rgb = rgb * (1.0 + 0.6 * spot) + ${i.hoverC} * 0.07 * spot;

          // pointer: soft flashlight + breathing ripple where the ray meets the room
          vec3 cv = p - ${i.cursor}.xyz;
          float cd = length(cv);
          float fl = ${i.cursor}.w * exp(-cd * cd / 0.03);
          rgb *= 1.0 + 0.45 * fl;
          p += cv / max(cd, 1e-3) * 0.010 * fl * (0.5 + 0.5 * sin(t * 4.0 - cd * 40.0));

          // shockwave
          if (${i.pulse}.w >= 0.0) {
            float age = ${i.pulse}.w;
            vec3 pv = p - ${i.pulse}.xyz;
            float pd = length(pv);
            float ring = exp(-pow(pd - age * 3.2, 2.0) / 0.02) * exp(-age * 1.1);
            p += pv / max(pd, 1e-3) * 0.06 * ring;
            rgb += ${i.pulseC} * 0.45 * ring;
          }

          // dissolve: splats lift away like dust
          if (${i.dissolve} > 0.0) {
            float k = clamp(${i.dissolve} * 1.7 - rnd.x * 0.7, 0.0, 1.0);
            float k2 = k * k;
            p += (vec3(rnd.y - 0.5, 0.0, rnd.z - 0.5) * 1.6 + vec3(0.0, 0.9 + rnd.x, 0.0)) * k2
               + vec3(sin(t * 0.7 + rnd.x * 6.28), 0.0, cos(t * 0.6 + rnd.y * 6.28)) * 0.15 * k;
            a *= 1.0 - smoothstep(0.35, 1.0, k);
            sc *= 1.0 - 0.6 * k;
          }

          // intro: assemble outward from the origin
          if (${i.intro} < 1.0) {
            float di = length(p - ${i.introO});
            float front = ${i.intro} * 7.5;
            float r = clamp((front - di) / 0.9 + rnd.x * 0.3, 0.0, 1.0);
            float e = 1.0 - r;
            p += (rnd - 0.5) * 0.8 * e * e + vec3(0.0, 0.25, 0.0) * e;
            a *= smoothstep(0.0, 0.6, r);
            rgb *= mix(vec3(1.8, 1.2, 0.7), vec3(1.0), smoothstep(0.0, 1.0, r));
          }

          // torch: in the dark, the pointer lights the room on its own
          float tq = ${i.torch}.x * ${i.cursor}.w * exp(-cd * cd / ${i.torch}.y);
          rgb *= mix(${i.light} + tq, 1.15, selfLit);
          ${o.gsplat}.center = p;
          ${o.gsplat}.scales = sc;
          ${o.gsplat}.rgba = vec4(rgb, a);
        `);
      },
    });
    return { gsplat: d.apply({ gsplat, ...inputs }).gsplat };
  });
  return { uniforms: u, modifier };
}

/** Uniforms + modifier for one typography object. style: "plain" | "crt" | "neon" */
export function textEffects(style = "plain") {
  const u = {
    time: dyno.dynoFloat(0), hover: dyno.dynoFloat(0), press: dyno.dynoFloat(0),
    reveal: dyno.dynoFloat(0), light: dyno.dynoFloat(1),
  };
  const styleCode = {
    plain: `rgb *= 1.0 + 0.55 * hv;`,
    ink: `rgb = mix(rgb, vec3(0.78, 0.10, 0.08), hv * 0.9);`,
    crt: `
      float scan = 0.80 + 0.20 * sin(p.y * 1500.0 - t * 18.0);
      float roll = 0.9 + 0.1 * smoothstep(0.0, 0.02, abs(fract(p.y * 6.0 - t * 0.35) - 0.5));
      rgb *= scan * roll * (1.0 + 0.7 * hv);
      p.x += (pm_rand3(int(t * 24.0)).x - 0.5) * 0.0025 * (0.3 + hv);`,
    neon: `rgb *= (0.92 + 0.08 * sin(t * 50.0 + rnd.x * 3.0)) * (1.0 + 0.5 * hv);`,
  }[style];
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", hover: "float", press: "float", reveal: "float", light: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 p = ${i.gsplat}.center;
        vec3 rgb = ${i.gsplat}.rgba.rgb;
        float a = ${i.gsplat}.rgba.a;
        vec3 rnd = pm_rand3(${i.gsplat}.index);
        float t = ${i.t};
        float hv = ${i.hover};
        // lift off the surface + travelling wave when hovered
        p.z += hv * 0.006 + sin(p.x * 55.0 - t * 6.0) * 0.0018 * hv;
        ${styleCode}
        // press: flash and kick
        rgb += vec3(${i.press}) * 0.9;
        p.z += ${i.press} * 0.02;
        // reveal: letters condense out of drifting splats
        float r = clamp(${i.reveal} * 1.6 - rnd.x * 0.6, 0.0, 1.0);
        float e = 1.0 - r;
        p += (rnd - 0.5) * vec3(0.5, 0.3, 0.4) * e * e;
        a *= smoothstep(0.0, 0.7, r);
        rgb *= ${i.light};
        ${o.gsplat}.center = p;
        ${o.gsplat}.rgba = vec4(rgb, a);
      `),
    });
    return { gsplat: d.apply({ gsplat, t: u.time, hover: u.hover, press: u.press, reveal: u.reveal, light: u.light }).gsplat };
  });
  return { uniforms: u, modifier };
}

/** Hidden marker ink: only the splats inside the torch beam show. cursor = beam centre in the ink's local frame. */
export function inkEffects() {
  const u = {
    time: dyno.dynoFloat(0), reveal: dyno.dynoFloat(0),
    cursor: dyno.dynoVec4(new THREE.Vector4(0, 0, 0, 0)),   // xyz local, w beam strength
    radius: dyno.dynoFloat(0.15),
  };
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", reveal: "float", cursor: "vec4", radius: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 p = ${i.gsplat}.center;
        vec3 rnd = pm_rand3(${i.gsplat}.index);
        float d = length(p.xy - ${i.cursor}.xy);
        float lit = ${i.cursor}.w * (1.0 - smoothstep(${i.radius} * 0.45, ${i.radius}, d + (rnd.x - 0.5) * 0.02));
        lit *= 0.9 + 0.1 * sin(${i.t} * 3.0 + rnd.y * 6.28);
        ${o.gsplat}.rgba = vec4(${i.gsplat}.rgba.rgb * (0.35 + 0.9 * lit), ${i.gsplat}.rgba.a * clamp(lit, 0.0, 1.0) * ${i.reveal});
      `),
    });
    return { gsplat: d.apply({ gsplat, t: u.time, reveal: u.reveal, cursor: u.cursor, radius: u.radius }).gsplat };
  });
  return { uniforms: u, modifier };
}

/**
 * The dust digit: motes that wander like the room's dust while you stand, and settle into a crisp glyph
 * as your eye reaches the seat they were laid out from. align: 0 = loose dust, 1 = lined up.
 */
export function moteEffects() {
  const u = { time: dyno.dynoFloat(0), reveal: dyno.dynoFloat(0), align: dyno.dynoFloat(0) };
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", reveal: "float", align: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 rnd = pm_rand3(${i.gsplat}.index);
        float t = ${i.t};
        float al = ${i.align};
        float loose = 1.0 - al;
        vec3 p = ${i.gsplat}.center;
        p += vec3(sin(t * (0.23 + rnd.x * 0.2) + rnd.y * 6.28),
                  sin(t * (0.17 + rnd.z * 0.15) + rnd.x * 6.28),
                  cos(t * (0.19 + rnd.y * 0.2) + rnd.z * 6.28)) * 0.035 * loose * loose;
        float tw = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(t * (0.8 + rnd.z * 2.0) + rnd.x * 30.0), 3.0);
        tw = mix(tw, 0.92 + 0.08 * sin(t * 3.0 + rnd.y * 6.28), al);
        float r = clamp(${i.reveal} * 1.6 - rnd.x * 0.6, 0.0, 1.0);
        float a = ${i.gsplat}.rgba.a * smoothstep(0.0, 0.7, r) * mix(0.3, 1.0, al) * tw;
        ${o.gsplat}.center = p;
        ${o.gsplat}.scales = ${i.gsplat}.scales * mix(0.7, 0.8, al);
        float grain = mix(1.0, 0.55 + 0.6 * rnd.y * rnd.y, al);   // lined up, it still reads as specks of dust
        ${o.gsplat}.rgba = vec4(${i.gsplat}.rgba.rgb * mix(0.5, 1.6, al) * tw * grain, a);
      `),
    });
    return { gsplat: d.apply({ gsplat, t: u.time, reveal: u.reveal, align: u.align }).gsplat };
  });
  return { uniforms: u, modifier };
}

/** Outline polygon (photo px) → segments with start, unit direction, length, arc start and inward normal. */
export function outlineSegments(poly) {
  const n = poly.length;
  let area = 0;
  for (let k = 0; k < n; k++) { const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % n]; area += ax * by - bx * ay; }
  const sgn = Math.sign(area) || 1;
  const segs = [];
  let per = 0;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % n];
    const len = Math.hypot(bx - ax, by - ay), ex = (bx - ax) / len, ey = (by - ay) / len;
    segs.push({ ax, ay, ex, ey, len, s: per, nx: -ey * sgn, ny: ex * sgn });
    per += len;
  }
  return { segs, per };
}
/** Nearest outline point to p (photo px) → { s: arc position, d: distance }. */
export function outlineNearest({ segs }, p) {
  let d = Infinity, s = 0;
  for (const g of segs) {
    const wx = p[0] - g.ax, wy = p[1] - g.ay, q = Math.min(Math.max(wx * g.ex + wy * g.ey, 0), g.len);
    const dd = Math.hypot(wx - g.ex * q, wy - g.ey * q);
    if (dd < d) { d = dd; s = g.s + q; }
  }
  return { s, d };
}

/**
 * Rim motes: copies of the gaussians along a cut-out's outline (photo px polygon) that come alive while it is in focus.
 * Each copy finds where it sits on the outline (arc position + inward distance) and, by its own random draw, either
 * streams around the rim, coils around the bezel edge, or peels off as an ember. rim: 0 → 1 fade in, clock: rim time (s),
 * off: the lift offset the cut-out has travelled, light: room light.
 */
export function rimEffects({ cam, poly, depth, glow = [0.35, 1.0, 0.55] }) {
  const u = {
    time: dyno.dynoFloat(0), clock: dyno.dynoFloat(0), rim: dyno.dynoFloat(0), light: dyno.dynoFloat(1),
    off: dyno.dynoVec3(new THREE.Vector3()),
  };
  const f = (x) => x.toFixed(6);
  const v2 = (x, y) => `vec2(${f(x)}, ${f(y)})`;
  const v3 = (v) => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
  // outline segments; depth: surface depth (m along the view axis) sampled at even steps round the outline
  const { segs, per } = outlineSegments(poly);
  const n = segs.length;
  const RIM_DEPTH = `const float PM_RIM_DEPTH[${depth.length}] = float[${depth.length}](${Array.from(depth, f).join(", ")});
float pm_rimDepth(float sp) {
  float x = sp / ${f(per)} * ${f(depth.length)};
  int i0 = int(floor(x)) % ${depth.length};
  return mix(PM_RIM_DEPTH[i0], PM_RIM_DEPTH[(i0 + 1) % ${depth.length}], fract(x));
}`;
  const nearest = segs.map((g) => `
    { vec2 w = uv - ${v2(g.ax, g.ay)}; float q = clamp(dot(w, ${v2(g.ex, g.ey)}), 0.0, ${f(g.len)});
      float dd = length(w - ${v2(g.ex, g.ey)} * q); if (dd < best) { best = dd; s = ${f(g.s)} + q; } }`).join("");
  // position + corner-blended inward normal at arc position sp
  const CORNER = 24;
  const walk = segs.map((g, k) => {
    const pv = segs[(k + n - 1) % n], nx = segs[(k + 1) % n];
    return `${k ? "else " : ""}${k < n - 1 ? `if (sp < ${f(g.s + g.len)})` : ""} {
      float q = sp - ${f(g.s)};
      bp = ${v2(g.ax, g.ay)} + ${v2(g.ex, g.ey)} * q;
      float wp = 0.5 * (1.0 - smoothstep(0.0, ${f(CORNER)}, q)), wn = 0.5 * (1.0 - smoothstep(0.0, ${f(CORNER)}, ${f(g.len)} - q));
      nin = normalize(${v2(g.nx, g.ny)} * (1.0 - wp - wn) + ${v2(pv.nx, pv.ny)} * wp + ${v2(nx.nx, nx.ny)} * wn);
    }`;
  }).join("\n");
  const PER = f(per);
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", clock: "float", rim: "float", light: "float", off: "vec3" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH, RIM_DEPTH],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 p = ${i.gsplat}.center;
        vec3 rnd = pm_rand3(${i.gsplat}.index);
        vec3 rnd2 = pm_rand3(${i.gsplat}.index + 104729);
        float t = ${i.t};
        float clk = ${i.clock};
        vec3 cv0 = p - ${v3(cam.pos)};
        float cz = dot(cv0, ${v3(cam.fwd)});
        vec2 uv = vec2(${f(cam.focal)} * dot(cv0, ${v3(cam.right)}) / cz + ${f(cam.width / 2)},
                       ${f(cam.focal)} * dot(cv0, ${v3(cam.down)}) / cz + ${f(cam.height / 2)});
        float best = 1e9, s = 0.0;
        ${nearest}
        float d = best;                                   // px inside the outline

        // each mote's own path
        float dirS = rnd2.x < 0.35 ? -1.0 : 1.0;          // a third run the other way round
        float speed = mix(22.0, 170.0, rnd.y * rnd.y);    // px / s along the rim
        float cls = rnd.x;
        float travel = dirS * speed * clk;
        float dIn = d;
        float lift = 0.004;                               // m toward the viewer, so the motes sit over the bezel
        float coil = 0.0, coilR = 0.0;
        float aMul = 1.0, glowAmt = 0.0, scMul = 0.8;
        if (cls < 0.6) {
          // streamer: hugs the rim and breathes in and out of the outline
          dIn = d * (0.75 + 0.25 * sin(t * 1.3 + rnd.z * 6.28))
              - 3.0 * (0.5 + 0.5 * sin(t * (1.6 + rnd.z * 2.5) + rnd2.y * 6.28)) * smoothstep(0.0, 1.0, clk);
        } else if (cls < 0.88) {
          // orbiter: coils around the bezel edge as it travels
          travel *= 0.55;
          dIn = min(d, 3.0);
          coil = clk * (2.5 + rnd2.y * 5.5) * dirS + rnd.z * 6.2832;
          coilR = mix(0.003, 0.012, rnd2.z) * smoothstep(0.0, 1.2, clk);
          glowAmt = 0.6; scMul = 0.45; aMul = 0.85;
        } else {
          // ember: peels off the rim, drifts out toward you, fades, and comes back
          float k = fract(clk * (0.18 + rnd2.y * 0.3) + rnd.z);
          travel *= 0.25;
          dIn = mix(d, -(6.0 + 28.0 * rnd2.z), k * k);
          lift += k * (0.008 + 0.03 * rnd2.z);
          aMul = smoothstep(0.0, 0.12, k) * (1.0 - k) * (1.0 - k) * 1.4;
          glowAmt = 1.0; scMul = 0.4 * (1.0 - 0.6 * k);
        }

        float sp = mod(s + travel, ${PER});
        vec2 bp = vec2(0.0), nin = vec2(0.0, 1.0);
        ${walk}
        vec2 uv2 = bp + nin * dIn;
        // follow the surface round the rim: the case side sits deeper than the front bezel
        float cz2 = pm_rimDepth(sp) + clamp(cz - pm_rimDepth(s), -0.03, 0.03);
        vec3 outW = normalize(${v3(cam.right)} * -nin.x + ${v3(cam.down)} * -nin.y);
        vec3 toward = -${v3(cam.fwd)};
        vec3 pos = ${v3(cam.pos)} + cz2 * (${v3(cam.fwd)} + ((uv2.x - ${f(cam.width / 2)}) / ${f(cam.focal)}) * ${v3(cam.right)}
                                                     + ((uv2.y - ${f(cam.height / 2)}) / ${f(cam.focal)}) * ${v3(cam.down)});
        pos += (outW * cos(coil) + toward * sin(coil)) * coilR + toward * lift + ${i.off};

        // two comets chase each other round the rim (opposite ways), each trailing a fading tail
        float b1 = mod(mod(clk * 210.0, ${PER}) - sp, ${PER});
        float b2 = mod(sp - mod(${PER} * 0.5 - clk * 130.0, ${PER}), ${PER});
        float glint = exp(-b1 / 90.0) + 0.8 * exp(-b2 / 60.0);
        float tw = 0.75 + 0.25 * sin(t * (3.0 + rnd2.z * 7.0) + rnd.y * 40.0);

        vec3 G = ${v3(new THREE.Vector3(...glow))};
        vec3 rgb = ${i.gsplat}.rgba.rgb;
        // the bezel itself flows and catches the comets; the loose motes stay dim until a comet sweeps through
        float lit = mix(1.0, 0.3 + 1.7 * glint, glowAmt);
        rgb = mix(rgb, rgb * 0.4 + G * 0.7, glowAmt) * tw * lit + G * glint * mix(0.3, 0.6, glowAmt);
        rgb *= mix(${i.light}, 1.2, 0.7);
        float appear = clamp(${i.rim} * 1.8 - rnd2.z * 0.8, 0.0, 1.0);
        float a = ${i.gsplat}.rgba.a * appear * clamp(aMul, 0.0, 1.0) * mix(1.0, 0.08 + 0.92 * min(glint, 1.0), glowAmt);
        float offLen = length(${i.off});
        ${o.gsplat}.center = pos;
        ${o.gsplat}.scales = ${i.gsplat}.scales * scMul * (1.0 + 0.25 * offLen) * (1.0 + 0.5 * min(glint, 1.0) * glowAmt);
        ${o.gsplat}.rgba = vec4(rgb, a);
      `),
    });
    return { gsplat: d.apply({ gsplat, t: u.time, clock: u.clock, rim: u.rim, light: u.light, off: u.off }).gsplat };
  });
  return { uniforms: u, modifier, perimeter: per, segs };
}

/** Floating dust motes catching the window light. */
export function dustEffects() {
  const u = { time: dyno.dynoFloat(0), light: dyno.dynoFloat(1) };
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", light: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 rnd = pm_rand3(${i.gsplat}.index);
        float t = ${i.t};
        vec3 p = ${i.gsplat}.center;
        p += vec3(sin(t * (0.11 + rnd.x * 0.1) + rnd.y * 6.28) * 0.18,
                  sin(t * (0.07 + rnd.z * 0.08) + rnd.x * 6.28) * 0.12,
                  cos(t * (0.09 + rnd.y * 0.1) + rnd.z * 6.28) * 0.18);
        float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (0.8 + rnd.z * 2.0) + rnd.x * 30.0), 3.0);
        ${o.gsplat}.center = p;
        ${o.gsplat}.rgba = vec4(${i.gsplat}.rgba.rgb * ${i.light}, ${i.gsplat}.rgba.a * tw);
      `),
    });
    return { gsplat: d.apply({ gsplat, t: u.time, light: u.light }).gsplat };
  });
  return { uniforms: u, modifier };
}
