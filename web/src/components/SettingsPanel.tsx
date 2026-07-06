import { useEffect, useRef, useState } from 'react';
import { X, Settings, Monitor, Sun, Moon, Download, Upload, BookOpen, Trash2, KeyRound, Server, Terminal } from 'lucide-react';
import type { ApprovalMode, ProviderKeySource, SkillSummary } from '../types.ts';
import { getStoredTheme, setTheme, type Theme } from '../lib/theme.ts';
import { deleteSkill, downloadDataExport, downloadSkill, fetchSkills, importDataBundle, importSkillBundle } from '../lib/client.ts';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function ThemeSwitcher() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const pick = (value: Theme) => {
    setTheme(value);
    setThemeState(value);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-fg font-medium">Theme</span>
      <div className="flex gap-1 bg-elevated border border-border rounded-lg p-1">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              onClick={() => pick(value)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors ${
                active
                  ? 'bg-accent/90 text-white'
                  : 'text-muted-fg hover:text-fg hover:bg-surface-2'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataSection() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onImportFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const bundle = JSON.parse(await file.text());
      const result = await importDataBundle(bundle);
      setStatus(`Imported ${result.written} files (skipped ${result.skipped}). Reload to see changes.`);
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-fg font-medium">Data (sessions, memory, config, audit)</span>
      <div className="flex gap-2">
        <button
          onClick={() => downloadDataExport()}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-elevated border border-border text-fg hover:bg-surface-2 transition-colors"
        >
          <Download size={13} /> Export all
        </button>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-elevated border border-border text-fg hover:bg-surface-2 transition-colors disabled:opacity-50"
        >
          <Upload size={13} /> {busy ? 'Importing…' : 'Import'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <p className="text-[11px] text-muted-fg/70">
        Export bundles everything in <code>~/.dvalincode</code> into one file for moving to another machine. Import restores it.
      </p>
      {status && <p className="text-[11px] text-muted-fg">{status}</p>}
    </div>
  );
}

function SkillsSection() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoaded(true);
    setSkills(await fetchSkills());
  };

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded]);

  const onImportFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const skill = await importSkillBundle(bundle);
      setStatus(`Imported skill: ${skill.name}`);
      await load();
    } catch (err) {
      setStatus(`Skill import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await deleteSkill(name);
      setStatus(`Deleted skill: ${name}`);
      await load();
    } catch (err) {
      setStatus(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-fg font-medium">Skills</span>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-elevated border border-border text-muted-fg hover:text-fg hover:bg-surface-2 disabled:opacity-50"
        >
          <Upload size={11} /> Upload
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json,.dvalin-skill.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportFile(file);
          e.target.value = '';
        }}
      />
      <div className="max-h-40 overflow-y-auto flex flex-col gap-1">
        {skills.map((skill) => (
          <div key={skill.name} className="rounded-lg border border-border bg-elevated px-2.5 py-2">
            <div className="flex items-start gap-2">
              <BookOpen size={13} className="mt-0.5 text-accent flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-fg truncate">{skill.title || skill.name}</span>
                  {skill.builtIn && <span className="text-[9px] text-emerald-300 border border-emerald-500/20 bg-emerald-500/10 rounded px-1">built-in</span>}
                </div>
                <p className="text-[10px] text-muted-fg/75 line-clamp-2">{skill.description}</p>
                {skill.tools && skill.tools.length > 0 && (
                  <p className="text-[9px] text-muted-fg/50 truncate">tools: {skill.tools.join(', ')}</p>
                )}
              </div>
              <button
                onClick={() => downloadSkill(skill.name)}
                title="Download skill"
                className="p-1 rounded hover:bg-surface-2 text-muted-fg hover:text-fg"
              >
                <Download size={12} />
              </button>
              {!skill.builtIn && (
                <button
                  onClick={() => void remove(skill.name)}
                  title="Delete skill"
                  className="p-1 rounded hover:bg-red-500/10 text-muted-fg hover:text-red-300"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-fg/70">
        Skills are local instruction bundles stored under <code>~/.dvalincode/skills</code>. Built-in security skills expose agent tools for scan and remediation.
      </p>
      {status && <p className="text-[11px] text-muted-fg">{status}</p>}
    </div>
  );
}

export type ChatSettings = {
  cwd: string;
  provider: string;
  approvalMode: ApprovalMode;
};

type Props = {
  onOpenLLMConfig: () => void;
  activeProvider?: string;
  activeModel?: string;
  apiKeySet?: boolean;
  keySource?: ProviderKeySource;
  apiKeyEnv?: string;
};

type SettingsTab = 'general' | 'llm' | 'data';

function keySourceSummary(source?: ProviderKeySource, apiKeySet?: boolean, apiKeyEnv?: string): string {
  if (source === 'gateway') return 'Gateway managed';
  if (source === 'env') return apiKeyEnv ? `Env: ${apiKeyEnv}` : 'Environment variable';
  return apiKeySet ? 'Stored locally' : 'No key saved';
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-lg hover:bg-surface-2 text-muted-fg hover:text-fg transition-colors"
      title="Settings"
    >
      <Settings size={15} />
    </button>
  );
}

export function SettingsPanel({
  onOpenLLMConfig,
  activeProvider,
  activeModel,
  apiKeySet,
  keySource,
  apiKeyEnv,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');

  const openProviderConfig = () => {
    setOpen(false);
    onOpenLLMConfig();
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'llm', label: 'LLM Providers', icon: Server },
    { id: 'data', label: 'Data & Skills', icon: BookOpen },
  ];

  return (
    <>
      <button
        onClick={() => { setTab('general'); setOpen(true); }}
        className="p-1.5 rounded-lg hover:bg-surface-2 text-muted-fg hover:text-fg transition-colors"
        title="Settings"
      >
        <Settings size={15} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface border border-border rounded-xl w-[34rem] max-w-[calc(100vw-2rem)] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-fg">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-muted-fg hover:text-fg">
                <X size={16} />
              </button>
            </div>

            <div className="flex border-b border-border px-5 pt-3 gap-1">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                    tab === id ? 'text-fg border-b-2 border-accent -mb-px' : 'text-muted-fg hover:text-fg'
                  }`}
                >
                  <Icon size={12} />
                  {label}
                </button>
              ))}
            </div>

            <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
              {tab === 'general' && (
                <>
                  <ThemeSwitcher />

                  <p className="text-xs text-muted-fg/60 bg-elevated border border-border rounded px-2.5 py-2">
                    Approval mode is controlled by the switcher in the top bar.
                  </p>
                </>
              )}

              {tab === 'llm' && (
                <div className="flex flex-col gap-4">
                  <div className="rounded-lg border border-border bg-elevated px-3 py-3">
                    <div className="flex items-start gap-3">
                      <Server size={16} className="text-accent mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-fg">Active provider</div>
                        <div className="text-sm text-fg font-mono truncate mt-0.5">
                          {activeProvider || 'provider not set'} · {activeModel || 'model not set'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-fg mt-1">
                          <KeyRound size={11} />
                          <span className="truncate">{keySourceSummary(keySource, apiKeySet, apiKeyEnv)}</span>
                        </div>
                      </div>
                      <button
                        onClick={openProviderConfig}
                        className="px-3 py-1.5 text-xs rounded-lg bg-accent/90 hover:bg-accent text-white transition-colors"
                      >
                        Configure
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-elevated px-3 py-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                      <Terminal size={13} className="text-accent" />
                      CLI provider switching
                    </div>
                    <p className="text-xs text-muted-fg/75">
                      The CLI reads the same saved provider config as the web app.
                    </p>
                    <code className="text-[11px] bg-bg border border-border rounded px-2 py-1.5 text-muted-fg overflow-x-auto">
                      dvalincode provider set deepseek --env DEEPSEEK_API_KEY
                    </code>
                    <code className="text-[11px] bg-bg border border-border rounded px-2 py-1.5 text-muted-fg overflow-x-auto">
                      dvalincode provider set cc-switch --base-url http://localhost:3456/v1 --gateway
                    </code>
                  </div>
                </div>
              )}

              {tab === 'data' && (
                <>
                  <DataSection />
                  <SkillsSection />
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-muted-fg hover:text-fg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
