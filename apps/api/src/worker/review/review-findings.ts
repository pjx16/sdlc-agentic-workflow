export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const MAX_FINDINGS_PER_ROUND = 10;

export interface StoredFinding {
  id: string;
  round: number;
  severity: string;
  file: string;
  line: number | null;
  issue: string;
  rule: string;
  fix: string;
  status: string;
}

/** Critical and high findings are the ones that trigger a fix round (F10). */
export const blocksReview = (severity: string): boolean => severity === 'critical' || severity === 'high';

export const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const bySeverity = <T extends { severity: string }>(findings: readonly T[]): T[] => [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
