import { useEffect, useState } from 'react';
import {
  X, Eye, EyeOff, Check, Loader, AlertTriangle, ChevronRight,
  BookMarked, Trash2, Plus, ShieldCheck, ToggleLeft, ToggleRight,
  GripVertical, RefreshCw,
} from 'lucide-react';
import {
  fetchConfig, saveConfig, fetchProfiles, saveProfile, deleteProfile, applyProfile,
  fetchPool, savePool,
} from '../lib/client.ts';
import type { LLMConfig, ProviderPoolConfig, PoolEntry, RotationPolicy } from '../types.ts';
import type { Profile } from '../lib/client.ts';
import { PROVIDERS } from '../lib/providers.ts';
import type { ModelPreset } from '../lib/providers.ts';

// ── Provider colors & icons ───────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  deepseek:             'from-blue-600 to-cyan-500',
  openai:               'from-emerald-600 to-teal-500',
  google:               'from-blue-500 to-indigo-500',
  'anthropic-openrouter': 'from-orange-500 to-amber-400',
  xai:                  'from-slate-700 to-slate-500',
  mistral:              'from-orange-600 to-red-500',
  groq:                 'from-orange-500 to-amber-400',
  together:             'from-violet-600 to-purple-500',
  fireworks:            'from-rose-500 to-pink-500',
  perplexity:           'from-teal-600 to-cyan-500',
  openrouter:           'from-violet-600 to-purple-500',
  qwen:                 'from-indigo-600 to-blue-500',
  moonshot:             'from-sky-600 to-blue-500',
  zhipu:                'from-emerald-700 to-green-500',
  ollama:               'from-slate-600 to-slate-500',
  custom:               'from-zinc-600 to-zinc-500',
};

