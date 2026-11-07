import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

/** All displacement is visual. Collision uses simple mesh proxies. */
export function makeRoomFx() {
  const u = {
    t: dyno.dynoFloat(0), intro: dyno.dynoFloat(0), stationSkin:dyno.dynoFloat(0), stationDrawer:dyno.dynoFloat(0),
    scan: dyno.dynoVec4(new THREE.Vector4(0, 1, -1, 0)),
    pull: dyno.dynoVec4(new THREE.Vector4(0, 1, -1, 0)),
    repaired: dyno.dynoFloat(0), test: dyno.dynoFloat(0),
    drift: dyno.dynoFloat(0), echo: dyno.dynoFloat(0),
  };
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t:'float', intro:'float', scan:'vec4', pull:'vec4', repaired:'float', test:'float', drift:'float', echo:'float', stationSkin:'float', stationDrawer:'float' },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({inputs:i, outputs:o}) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        vec3 p = ${i.gsplat}.center;
        vec3 rgb = ${i.gsplat}.rgba.rgb;
        float a = ${i.gsplat}.rgba.a;
        float t = ${i.t};
        float seed = fract(sin(float(${i.gsplat}.index) * 12.9898) * 43758.5453);
        float unsteady = (1.0 - ${i.repaired});
        float band = exp(-pow(p.y - (1.2 + sin(t * .4) * .8), 2.0) / .018);
        p.z += sin(p.x * 21.0 + t * 2.0) * band * .008 * unsteady;
        vec3 sv = p - ${i.scan}.xyz;
        float spot = exp(-dot(sv,sv) / .75) * ${i.scan}.w;
        float contour = .5 + .5 * sin(p.z * 70.0 + t * 5.0);
        rgb += vec3(.08, .34, .19) * spot * contour;
        p += normalize(sv + vec3(.001)) * .018 * spot * sin(t*5.0 + seed*6.28);
        vec3 pv = p - ${i.pull}.xyz;
        float pull = exp(-dot(pv,pv) / 1.5) * ${i.pull}.w;
        p += vec3(sin(t*3.0 + p.y*8.0)*.025, .025, .08) * pull;
        rgb += vec3(.11, .14, .07) * pull;
        // Misalignment is visible in the scenery while the technician tunes.
        p.x += sin(p.y*7.0+t*2.5) * ${i.drift} * .018;
        p.z += sin(p.x*9.0-t*1.7) * ${i.drift} * .035;
        float echo = ${i.echo};
        p += normalize(p-vec3(0.,1.,-1.4)+vec3(.001))*sin(length(p)*13.0-t*12.0)*echo*.035;
        rgb += vec3(.07,.13,.07)*echo;
        // During the diagnostic the room briefly flattens toward the source view.
        float test = ${i.test};
        p.z = mix(p.z, -3.8, test * .55);
        rgb = mix(rgb, vec3(dot(rgb,vec3(.3,.59,.11))), test*.7);
        float reveal = smoothstep(seed*.25, .75 + seed*.25, ${i.intro});
        a *= reveal;
        p.y += (1.0 - reveal) * .1;
        // A small source-view matte prevents photographed clutter from
        // intersecting the authored front panel, including during deformation.
        float photoZ = max(.01, -p.z);
        vec2 apron = vec2(p.x, p.y-1.3633) * (.982 / photoZ);
        apron.y += 1.3633;
        if (p.z < -.1 && abs(apron.x) < .396 && apron.y > .850 && apron.y < .960) a = 0.;
        // Reserve only the new worktop's source-view footprint. The one-photo
        // backdrop contains inferred clutter in front of this foreground prop.
        // This is visual and disabled when original station appearances are used.
        if (${i.stationSkin} > .5 && p.z < -.1 && p.y < 1.3623) {
          float topRay = (.9825 - 1.3633) / (p.y - 1.3633);
          vec3 topHit = vec3(p.x * topRay, .9825, p.z * topRay);
          if (abs(topHit.x) < .432 && topHit.z > -1.472 && topHit.z < -.988) a = 0.;
          // The same photo contains a sign/board crossing the moving tray.
          // Reserve only its front panel and floor footprints, following travel.
          float travel = ${i.stationDrawer};
          vec2 drawerFront = vec2(p.x,p.y-1.3633) * ((-.965+travel)/p.z);
          drawerFront.y += 1.3633;
          if(abs(drawerFront.x)<.378 && drawerFront.y>.641 && drawerFront.y<.834) a=0.;
          float floorRay = (.650-1.3633)/(p.y-1.3633);
          vec3 floorHit = vec3(p.x*floorRay,.650,p.z*floorRay);
          if(abs(floorHit.x)<.353 && floorHit.z>(-1.386+travel) && floorHit.z<(-.992+travel)) a=0.;

        }

        ${o.gsplat}.center = p;
        ${o.gsplat}.rgba = vec4(rgb, a);
      `),
    });
    return { gsplat: d.apply({gsplat, ...u}).gsplat };
  });
  return { u, modifier };
}
