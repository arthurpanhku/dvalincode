import type { ProviderAdapter } from './types.js';
import type { PoolEntry, RotationPolicy } from '../server/configStore.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import { resolveApiKey } from './secrets.js';

type Slot = { id: string; adapter: ProviderAdapter; weight: number };

// Module-level cursor so round-robin state survives pool re-creation (e.g. config reload)
let rrCursor = 0;

export class ProviderPool {
  private slots: Slot[];
  private policy: RotationPolicy;

  constructor(entries: PoolEntry[], policy: RotationPolicy) {
    this.policy = policy;
    this.slots = entries
      .filter(e => e.enabled)
      .map(e => ({
        id: e.id,
        adapter: createOpenAICompatibleProvider({
          name: e.id,
          apiKey: resolveApiKey(e),
          baseUrl: e.baseUrl,
          model: e.model,
        }),
        weight: Math.max(1, e.weight),
      }));
    if (this.slots.length === 0) throw new Error('Provider pool has no enabled entries');
  }

  next(): { id: string; adapter: ProviderAdapter } {
    if (this.slots.length === 1) return this.slots[0];

    let slot: Slot;
    if (this.policy === 'round-robin') {
      slot = this.slots[rrCursor % this.slots.length];
      rrCursor++;
    } else if (this.policy === 'random') {
      slot = this.slots[Math.floor(Math.random() * this.slots.length)];
    } else {
      // weighted-random
      const total = this.slots.reduce((s, sl) => s + sl.weight, 0);
      let r = Math.random() * total;
      slot = this.slots[this.slots.length - 1];
      for (const sl of this.slots) {
        r -= sl.weight;
        if (r <= 0) { slot = sl; break; }
      }
    }
    return { id: slot.id, adapter: slot.adapter };
  }

  get size(): number {
    return this.slots.length;
  }
}

/** Reset the global round-robin cursor (call when pool config changes). */
export function resetRRCursor(): void {
  rrCursor = 0;
}
