import { House, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { WorkspaceMode } from '../types.ts';

type Props = {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
  /** When true, fills the parent width with equal-width tabs */
  fullWidth?: boolean;
};

const MODES: {
  value: WorkspaceMode;
  label: string;
  Icon: LucideIcon;
  color: string;
  activeBg: string;
  title: string;
}[] = [
  {
    value: 'home',
    label: 'Home',
    Icon: House,
    color: 'text-info-fg',
    activeBg: 'bg-blue-500/10 border-blue-500/25',
    title: 'Home — ask questions or collaborate with approval-gated edits',
  },
  {
    value: 'code',
    label: 'Code',
    Icon: Zap,
    color: 'text-warn-fg',
    activeBg: 'bg-orange-500/10 border-orange-500/25',
    title: 'Code — autonomous agent, full tool access',
  },
  {
    value: 'dvalin',
    label: 'Dvalin',
    Icon: ShieldCheck,
    color: 'text-success-fg',
    activeBg: 'bg-emerald-500/10 border-emerald-500/25',
    title: 'Dvalin — scan, remediate, verify, and publish security fixes',
  },
];

export function ModeSwitcher({ value, onChange, fullWidth }: Props) {
  if (fullWidth) {
    return (
      <div className="flex w-full rounded-lg overflow-hidden border border-border">
        {MODES.map((mode, i) => {
          const active = value === mode.value;
          return (
            <button
              key={mode.value}
              onClick={() => onChange(mode.value)}
              title={mode.title}
              className={[
                'flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-all',
                i > 0 ? 'border-l border-border' : '',
                active
                  ? `${mode.color} ${mode.activeBg}`
                  : 'text-muted-fg hover:text-fg hover:bg-surface-2',
              ].join(' ')}
            >
              <mode.Icon size={12} />
              {mode.label}
            </button>
          );
        })}
      </div>
    );
  }

  /* Compact inline variant (kept for potential reuse) */
  return (
    <div className="flex items-center bg-surface border border-border rounded-lg p-0.5 gap-0.5">
      {MODES.map((mode) => {
        const active = value === mode.value;
        return (
          <button
            key={mode.value}
            onClick={() => onChange(mode.value)}
            title={mode.title}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              active
                ? `${mode.color} bg-surface-2 border border-border shadow-sm`
                : 'text-muted-fg hover:text-fg'
            }`}
          >
            <mode.Icon size={11} />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
