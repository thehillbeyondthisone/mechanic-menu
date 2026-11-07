"""Export a baked action for the existing live frog without changing its rig.

Run with the approved Python environment containing bpy 4.3, NumPy and SciPy.
The .blend and rig.json are read-only inputs. No renderer, inference, installation,
source-scene save or publication is performed.
"""
import argparse
import hashlib
import json
import math
import re
import time
from pathlib import Path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blend", type=Path, required=True, help="Retargeted copy containing the unchanged frog rest rig")
    parser.add_argument("--rig", type=Path, default=Path(__file__).resolve().parents[1] / "viewer/studio/models/frog/rig.json")
    parser.add_argument("--out", "--output", dest="output", type=Path, required=True, help="New output directory; existing paths are rejected")
    parser.add_argument("--id", required=True, help="Clip identifier: lowercase letters, digits, underscore or hyphen")
    parser.add_argument("--label", required=True)
    parser.add_argument("--action", help="Exact baked Blender action name; default is the target armature's active action")
    parser.add_argument("--fps", type=float, default=24)
    parser.add_argument("--start", type=float, help="First source frame; default is scene.frame_start")
    parser.add_argument("--end", type=float, help="Last source frame, inclusive; default is scene.frame_end")
    parser.add_argument("--once", action="store_true", help="Mark the clip as one-shot rather than looping")
    parser.add_argument("--in-place", action="store_true", help="Remove horizontal Hips travel from every bone; preserve vertical motion")
    parser.add_argument("--max-seconds", type=float, default=120, help="CPU export time limit, default 120 seconds")
    return parser.parse_args()


