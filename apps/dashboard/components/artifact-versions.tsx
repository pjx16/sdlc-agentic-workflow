'use client';

import { planDiff } from '@sdlc/shared';
import { useState } from 'react';
import { formatDateTime } from '@/lib/ticket-status';
import type { ArtifactView } from '@/lib/types';

const TITLE: Record<string, string> = { plan: 'Plan', breakdown: 'Breakdown', review: 'Review rounds', kb: 'Knowledge base' };

/** What an artifact says, as text to read or to compare. */
export function artifactText(a: Pick<ArtifactView, 'stage' | 'data'>): string {
  const d = (a.data ?? {}) as Record<string, unknown>;
  if (a.stage === 'plan') return String(d.planMarkdown ?? '');
  if (a.stage === 'breakdown') return ((d.subtasks as { seq: number; title: string; description?: string }[] | undefined) ?? []).map((s) => `${s.seq}. ${s.title}${s.description ? `: ${s.description}` : ''}`).join('\n');
  if (a.stage === 'review') return `Round ${String(d.round ?? '')}: ${((d.findings as { severity: string; file: string; issue: string }[] | undefined) ?? []).map((f) => `${f.severity} ${f.file}: ${f.issue}`).join('\n') || 'no findings'}`;
  if (a.stage === 'kb') return `${String(d.featureKey ?? '')}${d.docPath ? ` (${String(d.docPath)})` : ''}`;
  return JSON.stringify(a.data, null, 2);
}

/**
 * Every version of the plan, breakdown, review rounds and KB pointer (BUILD_PLAN v1 6.8). The current one is the latest that is not
 * stale; older and stale versions are kept next to it, and any version can be compared with the current one.
 */
export function ArtifactVersions({ artifacts }: { artifacts: ArtifactView[] }) {
  const [compare, setCompare] = useState<string | null>(null);
  if (artifacts.length === 0) return <p className="text-sm text-muted">Nothing has been produced for this ticket yet.</p>;
  const stages = [...new Set(artifacts.map((a) => a.stage))];
  return (
    <div className="space-y-8">
      {stages.map((stage) => {
        const versions = artifacts.filter((a) => a.stage === stage);
        const current = [...versions].reverse().find((v) => !v.stale);
        return (
          <section key={stage} aria-label={TITLE[stage] ?? stage}>
            <h3 className="text-sm font-medium">
              {TITLE[stage] ?? stage} <span className="text-muted">({versions.length} version{versions.length === 1 ? '' : 's'})</span>
            </h3>
            <ul className="mt-2 grid gap-3 md:grid-cols-2">
              {versions.map((v) => {
                const isCurrent = v.id === current?.id;
                return (
                  <li key={v.id} data-stale={v.stale} className={`panel p-3 ${v.stale ? 'opacity-60' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="font-medium text-fg">Version {v.version}</span>
                      <span>{formatDateTime(v.createdAt)}</span>
                      {isCurrent && <span className="rounded border border-border px-1.5 py-0.5 text-green">current</span>}
                      {v.stale && <span className="rounded border border-border px-1.5 py-0.5">stale</span>}
                      {v.externalUrl && (
                        <a href={v.externalUrl} className="text-accent hover:underline">
                          Open in Confluence
                        </a>
                      )}
                    </div>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans text-sm">{artifactText(v)}</pre>
                    {current && !isCurrent && (
                      <button type="button" onClick={() => setCompare(compare === v.id ? null : v.id)} aria-expanded={compare === v.id} className="mt-2 text-xs text-accent underline">
                        {compare === v.id ? 'Hide the comparison' : 'Compare with the current version'}
                      </button>
                    )}
                    {compare === v.id && current && (
                      <pre aria-label="Changes since this version" className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs">
                        {planDiff(artifactText(v), artifactText(current)).split('\n').map((line, i) => (
                          <span key={i} className={line.startsWith('+ ') ? 'block text-green' : line.startsWith('- ') ? 'block text-red' : 'block'}>
                            {line}
                          </span>
                        ))}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
