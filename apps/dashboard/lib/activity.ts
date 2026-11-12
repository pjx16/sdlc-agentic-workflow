import { formatDuration } from './ticket-status';
import type { IntakeStatusView, SystemView } from './types';

export type Tone = 'green' | 'amber' | 'red' | 'grey';

export interface ActivityLine {
  key: 'worker' | 'pipeline' | 'intake-rest' | 'intake-mcp' | 'intake';
  label: string;
  tone: Tone;
  text: string;
  /** A link the line offers (to the page that fixes it or shows more). */
  link?: { href: string; text: string };
}

/** "5s ago", "3 min ago", "2 h ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** "in 40s", "in 2 min" (or "due now"). */
export function inFuture(ms: number): string {
  if (ms <= 0) return 'due now';
  const s = Math.round(ms / 1000);
  return s < 120 ? `in ${s}s` : `in ${Math.round(s / 60)} min`;
}

const MODE = { rest: 'REST', mcp: 'MCP' } as const;

function intakeLine(i: IntakeStatusView, system: SystemView, now: number): ActivityLine {
  const key = i.mode === 'mcp' ? 'intake-mcp' : 'intake-rest';
  const label = `Jira intake (${MODE[i.mode]})`;
  const when = ago(i.at, now);
  if (i.skipped === 'intake_paused') return { key, label, tone: 'amber', text: `Paused: not reading Jira (last checked ${when}).` };
  if (i.skipped === 'backoff') return { key, label, tone: 'amber', text: `Jira was unreachable; waiting before trying again (last attempt ${when}).` };
  if (i.error) return { key, label, tone: 'red', text: `Last poll ${when} failed: ${i.error}` };
  if (i.projects === 0 && i.waiting > 0) {
    return { key, label, tone: 'amber', text: `${i.waiting} project${i.waiting === 1 ? ' is' : 's are'} set to ${MODE[i.mode]} but the repository mirror is not Ready, so nothing is polled.`, link: { href: '/projects', text: 'Projects' } };
  }
  if (i.projects === 0) return { key, label, tone: 'grey', text: `No project uses ${MODE[i.mode]} intake.`, link: { href: '/projects', text: 'Projects' } };
  const found = `found ${i.seen} ticket${i.seen === 1 ? '' : 's'}${i.created > 0 ? `, ${i.created} new` : ''}`;
  const next =
    i.mode === 'rest' && i.at ? ` Next poll ${inFuture(new Date(i.at).getTime() + system.settings.pollIntervalSec * 1000 - now)}.` : i.mode === 'mcp' ? ' Each MCP poll runs Claude; per-project interval (default 15 min).' : '';
  return { key, label, tone: 'green', text: `Polled ${when}: ${found}.${next}` };
}

/** What the worker is doing, in plain language: is it alive, what the pipeline is doing, and what Jira intake did last. */
export function describeActivity(system: SystemView | null, now: number): ActivityLine[] {
  const lines: ActivityLine[] = [];
  const worker = system?.worker ?? null;

  if (!system || !worker) {
    lines.push({ key: 'worker', label: 'Worker', tone: 'amber', text: 'Has not reported yet. If it is not running, nothing will happen: start it with `npm run up:dev` or `docker compose up -d`.' });
    return lines;
  }
  if (!worker.online) {
    lines.push({ key: 'worker', label: 'Worker', tone: 'red', text: `Offline: last seen ${ago(worker.heartbeatAt, now)}. Nothing is polled or run until it is started again.` });
    return lines;
  }
  lines.push({ key: 'worker', label: 'Worker', tone: 'green', text: `Online (checked ${ago(worker.heartbeatAt, now)}).` });

  const run = system.runningStage ?? null;
  if (system.settings.pipelinePaused) {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'amber', text: `Paused. ${system.settings.pausedReason === 'manual' ? 'Paused by you.' : (system.settings.pausedReason ?? '')}`.trim() });
  } else if (run) {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'green', text: `Running ${run.stage} with ${run.model}${run.startedAt ? ` for ${formatDuration(run.startedAt, new Date(now).toISOString())}` : ''}.`, link: { href: `/runs/${run.id}`, text: 'Watch the log' } });
  } else if (worker.tickOutcome === 'not_configured') {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'amber', text: `Blocked: setup is incomplete (missing ${worker.tickDetail ?? 'credentials'}).`, link: { href: '/setup/connections', text: 'Finish setup' } });
  } else if (worker.tickOutcome === 'stepped' && worker.tickDetail) {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'green', text: `Working on ${worker.tickDetail}.` });
  } else if (worker.tickOutcome === 'idle' && worker.tickDetail?.startsWith('Iteration failed')) {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'red', text: worker.tickDetail });
  } else {
    lines.push({ key: 'pipeline', label: 'Pipeline', tone: 'grey', text: 'Idle. No ticket is waiting for a stage.' });
  }

  if (system.settings.intakePaused) {
    lines.push({ key: 'intake', label: 'Jira intake', tone: 'amber', text: 'Paused by you: Jira is not being read. Pasted tickets still work.' });
  } else if (worker.intake.length === 0) {
    lines.push({ key: 'intake', label: 'Jira intake', tone: 'grey', text: 'Has not polled yet. It needs a project with Jira mode REST or MCP and a ready mirror.' });
  } else {
    const relevant = worker.intake.filter((i) => i.projects > 0 || i.waiting > 0 || i.error || i.skipped);
    for (const i of relevant.length > 0 ? relevant : worker.intake.slice(0, 1)) lines.push(intakeLine(i, system, now));
  }
  return lines;
}
