// Reusable clip format: frame-major, bone-major [position3, quaternionXYZW4, scale3].
export function interpolatePose(a, aOffset, b, bOffset, alpha, output, outOffset) {
  for (const i of [0, 1, 2, 7, 8, 9]) output[outOffset+i]=a[aOffset+i]+(b[bOffset+i]-a[aOffset+i])*alpha;
  let dot=0;
  for(let i=3;i<7;i++)dot+=a[aOffset+i]*b[bOffset+i];
  const sign=dot<0?-1:1;dot=Math.min(1,Math.abs(dot));
  let left=1-alpha,right=alpha;
  if(dot<.9995){const angle=Math.acos(dot),sine=Math.sin(angle);left=Math.sin((1-alpha)*angle)/sine;right=Math.sin(alpha*angle)/sine;}
  let norm=0;
  for(let i=3;i<7;i++){const q=left*a[aOffset+i]+right*sign*b[bOffset+i];output[outOffset+i]=q;norm+=q*q;}
  norm=Math.sqrt(norm);
  for(let i=3;i<7;i++)output[outOffset+i]/=norm;
}

export function sampleClip(data, clip, numBones, seconds, output) {
  const span=clip.frames/clip.fps;
  const time=clip.loop?((seconds%span)+span)%span:Math.max(0,Math.min(seconds,(clip.frames-1)/clip.fps));
  const frame=time*clip.fps,first=Math.floor(frame),next=clip.loop?(first+1)%clip.frames:Math.min(first+1,clip.frames-1),alpha=frame-first;
  for(let bone=0;bone<numBones;bone++)interpolatePose(data,(first*numBones+bone)*10,data,(next*numBones+bone)*10,alpha,output,bone*10);
  return output;
}

export function blendPoses(a,b,alpha,output){
  for(let offset=0;offset<a.length;offset+=10)interpolatePose(a,offset,b,offset,alpha,output,offset);
  return output;
}
