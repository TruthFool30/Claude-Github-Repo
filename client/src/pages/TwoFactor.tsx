import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Copy, Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copy } from '../lib/clipboard';
import { cn } from '../lib/cn';
import { useMediaQuery } from '../lib/hooks';
import type { MeResponse } from '../lib/types';
import { Badge, Button, Card, CardHeader, Checkbox, Field, IconButton, Input, Modal, toast, type InputProps } from '../ui';
import { PasswordInput } from './PasswordInput';

/** 6-digit authenticator code field: digits only, phone keypad + one-time-code autofill, calls onComplete at 6 digits. */
export function CodeInput({
  value, onChange, onComplete, className, ...rest
}: Omit<InputProps, 'value' | 'onChange'> & { value: string; onChange: (code: string) => void; onComplete?: (code: string) => void }) {
  return (
    <Input
      {...rest}
      size="lg"
      value={value}
      onChange={(e) => {
        const code = e.target.value.replace(/\D/g, '').slice(0, 6);
        onChange(code);
        if (code.length === 6 && code !== value) onComplete?.(code);
      }}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      placeholder="••••••"
      className={cn('text-center font-mono text-2xl font-semibold tracking-[0.4em] indent-[0.4em] placeholder:text-xl', className)}
    />
  );
}

type WithCodes = MeResponse & { recovery_codes: string[] };
const meOnly = ({ recovery_codes: _codes, ...me }: WithCodes): MeResponse => me;

export function TwoFactorCard() {
  const { twoFactor } = useAuth();
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'regenerate' | null>(null);
  const close = () => setDialog(null);
  const left = twoFactor.recoveryCodesLeft;
  const low = left <= 3;

  return (
    <Card>
      <CardHeader
        title="Two-factor login"
        subtitle="Extra security when you sign in"
        icon={ShieldCheck}
        accent="#30A46C"
        action={twoFactor.enabled ? <Badge tone="success" dot>On</Badge> : <Badge>Off</Badge>}
      />
      {twoFactor.enabled ? (
        <div className="flex flex-col gap-3">
          <div className={cn('flex items-start gap-3 rounded-xl p-3', low ? 'bg-warning-soft' : 'bg-surface-2')}>
            <KeyRound size={18} className={cn('mt-0.5 shrink-0', low ? 'text-warning-soft-fg' : 'text-muted')} aria-hidden />
            <div className="min-w-0 text-[13px] leading-snug">
              <div className={cn('font-semibold', low ? 'text-warning-soft-fg' : 'text-fg')}>
                {left} of 10 recovery codes left
              </div>
              <div className={low ? 'text-warning-soft-fg' : 'text-muted'}>
                {left === 0
                  ? 'Create new ones so you can still sign in if you lose your phone.'
                  : low
                    ? 'Running low — create a fresh set soon.'
                    : 'Each one signs you in once if you lose your phone.'}
              </div>
            </div>
          </div>
          <div className="flex gap-2 [&>*]:flex-1">
            <Button variant="secondary" icon={RefreshCw} onClick={() => setDialog('regenerate')}>
              New codes
            </Button>
            <Button variant="secondary" icon={ShieldOff} className="text-danger" onClick={() => setDialog('disable')}>
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-muted">
            Keep your account safe even if your password leaks: after your password, Hearth asks for a code from an authenticator app
            like Google Authenticator, 1Password or Authy.
          </p>
          <Button variant="secondary" block icon={ShieldCheck} onClick={() => setDialog('enable')}>
            Turn on
          </Button>
        </div>
      )}
      <EnableDialog open={dialog === 'enable'} onClose={close} />
      <DisableDialog open={dialog === 'disable'} onClose={close} />
      <RegenerateDialog open={dialog === 'regenerate'} onClose={close} />
    </Card>
  );
}

function DialogIcon({ danger }: { danger?: boolean }) {
  const Icon = danger ? ShieldOff : ShieldCheck;
  return (
    <span className={cn('flex size-9 items-center justify-center rounded-xl', danger ? 'bg-danger-soft text-danger-soft-fg' : 'bg-success-soft text-success-soft-fg')}>
      <Icon size={18} aria-hidden />
    </span>
  );
}

