import type { StageName } from '@sdlc/shared';

/** The name a person sees for each stage (settings and project pages). */
export const STAGE_LABELS: Record<StageName, string> = {
  kbBuild: 'KB build', plan: 'Plan', breakdown: 'Breakdown', tests: 'Tests', implement: 'Implement',
  fix: 'Fix', review: 'Review', kbUpdate: 'KB update', assist: 'Assistant', repoProfile: 'Repo profiler', onboardAdvise: 'Onboarding advisor',
};
