import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from 'workshop-spark';

const canvas = document.getElementById('room');
const status = document.getElementById('status');
const progress = document.getElementById('progress');
const loading = document.getElementById('loading');
const retryButton = document.getElementById('retry');
const hud = document.getElementById('hud');
const settings = document.getElementById('settings');
const qualitySelect = document.getElementById('quality');
const qualityHelp = document.getElementById('quality-help');
const activeSplats = document.getElementById('active-splats');
const walkStick = document.getElementById('walk-stick');
const stickThumb = document.getElementById('stick-thumb');
const fullscreen = document.getElementById('fullscreen');
const vrHelp = document.getElementById('vr-help');
const vrButton = document.getElementById('vr');
const resetButton = document.getElementById('reset');
const spawn = new THREE.Vector3(0.08, 0, 1.5);
const spawnYaw = 0;
const eyeHeight = 1.65;
const allSplats = 2_000_000;
const detailModes = {
  smooth: { desktop: 360_000, touch: 250_000, vr: 250_000, pixel: 1, cone: 110, edge: 145, falloff: 0.6, behind: 0.23, dpr: 1.1, xrScale: 0.8, foveation: 0.5 },
  balanced: { desktop: 680_000, touch: 500_000, vr: 500_000, pixel: 0.78, cone: 130, edge: 160, falloff: 0.78, behind: 0.28, dpr: 1.35, xrScale: 0.9, foveation: 0.25 },
  high: { desktop: 1_250_000, touch: 900_000, vr: 850_000, pixel: 0.55, cone: 145, edge: 175, falloff: 0.9, behind: 0.38, dpr: 1.65, xrScale: 1, foveation: 0 },
  full: { dpr: 1.5 },
};
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
const touchPreview = matchMedia('(pointer: coarse)');
const locationUrl = new URL(location.href);
const requestedDetail = locationUrl.searchParams.get('detail');
const availableDetails = new Set(Array.from(qualitySelect.options, option => option.value));
let detailName = availableDetails.has(requestedDetail) ? requestedDetail : 'balanced';
const fullDetail = detailName === 'full';
const number = new Intl.NumberFormat();
const keys = new Set();
const up = new THREE.Vector3(0, 1, 0);
const localHead = new THREE.Vector3();
const worldHead = new THREE.Vector3();
const heading = new THREE.Vector3();
const orientation = new THREE.Quaternion();
// Approximate the clear aisle and open floor between the benches in world metres.
const walkingAreas = [
  { minX: -0.18, maxX: 0.28, minZ: 0.40, maxZ: 2.50 },
  { minX: -0.30, maxX: 0.45, minZ: 0.05, maxZ: 0.65 },
  { minX: -1.6, maxX: 0.95, minZ: 0.05, maxZ: 0.21 },
  { minX: 0.06, maxX: 1.05, minZ: -0.68, maxZ: 0.19 },
];
let renderer;

function distanceToWalkingArea(x, z) {
  let distance = Infinity;
  for (const { minX, maxX, minZ, maxZ } of walkingAreas) {
    const dx = x - THREE.MathUtils.clamp(x, minX, maxX);
    const dz = z - THREE.MathUtils.clamp(z, minZ, maxZ);
    distance = Math.min(distance, dx * dx + dz * dz);
  }
  return distance;
}

function stick(source) {
  const axes = source?.gamepad?.axes ?? [];
  const offset = axes.length >= 4 ? 2 : 0;
  return [axes[offset] ?? 0, axes[offset + 1] ?? 0];
}

function makeInfoPanel() {
  const image = document.createElement('canvas');
  image.width = 1024;
  image.height = 480;
  const paint = image.getContext('2d');
  const map = new THREE.CanvasTexture(image);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.6375), material);
  board.visible = false;
  board.renderOrder = 100;
  return {
    board,
    update(target) {
      paint.fillStyle = '#2c241a';
      paint.fillRect(0, 0, image.width, image.height);
      paint.fillStyle = '#f2daa2';
      paint.font = '54px Georgia';
      paint.fillText('Finished Workshop', 52, 85);
      paint.fillStyle = '#fbf3df';
      paint.font = '32px sans-serif';
      [
        'Static Gaussian environment · LichtFeld Studio, iteration 600',
        'Source: splat_600.ply · 2,000,000 Gaussians',
        `Headset detail target: ${number.format(target)} Gaussians`,
        'Left stick: walk · right stick: 30° snap turn',
        'A/X: return to start · B/Y: close this card',
        'Stick movement follows the central aisle.',
      ].forEach((line, index) => paint.fillText(line, 52, 147 + index * 51));
      map.needsUpdate = true;
    },
  };
}

