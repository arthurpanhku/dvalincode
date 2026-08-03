import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble.tsx';
import { RunReportCard } from './RunReportCard.tsx';
import { ThemeLogo } from './ThemeLogo.tsx';
import type { ChatMessage, AgentMode } from '../types.ts';

type Props = {
  messages: ChatMessage[];
  connected: boolean;
  mode?: AgentMode;
  onProceed?: (text: string) => void;
};

export function ChatThread({ messages, connected, mode, onProceed }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the thread pinned to the latest message — but scroll only this pane
  // (not the whole document, as scrollIntoView would), and only when the user
  // is already near the bottom, so sending from elsewhere (e.g. the sidebar's
  // "Fix finding") or reading older history doesn't yank the viewport.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
        <ThemeLogo className="w-16 h-16 rounded-xl" />
        <div className="text-center">
          <h2 className="text-lg font-semibold text-fg mb-1">DvalinCode</h2>
          <p className="text-sm text-muted-fg max-w-sm">
            An agentic coding assistant. Ask me to read files, write code, run commands, or explain anything in your project.
          </p>
        </div>
        {!connected && (
          <div className="text-xs text-warn-fg/80 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
            Connecting to server…
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-2xl mx-auto">
        {messages.map((msg, i) => {
          if (msg.role === 'compact') {
            const pct = msg.tokensBefore > 0
              ? Math.round((1 - msg.tokensAfter / msg.tokensBefore) * 100)
              : 0;
            return (
              <div key={i} className="flex items-center gap-3 my-5 text-xs text-muted-fg select-none">
                <div className="flex-1 border-t border-border" />
                <span>context compacted · {msg.tokensBefore.toLocaleString()} → {msg.tokensAfter.toLocaleString()} tokens (−{pct}%)</span>
                <div className="flex-1 border-t border-border" />
              </div>
            );
          }
          if (msg.role === 'report') {
            return <RunReportCard key={i} runId={msg.runId} markdown={msg.markdown} />;
          }
          return (
            <MessageBubble
              key={i}
              message={msg}
              mode={mode}
              onProceed={onProceed}
            />
          );
        })}
      </div>
    </div>
  );
}
