import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { RotateCcw } from 'lucide-react';
import { AgentActivity } from './AgentActivity.tsx';
import { PlanCard, extractPlanSteps } from './PlanCard.tsx';
import { ThemeLogo } from './ThemeLogo.tsx';
import type { ChatMessage } from '../types.ts';
import type { AgentMode } from '../types.ts';

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      <div className="w-1.5 h-1.5 rounded-full bg-muted-fg animate-dot-1" />
      <div className="w-1.5 h-1.5 rounded-full bg-muted-fg animate-dot-2" />
      <div className="w-1.5 h-1.5 rounded-full bg-muted-fg animate-dot-3" />
    </div>
  );
}

type Props = {
  message: ChatMessage;
  mode?: AgentMode;
  onProceed?: (text: string) => void;
};

export function MessageBubble({ message, mode, onProceed }: Props) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4 animate-fade-in">
        <div className="max-w-[75%] bg-surface-2 border border-border rounded-2xl rounded-tr-sm px-4 py-2.5 text-fg text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'recovered') {
    return (
      <div className="mb-4 ml-7 animate-fade-in">
        <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2.5 text-sm text-fg">
          <div className="text-yellow-300 font-medium">A previous message was interrupted.</div>
          <div className="mt-1 text-muted-fg">Its text was:</div>
          <blockquote className="mt-2 border-l-2 border-yellow-500/35 pl-3 text-fg whitespace-pre-wrap">
            {message.content}
          </blockquote>
          {onProceed && (
            <button
              type="button"
              onClick={() => onProceed(message.content)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-1.5 text-xs font-medium text-yellow-200 hover:bg-yellow-500/20"
              title="Re-send recovered message"
            >
              <RotateCcw size={12} />
              Re-send
            </button>
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'compact' || message.role === 'report') return null;

  // Assistant message
  const { content, toolCalls, pending, replayed, startedAt, completedAt } = message;
  const showDots = pending && toolCalls.length === 0 && !content;

  // Detect plan in Cowork mode: ≥3 numbered steps, no tool calls, message done
  const planSteps =
    !pending && mode === 'cowork' && toolCalls.length === 0 && content
      ? extractPlanSteps(content)
      : null;

  return (
    <div className="mb-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <ThemeLogo className="w-5 h-5 rounded-full flex-shrink-0" />
        <span className="text-xs text-muted-fg font-medium">DvalinCode</span>
        {pending && <span className="text-xs text-accent/60 animate-pulse">thinking…</span>}
        {replayed && !pending && (
          <span className="text-[10px] text-muted-fg/50 italic" title="Returned from session journal without re-running the model">
            replayed
          </span>
        )}
      </div>

      {/* Agent tool activity */}
      {(pending || toolCalls.length > 0 || startedAt) && (
        <div className="ml-7">
          <AgentActivity
            toolCalls={toolCalls}
            pending={pending}
            startedAt={startedAt}
            completedAt={completedAt}
          />
        </div>
      )}

      {/* Final response */}
      <div className="ml-7">
        {showDots ? (
          <ThinkingDots />
        ) : planSteps ? (
          /* Cowork Plan mode: show visual plan card */
          <PlanCard steps={planSteps} onProceed={onProceed} />
        ) : content ? (
          <div className="prose text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {content}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}
