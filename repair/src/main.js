import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh, SparkXr } from '@sparkjsdev/spark';
import { RepairJob } from './repair-job.mjs';
import { makeRoomFx } from './room-fx.js';
import { WorkshopAudio } from './audio.js';
import { dressStation, makeTethers, makeMiniature } from './workshop-details.js';
import { attachGeneratedProps, generatedPropsSnapshot } from './generated-props.js';
import { attachGeneratedStation, generatedStationSnapshot } from './generated-station.js';
import { attachGeneratedTerminal, generatedTerminalSnapshot, liveScreenSnapshot } from './generated-terminal.js';

const $ = id => document.getElementById(id);
const V = THREE.Vector3, clamp = THREE.MathUtils.clamp, damp = THREE.MathUtils.damp;
const job = new RepairJob(), sound = new WorkshopAudio();
const scene = new THREE.Scene();
scene.background = new THREE.Color('#080e0d');
const renderer = new THREE.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.35));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = .95;
$('world').appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(58, innerWidth/innerHeight, .025, 40);
camera.position.set(0,1.3633,0); scene.add(camera);
const root = new THREE.Group(); scene.add(root);
const spark = new SparkRenderer({renderer,accumExtSplats:true,covSplats:true}); scene.add(spark);
scene.add(new THREE.HemisphereLight(0xe9e8d0, 0x293529, 1.65));
const key = new THREE.DirectionalLight(0xffd7a3, 1.65); key.position.set(-2,4,1); scene.add(key);
const fill = new THREE.PointLight(0x9bffd0, .8, 3); fill.position.set(-.25,1.3,-.75); root.add(fill);
const fx = makeRoomFx();
let room, station, drawer, probe, part, consoleScreen, consoleCtx, noteCtx, noteTexture;
let drawerTarget = 0, drawerOpen = 0, heldProbe = null, heldPart = null;
let probeDock, partHome, socketPos, fault, faultPoints, faultPositions, faultSeeds;
let generatedProps, generatedStation, generatedTerminal;
let ready = false, hover = null, lastPhase = '', toastUntil = 0, time = 0, lastTime = performance.now();
let scanActive = false, scanBeep = 0, testSoundStage = -1;
let repairBlend = 0, pullAmount = 0, introBlend = 0;
let buttonScan = false, scanGesture = false, keyboardScan = false;
let selectedDial=0, miniature, postgame=false, echoAge=10, calibrationTone=0;
let extractionAge=10;
const dials=[],dialLights=[],tethers=makeTethers(scene);
const dialNames=['DEPTH','PHASE','GAIN'],dialXs=[-.235,0,.235];
const completedSteps = ['drawer','scan','part','install','calibrate','test'];
const pointer = {ndc:new THREE.Vector2(), down:false, dragged:false, scanning:false, x:0,y:0, x0:0,y0:0};
const look = {x:0,y:0,targetX:0,targetY:0};
const raycaster = new THREE.Raycaster(), hits = [], controllers = [];
const beamGeo = new THREE.BufferGeometry().setFromPoints([new V(),new V()]);
const beam = new THREE.Line(beamGeo,new THREE.LineBasicMaterial({color:0xa8ffd1,transparent:true,opacity:.7,depthTest:false}));
beam.renderOrder=100; beam.visible=false; scene.add(beam);
const ring = new THREE.Mesh(new THREE.TorusGeometry(.065,.0025,6,48),new THREE.MeshBasicMaterial({color:0xc5e5a4,transparent:true,opacity:.7}));
ring.visible=false; root.add(ring);

function toast(message) { $('toast').textContent=message; $('toast').classList.add('visible'); toastUntil=performance.now()+3500; }
function haptic(ctl, value=.25, duration=60) {
  const actuator=ctl?.source?.gamepad?.hapticActuators?.[0];
  if (actuator) Promise.resolve(actuator.pulse(value,duration)).catch(()=>{});
}
function errorScreen(error) {
  console.error(error); $('loading').hidden=false;
  $('load-status').textContent=`Could not open the shop: ${error.message}. Reload to retry.`;
}
window.addEventListener('unhandledrejection', e=>errorScreen(e.reason instanceof Error?e.reason:new Error(String(e.reason))));

