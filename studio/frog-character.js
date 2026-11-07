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
    this.time=0;this.paused=false;this.transition=1;this.playing='hello';this.lastUi=0;
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
    this.update(0);return this;
  }
  select(id){
    if(!this.clips.has(id))return;
    this.previous.set(this.blended);this.playing=id;this.time=0;this.transition=0;
    this.update(0);
  }
  seek(seconds){this.time=seconds;this.transition=1;this.update(0);}
  update(delta){
    if(!this.clips||!this.group.visible)return;
    if(!this.paused)this.time+=delta;
    this.transition=Math.min(1,this.transition+delta/.25);
    const clip=this.clips.get(this.playing);
    sampleClip(clip.data,clip,this.rig.numBones,this.time,this.pose);
    if(this.transition<1)blendPoses(this.previous,this.pose,this.transition,this.blended);else this.blended.set(this.pose);
    for(let i=0;i<this.rig.numBones;i++){
      const offset=i*10;
      this.position.fromArray(this.blended,offset);this.quaternion.fromArray(this.blended,offset+3);this.scale.fromArray(this.blended,offset+7);
      this.skinning.setBoneQuatPosScale(i,this.quaternion,this.position,this.scale);
    }
    this.skinning.updateBones();
  }
  get duration(){const c=this.clips?.get(this.playing);return c?c.frames/c.fps:4;}
  get label(){return this.clips?.get(this.playing)?.label??'Loading mechanic';}
}
