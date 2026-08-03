import { useState } from 'react';
import { ClipboardList, ChevronDown, ChevronUp, PlayCircle } from 'lucide-react';

type Props = {
  steps: string[];
  onProceed?: (message: string) => void;
};

export function PlanCard({ steps, onProceed }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setDone((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <div className="my-3 border border-violet-500/25 rounded-xl overflow-hidden bg-violet-500/5">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-violet-500/10 border-b border-violet-500/20">
        <ClipboardList size={13} className="text-violet-400 flex-shrink-0" />
        <span className="text-xs font-semibold text-violet-300">Plan · {steps.length} steps</span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="ml-auto text-violet-400/60 hover:text-violet-300 transition-colors"
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Steps */}
          <ol className="px-4 py-3 flex flex-col gap-1.5">
            {steps.map((step, i) => (
              <li
                key={i}
                className="flex items-start gap-2.5 cursor-pointer group"
                onClick={() => toggle(i)}
              >
                {/* Checkbox */}
                <span
                  className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-[10px] transition-colors ${
                    done.has(i)
                      ? 'bg-violet-500 border-violet-500 text-white'
                      : 'border-violet-500/40 group-hover:border-violet-400'
                  }`}
                >
                  {done.has(i) ? '✓' : ''}
                </span>
                <span
                  className={`text-xs leading-relaxed transition-colors ${
                    done.has(i) ? 'text-muted-fg line-through' : 'text-fg/90'
                  }`}
                >
                  <span className="text-violet-400 font-mono mr-1">{i + 1}.</span>
                  {step}
                </span>
              </li>
            ))}
          </ol>

          {/* Proceed button */}
          {onProceed && (
            <div className="px-4 pb-3">
              <button
                onClick={() => onProceed('Proceed with the plan above. Execute each step in order.')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-300 hover:text-violet-200 transition-all font-medium"
              >
                <PlayCircle size={12} />
                Proceed with Plan
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Extract numbered steps from markdown text. Returns null if <3 steps found. */
export function extractPlanSteps(content: string): string[] | null {
  const lines = content.split('\n');
  const steps: string[] = [];

  for (const line of lines) {
    const m = line.match(/^\s*\d+\.\s+(.+)/);
    if (m) {
      steps.push(m[1].trim());
    }
  }

  return steps.length >= 3 ? steps : null;
}
