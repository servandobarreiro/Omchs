/* Omchs AudioWorklet processors — fold, crush, LFO, CV monitor */

function reflectFold(x){
  let guard = 0;
  while((x > 1 || x < -1) && guard < 16){
    if(x > 1) x = 2 - x;
    else if(x < -1) x = -2 - x;
    guard++;
  }
  return x;
}

class OmchsFoldProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    this.prev = 0;
    this.z1 = 0;
    this.z2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    const opts = (options && options.processorOptions) || {};
    this.hq = !!opts.hq;
    this.initOsFilter();
    this.port.onmessage = e => {
      if(e.data && e.data.type === 'hq'){
        this.hq = !!e.data.value;
        if(this.hq){ this.z1 = 0; this.z2 = 0; }
      }
    };
  }
  initOsFilter(){
    // 2-pole Butterworth lowpass on the 4x stream, cutoff just below original Nyquist
    const osSr = sampleRate * 4;
    const cutoff = Math.min(18000, sampleRate * 0.45);
    const w0 = 2 * Math.PI * cutoff / osSr;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * 0.7071067811865476);
    const b0 = (1 - cosw) * 0.5;
    const b1 = 1 - cosw;
    const b2 = (1 - cosw) * 0.5;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw;
    const a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(inputs, outputs){
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if(!output) return true;
    if(!input){ output.fill(0); return true; }
    if(this.hq) this.processHq(input, output);
    else this.processLq(input, output);
    return true;
  }
  processLq(input, output){
    let prev = this.prev;
    for(let i = 0; i < output.length; i++){
      const cur = input[i];
      const mid = (prev + cur) * 0.5;
      output[i] = (reflectFold(mid) + reflectFold(cur)) * 0.5;
      prev = cur;
    }
    this.prev = prev;
  }
  processHq(input, output){
    let prev = this.prev;
    let z1 = this.z1, z2 = this.z2;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    for(let i = 0; i < output.length; i++){
      const cur = input[i];
      const d = (cur - prev) * 0.25;
      let x = prev;
      let y = 0;
      for(let k = 0; k < 4; k++){
        x += d;
        const f = reflectFold(x);
        y = b0 * f + z1;
        z1 = b1 * f - a1 * y + z2;
        z2 = b2 * f - a2 * y;
      }
      output[i] = y;
      prev = cur;
    }
    this.prev = prev;
    this.z1 = z1;
    this.z2 = z2;
  }
}

class OmchsCrushProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.crush = 0;
    this.phase = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.port.onmessage = e => {
      if(e.data && e.data.type === 'crush') this.crush = e.data.value;
    };
  }
  process(inputs, outputs){
    const inn = inputs[0];
    const out = outputs[0];
    if(!out || !out[0]) return true;
    const inL = inn && inn[0];
    const inR = (inn && inn[1]) || inL;
    const outL = out[0];
    const outR = out[1] || out[0];
    if(!inL){ outL.fill(0); if(outR !== outL) outR.fill(0); return true; }
    const crush = this.crush;
    const step = Math.pow(0.5, (1 - crush) * 16);
    for(let i = 0; i < outL.length; i++){
      if(crush > 0){
        this.phase += crush;
        if(this.phase >= 1){
          this.phase -= 1;
          this.holdL = Math.round(inL[i] / step) * step;
          this.holdR = Math.round((inR ? inR[i] : inL[i]) / step) * step;
        }
        outL[i] = this.holdL;
        outR[i] = this.holdR;
      } else {
        outL[i] = inL[i];
        outR[i] = inR ? inR[i] : inL[i];
      }
    }
    return true;
  }
}

function lfoSample(state, wave){
  let v;
  switch(Math.round(Math.max(0, Math.min(7, wave)))){
    case 0: v = Math.sin(state.phase * 2 * Math.PI); break;
    case 1: v = state.phase < 0.5 ? (4 * state.phase - 1) : (3 - 4 * state.phase); break;
    case 2: v = 2 * state.phase - 1; break;
    case 3: v = 1 - 2 * state.phase; break;
    case 4: v = state.phase < 0.5 ? 1 : -1; break;
    case 5: v = state.phase < 0.2 ? 1 : -1; break;
    case 6: v = state.sqRand; break;
    default:
      state.softVal += (state.softTarget - state.softVal) * 0.0015;
      v = state.softVal;
      break;
  }
  return v;
}

class OmchsLfoProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.phase = 0;
    this.softVal = 0;
    this.softTarget = 0;
    this.sqRand = 1;
    this.speed = 1.5;
    this.wave = 0;
    this.port.onmessage = e => {
      const d = e.data;
      if(!d) return;
      if(d.type === 'ping') this.phase = 0;
      if(d.type === 'params'){
        if(typeof d.speed === 'number') this.speed = d.speed;
        if(typeof d.wave === 'number') this.wave = d.wave;
      }
    };
  }
  process(_inputs, outputs){
    const output = outputs[0] && outputs[0][0];
    if(!output) return true;
    const sr = sampleRate;
    const state = this;
    const freq = Math.max(0.001, this.speed);
    const wave = this.wave;
    for(let i = 0; i < output.length; i++){
      state.phase += freq / sr;
      if(state.phase >= 1){
        state.phase -= 1;
        if(Math.random() < 0.5) state.sqRand *= -1;
        state.softTarget = Math.random() * 2 - 1;
      }
      output[i] = lfoSample(state, wave);
    }
    return true;
  }
}

class OmchsCvMonitorProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const opts = (options && options.processorOptions) || {};
    this.names = opts.names || [];
    this.riseNames = new Set(opts.riseNames || []);
    this.prevEdge = {};
    this.riseNames.forEach(n => { this.prevEdge[n] = 0; });
    this.thresh = 0.3;
    this.counter = 0;
  }
  process(inputs){
    const inn = inputs[0];
    if(!inn || !inn.length) return true;
    const live = {};
    const rises = [];
    for(let c = 0; c < this.names.length; c++){
      const name = this.names[c];
      const data = inn[c];
      if(!data || !data.length){ live[name] = 0; continue; }
      live[name] = data[data.length - 1];
      if(this.riseNames.has(name)){
        let rose = false, prev = this.prevEdge[name] || 0;
        for(let s = 0; s < data.length; s++){
          if(prev < this.thresh && data[s] >= this.thresh) rose = true;
          prev = data[s];
        }
        this.prevEdge[name] = prev;
        if(rose) rises.push(name);
      }
    }
    // Post every ~4 quantum (~3ms at 128) to keep UI responsive without flooding
    this.counter++;
    if(this.counter >= 4 || rises.length){
      this.counter = 0;
      this.port.postMessage({ type: 'cv', live, rises });
    }
    return true;
  }
}

// Stereo PCM tap for WAV export: 16-bit or 24-bit interleaved chunks posted to the main thread
class OmchsRecProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.recording = false;
    this.buf = null;
    this.bufPos = 0;
    this.chunkBytes = 0;
    this.bits = 16;
    this.port.onmessage = e => {
      const d = e.data;
      if(!d) return;
      if(d.type === 'start'){
        this.recording = true;
        this.bits = d.bits === 24 ? 24 : 16;
        const frames = Math.max(2048, Math.floor(sampleRate * 0.25));
        const bytesPerFrame = 2 * (this.bits === 24 ? 3 : 2);
        this.chunkBytes = frames * bytesPerFrame;
        this.buf = new Uint8Array(this.chunkBytes);
        this.bufPos = 0;
      } else if(d.type === 'stop'){
        this.recording = false;
        this.flush(true);
      }
    };
  }
  write16(x){
    const v = (x < 0 ? x * 0x8000 : x * 0x7FFF) | 0;
    this.buf[this.bufPos++] = v & 0xFF;
    this.buf[this.bufPos++] = (v >> 8) & 0xFF;
  }
  write24(x){
    let v = x < 0 ? Math.round(x * 0x800000) : Math.round(x * 0x7FFFFF);
    if(v > 0x7FFFFF) v = 0x7FFFFF;
    else if(v < -0x800000) v = -0x800000;
    this.buf[this.bufPos++] = v & 0xFF;
    this.buf[this.bufPos++] = (v >> 8) & 0xFF;
    this.buf[this.bufPos++] = (v >> 16) & 0xFF;
  }
  flush(final){
    if(this.buf && this.bufPos > 0){
      const copy = this.buf.slice(0, this.bufPos);
      this.port.postMessage({ type: 'rec-chunk', buffer: copy.buffer, bits: this.bits }, [copy.buffer]);
      this.bufPos = 0;
    }
    if(final) this.port.postMessage({ type: 'rec-end', sampleRate, bits: this.bits });
  }
  process(inputs){
    if(!this.recording || !this.buf) return true;
    const inn = inputs[0];
    const L = inn && inn[0];
    if(!L) return true;
    const R = (inn && inn[1]) || L;
    const write = this.bits === 24
      ? (x) => this.write24(x)
      : (x) => this.write16(x);
    for(let i = 0; i < L.length; i++){
      let l = L[i], r = R[i];
      if(l > 1) l = 1; else if(l < -1) l = -1;
      if(r > 1) r = 1; else if(r < -1) r = -1;
      write(l);
      write(r);
      if(this.bufPos >= this.chunkBytes) this.flush(false);
    }
    return true;
  }
}

