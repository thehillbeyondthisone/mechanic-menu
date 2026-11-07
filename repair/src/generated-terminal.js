import * as THREE from 'three';
import {SplatMesh,dyno} from '@sparkjsdev/spark';

function screenAperture(scale,offset){
  const vector=v=>`vec3(${v.toArray().map(n=>Number(n).toFixed(9)).join(',')})`;
  return dyno.dynoBlock({gsplat:dyno.Gsplat},{gsplat:dyno.Gsplat},({gsplat})=>{
    const d=new dyno.Dyno({inTypes:{gsplat:dyno.Gsplat},outTypes:{gsplat:dyno.Gsplat},statements:({inputs:i,outputs:o})=>dyno.unindentLines(`
      ${o.gsplat}=${i.gsplat};
      vec3 p=vec3(${i.gsplat}.center.z,-${i.gsplat}.center.y,${i.gsplat}.center.x)*${vector(scale)}+${vector(offset)};
      // The authored canvas remains opaque, live and slightly in front of the bezel.
      // Clear front-facing inferred geometry inside its opening; retain rear shell.
      if(abs(p.x+.18)<.157 && abs(p.y-1.15)<.101 && p.z>-.075) ${o.gsplat}.rgba.a=0.;
      // Faint source floaters must not expand the fitted physical envelope.
      if(p.y>1.283 || p.y<.977 || p.x<-.378 || p.x>.018) ${o.gsplat}.rgba.a=0.;
    `)});return {gsplat:d.apply({gsplat}).gsplat};
  });
}

export async function attachGeneratedTerminal({station,miniature,screen}){
  const query=new URLSearchParams(location.search);
  if(['terminal','station','props'].some(k=>query.get(k)==='original'))return {mode:'original',mesh:null,visual:null,error:null};
  let mesh,visual;const hidden=[];
  try{
    const response=await fetch('./assets/triposplat-terminal/terminal.json');if(!response.ok)throw new Error('Terminal manifest HTTP '+response.status);
    const a=await response.json();
    mesh=new SplatMesh({url:'./assets/triposplat-terminal/'+a.file,extSplats:true,covSplats:true,lod:false,raycastable:false});await mesh.initialized;
    if(mesh.numSplats!==65536)throw new Error('Unexpected housing splat count');
    visual=new THREE.Group();visual.name='TripoSplat-TerminalHousing';const axes=new THREE.Group();axes.rotation.y=-Math.PI/2;mesh.rotation.x=Math.PI;axes.add(mesh);visual.add(axes);
    mesh.updateMatrix();axes.updateMatrix();
    const box=new THREE.Box3(new THREE.Vector3(...a.fitMin),new THREE.Vector3(...a.fitMax)).applyMatrix4(mesh.matrix).applyMatrix4(axes.matrix);
    const scale=new THREE.Vector3(...a.targetSize).divide(box.getSize(new THREE.Vector3()));visual.scale.copy(scale);visual.position.fromArray(a.center).sub(box.getCenter(new THREE.Vector3()).multiply(scale));
    mesh.objectModifier=screenAperture(scale,visual.position);
    const inMiniature=o=>{for(let p=o;p;p=p.parent)if(p===miniature)return true;return false;};
    station.traverse(o=>{if(o.isMesh&&!inMiniature(o)&&/^(TerminalBody|TerminalBezel|TerminalStand)/.test(o.name))hidden.push(o);});
    if(hidden.length!==3)throw new Error('Expected three authored terminal meshes; retained originals');
    if(!screen?.material?.map?.image)throw new Error('Original live canvas missing; retained originals');
    for(const o of hidden)o.visible=false;station.add(visual);
    return {mode:'triposplat',mesh,visual,error:null,hiddenNames:hidden.map(o=>o.name),scale:scale.toArray()};
  }catch(error){
    for(const o of hidden)o.visible=true;visual?.removeFromParent();mesh?.dispose();
    console.warn('Terminal housing unavailable; retaining original live terminal.',error);
    return {mode:'original-fallback',mesh:null,visual:null,error:String(error)};
  }
}

export function generatedTerminalSnapshot(state){return {mode:state?.mode??'loading',error:state?.error??null,splats:state?.mesh?.numSplats??0,transformMode:state?.mesh?.covSplats?'covariance':null,hiddenNames:state?.hiddenNames??[],scale:state?.scale??null};}

export function liveScreenSnapshot(screen,lines,camera){
  if(!screen)return null;
  const c=screen.material.map.image,w=screen.geometry.parameters.width,h=screen.geometry.parameters.height;
  const corners=[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([x,y])=>{const p=screen.localToWorld(new THREE.Vector3(x,y,0)).project(camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};});
  return {visible:screen.visible,localPosition:screen.position.toArray(),worldPosition:screen.getWorldPosition(new THREE.Vector3()).toArray(),size:[w,h],canvas:[c.width,c.height],textureVersion:screen.material.map.version,lines,corners};
}
