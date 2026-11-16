import type { ReactNode } from 'react';
import { Bot, ClipboardList, MessageCircle, ShieldOff, ShieldQuestion, Users } from 'lucide-react';
import type { CodePermissionMode, HomeMode } from '../types.ts';

/** One choice in the composer's mode menu. */
export type ModeOption<T extends string = string> = {
  id: T;
  label: string;
  icon: ReactNode;
  chipClass: string;
  description: string;
};

/** Chat workspace: how much the agent may do on its own. */
export const HOME_MODE_OPTIONS: ModeOption<HomeMode>[] = [
  {
    id: 'chat',
    label: 'Ask',
    icon: <MessageCircle size={11} />,
    chipClass: 'text-info-fg border-blue-500/25 bg-blue-500/10',
    description: 'Read-only — answers questions, never edits',
  },
  {
    id: 'cowork',
    label: 'Collaborate',
    icon: <Users size={11} />,
    chipClass: 'text-muted-fg border-border bg-surface-2',
    description: 'Plans first; edits and commands need approval',
  },
];

/** Code and Dvalin workspaces: the permission mode for tool calls. */
export const CODE_MODE_OPTIONS: ModeOption<CodePermissionMode>[] = [
  {
    id: 'ask',
    label: 'Ask Permissions',
    icon: <ShieldQuestion size={11} />,
    chipClass: 'text-muted-fg border-border bg-surface-2',
    description: 'Approve each write and command',
  },
  {
    id: 'plan',
    label: 'Plan Mode',
    icon: <ClipboardList size={11} />,
    chipClass: 'text-info-fg border-blue-500/25 bg-blue-500/10',
    description: 'Read-only — plan before executing',
  },
  {
    id: 'auto',
    label: 'Auto Mode',
    icon: <Bot size={11} />,
    chipClass: 'text-warn-fg border-orange-500/25 bg-orange-500/10',
    description: 'Run operations automatically',
  },
  {
    id: 'bypass',
    label: 'Bypass permissions',
    icon: <ShieldOff size={11} />,
    chipClass: 'text-warn-fg border-amber-500/25 bg-amber-500/10',
    description: 'No confirmation at all',
  },
];