function hitBox(id, parent, pos, dims) {
  const m=new THREE.Mesh(new THREE.BoxGeometry(...dims),new THREE.MeshBasicMaterial({visible:false}));
  m.position.set(...pos); m.userData.id=id; parent.add(m); hits.push(m); return m;
}
function makeLabel(parent, text, pos, width=.18, height=.035, bg='#d9d0ad', ink='#24382c') {
  const c=document.createElement('canvas'); c.width=512; c.height=Math.round(512*height/width);
  const g=c.getContext('2d'); g.fillStyle=bg; g.fillRect(0,0,c.width,c.height);
  g.fillStyle=ink; g.font=`bold ${Math.round(c.height*.45)}px monospace`; g.textAlign='center';g.textBaseline='middle';
  g.fillText(text,c.width/2,c.height/2,c.width*.92);
  const tx=new THREE.CanvasTexture(c); tx.colorSpace=THREE.SRGBColorSpace;
  const p=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:tx}));
  p.position.set(...pos); parent.add(p); return p;
}
function textCanvas(width,height) {
  const c=document.createElement('canvas'); c.width=width;c.height=height;
  const tx=new THREE.CanvasTexture(c);tx.colorSpace=THREE.SRGBColorSpace;
  return {c,ctx:c.getContext('2d'),tx};
}
function screenLines() {
  switch(job.phase) {
    case 'briefing':return ['PATTERSON / AFTER HOURS','WORK ORDER 0417','ROOM WILL NOT STAY SOLID.','TOUCH SCREEN TO ACCEPT.'];
    case 'drawer':return ['0417 / DIAGNOSTIC','01  OPEN SERVICE DRAWER','PULL THE METAL HANDLE.','PLEASE RETAIN ALL DEPTH.'];
    case 'probe':return ['0417 / TOOL REQUIRED','02  PICK UP THE PROBE','IN ITS CRADLE, ON THE RIGHT.','TRIGGER: INSPECT / GRIP: HOLD'];
    case 'scan':return ['0417 / INSPECTION',`DEPTH INTEGRITY: ${Math.floor(job.scan*100)}%`,'AIM AT THE DRAWER. HOLD TRIGGER.','KEEP DRAWER OPEN.'];
    case 'extract':return ['0417 / FAULT IDENTIFIED','03  EXTRACT DEPTH REGULATOR','GRAB THE BRASS COMPONENT.','RELEASE PROBE TO DOCK IT.'];
    case 'install':return ['0417 / REPLACEMENT','04  INSTALL THE REGULATOR','BRASS SOCKET, ABOVE THE DRAWER.','DROPPED PARTS RETURN TO TRAY.'];
    case 'calibrate':return ['0417 / SIGNAL ALIGNMENT','05  TUNE THE THREE FRONT DIALS','DEPTH / PHASE / GAIN','HOLD ALL THREE CHANNELS GREEN.'];
    case 'test':return ['0417 / SIGNAL LOCKED','06  PRESS RED TEST BUTTON','ROOM MAY BECOME TEMPORARILY 2D.','KEEP HANDS INSIDE REALITY.'];
    case 'testing':return ['0417 / ROOM TEST',`RECONSTITUTING... ${Math.min(99,Math.floor(job.testTime*20))}%`,'DEPTH CHANNEL: RECOVERED','PLEASE REMAIN YOURSELF.'];
    case 'complete':return echoAge<2?['0418 / FEEDBACK DETECTED','PLEASE STOP TOUCHING THAT.','THE SMALL SHOP CAN FEEL IT.','SERVICE CHARGE MAY INCREASE.']:['0417 / REPAIR COMPLETE','NEW WORK ORDER: 0418','SHOP FOUND INSIDE SERVICE DRAWER.','TOUCH THE MINIATURE TO INVESTIGATE.'];
  }
}
let screenCache='',noteCache='';
function updateScreen(force=false) {
  if(!consoleCtx)return;
  const lines=screenLines(), cache=lines.join('|')+(job.phase==='calibrate'?JSON.stringify(job.dials)+Math.floor(time*12):'');
  if(cache===screenCache&&!force)return;screenCache=cache;
  const g=consoleCtx;g.fillStyle='#071b13';g.fillRect(0,0,640,400);
  g.strokeStyle='#2d6246';g.strokeRect(16,16,608,368);
  g.fillStyle='#75c59a';g.font='19px monospace';g.fillText(lines[0],33,58);
  g.fillStyle='#b8f4be';g.font='bold 25px monospace';g.fillText(lines[1],33,140,575);
  g.font='19px monospace';g.fillText(lines[2],33,209,575);g.fillStyle='#72b08d';g.fillText(lines[3],33,257,575);
  g.fillStyle='#1d462e';g.fillRect(33,311,574,14);
  g.fillStyle='#b3eab3';g.fillRect(33,311,574*(job.complete?1:job.testing?job.testTime/5:job.scan),14);
  g.fillStyle='#a0b888';g.font='15px monospace';g.fillText('SERVICE  /  PARTS  /  REPAIR',33,365);
  for(let y=0;y<400;y+=4){g.fillStyle='#00000018';g.fillRect(0,y,640,1);}
  if(job.phase==='calibrate'){
    g.fillStyle='#071b13';g.fillRect(25,90,590,250);
    g.strokeStyle='#173e2a';g.lineWidth=1;
    for(let x=32;x<610;x+=32){g.beginPath();g.moveTo(x,95);g.lineTo(x,225);g.stroke();}
    for(let y=95;y<225;y+=26){g.beginPath();g.moveTo(32,y);g.lineTo(610,y);g.stroke();}
    g.strokeStyle=job.channelLocks.every(Boolean)?'#c5f7b0':'#a9d990';g.lineWidth=2;g.beginPath();
    for(let x=32;x<610;x++){
      const v=job.dials.map((a,i)=>Math.abs(a-job.targets[i]));
      const y=160+Math.sin(x*.035+time*2)*v[0]*90+Math.sin(x*.072-time*3)*v[1]*75+Math.sin(x*.17+time*4)*v[2]*50;
      if(x===32)g.moveTo(x,y);else g.lineTo(x,y);
    }g.stroke();
    job.channelLocks.forEach((locked,i)=>{
      g.fillStyle=locked?'#bcedae':'#c49b6e';g.font=`${i===selectedDial?'bold ':''}22px monospace`;
      g.fillText(`${i===selectedDial?'>':' '} ${dialNames[i]} ${locked?'LOCK':'~~~~'}`,35+i*190,266,185);
      g.fillStyle='#214831';g.fillRect(35+i*190,285,167,5);g.fillStyle=locked?'#bcedae':'#9b9d70';g.fillRect(35+i*190,285,167*job.dials[i],5);
    });
    g.fillStyle='#a6d69b';g.font='19px monospace';g.fillText(job.channelLocks.every(Boolean)?'SIGNAL FOUND. HOLD STEADY.':'TURN DIALS UNTIL THE WAVE IS QUIET.',33,327,575);
  }
  consoleScreen.material.map.needsUpdate=true;
  if(noteCache===job.phase&&!force)return;noteCache=job.phase;
  noteCtx.fillStyle='#e2d5b2';noteCtx.fillRect(0,0,480,620);
  noteCtx.fillStyle='#365044';noteCtx.font='20px monospace';noteCtx.fillText('PATTERSON SERVICE',28,42);
  noteCtx.font='bold 35px monospace';noteCtx.fillText('WORK ORDER 0417',28,94);
  noteCtx.font='20px monospace';['CUSTOMER REPORTS:', 'ROOM OCCASIONALLY', 'BECOMES A PHOTOGRAPH.', '', '1. OPEN DRAWER', '2. INSPECT WITH PROBE', '3. EXTRACT REGULATOR', '4. INSTALL IN SOCKET', '5. TUNE THREE CHANNELS', '6. PRESS TEST'].forEach((s,i)=>noteCtx.fillText(s,28,151+i*33));
  noteCtx.fillStyle='#934e35';noteCtx.font='bold 20px monospace';noteCtx.fillText(job.complete?'REPAIR ACCEPTED':'PLEASE RETURN ALL DEPTH.',28,560);
  noteTexture.needsUpdate=true;
}

