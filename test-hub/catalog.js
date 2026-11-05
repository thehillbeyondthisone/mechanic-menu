export const budgets = [393024, 800000, 1200000, 2000000, 3200000];
export const modes = [
  ['menu', 'Current room menu'],
  ['stream-menu', 'Streamed menu snapshot (earlier sign layout)'],
  ['stream', 'PlayCanvas streamed SOG — scene only'],
  ['lite', 'Splat Lite streamed SOG — scene only'],
  ['reference', 'Full PLY reference — scene only'],
];
export const presets = [
  {id:'default', title:'Current menu', detail:'Automatic desktop / Quest scene choice.', config:{mode:'menu'}},
  {id:'full', title:'Full photo splat', detail:'All 3,144,197 source splats; full generated surround when available.', config:{mode:'menu',scene:'full'}},
  {id:'light', title:'Light photo splat', detail:'300K source splats; light generated surround when available.', config:{mode:'menu',scene:'reduced'}},
  {id:'still', title:'Still signs', detail:'Disable sign drop, sway and power-on flicker.', config:{mode:'menu',still:true}},
  {id:'flat', title:'Painted surround comparison', detail:'Photo splat plus the generated flat shell; disables the additional surround splat in v0.7.', needs:'surround', config:{mode:'menu',flat:true}},
  {id:'legacy', title:'Legacy camera diagnostic', detail:'Restores the old forward camera offset for comparison.', config:{mode:'menu',legacy:true}},
  {id:'stream-menu', title:'Streamed menu snapshot', detail:'Earlier physical-sign menu with adaptive office LOD. Separate from the current surround work.', needs:'streaming', config:{mode:'stream-menu'}},
  {id:'stream', title:'PlayCanvas LOD comparison', detail:'Scene-only streamed SOG. Choose a budget below.', needs:'streaming', config:{mode:'stream'}},
  {id:'lite', title:'Splat Lite LOD comparison', detail:'Same SOG dataset, source camera and resolution as the PlayCanvas comparison.', needs:'streaming', config:{mode:'lite'}},
  {id:'reference', title:'All-splat reference', detail:'Scene-only PlayCanvas reference using the full compressed PLY.', needs:'streaming', config:{mode:'reference'}},
];
export function launchUrl(config, pageUrl, capabilities={}) {
  const base = new URL('./', pageUrl);
  const mode = config.mode || 'menu';
  if (!modes.some(([key])=>key===mode)) throw Error('Unknown test mode');
  const url = mode === 'menu' ? base : new URL(mode === 'stream-menu' ? 'menu/' : './', capabilities.streamingBase || base);
  if (mode === 'menu') {
    if (['full','reduced'].includes(config.scene)) url.searchParams.set('scene',config.scene);
    if (config.flat) url.searchParams.set('flat','');
    if (config.still) url.searchParams.set('still','');
    if (config.legacy) url.searchParams.set('camera','legacy');
  } else {
    if (mode !== 'stream-menu') url.searchParams.set('mode',mode);
    const budget = Number(config.budget || 1200000);
    if (!budgets.includes(budget)) throw Error('Unknown splat budget');
    if (mode !== 'reference') url.searchParams.set('budget',String(budget));
    if (mode === 'stream-menu' && config.still) url.searchParams.set('still','');
  }
  return url;
}
export function unavailableReason(config, capabilities) {
  if ((config.mode || 'menu') !== 'menu' && !capabilities.streaming) return 'Local comparison build only; not published here.';
  if (config.flat && !capabilities.surround) return 'The v0.7 surround-splat comparison is not deployed here.';
  return '';
}
