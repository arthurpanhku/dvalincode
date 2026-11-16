import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { ACCESS_LOST_EVENT, hasAccess, unlock } from '../lib/client.ts';
import { ThemeLogo } from './ThemeLogo.tsx';

let firstCheck: Promise<boolean> | undefined;

/**
 * Trade the token from the launch URL (`/?token=…`) for the access cookie and
 * drop it from the address bar, then ask whether access is held. Memoized: a
 * StrictMode re-run must not race the exchange it started.
 */
function checkAccessOnce(): Promise<boolean> {
  firstCheck ??= (async () => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      if (await unlock(token).catch(() => false)) return true;
    }
    return hasAccess();
  })();
  return firstCheck;
}

/**
 * Keeps the app behind the server's access token. The desktop window and the
 * link `dvalincode serve` prints both carry the token, so this is invisible in
 * normal use; it shows only for a link without one, or after the server
 * restarted with a new token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'granted' | 'locked'>('checking');
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void checkAccessOnce().then((ok) => {
      if (!cancelled) setState(ok ? 'granted' : 'locked');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onLost = () => setLost(true);
    window.addEventListener(ACCESS_LOST_EVENT, onLost);
    return () => window.removeEventListener(ACCESS_LOST_EVENT, onLost);
  }, []);

  if (state === 'checking') return null;
  if (state === 'locked') return <UnlockScreen onUnlocked={() => setState('granted')} />;
  return (
    <>
      {children}
      {/* Reload on unlock: the app's socket and data predate the new token. */}
      {lost && <UnlockScreen restarted onUnlocked={() => window.location.reload()} />}
    </>
  );
}

function UnlockScreen({ restarted, onUnlocked }: { restarted?: boolean; onUnlocked: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Accept the whole launch link as well as the bare token.
    const token = value.trim().replace(/^.*[?&]token=/, '').replace(/[&#].*$/, '');
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      if (await unlock(token)) onUnlocked();
      else setError('That token does not match this server. Copy it again from the terminal.');
    } catch {
      setError('Could not reach the DvalinCode server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center justify-center px-6 ${
        restarted ? 'fixed inset-0 z-[60] bg-bg/90 backdrop-blur-sm' : 'h-full bg-bg'
      }`}
    >
      <form
        onSubmit={(event) => void submit(event)}
        aria-labelledby="unlock-title"
        className="w-full max-w-sm bg-surface border border-border rounded-xl shadow-2xl p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-3">
          <ThemeLogo className="w-9 h-9 rounded-lg flex-shrink-0" />
          <div>
            <h1 id="unlock-title" className="text-sm font-semibold text-fg">
              {restarted ? 'DvalinCode restarted' : 'Access token required'}
            </h1>
            <p className="text-xs text-muted-fg">
              {restarted ? 'The server now uses a new access token.' : 'This server only answers whoever started it.'}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-fg leading-relaxed">
          Open the link printed where you ran <code className="font-mono text-fg">dvalincode serve</code>, or paste
          the token — or the whole link — here.
        </p>
        <label className="flex flex-col gap-1.5 text-xs text-muted-fg">
          Access token
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            name="dvalincode-access-token"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg font-mono outline-none focus:border-accent/50"
          />
        </label>
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="flex items-center justify-center gap-2 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
          Unlock
        </button>
      </form>
    </div>
  );
}
