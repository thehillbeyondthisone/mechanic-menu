import * as THREE from 'three';
import {SplatMesh,dyno} from '@sparkjsdev/spark';

function fit(mesh,a){
  const outer=new THREE.Group(),axes=new THREE.Group();outer.name='StationSplat-'+a.id;
  axes.rotation.y=-Math.PI/2;mesh.rotation.x=Math.PI;axes.add(mesh);outer.add(axes);
  mesh.updateMatrix();axes.updateMatrix();
  const box=new THREE.Box3(new THREE.Vector3(...(a.fitMin??a.min)),new THREE.Vector3(...(a.fitMax??a.max))).applyMatrix4(mesh.matrix).applyMatrix4(axes.matrix);
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const scale=new THREE.Vector3(...a.targetSize).divide(size);
  outer.scale.copy(scale);outer.position.fromArray(a.center).sub(center.multiply(scale));
  return {outer,scale,offset:outer.position.clone()};
}

// Preserve the exact authored drawer travel volume. No source PLY edits.
function cabinetOpening(scale,offset){
  const vec=v=>`vec3(${v.toArray().map(n=>Number(n).toFixed(9)).join(',')})`;
  return dyno.dynoBlock({gsplat:dyno.Gsplat},{gsplat:dyno.Gsplat},({gsplat})=>{
    const d=new dyno.Dyno({inTypes:{gsplat:dyno.Gsplat},outTypes:{gsplat:dyno.Gsplat},statements:({inputs:i,outputs:o})=>dyno.unindentLines(`
      ${o.gsplat}=${i.gsplat};
      vec3 p=vec3(${i.gsplat}.center.z,-${i.gsplat}.center.y,${i.gsplat}.center.x)*${vec(scale)}+${vec(offset)};
      if(p.y>0.986 || p.y< -0.006) ${o.gsplat}.rgba.a=0.0;
      if(abs(p.x)<0.356 && p.y>0.635 && p.y<0.854 && p.z>-0.167) ${o.gsplat}.rgba.a=0.0;
    `)});return {gsplat:d.apply({gsplat}).gsplat};
  });
}

/** Cosmetic layer only. Called AFTER the existing mesh-only miniature is made. */
export async function attachGeneratedStation({station,drawer,dials,miniature}){
  const query=new URLSearchParams(location.search);
  if(query.get('station')==='original'||query.get('props')==='original')return {mode:'original',visuals:[],error:null};
  const visuals=[],loads=[],hidden=[];
  try{
    const response=await fetch('./assets/triposplat-station/station.json');if(!response.ok)throw new Error('Station manifest HTTP '+response.status);
    const config=await response.json();
    for(const a of config.assets){
      const mesh=new SplatMesh({url:'./assets/triposplat-station/'+a.file,extSplats:true,covSplats:true,lod:false,raycastable:false});
      loads.push({a,mesh});
    }
    const results=await Promise.allSettled(loads.map(e=>e.mesh.initialized));
    const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    for(const {a,mesh} of loads){
      if(mesh.numSplats!==65536)throw new Error(a.id+' count mismatch');
      if(a.id==='dial'){
        for(let i=0;i<dials.length;i++){
          const instance=i===0?mesh:new SplatMesh({extSplats:mesh.extSplats,covSplats:true,lod:false,raycastable:false});
          await instance.initialized;const f=fit(instance,a);
          visuals.push({id:['depth','phase','gain'][i],root:dials[i],mesh:instance,...f});
        }
      }else{
        const f=fit(mesh,a);if(a.id==='cabinet')mesh.objectModifier=cabinetOpening(f.scale,f.offset);
        visuals.push({id:a.id,root:a.id==='cabinet'?station:drawer,mesh,...f});
      }
    }
    const insideMini=o=>{for(let p=o;p;p=p.parent)if(p===miniature)return true;return false;};
    const fixed=/^(Worktop|CalibrationApron|ApronScrew|CabinetSide|CabinetBack|Leg|FrontLeg|Rail|LowerShelf)/;
    const moving=/^(DrawerFront|DrawerFloor|DrawerWall|DrawerBack|DrawerHandle|HandleMount|DrawerPlate)/;
    station.traverse(o=>{if(o.isMesh&&!insideMini(o)&&(fixed.test(o.name)||moving.test(o.name)))hidden.push(o);});
    for(const dial of dials)dial.traverse(o=>{if(o.isMesh)hidden.push(o);});
    for(const o of hidden)o.visible=false;
    for(const v of visuals)v.root.add(v.outer);
    return {mode:'triposplat',visuals,error:null,hiddenNames:hidden.map(o=>o.name),miniatureMode:'original mesh-only'};
  }catch(error){
    for(const o of hidden)o.visible=true;
    for(const v of visuals)v.outer.removeFromParent();
    const disposed=new Set();for(const {mesh} of loads)if(!disposed.has(mesh.extSplats)){disposed.add(mesh.extSplats);mesh.dispose();}
    console.warn('Station splats unavailable; keeping original station mechanisms and visuals.',error);
    return {mode:'original-fallback',visuals:[],error:String(error)};
  }
}

export function generatedStationSnapshot(state){
  return {mode:state?.mode??'loading',error:state?.error??null,miniatureMode:state?.miniatureMode,
    assets:(state?.visuals??[]).map(v=>({id:v.id,splats:v.mesh.numSplats,transformMode:v.mesh.covSplats?'covariance':'uniform',rootName:v.root.name,rootPosition:v.root.position.toArray(),rootRotation:v.root.rotation.toArray().slice(0,3),scale:v.scale.toArray(),finite:[...v.root.position.toArray(),...v.root.quaternion.toArray(),...v.scale.toArray()].every(Number.isFinite)}))};
}
