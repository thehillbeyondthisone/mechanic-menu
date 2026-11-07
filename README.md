# The Workshop: mechanic experience + Splat Studio

The entry page is a styled chooser for two bundled experiences:

- **The mechanic** at `mechanic/`: the original Patterson workshop.
- **Splat Studio** at `studio/`: five TripoSplat props and a live animated frog mechanic, with desktop walking and pickup, plus WebXR controller manipulation.

Both run from the same GitHub Pages site. No localhost service is required. The Studio renderer, controller code and all five PLYs are bundled; desktop/VR support still depends on the browser and hardware. The Studio performance tool prepares a downloadable JSON file because GitHub Pages has no write API. Physical Quest acceptance remains separate from desktop or simulated checks.

`viewer/menu.html`, `viewer/src/menu.css` and `viewer/src/menu.js` provide the landing page. The two destination links and the **1**/**2** keyboard shortcuts open the bundled routes. `tools/serve.py` serves the chooser at `/` and the original viewer at `/mechanic/`; `tools/make_site.py` builds the same routes for GitHub Pages. It retains the original viewer files and data.

The frog was generated with built-in ImageGen, converted by the native 65,536-Gaussian TripoSplat workflow, then rigged by MakeItAnimatableRigGS with 22 Mixamo bones. In Studio he is live 3D Gaussian geometry: Spark's native linear blend skinning transforms both centers and covariance on the GPU. The inference proxy mesh is hidden. Five props plus the frog total 393,216 Gaussians. The rest splats, four-influence skin weights and two 24fps bone clips total 4.38 MB. Only bone transforms update each frame, with interpolation and a short blend when switching clips.

Open **Splat Studio**, choose **Walk up to the mechanic**, then select **Hello wave** or **Relaxed idle**. Pause and scrub to inspect a pose. In Quest Browser choose **Enter VR**; use the left stick to approach him and the right stick to snap turn. He stands at the sixth station, separate from the five grabbable props. The viewer-pose collision calculation includes the locomotion rig and tracked headset position. Desktop controls and simulated two-eye WebXR approach/collision checks pass; physical Quest quality, comfort and performance remain untested.

See [Adding motions to the frog](docs/frog-animation-mapping.md) and [`tools/export_frog_clip.py`](tools/export_frog_clip.py) to reuse the accepted rest rig and skin weights with retargeted FBX/BVH actions. The exporter validates the bind rig and was checked against the accepted wave with zero binary transform difference. New source motions still need retargeting and visual review.

The chooser places the frog preview on the Studio card and Patterson's room photo on the workshop card. The preview's four-second, 24fps WebP is rendered from skinned Gaussian geometry, with a still for reduced-motion preferences. The editable rest and animated Blender scenes remain preserved in the canonical experiment. Gallery sources are copied from the preserved `2026-11-06_triposplat-gallery-quest3_prepare` experiment; all five original PLYs are unchanged. Vendor libraries remain pinned at Spark 2.4.0 / Three 0.180.0 for Studio, separately from the original Patterson versions below.

## Original Patterson experience

One photo (`source/patterson.jpg`, the original 1536×2048 file) lifted into a 3D Gaussian splat, presented as an interactive game menu. The menu typography is built from splats and placed on real surfaces in the room. Runs in desktop browsers and on Quest 3 (WebXR).

This is separate from `../single-photo-run` (the full reconstruction by another agent). Nothing there was changed.

## Open it

- **Online (desktop and Quest 3):** https://thehillbeyondthisone.github.io/mechanic-menu/. Open it in the Quest Browser and press ENTER VR, with no certificate step. Redeploy the `gh-pages` branch with `python -B tools/make_site.py <gh-pages checkout>`.
- **First time on a new machine:** run `npm install` in `viewer/` (installs Spark and three.js).
- **Desktop:** double-click `Open-Single-Image-Splat.bat`. It opens http://127.0.0.1:8765/
- **Quest 3:** with the server running, open the Quest Browser on the same Wi-Fi and go to the `quest 3:` address printed in the server window (currently `https://192.168.1.168:8766/`). Accept the certificate warning once (Advanced → Proceed), then press **ENTER VR**. If Windows Firewall asks about Python, allow it on private networks.
- **Hosted (desktop):** https://claude.ai/artifact/GGV2eT5KreGDa1QCoasvK2. It's private until shared from its Share menu. VR may not be offered inside claude.ai, so use the LAN address for the headset. Rebuild the hosted copy with `python -B tools/make_artifact.py <out_dir>`. That script splits the splat into base64 text parts, because the host only serves text and data files.
- Add `?tier=high` or `?tier=quest` to force a detail level. The Quest Browser picks `quest` automatically.

## Controls

| | Desktop | Phone / tablet | Quest 3 |
|---|---|---|---|
| Browse | mouse, ↑ ↓ / W S, gamepad d-pad | press and hold to highlight; drag to look around | point a controller (or hand), thumbstick up/down |
| Select | click, Enter, gamepad A | tap | trigger / pinch |
| Back | Esc, gamepad B | tap **< BACK** on the card | B / Y, or grip while a card is open |
| Recenter | n/a | n/a | grip |

On an upright phone the room fills the screen height and every menu item fits on first load; dragging pans sideways (the camera only turns, so the splat stays sharp). Sub-menu cards are held closer and centred on small screens so their lines are about 30 px apart. Phones start at up to 1.5× resolution and step down to 0.75× if the frame rate stays under about 28 fps.

## What's in the room

| Object | Menu item | Reaction |
|---|---|---|
| CRT monitor | **CONTINUE** (green phosphor, scanlines) | loading bar types out, shockwave, push-in |
| Red label-maker tape, top drawer | **NEW GAME** | room blows apart into dust and reassembles |
| Black tape, middle drawer | **LOAD GAME** | drawer slides open, a typed index card flies out |
| Blue tape, bottom drawer | **OPTIONS** | same card: flicker, depth of field, pointer light, quality |
| Yellow floor stencil | **QUIT** | room dissolves; "Thanks for stopping by"; select to return |
| Enamel sign on chains | title | swings when touched or clicked |

Always running: hovered objects get a warm light in the room, the drawers ease out under hover (the photographed drawer fronts actually move), the pointer acts as a flashlight with a soft ripple where it hits the room, the fluorescent tube flickers now and then, and dust drifts through the window light.

## Files

- `viewer/` is the app (`index.html`, `src/main.js`, `src/effects.js`, `src/typography.js`). It uses Spark 2.3.1 and three.js 0.180.0, installed locally in `viewer/node_modules`.
- `viewer/public/assets/patterson-high.spz` has 1,713,028 gaussians (17 MB). `patterson-quest.spz` has 454,382 gaussians (4.8 MB).
- `export/patterson-{high,quest}.ply` are standard 3DGS PLYs for game engines and editors. They are Y-up, in metres, with the floor at y = 0 and the photo camera at (0, 1.36, 0) looking toward −Z.
- `tools/depth.py` runs Depth Anything 3 BASE (Apache-2.0, reused read-only from the earlier BLUNT run on D:) with a mirrored second pass.
- `tools/build_splat.py` builds the splat from photo plus depth. `tools/serve.py` is the local HTTP/HTTPS server.

## How the splat is built

1. DA3 depth at 1512 px, averaged with a horizontally mirrored pass, then upsampled to the full photo.
2. Depth discontinuities are snapped to the near or far side, which removes floating "flying pixels".
3. Adaptive density: one gaussian per pixel where there's detail, and 2×2 or 4×4 cells on flat, plain surfaces.
4. Each gaussian is a surface-aligned disc sized to its pixel's footprint on the depth surface, so it reproduces the photo exactly from the original viewpoint and holds up at oblique angles.
5. A hidden background layer fills in behind every foreground edge, so leaning around objects shows plausible wall instead of black holes.
6. The edges of the photo fade into darkness.

Calibration (in `build_splat.py`): focal length 1250 px (79° vertical field of view). DA3's own camera estimate was inconsistent, so this came from its average guess and the visible ceiling-to-floor span. Scale is 2.4 m per depth unit, so the CRT bezel measures about 40 cm. The camera ends up 1.36 m above the floor, which fits a hand-held photo. Gravity comes from the wall and ceiling planes (about 8° downward pitch).

## Limits

- It's one photo. Anything the camera didn't see (behind objects, outside the frame) is filled in by guesswork. It looks best within about 0.5 m of the original viewpoint. VR recenters you onto that spot when you enter, and grip recenters again.
- Scale and focal length are estimates, not measurements.
- Quest 3 frame rate hasn't been measured on a headset yet. If it stutters, the quest tier is the lever (fewer gaussians, or a lower `frameBufferScaleFactor` in `main.js`).

## Rebuild

```bash
python -B tools/depth.py source/patterson.jpg build 1512   # with the DA3 env python
python -B tools/build_splat.py source/patterson.jpg build viewer/public/assets high
python -B tools/build_splat.py source/patterson.jpg build viewer/public/assets quest
```
