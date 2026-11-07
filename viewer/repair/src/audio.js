/** Procedural workshop audio; no remote media, autoplay, or microphone. */
export class WorkshopAudio {
  constructor() { this.enabled = true; this.ctx = null; }
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = this.enabled ? .16 : 0;
      this.master.connect(this.ctx.destination);
      const hum = this.ctx.createOscillator(), gain = this.ctx.createGain();
      hum.frequency.value = 60; gain.gain.value = .035;
      hum.connect(gain).connect(this.master); hum.start();
    }
    this.ctx.resume().catch(() => {});
  }
  toggle() {
    this.enabled = !this.enabled;
    if (this.ctx) this.master.gain.setTargetAtTime(this.enabled ? .16 : 0, this.ctx.currentTime, .1);
    return this.enabled;
  }
  tone(freq = 300, duration = .12, type = 'sine', volume = .35, x = 0) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), pan = c.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, x));
    o.type = type; o.frequency.setValueAtTime(freq, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * .7), c.currentTime + duration);
    g.gain.setValueAtTime(.001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(volume, c.currentTime + .008);
    g.gain.exponentialRampToValueAtTime(.001, c.currentTime + duration);
    o.connect(g).connect(pan).connect(this.master); o.start(); o.stop(c.currentTime + duration + .02);
  }
  click() { this.tone(120, .09, 'triangle'); }
  success() { [430, 540, 650].forEach((f,i) => setTimeout(() => this.tone(f,.22), i*110)); }
}
