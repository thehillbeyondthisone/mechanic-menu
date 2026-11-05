"""Read-only check: fraction of each candidate wall-sign box hidden by splats in front of it.
Uses splat centres plus 1.5x their largest scale (opacity > 0.25) from the preserved original PLY.
Used on 2026-11-05 to choose STANDOFF = 0.08 and the list position in src/layout.js."""
import numpy as np, sys
PLY=r'D:/Lustron/experiments/BLUNT/2026-11-04_repair-office-single-image/output/repair-office.ply'
with open(PLY,'rb') as f:
    while f.readline().strip()!=b'end_header': pass
    off=f.tell()
a=np.memmap(PLY,'<f4','r',offset=off).reshape(-1,17)
op=1/(1+np.exp(-a[:,9])); keep=op>0.25
W=np.stack([3*a[:,0],1.6-3*a[:,1],-3*a[:,2]],1)[keep]; S=3*np.exp(a[keep][:,10:13]).max(1)
eye=np.array([0,1.6,0]); V=W-eye; Dn=np.linalg.norm(V,axis=1); Dir=V/Dn[:,None]
n=np.array([0.65,-0.01,0.76]); n=n/np.linalg.norm(n); t=np.array([n[2],0,-n[0]]); t/=np.linalg.norm(t)
def wallpt(x,y,off):
    z=-3.12-(0.65*(x+1.06)-0.01*(y-2.8))/0.76; return np.array([x,y,z])+off*n
def occluded(c,tan,w,h,front_off):
    a_,b_=np.meshgrid(np.linspace(-.48,.48,16),np.linspace(-.45,.45,5)); P=c+a_.ravel()[:,None]*w*tan+b_.ravel()[:,None]*h*np.array([0,1,0])+front_off*n
    occ=0
    for p in P:
        v=p-eye; d=np.linalg.norm(v); u=v/d
        m=(Dn<d-0.01)&(Dir@u>np.cos(0.05))
        if not m.any(): continue
        ang=np.arccos(np.clip(Dir[m]@u,-1,1)); hit=(ang*Dn[m]<1.5*S[m]).any(); occ+=hit
    return occ/len(P)
for st in [0.045,0.08]:
  for x0 in [-1.22,-1.1]:
    for y in [2.36,2.25,2.20,2.14,2.09,2.03,1.98]:
        for L in [0.35,0.62]:
            depth=0.012; c=wallpt(x0,y,st+depth/2)+t*L/2
            print(f'standoff {st} x0 {x0} y {y} len {L}: occluded {occluded(c,t,L,0.08,depth/2):.2f}')
