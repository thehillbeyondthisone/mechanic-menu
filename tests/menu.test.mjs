import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { intersectBox, desktopFov } from '../src/spatial.js';
import { readSettings, cycleQuality } from '../src/menu-state.js';
import { signsFor, wallPoint, WALL_TANGENT, ROOM, EYE, dimFor } from '../src/layout.js';

const words = JSON.parse(await readFile(new URL('../public/assets/type-meshes.json', import.meta.url)));
const decode = (b64, Type) => { const bytes = Buffer.from(b64, 'base64'); return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT); };
const measure = text => words[text];
const views = [['menu', {}], ['settings', {}], ['settings', {xr: true, sound: true, quality: 'performance'}], ['start', {}], ['continue', {}]];

test('word selection volumes support front/side rays, parallel misses and rays starting inside', () => {
  const half = {x: 0.3, y: 0.06, z: 0.02};
  assert.equal(intersectBox({x: 0, y: 0, z: 1}, {x: 0, y: 0, z: -1}, half), 0.98);
  assert.equal(intersectBox({x: 1, y: 0, z: 0}, {x: -1, y: 0, z: 0}, half), 0.7);
  assert.equal(intersectBox({x: 0, y: 0.1, z: 1}, {x: 0, y: 0, z: -1}, half), null);
  assert.equal(intersectBox({x: 0, y: 0, z: -1}, {x: 0, y: 0, z: -1}, half), null);
  assert.equal(intersectBox({x: 0, y: 0, z: 0}, {x: 0, y: 0, z: 1}, half), 0.02);
});
test('wide desktop framing retains a 50 degree horizontal view; portrait remains bounded', () => {
  for (const aspect of [16/9, 21/9, 4/3]) {
    const vertical = desktopFov(aspect) * Math.PI / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect) * 180 / Math.PI;
    assert.ok(Math.abs(horizontal - 50) < 1e-8);
  }
  assert.equal(desktopFov(9/16), 56);
});
test('baked Anton sign letters are indexed, finite, deep and have smooth returns', () => {
  for (const text of ['START', 'CONTINUE', 'SETTINGS', 'QUALITY PERFORMANCE', 'NO SAVED GAME']) {
    const word = words[text];
    assert.ok(word.depth / word.height > 0.12 && word.depth / word.height < 0.2, `${text} depth ratio`);
    for (const part of word.parts) {
      const positions = decode(part.positions, Float32Array), normals = decode(part.normals, Float32Array), indices = decode(part.indices, Uint32Array);
      assert.equal(positions.length, part.vertices * 3);
      assert.equal(normals.length, positions.length);
      assert.ok(indices.length > 0 && indices.length % 3 === 0 && indices.every(i => i < part.vertices));
      assert.ok(positions.every(Number.isFinite) && normals.every(Number.isFinite));
      const zs = positions.filter((_, index) => index % 3 === 2);
      assert.ok(Math.max(...zs) - Math.min(...zs) > 0.12);
    }
    // Returns carry intermediate (bevel) normals, not only flat 0/90-degree ones.
    const sideNormals = decode(word.parts[1].normals, Float32Array);
    let rounded = 0;
    for (let i = 2; i < sideNormals.length; i += 3) if (Math.abs(sideNormals[i]) > 0.2 && Math.abs(sideNormals[i]) < 0.95) rounded++;
    assert.ok(rounded > 50, `${text} bevel normals`);
  }
});
test('every sign is legible and comfortable in a headset from the standing eye point', () => {
  for (const [view, options] of views) {
    for (const sign of signsFor(view, options, measure)) {
      const [x, y, z] = sign.position.map((value, axis) => value - EYE[axis]);
      const distance = Math.hypot(x, y, z);
      const angularHeight = 2 * Math.atan(sign.size / 2 / distance) * 180 / Math.PI;
      const yaw = Math.abs(Math.atan2(x, -z)) * 180 / Math.PI, pitch = Math.atan2(y, Math.hypot(x, z)) * 180 / Math.PI;
      assert.ok(distance > 1.5 && distance < 4, `${view} ${sign.text} distance ${distance}`);
      assert.ok(angularHeight >= 1.3, `${view} ${sign.text} angular height ${angularHeight}`);
      assert.ok(yaw < 25 && pitch > -15 && pitch < 15, `${view} ${sign.text} needs no head turn (${yaw}, ${pitch})`);
    }
  }
});
test('wall signs stay on the measured clear part of the poster wall', () => {
  for (const [view, options] of views) {
    for (const sign of signsFor(view, options, measure).filter(sign => sign.slot === 'wall')) {
      const plane = wallPoint(sign.position[0], sign.position[1]);
      const offset = sign.position.reduce((sum, value, axis) => sum + (value - plane[axis]) * ROOM.wall.normal[axis], 0);
      assert.ok(offset > sign.depth / 2 && offset < 0.1, `${sign.text} off the wall by ${offset}`);
      // Where the line's right end meets the wall plane must stop short of the corner.
      const rightOnWall = sign.position.map((value, axis) => value + WALL_TANGENT[axis] * sign.width / 2 - ROOM.wall.normal[axis] * offset);
      assert.ok(rightOnWall[0] < ROOM.wall.cornerX, `${sign.text} runs into the corner (${rightOnWall[0]})`);
      assert.ok(sign.position[1] - sign.size / 2 >= ROOM.wall.clearBelow, `${sign.text} hidden by the CRT`);
    }
  }
});
test('menu has one sign per surface; labels are not selectable; START opens the room', () => {
  assert.deepEqual(signsFor('menu', {}, measure).map(sign => [sign.text, sign.slot]), [['START', 'hang'], ['CONTINUE', 'desk'], ['SETTINGS', 'wall']]);
  assert.ok(signsFor('continue', {}, measure).some(sign => sign.text === 'NO SAVED GAME' && sign.action === null));
  assert.ok(signsFor('settings', {xr: true}, measure).some(sign => sign.action === 'exit-vr'));
  assert.ok(!signsFor('settings', {}, measure).some(sign => sign.action === 'exit-vr'));
  assert.equal(dimFor('start'), 0); assert.equal(dimFor('menu'), 1);
});
test('room shell encloses the viewer in every direction, with floor below and ceiling above', async () => {
  const shell = JSON.parse(await readFile(new URL('../public/assets/room-shell.json', import.meta.url)));
  const P = shell.positions, tris = shell.indices;
  assert.equal(shell.uvs.length, P.length);
  assert.ok(P.flat().every(Number.isFinite) && shell.uvs.flat().every(v => v >= 0 && v <= 1));
  // Cast rays from the eye over the whole sphere; every one must hit a shell triangle within 8 m.
  const sub = (a, b) => a.map((v, i) => v - b[i]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function hit(dir) {
    let best = Infinity;
    for (const [i, j, k] of tris) {
      const e1 = sub(P[j], P[i]), e2 = sub(P[k], P[i]), p = cross(dir, e2), det = dot(e1, p);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(EYE, P[i]), u = dot(s, p) / det, q = cross(s, e1), v = dot(dir, q) / det, t = dot(e2, q) / det;
      if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9 && t > 0) best = Math.min(best, t);
    }
    return best;
  }
  for (let pitch = -85; pitch <= 85; pitch += 17) for (let yaw = 0; yaw < 360; yaw += 15) {
    const a = pitch * Math.PI / 180, b = yaw * Math.PI / 180;
    const t = hit([Math.cos(a) * Math.sin(b), Math.sin(a), -Math.cos(a) * Math.cos(b)]);
    assert.ok(t > 0.3 && t < 8, `no shell at yaw ${yaw} pitch ${pitch} (${t})`);
  }
  const floor = hit([0, -1, 0]), ceiling = hit([0, 1, 0]);
  assert.ok(floor > 1.2 && floor < 1.7, `eye height ${floor}`);
  assert.ok(ceiling > 1.2 && ceiling < 2.6, `ceiling above eye ${ceiling}`);
});
test('settings recover from corrupt storage and unsupported quality values', () => {
  assert.deepEqual(readSettings({getItem: () => '{bad'}), {sound: false, quality: 'balanced'});
  assert.deepEqual(readSettings({getItem: () => {throw Error();}}), {sound: false, quality: 'balanced'});
  assert.deepEqual(readSettings({getItem: () => '{"sound":true,"quality":"ultra"}'}), {sound: true, quality: 'balanced'});
  assert.equal(cycleQuality(cycleQuality(cycleQuality('balanced'))), 'balanced');
});
