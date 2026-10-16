// Voice client for this server's /voice WebSocket (proxied to Gemini Live).
// Protocol: we send raw PCM16 mono @16 kHz binary frames; we receive PCM16 mono @24 kHz binary
// frames plus the text frame "__TURN_COMPLETE__".
const SEND_RATE = 16000;
const RECEIVE_RATE = 24000;

function downsample(input, inputRate) {
  if (inputRate === SEND_RATE) return input;
  const ratio = inputRate / SEND_RATE;
  const out = new Float32Array(Math.round(input.length / ratio));
  let pos = 0;
  for (let i = 0; i < out.length; i++) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0, n = 0;
    for (; pos < next && pos < input.length; pos++, n++) sum += input[pos];
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function toPcm16(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

export class VoiceClient {
  /** @param {string} url  @param {(state: 'connecting'|'listening'|'speaking'|'idle'|'error', detail?: string) => void} onState */
  constructor(url, onState) {
    this.url = url;
    this.onState = onState;
    this.ws = null;
  }

  get active() { return !!this.ws; }

  async start() {
    if (this.ws) return;
    this.onState('connecting');
    // Ask for the mic first, so a denied permission doesn't open a session for nothing.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.playCtx = new AudioContext({ sampleRate: RECEIVE_RATE });
    this.nextPlayAt = 0;
    this.sources = new Set();

    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // Stay on "connecting" until Gemini's greeting arrives: the mic opens only once the session
    // has answered, so the owner never speaks into a session that is still cold-starting.
    ws.onmessage = (e) => {
      if (!this.micCtx) this.startMic();
      if (typeof e.data === 'string') {
        // Show "listening" once the queued audio has actually finished playing.
        if (e.data === '__TURN_COMPLETE__') {
          const wait = Math.max(0, this.nextPlayAt - this.playCtx.currentTime) * 1000;
          setTimeout(() => {
            if (this.ws && this.playCtx.currentTime >= this.nextPlayAt - 0.05) this.onState('listening');
          }, wait);
        }
        return;
      }
      this.play(e.data);
    };
    ws.onerror = () => this.onState('error', 'Could not reach the voice assistant.');
    ws.onclose = (e) => {
      const reason = e.code !== 1000 && e.reason ? e.reason : '';
      this.cleanup();
      this.onState(reason ? 'error' : 'idle', reason);
    };
  }

  startMic() {
    const ctx = new AudioContext();
    this.micCtx = ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    // shortcut: ScriptProcessorNode is deprecated but works everywhere; move to an AudioWorklet if it glitches.
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(toPcm16(downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate)).buffer);
    };
    src.connect(proc);
    proc.connect(ctx.destination); // some browsers only fire onaudioprocess when connected
  }

  play(buf) {
    const pcm = new Int16Array(buf);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;
    const audio = this.playCtx.createBuffer(1, f32.length, RECEIVE_RATE);
    audio.copyToChannel(f32, 0);
    const node = this.playCtx.createBufferSource();
    node.buffer = audio;
    node.connect(this.playCtx.destination);
    // Back-to-back scheduling so chunks neither overlap nor leave gaps.
    const at = Math.max(this.playCtx.currentTime, this.nextPlayAt);
    node.start(at);
    this.nextPlayAt = at + audio.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
    this.onState('speaking');
  }

  stop() {
    this.ws?.close(1000, 'user ended');
    this.cleanup();
    this.onState('idle');
  }

  cleanup() {
    this.ws = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close().catch(() => {});
    this.sources?.forEach((s) => { try { s.stop(); } catch { /* already ended */ } });
    this.playCtx?.close().catch(() => {});
    this.stream = this.micCtx = this.playCtx = null;
  }
}
