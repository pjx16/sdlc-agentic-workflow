'use client';

import { useId, useState, type ReactNode } from 'react';

export interface ChartTable {
  columns: string[];
  rows: (string | number | null)[][];
}

interface Props {
  title: string;
  /** The text alternative: what the chart shows, in a sentence or two (BUILD_PLAN 13). */
  summary: string;
  empty: boolean;
  emptyText: string;
  table: ChartTable;
  children: ReactNode;
}

/**
 * Every chart (F17): a title, a text alternative, a clear empty state, and a "View data" toggle that shows the same numbers as a table.
 */
export function ChartFrame({ title, summary, empty, emptyText, table, children }: Props) {
  const [showData, setShowData] = useState(false);
  const id = useId();
  return (
    <figure className="rounded-lg border border-border bg-surface p-4">
      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {!empty && (
          <button type="button" aria-pressed={showData} aria-controls={id} onClick={() => setShowData((v) => !v)} className="text-xs text-muted underline">
            {showData ? 'View chart' : 'View data'}
          </button>
        )}
      </figcaption>
      <p className="mt-1 text-xs text-muted">{summary}</p>
      <div id={id} className="mt-3">
        {empty ? (
          <p className="py-10 text-center text-sm text-muted">{emptyText}</p>
        ) : showData ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c} scope="col" className="py-1 pr-3 font-normal">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {row.map((cell, j) => (
                      <td key={j} className="py-1 pr-3">
                        {cell ?? '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div role="img" aria-label={`${title}. ${summary}`}>
            {children}
          </div>
        )}
      </div>
    </figure>
  );
}