async function boot() {
  const loader=new GLTFLoader();
  const modelNames=['service-station.glb','inspection-probe.glb','depth-regulator.glb'];
  const modelsPromise=Promise.all(modelNames.map(n=>loader.loadAsync(`./assets/models/${n}`)));
  room=new SplatMesh({url:'./assets/patterson-quest.spz',lod:false,onProgress:e=>{
    if(e.lengthComputable){$('load-bar').style.width=`${Math.floor(e.loaded/e.total*90)}%`;$('load-status').textContent=`Restoring room… ${Math.floor(e.loaded/e.total*100)}%`;}
  }});
  room.objectModifier=fx.modifier;root.add(room);
  const [models]=await Promise.all([modelsPromise,room.initialized]);
  station=models[0].scene;station.position.set(0,0,-1.23);root.add(station);
  dressStation(station);
  drawer=station.getObjectByName('RepairDrawer');
  if(!drawer)throw new Error('RepairDrawer node is missing from station model');
  probe=models[1].scene;part=models[2].scene;root.add(probe,part);
  generatedProps=await attachGeneratedProps({probe,part});
  probeDock=new V(.085,1.09,-1.27);partHome=new V(0,.735,-1.17);socketPos=new V(.265,1.13,-1.015);
  dockProbe(false);homePart();part.visible=false;
  hitBox('drawer',drawer,[0,.78,.265],[.58,.13,.075]);
  hitBox('probe',probe,[0,.045,0],[.13,.24,.15]);
  hitBox('part',part,[0,0,0],[.16,.13,.13]);
  hitBox('socket',station,[.265,1.13,.20],[.21,.20,.09]);
  hitBox('test',station,[-.28,1.03,.145],[.16,.09,.12]);
  hitBox('screen',station,[-.18,1.15,.03],[.35,.23,.035]);
  hitBox('recenter',station,[.075,1.245,.03],[.13,.04,.025]);
  makeLabel(drawer,'DEPTH / KEEP CLOSED',[0,.697,.242],.21,.035);
  ['TuningDepth','TuningPhase','TuningGain'].forEach((name,i)=>{
    const knob=station.getObjectByName(name);if(!knob)throw new Error(`Missing calibration dial: ${name}`);
    dials.push(knob);hitBox(`dial-${i}`,station,[dialXs[i],.91,.29],[.085,.075,.065]);
    makeLabel(station,dialNames[i],[dialXs[i],.869,.254],.12,.017,'#20382f','#d2cfb0');
    const led=new THREE.Mesh(new THREE.SphereGeometry(.005,8,6),new THREE.MeshBasicMaterial({color:0x4a4d34}));
    led.position.set(dialXs[i]+.054,.91,.257);station.add(led);dialLights.push(led);
  });
  makeLabel(station,'TEST',[-.28,.993,.20],.10,.025,'#dccca6','#65372c');
  makeLabel(station,'REGULATOR',[.265,1.025,.193],.18,.025);
  makeLabel(station,'RECENTER',[.075,1.245,.048],.13,.032,'#213a2f','#b0cba6');
  const screen=textCanvas(640,400);consoleCtx=screen.ctx;
  consoleScreen=new THREE.Mesh(new THREE.PlaneGeometry(.302,.19),new THREE.MeshBasicMaterial({map:screen.tx,toneMapped:false}));
  consoleScreen.position.set(-.18,1.15,.014);station.add(consoleScreen);
  const note=textCanvas(480,620);noteCtx=note.ctx;noteTexture=note.tx;
  const slip=new THREE.Mesh(new THREE.PlaneGeometry(.235,.304),new THREE.MeshBasicMaterial({map:note.tx,side:THREE.DoubleSide}));
  slip.position.set(-.54,1.10,.04);slip.rotation.y=.22;slip.rotation.z=.05;station.add(slip);
  makeFault();
  miniature=makeMiniature(station,drawer);hitBox('miniature',miniature,[0,.60,0],[1.1,1.35,.55]);
  generatedStation=await attachGeneratedStation({station,drawer,dials,miniature});
  fx.u.stationSkin.value=generatedStation.mode==='triposplat'?1:0;
  generatedTerminal=await attachGeneratedTerminal({station,miniature,screen:consoleScreen});
  setupXR();
  $('load-bar').style.width='100%';$('loading').hidden=true;$('intro').hidden=false;
  ready=true;refreshUI();updateScreen(true);
  renderer.setAnimationLoop(frame);
}

