import { useState, useEffect } from 'react';
import {
  Plus, MessageSquare, Trash2, Zap, ChevronRight, X, Check, Download,
} from 'lucide-react';
import type { SessionMeta } from '../types.ts';
import { fetchPlaybook, savePlaybook, downloadSessionMarkdown } from '../lib/client.ts';
import { SecurityRemediation } from './SecurityRemediation.tsx';

// ── Local-storage routines ────────────────────────────────────────────────────

type Routine = { name: string; prompt: string };

const DEFAULT_ROUTINES: Routine[] = [
  { name: 'Run tests',   prompt: 'Run the test suite and report any failures with details.' },
  { name: 'Type check',  prompt: 'Run TypeScript type-checking and list all type errors.' },
  { name: 'Build',       prompt: 'Build the project and report any build errors or warnings.' },
  { name: 'Git status',  prompt: '/git' },
  { name: 'Lint',        prompt: 'Run the linter and show any issues that need fixing.' },
];

function useRoutines(): [Routine[], (r: Routine[]) => void] {
  const KEY = 'dvalincode-routines-v1';
  const [routines, setRoutinesState] = useState<Routine[]>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      return stored ? (JSON.parse(stored) as Routine[]) : DEFAULT_ROUTINES;
    } catch {
      return DEFAULT_ROUTINES;
    }
  });
  const setRoutines = (r: Routine[]) => {
    setRoutinesState(r);
    localStorage.setItem(KEY, JSON.stringify(r));
  };
  return [routines, setRoutines];
}

// ── Session row ───────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SessionRow({
  session, active, onSelect, onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={`group flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors text-xs border ${
        active
          ? 'bg-orange-500/10 border-orange-500/20 text-fg'
          : 'hover:bg-surface-2 text-muted-fg hover:text-fg border-transparent'
      }`}
    >
      <MessageSquare size={12} className="mt-0.5 flex-shrink-0 opacity-50" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate leading-tight">
          {session.summary
            ? session.summary.replace(/^User wanted: /, '').slice(0, 38)
            : session.cwd.split('/').pop() ?? session.id}
        </div>
        <div className="text-[10px] text-muted-fg mt-0.5 opacity-70">
          {timeAgo(session.updatedAt)} · {session.messageCount} msg
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); downloadSessionMarkdown(session.id); }}
        title="Download Markdown transcript"
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-accent transition-all flex-shrink-0"
      >
        <Download size={11} />
      </button>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-400 transition-all flex-shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// ── Add routine form ──────────────────────────────────────────────────────────

