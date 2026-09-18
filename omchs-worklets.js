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
  constructor(){
    super();
    this.prev = 0;
  }
  process(inputs, outputs){
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if(!output) return true;
    if(!input){ output.fill(0); return true; }
    let prev = this.prev;
    for(let i = 0; i < output.length; i++){
      const cur = input[i];
      const mid = (prev + cur) * 0.5;
      output[i] = (reflectFold(mid) + reflectFold(cur)) * 0.5;
      prev = cur;
    }
    this.prev = prev;
    return true;
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

// Stereo PCM tap for WAV export: Int16 interleaved chunks posted to the main thread
class OmchsRecProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.recording = false;
    this.buf = null;
    this.bufPos = 0;
    this.chunkSamples = 0;
    this.port.onmessage = e => {
      const d = e.data;
      if(!d) return;
      if(d.type === 'start'){
        this.recording = true;
        // ~0.25s of interleaved stereo Int16 per postMessage
        this.chunkSamples = Math.max(4096, Math.floor(sampleRate * 0.25) * 2);
        this.buf = new Int16Array(this.chunkSamples);
        this.bufPos = 0;
      } else if(d.type === 'stop'){
        this.recording = false;
        this.flush(true);
      }
    };
  }
  flush(final){
    if(this.buf && this.bufPos > 0){
      const copy = this.buf.slice(0, this.bufPos);
      this.port.postMessage({ type: 'rec-chunk', buffer: copy.buffer }, [copy.buffer]);
      this.bufPos = 0;
    }
    if(final) this.port.postMessage({ type: 'rec-end', sampleRate });
  }
  process(inputs){
    if(!this.recording || !this.buf) return true;
    const inn = inputs[0];
    const L = inn && inn[0];
    if(!L) return true;
    const R = (inn && inn[1]) || L;
    for(let i = 0; i < L.length; i++){
      let l = L[i], r = R[i];
      if(l > 1) l = 1; else if(l < -1) l = -1;
      if(r > 1) r = 1; else if(r < -1) r = -1;
      this.buf[this.bufPos++] = (l < 0 ? l * 0x8000 : l * 0x7FFF) | 0;
      this.buf[this.bufPos++] = (r < 0 ? r * 0x8000 : r * 0x7FFF) | 0;
      if(this.bufPos >= this.chunkSamples) this.flush(false);
    }
    return true;
  }
}

registerProcessor('omchs-fold', OmchsFoldProcessor);
registerProcessor('omchs-crush', OmchsCrushProcessor);
registerProcessor('omchs-lfo', OmchsLfoProcessor);
registerProcessor('omchs-cv-monitor', OmchsCvMonitorProcessor);
registerProcessor('omchs-rec', OmchsRecProcessor);
