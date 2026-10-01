import './csp';
import { createDecartClient, models, noopLogger, type RealTimeClient } from '@decartai/sdk';
import type { EngineBridge, GarmentBytes } from './engine-contract';

let session: RealTimeClient | null = null;
let disposed = false;
const imageFile = (image: GarmentBytes) => new File([image.bytes], image.name, { type: image.type });

const bridge: EngineBridge = {
  async connect(stream, apiKey, garment, prompt, events) {
    if (disposed) throw new Error('Session cancelled');
    const client = createDecartClient({ apiKey, telemetry: false, logger: noopLogger });
    const connected = await client.realtime.connect(stream, {
      model: models.realtime('lucy-vton-3.5'),
      mirror: false,
      initialState: { image: imageFile(garment), prompt: { text: prompt, enhance: false } },
      onRemoteStream: output => { if (!disposed) events.stream(output); },
      onConnectionChange: state => { if (!disposed) events.state(state); }
    });
    if (disposed) { connected.disconnect(); return; }
    session = connected;
    connected.on('stats', stats => events.stats(stats.video?.framesPerSecond ?? null, stats.glassToGlass?.medianMs ?? null));
    connected.on('sessionEnded', () => events.ended());
    connected.on('error', () => events.error());
  },
  async update(garment, prompt) {
    if (!session || disposed) throw new Error('Session unavailable');
    await session.set({ image: imageFile(garment), prompt, enhance: false });
  },
  stop() { disposed = true; session?.disconnect(); session = null; }
};

window.realtimeEngine = bridge;
window.addEventListener('pagehide', () => bridge.stop());
