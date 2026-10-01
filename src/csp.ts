import { config } from 'zod';
// Run before SDK schemas are constructed: MV3 forbids dynamic code evaluation.
config({ jitless: true });
