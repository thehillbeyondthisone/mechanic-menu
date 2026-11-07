import * as THREE from 'three';
import {SparkRenderer,SplatMesh} from './vendor/spark.module.js';
import {XrWorkshop} from './xr-workshop.js';
import {FrogCharacter} from './frog-character.js';

const $=id=>document.getElementById(id),canvas=$('view'),query=new URLSearchParams(location.search);
const errors=[];window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
let ready=false,paused=false,bench=null,yaw=0,pitch=0,drag=null,last=0,dpr=1,statsAt=0;
let workshop=null,frog=null,selectedProp=4;
const keys=new Set(),meshes=[],groups=[],colliders=[],frameHistory=[];
const scene=new THREE.Scene();scene.background=new THREE.Color('#d9ded5');scene.fog=new THREE.Fog('#d9ded5',14,31);
const camera=new THREE.PerspectiveCamera(57,innerWidth/innerHeight,.025,60);camera.rotation.order='YXZ';
const renderer=new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance',preserveDrawingBuffer:true});
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
const spark=new SparkRenderer({renderer,enableLod:false,sortRadial:true,covSplats:true,accumExtSplats:true,preBlurAmount:0,blurAmount:.3});scene.add(spark);
scene.add(new THREE.HemisphereLight('#fffbe9','#8d9d99',2.0));const sun=new THREE.DirectionalLight('#fff8df',2);sun.position.set(-3,8,5);scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(22,22),new THREE.MeshStandardMaterial({color:'#d5d0c2',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.008;scene.add(floor);
const grid=new THREE.GridHelper(22,44,'#c7c2b6','#cec9bb');grid.material.transparent=false;scene.add(grid);
const back=new THREE.Mesh(new THREE.BoxGeometry(16,2.7,.15),new THREE.MeshStandardMaterial({color:'#eae9dd',roughness:1}));back.position.set(0,1.35,-6.6);scene.add(back);
const inset=new THREE.Mesh(new THREE.BoxGeometry(10,.03,.04),new THREE.MeshBasicMaterial({color:'#7c9a87'}));inset.position.set(0,.45,-6.51);scene.add(inset);

const gl=renderer.getContext(),gpuExt=gl.getExtension('EXT_disjoint_timer_query_webgl2'),debugExt=gl.getExtension('WEBGL_debug_renderer_info');
const gpuInfo={vendor:debugExt?gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:debugExt?gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),timerQuery:!!gpuExt};
const pendingQueries=[];
function resize(){if(renderer.xr.isPresenting)return;renderer.setPixelRatio(dpr);renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
window.addEventListener('resize',resize);resize();
function orient(target){camera.lookAt(target);yaw=camera.rotation.y;pitch=camera.rotation.x;}
function reset(){if(workshop?.active)return;keys.clear();camera.position.set(0,1.65,6.5);orient(new THREE.Vector3(.8,1.1,-.7));document.querySelectorAll('.stations button').forEach(b=>b.classList.remove('active'));}
function visit(index){if(bench||workshop?.active)return;selectedProp=index;$('propSelect').value=String(index);const g=groups[index],a=config.assets[index];camera.position.set(g.position.x,1.65,g.position.z+2.05);orient(new THREE.Vector3(g.position.x,a.pedestal+a.height*.55,g.position.z));keys.clear();canvas.focus();document.querySelectorAll('.stations button').forEach((b,i)=>b.classList.toggle('active',i===index));}
function blocked(x,z){return Math.abs(x)>7.2||z< -6.1||z>7.2||colliders.some(c=>Math.abs(x-c.x)<c.hx+.19&&Math.abs(z-c.z)<c.hz+.19);}
function move(dt){const speed=keys.has('ShiftLeft')||keys.has('ShiftRight')?3.6:1.9;let x=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),z=(keys.has('KeyS')?1:0)-(keys.has('KeyW')?1:0);const n=Math.hypot(x,z)||1;x/=n;z/=n;const dx=(x*Math.cos(yaw)+z*Math.sin(yaw))*speed*dt,dz=(-x*Math.sin(yaw)+z*Math.cos(yaw))*speed*dt;if(!blocked(camera.position.x+dx,camera.position.z))camera.position.x+=dx;if(!blocked(camera.position.x,camera.position.z+dz))camera.position.z+=dz;camera.position.y=1.65;}
window.addEventListener('keydown',e=>{if(e.code==='Escape'){document.exitPointerLock?.();workshop?.dropDesktop();$('carry').textContent='Pick up selected prop';keys.clear();return;}if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;if(e.code==='KeyR'){reset();return;}if(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight'].includes(e.code)){e.preventDefault();keys.add(e.code);}});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());
canvas.addEventListener('pointerdown',e=>{if(bench)return;canvas.focus();drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
canvas.addEventListener('pointermove',e=>{if(bench)return;const locked=document.pointerLockElement===canvas;if(!locked&&!drag)return;const dx=locked?e.movementX:e.clientX-drag.x,dy=locked?e.movementY:e.clientY-drag.y;yaw-=dx*.0024;pitch=THREE.MathUtils.clamp(pitch-dy*.0024,-1.05,1.05);camera.rotation.set(pitch,yaw,0,'YXZ');if(drag){drag.x=e.clientX;drag.y=e.clientY;}});
document.addEventListener('pointerlockchange',()=>{const locked=document.pointerLockElement===canvas;document.body.classList.toggle('locked',locked);$('crosshair').hidden=!locked;drag=null;keys.clear();$('hint').textContent=locked?'WASD to walk Â· mouse to look Â· Esc to release':'Drag to look Â· WASD to walk Â· R to return';});
$('walk').onclick=()=>{canvas.focus();if(!matchMedia('(pointer: coarse)').matches&&canvas.requestPointerLock){try{const req=canvas.requestPointerLock();req?.catch(()=>{$('hint').textContent='Drag to look Â· WASD to walk Â· R to return';});}catch{$('hint').textContent='Drag to look Â· WASD to walk Â· R to return';}}};
$('reset').onclick=reset;$('quality').onchange=e=>{dpr=Number(e.target.value);resize();};
for(const b of document.querySelectorAll('#touchpad button')){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);};b.onpointerup=b.onpointercancel=()=>keys.delete(b.dataset.key);}

function label(text){const c=document.createElement('canvas');c.width=512;c.height=96;const ctx=c.getContext('2d');ctx.fillStyle='#edf0e8';ctx.fillRect(0,0,512,96);ctx.fillStyle='#3c6155';ctx.font='500 36px Segoe UI';ctx.textAlign='center';ctx.fillText(text,256,61);const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:true}));sprite.scale.set(1.15,.215,1);sprite.renderOrder=-10;sprite.material.depthWrite=false;return sprite;}
let config;
function visitFrog(){if(bench||workshop?.active||!frog?.clips)return;const p=frog.group.position;camera.position.set(p.x,1.65,p.z+1.6);orient(new THREE.Vector3(p.x,1.50,p.z));keys.clear();canvas.focus();document.querySelectorAll('.stations button').forEach(b=>b.classList.toggle('active',b.id==='visit-frog'));}
function setupFrogControls(){
  const select=$('frogClip');for(const clip of frog.rig.clips){const option=document.createElement('option');option.value=clip.id;option.textContent=clip.label;select.append(option);}select.value=frog.playing;
  select.onchange=()=>{frog.select(select.value);$('frogSeek').max=frog.duration;};
  $('frogPause').onclick=()=>{frog.paused=!frog.paused;$('frogPause').textContent=frog.paused?'Resume animation':'Pause animation';};
  $('frogSeek').oninput=e=>frog.seek(Number(e.target.value));$('meetFrog').onclick=visitFrog;
  for(const id of ['frogClip','frogPause','frogSeek','meetFrog'])$(id).disabled=false;
  const button=document.createElement('button');button.textContent='Frog mechanic';button.id='visit-frog';button.onclick=visitFrog;$('stations').append(button);
  const pad=new THREE.Mesh(new THREE.CylinderGeometry(.55,.55,.012,48),new THREE.MeshStandardMaterial({color:'#b9cfc0',roughness:.95}));pad.position.set(frog.group.position.x,.002,frog.group.position.z);scene.add(pad);
  const sign=label('06  Frog mechanic');sign.position.set(frog.group.position.x,.13,frog.group.position.z+.65);scene.add(sign);
  colliders.push({x:frog.group.position.x,z:frog.group.position.z,hx:.42,hz:.30});
}
async function load(){config=await fetch('scene.json').then(r=>{if(!r.ok)throw Error('Scene configuration failed');return r.json();});
frog=new FrogCharacter(scene);const frogReady=frog.load();
await Promise.all(config.assets.map(async(a,i)=>{const g=new THREE.Group();g.position.set(a.position[0],a.pedestal,a.position[2]);g.rotation.y=-Math.PI/2+a.yaw;scene.add(g);groups[i]=g;
const scale=a.height/(a.max[1]-a.min[1]),cx=(a.min[0]+a.max[0])/2,cz=(a.min[2]+a.max[2])/2;
const mesh=new SplatMesh({url:a.url,enableLod:false,lod:false,raycastable:false});mesh.rotation.x=Math.PI;mesh.scale.setScalar(scale);mesh.position.set(-cx*scale,a.max[1]*scale,cz*scale);g.add(mesh);meshes[i]=mesh;
const radius=a.id==='fox'?.82:a.id==='chair'?.73:.66;const plinth=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,a.pedestal,64),new THREE.MeshStandardMaterial({color:i%2?'#dde6db':'#e8e8d9',roughness:.85}));plinth.position.set(g.position.x,a.pedestal/2,g.position.z);scene.add(plinth);colliders.push({x:g.position.x,z:g.position.z,hx:radius,hz:radius});
const l=label(String(i+1).padStart(2,'0')+'  '+a.label);l.position.set(g.position.x,.14,g.position.z+radius+.13);scene.add(l);
const b=document.createElement('button');b.textContent=a.label;b.id='visit-'+a.id;b.onclick=()=>visit(i);$('stations').append(b);
await mesh.initialized;if(mesh.numSplats!==a.numSplats)throw Error(a.id+' count mismatch: '+mesh.numSplats);$('status').textContent=meshes.filter(m=>m?.isInitialized).length+' / 5 props loaded';}));
await frogReady;setupFrogControls();window.exhibit.frog=frog;
workshop=new XrWorkshop({renderer,scene,camera,groups,meshes,assets:config.assets,blocked,onDesktopRestore:()=>{yaw=camera.rotation.y;pitch=camera.rotation.x;$('enterVr').textContent='Enter VR';$('measure').disabled=false;}});window.exhibit.workshop=workshop;
for(const [i,a] of config.assets.entries()){const o=document.createElement('option');o.value=String(i);o.textContent=a.label;$('propSelect').append(o);}$('propSelect').value='4';
const support=await workshop.support();$('enterVr').disabled=!support.supported;$('vrStatus').textContent=support.supported?(query.has('emulate')?'SIMULATED Quest 3 for QA':support.reason):support.reason;
$('enterVr').onclick=async()=>{try{await workshop.toggle();$('enterVr').textContent=workshop.active?'Exit VR':'Enter VR';$('measure').disabled=workshop.active;}catch(e){$('vrStatus').textContent=String(e);}};
$('resetProps').onclick=()=>{workshop.resetObjects();$('carry').textContent='Pick up selected prop';};$('propSelect').onchange=e=>{selectedProp=Number(e.target.value);visit(selectedProp);};$('carry').onclick=()=>{$('carry').textContent=workshop.carry(selectedProp)?'Release prop':'Pick up selected prop';canvas.focus();};
await spark.update({scene,camera});await waitActive(393216);ready=true;document.body.dataset.ready='true';$('status').textContent='Five props + live mechanic Â· ready';$('readyDot').classList.add('ready');$('walk').disabled=false;$('measure').disabled=false;$('hint').textContent='Drag to look Â· WASD to walk Â· R to return';
const startup=performance.now()-loadStart;window.exhibit.loadMs=startup;window.exhibit.assetBounds=config.assets.map(a=>({id:a.id,min:a.min,max:a.max,scale:a.height/(a.max[1]-a.min[1]),rotationX:Math.PI,rotationY:-Math.PI/2+a.yaw}));
if(query.has('autobench'))setTimeout(()=>runBenchmark().catch(showError),2000);
}
function showError(e){errors.push(String(e));$('error').hidden=false;$('error').textContent=String(e);document.body.dataset.error='true';console.error(e);}
async function waitActive(expected){const start=performance.now();while(spark.activeSplats!==expected){if(performance.now()-start>10000)throw Error('Expected '+expected+' active splats, got '+spark.activeSplats);await new Promise(requestAnimationFrame);}}
const qtile=(a,q)=>{const s=[...a].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*(s.length-1)))]??null;};
function pollGpu(){for(let i=pendingQueries.length-1;i>=0;i--){const p=pendingQueries[i];if(gl.getQueryParameter(p.q,gl.QUERY_RESULT_AVAILABLE)){if(!gl.getParameter(gpuExt.GPU_DISJOINT_EXT))p.phase?.gpu.push(gl.getQueryParameter(p.q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(p.q);pendingQueries.splice(i,1);}}}
function summarize(p){const mean=p.intervals.reduce((a,b)=>a+b,0)/p.intervals.length;return {name:p.name,visibleAssets:p.count,splats:p.count*65536,frames:p.intervals.length,meanFps:1000/mean,medianFrameMs:qtile(p.intervals,.5),p95FrameMs:qtile(p.intervals,.95),maxFrameMs:Math.max(...p.intervals),framesAbove33ms:p.intervals.filter(t=>t>33.34).length,cpuSubmitMedianMs:qtile(p.cpu,.5),gpuMedianMs:qtile(p.gpu,.5),gpuP95Ms:qtile(p.gpu,.95),gpuSamples:p.gpu.length,activeSplats:spark.activeSplats};}
function setCount(n,showFrog=false){meshes.forEach((m,i)=>m.visible=i<n);if(frog)frog.group.visible=showFrog;}
function benchPose(name,t){if(name==='five-walk'){const a=t*Math.PI*2;camera.position.set(5.3*Math.sin(a),1.65,1+5.3*Math.cos(a));orient(new THREE.Vector3(0,1,-.7));}else{camera.position.set(0,2.15,7.6);orient(new THREE.Vector3(0,1.05,-.8));}}
async function phase(name,count,seconds){benchPose(name,0);setCount(count);await spark.update({scene,camera});await waitActive(count*65536);const p={name,count,seconds,intervals:[],cpu:[],gpu:[],start:performance.now(),warmMs:1500,last:null,done:null};bench=p;$('benchmarkStatus').textContent='Measuring '+name+'â€¦';console.info('[benchmark]',name);await new Promise(resolve=>p.done=resolve);await new Promise(r=>setTimeout(r,120));pollGpu();return summarize(p);}
async function runBenchmark(){if(!ready||bench||renderer.xr.isPresenting)return null;paused=false;keys.clear();document.exitPointerLock?.();document.body.classList.add('benchmarking');$('measure').disabled=true;const saved={position:camera.position.clone(),quaternion:camera.quaternion.clone(),dpr};const result={schema:'tripo-keepers-perf/1',created:new Date().toISOString(),renderer:'Spark 2.4.0 / Three 0.180.0',gpu:gpuInfo,userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],drawingBuffer:[],dpr:1,loadMs:window.exhibit.loadMs,sourceGaussians:327680,sourcePlyBytes:config.totalBytes,phases:[],errors,mode:query.get('mode')||'interactive-rAF',note:'One versus five fixed matched overview; five-walk follows an outer circle at fixed eye height. All source splats retained, no LOD. GPU queries cover submitted render commands; asynchronous worker sorting is reflected in CPU/frame pacing, not GPU query time.'};
try{dpr=1;resize();const size=new THREE.Vector2();renderer.getDrawingBufferSize(size);result.drawingBuffer=size.toArray();for(const [name,count,s] of [['one-static',1,7],['five-static',5,7],['five-walk',5,12]])result.phases.push(await phase(name,count,s));result.receipt=prepareMeasurementDownload(result);window.exhibit.lastBenchmark=result;$('benchResults').innerHTML=result.phases.map(p=>`<div>${p.name}: ${p.meanFps.toFixed(1)} FPS Â· p95 ${p.p95FrameMs.toFixed(2)} ms${p.gpuMedianMs!==null?' Â· GPU '+p.gpuMedianMs.toFixed(2)+' ms':''}</div>`).join('');$('benchmarkStatus').textContent='Measurement ready. Download the JSON to keep it.';return result;}finally{bench=null;setCount(5,true);camera.position.copy(saved.position);camera.quaternion.copy(saved.quaternion);yaw=camera.rotation.y;pitch=camera.rotation.x;dpr=saved.dpr;resize();$('measure').disabled=false;document.body.classList.remove('benchmarking');}}
let measurementUrl=null;
function prepareMeasurementDownload(result){
  if(measurementUrl)URL.revokeObjectURL(measurementUrl);
  const filename='splat-studio-measurement-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  measurementUrl=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  const link=$('downloadMeasurement');link.href=measurementUrl;link.download=filename;link.hidden=false;
  return {status:'DOWNLOAD_READY',filename};
}
$('measure').onclick=()=>runBenchmark().catch(showError);

function frame(now,xrFrame){const frameMs=last?now-last:0;const dt=Math.min(frameMs/1000,.06);last=now;if(paused&&!renderer.xr.isPresenting)return;if(gpuExt)pollGpu();if(bench){const age=now-bench.start;if(age>=bench.warmMs){const t=Math.min(1,(age-bench.warmMs)/(bench.seconds*1000));benchPose(bench.name,t);if(bench.last!==null)bench.intervals.push(now-bench.last);bench.last=now;if(t>=1){const finish=bench.done;bench.done=null;bench=null;finish?.();}}}else if(!renderer.xr.isPresenting)move(dt);workshop?.update(dt);if(frog&&workshop)frog.approach(new THREE.Vector3().setFromMatrixPosition(workshop.headWorldMatrix()),workshop.active);frog?.update(dt);if(frog?.clips&&now-frog.lastUi>120){$('frogStatus').textContent=frog.label+' Â· '+(frog.paused?'paused':'playing');if(document.activeElement!==$('frogSeek'))$('frogSeek').value=String(frog.time%frog.duration);frog.lastUi=now;}
const active=bench&&now-bench.start>=bench.warmMs?bench:null;let timer=null;if(gpuExt&&!renderer.xr.isPresenting&&pendingQueries.length<12&&!gl.getQuery(gpuExt.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){timer=gl.createQuery();gl.beginQuery(gpuExt.TIME_ELAPSED_EXT,timer);}const start=performance.now();renderer.render(scene,camera);const cpu=performance.now()-start;if(timer){gl.endQuery(gpuExt.TIME_ELAPSED_EXT);pendingQueries.push({q:timer,phase:active});}active?.cpu.push(cpu);
if(frameMs>0)frameHistory.push(frameMs);if(frameHistory.length>90)frameHistory.shift();if(now-statsAt>600&&ready){const med=qtile(frameHistory,.5);$('fps').textContent=med?(1000/med).toFixed(0):'â€”';$('frameMs').textContent=med?med.toFixed(1)+' ms':'';statsAt=now;}}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();showError('The GPU context was lost. Reload the exhibit to resume.');});
window.exhibit={get ready(){return ready;},renderer,scene,camera,spark,meshes,groups,colliders,errors,gpuInfo,reset,visit,blocked,runBenchmark,visitFrog,pause(v=true){paused=v;},snapshot(){return {ready,position:camera.position.toArray(),yaw,pitch,meshes:meshes.map((m,i)=>({id:config.assets[i].id,splats:m.numSplats,visible:m.visible})),frog:frog?.clips?{splats:frog.mesh.numSplats,bones:frog.rig.numBones,clip:frog.playing,time:frog.time,paused:frog.paused,position:frog.group.position.toArray()}:null,activeSplats:spark.activeSplats,drawingBuffer:[canvas.width,canvas.height],errors:[...errors]};}};
const loadStart=performance.now();reset();renderer.setAnimationLoop(frame);load().catch(showError);

