import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Mail, User as UserIcon } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { firstName } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { Button, Field, Input } from '../ui';
import { AuthLayout } from './AuthLayout';
import { FamilySetup } from './FamilySetup';
import { PasswordInput } from './PasswordInput';

export default function Register() {
  useDocumentTitle('Create account');
  const { register, user } = useAuth();
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const [step, setStep] = useState<1 | 2>(user ? 2 : 1);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<Partial<Record<'name' | 'email' | 'password' | 'form', string>>>({});
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!form.name.trim()) errs.name = 'Please enter your name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Please enter a valid email';
    if (form.password.length < 6) errs.password = 'Use at least 6 characters';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      await register(form);
      setStep(2);
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  if (step === 2) {
    const name = firstName(user?.name ?? form.name);
    return (
      <AuthLayout title={`Nice to meet you${name ? `, ${name}` : ''}!`} subtitle="Now start your family space, or join one that already exists.">
        <Steps step={2} />
        <FamilySetup initialCode={code} defaultName={user?.name || form.name ? `The ${(user?.name ?? form.name).trim().split(/\s+/).slice(-1)[0]}s` : ''} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="It takes less than a minute.">
      <Steps step={1} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Your name" error={errors.name}>
          <Input icon={UserIcon} autoComplete="name" placeholder="Alex Rivera" value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input icon={Mail} type="email" autoComplete="email" placeholder="you@example.com" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" error={errors.password ?? errors.form} hint={!errors.password && !errors.form ? 'At least 6 characters' : undefined}>
          <PasswordInput autoComplete="new-password" placeholder="Choose a password" value={form.password} onChange={set('password')} />
        </Field>
        <Button type="submit" size="lg" block loading={loading} className="mt-2">
          Continue
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" state={code ? { from: `/join/${code}` } : undefined} className="font-semibold text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

function Steps({ step }: { step: 1 | 2 }) {
  return (
    <div className="mb-6 flex items-center gap-2" aria-label={`Step ${step} of 2`}>
      {[1, 2].map((s) => (
        <span key={s} className={`h-1.5 flex-1 rounded-full transition-colors ${s <= step ? 'bg-primary' : 'bg-surface-3'}`} />
      ))}
    </div>
  );
}
