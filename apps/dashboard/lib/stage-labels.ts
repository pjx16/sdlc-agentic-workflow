import type { StageName } from '@sdlc/shared';

/** The name a person sees for each stage (settings and project pages). */
export const STAGE_LABELS: Record<StageName, string> = {
  featureMap: 'Feature mapper', kbBuild: 'Documentor (new doc)', solutionDesign: 'Solution architect', bugInvestigation: 'Bug investigator', technicalDesign: 'Technical architect',
  tests: 'Test writer', implement: 'Coder', fix: 'Fixer', prReview: 'PR reviewer', qualityReview: 'Quality reviewer', securityReview: 'Security reviewer',
  kbUpdate: 'Documentor (refresh)', ciTriage: 'CI triager', orchestrate: 'Orchestrator', assist: 'Assistant', repoProfile: 'Repo profiler', onboardAdvise: 'Onboarding advisor',
};
