/*
 * AudioWorkletProcessor that captures mono PCM frames and forwards them
 * to the main thread for aggregation.
 */
class PCMCollectorProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    // copy Float32Array to detach from audio thread buffer
    const copy = new Float32Array(channel);
    this.port.postMessage(copy);
    return true;
  }
}

registerProcessor('audio-processor', PCMCollectorProcessor);
