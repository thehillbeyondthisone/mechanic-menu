# mechanic-menu

A game menu built into a Gaussian-splat repair office. START hangs from the ceiling, CONTINUE stands on the counter and SETTINGS is mounted on the poster wall. They're real 3D sign letters (Anton font, enamel faces on brass sides) that light up when you point at them, on desktop or in a Quest headset (WebXR).

- **Live menu:** https://thehillbeyondthisone.github.io/mechanic-menu/
- **Test page:** https://thehillbeyondthisone.github.io/mechanic-menu/test.html. It checks the browser, VR support and scene files, links each scene mode, and has a headset checklist you can copy out.

On a Quest, open either link in Quest Browser, wait for the room to load, then press **Enter VR**. Point a controller at a word and pull the trigger.

## What's in the scene

The office is a single-image reconstruction. One photo was lifted to 3D Gaussians with depth from Depth Anything 3. The photo covers only about 60 degrees of view. A room shell (floor, ceiling and walls fitted to the depth) surrounds the viewer, textured with the photo where it saw the room and a soft mirrored continuation beyond, so there's no empty space past the photo's edges. Everything outside the photo's view is invented, not measured.

`src/room-frame.js` corrects the reconstruction's unequal focal lengths to square pixels, levels the room from its ceiling, and sets scale from a 1.4 m handheld eye height. A CRT monitor in the scene comes out about 35 cm wide.

## Run locally

```bash
npm ci
npm run build
npm start
```

Open http://127.0.0.1:8840/. `npm test` runs the geometry, legibility, wall-clearance and room-enclosure checks.

For a Quest over USB (developer mode, USB debugging allowed), run `Start-Office.cmd` and then `Connect-Quest.cmd`. Plain-HTTP LAN addresses can't enter VR; GitHub Pages is HTTPS, so the live link works over Wi-Fi.

## Layout

| Path | What it does |
| --- | --- |
| `src/main.js` | PlayCanvas 2.23.3 app: scene, signs, picking, room dimming, WebXR |
| `src/layout.js` | Where each sign sits, fitted to the room's surfaces |
| `src/room-frame.js` | Generated room transform (from `scripts/make_room_shell.py`) |
| `scripts/bake-type.mjs` | Bakes the 3D letters with Three.js `TextGeometry` at build time |
| `scripts/make_room_shell.py` | Fits the room surfaces and bakes the shell texture (needs the source depth map, not included) |
| `public/assets/` | Scene (compressed PLY, full and 300K), letters, shell and reflection map |

Licences: the Anton font is under the SIL Open Font License (`public/FONT-LICENSE.txt`), and PlayCanvas is MIT.