async function start() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1f1c18');
  const rig = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(63, 1, 0.035, 120);
  camera.rotation.order = 'YXZ';
  scene.add(rig);
  rig.add(camera);
  const spark = new SparkRenderer({ renderer, enableLod: !fullDetail, sortRadial: true });
  const { board: infoPanel, update: updateInfoPanel } = makeInfoPanel();
  scene.add(spark, infoPanel);

  let desktopPose;
  let alignHead = false;
  let turnReady = true;
  let resetReady = true;
  let infoReady = true;
  let drag;
  let walkingPointer;
  let previousTime;
  let statsAt = 0;
  const touchWalk = new THREE.Vector2();

  function resize() {
    if (renderer.xr.isPresenting) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio, detailModes[detailName].dpr));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }

  function applyDetail(immersive = false) {
    const mode = detailModes[detailName];
    if (fullDetail) {
      qualityHelp.textContent = 'All 2 million source Gaussians in flat view. Choose High or lower to enter VR.';
    } else {
      const preview = touchPreview.matches ? mode.touch : mode.desktop;
      Object.assign(spark, {
        lodSplatCount: immersive ? mode.vr : preview,
        lodRenderScale: mode.pixel,
        coneFov0: mode.cone,
        coneFov: mode.edge,
        coneFoveate: mode.falloff,
        behindFoveate: mode.behind,
      });
      if (!immersive) renderer.xr.setFramebufferScaleFactor(mode.xrScale);
      renderer.xr.setFoveation(mode.foveation);
      updateInfoPanel(mode.vr);
      const fullNote = availableDetails.has('full') ? ' Full detail reloads the room.' : '';
      qualityHelp.textContent = `${number.format(preview)} target in this view · ${number.format(mode.vr)} in VR.${fullNote}`;
    }
    resize();
  }

  function stopWalking(event) {
    if (event && event.pointerId !== walkingPointer) return;
    walkingPointer = undefined;
    touchWalk.set(0, 0);
    stickThumb.style.removeProperty('--stick-x');
    stickThumb.style.removeProperty('--stick-y');
  }

  function clearInput() {
    keys.clear();
    stopWalking();
    drag = undefined;
  }

  function resetDesktop() {
    clearInput();
    camera.position.copy(spawn).addScaledVector(up, eyeHeight);
    camera.rotation.set(0, spawnYaw, 0);
  }

  function walk(offset, head, yaw, x, z, distance) {
    const length = Math.max(1, Math.hypot(x, z));
    const dx = (x * Math.cos(yaw) + z * Math.sin(yaw)) * distance / length;
    const dz = (z * Math.cos(yaw) - x * Math.sin(yaw)) * distance / length;
    let { x: headX, z: headZ } = head;
    let boundaryDistance = distanceToWalkingArea(headX, headZ);
    const afterX = distanceToWalkingArea(headX + dx, headZ);
    if (afterX <= boundaryDistance) {
      offset.x += dx;
      headX += dx;
      boundaryDistance = afterX;
    }
    if (distanceToWalkingArea(headX, headZ + dz) <= boundaryDistance) offset.z += dz;
  }

  function updateVr(frame, dt) {
    const session = renderer.xr.getSession();
    const pose = frame?.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose || session.visibilityState === 'hidden') return;
    const { position, orientation: trackedRotation } = pose.transform;
    localHead.set(position.x, position.y, position.z);
    orientation.set(trackedRotation.x, trackedRotation.y, trackedRotation.z, trackedRotation.w);
    heading.set(0, 0, -1).applyQuaternion(orientation);
    const headYaw = Math.atan2(-heading.x, -heading.z);
    const sources = Array.from(session.inputSources);
    const left = sources.find(source => source.handedness === 'left');
    const right = sources.find(source => source.handedness === 'right');
    const resetPressed = sources.some(source => source.gamepad?.buttons[4]?.pressed);
    if (alignHead || (resetReady && resetPressed)) {
      rig.rotation.y = spawnYaw - headYaw;
      worldHead.copy(localHead).applyAxisAngle(up, rig.rotation.y);
      rig.position.set(spawn.x - worldHead.x, 0, spawn.z - worldHead.z);
      alignHead = false;
      infoPanel.visible = false;
    }
    resetReady = !resetPressed;

    worldHead.copy(localHead).applyAxisAngle(up, rig.rotation.y).add(rig.position);
    const [x, z] = stick(left);
    if (Math.hypot(x, z) > 0.2) walk(rig.position, worldHead, headYaw + rig.rotation.y, x, z, dt * 1.05);
    const [turnAxis] = stick(right);
    if (Math.abs(turnAxis) < 0.3) turnReady = true;
    if (turnReady && Math.abs(turnAxis) > 0.7) {
      worldHead.copy(localHead).applyAxisAngle(up, rig.rotation.y).add(rig.position);
      const turn = -Math.sign(turnAxis) * Math.PI / 6;
      rig.position.sub(worldHead).applyAxisAngle(up, turn).add(worldHead);
      rig.rotation.y += turn;
      turnReady = false;
    }
    const infoPressed = sources.some(source => source.gamepad?.buttons[5]?.pressed);
    if (infoReady && infoPressed) {
      infoPanel.visible = !infoPanel.visible;
      if (infoPanel.visible) {
        const yaw = headYaw + rig.rotation.y;
        worldHead.copy(localHead).applyAxisAngle(up, rig.rotation.y).add(rig.position);
        heading.set(0, -0.12, -1.4).applyAxisAngle(up, yaw);
        infoPanel.position.copy(worldHead).add(heading);
        infoPanel.rotation.y = yaw;
      }
    }
    infoReady = !infoPressed;
  }

  renderer.xr.addEventListener('sessionstart', () => {
    desktopPose = { position: camera.position.clone(), rotation: camera.rotation.clone() };
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    clearInput();
    alignHead = turnReady = resetReady = infoReady = true;
    applyDetail(true);
  });
  renderer.xr.addEventListener('sessionend', () => {
    rig.position.set(0, 0, 0);
    rig.rotation.y = 0;
    camera.position.copy(desktopPose.position);
    camera.rotation.copy(desktopPose.rotation);
    infoPanel.visible = false;
    vrButton.disabled = false;
    applyDetail();
  });

  addEventListener('resize', resize);
  touchPreview.addEventListener('change', () => applyDetail(renderer.xr.isPresenting));
  addEventListener('blur', clearInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInput();
  });
  addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]')) return;
    if (event.code === 'KeyR' && !renderer.xr.isPresenting) resetDesktop();
    if (!movementKeys.has(event.code) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    keys.add(event.code);
  });
  addEventListener('keyup', event => keys.delete(event.code));
  canvas.addEventListener('pointerdown', event => {
    if (drag || event.button !== 0) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId || renderer.xr.isPresenting) return;
    const sensitivity = event.pointerType === 'touch' ? 0.0045 : 0.003;
    camera.rotation.y -= (event.clientX - drag.x) * sensitivity;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - (event.clientY - drag.y) * sensitivity, -1.48, 1.48);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  canvas.addEventListener('lostpointercapture', event => {
    if (drag?.pointerId === event.pointerId) drag = undefined;
  });
  function updateWalkStick(event) {
    if (event.pointerId !== walkingPointer) return;
    const bounds = walkStick.getBoundingClientRect();
    const reach = bounds.width * 0.29;
    touchWalk.set(
      (event.clientX - bounds.left - bounds.width * 0.5) / reach,
      (event.clientY - bounds.top - bounds.height * 0.5) / reach,
    ).clampLength(0, 1);
    stickThumb.style.setProperty('--stick-x', `${touchWalk.x * reach}px`);
    stickThumb.style.setProperty('--stick-y', `${touchWalk.y * reach}px`);
    if (touchWalk.lengthSq() < 0.012) touchWalk.set(0, 0);
  }
  walkStick.addEventListener('pointerdown', event => {
    if (walkingPointer !== undefined || event.button !== 0) return;
    event.preventDefault();
    walkingPointer = event.pointerId;
    walkStick.setPointerCapture(event.pointerId);
    updateWalkStick(event);
  });
  walkStick.addEventListener('pointermove', updateWalkStick);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    walkStick.addEventListener(event, stopWalking);
  }
  settings.addEventListener('toggle', clearInput);
  resetButton.onclick = resetDesktop;
  qualitySelect.value = detailName;
  qualitySelect.onchange = () => {
    const next = qualitySelect.value;
    locationUrl.searchParams.set('detail', next);
    if (fullDetail || next === 'full') {
      location.assign(locationUrl);
      return;
    }
    detailName = next;
    history.replaceState(null, '', locationUrl);
    applyDetail();
  };
  if (document.fullscreenEnabled) {
    fullscreen.hidden = false;
    fullscreen.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) {
        fullscreen.hidden = true;
        console.warn('Fullscreen unavailable', error);
      }
    };
    document.addEventListener('fullscreenchange', () => {
      fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
      resize();
    });
  }
  applyDetail();
  resetDesktop();

  const room = new SplatMesh({
    url: new URL(fullDetail ? './workshop-full.spz' : './workshop.spz', import.meta.url).href,
    raycastable: false,
    onProgress: event => {
      if (event.lengthComputable && event.loaded < event.total) {
        progress.value = Math.floor(event.loaded * 100 / event.total);
        status.textContent = 'Downloading workshop…';
      } else {
        progress.removeAttribute('value');
        status.textContent = 'Opening workshop…';
      }
    },
  });
  await room.initialized;
  if (fullDetail ? room.packedSplats?.numSplats !== allSplats : !room.packedSplats?.lodSplats?.extra?.lodTree) {
    throw new Error('The chosen workshop asset is incomplete.');
  }
  room.rotation.x = Math.PI;
  scene.add(room);

  renderer.setAnimationLoop((time, frame) => {
    const dt = Math.min((time - (previousTime ?? time)) / 1000, 0.05);
    previousTime = time;
    if (renderer.xr.isPresenting) updateVr(frame, dt);
    else {
      const x = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      const z = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
      if (x || z || touchWalk.lengthSq()) {
        walk(camera.position, camera.position, camera.rotation.y, x + touchWalk.x, z + touchWalk.y, dt * 1.55);
      }
    }
    renderer.render(scene, camera);
    if (spark.activeSplats > 0 && !loading.hidden) {
      loading.hidden = true;
      hud.hidden = false;
      resetButton.disabled = false;
      if (!vrButton.hidden) vrButton.disabled = false;
    }
    if (settings.open && time - statsAt > 500) {
      activeSplats.textContent = `${number.format(spark.activeSplats)} Gaussians in the latest render.`;
      statsAt = time;
    }
  });

  if (fullDetail) return;
  let immersiveSupported = false;
  try {
    immersiveSupported = !!(isSecureContext && await navigator.xr?.isSessionSupported('immersive-vr'));
  } catch (error) {
    console.warn('WebXR availability check failed', error);
  }
  vrHelp.textContent = immersiveSupported
    ? 'In VR, use the left stick to walk, right stick to turn, A/X to reset and B/Y for room info.'
    : '';
  if (!immersiveSupported) return;
  vrButton.hidden = false;
  vrButton.disabled = !loading.hidden;
  vrButton.onclick = async () => {
    vrButton.disabled = true;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
      await renderer.xr.setSession(session);
    } catch (error) {
      await session?.end().catch(() => {});
      settings.open = true;
      vrHelp.textContent = `Could not enter VR. ${error.message}`;
      vrButton.disabled = false;
      return;
    }
    if (Array.from(session.supportedFrameRates ?? []).includes(72)) {
      session.updateTargetFrameRate?.(72).catch(error => console.warn('Headset kept its current frame rate', error));
    }
  };
}

function showError(error) {
  renderer?.setAnimationLoop(null);
  loading.hidden = false;
  hud.hidden = true;
  resetButton.disabled = true;
  vrButton.disabled = true;
  status.textContent = `Could not open the workshop. ${error.message}`;
  progress.hidden = true;
  retryButton.hidden = false;
  retryButton.textContent = fullDetail ? 'Open Balanced' : 'Reload workshop';
  retryButton.onclick = () => {
    if (fullDetail) {
      locationUrl.searchParams.set('detail', 'balanced');
      location.assign(locationUrl);
    } else location.reload();
  };
  console.error(error);
}

canvas.addEventListener('webglcontextlost', () => showError(new Error('The graphics session ended.')));
start().catch(showError);
