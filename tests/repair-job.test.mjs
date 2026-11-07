import test from 'node:test';
import assert from 'node:assert/strict';
import { RepairJob } from '../viewer/repair/src/repair-job.mjs';

function reveal(j) {
  j.start();j.setDrawer(1);assert.equal(j.useProbe(),true);
  for(let i=0;i<29;i++)j.inspect(.1,true);
}
function calibrate(j) {
  j.targets.forEach((v,i)=>assert.equal(j.setDial(i,v),true));
  for(let i=0;i<17;i++)j.tickCalibration(.1);
  assert.equal(j.calibrated,true);
}

test('repair requires the complete ordered sequence, including the final test',()=>{
  const j=new RepairJob();
  assert.equal(j.takePart(),false);assert.equal(j.install(true),false);assert.equal(j.test(),false);
  j.start();assert.equal(j.useProbe(),false);
  j.setDrawer(.4);assert.equal(j.phase,'drawer');
  j.setDrawer(1);assert.equal(j.phase,'probe');
  j.inspect(.1,true);assert.equal(j.scan,0);
  j.useProbe();assert.equal(j.phase,'scan');
  for(let i=0;i<29;i++)j.inspect(.1,true);
  assert.equal(j.phase,'extract');assert.equal(j.test(),false);
  assert.equal(j.takePart(),true);assert.equal(j.phase,'install');
  assert.equal(j.install(false),false);assert.equal(j.install(true),true);
  assert.equal(j.complete,false);assert.equal(j.phase,'calibrate');assert.equal(j.test(),false);
  calibrate(j);assert.equal(j.phase,'test');
  j.test();for(let i=0;i<51;i++)j.tick(.1);
  assert.equal(j.phase,'complete');assert.equal(j.test(),false);
});

test('inspection pauses when aim is lost or the drawer closes, then resumes',()=>{
  const j=new RepairJob();j.start();j.setDrawer(1);j.useProbe();
  for(let i=0;i<10;i++)j.inspect(.1,true);
  const partial=j.scan;
  j.inspect(.1,false);assert.equal(j.scan,partial);
  j.setDrawer(0);j.inspect(.1,true);assert.equal(j.scan,partial);
  j.setDrawer(1);for(let i=0;i<20;i++)j.inspect(.1,true);
  assert.equal(j.revealed,true);
});

test('dropped parts can be retrieved without bypassing installation',()=>{
  const j=new RepairJob();reveal(j);j.takePart();
  assert.equal(j.install(false),false);assert.equal(j.test(),false);
  assert.equal(j.takePart(),true);assert.equal(j.install(true),true);
});

test('restart clears every puzzle state after completion',()=>{
  const j=new RepairJob();reveal(j);j.takePart();j.install(true);calibrate(j);j.test();
  for(let i=0;i<51;i++)j.tick(.1);
  j.reset();assert.equal(j.phase,'briefing');assert.equal(j.scan,0);
  for(const key of ['begun','opened','probeUsed','revealed','extracted','installed','calibrated','testing','complete'])assert.equal(j[key],false,key);
  assert.equal(j.testTime,0);assert.equal(j.takePart(),false);
  assert.deepEqual(j.dials,[.22,.78,.20]);assert.equal(j.lockTime,0);
});

test('all three channels must hold alignment continuously before the test enables',()=>{
  const j=new RepairJob();reveal(j);j.takePart();j.install(true);
  j.setDial(0,j.targets[0]);j.setDial(1,j.targets[1]);
  for(let i=0;i<30;i++)j.tickCalibration(.1);
  assert.equal(j.calibrated,false);assert.equal(j.test(),false);
  j.setDial(2,j.targets[2]);for(let i=0;i<8;i++)j.tickCalibration(.1);
  assert.ok(j.lockTime>.7);j.setDial(1,.9);assert.equal(j.lockTime,0);
  j.setDial(1,j.targets[1]);for(let i=0;i<8;i++)j.tickCalibration(.1);
  assert.equal(j.calibrated,false);
  for(let i=0;i<9;i++)j.tickCalibration(.1);
  assert.equal(j.calibrated,true);assert.equal(j.test(),true);
});

test('invalid or premature tuning cannot corrupt calibration values',()=>{
  const j=new RepairJob();assert.equal(j.setDial(0,.66),false);
  reveal(j);j.takePart();j.install(true);
  for(const [index,value] of [[-1,.5],[3,.5],[0,NaN],[1,Infinity]])assert.equal(j.setDial(index,value),false);
  j.setDial(0,100);assert.equal(j.dials[0],1);j.setDial(0,-100);assert.equal(j.dials[0],0);
  calibrate(j);assert.equal(j.setDial(0,.1),false);assert.equal(j.dials[0],j.targets[0]);
});

test('stable alignment and diagnostics use elapsed time when rendering is throttled',()=>{
  const j=new RepairJob();j.start();j.setDrawer(1);j.useProbe();
  for(let i=0;i<4;i++)j.inspect(.71,true);
  assert.equal(j.revealed,true);j.takePart();j.install(true);
  j.targets.forEach((v,i)=>j.setDial(i,v));
  assert.equal(j.tickCalibration(1.7),true);assert.equal(j.test(),true);
  assert.equal(j.tick(2.5),false);assert.equal(j.tick(2.5),true);
  assert.equal(j.complete,true);
});
