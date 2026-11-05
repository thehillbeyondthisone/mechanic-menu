# Repair Office - private spatial menu, v0.8.0

Start with [HANDOFF.md](HANDOFF.md) for a copyable new-session prompt, paths, user direction, design details and current limits. The project is stored on Harbinger independently of the chat. No off-machine backup has been verified, and nothing has been published or uploaded.

## Launch

Double-click `Start-Office.cmd`, then open the local URL printed by the server on Harbinger (normally **http://127.0.0.1:8840/**; a free port is chosen when occupied). Keep the server window open; close it or press Ctrl+C to stop. The runtime is already built in `dist/` and requires Node.js, not an internet connection. The server binds only to loopback by default.

## Current design and controls

The office fills the initial desktop frame. The menu is built into the room as physical sign letters (Anton, deep bevelled returns): START hangs from the ceiling on a raceway and cables, CONTINUE stands on the counter, SETTINGS is mounted on the left poster wall with a soft shadow. The settings list is a wall directory beside it, and BACK stands on the counter. Selectable words are ivory enamel on brass and light up amber when hovered or pointed at; red enamel words are labels only. The room dims while the menu is open and returns to full brightness on START. Add `?still` to the URL to turn off sign motion (reduced-motion settings do this too). There are no cards, title panels, slogans, sidebars, numbered labels, or duplicated visible HTML menus.

Sign positions are in `src/layout.js`, fitted to the reconstruction's depth map. To regenerate assets: `python scripts/ttf_to_typeface.py` (font conversion), `python scripts/make_room_env.py` (reflection map), then `npm run build`. Current evidence is `evidence/v04-verification.json` and `evidence/v04-*.jpg`.

Click a word, or point a Quest controller and pull the trigger. Drag for a small desktop look adjustment; R resets; Escape goes back. The small ? button shows help. Keyboard users can Tab to an accessible menu which becomes visible when focused. Enter VR appears when the browser reports an available immersive device.

Start opens the room with a DEMO ONLY label and BACK; it does not launch a real game. Continue shows NO SAVED GAME. Sound and render quality persist in this browser. Settings also offer recenter and, while immersed, Exit VR. No locomotion, automatic drift or teleportation is added.

The original is a finite single-image depth reconstruction, with no measured scale or unseen surfaces. Desktop framing crops into that view. XR keeps native headset projection and tracking; a physical Quest test is still required for stereo, field of view, comfort, selection and performance.

## Private Quest delivery

**2026-11-05: the USB route below works with the owner's Quest 3** (already in developer mode; project adb at `C:\Users\thefo\OneDrive\Desktop\Gaussian Splat\.tooling\android-sdk\platform-tools\adb.exe`). VR loads at 72 fps on the 300K scene with no errors; see `evidence/v04-verification.json`. Wireless HTTPS is still not set up.

With the headset plugged in and `Start-Office.cmd` running, double-click `Connect-Quest.cmd`: it forwards the port over USB and opens the page in Quest Browser. Run it again after re-plugging or waking the headset.

v0.6.0 surrounds the viewer with a room shell: the photo where it saw the room and a locally generated (SDXL inpainting) shop everywhere else (`python scripts/make_room_shell.py --surround <panorama>`, then `npm run build`); see HANDOFF.md. Generated areas are invented, not measured. v0.7.0 lifts those generated views into a second Gaussian splat (`scripts/lift_surround.py`), so the rest of the shop has depth; drag to look all round on desktop, `?flat` for the old painted shell. v0.8.0 sharpens the generated views (Real-ESRGAN, `scripts/sharpen_surround.py`) and trains them into one splat in LichtFeld Studio (`scripts/prepare_training.py`, MCMC strategy).

### Wireless (not set up)

**No trusted private HTTPS hostname/certificate is configured, so wireless delivery is unavailable.** A plain `http://192.168…` link is not a secure WebXR origin. An HTTPS page loading its scene over HTTP is not a solution either.

### Wireless, no public scene host

Use a domain you control with a browser-trusted certificate obtained by DNS validation, and private DNS that resolves that hostname to Harbinger's private address. DNS validation does not require exposing this server to the internet. Serve the whole `dist/` directory over that private HTTPS origin, either behind your existing trusted private reverse proxy or with this server:

```powershell
# Replace these with the actual private interface and certificate paths.
$env:HOST = '<Harbinger-private-IP>'
$env:PORT = '8840'
$env:TLS_CERT = 'C:\path\to\fullchain.pem'
$env:TLS_KEY = 'C:\path\to\privkey.pem'
npm start
```

Open `https://<certificate-hostname>:8840/` in Quest Browser on the same private network. Its certificate must validate normally on the headset, and DNS must resolve there too. Keep access limited to the private network through your existing network/firewall controls; do not add internet port forwarding. No certificate, trust store, DNS, firewall, or browser security setting was changed by this task. Do not bypass certificate errors or enable insecure-origin browser flags.

A private VPN HTTPS reverse proxy is another option if the headset already has authorized access to that private network. Tailscale Serve, when already configured, is private to its tailnet; Funnel is a public service and is outside this demo's scope.

### Localhost over USB, for an already configured development headset

If the Quest is already authorized for development and USB debugging with Harbinger, Chrome's `chrome://inspect/#devices` supports forwarding device `localhost:8840` to Harbinger `localhost:8840`. Or, with an existing Android SDK `adb` installation and the intended authorized device selected:

```text
adb -s <Quest-device-serial> reverse tcp:8840 tcp:8840
```

Then open **http://localhost:8840/** in Quest Browser. This is the browser's standard loopback secure-context exception, not an insecure-origin override. Traffic stays on the USB connection. Disconnect forwarding afterward with `adb -s <Quest-device-serial> reverse --remove tcp:8840`. No ADB tooling was installed and no device settings were enabled here. If the headset is not already configured for this, use the private HTTPS route or have the owner perform the device setup.

### Headset acceptance pass

Check: the room is upright in both eyes; initial placement works seated and standing; both controllers highlight/select all three cards; Start → Look around → Back works; settings and Exit VR respond; recenter preserves natural head tracking; text is readable; there are no uncomfortable jumps or sustained stutters. Try Balanced first, then Performance. Request is 72 Hz where supported, with a reduced XR framebuffer size; that is a target, not a measured Quest result. Use the displayed FPS as a first signal, then inspect actual headset timings if needed.

## Assets, build and evidence

The preserved original is `D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image\output\repair-office.ply` (3,144,197 splats; SHA-256 `c5751f34df70ab46d236ce825ded01d21004a2f2de776376c7eb3d93afeb1f9a`). Its local derivative is `public/assets/office.compressed.ply`: 300,000 splats, 4,885,044 bytes. Preparation used CPU merge decimation; the original was not overwritten.

PlayCanvas 2.23.3 renders the static splat, meshes and WebXR. Three.js 0.187.0 is used only at build time to bake extruded typography. The pinned font and its notice are in `design/`. `public/assets/type-meshes.json` contains actual caps, bevels, sides and normals. Font and engine notices are copied into the build. No external fonts or CDNs are used at runtime.

Run `npm ci` if dependencies are missing, `npm run build` to bake typography and bundle the static site, and `npm test` for geometry, ray, camera-framing and settings checks. `npm run prepare-scene` recreates the derivative on CPU and is unnecessary for menu edits.

Current quality-recovery evidence is in `evidence/v03-verification.json` and `evidence/v03-*.jpg`. The v02 files describe the degraded version. The earlier `evidence/verification.json`, `menu.jpg`, `settings.jpg`, `room-preview.jpg` and `v01-source/` are retained history from the rejected first design. Do not present them as current screenshots or tests.

For continuing work, read `HANDOFF.md`; for source changes start with `src/main.js`, `src/spatial.js` and `scripts/bake-type.mjs`.


## Quality recovery in v0.2.1

Desktop uses `public/assets/office-full.compressed.ply`: all 3,144,197 splats, 51,192,190 bytes (48.82 MiB), converted locally without decimation. The original camera origin is restored; desktop MSAA smooths geometry edges; typography uses a much thinner extrusion and lighter sides. A controlled full-vs-300K comparison recovered fine detail and removed much of the reduced file's grain. Full compressed PLY is quantized and remains a derivative; the original 213.8 MB PLY is preserved.

Use `npm run prepare-full` if the full derivative is missing. `/?scene=full` and `/?scene=reduced` provide the same-camera comparison; `&camera=legacy` selects the previous forward eye offset. Quest/Android still uses the reduced fallback by default until higher counts/LOD have been measured on hardware. Desktop performance and visual improvement are not a Quest acceptance test.