function makeFault() {
  fault=new THREE.Group();drawer.add(fault);fault.position.set(0,.745,.06);
  const n=420,positions=new Float32Array(n*3),colors=new Float32Array(n*3);
  faultSeeds=new Float32Array(n*4);
  for(let i=0;i<n;i++){
    const a=i*2.39996,r=.025+.125*Math.sqrt(i/n),z=Math.sin(i*47.11);
    faultSeeds.set([Math.cos(a)*r,Math.sin(i*2.71)*.055,Math.sin(a)*r,i*.12],i*4);
    colors.set(i%5===0?[.95,.74,.32]:[.34,.9,.64],i*3);
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geo.setAttribute('color',new THREE.BufferAttribute(colors,3));faultPositions=positions;
  const dot=document.createElement('canvas');dot.width=32;dot.height=32;
  const g=dot.getContext('2d'),grad=g.createRadialGradient(16,16,0,16,16,16);
  grad.addColorStop(0,'#ffffffff');grad.addColorStop(.25,'#ffffffdd');grad.addColorStop(1,'#ffffff00');g.fillStyle=grad;g.fillRect(0,0,32,32);
  faultPoints=new THREE.Points(geo,new THREE.PointsMaterial({size:.012,map:new THREE.CanvasTexture(dot),vertexColors:true,transparent:true,opacity:.7,depthWrite:false,blending:THREE.AdditiveBlending}));
  fault.add(faultPoints);hitBox('fault',fault,[0,.015,0],[.34,.20,.31]);
}

function startJob() {
  if(!ready)return;sound.unlock();job.start();$('intro').hidden=true;$('controls').hidden=false;
  document.body.classList.add('playing');sound.click();toast('Work order accepted. Pull the handle on the service drawer.');refreshUI();
}
function toggleDrawer() {
  if(!job.begun)return startJob();
  if(job.testing||job.complete&&!postgame)return;
  drawerTarget=drawerTarget>.5?0:1;sound.tone(drawerTarget?95:75,.24,'sawtooth',.13);
}
function dockProbe(announce=true) {
  if(!probe)return;
  const old=heldProbe;root.add(probe);probe.position.copy(probeDock);probe.rotation.set(0,0,-.14);
  heldProbe=null;buttonScan=false;keyboardScan=false;
  if(old?.ctl)old.ctl.scanning=false;
  if(announce)toast('Probe returned to its cradle.');refreshUI();
}
function grabProbe(ctl=null) {
  if(!job.useProbe()){toast('Open the drawer before collecting the probe.');return;}
  if(heldProbe){if(heldProbe.ctl===ctl)dockProbe();return;}
  if(heldPart&&(!ctl||heldPart.ctl===ctl))returnPart();
  heldProbe={ctl};
  if(ctl){ctl.grip.add(probe);probe.position.set(0,-.02,-.055);probe.rotation.set(0,0,0);}
  else{camera.add(probe);probe.position.set(.18,-.14,-.52);probe.rotation.set(-.12,-.35,-.12);}
  haptic(ctl);sound.click();toast(ctl?'Aim into the drawer and hold trigger.':'Aim into the drawer and hold the mouse to inspect.');refreshUI();
}
function homePart() {
  root.add(part);part.position.copy(partHome).add(new V(0,0,drawerOpen*.32));part.rotation.set(0,.25,0);
  heldPart=null;
}
function grabPart(ctl=null) {
  if(!job.takePart()){toast('Inspect the fault with the probe until the component becomes solid.');return;}
  if(heldPart)return;
  if(heldProbe&&(!ctl||heldProbe.ctl===ctl))dockProbe(false);
  const from=part.getWorldPosition(new V());
  heldPart={ctl,age:0};part.visible=true;extractionAge=0;
  const holder=ctl?ctl.grip:camera;holder.add(part);part.position.copy(holder.worldToLocal(from));
  heldPart.from=part.position.clone();part.rotation.set(.15,-.3,0);
  sound.tone(410,.25,'triangle');haptic(ctl,.5,100);
  toast('Depth regulator extracted. Seat it in the socket above the drawer.');refreshUI();
}
function returnPart() {
  if(!heldPart)return;
  const old=heldPart;homePart();haptic(old.ctl,.12,30);
  drawerTarget=1;toast('Component returned safely to the drawer. Pick it up again.');refreshUI();
}
function installPart(ctl=null) {
  if(!job.install(!!heldPart)){toast('Bring the extracted regulator to the socket.');return;}
  root.add(part);part.position.copy(socketPos);part.rotation.set(0,0,0);heldPart=null;
  if(heldProbe)dockProbe(false);
  drawerTarget=0;
  sound.success();haptic(ctl,.6,130);toast('Regulator seated. Align the three front dials until the signal is quiet.');refreshUI();
}
function beginTest() {
  if(!job.test()){toast(job.installed?'Align all three channels before testing.':'Install the regulator before running the room test.');return;}
  drawerTarget=0;testSoundStage=-1;sound.tone(65,.8,'sawtooth',.2);refreshUI();
}
function interact(id,ctl=null) {
  if(!ready)return;sound.unlock();
  if(id==='recenter')return recenter();
  if(!job.begun){if(id==='screen')startJob();return;}
  if(job.complete){if(id==='miniature'||id==='test')pulseMiniature();else if(id==='screen')investigate();else if(id==='drawer')toggleDrawer();return;}
  if(job.testing)return;
  if(id?.startsWith('dial-')){const i=Number(id.slice(-1));selectedDial=i;setDial(i,(job.dials[i]+.04)%1.01,ctl);return;}
  switch(id){
    case 'screen':return primaryAction(ctl);
    case 'drawer':return toggleDrawer();
    case 'probe':return grabProbe(ctl);
    case 'fault':if(job.revealed)return grabPart(ctl);else toast('Pick up the probe, aim into the drawer, and hold to inspect.');break;
    case 'part':return grabPart(ctl);
    case 'socket':return installPart(ctl);
    case 'test':return beginTest();
  }
}
function primaryAction(ctl=null) {
  switch(job.phase){
    case 'briefing':startJob();break;
    case 'drawer':drawerTarget=1;sound.click();break;
    case 'probe':grabProbe(ctl);break;
    case 'scan':if(!heldProbe)grabProbe(ctl);else if(drawerTarget<.7){drawerTarget=1;toast('Reopening the drawer.');}else toast('Hold the inspection button, Space, or the trigger over the drawer.');break;
    case 'extract':drawerTarget=1;grabPart(ctl);break;
    case 'install':if(!heldPart){drawerTarget=1;grabPart(ctl);}else installPart(ctl);break;
    case 'calibrate':selectedDial=(selectedDial+1)%3;toast('Drag a front dial sideways, or use its slider. Quiet all three channels.');break;
    case 'test':beginTest();break;
    case 'complete':if(postgame)pulseMiniature();else investigate();break;
  }
}
function resetJob() {
  if(!ready)return;
  dockProbe(false);homePart();job.reset();drawerTarget=0;drawerOpen=0;drawer.position.z=0;
  part.visible=false;fault.visible=true;repairBlend=0;pullAmount=0;testSoundStage=-1;
  miniature.visible=false;postgame=false;echoAge=10;extractionAge=10;tethers.mesh.visible=false;selectedDial=0;
  buttonScan=false;keyboardScan=false;scanGesture=false;pointer.scanning=false;pointer.down=false;pointer.drawerDrag=false;pointer.dialDrag=null;
  beam.visible=false;toastUntil=0;$('toast').classList.remove('visible');$('toast').textContent='';
  controllers.forEach(c=>{c.scanning=false;c.dragging=null;c.tuning=null;});
  look.targetX=0;look.targetY=0;
  document.body.classList.remove('ended','show-order');$('order').setAttribute('aria-expanded','false');$('ending').hidden=true;$('controls').hidden=true;$('intro').hidden=false;
  document.body.classList.remove('playing');sound.click();refreshUI();updateScreen(true);
}

function setDial(index,value,ctl=null){
  const locked=job.channelLocks[index];
  if(!job.setDial(index,value))return;
  selectedDial=index;
  if(!locked&&job.channelLocks[index]){sound.tone(620+index*100,.11,'sine',.15);haptic(ctl,.35,60);}
  updateCalibrationUI();
}
function updateCalibrationUI(){
  const locks=job.channelLocks;
  job.dials.forEach((value,i)=>{
    const slider=$(`dial-${i}`);if(document.activeElement!==slider)slider.value=Math.round(value*100);
    $(`dial-value-${i}`).textContent=Math.round(value*100);
    $(`dial-status-${i}`).textContent=locks[i]?'LOCK':Math.abs(value-job.targets[i])<.16?'NEAR':'NOISY';
    const row=document.querySelector(`[data-channel="${i}"]`);row.classList.toggle('locked',locks[i]);row.classList.toggle('active',i===selectedDial);
  });
  $('signal-quality').textContent=`${Math.round(job.signal*100)}%`;
  $('lock-fill').style.width=`${Math.min(1,job.lockTime/1.6)*100}%`;
  const message=locks.every(Boolean)?'Signal found. Hold steady…':`${locks.filter(Boolean).length} / 3 channels locked.`;
  if($('lock-status').textContent!==message)$('lock-status').textContent=message;
}
function investigate(){
  if(!job.complete)return;postgame=true;$('ending').hidden=true;document.body.classList.remove('ended');
  $('controls').hidden=false;drawerTarget=1;refreshUI();
}
function pulseMiniature(){
  if(!job.complete)return;investigate();echoAge=0;sound.tone(85,.55,'triangle',.25);sound.tone(430,.19,'sine',.14);
  controllers.forEach(c=>haptic(c,.2,70));toast('The little shop remembers your touch.');
}

function refreshUI() {
  if(!ready)return;
  const phase=job.phase;document.body.dataset.phase=phase;
  const messages={
    briefing:['00 / SERVICE CALL','One small fault in the room.','TAKE THE JOB'],
    drawer:['01 / OPEN','Pull open the service drawer.','OPEN DRAWER'],
    probe:['02 / INSPECT','Pick up the probe from its cradle.','TAKE PROBE'],
    scan:['02 / INSPECT',heldProbe?'Hold the probe on the unstable part.':'Pick up the probe to continue inspecting.',heldProbe?(drawerTarget<.7?'REOPEN DRAWER':'HOLD TO INSPECT'):'TAKE PROBE'],
    extract:['03 / EXTRACT','The regulator is solid. Pull it free.','EXTRACT PART'],
    install:['04 / INSTALL',heldPart?'Seat the regulator in the brass socket.':'Retrieve the regulator from the drawer.',heldPart?'INSTALL PART':'RETRIEVE PART'],
    calibrate:['05 / ALIGN','Tune depth, phase, and gain. Find a quiet signal.','SELECT CHANNEL'],
    test:['06 / TEST','Signal locked. Press the red button.','TEST THE ROOM'],
    testing:['06 / TEST','Reconstituting the room. Please remain yourself.','TEST IN PROGRESS'],
    complete:['0418 / FOLLOW-UP','A little shop has appeared inside the drawer.','TOUCH MINIATURE'],
  };
  const m=messages[phase];$('phase').textContent=m[0];$('instruction').textContent=m[1];
  $('action').textContent=m[2];$('action').disabled=job.testing;
  $('secondary').hidden=!(heldProbe||heldPart||job.complete);
  $('secondary').textContent=job.complete?'NEW SHIFT':heldPart?'RETURN PART':'DOCK PROBE';
  $('stamp').textContent=job.complete?'REPAIR ACCEPTED':job.testing?'TEST IN PROGRESS':job.begun?'TECHNICIAN ON SITE':'AWAITING TECHNICIAN';
  const done={drawer:job.opened,scan:job.revealed,part:job.extracted,install:job.installed,calibrate:job.calibrated,test:job.complete};
  const active=phase==='probe'?'scan':phase==='extract'?'part':phase==='testing'?'test':phase;
  for(const key of completedSteps){const li=document.querySelector(`[data-step="${key}"]`);li.classList.toggle('done',done[key]);li.classList.toggle('active',key===active);}
  $('scan-meter').hidden=phase!=='scan'||!heldProbe;
  $('calibration').hidden=phase!=='calibrate';
  $('control-hint').textContent=phase==='calibrate'?'DRAG DIALS · 1–3 SELECT · ← → TUNE':'CLICK OBJECTS · E TO INTERACT · DRAG TO LOOK';
  updateCalibrationUI();
  updateScreen();
}

function pick(origin,direction) {
  raycaster.set(origin,direction);
  const valid=hits.filter(o=>{
    const id=o.userData.id;
    if(id==='probe')return !heldProbe;
    if(id==='part')return part.visible&&!heldPart&&!job.installed;
    if(id==='fault')return job.drawer>.55&&!job.extracted;
    if(id.startsWith('dial-'))return job.phase==='calibrate';
    if(id==='miniature')return job.complete&&miniature.visible;
    return true;
  });
  return raycaster.intersectObjects(valid,false)[0]??null;
}
function pointerHit() {raycaster.setFromCamera(pointer.ndc,camera);return pick(raycaster.ray.origin.clone(),raycaster.ray.direction.clone());}
function setPointer(e){pointer.ndc.set(e.clientX/innerWidth*2-1,-e.clientY/innerHeight*2+1);}
function controllerRay(c) {
  c.ray.updateWorldMatrix(true,false);
  return {origin:new V().setFromMatrixPosition(c.ray.matrixWorld),dir:new V(0,0,-1).transformDirection(c.ray.matrixWorld)};
}
function setupXR() {
  // Local geometric controllers avoid network-fetched controller profiles.
  for(let i=0;i<2;i++){
    const ray=renderer.xr.getController(i),grip=renderer.xr.getControllerGrip(i);
    scene.add(ray,grip);
    const handle=new THREE.Mesh(new THREE.CapsuleGeometry(.021,.075,3,8),new THREE.MeshStandardMaterial({color:0x303c35,roughness:.65}));
    handle.rotation.x=Math.PI/2;grip.add(handle);
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V(),new V(0,0,-1)]),new THREE.LineBasicMaterial({color:0xe1d5a1,transparent:true,opacity:.45}));
    ray.add(line);const c={ray,grip,line,source:null,hit:null,scanning:false,dragging:null,tuning:null};controllers.push(c);
    ray.addEventListener('connected',e=>{c.source=e.data;});
    ray.addEventListener('disconnected',()=>{
      if(heldProbe?.ctl===c)dockProbe(false);if(heldPart?.ctl===c)returnPart();c.source=null;c.dragging=null;c.tuning=null;c.scanning=false;
    });
    ray.addEventListener('selectstart',()=>{
      if(heldProbe?.ctl===c){c.scanning=true;sound.unlock();return;}
      if(heldPart?.ctl===c&&c.hit?.object.userData.id==='socket'){installPart(c);return;}
      interact(c.hit?.object.userData.id,c);
    });
    ray.addEventListener('selectend',()=>{c.scanning=false;});
    ray.addEventListener('squeezestart',()=>{
      if(!job.begun)return startJob();
      if(heldProbe?.ctl===c||heldPart?.ctl===c)return;
      const id=c.hit?.object.userData.id;
      if(id?.startsWith('dial-')&&job.phase==='calibrate'){
        selectedDial=Number(id.slice(-1));
        c.tuning={index:selectedDial,value:job.dials[selectedDial],q:c.grip.getWorldQuaternion(new THREE.Quaternion())};
        haptic(c,.18,35);
      }else if(id==='drawer'){
        const local=root.worldToLocal(c.grip.getWorldPosition(new V()));
        c.dragging={start:local.z,open:drawerOpen};haptic(c,.2,40);
      }else if(id==='probe')grabProbe(c);else if(id==='part'||(id==='fault'&&job.revealed))grabPart(c);
    });
    ray.addEventListener('squeezeend',()=>{
      c.tuning=null;
      if(c.dragging){drawerTarget=drawerTarget>.5?1:0;c.dragging=null;}
      if(heldProbe?.ctl===c)dockProbe();
      if(heldPart?.ctl===c){
        const pos=root.worldToLocal(part.getWorldPosition(new V()));
        if(pos.distanceTo(socketPos)<.17)installPart(c);else returnPart();
      }
    });
  }
  new SparkXr({renderer,element:$('vr'),mode:'vr',referenceSpaceType:'local-floor',enableHands:false,
    frameBufferScaleFactor:.85,fixedFoveation:.6,
    onReady:ok=>{$('vr').hidden=!ok;$('vr').textContent='ENTER VR';},
    onEnterXr:()=>{
      $('vr').textContent='EXIT VR';recenterFrames=10;
      if(heldProbe)dockProbe(false);if(heldPart)returnPart();
      controllers.forEach(c=>{c.tuning=null;c.dragging=null;c.scanning=false;});
      spark.apertureAngle=0;
    },
    onExitXr:()=>{
      $('vr').textContent='ENTER VR';if(heldProbe)dockProbe(false);if(heldPart)returnPart();
      controllers.forEach(c=>{c.tuning=null;c.dragging=null;c.scanning=false;});
      root.position.set(0,0,0);root.rotation.set(0,0,0);
    },
  });
}
let recenterFrames=0;
function recenter() {if(renderer.xr.isPresenting)recenterFrames=2;else{look.targetX=0;look.targetY=0;}sound.click();}
function applyRecenter() {
  const head=renderer.xr.getCamera(),pos=head.getWorldPosition(new V());
  const forward=new V(0,0,-1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  root.rotation.y=Math.atan2(-forward.x,-forward.z);
  root.position.copy(pos).sub(new V(0,1.3633,0));root.updateMatrixWorld(true);
}

function updateInput(dt) {
  scanActive=false;hover=null;
  if(renderer.xr.isPresenting){
    if(recenterFrames>0&&--recenterFrames===0)applyRecenter();
    for(const c of controllers){
      if(!c.source)continue;
      const r=controllerRay(c);c.hit=pick(r.origin,r.dir);c.line.scale.z=c.hit?.distance??2;
      c.line.visible=!(heldProbe?.ctl===c);
      if(c.hit)hover=c.hit.object.userData.id;
      if(c.dragging){const local=root.worldToLocal(c.grip.getWorldPosition(new V()));drawerTarget=clamp(c.dragging.open+(local.z-c.dragging.start)/.32,0,1);}
      if(c.tuning){
        const delta=c.tuning.q.clone().invert().multiply(c.grip.getWorldQuaternion(new THREE.Quaternion()));
        const angle=2*Math.atan2(delta.z,delta.w);
        setDial(c.tuning.index,c.tuning.value-angle/(Math.PI*1.35),c);
      }
      if(heldProbe?.ctl===c&&c.scanning){
        const fp=fault.getWorldPosition(new V()),along=fp.clone().sub(r.origin).dot(r.dir);
        const distance=r.origin.clone().addScaledVector(r.dir,Math.max(0,along)).distanceTo(fp);
        scanActive=along>0&&distance<.22&&job.drawer>.7;
        updateBeam(r.origin.clone(),r.origin.clone().addScaledVector(r.dir,Math.min(2,Math.max(.15,along))));
      }
    }
  }else{
    const hit=pointerHit();hover=hit?.object.userData.id??null;
    const holding=buttonScan||keyboardScan||pointer.down&&pointer.scanning;
    scanActive=!!heldProbe&&holding&&job.drawer>.7&&(buttonScan||keyboardScan||hover==='fault'||hover==='part'||hover==='drawer');
    if(heldProbe&&holding){
      const p=probe.localToWorld(new V(0,.09,-.055));
      updateBeam(p,scanActive?fault.getWorldPosition(new V()):raycaster.ray.at(1.3,new V()));
    }
    document.body.style.cursor=hover?'pointer':pointer.down?'grabbing':'default';
  }
  if(!heldProbe||!scanActive&&!buttonScan&&!keyboardScan&&!controllers.some(c=>c.scanning)&&!pointer.scanning)beam.visible=false;
  if(scanActive&&job.phase==='scan'){
    scanBeep-=dt;if(scanBeep<=0){sound.tone(220+job.scan*750,.055,'sine',.1);haptic(heldProbe?.ctl,.1,25);scanBeep=.18;}
  }
  if(job.inspect(dt,scanActive)){
    part.visible=true;sound.success();haptic(heldProbe?.ctl,.65,160);toast('Fault isolated. The brass regulator is now solid enough to grab.');refreshUI();
  }
  const labels={drawer:'DRAWER · click or pull down',probe:'INSPECTION PROBE · pick up',part:'DEPTH REGULATOR · take',fault:job.revealed?'REGULATOR · take':'UNSTABLE MATTER · hold probe to inspect',socket:heldPart?'SOCKET · install regulator':'REGULATOR SOCKET',test:job.calibrated?'ROOM TEST · press':'ROOM TEST · requires signal lock',miniature:'THE LITTLE SHOP · touch',recenter:'RECENTER VIEW'};
  const hint=hover?.startsWith('dial-')?`${dialNames[Number(hover.slice(-1))]} · drag sideways to tune`:labels[hover];
  $('object-hint').hidden=!hint||!job.begun||job.testing||$('ending').hidden===false;
  if(hint)$('object-hint').textContent=hint;
}
function updateBeam(from,to){beam.visible=true;const a=beam.geometry.attributes.position;a.setXYZ(0,...from.toArray());a.setXYZ(1,...to.toArray());a.needsUpdate=true;beam.geometry.computeBoundingSphere();}

const canvas=renderer.domElement;
canvas.addEventListener('pointerdown',e=>{
  setPointer(e);pointer.down=true;pointer.dragged=false;pointer.x0=pointer.x=e.clientX;pointer.y0=pointer.y=e.clientY;
  pointer.scanning=!!heldProbe&&!job.revealed;pointer.drawerDrag=false;
  pointer.dialDrag=null;
  const hit=ready?pointerHit():null;
  if(hit?.object.userData.id==='drawer'&&!heldProbe){pointer.drawerDrag=true;pointer.drawerStart=drawerOpen;}
  if(hit?.object.userData.id.startsWith('dial-')){selectedDial=Number(hit.object.userData.id.slice(-1));pointer.dialDrag={index:selectedDial,value:job.dials[selectedDial]};}
  canvas.setPointerCapture(e.pointerId);sound.unlock();
});
canvas.addEventListener('pointermove',e=>{
  setPointer(e);if(!pointer.down)return;
  const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
  if(Math.hypot(e.clientX-pointer.x0,e.clientY-pointer.y0)>7)pointer.dragged=true;
  if(pointer.dialDrag){setDial(pointer.dialDrag.index,pointer.dialDrag.value+(e.clientX-pointer.x0)/240);}
  else if(pointer.dragged&&pointer.drawerDrag){drawerTarget=clamp(pointer.drawerStart+(e.clientY-pointer.y0)/180,0,1);}
  else if(pointer.dragged&&!pointer.scanning){look.targetX=clamp(look.targetX-dx*.002,-.5,.5);look.targetY=clamp(look.targetY+dy*.002,-.32,.25);}
  pointer.x=e.clientX;pointer.y=e.clientY;
});
canvas.addEventListener('pointerup',e=>{
  setPointer(e);const scan=pointer.scanning;
  if(pointer.dialDrag){/* Rotation already follows pointer movement. */}
  else if(pointer.drawerDrag&&pointer.dragged){drawerTarget=drawerTarget>.5?1:0;}
  else if(!pointer.dragged&&!scan&&ready)interact(pointerHit()?.object.userData.id);
  pointer.down=false;pointer.scanning=false;pointer.drawerDrag=false;pointer.dialDrag=null;
});
canvas.addEventListener('pointercancel',()=>{pointer.down=false;pointer.scanning=false;pointer.drawerDrag=false;pointer.dialDrag=null;});
canvas.addEventListener('wheel',e=>{if(job.phase!=='calibrate')return;setPointer(e);const id=pointerHit()?.object.userData.id;if(id?.startsWith('dial-')){e.preventDefault();const i=Number(id.slice(-1));setDial(i,job.dials[i]-Math.sign(e.deltaY)*.015);}},{passive:false});
window.addEventListener('blur',()=>{pointer.down=false;pointer.scanning=false;pointer.dialDrag=null;buttonScan=false;keyboardScan=false;controllers.forEach(c=>{c.scanning=false;c.tuning=null;c.dragging=null;});});
$('start').addEventListener('click',startJob);$('restart').addEventListener('click',resetJob);
$('investigate').addEventListener('click',investigate);
$('secondary').addEventListener('click',()=>job.complete?resetJob():heldPart?returnPart():dockProbe());
$('order').addEventListener('click',()=>{const open=document.body.classList.toggle('show-order');$('order').setAttribute('aria-expanded',String(open));});
for(let i=0;i<3;i++)$(`dial-${i}`).addEventListener('input',e=>setDial(i,Number(e.target.value)/100));
$('action').addEventListener('pointerdown',e=>{
  if(job.phase==='scan'&&heldProbe&&drawerTarget>.7){buttonScan=true;scanGesture=true;sound.unlock();$('action').setPointerCapture(e.pointerId);}
});
$('action').addEventListener('pointerup',()=>{buttonScan=false;});
$('action').addEventListener('pointercancel',()=>{buttonScan=false;scanGesture=false;});
$('action').addEventListener('click',()=>{if(scanGesture){scanGesture=false;return;}primaryAction();});
$('sound').addEventListener('click',()=>{sound.unlock();const on=sound.toggle();$('sound').textContent=on?'SOUND ON':'SOUND OFF';$('sound').setAttribute('aria-pressed',String(on));});
addEventListener('keydown',e=>{
  if(!ready||e.repeat||/INPUT|TEXTAREA/.test(e.target.tagName))return;
  if(e.code==='Space'&&job.phase==='scan'){e.preventDefault();keyboardScan=true;sound.unlock();}
  else if(job.phase==='calibrate'&&['Digit1','Digit2','Digit3'].includes(e.code)){selectedDial=Number(e.code.slice(-1))-1;updateCalibrationUI();}
  else if(job.phase==='calibrate'&&['ArrowLeft','ArrowRight'].includes(e.code)){e.preventDefault();setDial(selectedDial,job.dials[selectedDial]+(e.code==='ArrowRight'?.01:-.01));}
  else if(e.code==='KeyE'){e.preventDefault();primaryAction();}
  else if(e.code==='KeyR')resetJob();
  else if(e.code==='KeyF')recenter();
  else if(e.code==='Escape'){if(heldPart)returnPart();else if(heldProbe)dockProbe();}
});
addEventListener('keyup',e=>{if(e.code==='Space'){keyboardScan=false;e.preventDefault();}});
function fitScreen() {
  camera.aspect=innerWidth/innerHeight;
  camera.fov=Math.max(58,THREE.MathUtils.radToDeg(2*Math.atan(.54/camera.aspect)));
  camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);
}
addEventListener('resize',fitScreen);fitScreen();

