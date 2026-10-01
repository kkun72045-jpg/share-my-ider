export interface GarmentBytes { bytes: ArrayBuffer; type: string; name: string }
export interface EngineEvents {
  stream: (stream: MediaStream) => void;
  state: (state: string) => void;
  stats: (fps: number | null, latency: number | null) => void;
  ended: () => void;
  error: () => void;
}
export interface EngineBridge {
  connect: (stream: MediaStream, apiKey: string, garment: GarmentBytes, prompt: string, events: EngineEvents) => Promise<void>;
  update: (garment: GarmentBytes, prompt: string) => Promise<void>;
  stop: () => void;
}
declare global { interface Window { realtimeEngine?: EngineBridge } }