/**
 * Modal props for the recovery-codes step. It is the last step of the same dialog (so the sheet
 * doesn't re-animate) and can't be dismissed until "I saved them" is ticked.
 */
const codesStep = (saved: boolean, onClose: () => void) => ({
  dismissible: false,
  hideClose: true,
  icon: <DialogIcon />,
  description: "If you lose your phone, each code lets you sign in once. Keep them somewhere safe — they won't be shown again.",
  footer: (
    <Button onClick={onClose} disabled={!saved}>
      Done
    </Button>
  ),
});

/** Recovery codes (shown once) with Copy / Download and the "I saved them" checkbox. */
function RecoveryCodes({ codes, saved, onSavedChange }: { codes: string[]; saved: boolean; onSavedChange: (saved: boolean) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  // The field that had focus is gone: move focus to the codes so screen readers read them.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  const text = `Hearth recovery codes\nEach code signs you in once if you can't use your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'hearth-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <>
      <ul
        ref={listRef}
        tabIndex={-1}
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-border bg-surface-2 px-4 py-3.5 font-mono text-[15px] font-semibold tracking-wide text-fg outline-none focus-visible:ring-4 focus-visible:ring-ring"
      >
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" icon={Copy} onClick={() => copy(text, 'Recovery codes')}>
          Copy
        </Button>
        <Button variant="secondary" icon={Download} onClick={download}>
          Download
        </Button>
      </div>
      <Checkbox className="mt-4" checked={saved} onChange={onSavedChange} label="I saved my recovery codes" />
    </>
  );
}

interface Setup {
  secret: string;
  otpauth_uri: string;
  qr_svg: string;
}

function EnableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setMe } = useAuth();
  const [step, setStep] = useState<'password' | 'scan'>('password');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  // Auto-submit at 6 digits and Enter / a password manager can fire in the same tick: one request only.
  const inFlight = useRef(false);
  const onPhone = useMediaQuery('(pointer: coarse)');

  useEffect(() => {
    if (!open) return;
    setStep('password');
    setPassword('');
    setSetup(null);
    setCode('');
    setCodes(null);
    setSaved(false);
    setError(null);
  }, [open]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      setSetup(await api.post<Setup>('/auth/2fa/setup', { password }));
      setPassword('');
      setStep('scan');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** Closing before the code is confirmed: tell the server to forget the pending secret. */
  const cancel = () => {
    if (setup) void api.del('/auth/2fa/setup').catch(() => {});
    onClose();
  };

  const confirm = async (value: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<WithCodes>('/auth/2fa/enable', { code: value });
      setMe(meOnly(res));
      setCodes(res.recovery_codes);
      toast.success('Two-factor login is on', { description: 'Other devices have been signed out.' });
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
      requestAnimationFrame(() => codeRef.current?.focus());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Modal open={open} onClose={onClose} size="sm" title="Save your recovery codes" {...codesStep(saved, onClose)}>
        <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={cancel}
      size="sm"
      dismissible={!busy}
      icon={<DialogIcon />}
      title={step === 'password' ? 'Turn on two-factor login' : 'Add Hearth to your app'}
      description={
        step === 'password' ? 'First, confirm it’s you.' : 'Scan this QR code with your authenticator app, then enter the 6‑digit code it shows.'
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              if (step === 'password') return cancel();
              setError(null);
              setStep('password');
            }}
            disabled={busy}
          >
            {step === 'scan' ? 'Back' : 'Cancel'}
          </Button>
          <Button type="submit" form="tfa-enable" loading={busy} disabled={step === 'password' ? !password : code.length !== 6}>
            {step === 'password' ? 'Continue' : 'Turn on'}
          </Button>
        </>
      }
    >
      {step === 'password' || !setup ? (
        <form id="tfa-enable" onSubmit={start}>
          <Field label="Current password" error={error}>
            <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </form>
      ) : (
        <form
          id="tfa-enable"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm(code);
          }}
        >
          <div className="flex flex-col items-center gap-3">
            {/* Our own server-rendered SVG, shown as an image so nothing in it can run. */}
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr_svg)}`}
              alt="QR code for your authenticator app"
              width={176}
              height={176}
              className="size-44 rounded-2xl bg-white p-3 shadow-card ring-1 ring-border"
            />
            {onPhone && (
              <a href={setup.otpauth_uri} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline">
                <Smartphone size={15} aria-hidden /> Open in authenticator app
              </a>
            )}
          </div>
          <div>
            <p className="text-[13px] text-muted">Can't scan it? Enter this setup key instead:</p>
            <div className="mt-1.5 flex items-center gap-1 rounded-xl border border-border bg-surface-2 py-1 pl-3 pr-1">
              <code className="min-w-0 flex-1 break-words font-mono text-[13px] font-semibold tracking-wide text-fg">
                {setup.secret}
              </code>
              <IconButton icon={Copy} label="Copy setup key" size="sm" onClick={() => copy(setup.secret.replace(/\s/g, ''), 'Setup key')} />
            </div>
          </div>
          <Field label="6-digit code from the app" error={error}>
            <CodeInput ref={codeRef} value={code} onChange={setCode} onComplete={(c) => void confirm(c)} autoFocus={!onPhone} />
          </Field>
        </form>
      )}
    </Modal>
  );
}

/** "Prove it's you, then act" dialog (turn off, new codes); can continue into the recovery-codes step. */
function CodeFormDialog({
  open, onClose, title, description, danger, submitLabel, withPassword, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  danger?: boolean;
  submitLabel: string;
  withPassword?: boolean;
  /** Returns new recovery codes to show next, or nothing to close. */
  onSubmit: (input: { password: string; code: string }) => Promise<string[] | void>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  /** Shown under the field it is about (the server marks wrong passwords with `field: 'password'`). */
  const [error, setError] = useState<{ field: 'password' | 'code'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setCode('');
    setCodes(null);
    setSaved(false);
    setError(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const fresh = await onSubmit({ password, code: code.trim() });
      if (fresh) setCodes(fresh);
      else onClose();
    } catch (err) {
      const field = err instanceof ApiError && (err.data as { field?: string } | null)?.field === 'password' ? 'password' : 'code';
      setError({ field, message: errorMessage(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Modal open={open} onClose={onClose} size="sm" title="Your new recovery codes" {...codesStep(saved, onClose)}>
        <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      icon={<DialogIcon danger={danger} />}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="tfa-code"
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={(withPassword && !password) || !code.trim()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="tfa-code" onSubmit={submit} className="flex flex-col gap-3.5">
        {withPassword && (
          <Field label="Current password" error={error?.field === 'password' && error.message}>
            <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <Field
          label="Authentication code"
          hint="From your authenticator app, or one of your recovery codes."
          error={error?.field === 'code' && error.message}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            icon={KeyRound}
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="123456 or abcd-efgh-jkmn"
            maxLength={40}
          />
        </Field>
      </form>
    </Modal>
  );
}

function DisableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setMe } = useAuth();
  return (
    <CodeFormDialog
      open={open}
      onClose={onClose}
      danger
      withPassword
      title="Turn off two-factor login?"
      description="You'll sign in with just your password again, and your recovery codes stop working."
      submitLabel="Turn off"
      onSubmit={async ({ password, code }) => {
        setMe(await api.post<MeResponse>('/auth/2fa/disable', { password, code }));
        toast.success('Two-factor login is off');
      }}
    />
  );
}

function RegenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setMe } = useAuth();
  return (
    <CodeFormDialog
      open={open}
      onClose={onClose}
      title="Create new recovery codes"
      description="You'll get 10 fresh codes. Your old codes stop working right away."
      submitLabel="Create codes"
      onSubmit={async ({ code }) => {
        const res = await api.post<WithCodes>('/auth/2fa/recovery-codes', { code });
        setMe(meOnly(res));
        return res.recovery_codes;
      }}
    />
  );
}
