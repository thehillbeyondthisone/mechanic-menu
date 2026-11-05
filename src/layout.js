// Where the menu signs live in the room. Content space: eye at (0, 1.6, 0) looking down -z, metres.
// The room frame (src/room-frame.js, from scripts/make_room_shell.py) corrects the reconstruction's
// unequal x/y focal lengths, levels it from the ceiling and sets scale from a 1.4 m handheld eye.
// Surfaces were first fitted to the BLUNT depth map in the v0.4 frame (uniform 3x, unlevelled) on
// 2026-11-05; those measurements are kept as-is and mapped into the corrected frame:
//   left poster wall: plane rms 0.017 above 2.0 (v0.4 units); below ~1.95 the CRT and papers sit in front.
//   Clear spans were re-checked against splat footprints (centre + 1.5x largest scale, opacity > 0.25).
//   counter top under the desk sign: median 1.44.   ceiling above the hanging sign: 3.14.
import { fromLegacy, normalFromLegacy, CEILING_Y } from './room-frame.js';

export const EYE = [0, 1.6, 0];
const V04 = {hang: [0.05, 2, -3.0], desk: [0.08, 1.44, -2.25],
  wall: {point: [-1.06, 2.8, -3.12], normal: [0.65, -0.01, 0.76], left: -1.16, cornerX: -0.64, clearBelow: 1.98}};
// A point on the v0.4 wall plane at v0.4 (x, y).
function v04Wall(x, y) {
  const [px, py, pz] = V04.wall.point, [a, b, c] = V04.wall.normal;
  return [x, y, pz - (a * (x - px) + b * (y - py)) / c];
}
const hang = fromLegacy(V04.hang), desk = fromLegacy(V04.desk);
export const ROOM = {
  ceilingY: CEILING_Y,
  hang: {x: hang[0], z: hang[2]},
  desk: {x: desk[0], y: desk[1], z: desk[2]},
  wall: {point: fromLegacy(V04.wall.point), normal: normalFromLegacy(V04.wall.normal),
    left: fromLegacy(v04Wall(V04.wall.left, 2.2))[0], cornerX: fromLegacy(v04Wall(V04.wall.cornerX, 2.2))[0],
    clearBelow: fromLegacy(v04Wall(V04.wall.left, V04.wall.clearBelow))[1]},
};
// Height on the wall, in this frame, of a line measured at v0.4 height y at the list's left edge.
const wallHeight = y => fromLegacy(v04Wall(V04.wall.left, y))[1];
// Letter backs sit this far in front of the fitted wall plane. Poster boards bulge out of the
// fitted plane; a splat-footprint occlusion test showed 4.5 cm let them cover the top lines, 8 cm clears them.
export const STANDOFF = 0.08;

const DEG = 180 / Math.PI;
const n = ROOM.wall.normal;
const flat = Math.hypot(n[0], n[2]);
export const WALL_TANGENT = [n[2] / flat, 0, -n[0] / flat]; // runs left to right along the wall
export const WALL_YAW = Math.atan2(n[0], n[2]) * DEG;
// The list starts 3 cm further left along the wall than v0.4 so the longest line clears the corner;
// scripts/check_wall_occlusion_frame.py shows every line still unoccluded there (2026-11-05).
ROOM.wall.left -= 0.03 * WALL_TANGENT[0];

export function wallPoint(x, y, offset = 0) {
  const [px, py, pz] = ROOM.wall.point;
  const z = pz - (n[0] * (x - px) + n[1] * (y - py)) / n[2];
  return [x + offset * n[0], y + offset * n[1], z + offset * n[2]];
}
// Yaw that turns a sign's +z face toward the eye.
export const faceYaw = (x, z) => Math.atan2(EYE[0] - x, EYE[2] - z) * DEG;

// Letter heights in metres, chosen for headset legibility at each distance (all >= 1.3 degrees).
const SIZE = {hero: 0.27, title: 0.17, desk: 0.13, wall: 0.14, list: 0.088};
// The occlusion check cleared v0.4 heights 2.03-2.36 on the wall, which map to about 2.06-2.49 here.
// Lines stack down from the top; the headset's taller view adds the EXIT VR line.
const LIST_STEP = 0.125, listTop = xr => xr ? 2.49 : 2.36;

/**
 * Pure layout for one menu view. `measure(text)` returns the baked {width, height, depth} in em.
 * Each sign: text, action (null = label), style, slot, scale, world centre, yaw and, for hanging
 * signs, the ceiling pivot. `normal` is the direction the sign faces.
 */
export function signsFor(view, {sound = false, quality = 'balanced', xr = false} = {}, measure) {
  const specs = [];
  const add = (text, action, style, slot, size, extra = {}) => specs.push({text, action, style, slot, size, ...extra});
  if (view === 'menu') {
    add('START', 'start', 'action', 'hang', SIZE.hero);
    add('CONTINUE', 'continue', 'action', 'desk', SIZE.desk);
    add('SETTINGS', 'settings', 'action', 'wall', SIZE.wall, {y: wallHeight(2.14)});
  } else if (view === 'settings') {
    add('SETTINGS', null, 'label', 'hang', SIZE.title);
    const items = [[sound ? 'SOUND ON' : 'SOUND OFF', 'sound'], [`QUALITY ${quality.toUpperCase()}`, 'quality'], ['RECENTER', 'recenter']];
    if (xr) items.push(['EXIT VR', 'exit-vr']);
    items.forEach(([text, action], index) => add(text, action, 'action', 'wall', SIZE.list, {y: listTop(xr) - index * LIST_STEP}));
    add('BACK', 'back', 'action', 'desk', SIZE.desk);
  } else {
    add(view === 'start' ? 'DEMO ONLY' : 'NO SAVED GAME', null, 'label', 'hang', SIZE.title);
    add('BACK', 'back', 'action', 'desk', SIZE.desk);
  }
  return specs.map(spec => place(spec, measure(spec.text)));
}

function place(spec, data) {
  const scale = spec.size / data.height;
  const width = data.width * scale, depth = data.depth * scale;
  if (spec.slot === 'hang') {
    const {x, z} = ROOM.hang;
    const y = spec.action ? 1.99 : 2.05;
    // Turned 12 degrees so the lit left-hand returns show the letters' depth.
    return {...spec, scale, width, depth, position: [x, y, z], pivot: [x, ROOM.ceilingY, z], yaw: faceYaw(x, z) + 12};
  }
  if (spec.slot === 'desk') {
    const {x, y, z} = ROOM.desk;
    // Sunk 4 mm so the letters read as standing on the counter, not hovering.
    return {...spec, scale, width, depth, position: [x, y + spec.size / 2 - 0.004, z], yaw: faceYaw(x, z) - 10};
  }
  // Wall: left-aligned like a directory sign, starting at the same left edge for every line.
  const start = wallPoint(ROOM.wall.left, spec.y, STANDOFF + depth / 2);
  const position = start.map((value, axis) => value + WALL_TANGENT[axis] * width / 2);
  return {...spec, scale, width, depth, position, yaw: WALL_YAW, normal: ROOM.wall.normal};
}

// How much to dim the room behind the menu (1 = full dim). START opens the room to look around.
export const dimFor = view => view === 'start' ? 0 : 1;
