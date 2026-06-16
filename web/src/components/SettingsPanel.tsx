import { useRef, useState } from 'react';
import { X, Settings, Monitor, Sun, Moon, Download, Upload } from 'lucide-react';
import type { ApprovalMode } from '../types.ts';
import { getStoredTheme, setTheme, type Theme } from '../lib/theme.ts';
import { downloadDataExport, importDataBundle } from '../lib/client.ts';

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

export type ChatSettings = {
  cwd: string;
  provider: string;
  approvalMode: ApprovalMode;
};

type Props = {
  settings: ChatSettings;
  onChange: (s: ChatSettings) => void;
};

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

export function SettingsPanel({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);

  const save = () => {
    onChange(draft);
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => { setDraft(settings); setOpen(true); }}
        className="p-1.5 rounded-lg hover:bg-surface-2 text-muted-fg hover:text-fg transition-colors"
        title="Settings"
      >
        <Settings size={15} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface border border-border rounded-xl w-96 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-fg">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-muted-fg hover:text-fg">
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 flex flex-col gap-4">
              <ThemeSwitcher />

              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-fg font-medium">Working directory (cwd)</span>
                <input
                  value={draft.cwd}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-fg outline-none focus:border-accent/40 font-mono"
                  placeholder="/path/to/project"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-fg font-medium">Provider</span>
                <input
                  value={draft.provider}
                  onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
                  className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-fg outline-none focus:border-accent/40"
                  placeholder="deepseek"
                />
              </label>

              <p className="text-xs text-muted-fg/60 bg-elevated border border-border rounded px-2.5 py-2">
                Approval mode is controlled by the switcher in the top bar.
              </p>

              <DataSection />
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-muted-fg hover:text-fg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="px-4 py-2 text-sm bg-accent/90 hover:bg-accent text-white rounded-lg transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
