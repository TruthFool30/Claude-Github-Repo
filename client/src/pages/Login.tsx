import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Mail, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { Button, Field, Input } from '../ui';
import { AuthLayout } from './AuthLayout';
import { PasswordInput } from './PasswordInput';

export default function Login() {
  useDocumentTitle('Sign in');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const next = (location.state as { from?: string } | null)?.from;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const me = await login(email, password);
      navigate(me.families.length ? next || '/home' : '/onboarding', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

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
            autoFocus
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
