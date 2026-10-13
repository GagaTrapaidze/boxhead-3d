/**
 * Procedural audio engine — everything is synthesized with the native Web Audio
 * API, so the game ships with zero MP3/WAV assets.
 *
 * Design notes
 *  - The `AudioContext` is created lazily on the first user gesture (keydown /
 *    pointerdown) so browser autoplay policies never block playback; every
 *    trigger also re-checks `resume()` as a safety net.
 *  - One shared white-noise buffer is reused by every noisy voice — no
 *    per-shot allocation of sample data.
 *  - Every voice is a short gain-enveloped oscillator + optional low-passed
 *    noise burst, then torn down by the Web Audio graph itself. Per-sound
 *    numbers live in `balance.config.ts` (`AUDIO_CONFIG`).
 */
import { AUDIO_CONFIG } from '../../../shared/src/balance.config.ts';
import type { SoundSpec } from '../../../shared/src/balance.config.ts';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  /** Rolling one-second window used to cap voices/second. */
  private voiceWindowStart = 0;
  private voiceCount = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    // First gesture unlocks/creates the context; both listeners are passive.
    window.addEventListener('pointerdown', this.unlock, { passive: true });
    window.addEventListener('keydown', this.unlock, { passive: true });
  }

  private readonly unlock = (): void => {
    this.resume();
  };

  /**
   * Creates or resumes the AudioContext. Safe to call on every interaction —
   * the browser blocks construction until the first gesture, after which
   * `resume()` guarantees the clock is running.
   */
  resume(): void {
    const ctx = this.ensureGraph();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  /** Mutes/unmutes every synthesized voice (master gain). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : AUDIO_CONFIG.masterVolume;
  }

  // ── Public one-shots ───────────────────────────────────────────────────────

  /** Pistol: high-frequency click/pop with quick decay. */
  pistol(): void {
    this.play(AUDIO_CONFIG.pistol);
  }

  /** Shotgun: heavy low-frequency punch + noisy burst. */
  shotgun(): void {
    this.play(AUDIO_CONFIG.shotgun);
  }

  /** Uzi: rapid micro-click with a short pitch envelope (slight variation). */
  uzi(): void {
    this.play(AUDIO_CONFIG.uzi, 0.9 + Math.random() * 0.25);
  }

  /** Grenade / barrel: low-passed noise burst + sub-bass decay. */
  explosion(): void {
    this.play(AUDIO_CONFIG.explosion);
  }

  /** Pickup: cheerful two-tone 8-bit arpeggio (root then a fifth up). */
  pickup(): void {
    this.play(AUDIO_CONFIG.pickup, 1, 0);
    this.play(AUDIO_CONFIG.pickup, 1.5, 0.09);
  }

  /**
   * Combo milestone: bright rising 8-bit arpeggio. Higher pitches read as
   * "better" so the ear tracks the escalating multiplier.
   */
  spree(): void {
    const notes = [1, 1.26, 1.5, 2];
    notes.forEach((pitch, i) => this.play(AUDIO_CONFIG.pickup, pitch, i * 0.06));
  }

  /** Non-lethal hit: low-pitched thud. */
  zombieHit(): void {
    this.play(AUDIO_CONFIG.zombieHit, 0.9 + Math.random() * 0.2);
  }

  /** Death: deeper, wetter crunch. */
  zombieDeath(): void {
    this.play(AUDIO_CONFIG.zombieDeath, 0.85 + Math.random() * 0.3);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private ensureGraph(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const scope = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    const ctx = this.ctx;
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : AUDIO_CONFIG.masterVolume;
      this.master.connect(ctx.destination);
    }
    if (!this.noiseBuffer) this.noiseBuffer = this.createNoise(ctx);
    return ctx;
  }

  /** One second of white noise, reused by every noisy voice. */
  private createNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** True while the voice budget for this second still has room. */
  private canPlay(ctx: AudioContext): boolean {
    const now = ctx.currentTime;
    if (now - this.voiceWindowStart > 1) {
      this.voiceWindowStart = now;
      this.voiceCount = 0;
    }
    if (this.voiceCount >= AUDIO_CONFIG.maxVoicesPerSecond) return false;
    this.voiceCount++;
    return true;
  }

  /** Schedules one short synth voice. `pitch` shifts both tone and noise. */
  private play(spec: SoundSpec, pitch = 1, delay = 0): void {
    const ctx = this.ensureGraph();
    if (!ctx || !this.master || this.muted) return;
    if (!this.canPlay(ctx)) return;

    const start = ctx.currentTime + delay;
    const gain = ctx.createGain();
    const attack = Math.min(0.008, spec.duration * 0.25);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.volume), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration);
    gain.connect(this.master);

    if (spec.noise > 0 && this.noiseBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.playbackRate.value = Math.max(0.25, Math.min(4, pitch));
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = spec.noise;
      if (spec.lowpass > 0) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = spec.lowpass;
        noiseGain.connect(filter).connect(gain);
      } else {
        noiseGain.connect(gain);
      }
      source.connect(noiseGain);
      source.start(start);
      source.stop(start + spec.duration);
    }

    if (spec.freqStart > 0) {
      const osc = ctx.createOscillator();
      osc.type = spec.wave;
      osc.frequency.setValueAtTime(spec.freqStart * pitch, start);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, spec.freqEnd * pitch),
        start + spec.duration
      );
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + spec.duration);
    }
  }
}

/** Singleton used by the game loop. */
export const audio = new AudioManager();
