import type { Ticket } from '../generated/prisma/client';

export interface TicketDto {
  id: string;
  projectId: string;
  key: string;
  source: 'jira' | 'paste';
  externalKey: string | null;
  type: 'story' | 'bug' | 'tech';
  title: string;
  body: string;
  featureKey: string | null;
  labels: unknown;
  status: string;
  holdReason: string | null;
  holdFromStatus: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTicketDto(t: Ticket): TicketDto {
  return {
    id: t.id,
    projectId: t.projectId,
    key: t.key,
    source: t.source,
    externalKey: t.externalKey,
    type: t.type,
    title: t.title,
    body: t.body,
    featureKey: t.featureKey,
    labels: t.labels,
    status: t.status,
    holdReason: t.holdReason,
    holdFromStatus: t.holdFromStatus,
    branch: t.branch,
    prNumber: t.prNumber,
    prUrl: t.prUrl,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
