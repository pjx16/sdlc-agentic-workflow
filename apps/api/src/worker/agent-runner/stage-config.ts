import type { ClaudeMdMode, ModelAlias, StageName } from '@sdlc/shared';

export type WorkspaceAccess = 'rw' | 'ro' | 'none';

/** Workspace mounting per stage (BUILD_PLAN 6.4 table). kbBuild and kbUpdate may only change `kbDir`. */
export const STAGE_WORKSPACE: Record<StageName, WorkspaceAccess> = {
  featureMap: 'ro', kbBuild: 'rw', solutionDesign: 'ro', bugInvestigation: 'ro', technicalDesign: 'ro', tests: 'rw', implement: 'rw', fix: 'rw',
  prReview: 'ro', qualityReview: 'ro', securityReview: 'ro', kbUpdate: 'rw', ciTriage: 'none', assist: 'ro', repoProfile: 'ro', onboardAdvise: 'none',
};

/** `stage.json`, read by run-stage (BUILD_PLAN 6.4). `attempt` and `round` are extra, for the test stub and diagnostics. */
export interface StageJson {
  model: string;
  maxTurns: number;
  disallowedTools: string[];
  /** Continue this CLI session (the assistant keeps one conversation per support ticket). */
  resumeSession?: string;
  attempt: number;
  round: number;
}

export interface StageConfigInput {
  stage: StageName;
  /** Alias from the project's stage settings (haiku, sonnet, opus). */
  modelAlias: ModelAlias;
  /** GlobalSettings.modelAliases: what each alias resolves to. */
  modelAliases: Record<ModelAlias, string>;
  maxTurns: number;
  attempt?: number;
  round?: number;
  resumeSession?: string;
}

const ALWAYS_DISALLOWED = ['WebFetch', 'WebSearch'];
const READ_ONLY_EXTRA = ['Edit', 'Write', 'NotebookEdit'];

export function buildStageJson(input: StageConfigInput): StageJson {
  const disallowed = [...ALWAYS_DISALLOWED];
  // Only a stage with a read-write workspace may edit files; a read-only or workspace-less stage has nothing it may change.
  if (STAGE_WORKSPACE[input.stage] !== 'rw') disallowed.push(...READ_ONLY_EXTRA);

  const json: StageJson = {
    model: input.modelAliases[input.modelAlias],
    maxTurns: input.maxTurns,
    disallowedTools: disallowed,
    attempt: input.attempt ?? 1,
    round: input.round ?? 0,
    ...(input.resumeSession ? { resumeSession: input.resumeSession } : {}),
  };
  return json;
}

const OUR_CLAUDE_MD_MODES: readonly ClaudeMdMode[] = ['ours', 'both'];

/** `system.md` includes our default CLAUDE.md in modes ours and both. */
export const includesOurClaudeMd = (mode: ClaudeMdMode): boolean => OUR_CLAUDE_MD_MODES.includes(mode);

/** Only mode `ours` hides the repository's own CLAUDE.md (an empty file is bind-mounted over it). */
export const hidesRepoClaudeMd = (mode: ClaudeMdMode): boolean => mode === 'ours';

export const CLAUDE_MD_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;
