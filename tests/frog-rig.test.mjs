import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sampleClip,blendPoses} from '../viewer/studio/frog-skin-utils.mjs';

const base=new URL('../viewer/studio/models/frog/',import.meta.url);
const rig=JSON.parse(readFileSync(new URL('rig.json',base),'utf8'));
const reference=JSON.parse(readFileSync(new URL('./fixtures/frog-skin-reference.json',import.meta.url),'utf8'));
function array(name,Type){const b=readFileSync(new URL(name,base));return new Type(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
const weights=array('skin.bin',Uint16Array);
const clips=new Map(rig.clips.map(c=>[c.id,{...c,data:array(c.url,Float32Array)}]));
function transform(p,trs,offset){
  const x=p[0]*trs[offset+7],y=p[1]*trs[offset+8],z=p[2]*trs[offset+9];
  const qx=trs[offset+3],qy=trs[offset+4],qz=trs[offset+5],qw=trs[offset+6];
  const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
  return [x+qw*tx+qy*tz-qz*ty+trs[offset],y+qw*ty+qz*tx-qx*tz+trs[offset+1],z+qw*tz+qx*ty-qy*tx+trs[offset+2]];
}

test('all 65K GPU skin entries refer to the 22-bone rig and sum to 255',()=>{
  assert.equal(weights.length,65536*4);assert.equal(rig.numBones,22);
  for(let i=0;i<weights.length;i+=4){let sum=0;for(let k=0;k<4;k++){sum+=weights[i+k]&255;assert.ok((weights[i+k]>>8)<22);}assert.equal(sum,255);}
});

test('web clip sampling matches independently exported Blender skin positions',()=>{
  const clip=clips.get('hello'),pose=new Float32Array(22*10);
  for(const [seconds,key] of [[0,'expectedFrame1'],[2,'expectedFrame49']]){
    sampleClip(clip.data,clip,22,seconds,pose);
    for(let i=0;i<reference.indices.length;i++){
      const result=[0,0,0];
      for(let k=0;k<4;k++){
        const packed=reference.skin[i][k],weight=(packed&255)/255;
        const p=transform(reference.centers[i],pose,(packed>>8)*10);
        for(let axis=0;axis<3;axis++)result[axis]+=weight*p[axis];
      }
      for(let axis=0;axis<3;axis++)assert.ok(Math.abs(result[axis]-reference[key][i][axis])<2e-5,`${seconds}s, splat ${reference.indices[i]}, axis ${axis}`);
    }
  }
});

test('both clips interpolate at VR frame rates with normalized rotations and loop continuity',()=>{
  for(const clip of clips.values()){
    const pose=new Float32Array(220),start=new Float32Array(220),end=new Float32Array(220);
    sampleClip(clip.data,clip,22,0,start);sampleClip(clip.data,clip,22,4,end);assert.deepEqual(start,end);
    for(let frame=0;frame<360;frame++){
      sampleClip(clip.data,clip,22,frame/90,pose);assert.ok(pose.every(Number.isFinite));
      for(let bone=0;bone<22;bone++)assert.ok(Math.abs(Math.hypot(...pose.slice(bone*10+3,bone*10+7))-1)<1e-5);
    }
  }
});

test('crossfade endpoints preserve the sampled bone poses',()=>{
  const a=new Float32Array(220),b=new Float32Array(220),out=new Float32Array(220);
  const hello=clips.get('hello'),idle=clips.get('idle');sampleClip(hello.data,hello,22,2,a);sampleClip(idle.data,idle,22,1,b);
  for(const [alpha,expected] of [[0,a],[1,b]]){
    blendPoses(a,b,alpha,out);
    for(let bone=0;bone<22;bone++){
      const offset=bone*10;
      for(const i of [0,1,2,7,8,9])assert.ok(Math.abs(expected[offset+i]-out[offset+i])<1e-6);
      // q and -q encode the same physical orientation.
      let dot=0;for(let i=3;i<7;i++)dot+=expected[offset+i]*out[offset+i];
      assert.ok(Math.abs(Math.abs(dot)-1)<1e-6);
    }
  }
});
