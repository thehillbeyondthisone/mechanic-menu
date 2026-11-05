import {modes,presets,launchUrl,unavailableReason} from './catalog.js';
const $=id=>document.getElementById(id), form=$('config');
const data={browser:{},files:{}};
let capabilities={streaming:false,surround:false,version:'unknown'}, currentKey='', saved={};
try{saved=JSON.parse(localStorage.getItem('mechanic-menu-tests-v2'))||{};}catch{}
const checks=[...document.querySelectorAll('[data-check]')];
for(const [value,label] of modes){const option=document.createElement('option');option.value=value;option.textContent=label;$('mode').append(option);}
function config(){return {mode:$('mode').value,scene:$('scene').value,flat:$('surround').value==='flat',budget:Number($('budget').value),still:$('still').checked,legacy:$('legacy').checked};}
function store(){if(!currentKey)return;saved[currentKey]={notes:$('notes').value,checks:Object.fromEntries(checks.map(box=>[box.dataset.check,box.checked]))};try{localStorage.setItem('mechanic-menu-tests-v2',JSON.stringify(saved));}catch{}}
function update(){
  store();const value=config(), menu=value.mode==='menu', streamed=value.mode==='stream-menu';
  $('scene').disabled=!menu;$('surround').disabled=!menu||!capabilities.surround;$('legacy').disabled=!menu;$('still').disabled=!menu&&!streamed;$('budget').disabled=menu||value.mode==='reference';
  const effective={...value,flat:menu&&value.flat,still:(menu||streamed)&&value.still};
  const reason=unavailableReason(effective,capabilities), url=launchUrl(effective,location.href,capabilities);
  $('launch').setAttribute('aria-disabled',String(!!reason));if(reason)$('launch').removeAttribute('href');else $('launch').href=url.href;
  $('copy-link').disabled=!!reason;$('availability').textContent=reason;$('availability').className=reason?'warn':'ok';
  $('selected-url').textContent=reason?'This option has no deployed URL here.':url.href;
  $('mode-note').textContent=menu?(capabilities.surround?(value.flat?'Painted shell only: the generated surround splat is disabled. The photo splat remains.':'Current room: generated 3D surround plus its painted gap-filling shell. Full/light changes both photo and surround files.'):'This deployment has the generated painted shell. The newer surround-splat comparison is not deployed here.'):
    streamed?'Earlier streamed menu snapshot. No generated surround, and an older room transform/layout.':'Scene-only renderer check, without the current game menu or generated surround. Full reference ignores LOD budget. The comparison page also has source/left/right/away views, live budget changes, frame-sample reset and measurements.';
  currentKey=JSON.stringify({mode:effective.mode,url:reason?effective:url.href});const previous=saved[currentKey]||{};
  $('notes').value=previous.notes||'';for(const box of checks)box.checked=!!previous.checks?.[box.dataset.check];
  $('result-status').textContent='';$('link-status').textContent='';$('result-fallback').hidden=true;
}
form.addEventListener('submit',event=>event.preventDefault());form.addEventListener('change',update);
for(const box of checks)box.addEventListener('change',store);$('notes').addEventListener('input',store);
function choose(value){$('mode').value=value.mode||'menu';$('scene').value=value.scene||'auto';$('surround').value=value.flat?'flat':'splat';$('still').checked=!!value.still;$('legacy').checked=!!value.legacy;if(value.budget)$('budget').value=String(value.budget);update();}
function renderPresets(){
  $('preset-list').replaceChildren(...presets.map(preset=>{
    const row=document.createElement('div');row.className='preset';const title=document.createElement('strong');title.textContent=preset.title;
    const description=document.createElement('div'), detail=document.createElement('p'), status=document.createElement('p');detail.textContent=preset.detail;
    const reason=unavailableReason(preset.config,capabilities);status.textContent=reason||'Available here';status.className='status '+(reason?'':'ok');description.append(detail,status);
    const button=document.createElement('button');button.type='button';button.textContent='Choose';button.setAttribute('aria-label','Choose '+preset.title);button.addEventListener('click',()=>{choose(preset.config);$('mode').focus();});
    row.append(title,description,button);return row;
  }));
}
function tableRow(table,label,value){const row=document.createElement('tr'),title=document.createElement('th'),cell=document.createElement('td');title.scope='row';title.textContent=label;cell.textContent=value;row.append(title,cell);table.append(row);return cell;}
function browserNote(label,value){data.browser[label]=value;return tableRow($('environment'),label,value);}
browserNote('Secure page',isSecureContext?'yes':'no');const gl=document.createElement('canvas').getContext('webgl2');browserNote('WebGL 2',gl?'yes':'no');gl?.getExtension('WEBGL_lose_context')?.loseContext();
browserNote('Device',/Quest|Oculus/i.test(navigator.userAgent)?'Meta Quest browser':/Android|iPhone|iPad/i.test(navigator.userAgent)?'phone or tablet':'desktop');
browserNote('Screen',`${screen.width} × ${screen.height} @ ${devicePixelRatio}x`);const xr=browserNote('Immersive VR','checking…');
try{const supported=await navigator.xr?.isSessionSupported('immersive-vr');xr.textContent=supported?'supported':'no headset found';}catch(error){xr.textContent='check failed: '+error.message;}data.browser['Immersive VR']=xr.textContent;
async function json(url){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();}
if(['127.0.0.1','localhost','[::1]'].includes(location.hostname)){
  try{capabilities=await json('./test-hub/local-capabilities.json');}catch{}
}else{
  try{const build=await json('./build-info.json');const [major,minor]=String(build.version).split('.').map(Number);capabilities={...capabilities,version:build.version,commit:build.commit,built:build.built,surround:major>0||minor>=7};}catch{}
}
data.deployment=capabilities;
if(capabilities.surround){const present=await Promise.all(['assets/surround.compressed.ply','assets/surround-full.compressed.ply'].map(async path=>{try{return (await fetch(new URL(path,new URL('./',location.href)),{method:'HEAD',cache:'no-store'})).ok;}catch{return false;}}));capabilities.surround=present.every(Boolean);}
$('surround').options[0].textContent=capabilities.surround?'Generated splat + painted shell':'Painted shell (this deployment)';
$('build').textContent=`${capabilities.label||'This deployment'} · v${capabilities.version}${capabilities.commit?' · '+capabilities.commit.slice(0,7):''}${capabilities.built?' · '+capabilities.built:''}. Streaming ${capabilities.streaming?'available locally':'not published here'}.`;
renderPresets();update();
const mainFiles=[['app.js','Current menu app'],['assets/type-meshes.json','3D letters'],['assets/room-shell.json','Room shell geometry'],['assets/room-shell.jpg','Painted room shell'],['assets/room-env.jpg','Sign reflections'],['assets/office.compressed.ply','Photo splat — light'],['assets/office-full.compressed.ply','Photo splat — full']];
if(capabilities.surround)mainFiles.push(['assets/surround.compressed.ply','Generated surround — light'],['assets/surround-full.compressed.ply','Generated surround — full']);
const resources=mainFiles.map(([path,label])=>({url:new URL(path,new URL('./',location.href)),label}));
if(capabilities.streaming)for(const [path,label] of [['compare.js','Renderer comparison app'],['menu/app.js','Streamed menu snapshot'],['assets/office/lod-meta.json','Four-level office LOD index']])resources.push({url:new URL(path,capabilities.streamingBase),label});
await Promise.all(resources.map(async({url,label})=>{const cell=tableRow($('files'),label,'checking…');try{const response=await fetch(url,{method:'HEAD',cache:'no-store'});const size=Number(response.headers.get('content-length')),sizeLabel=size>=1048576?(size/1048576).toFixed(2)+' MiB':(size/1024).toFixed(1)+' KiB';cell.textContent=response.ok?`Available${size?' · '+sizeLabel:''}`:`HTTP ${response.status}`;cell.className=response.ok?'ok':'warn';}catch{cell.textContent='Unreachable';cell.className='warn';}data.files[label]=cell.textContent;}));
document.body.dataset.ready='true';
$('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('launch').href);$('link-status').textContent='Link copied.';}catch{$('link-status').textContent='Clipboard unavailable. Copy the address shown above.';}});
$('copy-results').addEventListener('click',async()=>{store();const selected=config(),reason=unavailableReason(selected,capabilities);const text=['Mechanic Menu test',`Deployment: ${$('build').textContent}`,`Selected: ${reason||launchUrl(selected,location.href,capabilities).href}`,...checks.map(box=>`${box.checked?'[x]':'[ ]'} ${box.parentElement.textContent.trim()}`),'Notes: '+($('notes').value||'—'),JSON.stringify(data,null,2)].join('\n');
  try{await navigator.clipboard.writeText(text);$('result-status').textContent='Results copied. Nothing sent.';}catch{$('result-fallback').value=text;$('result-fallback').hidden=false;$('result-status').textContent='Clipboard unavailable. Copy the results below.';}});
