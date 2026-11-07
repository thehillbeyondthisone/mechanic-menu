import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';

/** Replace appearances only; existing GLB roots keep all grips, hitboxes and rules. */
export async function attachGeneratedProps({probe,part}) {
  const roots={probe,regulator:part};
  if(new URLSearchParams(location.search).get('props')==='original')return {mode:'original',visuals:[],error:null};
  const visuals=[];
  try {
    const response=await fetch('./assets/triposplat-pilot/props.json');
    if(!response.ok)throw new Error(`Prop manifest HTTP ${response.status}`);
    const config=await response.json();
    await Promise.all(config.assets.map(async a=>{
      const visual=new THREE.Group();visual.name=`TripoSplat-${a.id}`;
      const mesh=new SplatMesh({url:`./assets/triposplat-pilot/${a.file}`,lod:false,raycastable:false});
      mesh.name=`${a.id}-65536`;mesh.rotation.x=Math.PI;visual.rotation.y=a.yaw;visual.add(mesh);
      const entry={id:a.id,root:roots[a.id],visual,mesh,config:a};visuals.push(entry);
      await mesh.initialized;
      if(mesh.numSplats!==65536)throw new Error(`${a.id}: unexpected splat count ${mesh.numSplats}`);
      mesh.updateMatrix();visual.updateMatrix();
      const box=new THREE.Box3(new THREE.Vector3(...a.min),new THREE.Vector3(...a.max))
        .applyMatrix4(mesh.matrix).applyMatrix4(visual.matrix);
      const size=box.getSize(new THREE.Vector3());
      const scale=Math.min(...a.fitSize.map((limit,i)=>limit/size.getComponent(i)));
      visual.scale.setScalar(scale);
      visual.position.fromArray(a.center).sub(box.getCenter(new THREE.Vector3()).multiplyScalar(scale));
      entry.scale=scale;
    }));
    // Commit both visuals together. Hitboxes are added by main.js after this call.
    for(const e of visuals){
      e.root.traverse(o=>{if(o.isMesh||o.isPoints||o.isLine)o.visible=false;});
      e.root.add(e.visual);
    }
    return {mode:'triposplat',visuals,error:null};
  } catch(error) {
    for(const e of visuals){e.visual.removeFromParent();e.mesh.dispose();}
    console.warn('Generated prop appearance unavailable; retaining original GLB visuals.',error);
    return {mode:'original-fallback',visuals:[],error:String(error)};
  }
}

export function generatedPropsSnapshot(state) {
  return {mode:state?.mode??'loading',error:state?.error??null,assets:(state?.visuals??[]).map(e=>({
    id:e.id,splats:e.mesh.numSplats,rootName:e.root.name,parent:e.root.parent?.name||e.root.parent?.type,
    visible:e.root.visible,scale:e.scale,position:e.root.position.toArray(),
    finite:[...e.root.position.toArray(),...e.root.quaternion.toArray(),...e.visual.scale.toArray()].every(Number.isFinite),
  }))};
}
