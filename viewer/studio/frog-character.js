import * as THREE from 'three';
import {SplatMesh,SplatSkinning,SplatSkinningMode} from './vendor/spark.module.js';
import {sampleClip,blendPoses} from './frog-skin-utils.mjs';

async function read(url,type){
  const response=await fetch(url);
  if(!response.ok)throw Error(`Frog asset failed (${response.status}): ${url}`);
  return type==='json'?response.json():response.arrayBuffer();
}

export class FrogCharacter {
  constructor(scene){
    this.group=new THREE.Group();this.group.name='Frog mechanic · live skinned splats';
    this.group.position.set(2.6,0,2.0);scene.add(this.group);
    this.time=0;this.paused=false;this.transition=1;this.playing='work';this.routineTime=0;this.near=false;this.lastUi=0;
    this.position=new THREE.Vector3();this.quaternion=new THREE.Quaternion();this.scale=new THREE.Vector3();
  }
  async load(){
    const url=new URL('./models/frog/rig.json',import.meta.url);
    this.rig=await read(url,'json');
    const r=this.rig;
    if(r.schema!=='frog-gaussian-rig/1'||r.numSplats!==65536||r.numBones>256)throw Error('Unsupported frog rig');
    const skinPromise=read(new URL(r.skin,url),'binary');
    const clipsPromise=Promise.all(r.clips.map(async clip=>{
      if(clip.bindSignature&&clip.bindSignature!==r.bindSignature)throw Error('Frog clip belongs to a different bind rig: '+clip.id);
      const data=new Float32Array(await read(new URL(clip.url,url),'binary'));
      if(data.length!==clip.frames*r.numBones*10||!data.every(Number.isFinite))throw Error('Invalid frog clip: '+clip.id);
      return {...clip,data};
    }));
    this.mesh=new SplatMesh({url:new URL(r.rest,url).href,extSplats:true,covSplats:true,lod:false,enableLod:false,raycastable:false});
    this.mesh.name='Frog · 65,536 animated Gaussians';this.mesh.position.y=r.groundOffset;
    this.mesh.frustumCulled=false;this.group.add(this.mesh);
    await this.mesh.initialized;
    if(this.mesh.numSplats!==r.numSplats)throw Error('Frog Gaussian count mismatch');
    const weights=new Uint16Array(await skinPromise);
    if(weights.length!==r.numSplats*4)throw Error('Frog skin weight count mismatch');
    this.skinning=new SplatSkinning({mesh:this.mesh,numSplats:r.numSplats,numBones:r.numBones,mode:SplatSkinningMode.LINEAR_BLEND});
    for(let i=0;i<r.numBones;i++)this.skinning.setRestMatrix(i,new THREE.Matrix4());
    this.skinning.skinData.set(weights);this.skinning.skinTexture.needsUpdate=true;
    this.mesh.skinning=this.skinning;this.mesh.updateGenerator();
    this.clips=new Map((await clipsPromise).map(c=>[c.id,c]));
    this.pose=new Float32Array(r.numBones*10);this.blended=new Float32Array(this.pose.length);this.previous=new Float32Array(this.pose.length);
    for(const [id,label] of [['work','Tool work'],['look','Look around']])this.clips.set(id,{...this.clips.get('idle'),id,label});
    this.rig.clips.push(...['work','look'].map(id=>this.clips.get(id)));
    const metal=new THREE.MeshStandardMaterial({color:0x657477,metalness:.65,roughness:.4});
    this.tool=new THREE.Group();
    const handle=new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,.24,8),new THREE.MeshStandardMaterial({color:0x8a4530}));handle.position.y=.08;
    const head=new THREE.Mesh(new THREE.BoxGeometry(.15,.05,.055),metal);head.position.y=.21;
    this.tool.add(handle,head);this.group.add(this.tool);
    this.update(0);return this;
  }
  select(id){
    if(!this.clips.has(id))return;
    this.previous.set(this.blended);this.playing=id;this.time=0;this.transition=0;
    this.update(0);
  }
  approach(position,active){
    if(!this.clips)return;
    const d=Math.hypot(position.x-this.group.position.x,position.z-this.group.position.z);
    if(active&&!this.near&&d<2){this.near=true;this.paused=false;this.select('hello');}
    else if(this.near&&(!active||d>2.7)){this.near=false;this.routineTime=0;this.select('work');}
  }
  rotateJoint(name,axis,angle){
    const index=this.rig.bones.findIndex(b=>b.name.endsWith(':'+name));if(index<0)return;
    const rest=new THREE.Matrix4().fromArray(this.rig.bones[index].restMatrix);
    const skin=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(this.pose,index*10),new THREE.Quaternion().fromArray(this.pose,index*10+3),new THREE.Vector3().fromArray(this.pose,index*10+7));
    const pivot=new THREE.Vector3().setFromMatrixPosition(rest).applyMatrix4(skin);
    const rotation=new THREE.Matrix4().makeTranslation(...pivot.toArray()).multiply(new THREE.Matrix4().makeRotationAxis(axis,angle)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
    for(let i=0;i<this.rig.numBones;i++){
      let j=i;while(j>=0&&j!==index)j=this.rig.bones[j].parent;
      if(j!==index)continue;
      const o=i*10,m=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(this.pose,o),new THREE.Quaternion().fromArray(this.pose,o+3),new THREE.Vector3().fromArray(this.pose,o+7));
      rotation.clone().multiply(m).decompose(this.position,this.quaternion,this.scale);this.position.toArray(this.pose,o);this.quaternion.toArray(this.pose,o+3);this.scale.toArray(this.pose,o+7);
    }
  }
  seek(seconds){this.time=seconds;this.transition=1;this.update(0);}
  update(delta){
    if(!this.clips||!this.group.visible)return;
    if(!this.paused)this.time+=delta;
    this.transition=Math.min(1,this.transition+delta/.25);
    if(!this.near&&!this.paused&&['work','look'].includes(this.playing)){this.routineTime+=delta;if(this.routineTime>8){this.routineTime=0;this.select(this.playing==='work'?'look':'work');}}
    const clip=this.clips.get(this.playing);
    sampleClip(clip.data,clip,this.rig.numBones,this.time,this.pose);
    const x=new THREE.Vector3(1,0,0),y=new THREE.Vector3(0,1,0),z=new THREE.Vector3(0,0,1);
    if(this.playing==='look'){this.rotateJoint('Neck',y,.45*Math.sin(this.time*Math.PI/2));this.rotateJoint('Head',x,.10*Math.sin(this.time*Math.PI));}
    if(this.playing==='work'){this.rotateJoint('RightArm',z,-.45);this.rotateJoint('RightForeArm',x,-.8+.30*Math.sin(this.time*Math.PI*3));this.rotateJoint('Head',x,.22);}
    if(this.transition<1)blendPoses(this.previous,this.pose,this.transition,this.blended);else this.blended.set(this.pose);
    for(let i=0;i<this.rig.numBones;i++){
      const offset=i*10;
      this.position.fromArray(this.blended,offset);this.quaternion.fromArray(this.blended,offset+3);this.scale.fromArray(this.blended,offset+7);
      this.skinning.setBoneQuatPosScale(i,this.quaternion,this.position,this.scale);
    }
    this.skinning.updateBones();
    this.tool.visible=this.playing==='work';
    const hand=this.rig.bones.findIndex(b=>b.name.endsWith(':RightHand')),o=hand*10;
    const handMatrix=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(this.blended,o),new THREE.Quaternion().fromArray(this.blended,o+3),new THREE.Vector3().fromArray(this.blended,o+7)).multiply(new THREE.Matrix4().fromArray(this.rig.bones[hand].restMatrix));
    handMatrix.decompose(this.tool.position,this.tool.quaternion,this.tool.scale);this.tool.scale.setScalar(1);this.tool.position.y+=this.rig.groundOffset;
  }
  get duration(){const c=this.clips?.get(this.playing);return c?c.frames/c.fps:4;}
  get label(){return this.clips?.get(this.playing)?.label??'Loading mechanic';}
}
