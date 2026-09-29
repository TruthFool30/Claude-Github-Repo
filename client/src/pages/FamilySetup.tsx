import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Home, KeyRound, Ticket } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../lib/api';
import { ME_KEY } from '../lib/auth';
import { Button, Field, Input, SegmentedControl, toast } from '../ui';
import type { Family } from '../lib/types';

/** Create a new family or join one with an invite code. Used by Register + Onboarding. */
export function FamilySetup({ initialCode = '', defaultName = '' }: { initialCode?: string; defaultName?: string }) {
  const [mode, setMode] = useState<'create' | 'join'>(initialCode ? 'join' : 'create');
  const [name, setName] = useState(defaultName);
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const family =
        mode === 'create'
          ? await api.post<Family>('/families', { name })
          : await api.post<Family>('/families/join', { invite_code: code });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success(mode === 'create' ? `${family.name} is ready!` : `You joined ${family.name}`);
      navigate('/home', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <SegmentedControl
        block
        aria-label="Create or join"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        options={[
          { value: 'create', label: 'Create a family', icon: Home },
          { value: 'join', label: 'Join with a code', icon: Ticket },
        ]}
      />
      {mode === 'create' ? (
        <Field label="Family name" hint="You can change this any time." error={error}>
          <Input icon={Home} placeholder="e.g. The Riveras" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </Field>
      ) : (
        <Field label="Invite code" hint="Ask a family admin — it's on their Family page." error={error}>
          <Input
            icon={KeyRound}
            placeholder="ABCD-2345"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="font-mono tracking-[0.2em]"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={12}
            autoFocus
          />
        </Field>
      )}
      <Button type="submit" size="lg" block loading={loading} disabled={mode === 'create' ? !name.trim() : code.replace(/[^A-Z0-9]/gi, '').length < 4}>
        {mode === 'create' ? 'Create family' : 'Join family'}
      </Button>
    </form>
  );
}
