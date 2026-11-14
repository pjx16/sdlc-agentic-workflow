import type { ModelUsageView } from '@/lib/types';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const n = (v: number) => v.toLocaleString('en-US');

function Share({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="inline-block h-1.5 w-16 rounded bg-border">
        <span className="block h-1.5 rounded bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span>
        {pct(value)}
        <span className="sr-only"> of {label}</span>
      </span>
    </span>
  );
}

/** Usage by model: exact tokens and cost, and an estimated share of the usage windows (BUILD_PLAN v1 6.4). */
export function ModelUsage({ data }: { data: ModelUsageView }) {
  if (data.models.length === 0) return <p className="text-sm text-muted">No stage ran in this period.</p>;
  return (
    <div className="space-y-4">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="py-2 font-normal">Model</th>
            <th className="py-2 font-normal">Runs</th>
            <th className="py-2 font-normal">Input</th>
            <th className="py-2 font-normal">Output</th>
            <th className="py-2 font-normal">Cache read</th>
            <th className="py-2 font-normal">Cache write</th>
            <th className="py-2 font-normal">Cost</th>
            <th className="py-2 font-normal">Share of tokens</th>
            <th className="py-2 font-normal">Share of cost</th>
          </tr>
        </thead>
        <tbody>
          {data.models.map((m) => (
            <tr key={m.model} className="border-t border-border align-top">
              <td className="py-2 font-mono">{m.model}</td>
              <td className="py-2">{m.runs}</td>
              <td className="py-2">{n(m.inputTokens)}</td>
              <td className="py-2">{n(m.outputTokens)}</td>
              <td className="py-2">{n(m.cacheReadTokens)}</td>
              <td className="py-2">{n(m.cacheWriteTokens)}</td>
              <td className="py-2">${m.costUsd.toFixed(2)}</td>
              <td className="py-2">
                <Share value={m.tokenShare} label="tokens" />
              </td>
              <td className="py-2">
                <Share value={m.costShare} label="cost" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div>
        <h3 className="mb-1 text-sm font-medium">
          Share of the usage windows <span className="rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted">estimate</span>
        </h3>
        <p className="mb-2 text-xs text-muted">{data.estimateNote}</p>
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-normal">Model</th>
              <th className="py-1 font-normal">5-hour (points)</th>
              <th className="py-1 font-normal">5-hour share</th>
              <th className="py-1 font-normal">Weekly (points)</th>
              <th className="py-1 font-normal">Weekly share</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.model} className="border-t border-border">
                <td className="py-1 font-mono">{m.model}</td>
                <td className="py-1">{m.estimate.fiveHourPts}</td>
                <td className="py-1">{pct(m.estimate.fiveHourShare)}</td>
                <td className="py-1">{m.estimate.weeklyPts}</td>
                <td className="py-1">{pct(m.estimate.weeklyShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {data.models.map((m) => (
          <div key={m.model} className="panel p-3">
            <h3 className="mb-1 font-mono text-sm">{m.model}: by stage</h3>
            <ul className="space-y-0.5 text-sm">
              {m.byStage.map((s) => (
                <li key={s.stage} className="flex justify-between">
                  <span>{s.stage}</span>
                  <span className="text-muted">
                    {n(s.tokens)} tokens · ${s.costUsd.toFixed(2)} · {s.runs} runs
                  </span>
                </li>
              ))}
            </ul>
            <h4 className="mb-1 mt-3 text-xs text-muted">Per day</h4>
            <ul className="space-y-0.5 text-xs text-muted">
              {m.perDay.map((d) => (
                <li key={d.day} className="flex justify-between">
                  <span>{d.day}</span>
                  <span>
                    {n(d.tokens)} tokens · ${d.costUsd.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
