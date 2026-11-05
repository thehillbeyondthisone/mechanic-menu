export const DEFAULT_SETTINGS = Object.freeze({ sound: false, quality: 'balanced' });
export const QUALITY = Object.freeze({
  performance: { label: 'Performance', pixelRatio: 0.75, framebufferScale: 0.65 },
  balanced: { label: 'Balanced', pixelRatio: 1, framebufferScale: 0.8 },
  detail: { label: 'Detail', pixelRatio: 1.4, framebufferScale: 1 },
});
export function readSettings(storage) {
  try {
    const value = JSON.parse(storage.getItem('repair-office-settings') || '{}');
    return { sound: value.sound === true, quality: QUALITY[value.quality] ? value.quality : 'balanced' };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function cycleQuality(current) {
  const choices = Object.keys(QUALITY);
  return choices[(choices.indexOf(current) + 1) % choices.length];
}