function frame() {
  const now=performance.now(),elapsed=Math.max(0,(now-lastTime)/1000),dt=Math.min(elapsed,.05);lastTime=now;time+=dt;
  if(!ready)return;
  introBlend=damp(introBlend,1,1.5,dt);fx.u.intro.value=introBlend;
  root.updateMatrixWorld(true);
  updateInput(elapsed);
  drawerOpen=damp(drawerOpen,drawerTarget,8,dt);drawer.position.z=drawerOpen*.32;job.setDrawer(drawerOpen);
  if(!heldPart&&!job.installed)part.position.copy(partHome).add(new V(0,0,drawerOpen*.32));
  part.visible=job.revealed;
  extractionAge+=elapsed;echoAge+=elapsed;
  if(heldPart){
    heldPart.age+=elapsed;
    const goal=heldPart.ctl?new V(0,-.015,-.08):new V(.12,-.13,-.42);
    const a=clamp(heldPart.age/.65,0,1),ease=1-Math.pow(1-a,3);
    part.position.lerpVectors(heldPart.from,goal,ease);
    if(!heldPart.ctl&&a>=1)part.rotation.y+=dt*.2;
  }
  if(heldPart)tethers.update(fault.getWorldPosition(new V()),part.getWorldPosition(new V()),extractionAge,time);
  else tethers.mesh.visible=false;
  if(job.tickCalibration(elapsed)){sound.success();toast('All channels locked. Run the room test.');refreshUI();}
  if(job.phase==='calibrate'){
    updateCalibrationUI();calibrationTone-=dt;
    if(calibrationTone<=0&&(pointer.dialDrag||controllers.some(c=>c.tuning)||document.activeElement?.type==='range')){
      sound.tone(130+job.dials[selectedDial]*480,.055,'sine',.055);calibrationTone=.2;
    }
  }
  dials.forEach((dial,i)=>{dial.rotation.z=(.5-job.dials[i])*Math.PI*1.5;dialLights[i].material.color.setHex(!job.installed?0x343c30:job.channelLocks[i]?0xb6eda4:0xb0783c);});
  if(!renderer.xr.isPresenting){
    look.x=damp(look.x,look.targetX,7,dt);look.y=damp(look.y,look.targetY,7,dt);
    camera.position.set(0,1.3633,0);
    camera.lookAt(Math.sin(look.x)*2,.90-drawerOpen*.32+look.y,-2*Math.cos(look.x));
  }
  const fp=fault.getWorldPosition(new V());
  const localFault=root.worldToLocal(fp.clone());
  fx.u.stationDrawer.value=drawerOpen*.32;
  fx.u.t.value=time;fx.u.scan.value.set(localFault.x,localFault.y,localFault.z,scanActive?1:0);
  pullAmount=damp(pullAmount,heldPart?1:0,3,dt);
  fx.u.pull.value.set(localFault.x,localFault.y,localFault.z,pullAmount);
  repairBlend=damp(repairBlend,job.calibrated?1:0,1.7,dt);fx.u.repaired.value=repairBlend;
  fx.u.drift.value=job.phase==='calibrate'?1-job.signal:0;
  fx.u.echo.value=echoAge<2?Math.exp(-echoAge*2):0;
  key.intensity=1.65+(echoAge<2?Math.sin(echoAge*14)*.25*Math.exp(-echoAge*2):0);
  if(miniature.visible)miniature.rotation.y=Math.sin(time*.6)*.08;
  fx.u.test.value=job.testing?Math.pow(Math.sin(Math.min(1,job.testTime/3)*Math.PI),2)*.7:0;
  room.updateVersion();
  fault.visible=job.begun&&!job.extracted&&drawerOpen>.15;
  const extent=job.revealed?.28:1;
  for(let i=0;i<faultPositions.length/3;i++){
    const j=i*4,k=i*3,s=faultSeeds[j+3];
    faultPositions[k]=faultSeeds[j]*extent+Math.sin(time*1.7+s)*.012;
    faultPositions[k+1]=faultSeeds[j+1]*extent+Math.sin(time*2.3+s)*.018;
    faultPositions[k+2]=faultSeeds[j+2]*extent+Math.cos(time*1.5+s)*.012;
  }
  faultPoints.geometry.attributes.position.needsUpdate=true;faultPoints.geometry.computeBoundingSphere();
  faultPoints.material.opacity=job.revealed?.28:.50+job.scan*.3;
  ring.visible=(scanActive||!!heldPart)&&!job.testing;
  const focus=job.phase==='install'?socketPos:job.phase==='probe'?probeDock:job.phase==='test'?new V(-.28,1.03,-1.085):localFault;
  ring.position.copy(focus);ring.rotation.set(-.15,0,time*.15);ring.material.opacity=.28+Math.sin(time*3)*.12;
  if(job.testing){
    const s=Math.floor(job.testTime);
    if(s!==testSoundStage){testSoundStage=s;sound.tone(90+s*60,.25,'triangle',.2);}
    if(job.tick(elapsed)){
      sound.success();toast('Work order 0417 complete. A new ticket has arrived.');
      miniature.visible=true;drawerTarget=1;
      $('ending').hidden=false;$('controls').hidden=true;document.body.classList.add('ended');
      refreshUI();
    }
  }
  $('scan-fill').style.width=`${job.scan*100}%`;$('scan-percent').textContent=`${Math.floor(job.scan*100)}%`;
  if(job.phase!==lastPhase){lastPhase=job.phase;refreshUI();}
  updateScreen();
  if(toastUntil<now)$('toast').classList.remove('visible');
  renderer.render(scene,camera);
}

// Read-only diagnostics for development; normal input performs every action.
Object.defineProperty(window,'repairDebug',{get:()=>({phase:job.phase,drawer:drawerOpen,scan:job.scan,revealed:job.revealed,
  extracted:job.extracted,installed:job.installed,calibrated:job.calibrated,complete:job.complete,holdingProbe:!!heldProbe,holdingPart:!!heldPart,
  xr:renderer.xr.isPresenting,modelsReady:ready,splats:room?.packedSplats?.numSplats,
  drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
  activeSplats:spark.activeSplats,generatedProps:generatedPropsSnapshot(generatedProps),
  generatedStation:generatedStationSnapshot(generatedStation),
  generatedTerminal:generatedTerminalSnapshot(generatedTerminal),liveScreen:liveScreenSnapshot(consoleScreen,screenLines(),camera),
  hitTargets:hits.map(o=>{const p=o.getWorldPosition(new V()).project(camera);return {id:o.userData.id,x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2,z:p.z};}),
  dials:[...job.dials],channelLocks:[...job.channelLocks],echoAge,
})});
boot().catch(errorScreen);
