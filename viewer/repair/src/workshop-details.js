import * as THREE from 'three';

/** Cheap, deterministic wear on the existing Blender materials. */
export function dressStation(station) {
  let seed=417;
  const random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
  const g=canvas.getContext('2d');g.fillStyle='#c4bfad';g.fillRect(0,0,512,512);
  for(let i=0;i<5500;i++){
    const x=random()*512,y=random()*512,v=80+random()*130;
    g.fillStyle=`rgba(${v},${v},${v},${.03+random()*.14})`;g.fillRect(x,y,1+random()*4,1+random()*3);
  }
  for(let i=0;i<90;i++){
    g.strokeStyle=`rgba(32,26,18,${random()*.17})`;g.lineWidth=.4+random()*1.2;
    const x=random()*512,y=random()*512;
    g.beginPath();g.moveTo(x,y);g.lineTo(x+random()*80,y+random()*6);g.stroke();
  }
  for(const [x,y,r] of [[350,280,76],[120,420,49],[425,80,35]]){
    const a=g.createRadialGradient(x,y,0,x,y,r);a.addColorStop(0,'#20150924');a.addColorStop(1,'#20150900');
    g.fillStyle=a;g.fillRect(x-r,y-r,r*2,r*2);
  }
  const wear=new THREE.CanvasTexture(canvas);wear.colorSpace=THREE.SRGBColorSpace;wear.anisotropy=4;
  const touched=new Set();
  station.traverse(o=>{
    if(!o.isMesh||!o.material||Array.isArray(o.material)||touched.has(o.material))return;
    const m=o.material;touched.add(m);
    if(/enamel|worktop|ivory|steel|bakelite|Brass/.test(m.name)){
      m.map=wear;m.roughness=Math.max(m.roughness,.57);m.needsUpdate=true;
    }
    if(/worktop/.test(m.name))m.color.multiplyScalar(.8);
  });
}

/** A short-lived elastic connection makes extraction visibly continuous. */
export function makeTethers(scene) {
  const strands=12,steps=14,positions=new Float32Array(strands*steps*6);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  const material=new THREE.LineBasicMaterial({color:0xb3e4bb,transparent:true,opacity:.6,depthWrite:false});
  const mesh=new THREE.LineSegments(geometry,material);mesh.visible=false;scene.add(mesh);
  return {
    mesh,
    update(from,to,age,time) {
      mesh.visible=age<1.35;
      if(!mesh.visible)return;
      let k=0;
      const point=(s,t)=>{
        const a=s*2.39996,envelope=Math.sin(Math.PI*t),r=.012+Math.sin(age*Math.PI/1.35)*.025;
        return new THREE.Vector3().lerpVectors(from,to,t).add(new THREE.Vector3(
          Math.cos(a+time*2+t*7)*r*envelope,
          Math.sin(a+time*3+t*9)*r*envelope + envelope*.04,
          Math.cos(a+t*9)*r*envelope));
      };
      for(let s=0;s<strands;s++)for(let n=0;n<steps;n++)for(const t of [n/steps,(n+1)/steps]){
        const p=point(s,t);positions[k++]=p.x;positions[k++]=p.y;positions[k++]=p.z;
      }
      geometry.attributes.position.needsUpdate=true;geometry.computeBoundingSphere();
      material.opacity=.65*(1-age/1.35);
    },
  };
}

export function makeMiniature(station,drawer) {
  // A mesh-only miniature shares geometry and textures. It adds no splat scene.
  const model=station.clone(true);model.position.set(0,0,0);model.rotation.set(0,0,0);
  model.traverse(o=>{if(o.material?.visible===false||o.isPoints)o.visible=false;});
  const group=new THREE.Group();group.add(model);group.scale.setScalar(.23);
  group.position.set(0,.676,.035);group.visible=false;drawer.add(group);
  return group;
}
