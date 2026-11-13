import { stringifyNumbers, toNumber, type FormValues } from './form';
import type { GlobalSettingsView } from './types';

const NUMERIC_PATHS = [
  'usageThresholdPct', 'usageThresholdWeeklyPct', 'calibratedWindowTokens', 'pollIntervalSec',
  'stageTimeoutMin', 'verifyTimeoutSec', 'workspaceRetentionDays', 'logRetentionDays', 'assistantTokenCap',
] as const;

export function initialSettingsValues(s: GlobalSettingsView): FormValues {
  return {
    ...stringifyNumbers({
      usageThresholdPct: s.usageThresholdPct,
      usageThresholdWeeklyPct: s.usageThresholdWeeklyPct,
      pollIntervalSec: s.pollIntervalSec,
      stageTimeoutMin: s.stageTimeoutMin,
      verifyTimeoutSec: s.verifyTimeoutSec,
      workspaceRetentionDays: s.workspaceRetentionDays,
      logRetentionDays: s.logRetentionDays,
      assistantTokenCap: s.assistantTokenCap,
    }),
    calibratedWindowTokens: s.calibratedWindowTokens === null ? '' : String(s.calibratedWindowTokens),
    modelAliases: { ...s.modelAliases },
  };
}

/** Empty calibration means "not calibrated" (null); other empty numbers stay null so the API reports them. */
export function toSettingsPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, any> = { ...values }; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const key of NUMERIC_PATHS) out[key] = toNumber(values[key]);
  return out;
}
