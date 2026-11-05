import { build } from 'esbuild';
import { mkdir, cp, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bakeType } from './bake-type.mjs';

const root = resolve(import.meta.dirname, '..');
await bakeType();
await mkdir(resolve(root, 'dist'), { recursive: true });
await cp(resolve(root, 'public'), resolve(root, 'dist'), { recursive: true });
await cp(resolve(root, 'node_modules/playcanvas/LICENSE'), resolve(root, 'dist/PLAYCANVAS-LICENSE.txt'));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.js'], bundle: true, minify: true, sourcemap: true,
  format: 'esm', target: 'es2022', outfile: 'dist/app.js', metafile: true,
});
await mkdir(resolve(root, 'evidence'), { recursive: true });
const scene = await stat(resolve(root, 'dist/assets/office.compressed.ply'));
const fullScene = await stat(resolve(root, 'dist/assets/office-full.compressed.ply'));
await writeFile(resolve(root, 'evidence/build.json'), JSON.stringify({
  completed: new Date().toISOString(), sceneBytes: fullScene.size, reducedSceneBytes: scene.size,
  entry: 'dist/index.html', outputs: result.metafile.outputs,
}, null, 2));
console.log(`Built demo. Full desktop ${(fullScene.size / 1048576).toFixed(2)} MiB; reduced ${(scene.size / 1048576).toFixed(2)} MiB. No upload performed.`);
