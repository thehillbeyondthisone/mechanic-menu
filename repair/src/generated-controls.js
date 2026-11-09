import * as THREE from 'three';
import {SplatMesh,dyno} from '@sparkjsdev/spark';

function socketOpening(scale,offset){
  const vec=v=>`vec3(${v.toArray().map(n=>Number(n).toFixed(9)).join(',')})`;
  return dyno.dynoBlock({gsplat:dyno.Gsplat},{gsplat:dyno.Gsplat},({gsplat})=>{
    const d=new dyno.Dyno({inTypes:{gsplat:dyno.Gsplat},outTypes:{gsplat:dyno.Gsplat},statements:({inputs:i,outputs:o})=>dyno.unindentLines(`
      ${o.gsplat}=${i.gsplat};
      vec3 p=vec3(${i.gsplat}.center.z,-${i.gsplat}.center.y,${i.gsplat}.center.x)*${vec(scale)}+${vec(offset)};
      // Reserve the original cartridge travel/opening; keep the rear shell.
      if(abs(p.x-.265)<.056 && abs(p.y-1.125)<.048 && p.z>.151) ${o.gsplat}.rgba.a=0.;
    `)});return {gsplat:d.apply({gsplat}).gsplat};
  });
}

/** Appearance only. Attach after the original mesh-only miniature is cloned. */
export async function attachGeneratedControls({station,miniature}){
  const query=new URLSearchParams(location.search),visuals=[],loads=[],hidden=[];
  const original=['controls','station','props'].some(k=>query.get(k)==='original');
  if(original)return {mode:'original',visuals,error:null};
  try{
    const response=await fetch('./assets/triposplat-controls/controls.json');if(!response.ok)throw new Error('Controls manifest HTTP '+response.status);
    const config=await response.json();
    for(const a of config.assets){
      if(query.get(a.id==='socket'?'socket':'test')==='original')continue;
      const mesh=new SplatMesh({url:'./assets/triposplat-controls/'+a.file,extSplats:true,covSplats:true,lod:false,raycastable:false});loads.push({a,mesh});
    }
    const results=await Promise.allSettled(loads.map(v=>v.mesh.initialized));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    const inMini=o=>{for(let p=o;p;p=p.parent)if(p===miniature)return true;return false;};
    for(const {a,mesh} of loads){
      if(mesh.numSplats!==65536)throw new Error(a.id+' count mismatch');
      const outer=new THREE.Group(),axes=new THREE.Group();outer.name='TripoSplat-Control-'+a.id;axes.rotation.y=-Math.PI/2;mesh.rotation.x=Math.PI;axes.add(mesh);outer.add(axes);mesh.updateMatrix();axes.updateMatrix();
      const box=new THREE.Box3(new THREE.Vector3(...a.fitMin),new THREE.Vector3(...a.fitMax)).applyMatrix4(mesh.matrix).applyMatrix4(axes.matrix);
      const scale=new THREE.Vector3(...a.targetSize).divide(box.getSize(new THREE.Vector3()));outer.scale.copy(scale);outer.position.fromArray(a.center).sub(box.getCenter(new THREE.Vector3()).multiply(scale));
      if(a.id==='socket')mesh.objectModifier=socketOpening(scale,outer.position);
      const matches=[];station.traverse(o=>{if(o.isMesh&&!inMini(o)&&(a.id==='socket'?/^(SocketHousing|BrassSocketFrame|SocketScrew)/:/^TestButton/).test(o.name))matches.push(o);});
      if(matches.length!==(a.id==='socket'?7:2))throw new Error('Unexpected authored '+a.id+' mesh set: '+matches.length);
      hidden.push(...matches);visuals.push({id:a.id,mesh,outer,scale});
    }
    for(const o of hidden)o.visible=false;for(const v of visuals)station.add(v.outer);
    return {mode:visuals.length?'triposplat':'original',visuals,error:null,hiddenNames:hidden.map(o=>o.name)};
  }catch(error){
    for(const o of hidden)o.visible=true;for(const v of visuals)v.outer.removeFromParent();for(const {mesh} of loads)mesh.dispose();
    console.warn('Control splats unavailable; retaining original socket and TEST button.',error);
    return {mode:'original-fallback',visuals:[],error:String(error)};
  }
}

export function generatedControlsSnapshot(state){return {mode:state?.mode??'loading',error:state?.error??null,hiddenNames:state?.hiddenNames??[],assets:(state?.visuals??[]).map(v=>({id:v.id,splats:v.mesh.numSplats,transformMode:v.mesh.covSplats?'covariance':null,scale:v.scale.toArray(),finite:[...v.outer.position.toArray(),...v.scale.toArray()].every(Number.isFinite)}))};}
