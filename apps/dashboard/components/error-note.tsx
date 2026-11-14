import { ERROR_POLICY, isErrorCode, type ErrorCode } from '@sdlc/shared';
import { formatDateTime } from '@/lib/ticket-status';

const TONE: Record<string, string> = {
  Claude: 'border-amber text-amber',
  Agent: 'border-border text-muted',
  Workspace: 'border-red text-red',
  Jira: 'border-border text-muted',
  Confluence: 'border-border text-muted',
  GitHub: 'border-border text-muted',
  Git: 'border-border text-muted',
  User: 'border-border text-muted',
};

/** Who the failure belongs to: Claude, Agent, Workspace, Jira, Confluence, GitHub, Git or User (BUILD_PLAN v1 6.3). */
export function SourceBadge({ code }: { code: ErrorCode }) {
  const badge = ERROR_POLICY[code].badge;
  return (
    <span data-testid="error-source" className={`rounded border px-1.5 py-0.5 text-xs ${TONE[badge] ?? ''}`}>
      {badge}
    </span>
  );
}

/** An error with its source badge, the message, what to do about it and, for an automatic retry, when it happens. */
export function ErrorNote({ code, message, retryAt }: { code: string | null | undefined; message: string; retryAt?: string | null }) {
  if (!isErrorCode(code)) return <span className="block text-xs text-red">{message}</span>;
  const policy = ERROR_POLICY[code];
  return (
    <span className="mt-1 block space-y-0.5 text-xs">
      <span className="flex items-center gap-2">
        <SourceBadge code={code} />
        <span className="text-red">{message}</span>
      </span>
      <span className="block text-muted">{policy.action}</span>
      {retryAt && new Date(retryAt).getTime() > Date.now() && <span className="block text-muted">Next attempt {formatDateTime(retryAt)}.</span>}
    </span>
  );
}
