import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { toCreasedNormals, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const WORDS = ['START', 'CONTINUE', 'SETTINGS', 'BACK', 'SOUND OFF', 'SOUND ON', 'QUALITY BALANCED', 'QUALITY PERFORMANCE', 'QUALITY DETAIL', 'RECENTER', 'EXIT VR', 'DEMO ONLY', 'NO SAVED GAME'];
// Sign-letter proportions in em units: deep returns and a rounded bevel that catches light.
export const LETTER = {size: 1, depth: 0.1, curveSegments: 8, steps: 1, bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.014, bevelSegments: 3};

// Group 0 is the front/back caps, group 1 the returns and bevels.
function group(flat, materialIndex) {
  const positions = [];
  for (const part of flat.groups.filter(part => part.materialIndex === materialIndex)) {
    for (let i = part.start * 3; i < (part.start + part.count) * 3; i++) positions.push(flat.attributes.position.array[i]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}
const base64 = typed => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
// Indexed little-endian Float32 positions/normals and Uint32 indices, base64 in JSON.
function pack(part) {
  const indexed = mergeVertices(part, 1e-5);
  const result = {
    vertices: indexed.attributes.position.count,
    positions: base64(new Float32Array(indexed.attributes.position.array)),
    normals: base64(new Float32Array(indexed.attributes.normal.array)),
    indices: base64(new Uint32Array(indexed.index.array)),
  };
  indexed.dispose();
  return result;
}

export async function bakeType() {
  const font = new FontLoader().parse(JSON.parse(await readFile(resolve(root, 'design/anton.typeface.json'), 'utf8')));
  const output = {};
  for (const text of WORDS) {
    const geometry = new TextGeometry(text, {font, ...LETTER});
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    geometry.translate(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    // Caps stay flat so their long triangles shade evenly. Returns get creased normals:
    // the 30-degree bevel steps blend into a rounded edge, while 90-degree letter corners stay crisp.
    const caps = group(flat, 0); caps.computeVertexNormals();
    const sides = toCreasedNormals(group(flat, 1), 40 * Math.PI / 180);
    const parts = [caps, sides].map(pack);
    output[text] = { width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z, parts };
    for (const item of [geometry, flat, caps, sides]) item.dispose();
  }
  await mkdir(resolve(root, 'public/assets'), {recursive: true});
  await writeFile(resolve(root, 'public/assets/type-meshes.json'), JSON.stringify(output));
  await cp(resolve(root, 'design/ANTON-OFL.txt'), resolve(root, 'public/FONT-LICENSE.txt'));
  console.log(`Baked ${WORDS.length} extruded Anton sign-letter meshes locally.`);
  return output;
}
