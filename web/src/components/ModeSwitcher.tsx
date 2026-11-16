import { MessageSquare, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { WorkspaceMode } from '../types.ts';

type Props = {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
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
    label: 'Chat',
    Icon: MessageSquare,
    color: 'text-info-fg',
    activeBg: 'bg-blue-500/10 border-blue-500/25',
    title: 'Chat — ask about your code, or collaborate with approval-gated edits',
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

/** The three workspaces, as equal-width tabs. */
export function ModeSwitcher({ value, onChange }: Props) {
  return (
    <div className="flex w-full rounded-lg overflow-hidden border border-border">
      {MODES.map((mode, i) => {
        const active = value === mode.value;
        return (
          <button
            key={mode.value}
            onClick={() => onChange(mode.value)}
            title={mode.title}
            aria-pressed={active}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium transition-all',
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
