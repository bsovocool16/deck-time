// The deck-time companion, unchanged, running inside the page. Node's modules
// are swapped for the stand-ins in ./shim (see build.js), and the page's
// fetch('/api/...') and EventSource('/api/events') reach its request handler
// directly. Called by boot.js once the runtime (disk, platform, env) is set.
import { rt } from './shim/runtime.js';
import { startCompanion } from '../companion/src/host.js';

export async function start({ home, edition = 'full' }) {
  const companion = await startCompanion({ home, edition, log: () => {} });
  return { companion, server: rt.server };
}