function AddRoutineForm({ onAdd }: { onAdd: (r: Routine) => void }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  const submit = () => {
    if (!name.trim() || !prompt.trim()) return;
    onAdd({ name: name.trim(), prompt: prompt.trim() });
    setName('');
    setPrompt('');
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5 px-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Routine name…"
        className="w-full bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-muted-fg outline-none focus:border-accent/40"
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Prompt or /command…"
        rows={2}
        className="w-full bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-muted-fg outline-none focus:border-accent/40 resize-none"
      />
      <div className="flex gap-1.5">
        <button
          onClick={submit}
          disabled={!name.trim() || !prompt.trim()}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs rounded-lg bg-orange-500/15 hover:bg-orange-500/25 text-orange-300 border border-orange-500/25 disabled:opacity-40 transition-colors"
        >
          <Check size={11} />
          Save
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
  onSend: (text: string) => void;
  cwd?: string;
  onCwdChange?: (cwd: string) => void;
};

export function SidebarCode({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onSend,
  cwd,
  onCwdChange,
}: Props) {
  const [routines, setRoutines] = useRoutines();
  const [addingRoutine, setAddingRoutine] = useState(false);
  const [projectRoutines, setProjectRoutines] = useState<Routine[]>([]);
  const [exportToast, setExportToast] = useState(false);

  useEffect(() => {
    if (!cwd) { setProjectRoutines([]); return; }
    fetchPlaybook(cwd).then((items) => {
      setProjectRoutines(items.map((r) => ({ name: r.label, prompt: r.prompt })));
    }).catch(() => {});
  }, [cwd]);

  const removeRoutine = (name: string) =>
    setRoutines(routines.filter((r) => r.name !== name));

  const handleExport = async () => {
    if (!cwd) return;
    await savePlaybook(cwd, routines.map((r) => ({ label: r.name, prompt: r.prompt })));
    setExportToast(true);
    setTimeout(() => setExportToast(false), 3000);
  };

  // My routines: exclude any whose name matches a project routine label
  const projectLabels = new Set(projectRoutines.map((r) => r.name));
  const myRoutines = routines.filter((r) => !projectLabels.has(r.name));

  return (
    <>
      {/* New session */}
      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-orange-500/40 hover:bg-orange-500/5 text-muted-fg hover:text-fg transition-all text-xs"
        >
          <Plus size={13} />
          New session
          <kbd className="ml-auto text-[10px] opacity-40">⌘N</kbd>
        </button>
      </div>

      <SecurityRemediation cwd={cwd} onSend={onSend} onCwdChange={onCwdChange} />

      {/* Routines */}
      <div className="px-3 pb-2 border-b border-border">
        <div className="flex items-center justify-between px-1 mb-1">
          <span className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider">
            Routines
          </span>
          <div className="flex items-center gap-1.5">
            {cwd && (
              <button
                onClick={() => void handleExport()}
                className="text-[10px] text-muted-fg/50 hover:text-muted-fg transition-colors"
                title="Export routines to dvalin.json"
              >
                <Download size={11} />
              </button>
            )}
            <button
              onClick={() => setAddingRoutine((v) => !v)}
              className={`text-[10px] transition-colors ${
                addingRoutine ? 'text-orange-400' : 'text-muted-fg/50 hover:text-muted-fg'
              }`}
              title={addingRoutine ? 'Cancel' : 'Add routine'}
            >
              {addingRoutine ? <X size={11} /> : <Plus size={11} />}
            </button>
          </div>
        </div>

        {exportToast && (
          <div className="mb-1.5 px-2 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-[10px] text-green-400">
            Saved to dvalin.json — commit it to share with your team
          </div>
        )}

        {/* Project routines */}
        {projectRoutines.length > 0 && (
          <div className="mb-1">
            <div className="text-[9px] font-semibold text-muted-fg/40 uppercase tracking-wider px-1 mb-0.5">
              Project
            </div>
            <div className="flex flex-col gap-0.5">
              {projectRoutines.map((r) => (
                <button
                  key={r.name}
                  onClick={() => onSend(r.prompt)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors text-left w-full"
                >
                  <Zap size={11} className="text-blue-400/70 flex-shrink-0" />
                  <span className="truncate flex-1">{r.name}</span>
                  <ChevronRight size={10} className="opacity-30 flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* My routines */}
        {(projectRoutines.length > 0 || myRoutines.length > 0) && projectRoutines.length > 0 && (
          <div className="text-[9px] font-semibold text-muted-fg/40 uppercase tracking-wider px-1 mb-0.5">
            My routines
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {myRoutines.map((r) => (
            <div key={r.name} className="group flex items-center gap-1">
              <button
                onClick={() => onSend(r.prompt)}
                className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors text-left"
              >
                <Zap size={11} className="text-orange-400/70 flex-shrink-0" />
                <span className="truncate">{r.name}</span>
                <ChevronRight size={10} className="ml-auto opacity-30 flex-shrink-0" />
              </button>
              <button
                onClick={() => removeRoutine(r.name)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-red-400 transition-all flex-shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>

        {addingRoutine && (
          <AddRoutineForm
            onAdd={(r) => {
              setRoutines([...routines, r]);
              setAddingRoutine(false);
            }}
          />
        )}
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider px-2 py-1.5">
          Sessions
        </div>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-fg/50 px-3 py-3 text-center">No sessions yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSessionId}
                onSelect={() => onSelectSession(s.id)}
                onDelete={(e) => onDeleteSession(e, s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
