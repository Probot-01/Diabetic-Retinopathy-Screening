/**
 * Which engine ran the quality gate on this device, in the contract's shape
 * (api-contracts.md, `qualityGateEngine`). The phone's gate is the TypeScript
 * port in qualityGate.ts -- its primary gate, not a fallback -- so it reports
 * "js-device". Recorded with every capture, sent to central, and carried across
 * desktop <-> phone replication so a synced case never shows qualityGate: null.
 */
export interface QualityEngine {
  engine: 'matlab' | 'python' | 'js-fallback' | 'js-device';
  fallback: boolean;
  detail: string | null;
}

export const QUALITY_GATE_ENGINE: QualityEngine = {
  engine: 'js-device',
  fallback: false,
  detail: 'qualityGate.ts, the TypeScript port of qualityGateMain.m, run on the phone',
};
