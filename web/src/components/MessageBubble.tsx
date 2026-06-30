import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
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

  if (message.role === 'compact' || message.role === 'report') return null;

  // Assistant message
  const { content, toolCalls, pending } = message;
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
      </div>

      {/* Agent tool activity */}
      {toolCalls.length > 0 && (
        <div className="ml-7">
          <AgentActivity toolCalls={toolCalls} pending={pending} />
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