function ProviderIcon({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
  const gradient = PROVIDER_COLORS[id] ?? 'from-zinc-600 to-zinc-500';
  const cls = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-9 h-9 text-xs';
  const provider = PROVIDERS.find((p) => p.id === id);
  const initials = provider ? provider.name.slice(0, 2).toUpperCase() : id.slice(0, 2).toUpperCase();
  return (
    <div className={`${cls} rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center font-bold text-white flex-shrink-0`}>
      {initials}
    </div>
  );
}

// ── Model preset card ─────────────────────────────────────────────────────────

function ModelCard({ preset, selected, onClick }: { preset: ModelPreset; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative text-left rounded-xl border px-4 py-3 transition-all ${
        selected
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-border hover:border-[#333] bg-[#0f0f0f] text-muted-fg hover:text-fg'
      }`}
    >
      {selected && (
        <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-accent flex items-center justify-center">
          <Check size={10} className="text-white" />
        </span>
      )}
      <div className="text-sm font-medium leading-tight">{preset.label}</div>
      <div className="text-[11px] mt-0.5 opacity-70">{preset.description}</div>
      <div className="text-[10px] mt-1 font-mono opacity-50 truncate">{preset.model}</div>
    </button>
  );
}

// ── Pool entry row ────────────────────────────────────────────────────────────

function PoolEntryRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: PoolEntry;
  onChange: (updated: PoolEntry) => void;
  onRemove: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const provider = PROVIDERS.find(p => p.id === entry.provider);

  return (
    <div className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
      entry.enabled ? 'border-[#222] bg-[#0f0f0f]' : 'border-[#1a1a1a] bg-[#0a0a0a] opacity-50'
    }`}>
      <GripVertical size={14} className="text-muted-fg mt-1 flex-shrink-0 cursor-grab" />

      <div className="flex-1 flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2">
          <ProviderIcon id={entry.provider} size="sm" />
          <select
            value={entry.provider}
            onChange={e => {
              const p = PROVIDERS.find(pr => pr.id === e.target.value)!;
              onChange({ ...entry, provider: e.target.value, baseUrl: p.baseUrl, model: p.models[0]?.model ?? '', apiKey: '' });
            }}
            className="flex-1 bg-transparent text-xs text-fg outline-none cursor-pointer"
          >
            {PROVIDERS.filter(p => p.id !== 'custom').map(p => (
              <option key={p.id} value={p.id} className="bg-[#111]">{p.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted-fg ml-auto">
            <span>W:</span>
            <input
              type="number"
              min={1}
              max={10}
              value={entry.weight}
              onChange={e => onChange({ ...entry, weight: Math.max(1, parseInt(e.target.value) || 1) })}
              className="w-10 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-0.5 text-xs text-fg outline-none"
            />
          </label>
        </div>

        <div className="flex gap-2">
          <input
            value={entry.model}
            onChange={e => onChange({ ...entry, model: e.target.value })}
            placeholder={provider?.models[0]?.model ?? 'model-name'}
            className="flex-1 bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-muted-fg outline-none focus:border-accent/30 font-mono"
          />
        </div>

        <div className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-2.5 py-1.5 focus-within:border-accent/30 transition-colors">
          <input
            type={showKey ? 'text' : 'password'}
            value={entry.apiKey ?? ''}
            onChange={e => onChange({ ...entry, apiKey: e.target.value })}
            placeholder={provider?.keyPlaceholder ?? 'api-key'}
            className="flex-1 bg-transparent text-xs text-fg placeholder-muted-fg font-mono outline-none"
          />
          <button type="button" onClick={() => setShowKey(v => !v)} className="text-muted-fg hover:text-fg">
            {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 flex-shrink-0 pt-0.5">
        <button
          onClick={() => onChange({ ...entry, enabled: !entry.enabled })}
          className={`transition-colors ${entry.enabled ? 'text-accent' : 'text-muted-fg'}`}
          title={entry.enabled ? 'Disable' : 'Enable'}
        >
          {entry.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
        </button>
        <button onClick={onRemove} className="text-muted-fg hover:text-red-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

type Tab = 'single' | 'pool';
type Props = { onClose: () => void };

export function LLMConfigModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('single');

  // ── Single provider state ──
  const [draft, setDraft] = useState<LLMConfig>({ provider: 'deepseek', apiKey: '', baseUrl: '', model: '' });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // ── Profiles state ──
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [newProfileName, setNewProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // ── Pool state ──
  const [pool, setPool] = useState<ProviderPoolConfig>({ enabled: false, policy: 'round-robin', entries: [] });
  const [savingPool, setSavingPool] = useState(false);
  const [savedPool, setSavedPool] = useState(false);
  const [poolError, setPoolError] = useState('');

  const activeProvider = PROVIDERS.find((p) => p.id === draft.provider) ?? PROVIDERS[PROVIDERS.length - 1];

  useEffect(() => {
    Promise.all([fetchConfig(), fetchProfiles(), fetchPool()])
      .then(([cfg, profs, poolCfg]) => {
        const ap = PROVIDERS.find(p => p.id === cfg.llm.provider) ?? PROVIDERS[PROVIDERS.length - 1];
        setDraft({
          provider: cfg.llm.provider,
          apiKey: cfg.llm.apiKeySet ? '••••••••' : '',
          baseUrl: cfg.llm.baseUrl ?? ap.baseUrl,
          model: cfg.llm.model ?? ap.models[0]?.model ?? '',
        });
        setProfiles(profs);
        setPool(poolCfg);
        if (poolCfg.enabled) setTab('pool');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const selectProvider = (id: string) => {
    const p = PROVIDERS.find((pr) => pr.id === id)!;
    setDraft((d) => ({ ...d, provider: id, baseUrl: p.baseUrl, model: p.models[0]?.model ?? '' }));
  };

  const handleSaveProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    setSavingProfile(true);
    try {
      const profile: Profile = {
        provider: draft.provider,
        apiKey: draft.apiKey?.startsWith('••') ? undefined : draft.apiKey || undefined,
        baseUrl: draft.baseUrl || undefined,
        model: draft.model || undefined,
      };
      await saveProfile(name, profile);
      setProfiles((p) => ({ ...p, [name]: profile }));
      setNewProfileName('');
    } catch { /* ignore */ } finally { setSavingProfile(false); }
  };

  const handleApplyProfile = async (name: string) => {
    try {
      await applyProfile(name);
      const p = profiles[name];
      if (!p) return;
      setDraft({ provider: p.provider, apiKey: p.apiKey ?? '', baseUrl: p.baseUrl ?? '', model: p.model ?? '' });
    } catch { /* ignore */ }
  };

  const handleDeleteProfile = async (name: string) => {
    try {
      await deleteProfile(name);
      setProfiles((p) => { const n = { ...p }; delete n[name]; return n; });
    } catch { /* ignore */ }
  };

  const handleSave = async () => {
    if (!(draft.model ?? '').trim()) { setError('Model name is required'); return; }
    setSaving(true); setError('');
    try {
      await saveConfig({ llm: draft });
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 800);
    } catch {
      setError('Failed to save — is the server running?');
    } finally { setSaving(false); }
  };

  const addPoolEntry = () => {
    const first = PROVIDERS[0];
    const newEntry: PoolEntry = {
      id: `entry-${Date.now()}`,
      provider: first.id,
      baseUrl: first.baseUrl,
      model: first.models[0]?.model ?? '',
      apiKey: '',
      weight: 1,
      enabled: true,
    };
    setPool(p => ({ ...p, entries: [...p.entries, newEntry] }));
  };

  const handleSavePool = async () => {
    setSavingPool(true); setPoolError('');
    try {
      const saved = await savePool(pool);
      setPool(saved);
      setSavedPool(true);
      setTimeout(() => { setSavedPool(false); onClose(); }, 800);
    } catch {
      setPoolError('Failed to save pool config');
    } finally { setSavingPool(false); }
  };

  const enabledCount = pool.entries.filter(e => e.enabled).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#111] border border-[#222] rounded-2xl w-full max-w-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e1e1e]">
          <div>
            <h2 className="font-semibold text-fg">LLM Configuration</h2>
            <p className="text-xs text-muted-fg mt-0.5">Provider, model, and API key settings</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#1e1e1e] text-muted-fg hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#1e1e1e] px-6 pt-3 gap-1">
          {(['single', 'pool'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                tab === t ? 'text-fg border-b-2 border-accent -mb-px' : 'text-muted-fg hover:text-fg'
              }`}
            >
              {t === 'single' ? 'Single Provider' : (
                <span className="flex items-center gap-1.5">
                  <ShieldCheck size={11} />
                  Provider Pool
                  {pool.enabled && (
                    <span className="ml-1 px-1.5 py-0.5 rounded bg-accent/20 text-accent text-[10px]">
                      {enabledCount} active
                    </span>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader size={20} className="animate-spin text-muted-fg" />
            </div>
          ) : tab === 'single' ? (
            // ── Single provider tab ──────────────────────────────────────────
            <div className="px-6 py-5 flex flex-col gap-6">

              <section>
                <h3 className="text-xs font-semibold text-muted-fg uppercase tracking-wider mb-3">Provider</h3>
                <div className="grid grid-cols-4 gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => selectProvider(p.id)}
                      className={`flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-xl border transition-all ${
                        draft.provider === p.id
                          ? 'border-accent bg-accent/10 text-fg'
                          : 'border-border hover:border-[#333] text-muted-fg hover:text-fg bg-[#0f0f0f]'
                      }`}
                    >
                      <ProviderIcon id={p.id} size="sm" />
                      <span className="text-[11px] font-medium truncate w-full text-center">{p.name}</span>
                      {draft.provider === p.id && <Check size={10} className="text-accent" />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold text-muted-fg uppercase tracking-wider">Credentials</h3>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-fg">
                    API Key
                    {!activeProvider.needsKey && (
                      <span className="ml-2 text-emerald-500/80">(not required for {activeProvider.name})</span>
                    )}
                  </span>
                  <div className="flex items-center gap-2 bg-[#0a0a0a] border border-[#222] rounded-xl px-3 py-2.5 focus-within:border-accent/40 transition-colors">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={draft.apiKey ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                      placeholder={activeProvider.keyPlaceholder}
                      className="flex-1 bg-transparent outline-none text-sm text-fg placeholder-muted-fg font-mono"
                    />
                    <button type="button" onClick={() => setShowKey((v) => !v)} className="text-muted-fg hover:text-fg transition-colors flex-shrink-0">
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-fg">Base URL</span>
                  <input
                    value={draft.baseUrl ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                    placeholder={activeProvider.baseUrl || 'https://your-endpoint/v1'}
                    className="bg-[#0a0a0a] border border-[#222] rounded-xl px-3 py-2.5 text-sm text-fg placeholder-muted-fg outline-none focus:border-accent/40 transition-colors font-mono"
                  />
                </label>
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold text-muted-fg uppercase tracking-wider">Model</h3>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-fg">Model name</span>
                  <input
                    value={draft.model ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                    placeholder={activeProvider.models[0]?.model ?? 'model-name'}
                    className="bg-[#0a0a0a] border border-[#222] rounded-xl px-3 py-2.5 text-sm text-fg placeholder-muted-fg outline-none focus:border-accent/40 transition-colors font-mono"
                  />
                </label>
                {activeProvider.models.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {activeProvider.models.map((preset) => (
                      <ModelCard
                        key={preset.model}
                        preset={preset}
                        selected={draft.model === preset.model}
                        onClick={() => setDraft(d => ({ ...d, model: preset.model }))}
                      />
                    ))}
                  </div>
                )}
                {activeProvider.id === 'ollama' && (
                  <div className="flex items-start gap-2 text-xs text-muted-fg bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2.5">
                    <ChevronRight size={12} className="mt-0.5 flex-shrink-0" />
                    <span>Make sure Ollama is running locally:
                      <code className="ml-1 text-accent font-mono">ollama pull {draft.model ?? 'qwen2.5-coder'}</code>
                    </span>
                  </div>
                )}
              </section>

              <section className="flex flex-col gap-3 pt-2 border-t border-[#1e1e1e]">
                <h3 className="text-xs font-semibold text-muted-fg uppercase tracking-wider flex items-center gap-1.5">
                  <BookMarked size={11} /> Saved Profiles
                </h3>
                {Object.keys(profiles).length === 0 ? (
                  <p className="text-xs text-muted-fg/60 italic">No profiles saved yet.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {Object.entries(profiles).map(([name, p]) => (
                      <div key={name} className="flex items-center gap-2 bg-[#0f0f0f] border border-[#222] rounded-lg px-3 py-2">
                        <ProviderIcon id={p.provider} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-fg truncate">{name}</div>
                          <div className="text-[11px] text-muted-fg font-mono truncate">{p.provider} · {p.model ?? '—'}</div>
                        </div>
                        <button onClick={() => void handleApplyProfile(name)} className="text-[11px] px-2 py-1 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors">Apply</button>
                        <button onClick={() => void handleDeleteProfile(name)} className="p-1 text-muted-fg hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveProfile(); }}
                    placeholder="Profile name…"
                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded-lg px-3 py-1.5 text-xs text-fg placeholder-muted-fg outline-none focus:border-accent/40"
                  />
                  <button
                    onClick={() => void handleSaveProfile()}
                    disabled={!newProfileName.trim() || savingProfile}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-[#333] text-muted-fg hover:text-fg hover:border-accent/40 disabled:opacity-40 transition-colors"
                  >
                    {savingProfile ? <Loader size={11} className="animate-spin" /> : <Plus size={11} />}
                    Save
                  </button>
                </div>
              </section>
            </div>
          ) : (
            // ── Pool tab ─────────────────────────────────────────────────────
            <div className="px-6 py-5 flex flex-col gap-5">

              {/* Explainer */}
              <div className="flex items-start gap-3 bg-accent/5 border border-accent/20 rounded-xl px-4 py-3 text-xs text-muted-fg">
                <ShieldCheck size={14} className="text-accent mt-0.5 flex-shrink-0" />
                <span>
                  Pool mode rotates each conversation turn across multiple providers so no single vendor sees your full conversation history.
                  Each turn sends only the current history to the selected provider.
                </span>
              </div>

              {/* Enable toggle + policy */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPool(p => ({ ...p, enabled: !p.enabled }))}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all ${
                    pool.enabled
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-border text-muted-fg hover:text-fg'
                  }`}
                >
                  {pool.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                  {pool.enabled ? 'Pool enabled' : 'Pool disabled'}
                </button>

                <select
                  value={pool.policy}
                  onChange={e => setPool(p => ({ ...p, policy: e.target.value as RotationPolicy }))}
                  className="flex-1 bg-[#0a0a0a] border border-[#222] rounded-xl px-3 py-2 text-xs text-fg outline-none"
                >
                  <option value="round-robin">Round-robin (sequential)</option>
                  <option value="random">Random</option>
                  <option value="weighted-random">Weighted random</option>
                </select>
              </div>

              {/* Entries */}
              <div className="flex flex-col gap-2">
                {pool.entries.length === 0 ? (
                  <p className="text-xs text-muted-fg/60 italic text-center py-4">No providers added yet. Click + Add Provider below.</p>
                ) : (
                  pool.entries.map((entry, i) => (
                    <PoolEntryRow
                      key={entry.id}
                      entry={entry}
                      onChange={updated => setPool(p => ({ ...p, entries: p.entries.map((e, j) => j === i ? updated : e) }))}
                      onRemove={() => setPool(p => ({ ...p, entries: p.entries.filter((_, j) => j !== i) }))}
                    />
                  ))
                )}
                <button
                  onClick={addPoolEntry}
                  className="flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-[#333] text-xs text-muted-fg hover:text-fg hover:border-accent/40 transition-colors"
                >
                  <Plus size={12} /> Add Provider
                </button>
              </div>

              {pool.policy === 'weighted-random' && pool.entries.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-muted-fg bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2.5">
                  <RefreshCw size={11} className="mt-0.5 flex-shrink-0" />
                  <span>Weight controls selection probability. W:2 means 2× more likely to be picked than W:1.</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#1e1e1e] flex items-center gap-3">
          {tab === 'single' ? (
            <>
              {error ? (
                <div className="flex items-center gap-1.5 text-xs text-red-400 flex-1"><AlertTriangle size={12} />{error}</div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-fg flex-1">
                  <ProviderIcon id={draft.provider} size="sm" />
                  <span className="font-mono truncate">{draft.model || '—'}</span>
                </div>
              )}
              <button onClick={onClose} className="px-4 py-2 text-sm text-muted-fg hover:text-fg transition-colors">Cancel</button>
              <button
                onClick={() => void handleSave()}
                disabled={saving || saved}
                className="px-5 py-2 text-sm bg-accent/90 hover:bg-accent disabled:opacity-60 text-white rounded-xl transition-all flex items-center gap-2 min-w-[80px] justify-center"
              >
                {saving ? <Loader size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
                {saved ? 'Saved!' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {poolError ? (
                <div className="flex items-center gap-1.5 text-xs text-red-400 flex-1"><AlertTriangle size={12} />{poolError}</div>
              ) : (
                <div className="text-xs text-muted-fg flex-1">
                  {enabledCount} provider{enabledCount !== 1 ? 's' : ''} active · {pool.policy}
                </div>
              )}
              <button onClick={onClose} className="px-4 py-2 text-sm text-muted-fg hover:text-fg transition-colors">Cancel</button>
              <button
                onClick={() => void handleSavePool()}
                disabled={savingPool || savedPool}
                className="px-5 py-2 text-sm bg-accent/90 hover:bg-accent disabled:opacity-60 text-white rounded-xl transition-all flex items-center gap-2 min-w-[80px] justify-center"
              >
                {savingPool ? <Loader size={13} className="animate-spin" /> : savedPool ? <Check size={13} /> : null}
                {savedPool ? 'Saved!' : 'Save Pool'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
