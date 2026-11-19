import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from 'workshop-spark';

const canvas = document.getElementById('room');
const status = document.getElementById('status');
const vrHelp = document.getElementById('vr-help');
const vrButton = document.getElementById('vr');
const resetButton = document.getElementById('reset');
const spawn = new THREE.Vector3(0.08, 0, 1.5);
const spawnYaw = 0;
const eyeHeight = 1.65;
const desktopBudget = 360_000;
const vrBudget = 220_000;
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
    'Headset LOD target: 220,000 rendered Gaussians',
    'Left stick: walk · right stick: 30° snap turn',
    'A/X: return to start · B/Y: close this card',
    'Stick movement follows the central aisle.',
  ].forEach((line, index) => paint.fillText(line, 52, 147 + index * 51));
  const map = new THREE.CanvasTexture(image);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.6375), material);
  board.visible = false;
  board.renderOrder = 100;
  return board;
}

async function start() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(0.8);
  renderer.xr.setFoveation(0.5);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1f1c18');
  const rig = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(63, 1, 0.035, 120);
  camera.rotation.order = 'YXZ';
  scene.add(rig);
  rig.add(camera);
  const previewBudget = matchMedia('(pointer: coarse)').matches ? vrBudget : desktopBudget;
  const spark = new SparkRenderer({ renderer, lodSplatCount: previewBudget, sortRadial: true });
  const infoPanel = makeInfoPanel();
  scene.add(spark, infoPanel);

  let desktopPose;
  let alignHead = false;
  let turnReady = true;
  let resetReady = true;
  let infoReady = true;
  let drag;
  let previousTime;

  function resize() {
    if (renderer.xr.isPresenting) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }

  function resetDesktop() {
    keys.clear();
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
    keys.clear();
    alignHead = turnReady = resetReady = infoReady = true;
    spark.lodSplatCount = vrBudget;
  });
  renderer.xr.addEventListener('sessionend', () => {
    rig.position.set(0, 0, 0);
    rig.rotation.y = 0;
    camera.position.copy(desktopPose.position);
    camera.rotation.copy(desktopPose.rotation);
    spark.lodSplatCount = previewBudget;
    infoPanel.visible = false;
    vrButton.disabled = false;
    resize();
  });

  addEventListener('resize', resize);
  addEventListener('blur', () => keys.clear());
  addEventListener('keydown', event => {
    if (event.code === 'KeyR' && !renderer.xr.isPresenting) resetDesktop();
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) keys.add(event.code);
  });
  addEventListener('keyup', event => keys.delete(event.code));
  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!event.isPrimary || !drag || renderer.xr.isPresenting) return;
    camera.rotation.y -= (event.clientX - drag.x) * 0.003;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - (event.clientY - drag.y) * 0.003, -1.48, 1.48);
    drag = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('lostpointercapture', () => { drag = null; });
  resetButton.onclick = resetDesktop;
  resize();
  resetDesktop();

  const room = new SplatMesh({
    url: new URL('./workshop.spz', import.meta.url).href,
    raycastable: false,
    onProgress: event => {
      status.textContent = event.lengthComputable && event.loaded < event.total
        ? `Loading workshop… ${Math.floor(event.loaded * 100 / event.total)}%`
        : 'Opening workshop…';
    },
  });
  await room.initialized;
  if (!room.packedSplats?.lodSplats?.extra?.lodTree) throw new Error('Workshop LOD data is missing.');
  room.rotation.x = Math.PI;
  scene.add(room);

  status.textContent = '';
  resetButton.disabled = false;
  renderer.setAnimationLoop((time, frame) => {
    const dt = Math.min((time - (previousTime ?? time)) / 1000, 0.05);
    previousTime = time;
    if (renderer.xr.isPresenting) updateVr(frame, dt);
    else {
      const x = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      const z = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
      if (x || z) walk(camera.position, camera.position, camera.rotation.y, x, z, dt * 1.55);
    }
    renderer.render(scene, camera);
  });

  let immersiveSupported = false;
  try {
    immersiveSupported = !!(isSecureContext && await navigator.xr?.isSessionSupported('immersive-vr'));
  } catch (error) {
    console.warn('WebXR availability check failed', error);
  }
  vrHelp.textContent = immersiveSupported
    ? 'Left stick moves · right stick snap turns · A/X resets · B/Y shows room info'
    : 'Open the HTTPS page in Quest Browser to enter VR.';
  if (!immersiveSupported) return;
  vrButton.disabled = false;
  vrButton.onclick = async () => {
    vrButton.disabled = true;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
      await renderer.xr.setSession(session);
    } catch (error) {
      await session?.end().catch(() => {});
      vrHelp.textContent = `Could not enter VR. ${error.message}`;
      vrButton.disabled = false;
      return;
    }
    if (Array.from(session.supportedFrameRates ?? []).includes(72)) {
      session.updateTargetFrameRate?.(72).catch(error => console.warn('Headset kept its current frame rate', error));
    }
  };
}

start().catch(error => {
  renderer?.setAnimationLoop(null);
  status.textContent = `Could not open the workshop. ${error.message}`;
  console.error(error);
});