registerProcessor('omchs-fold', OmchsFoldProcessor);
registerProcessor('omchs-crush', OmchsCrushProcessor);
registerProcessor('omchs-lfo', OmchsLfoProcessor);
registerProcessor('omchs-cv-monitor', OmchsCvMonitorProcessor);
registerProcessor('omchs-rec', OmchsRecProcessor);

/* Frequency shifter (Bode / SSB): Hilbert allpass pair + quadrature carrier.
   Stereo; uses AudioParam `hz` and optional port {type:'hz', value}. */
class OmchsFreqShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){
    return [{ name:'hz', defaultValue:0, minValue:-2000, maxValue:2000, automationRate:'a-rate' }];
  }
  constructor(){
    super();
    this.hzMsg = 0;
    this.phase = 0;
    // Parallel allpass banks (approx ±90°) — Domínguez / Bode style
    this.coefA = [0.16175849875, 0.7330289324, 0.9453497216, 0.9905981564];
    this.coefB = [0.4794008658, 0.8762184935, 0.9765987444, 0.9975252324];
    this.zA = [new Float64Array(4), new Float64Array(4)];
    this.zB = [new Float64Array(4), new Float64Array(4)];
    this.reDelay = [0, 0];
    this.port.onmessage = e => {
      if(e.data && e.data.type === 'hz' && typeof e.data.value === 'number') this.hzMsg = e.data.value;
    };
  }
  allpass(x, coefs, z){
    let y = x;
    for(let i = 0; i < coefs.length; i++){
      const c = coefs[i];
      const x0 = y;
      y = z[i] + c * x0;
      z[i] = x0 - c * y;
    }
    return y;
  }
  process(inputs, outputs, parameters){
    const input = inputs[0];
    const output = outputs[0];
    if(!output || !output[0]) return true;
    const hzParam = parameters.hz;
    const n = output[0].length;
    const outL = output[0];
    const outR = output[1] || output[0];
    const inL = (input && input[0]) || null;
    const inR = (input && input[1]) || inL;
    const sr = sampleRate;
    for(let i = 0; i < n; i++){
      const hz = (hzParam.length > 1 ? hzParam[i] : hzParam[0]) || this.hzMsg || 0;
      const xL = inL ? inL[i] : 0;
      const xR = inR ? inR[i] : xL;
      if(Math.abs(hz) < 0.01){
        outL[i] = xL;
        outR[i] = xR;
        continue;
      }
      this.phase += (2 * Math.PI * hz) / sr;
      if(this.phase > Math.PI * 1000) this.phase -= Math.PI * 1000;
      else if(this.phase < -Math.PI * 1000) this.phase += Math.PI * 1000;
      const c = Math.cos(this.phase);
      const s = Math.sin(this.phase);
      for(let ch = 0; ch < 2; ch++){
        const x = ch === 0 ? xL : xR;
        const re = this.allpass(x, this.coefA, this.zA[ch]);
        const im = this.allpass(x, this.coefB, this.zB[ch]);
        const reD = this.reDelay[ch];
        this.reDelay[ch] = re;
        const y = reD * c - im * s;
        if(ch === 0) outL[i] = y;
        else outR[i] = y;
      }
    }
    return true;
  }
}
registerProcessor('omchs-freqshift', OmchsFreqShiftProcessor);


