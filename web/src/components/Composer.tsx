import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, File, Terminal, ChevronDown, Check, ShieldQuestion, ClipboardList, Bot, ShieldOff, Plus, Settings2 } from 'lucide-react';
import { fetchFiles } from '../lib/client.ts';
import { WorkspaceControls } from './WorkspaceControls.tsx';
import type { CodePermissionMode } from '../types.ts';
import type { ModelPreset } from '../lib/providers.ts';

type Intensity = 'low' | 'normal' | 'high';

type Props = {
  onSend: (text: string) => void;
  onClear?: () => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  sending?: boolean;
  placeholder?: string;
  cwd?: string;
  activeModel?: string;
  modelOptions?: ModelPreset[];
  onModelChange?: (model: string) => void;
  onOpenConfig?: () => void;
  codePermissionMode?: CodePermissionMode;
  onCodePermissionModeChange?: (mode: CodePermissionMode) => void;
  onCwdChange?: (cwd: string) => void;
};

/* ── Slash commands ─────────────────────────────────────────────── */

type SlashCommand = {
  name: string;
  description: string;
  icon: React.ReactNode;
  /** If provided, insert this text; if null, handle via onClear/etc. */
  insertText: string | null;
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/clear',
    description: 'Clear the current conversation',
    icon: <Terminal size={11} />,
    insertText: null,
  },
  {
    name: '/compact',
    description: 'Compress conversation context to save tokens',
    icon: <Terminal size={11} />,
    insertText: '/compact',
  },
  {
    name: '/git',
    description: 'Show current git branch, commits, and changed files',
    icon: <Terminal size={11} />,
    insertText: '/git',
  },
  {
    name: '/plan',
    description: 'Ask the agent to plan the task before executing',
    icon: <Terminal size={11} />,
    insertText: '/plan',
  },
  {
    name: '/help',
    description: 'Show available slash commands',
    icon: <Terminal size={11} />,
    insertText: '/help',
  },
];

const INTENSITY_OPTIONS: { value: Intensity; label: string; color: string; description: string }[] = [
  { value: 'low',    label: 'Low',    color: 'text-blue-400',   description: 'Fast · economical' },
  { value: 'normal', label: 'Normal', color: 'text-muted-fg',   description: 'Balanced performance' },
  { value: 'high',   label: 'High',   color: 'text-orange-400', description: 'Extended reasoning' },
];

const CODE_MODES: { id: CodePermissionMode; label: string; icon: React.ReactNode; chipClass: string; description: string }[] = [
  {
    id: 'ask',
    label: 'Ask Permissions',
    icon: <ShieldQuestion size={11} />,
    chipClass: 'text-muted-fg border-border bg-[#1a1a1a]',
    description: 'Approve each write and command',
  },
  {
    id: 'plan',
    label: 'Plan Mode',
    icon: <ClipboardList size={11} />,
    chipClass: 'text-blue-300 border-blue-500/25 bg-blue-500/10',
    description: 'Read-only — plan before executing',
  },
  {
    id: 'auto',
    label: 'Auto Mode',
    icon: <Bot size={11} />,
    chipClass: 'text-orange-300 border-orange-500/25 bg-orange-500/10',
    description: 'Run operations automatically',
  },
  {
    id: 'bypass',
    label: 'Bypass permissions',
    icon: <ShieldOff size={11} />,
    chipClass: 'text-amber-300 border-amber-500/25 bg-amber-500/10',
    description: 'No confirmation at all',
  },
];

const MAX_MENTION_RESULTS = 8;

