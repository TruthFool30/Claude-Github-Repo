import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { KeyRound, LogOut, Monitor, Moon, Palette, Settings as SettingsIcon, Sun, UserRound, Check } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { useTheme, type ThemeMode } from '../lib/theme';
import type { MeResponse } from '../lib/types';
import { Avatar, Button, Card, CardHeader, ColorPicker, Field, ImageUploader, Input, PageHeader, fileForm, toast } from '../ui';
import { PasswordInput } from './PasswordInput';
import { TwoFactorCard } from './TwoFactor';

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div>
      <PageHeader title="Settings" subtitle="Your profile, appearance and account" icon={SettingsIcon} accent="#737889" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ProfileCard />
        <div className="flex flex-col gap-6">
          <AppearanceCard />
          <PasswordCard />
          <TwoFactorCard />
          <Card>
            <CardHeader title="Account" subtitle={user.email ?? undefined} icon={LogOut} accent="#E5484D" />
            <Button
              variant="secondary"
              block
              icon={LogOut}
              className="text-danger"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Sign out
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ProfileCard() {
  const { user, setMe } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', phone: '', birthday: '', color: '#5B5BD6' });
  const [emailPassword, setEmailPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) setForm({ name: user.name, email: user.email ?? '', phone: user.phone ?? '', birthday: user.birthday ?? '', color: user.color });
  }, [user]);

  if (!user) return null;
  const emailChanged = !!user.email && form.email.trim().toLowerCase() !== user.email.toLowerCase();
  const dirty =
    form.name !== user.name || form.email !== (user.email ?? '') || form.phone !== (user.phone ?? '') || form.birthday !== (user.birthday ?? '') || form.color !== user.color;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { name: form.name, phone: form.phone, birthday: form.birthday || null, color: form.color };
      if (emailChanged) {
        patch.email = form.email.trim();
        patch.current_password = emailPassword;
      }
      setMe(await api.patch<MeResponse>('/auth/me', patch));
      setEmailPassword('');
      toast.success('Profile saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="lg">
      <CardHeader title="Profile" subtitle="How your family sees you" icon={UserRound} accent="#5B5BD6" />
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
          <ImageUploader
            shape="circle"
            size={104}
            value={user.avatar_url}
            placeholder={<Avatar user={{ ...user, color: form.color, name: form.name || user.name }} size="2xl" />}
            hint="Photo changes save right away"
            maxSize={800}
            onSelect={async (file) => {
              setMe(await api.upload<MeResponse>('/auth/me/avatar', fileForm(file)));
              toast.success('Photo updated');
            }}
            onRemove={async () => setMe(await api.del<MeResponse>('/auth/me/avatar'))}
          />
          <div className="text-center sm:text-left">
            <div className="text-xl font-bold tracking-tight text-fg">{form.name || user.name}</div>
            <div className="text-sm text-muted">{user.email}</div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} autoComplete="name" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" disabled={!user.email} />
          </Field>
          {emailChanged && (
            <Field label="Current password" hint="Required to change your email." className="animate-fade-in sm:col-span-2">
              <PasswordInput autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} />
            </Field>
          )}
          <Field label="Phone">
            <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 555 0100" autoComplete="tel" />
          </Field>
          <Field label="Birthday" className="sm:col-span-2" hint="Shared with your family so nobody forgets 🎂">
            <Input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
          </Field>
        </div>
        <Field label="Your color" hint="Used for your avatar, calendar events and map pin. Saved with the rest of your profile.">
          <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
        </Field>
        <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
          {dirty && (
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-warning-soft-fg animate-fade-in" role="status">
              <span className="size-1.5 rounded-full bg-warning" /> Unsaved changes
            </span>
          )}
          <Button type="submit" loading={saving} disabled={!dirty || !form.name.trim() || (emailChanged && !emailPassword)}>
            Save profile
          </Button>
        </div>
      </form>
    </Card>
  );
}

const themes: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function ThemePreview({ dark }: { dark: boolean | 'split' }) {
  const pane = (d: boolean) => (
    <div className={cn('flex h-full flex-1 gap-1 p-1.5', d ? 'bg-[#0F1117]' : 'bg-[#F7F7FB]')}>
      <div className={cn('w-3 rounded-sm', d ? 'bg-[#171A23]' : 'bg-white')} />
      <div className="flex flex-1 flex-col gap-1">
        <div className={cn('h-2 w-2/3 rounded-sm', d ? 'bg-[#272B38]' : 'bg-[#E9E9F2]')} />
        <div className={cn('flex-1 rounded-sm', d ? 'bg-[#171A23]' : 'bg-white')}>
          <div className="m-1 h-1.5 w-1/2 rounded-sm bg-[#5B5BD6]" />
        </div>
      </div>
    </div>
  );
  return (
    <div className="flex h-14 w-full overflow-hidden rounded-lg border border-border">
      {dark === 'split' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(dark)
      )}
    </div>
  );
}

function AppearanceCard() {
  const { mode, setMode } = useTheme();
  return (
    <Card>
      <CardHeader title="Appearance" subtitle="Choose how Hearth looks on this device" icon={Palette} accent="#8E4EC6" />
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2.5">
        {themes.map((t) => {
          const on = mode === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(t.value)}
              className={cn(
                'relative flex flex-col gap-2 rounded-xl border-2 p-2 text-left transition',
                on ? 'border-primary bg-primary-soft/50' : 'border-border hover:border-border-strong',
              )}
            >
              <ThemePreview dark={t.value === 'system' ? 'split' : t.value === 'dark'} />
              <span className="flex items-center gap-1.5 px-0.5 text-[13px] font-semibold text-fg">
                <t.icon size={14} className="text-muted" /> {t.label}
              </span>
              {on && (
                <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary-solid text-white animate-check">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function PasswordCard() {
  const { setMe } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.next.length < 6) return setError('New password must be at least 6 characters');
    if (form.next !== form.confirm) return setError("Passwords don't match");
    setSaving(true);
    try {
      setMe(await api.patch<MeResponse>('/auth/me', { password: form.next, current_password: form.current }));
      setForm({ current: '', next: '', confirm: '' });
      toast.success('Password changed', { description: 'Other devices have been signed out.' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Password" subtitle="Change your sign-in password" icon={KeyRound} accent="#12A594" />
      <form onSubmit={save} className="flex flex-col gap-3.5">
        <Field label="Current password">
          <PasswordInput autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </Field>
        <Field label="New password">
          <PasswordInput autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </Field>
        <Field label="Confirm new password" error={error}>
          <PasswordInput autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <Button type="submit" variant="secondary" loading={saving} disabled={!form.current || !form.next} className="mt-1">
          Update password
        </Button>
      </form>
    </Card>
  );
}
