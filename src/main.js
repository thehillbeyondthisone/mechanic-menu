import * as pc from 'playcanvas';
import { QUALITY, readSettings, cycleQuality } from './menu-state.js';
import { intersectBox, desktopFov } from './spatial.js';
import { ROOM, STANDOFF, signsFor, dimFor } from './layout.js';
import { OFFICE, SHELL_REPORT } from './room-frame.js';

const $ = id => document.getElementById(id);
const canvas = $('scene');
const settings = readSettings(localStorage);
const review = new URLSearchParams(location.search);
const headsetBrowser = /Quest|Oculus|Android/i.test(navigator.userAgent);
const fullScene = review.get('scene') === 'full' || (review.get('scene') !== 'reduced' && !headsetBrowser);
const sceneCount = fullScene ? 3144197 : 300000;
const cameraZ = review.get('camera') === 'legacy' ? -0.45 : 0;
const withSurround = !review.has('flat');   // ?flat shows only the photo splat and the painted room shell
const reduceMotion = review.has('still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { ready: false, view: 'menu', hovered: null, fps: 0, xr: false, xrAvailable: false, lastAction: null, errors: [], settings, reflections: false, roomDim: 0 };
window.officeDemo = { state, version: '0.8.0', sceneCount, frame: SHELL_REPORT };
addEventListener('error', event => state.errors.push(event.message));
addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
$('retry').onclick = () => location.reload();
$('help-button').onclick = () => {
  $('help').hidden = !$('help').hidden;
  $('help-button').setAttribute('aria-expanded', String(!$('help').hidden));
};

// Sign finishes. Selectable words: ivory enamel faces on brass returns, lighting up amber on hover.
// Labels that only inform: signal-red enamel on steel. Colours are sRGB.
const FINISH = {
  action: {face: {color: [0.97, 0.93, 0.84], gloss: 0.74, glow: [1, 0.92, 0.78], idle: 0.06},
           side: {color: [0.8, 0.6, 0.3], metal: 1, gloss: 0.62},
           hover: {color: [1, 0.7, 0.32], glow: [1, 0.56, 0.16], intensity: 1.15}},
  label: {face: {color: [0.68, 0.09, 0.06], gloss: 0.78, glow: [1, 0.22, 0.12], idle: 0.08},
          side: {color: [0.62, 0.63, 0.66], metal: 1, gloss: 0.56}},
};
const ease = (from, to, rate, dt) => to + (from - to) * Math.exp(-rate * dt);
const flicker = t => t > 0.45 ? 1 : (Math.sin(Math.floor(t * 22) * 91.7) * 43758.5453 % 1 + 1) % 1 > 0.5 ? 1 : 0.12;

// Started after the constants above: the bundler turns top-level const into var.
try { await boot(); } catch (error) {
  console.error(error); state.errors.push(String(error));
  $('loading').hidden = true; $('fatal').hidden = false;
  $('fatal-message').textContent = `Office could not load: ${error.message || error}. Start the server with Start-Office.cmd and reopen the local address.`;
}

async function boot() {
  const app = new pc.Application(canvas, { graphicsDeviceOptions: {antialias: !headsetBrowser, alpha: false, powerPreference: 'high-performance'} });
  const device = app.graphicsDevice;
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW); app.setCanvasResolution(pc.RESOLUTION_AUTO);
  device.maxPixelRatio = QUALITY[settings.quality].pixelRatio;
  app.scene.ambientLight = new pc.Color(0.3, 0.3, 0.28);
  const rig = new pc.Entity('Stationary camera rig');
  const camera = new pc.Entity('Office camera');
  app.root.addChild(rig); rig.addChild(camera);
  camera.setLocalPosition(0, 1.6, cameraZ);
  camera.addComponent('camera', {clearColor: new pc.Color(0.16, 0.15, 0.12), fov: desktopFov(innerWidth / innerHeight), nearClip: 0.035, farClip: 40});
  // Contact shadows draw after the splat so they land on its wall and counter.
  const shadowLayer = new pc.Layer({name: 'Contact shadows'});
  const worldLayer = app.scene.layers.getLayerById(pc.LAYERID_WORLD);
  app.scene.layers.insertTransparent(shadowLayer, app.scene.layers.getTransparentIndex(worldLayer) + 1);
  // The reflection map lights the letters only; never draw it as a sky through gaps in the capture.
  // The room shell draws first, writes no depth, and so shows only where the splat has nothing.
  const shellLayer = new pc.Layer({name: 'Room shell'});
  app.scene.layers.insertOpaque(shellLayer, app.scene.layers.getOpaqueIndex(worldLayer));
  camera.camera.layers = camera.camera.layers.filter(id => id !== pc.LAYERID_SKYBOX).concat(shadowLayer.id, shellLayer.id);
  const content = new pc.Entity('Office anchor'); app.root.addChild(content);
  const office = new pc.Entity('Repair office splat'); content.addChild(office);
  // Corrected frame from scripts/make_room_shell.py: square-pixel shape, levelled, metric (1.4 m eye).
  office.setLocalRotation(new pc.Quat(...OFFICE.rotation)); office.setLocalScale(...OFFICE.scale); office.setLocalPosition(...OFFICE.position);
  // Generated views of the rest of the shop, lifted to Gaussians in room metres (scripts/lift_surround.py).
  const surround = new pc.Entity('Generated surround splat'); content.addChild(surround);
  // Key light from the ceiling strip light, slightly in front; soft fill from the viewer's left.
  const light = new pc.Entity('Strip light'); content.addChild(light);
  light.addComponent('light', {type: 'directional', color: new pc.Color(1, 0.97, 0.9), intensity: 0.9, castShadows: false});
  light.setLocalEulerAngles(40, -50, 0); // from the upper left, down and away from the viewer
  const fill = new pc.Entity('Letter fill'); content.addChild(fill);
  fill.addComponent('light', {type: 'point', color: new pc.Color(1, 0.95, 0.88), intensity: 0.7, range: 8, castShadows: false});
  fill.setLocalPosition(-0.8, 2.6, -0.6);
  const typeRoot = new pc.Entity('Room signs'); content.addChild(typeRoot);

  let audio;
  function beep() {
    if (!settings.sound) return;
    try {
      audio ||= new AudioContext(); audio.resume().catch(() => {});
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.frequency.setValueAtTime(560, audio.currentTime);
      gain.gain.setValueAtTime(0.025, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09);
      oscillator.start(); oscillator.stop(audio.currentTime + 0.1);
    } catch {}
  }
  function save() { try { localStorage.setItem('repair-office-settings', JSON.stringify(settings)); } catch {} }
  function toast(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 2500);
  }
  let yaw = 0, pitch = 0, xrNeedsRecenter = false, drag = null;
  function recenter() {
    drag = null;
    if (app.xr.active) {
      const position = camera.getPosition();
      const forward = camera.forward;
      const angle = Math.atan2(-forward.x, -forward.z) * pc.math.RAD_TO_DEG;
      const rotation = new pc.Quat().setFromEulerAngles(0, angle, 0);
      const offset = rotation.transformVector(new pc.Vec3(0, 1.6, cameraZ));
      content.setPosition(position.clone().sub(offset)); content.setRotation(rotation);
    } else {
      content.setPosition(0, 0, 0); content.setEulerAngles(0, 0, 0);
      rig.setPosition(0, 0, 0); rig.setEulerAngles(0, 0, 0);
      camera.setLocalPosition(0, 1.6, cameraZ); camera.setLocalEulerAngles(0, 0, 0);
      yaw = pitch = 0;
    }
  }
  function resize() {
    if (app.xr.active) return;
    camera.camera.fov = desktopFov(innerWidth / innerHeight); app.resizeCanvas();
  }
  addEventListener('resize', resize);
  const asset = new pc.Asset('Private office', 'gsplat', {url: fullScene ? './assets/office-full.compressed.ply' : './assets/office.compressed.ply'});
  app.assets.add(asset);
  asset.on('progress', (received, total) => {
    if (total) { $('progress').value = received / total * 100; $('load-message').textContent = `Loading office... ${Math.round(received / total * 100)}%`; }
  });
  // Optional: without it the flat room shell still surrounds the viewer.
  const surroundAsset = withSurround && new pc.Asset('Generated surround', 'gsplat', {url: fullScene ? './assets/surround-full.compressed.ply' : './assets/surround.compressed.ply'});
  const surroundLoaded = !surroundAsset ? Promise.resolve(false) : new Promise(resolve => {
    app.assets.add(surroundAsset);
    surroundAsset.once('load', () => resolve(true)); surroundAsset.once('error', error => {console.warn('Surround splat unavailable', error); resolve(false);});
    app.assets.load(surroundAsset);
  });
  app.start();
  const [baked, shellData, , , hasSurround] = await Promise.all([
    fetch('./assets/type-meshes.json').then(response => {if (!response.ok) throw Error('Missing 3D typography'); return response.json();}),
    roomShellData(),
    new Promise((resolve, reject) => {asset.once('load', resolve); asset.once('error', reject); app.assets.load(asset);}),
    roomReflections(),
    surroundLoaded,
  ]);
  office.addComponent('gsplat', {asset});
  if (hasSurround) surround.addComponent('gsplat', {asset: surroundAsset});
  const splatMaterial = dimmableSplats();
  const shellMaterial = roomShell(shellData);

  // Walls, floor and ceiling around the viewer, so the room continues beyond what the photo saw.
  async function roomShellData() {
    try {
      const [data, image] = await Promise.all([
        fetch('./assets/room-shell.json').then(response => {if (!response.ok) throw Error('missing room shell'); return response.json();}),
        new Promise((resolve, reject) => {const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = './assets/room-shell.jpg';}),
      ]);
      return {data, image};
    } catch (error) { console.warn('Room shell unavailable; the capture edge will show.', error); return null; }
  }
  function roomShell(loaded) {
    if (!loaded) return null;
    const {data, image} = loaded;
    const texture = new pc.Texture(device, {name: 'Room shell', width: image.width, height: image.height, format: pc.PIXELFORMAT_SRGBA8,
      mipmaps: true, flipY: false, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE});
    texture.setSource(image);
    const mesh = new pc.Mesh(device);
    mesh.setPositions(data.positions.flat()); mesh.setUvs(0, data.uvs.flat()); mesh.setIndices(data.indices.flat()); mesh.update();
    const shade = new pc.StandardMaterial();
    shade.useLighting = false; shade.useSkybox = false; shade.diffuse.set(0, 0, 0);
    shade.emissiveMap = texture; shade.emissive.set(1, 1, 1);
    shade.cull = pc.CULLFACE_NONE; shade.depthWrite = false; shade.depthTest = true; shade.update();
    const shell = new pc.Entity('Room shell'); content.addChild(shell);
    shell.addComponent('render', {meshInstances: [new pc.MeshInstance(mesh, shade)], layers: [shellLayer.id], castShadows: false, receiveShadows: false});
    return shade;
  }

  // Blurred reflection map of the room (built from the source photo) for the enamel and metal.
  async function roomReflections() {
    try {
      const image = new Image(); image.src = './assets/room-env.jpg'; await image.decode();
      const source = new pc.Texture(device, {name: 'Room reflections', width: image.width, height: image.height, format: pc.PIXELFORMAT_SRGBA8,
        projection: pc.TEXTUREPROJECTION_EQUIRECT, mipmaps: false, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_CLAMP_TO_EDGE});
      source.setSource(image);
      const lighting = pc.EnvLighting.generateLightingSource(source, {size: 64});
      app.scene.envAtlas = pc.EnvLighting.generateAtlas(lighting, {size: headsetBrowser ? 256 : 512});
      source.destroy(); lighting.destroy();
      state.reflections = true;
    } catch (error) { console.warn('Room reflections unavailable; letters fall back to direct light.', error); }
  }
  // Dim and desaturate the room per pixel in the splat shader itself, so it also works in the
  // headset (no screen-space pass). Uses the scene-wide unified splat material template.
  function dimmableSplats() {
    const material = app.scene.gsplat?.material;
    if (!material) { console.warn('Splat material unavailable; room dimming disabled.'); return null; }
    material.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('gsplatModifyPS', `
      uniform float uRoomDim;
      void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
        float grey = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = mix(color.rgb, vec3(grey), 0.1 * uRoomDim) * (1.0 - 0.15 * uRoomDim);
      }`);
    material.setParameter('uRoomDim', 0);
    material.update();
    return material;
  }

  const decode = (b64, Type) => new Type(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
  const meshCache = new Map();
  function meshes(text) {
    if (!meshCache.has(text)) {
      const data = baked[text]; if (!data) throw Error(`Unbaked word: ${text}`);
      const arrays = data.parts.map(part => ({positions: decode(part.positions, Float32Array), normals: decode(part.normals, Float32Array), indices: decode(part.indices, Uint32Array)}));
      const parts = arrays.map(part => {
        const mesh = new pc.Mesh(device);
        mesh.setPositions(part.positions); mesh.setNormals(part.normals); mesh.setIndices(part.indices); mesh.update();
        mesh.incRefCount(); // keep GPU geometry alive across menu rebuilds
        return mesh;
      });
      meshCache.set(text, {data, parts, caps: arrays[0], shadow: null});
    }
    return meshCache.get(text);
  }
  const measure = text => meshes(text).data;

  function material(finish) {
    const result = new pc.StandardMaterial();
    result.useMetalness = true;
    result.metalness = finish.metal || 0;
    result.gloss = finish.gloss;
    result.diffuse.set(...finish.color);
    if (finish.glow) { result.emissive.set(...finish.glow); result.emissiveIntensity = finish.idle; }
    // Normal depth testing: these are objects in the room, not overlays.
    result.depthTest = true; result.depthWrite = true; result.update();
    return result;
  }
  const hardware = {rail: material({color: [0.24, 0.22, 0.2], metal: 0.5, gloss: 0.5}), cable: material({color: [0.7, 0.7, 0.72], metal: 1, gloss: 0.7})};

  // Soft silhouette of the word, rasterised from its own front cap, for wall contact shadows.
  function silhouette(text) {
    const entry = meshes(text);
    if (entry.shadow) return entry.shadow;
    const {data, caps} = entry, pad = 0.3, ppu = 48;
    const w = Math.ceil((data.width + pad * 2) * ppu), h = Math.ceil((data.height + pad * 2) * ppu);
    const shape = document.createElement('canvas'); shape.width = w; shape.height = h;
    const context = shape.getContext('2d'); context.fillStyle = '#000'; context.beginPath();
    const {positions: p, indices} = caps;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      if (p[a + 2] < 0) continue; // front cap only; the back cap has opposite winding
      const x = v => (p[v] + data.width / 2 + pad) * ppu, y = v => (data.height / 2 + pad - p[v + 1]) * ppu;
      context.moveTo(x(a), y(a)); context.lineTo(x(b), y(b)); context.lineTo(x(c), y(c)); context.closePath();
    }
    context.fill();
    const soft = document.createElement('canvas'); soft.width = w; soft.height = h;
    const blurred = soft.getContext('2d'); blurred.filter = `blur(${Math.round(ppu * 0.07)}px)`; blurred.drawImage(shape, 0, 0);
    entry.shadow = {texture: canvasTexture(soft, `${text} shadow`), width: data.width + pad * 2, height: data.height + pad * 2};
    return entry.shadow;
  }
  let footprint;
  function footprintTexture() {
    if (footprint) return footprint;
    const soft = document.createElement('canvas'); soft.width = 256; soft.height = 64;
    const context = soft.getContext('2d'); context.filter = 'blur(9px)'; context.fillStyle = '#000';
    context.fillRect(22, 18, 212, 28);
    return footprint = canvasTexture(soft, 'Counter footprint');
  }
  function canvasTexture(source, name) {
    const texture = new pc.Texture(device, {name, width: source.width, height: source.height, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE});
    texture.setSource(source); return texture;
  }
  function shadowQuad(parent, texture, strength) {
    const shade = new pc.StandardMaterial();
    shade.useLighting = false; shade.useSkybox = false; shade.diffuse.set(0, 0, 0); shade.emissive.set(0, 0, 0);
    shade.opacityMap = texture; shade.opacityMapChannel = 'a'; shade.opacity = strength;
    shade.blendType = pc.BLEND_NORMAL; shade.depthWrite = false; shade.update();
    const quad = new pc.Entity('Contact shadow'); parent.addChild(quad);
    quad.addComponent('render', {type: 'plane', material: shade, layers: [shadowLayer.id], castShadows: false, receiveShadows: false});
    return {quad, shade};
  }

  const words = [];
  let shownAt = 0, clock = 0;
  function createSign(spec, index) {
    const {data, parts} = meshes(spec.text);
    const s = spec.scale, finish = FINISH[spec.style];
    const holder = new pc.Entity(`${spec.text} (${spec.slot})`); typeRoot.addChild(holder);
    let mount = holder, pivot = null;
    if (spec.slot === 'hang') {
      pivot = holder; pivot.setLocalPosition(...spec.pivot); pivot.setLocalEulerAngles(0, spec.yaw, 0);
      mount = new pc.Entity(spec.text); pivot.addChild(mount);
      mount.setLocalPosition(0, spec.position[1] - spec.pivot[1], 0);
    } else {
      mount.setLocalPosition(...spec.position); mount.setLocalEulerAngles(0, spec.yaw, 0);
    }
    mount.setLocalScale(s, s, s);
    const visual = new pc.Entity('Letters'); mount.addChild(visual);
    const face = material(finish.face), side = material(finish.side);
    visual.addComponent('render', {meshInstances: [new pc.MeshInstance(parts[0], face), new pc.MeshInstance(parts[1], side)], castShadows: false, receiveShadows: false});
    const sign = {...spec, text: spec.text, action: spec.action, entity: mount, mount, hanger: pivot, visual, materials: [face, side], finish, cables: [],
      delay: index * 0.14, hover: 0, glow: -1, data,
      half: {x: data.width / 2 + 0.05 / s, y: data.height / 2 + 0.04 / s, z: data.depth / 2 + 0.03 / s}};
    const box = (name, mat, position, size, parent = mount) => {
      const part = new pc.Entity(name); parent.addChild(part);
      part.addComponent('render', {type: name === 'Cable' ? 'cylinder' : 'box', material: mat, castShadows: false, receiveShadows: false});
      part.setLocalPosition(...position); part.setLocalScale(...size); return part;
    };
    if (spec.slot === 'hang') {
      // Dark raceway behind the letters, hung from the ceiling on two thin cables.
      const railZ = -data.depth / 2 - 0.02 / s;
      box('Raceway', hardware.rail, [0, 0, railZ], [data.width + 0.12 / s, data.height * 0.34, 0.035 / s]);
      sign.railTop = data.height * 0.17 * s;
      for (const end of [-1, 1]) sign.cables.push(box('Cable', hardware.cable, [end * (spec.width / 2 - 0.04), 0, railZ * s], [0.008, 1, 0.008], pivot));
    } else if (spec.slot === 'wall') {
      // The shadow lies just in front of the fitted wall plane, nudged down and right, away from the strip light.
      const {texture, width, height} = silhouette(spec.text);
      const {quad} = shadowQuad(mount, texture, 0.5);
      quad.setLocalPosition(0.3 * STANDOFF / s, -0.45 * STANDOFF / s, -data.depth / 2 - (STANDOFF - 0.012) / s);
      quad.setLocalEulerAngles(90, 0, 0); quad.setLocalScale(width, 1, height);
    } else {
      const {quad} = shadowQuad(mount, footprintTexture(), 0.55);
      quad.setLocalPosition(0, -data.height / 2 + 0.006 / s, -data.depth * 0.6);
      quad.setLocalScale(data.width * 1.12, 1, data.depth * 2.5 + 0.06 / s);
    }
    words.push(sign);
    return sign;
  }
  function clearWords() {
    state.hovered = null;
    for (const word of words) { word.materials.forEach(item => item.destroy()); (word.hanger || word.mount).destroy(); }
    words.length = 0;
  }

  let roomDimTarget = dimFor('menu'), firstShow = true;
  function show(view) {
    const animate = view !== state.view || !words.length;
    clearWords(); state.view = view;
    for (const [index, spec] of signsFor(view, {...settings, xr: app.xr.active}, measure).entries()) createSign(spec, index);
    // The first intro waits briefly so the room has drawn before the signs drop in.
    if (animate) shownAt = clock + (firstShow ? 0.8 : 0); else for (const word of words) word.delay = -10;
    firstShow = false;
    roomDimTarget = dimFor(view);
    const description = {
      menu: 'Start, Continue, Settings.',
      settings: 'Settings. Sound, render quality, recenter and back.',
      start: 'Demo only. No game is connected yet. The room is open to look around.',
      continue: 'No saved game exists. This is a menu prototype.',
    }[view];
    $('announcement').textContent = description;
    $('accessible-menu').replaceChildren(...words.filter(word => word.action).map(word => {
      const button = document.createElement('button'); button.textContent = word.text[0] + word.text.slice(1).toLowerCase();
      button.onclick = () => activate(word.action); return button;
    }));
  }
  function activate(action, source) {
    if (!state.ready) return;
    state.lastAction = action; beep();
    try { source?.inputSource?.gamepad?.hapticActuators?.[0]?.pulse(0.15, 35)?.catch?.(() => {}); } catch {}
    if (['start', 'continue', 'settings'].includes(action)) show(action);
    else if (action === 'back') show('menu');
    else if (action === 'sound') {settings.sound = !settings.sound; save(); show('settings'); if (settings.sound) beep();}
    else if (action === 'quality') {settings.quality = cycleQuality(settings.quality); save(); if (!app.xr.active) {device.maxPixelRatio = QUALITY[settings.quality].pixelRatio; resize();} show('settings');}
    else if (action === 'recenter') {recenter(); show('menu');}
    else if (action === 'exit-vr') app.xr.end();
  }
  function pick(origin, direction) {
    let best = null;
    for (const word of words) {
      if (!word.action || !word.mount.enabled) continue;
      const transform = word.mount.getWorldTransform();
      const inverse = transform.clone().invert();
      const start = inverse.transformPoint(origin);
      const forward = inverse.transformVector(direction).normalize();
      const t = intersectBox(start, forward, word.half);
      if (t === null) continue;
      const point = transform.transformPoint(start.clone().add(forward.mulScalar(t)));
      const distance = origin.distance(point);
      if (!best || distance < best.distance) best = {word, distance, point};
    }
    return best;
  }
  function hover(word) {
    state.hovered = word?.action || null;
    canvas.style.cursor = word ? 'pointer' : 'grab';
  }

  // Per-frame sign motion: hanging sign drops in and settles with a slow sway; wall and counter
  // letters pop out; every face "powers on" with a short tube flicker. Hover lights a sign amber.
  const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
  function animateSigns(dt) {
    for (const word of words) {
      const t = reduceMotion ? 10 : clock - shownAt - word.delay;
      (word.hanger || word.mount).enabled = t >= 0;
      if (t < 0) continue;
      const s = word.scale;
      word.hover = ease(word.hover, state.hovered === word.action && word.action ? 1 : 0, 14, dt);
      word.visual.setLocalPosition(0, 0, word.hover * 0.03 / s);
      if (word.slot === 'hang') {
        const drop = reduceMotion ? 0 : 0.3 * Math.exp(-4.5 * t) * Math.cos(7 * t);
        const swing = reduceMotion ? 0 : 0.35 * Math.sin(clock * 1.1) + 2.5 * Math.exp(-2.5 * t) * Math.sin(5.5 * t);
        const hangY = word.position[1] - word.pivot[1] + drop;
        word.mount.setLocalPosition(0, hangY, 0);
        word.hanger.setLocalEulerAngles(0, word.yaw, swing);
        const length = -hangY - word.railTop;
        for (const cable of word.cables) { cable.setLocalScale(0.008, length, 0.008); const p = cable.getLocalPosition(); cable.setLocalPosition(p.x, -length / 2, p.z); }
      } else {
        const pop = reduceMotion ? 1 : 1 - 0.14 * Math.exp(-7 * t) * Math.cos(9 * t);
        word.visual.setLocalScale(pop, pop, pop);
      }
      const power = reduceMotion ? 1 : flicker(t);
      const {face, hover: lit} = word.finish;
      const glow = (face.idle + (lit ? (lit.intensity - face.idle) * word.hover : 0)) * power;
      if (Math.abs(glow - word.glow) > 1e-3) {
        const [faceMaterial] = word.materials;
        faceMaterial.emissiveIntensity = glow;
        if (lit) { faceMaterial.emissive.set(...mix(face.glow, lit.glow, word.hover)); faceMaterial.diffuse.set(...mix(face.color, lit.color, word.hover)); }
        faceMaterial.update(); word.glow = glow;
      }
    }
    const dim = reduceMotion ? roomDimTarget : ease(state.roomDim, roomDimTarget, 3.5, dt);
    if (Math.abs(dim - state.roomDim) > 1e-4) {
      if (splatMaterial) { splatMaterial.setParameter('uRoomDim', dim); splatMaterial.update(); }
      if (shellMaterial) { const k = 1 - 0.15 * dim; shellMaterial.emissive.set(k, k * 0.98, k * 0.95); shellMaterial.update(); }
    }
    state.roomDim = Math.abs(dim - roomDimTarget) < 1e-3 ? roomDimTarget : dim;
  }

  function pointerRay(event) {
    const rect = canvas.getBoundingClientRect();
    const origin = camera.getPosition().clone();
    const far = camera.camera.screenToWorld((event.clientX - rect.left) * canvas.clientWidth / rect.width, (event.clientY - rect.top) * canvas.clientHeight / rect.height, 1);
    return {origin, direction: far.sub(origin).normalize()};
  }
  canvas.addEventListener('pointerdown', event => {if (app.xr.active) return; drag = {x: event.clientX, y: event.clientY, moved: 0}; canvas.focus(); canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove', event => {
    if (app.xr.active) return;
    if (drag && event.buttons === 0) drag = null;
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 5) {yaw = (yaw - dx * 0.15) % 360; pitch = pc.math.clamp(pitch - dy * 0.15, -80, 80); camera.setLocalEulerAngles(pitch, yaw, 0);}
      drag.x = event.clientX; drag.y = event.clientY;
    }
    const ray = pointerRay(event); hover(pick(ray.origin, ray.direction)?.word);
  });
  canvas.addEventListener('pointerup', event => {if (drag && drag.moved <= 5) {const ray = pointerRay(event); const hit = pick(ray.origin, ray.direction); if (hit) activate(hit.word.action);} drag = null;});
  canvas.addEventListener('pointercancel', () => drag = null);
  canvas.addEventListener('lostpointercapture', () => drag = null);
  addEventListener('blur', () => drag = null);
  canvas.addEventListener('pointerleave', () => {if (!drag) hover(null);});
  addEventListener('keydown', event => {if (event.key.toLowerCase() === 'r') recenter(); if (event.key === 'Escape') show('menu');});

  app.xr.input.on('add', source => source.on('select', () => {const hit = pick(source.getOrigin(), source.getDirection()); if (hit) activate(hit.word.action, source);}));
  function updateVR() {
    state.xrAvailable = !!app.xr.isAvailable(pc.XRTYPE_VR);
    $('enter-vr').hidden = !state.xrAvailable; $('enter-vr').disabled = !state.ready || !state.xrAvailable;
    $('xr-status').textContent = !isSecureContext ? 'VR needs trusted HTTPS or device localhost.' : state.xrAvailable ? 'VR available. Quality changes apply on next entry.' : 'No immersive headset detected in this browser.';
  }
  app.xr.on('available:immersive-vr', updateVR);
  app.xr.on('start', () => {state.xr = true; document.body.classList.add('xr-active'); xrNeedsRecenter = true; app.xr.updateTargetFrameRate(72, () => {}); if (state.view === 'settings') show('settings');});
  app.xr.on('end', () => {state.xr = false; document.body.classList.remove('xr-active'); device.maxPixelRatio = QUALITY[settings.quality].pixelRatio; recenter(); resize(); show('menu'); updateVR();});
  app.xr.on('error', error => {toast(`VR could not start: ${error.message}`); updateVR();});
  $('enter-vr').onclick = () => {
    if (!state.ready || !app.xr.isAvailable(pc.XRTYPE_VR)) return;
    const quality = QUALITY[settings.quality]; device.maxPixelRatio = devicePixelRatio;
    app.xr.start(camera.camera, pc.XRTYPE_VR, pc.XRSPACE_LOCALFLOOR, {framebufferScaleFactor: quality.framebufferScale, callback: error => {if (error) {device.maxPixelRatio = quality.pixelRatio; resize(); toast(`VR could not start: ${error.message}`);}}});
  };
  let sampleTime = 0, frames = 0;
  const rayColor = new pc.Color(1, 0.75, 0.36);
  app.on('update', dt => {
    clock += dt; sampleTime += dt; frames++;
    if (sampleTime >= 1) {state.fps = Math.round(frames / sampleTime); frames = sampleTime = 0; $('stats').textContent = `${sceneCount.toLocaleString()} splats / ${state.fps} fps / ${settings.quality}`;}
    if (app.xr.active) {
      if (xrNeedsRecenter && app.xr.views.list.length) {recenter(); xrNeedsRecenter = false;}
      let pointed = null;
      for (const source of app.xr.input.inputSources) {
        const origin = source.getOrigin(), direction = source.getDirection(); const hit = pick(origin, direction);
        if (hit) pointed = hit.word;
        const end = hit ? hit.point : origin.clone().add(direction.clone().mulScalar(3));
        app.drawLine(origin, end, rayColor, false);
        if (hit) {app.drawLine(end.clone().add(new pc.Vec3(-0.006, 0, 0)), end.clone().add(new pc.Vec3(0.006, 0, 0)), rayColor, false);}
      }
      hover(pointed);
    }
    animateSigns(dt);
  });
  state.ready = true; state.view = null; show('menu'); resize(); updateVR();
  await new Promise(resolve => app.once('postrender', resolve));
  document.body.dataset.ready = 'true'; document.body.dataset.splats = String(sceneCount); document.body.dataset.cameraZ = String(cameraZ); $('loading').hidden = true;
  Object.assign(window.officeDemo, {app, camera, office, content, words, pick, activate, recenter, ROOM, shell: !!shellMaterial});
}
