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

/** Uniforms + modifier for the photographed room. */
export function roomEffects(numDrawers) {
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
    drawers: [],
  };
  for (let k = 0; k < numDrawers; k++) {
    u.drawers.push({
      c: dyno.dynoVec3(new THREE.Vector3()), x: dyno.dynoVec3(new THREE.Vector3(1, 0, 0)),
      y: dyno.dynoVec3(new THREE.Vector3(0, 1, 0)), z: dyno.dynoVec3(new THREE.Vector3(0, 0, 1)),
      h: dyno.dynoVec3(new THREE.Vector3()), o: dyno.dynoFloat(0),
    });
  }

  const inTypes = {
    gsplat: dyno.Gsplat, t: "float", intro: "float", introO: "vec3", hover: "vec4", hoverC: "vec3",
    cursor: "vec4", pulse: "vec4", pulseC: "vec3", dissolve: "float", light: "float",
  };
  const inputs = {
    t: u.time, intro: u.intro, introO: u.introOrigin, hover: u.hover, hoverC: u.hoverColor,
    cursor: u.cursor, pulse: u.pulse, pulseC: u.pulseColor, dissolve: u.dissolve, light: u.light,
  };
  u.drawers.forEach((d, k) => {
    Object.assign(inTypes, { [`dc${k}`]: "vec3", [`dx${k}`]: "vec3", [`dy${k}`]: "vec3", [`dz${k}`]: "vec3", [`dh${k}`]: "vec3", [`do${k}`]: "float" });
    Object.assign(inputs, { [`dc${k}`]: d.c, [`dx${k}`]: d.x, [`dy${k}`]: d.y, [`dz${k}`]: d.z, [`dh${k}`]: d.h, [`do${k}`]: d.o });
  });

  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes,
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [HASH],
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
        return dyno.unindentLines(`
          ${o.gsplat} = ${i.gsplat};
          vec3 p = ${i.gsplat}.center;
          vec3 rgb = ${i.gsplat}.rgba.rgb;
          float a = ${i.gsplat}.rgba.a;
          vec3 sc = ${i.gsplat}.scales;
          vec3 rnd = pm_rand3(${i.gsplat}.index);
          float t = ${i.t};

          ${drawerCode}

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

          rgb *= ${i.light};
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
