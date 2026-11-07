/** Puzzle rules shared by desktop, XR, and the state tests. */
export class RepairJob {
  constructor() { this.reset(); }
  reset() {
    this.begun = false; this.opened = false; this.drawer = 0;
    this.probeUsed = false; this.scan = 0; this.revealed = false;
    this.extracted = false; this.installed = false; this.testing = false;
    this.testTime = 0; this.complete = false;
    this.dials = [.22, .78, .20];
    this.targets = [.66, .37, .73];
    this.lockTime = 0; this.calibrated = false;
  }
  get phase() {
    if (!this.begun) return 'briefing';
    if (this.complete) return 'complete';
    if (this.testing) return 'testing';
    if (this.installed) return this.calibrated ? 'test' : 'calibrate';
    if (this.extracted) return 'install';
    if (this.revealed) return 'extract';
    if (!this.opened) return 'drawer';
    if (!this.probeUsed) return 'probe';
    return 'scan';
  }
  start() { this.begun = true; }
  setDrawer(open) {
    this.drawer = Math.max(0, Math.min(1, open));
    if (this.begun && this.drawer > .7) this.opened = true;
  }
  useProbe() {
    if (!this.begun || !this.opened || this.testing || this.complete) return false;
    this.probeUsed = true; return true;
  }
  inspect(dt, active) {
    if (this.revealed || !this.probeUsed || this.drawer < .7 || !this.begun) return false;
    // Partial inspection holds its progress; interruption never strands the job.
    if (active && Number.isFinite(dt)) this.scan = Math.min(1, this.scan + Math.max(0, Math.min(dt,1)) / 2.8);
    if (this.scan >= 1) { this.revealed = true; return true; }
    return false;
  }
  takePart() {
    if (!this.revealed || this.drawer < .7 || this.installed || this.testing) return false;
    this.extracted = true; return true;
  }
  install(carrying) {
    if (!this.extracted || !carrying || this.installed) return false;
    this.installed = true; return true;
  }
  get channelLocks() { return this.dials.map((v,i) => Math.abs(v-this.targets[i]) <= .045); }
  get signal() { return Math.max(0, 1-this.dials.reduce((s,v,i)=>s+Math.abs(v-this.targets[i]),0)/1.5); }
  setDial(index, value) {
    if (!this.installed || this.testing || this.complete || this.calibrated || !Number.isInteger(index) || index<0 || index>2 || !Number.isFinite(value)) return false;
    this.dials[index] = Math.max(0, Math.min(1, value));
    if (!this.channelLocks.every(Boolean)) this.lockTime = 0;
    return true;
  }
  tickCalibration(dt) {
    if (!this.installed || this.calibrated) return false;
    if (!this.channelLocks.every(Boolean)) { this.lockTime = 0; return false; }
    this.lockTime += Number.isFinite(dt) ? Math.max(0, Math.min(dt,5)) : 0;
    if (this.lockTime >= 1.6) { this.calibrated = true; return true; }
    return false;
  }
  test() {
    if (!this.installed || !this.calibrated || this.testing || this.complete) return false;
    this.testing = true; this.testTime = 0; return true;
  }
  tick(dt) {
    if (!this.testing) return false;
    this.testTime += Number.isFinite(dt) ? Math.max(0, Math.min(dt,5)) : 0;
    if (this.testTime >= 5) { this.testing = false; this.complete = true; return true; }
    return false;
  }
}