export function Composer({ onSend, onClear, onInterrupt, disabled, sending, placeholder, cwd, activeModel, modelOptions, onModelChange, onOpenConfig, codePermissionMode, onCodePermissionModeChange, onCwdChange }: Props) {
  const [text, setText] = useState('');
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [intensity, setIntensity] = useState<Intensity>('normal');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);

  // @mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelMenu]);

  // Close mode menu on outside click
  useEffect(() => {
    if (!showModeMenu) return;
    const handler = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModeMenu]);

  // Close plus menu on outside click
  useEffect(() => {
    if (!showPlusMenu) return;
    const handler = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlusMenu]);

  const loadFiles = useCallback(async (): Promise<string[]> => {
    if (!cwd) return [];
    if (allFiles.length > 0) return allFiles;
    try {
      const files = await fetchFiles(cwd);
      setAllFiles(files);
      return files;
    } catch { return []; }
  }, [cwd, allFiles]);

  const detectMention = (value: string, cursorPos: number): string | null => {
    const match = value.slice(0, cursorPos).match(/@([\w./\-]*)$/);
    return match ? match[1] : null;
  };

  const detectSlash = (value: string, cursorPos: number): string | null => {
    const before = value.slice(0, cursorPos);
    const match = before.match(/(?:^|\n)(\/[\w]*)$/);
    return match ? match[1] : null;
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    const cursor = e.target.selectionStart ?? val.length;

    const mq = detectMention(val, cursor);
    if (mq !== null) {
      setMentionQuery(mq);
      const filtered = allFiles
        .filter((f) => f.toLowerCase().includes(mq.toLowerCase()))
        .slice(0, MAX_MENTION_RESULTS);
      setMentionFiles(filtered);
      setMentionIndex(0);
      setSlashQuery(null);
      if (allFiles.length === 0) void loadFiles();
      return;
    }
    setMentionQuery(null);

    const sq = detectSlash(val, cursor);
    if (sq !== null) {
      setSlashQuery(sq);
      const q = sq.slice(1).toLowerCase();
      setSlashMatches(SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(q)));
      setSlashIndex(0);
      return;
    }
    setSlashQuery(null);
  };

  const insertMention = (file: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);
    const match = before.match(/@([\w./\-]*)$/);
    if (!match) return;
    const newBefore = before.slice(0, before.length - match[0].length) + `@${file}`;
    setText(newBefore + after);
    setMentionQuery(null);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(newBefore.length, newBefore.length);
    }, 0);
  };

  const applySlashCommand = (cmd: SlashCommand) => {
    setSlashQuery(null);
    setSlashMatches([]);
    if (cmd.name === '/clear') {
      setText('');
      onClear?.();
      return;
    }
    if (cmd.insertText !== null) {
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = ta.selectionStart ?? text.length;
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      const match = before.match(/(?:^|\n)(\/[\w]*)$/);
      if (!match) return;
      const newBefore = before.slice(0, before.length - match[1].length) + cmd.insertText + ' ';
      setText(newBefore + after);
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(newBefore.length, newBefore.length);
      }, 0);
    }
  };

  /* ── "+" menu actions ─────────────────────────────────────────── */

  const startFileMention = async () => {
    setShowPlusMenu(false);
    const files = await loadFiles();
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? text.length;
    const newBefore = text.slice(0, cursor) + '@';
    setText(newBefore + text.slice(cursor));
    setMentionQuery('');
    setMentionFiles(files.slice(0, MAX_MENTION_RESULTS));
    setMentionIndex(0);
    setTimeout(() => {
      ta?.focus();
      ta?.setSelectionRange(newBefore.length, newBefore.length);
    }, 0);
  };

  const startSlashCommand = () => {
    setShowPlusMenu(false);
    // '/' is only recognized at the start of a line
    const newText = text.length === 0 || text.endsWith('\n') ? `${text}/` : `${text}\n/`;
    setText(newText);
    setSlashQuery('/');
    setSlashMatches(SLASH_COMMANDS);
    setSlashIndex(0);
    setTimeout(() => {
      const ta = textareaRef.current;
      ta?.focus();
      ta?.setSelectionRange(newText.length, newText.length);
    }, 0);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || sending) return;
    onSend(trimmed);
    setText('');
    setMentionQuery(null);
    setSlashQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionFiles.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && mentionFiles[mentionIndex]) { e.preventDefault(); insertMention(mentionFiles[mentionIndex]); return; }
      if (e.key === 'Escape') { setMentionQuery(null); return; }
    }

    if (slashQuery !== null && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && slashMatches[slashIndex]) { e.preventDefault(); applySlashCommand(slashMatches[slashIndex]); return; }
      if (e.key === 'Escape') { setSlashQuery(null); return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const showMentionDropdown = mentionQuery !== null && mentionFiles.length > 0;
  const showSlashDropdown   = slashQuery !== null && slashMatches.length > 0;

  const modelShort = activeModel ? (activeModel.split('/').pop() ?? activeModel) : '—';
  const activeModelLabel = modelOptions?.find(o => o.model === activeModel)?.label ?? modelShort;
  const activeIntensity = INTENSITY_OPTIONS.find(o => o.value === intensity)!;
  const activeMode = CODE_MODES.find(m => m.id === codePermissionMode);

  return (
    <div className="border-t border-border bg-surface px-4 py-3">
      <div className="relative">
        {/* @mention dropdown */}
        {showMentionDropdown && (
          <div className="absolute bottom-full mb-1 left-0 w-full max-w-sm bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50">
            <div className="px-3 py-1.5 border-b border-border flex items-center gap-1.5 text-[11px] text-muted-fg">
              <File size={10} />
              <span>Files matching <span className="text-accent font-mono">@{mentionQuery}</span></span>
            </div>
            {mentionFiles.map((file, i) => (
              <button
                key={file}
                onMouseDown={(e) => { e.preventDefault(); insertMention(file); }}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors flex items-center gap-2 ${
                  i === mentionIndex ? 'bg-accent/10 text-fg' : 'text-muted-fg hover:bg-[#1a1a1a] hover:text-fg'
                }`}
              >
                <File size={10} className="flex-shrink-0 opacity-60" />
                {file}
              </button>
            ))}
            <div className="px-3 py-1 border-t border-border text-[10px] text-muted-fg/50">↑↓ navigate · Tab/Enter select · Esc dismiss</div>
          </div>
        )}

        {/* Slash command dropdown */}
        {showSlashDropdown && (
          <div className="absolute bottom-full mb-1 left-0 w-72 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50">
            <div className="px-3 py-1.5 border-b border-border text-[11px] text-muted-fg flex items-center gap-1.5">
              <Terminal size={10} />
              Commands
            </div>
            {slashMatches.map((cmd, i) => (
              <button
                key={cmd.name}
                onMouseDown={(e) => { e.preventDefault(); applySlashCommand(cmd); }}
                className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2.5 ${
                  i === slashIndex ? 'bg-accent/10 text-fg' : 'text-muted-fg hover:bg-[#1a1a1a] hover:text-fg'
                }`}
              >
                <span className="mt-0.5 opacity-60">{cmd.icon}</span>
                <div>
                  <div className="font-mono font-medium">{cmd.name}</div>
                  <div className="text-[11px] opacity-70 mt-0.5">{cmd.description}</div>
                </div>
              </button>
            ))}
            <div className="px-3 py-1 border-t border-border text-[10px] text-muted-fg/50">↑↓ navigate · Tab/Enter select · Esc dismiss</div>
          </div>
        )}

        {/* Input box */}
        <div className="bg-[#0f0f0f] border border-border rounded-xl focus-within:border-accent/40 transition-colors">
          {/* Textarea + send button */}
          <div className="flex items-end gap-3 px-4 pt-3 pb-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder ?? 'Ask DvalinCode… ( / for commands · @ for files )'}
              disabled={disabled}
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none text-fg placeholder-muted-fg text-sm leading-relaxed min-h-[24px] disabled:opacity-50"
            />
            {sending ? (
              <button
                onClick={onInterrupt}
                title="Stop generation"
                className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-500/80 hover:bg-red-500 flex items-center justify-center transition-colors"
              >
                <Square size={12} className="text-white fill-white" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim() || disabled}
                className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/90 hover:bg-accent disabled:bg-muted/30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              >
                <Send size={13} className="text-white" />
              </button>
            )}
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-2 pt-1 border-t border-border/40">
            {/* Left: Mode + Model pickers */}
            <div className="flex items-center gap-2 min-w-0">
              {activeMode && onCodePermissionModeChange && (
                <div ref={modeRef} className="relative flex-shrink-0">
                  <button
                    onClick={() => setShowModeMenu(v => !v)}
                    title="Change permission mode"
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium transition-colors ${activeMode.chipClass}`}
                  >
                    {activeMode.icon}
                    <span className="truncate max-w-[140px]">{activeMode.label}</span>
                    <ChevronDown size={10} className="opacity-50 flex-shrink-0" />
                  </button>

                  {showModeMenu && (
                    <div className="absolute bottom-full left-0 mb-1 w-56 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50">
                      <div className="px-3 py-1.5 border-b border-border text-[11px] text-muted-fg">Mode</div>
                      {CODE_MODES.map(m => (
                        <button
                          key={m.id}
                          onMouseDown={(e) => { e.preventDefault(); onCodePermissionModeChange(m.id); setShowModeMenu(false); }}
                          className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2 ${
                            codePermissionMode === m.id ? 'bg-accent/10' : 'hover:bg-[#1a1a1a]'
                          }`}
                        >
                          <span className="mt-0.5 opacity-70">{m.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-fg">{m.label}</div>
                            <div className="text-[10px] text-muted-fg/60 mt-0.5">{m.description}</div>
                          </div>
                          {codePermissionMode === m.id && <Check size={10} className="text-accent mt-0.5 flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* "+" menu — attach files / commands */}
              <div ref={plusRef} className="relative flex-shrink-0">
                <button
                  onClick={() => setShowPlusMenu(v => !v)}
                  title="Add files and commands"
                  className="w-6 h-6 rounded-md border border-border flex items-center justify-center text-muted-fg hover:text-fg hover:bg-[#1a1a1a] transition-colors"
                >
                  <Plus size={12} />
                </button>

                {showPlusMenu && (
                  <div className="absolute bottom-full left-0 mb-1 w-52 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50">
                    <button
                      onMouseDown={(e) => { e.preventDefault(); void startFileMention(); }}
                      className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5 text-fg hover:bg-[#1a1a1a]"
                    >
                      <File size={11} className="opacity-60" />
                      <span className="flex-1">Add files</span>
                      <kbd className="text-[10px] text-muted-fg/50 font-mono">@</kbd>
                    </button>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); startSlashCommand(); }}
                      className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5 text-fg hover:bg-[#1a1a1a]"
                    >
                      <Terminal size={11} className="opacity-60" />
                      <span className="flex-1">Slash commands</span>
                      <kbd className="text-[10px] text-muted-fg/50 font-mono">/</kbd>
                    </button>
                  </div>
                )}
              </div>

              {onCwdChange && (
                <WorkspaceControls cwd={cwd} onCwdChange={onCwdChange} />
              )}
            </div>

            {/* Right: Model & intensity */}
            <div ref={modelMenuRef} className="relative">
              <button
                onClick={() => setShowModelMenu(v => !v)}
                className="flex items-center gap-1.5 text-[11px] text-muted-fg hover:text-fg transition-colors"
                title="Models & intensity"
              >
                <span className="truncate max-w-[140px]">{activeModelLabel}</span>
                <span className={activeIntensity.color}>{activeIntensity.label}</span>
                <ChevronDown size={10} className="opacity-40" />
              </button>

              {showModelMenu && (
                <div className="absolute bottom-full right-0 mb-1 w-60 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50">
                  <div className="px-3 py-1.5 border-b border-border text-[11px] text-muted-fg">Models</div>
                  {modelOptions && modelOptions.length > 0 ? (
                    modelOptions.map(opt => (
                      <button
                        key={opt.model}
                        onMouseDown={(e) => { e.preventDefault(); onModelChange?.(opt.model); setShowModelMenu(false); }}
                        className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2 ${
                          activeModel === opt.model ? 'bg-accent/10' : 'hover:bg-[#1a1a1a]'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-fg">{opt.label}</div>
                          <div className="text-[10px] text-muted-fg/60 mt-0.5">{opt.description}</div>
                        </div>
                        {activeModel === opt.model && <Check size={10} className="text-accent mt-0.5 flex-shrink-0" />}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-xs text-muted-fg font-mono truncate">{modelShort}</div>
                  )}

                  <div className="px-3 py-1.5 border-t border-border text-[11px] text-muted-fg">Intensity</div>
                  <div className="flex gap-1 px-2 pb-2">
                    {INTENSITY_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onMouseDown={(e) => { e.preventDefault(); setIntensity(opt.value); }}
                        className={`flex-1 py-1 text-[11px] rounded-md font-medium transition-colors ${
                          intensity === opt.value
                            ? `${opt.color} bg-[#1a1a1a] border border-border`
                            : 'text-muted-fg hover:text-fg'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {onOpenConfig && (
                    <button
                      onMouseDown={(e) => { e.preventDefault(); onOpenConfig(); setShowModelMenu(false); }}
                      className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 text-muted-fg hover:text-fg hover:bg-[#1a1a1a] border-t border-border"
                    >
                      <Settings2 size={11} className="opacity-60" />
                      LLM Configuration…
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-fg mt-2 text-center">
        Enter to send · Shift+Enter for newline · <span className="font-mono">/</span> commands · <span className="font-mono">@</span> files
      </p>
    </div>
  );
}
