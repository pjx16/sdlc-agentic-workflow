import { z } from 'zod';
import { MODEL_ALIASES } from './enums';

const int = (def: number, min: number, max: number) =>
  z.number({ error: 'must be a number' }).int('must be a whole number').min(min, `must be at least ${min}`).max(max, `must be at most ${max}`).default(def);

/** The user-editable part of GlobalSettings (pause state and usage-gate bookkeeping have their own endpoints). */
export const GlobalSettingsSchema = z.object({
  usageThresholdPct: int(50, 1, 100),
  usageThresholdWeeklyPct: int(80, 1, 100),
  calibratedWindowTokens: z.number().int().min(1, 'must be at least 1').nullable().default(null),
  pollIntervalSec: int(120, 5, 3600),
  stageTimeoutMin: int(20, 1, 240),
  verifyTimeoutSec: int(600, 10, 7200),
  workspaceRetentionDays: int(7, 1, 365),
  logRetentionDays: int(30, 1, 3650),
  modelAliases: z
    .object(Object.fromEntries(MODEL_ALIASES.map((m) => [m, z.string().trim().min(1, 'required').default(m)])) as Record<(typeof MODEL_ALIASES)[number], z.ZodDefault<z.ZodString>>)
    .prefault({}),
});

export type GlobalSettingsInput = z.infer<typeof GlobalSettingsSchema>;
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettingsInput = GlobalSettingsSchema.parse({});
