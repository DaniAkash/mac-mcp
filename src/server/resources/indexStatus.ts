import type { DomainPlugin } from "../../types.ts";

export const INDEX_STATUS_URI = "index://status";

/**
 * Collect the per-domain index health snapshot. Plugins without a
 * `getIndexStatus` opt out (returns `{ available: true }`).
 */
export async function readIndexStatus(plugins: DomainPlugin[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const p of plugins) {
    if (p.getIndexStatus) {
      try {
        out[p.name] = await p.getIndexStatus();
      } catch (e) {
        out[p.name] = { available: false, reason: (e as Error).message };
      }
    } else {
      out[p.name] = { available: true };
    }
  }
  return out;
}