def export(args):
    started = time.monotonic()
    try:
        import bpy
        import numpy as np
        from scipy.spatial.transform import Rotation
    except ImportError as error:
        raise RuntimeError("Use a Python environment containing bpy 4.3, NumPy and SciPy; this tool does not install dependencies") from error

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", args.id):
        raise ValueError("--id must be a safe lowercase clip identifier")
    if not args.label.strip():
        raise ValueError("--label cannot be empty")
    if not math.isfinite(args.fps) or not 0 < args.fps <= 240:
        raise ValueError("--fps must be greater than zero and at most 240")
    if not math.isfinite(args.max_seconds) or args.max_seconds <= 0:
        raise ValueError("--max-seconds must be positive")
    source, rig_path, output = args.blend.resolve(), args.rig.resolve(), args.output.resolve()
    if not source.is_file() or source.suffix.lower() != ".blend":
        raise ValueError("--blend must name an existing .blend file")
    if output.exists():
        raise FileExistsError(f"Keep existing export: {output}")
    rig = json.loads(rig_path.read_text(encoding="utf-8-sig"))
    if rig.get("schema") != "frog-gaussian-rig/1":
        raise ValueError("Unsupported rig schema")
    bones = rig["bones"]
    names = [bone["name"] for bone in bones]
    if len(names) != rig["numBones"] or len(names) != 22 or len(set(names)) != len(names):
        raise ValueError("Expected the unique 22-bone frog target skeleton")
    reference_rest = np.asarray([bone["restMatrix"] for bone in bones], dtype=np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    if not np.isfinite(reference_rest).all():
        raise ValueError("Rig rest transforms must be finite")
    signature = hashlib.sha256(json.dumps(names).encode() + reference_rest.astype("<f8").tobytes()).hexdigest()
    if signature != rig["bindSignature"]:
        raise ValueError("rig.json bind signature does not match its rest transforms")
    source_hash, rig_hash = digest(source), digest(rig_path)
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
    scene = bpy.context.scene
    candidates = [obj for obj in scene.objects if obj.type == "ARMATURE" and set(obj.data.bones.keys()) == set(names)]
    if len(candidates) != 1:
        raise ValueError("The scene must contain exactly one armature matching the target's 22 bone names")
    arm = candidates[0]
    conversion = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=np.float64)
    current_rest = np.stack([conversion @ np.asarray(arm.matrix_world @ arm.data.bones[name].matrix_local) for name in names])
    rest_error = float(np.max(np.abs(current_rest - reference_rest)))
    if rest_error > 2e-5:
        raise ValueError(f"Target rest rig changed (maximum matrix difference {rest_error:.8g}); retarget onto a copy of the accepted rest rig")
    for index, bone in enumerate(bones):
        parent = arm.data.bones[names[index]].parent
        actual = names.index(parent.name) if parent else -1
        if actual != bone["parent"]:
            raise ValueError(f"Target parent changed for {names[index]}")
    if not arm.animation_data:
        raise ValueError("Target armature has no baked animation action")
    if args.action:
        action = bpy.data.actions.get(args.action)
        if action is None:
            raise ValueError(f"Action not found: {args.action}; available: {', '.join(x.name for x in bpy.data.actions)}")
        arm.animation_data.action = action
    else:
        action = arm.animation_data.action
    if action is None:
        raise ValueError("Target armature has no active action; provide --action")
    # Export only this action, without mixing unrelated NLA tracks into the bake.
    arm.animation_data.use_nla = False
    start = scene.frame_start if args.start is None else args.start
    end = scene.frame_end if args.end is None else args.end
    if not math.isfinite(start) or not math.isfinite(end) or end < start:
        raise ValueError("Source range must be finite and --end must not precede --start")
    source_fps = scene.render.fps / scene.render.fps_base
    duration = (end - start + 1) / source_fps
    count = int(math.ceil(duration * args.fps - 1e-8))
    if count <= 0 or count * len(names) * 10 * 4 > 128 * 1024**2:
        raise ValueError("Clip is empty or exceeds the 128 MiB output budget")
    inverses = np.linalg.inv(reference_rest)
    values = np.empty((count, len(names), 10), dtype="<f4")
    maximum_fit_error = 0.0
    hip_index = names.index("mixamorig:Hips")
    initial_hips = None
    maximum_horizontal_removed = 0.0
    for index in range(count):
        if time.monotonic() - started > args.max_seconds:
            raise TimeoutError("CPU export budget exceeded; source is unchanged and no clip files were written")
        frame = start + index * source_fps / args.fps
        integer_frame = math.floor(frame)
        scene.frame_set(integer_frame, subframe=frame - integer_frame)
        bpy.context.view_layer.update()
        world = np.stack([conversion @ np.asarray(arm.matrix_world @ arm.pose.bones[name].matrix) for name in names])
        pose = world @ inverses
        if args.in_place:
            if initial_hips is None:
                initial_hips = world[hip_index, :3, 3].copy()
            offset = world[hip_index, :3, 3] - initial_hips
            offset[1] = 0.0
            pose[:, :3, 3] -= offset
            maximum_horizontal_removed = max(maximum_horizontal_removed, float(np.linalg.norm(offset)))
        scales = np.linalg.norm(pose[:, :3, :3], axis=1)
        if not np.isfinite(pose).all() or np.any(scales < 1e-10):
            raise ValueError(f"Invalid or degenerate transform at source frame {frame}")
        rotation = pose[:, :3, :3] / scales[:, None, :]
        if np.any(np.linalg.det(rotation) <= 0):
            raise ValueError(f"Reflected bone transform at source frame {frame}; bake supported positive-scale TRS first")
        quaternions = Rotation.from_matrix(rotation).as_quat()
        reconstructed = Rotation.from_quat(quaternions).as_matrix() * scales[:, None, :]
        fit_error = float(np.max(np.abs(reconstructed - pose[:, :3, :3])))
        maximum_fit_error = max(maximum_fit_error, fit_error)
        if fit_error > 2e-5:
            raise ValueError(f"Bone shear cannot be represented by TRS at source frame {frame} (residual {fit_error:.8g})")
        values[index] = np.column_stack((pose[:, :3, 3], quaternions, scales))
    if not np.isfinite(values).all() or not np.allclose(np.linalg.norm(values[:, :, 3:7], axis=2), 1, atol=2e-6):
        raise ValueError("Float32 clip contains nonfinite transforms or nonunit quaternions")
    if digest(source) != source_hash or digest(rig_path) != rig_hash:
        raise RuntimeError("An input changed during export")
    binary = args.id + ".bin"
    metadata = dict(schema="frog-gaussian-clip/1", id=args.id, label=args.label, url=binary, frames=count, fps=args.fps,
                    duration=count / args.fps, loop=not args.once, format="bone-skin-trs-f32le", stride=10,
                    numBones=len(names), boneNames=names, bindSignature=rig["bindSignature"],
                    rootMotion="horizontal-in-place" if args.in_place else "preserved",
                    source=dict(blendName=source.name, blendSha256=source_hash, rigSha256=rig_hash, action=action.name,
                                sourceFrames=[start, end], sourceFps=source_fps),
                    validation=dict(restMatrixMaxError=rest_error, trsReconstructionMaxError=maximum_fit_error,
                                    finite=True, unitQuaternions=True, maximumHorizontalTravelRemoved=maximum_horizontal_removed))
    output.mkdir(parents=True, exist_ok=False)
    content = values.tobytes()
    with (output / binary).open("xb") as stream:
        stream.write(content)
    metadata["bytes"] = len(content)
    metadata["sha256"] = hashlib.sha256(content).hexdigest()
    with (output / (args.id + ".json")).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(metadata, stream, indent=2)
        stream.write("\n")
    print(json.dumps(dict(output=str(output), clip=args.id, frames=count, bones=len(names), bytes=len(content),
                          bindSignature=rig["bindSignature"], restMatrixMaxError=rest_error,
                          trsReconstructionMaxError=maximum_fit_error, seconds=round(time.monotonic() - started, 3))))


if __name__ == "__main__":
    try:
        export(arguments())
    except (ValueError, FileExistsError, RuntimeError, TimeoutError) as error:
        raise SystemExit(f"Export stopped: {error}")
