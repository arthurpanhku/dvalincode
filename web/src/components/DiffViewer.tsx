import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { DiffLine } from '../types.ts';

type Props = {
  diff: DiffLine[];
  filePath?: string;
};

const CONTEXT_LINES = 3;
const COLLAPSE_THRESHOLD = 12;

/** Return only changed lines ± CONTEXT_LINES neighbours for the compact view. */
function compactDiff(diff: DiffLine[]): { lines: DiffLine[]; truncated: boolean } {
  if (diff.length <= COLLAPSE_THRESHOLD) return { lines: diff, truncated: false };

  const changedIdx = new Set<number>();
  diff.forEach((l, i) => { if (l.type !== 'keep') changedIdx.add(i); });

  const visible = new Set<number>();
  changedIdx.forEach((i) => {
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(diff.length - 1, i + CONTEXT_LINES); j++) {
      visible.add(j);
    }
  });

  return {
    lines: [...visible].sort((a, b) => a - b).map((i) => diff[i]),
    truncated: visible.size < diff.length,
  };
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bg =
    line.type === 'add'
      ? 'bg-emerald-500/10 text-success-fg'
      : line.type === 'remove'
      ? 'bg-red-500/10 text-danger-fg'
      : 'text-muted-fg';

  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';

  return (
    <div className={`flex gap-2 px-3 py-0.5 leading-5 ${bg}`}>
      <span className="select-none w-3 flex-shrink-0 opacity-60">{prefix}</span>
      <span className="break-all whitespace-pre-wrap">{line.content}</span>
    </div>
  );
}

export function DiffViewer({ diff, filePath }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (diff.length === 0) return null;

  const { lines, truncated } = expanded ? { lines: diff, truncated: false } : compactDiff(diff);
  const addCount = diff.filter((l) => l.type === 'add').length;
  const removeCount = diff.filter((l) => l.type === 'remove').length;

  return (
    <div className="rounded border border-border overflow-hidden text-xs font-mono mt-1.5">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-elevated border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          {filePath && (
            <span className="text-muted-fg truncate">{filePath}</span>
          )}
          <span className="text-success-fg flex-shrink-0">+{addCount}</span>
          <span className="text-danger-fg flex-shrink-0">-{removeCount}</span>
        </div>
        {(truncated || expanded) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-muted-fg hover:text-fg transition-colors flex-shrink-0 ml-2"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {expanded ? 'collapse' : `show all ${diff.length} lines`}
          </button>
        )}
      </div>

      {/* Diff lines */}
      <div className="overflow-x-auto bg-elevated">
        {lines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
        {truncated && (
          <div className="px-3 py-1 text-muted-fg italic">
            … {diff.length - lines.length} more lines hidden
          </div>
        )}
      </div>
    </div>
  );
}
