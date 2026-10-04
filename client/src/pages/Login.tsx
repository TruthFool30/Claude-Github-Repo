import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, KeyRound, Mail, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import type { MeResponse } from '../lib/types';
import { Button, Field, Input } from '../ui';
import { AuthLayout } from './AuthLayout';
import { PasswordInput } from './PasswordInput';
import { CodeInput } from './TwoFactor';

export default function Login() {
  useDocumentTitle('Sign in');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Set after a correct password on a two-factor account: show the code step. */
  const [ticket, setTicket] = useState<string | null>(null);
  const next = (location.state as { from?: string } | null)?.from;

  const finish = (me: MeResponse) => {
    if (next?.startsWith('/join/')) navigate(next, { replace: true });
    else navigate(me.families.length ? next || '/home' : '/onboarding', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email, password);
      if ('two_factor_required' in res) {
        setPassword('');
        setTicket(res.ticket);
        setLoading(false);
      } else finish(res);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  if (ticket) {
    return (
      <CodeStep
        ticket={ticket}
        onDone={finish}
        onBack={(message) => {
          setTicket(null);
          setError(message ?? null);
        }}
      />
    );
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to see what's happening at home.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email">
          <Input
            icon={Mail}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus={!email}
          />
        </Field>
        <Field label="Password" error={error}>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={!!email}
          />
        </Field>
        <Button type="submit" size="lg" block loading={loading} className="mt-2">
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        New to Hearth?{' '}
        <Link to="/register" className="font-semibold text-primary hover:underline">
          Create an account
        </Link>
      </p>

      <button
        type="button"
        onClick={() => {
          setEmail('alex@hearth.test');
          setPassword('hearth123');
          setError(null);
        }}
        className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-strong p-3.5 text-left transition hover:border-primary/60 hover:bg-primary-soft/40"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <Sparkles size={17} />
        </span>
        <span className="min-w-0 text-[13px] leading-snug text-muted">
          <span className="block font-semibold text-fg">Exploring the demo?</span>
          Use <span className="font-medium text-fg">alex@hearth.test</span> / <span className="font-medium text-fg">hearth123</span>
        </span>
      </button>
    </AuthLayout>
  );
}

/** Second sign-in step for two-factor accounts: authenticator code (auto-submits at 6 digits) or a recovery code. */
function CodeStep({ ticket, onDone, onBack }: { ticket: string; onDone: (me: MeResponse) => void; onBack: (message?: string) => void }) {
  useDocumentTitle('Two-factor login');
  const { loginWithCode } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Auto-submit at 6 digits and Enter / a password manager can fire in the same tick: send one request.
  const inFlight = useRef(false);

  const verify = async (value: string) => {
    if (inFlight.current || !value.trim()) return;
    inFlight.current = true;
    setError(null);
    setLoading(true);
    try {
      onDone(await loginWithCode(ticket, value.trim()));
    } catch (err) {
      // Ticket timed out or too many wrong codes: start over from the password.
      inFlight.current = false;
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_EXPIRED') return onBack(err.message);
      setError(errorMessage(err));
      setCode('');
      setLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <AuthLayout
      title="Two-factor login"
      subtitle={
        recovery
          ? 'Enter one of the recovery codes you saved when you turned on two-factor login.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        {recovery ? (
          <Field label="Recovery code" error={error}>
            <Input
              key="recovery"
              ref={inputRef}
              icon={KeyRound}
              name="recovery-code"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="abcd-efgh-jkmn"
              maxLength={40}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </Field>
        ) : (
          <Field label="Authentication code" error={error}>
            <CodeInput key="totp" ref={inputRef} name="code" value={code} onChange={setCode} onComplete={(c) => void verify(c)} autoFocus />
          </Field>
        )}
        <Button type="submit" size="lg" block loading={loading} disabled={recovery ? !code.trim() : code.length !== 6} className="mt-2">
          Verify
        </Button>
      </form>

      <div className="mt-6 flex flex-col items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => {
            setRecovery((r) => !r);
            setCode('');
            setError(null);
          }}
          className="rounded-lg px-2 py-1 font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          {recovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
        </button>
        <button
          type="button"
          onClick={() => onBack()}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          <ArrowLeft size={15} aria-hidden /> Back to sign in
        </button>
      </div>
    </AuthLayout>
  );
}
