// Slab intersection for the word's local 3D selection volume, including depth.
export function intersectBox(origin, direction, half) {
  let near = -Infinity, far = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (Math.abs(origin[axis]) > half[axis]) return null;
      continue;
    }
    const a = (-half[axis] - origin[axis]) / direction[axis];
    const b = (half[axis] - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  if (far <= 0) return null;
  return near > 0 ? near : far;
}
export function desktopFov(aspect) {
  return Math.min(56, 2 * Math.atan(Math.tan(25 * Math.PI / 180) / Math.max(0.25, aspect)) * 180 / Math.PI);
}
