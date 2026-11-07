# Adding motions to the frog

The frog's Gaussian rest data, 22-bone Mixamo rig and learned skin weights can be reused for new motions. A new animation changes the bone transforms; it does not require another TripoSplat generation or another rig prediction.

The current idle/wave is authored for this rig. Arbitrary downloaded motions have not been retargeted or accepted yet.

## Practical import path

1. Start from a **copy** of the preserved rest-rig Blender scene. Keep the accepted rest and idle/wave scenes unchanged.
2. Import a compatible animation-only Mixamo FBX, or a BVH/FBX motion with a known humanoid skeleton. Record its source, selected clip and frame range.
3. Map the source joints to the frog's joints. Normalize namespace spelling for lookup: `mixamorig:Hips`, `mixamorigHips` and `Hips` may refer to the same semantic joint. Do not rename the accepted target rig or assume name equality corrects different bind axes.
4. Retarget through the **source and target rest poses**, accounting for bone orientation, body proportions and scale. The existing MIA scene uses a `0.01` armature world scale; keep local bone coordinates and scene units distinct.
5. Bake the result onto the frog's target pose bones as a separate named action. Inspect shoulders, elbow/wrist bends, hips/knees, feet, floor contact and the start/end of loops on the actual splats.
6. Export the new clip's target-bone transforms with the same bone order/rest transforms as the live character asset. Keep the Gaussian geometry and skin weights fixed. Add a clip entry to the player; choose looping or one-shot playback and blend transitions before skinning.

The target joint families are:

| Part | Target joints (each prefixed `mixamorig:`) |
|---|---|
| Body/head | `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head` |
| Each arm | `Left/RightShoulder`, `Left/RightArm`, `Left/RightForeArm`, `Left/RightHand` |
| Each leg | `Left/RightUpLeg`, `Left/RightLeg`, `Left/RightFoot`, `Left/RightToeBase` |

The frog has no individual finger, facial or toe-end bones. Drop those source tracks rather than creating unbound animation channels. This rig supports body/head motion; new finger or facial articulation needs additional deformation data.

## Export a baked clip

Run [`tools/export_frog_clip.py`](../tools/export_frog_clip.py) with the approved Python environment containing Blender's `bpy` 4.3, NumPy and SciPy. The utility reads a retargeted scene copy and the existing `rig.json`; it does not run inference, render, save the input scene or publish anything. Its output directory must be new.

From the repository root, this complete PowerShell example exports the existing accepted hello action into a new folder:

```powershell
$MiaPython = "$env:LOCALAPPDATA\Lustron-Runtimes\mia-frog-20261106-attempt1\venv311\Scripts\python.exe"
& $MiaPython tools/export_frog_clip.py `
  --blend 'D:\Lustron\experiments\ComfyUI\2026-11-06_triposplat-frog-mechanic_attempt1\rigging\animation-attempt1\frog-mechanic-idle-wave.blend' `
  --id hello --label 'Hello wave' --fps 24 --start 1 --end 96 `
  --out 'D:\Lustron\experiments\ComfyUI\2026-11-06_frog-mechanic-vr-live_attempt1\exports\hello-copy'
```

For a new retargeted motion, change `--blend`, `--id`, `--label`, `--start`, `--end` and the new output folder. Use `--action 'Exact baked action name'` when it is not the armature's active action. `--once` marks a one-shot such as sitting down; otherwise clips loop. `--in-place` removes only horizontal Three.js X/Z Hips travel from all bones consistently, preserving vertical motion. Do not enable it if the character is supposed to travel through the scene.

Defaults are the active action, the scene's inclusive frame range and 24fps. Sampling converts from the source scene's native frame rate. `--rig` defaults to this checkout's `viewer/studio/models/frog/rig.json`, independent of the working directory. `--max-seconds` defaults to a 120-second CPU limit.

The exporter validates every target rest matrix and parent against the existing bind rig. It rejects changed rest poses, nonfinite transforms, degenerate/reflected scale and shear that cannot fit the clip format. It does not silently regenerate a bind signature. Existing output paths are rejected rather than overwritten.

The two output files are `<id>.bin` and `<id>.json`. The binary is frame-major, then bone-major, little-endian float32: position XYZ, quaternion XYZW, scale XYZ. These are **target skin transforms** (posed target transform multiplied by inverse bind transform), in the same fixed bone order and Y-up coordinates as the live rig. The JSON includes the exact existing bind signature, clip duration/loop metadata, input hashes and validation results.

After checking the new clip on the actual splats, copy its two files into `viewer/studio/models/frog/` and add its JSON metadata as a clip entry in `rig.json`. Preserve the existing entries and avoid reusing clip IDs. Build and publish the site through the usual repository workflow. The utility deliberately does not do those steps automatically.

The accepted hello export was tested at 96 frames × 22 bones × 10 floats: **84,480 bytes**, with maximum absolute difference **0.0** from the current live `hello.bin`. That verifies the exporter against this accepted clip; an arbitrary incoming motion still needs retargeting and visual acceptance.

## Root motion

For a stationary gallery character, keep the actor's scene position fixed and remove horizontal travel from locomotion clips after retargeting. Preserve vertical pelvis motion and foot contact. For a character that walks through the room, let an explicit scene/collision controller own the path and match the clip's gait speed to travel speed.

Do not blindly use `inplace=True` for a sit-down or kneeling action. The bundled retargeter's in-place operation compensates endpoint drift on pose-bone location curves and is intended for cyclic walk/run motions; it can remove meaningful noncyclic displacement.

## Existing tooling

The Comfy wrapper accepts one or more Mixamo FBX paths in `animation_file`, separated by newlines. Its MIA path can retarget and bake motions. For this already accepted character, reuse the saved rig instead of rerunning rig inference for every clip.

The patched `load_mixamo_anim()` helper removes actions outside its imported set and removes imported source objects in memory. Use an isolated scene copy and preserve/export accepted actions separately before calling it. Do not call it directly on the only accepted multi-action scene.

Three.js also provides animation playback and fades through [`AnimationMixer`](https://threejs.org/docs/pages/AnimationMixer.html) and [`AnimationAction`](https://threejs.org/docs/pages/AnimationAction.html). These play clips already mapped to the target; they do not make an unrelated skeleton compatible automatically.

Implementation references: [MIA Gaussian-capable version](https://github.com/jasongzy/Make-It-Animatable/tree/8fb51382ff6da556cdb95cc03a48200603f3a493), [wrapper node inputs](https://github.com/speige/ComfyUI_Make-It-Animatable/blob/486409c0843b66bd548a787516f0f987effe9aa1/nodes.py), [wrapper animation patch](https://github.com/speige/ComfyUI_Make-It-Animatable/blob/486409c0843b66bd548a787516f0f987effe9aa1/patches/04_blender_utils_py.patch).
