import { emitLivePcmLevel } from "./live-audio-visual-state.mjs";

export const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;
export const LIVE_INPUT_CHUNK_SAMPLES = 1_600;
export const LIVE_INPUT_MIME_TYPE = `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`;

export class StreamingPcm16Resampler {
  constructor(inputSampleRate, outputSampleRate = LIVE_INPUT_SAMPLE_RATE) {
    this.ratio = inputSampleRate / outputSampleRate;
    this.position = 0;
    this.remainder = new Float32Array(0);
  }

  process(chunk) {
    if (!(chunk instanceof Float32Array) || chunk.length === 0) return new Int16Array(0);
    emitLivePcmLevel("input", chunk);
    const combined = new Float32Array(this.remainder.length + chunk.length);
    combined.set(this.remainder, 0);
    combined.set(chunk, this.remainder.length);
    const samples = [];
    while (this.position + 1 < combined.length) {
      const leftIndex = Math.floor(this.position);
      const fraction = this.position - leftIndex;
      const sample = combined[leftIndex] + (combined[leftIndex + 1] - combined[leftIndex]) * fraction;
      samples.push(Math.max(-1, Math.min(1, sample)));
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), Math.max(0, combined.length - 1));
    this.remainder = combined.slice(consumed);
    this.position -= consumed;
    const output = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    }
    return output;
  }
}

export class PcmChunkAccumulator {
  constructor(chunkSamples = LIVE_INPUT_CHUNK_SAMPLES) {
    this.chunkSamples = chunkSamples;
    this.pending = new Int16Array(0);
  }

  push(samples, onChunk) {
    if (!(samples instanceof Int16Array) || samples.length === 0) return;
    const combined = new Int16Array(this.pending.length + samples.length);
    combined.set(this.pending, 0);
    combined.set(samples, this.pending.length);
    let offset = 0;
    while (combined.length - offset >= this.chunkSamples) {
      onChunk(combined.slice(offset, offset + this.chunkSamples));
      offset += this.chunkSamples;
    }
    this.pending = combined.slice(offset);
  }

  reset() {
    this.pending = new Int16Array(0);
  }
}

export function pcm16ToBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index], true);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function base64Pcm16ToFloat32(base64) {
  const binary = atob(base64);
  const byteLength = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  emitLivePcmLevel("output", samples);
  return samples;
}

export function buildLiveAudioInputMessage(samples) {
  return {
    realtimeInput: {
      audio: {
        data: pcm16ToBase64(samples),
        mimeType: LIVE_INPUT_MIME_TYPE,
      },
    },
  };
}
