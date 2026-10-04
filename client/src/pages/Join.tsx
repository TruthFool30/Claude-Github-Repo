import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Link2Off, LogIn, UserPlus, Users } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { plural } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import type { Family } from '../lib/types';
import { Button, EmptyState, Spinner, buttonClass, toast } from '../ui';
import { FamilyAvatar } from '../layout/FamilyAvatar';
import { AuthLayout } from './AuthLayout';

interface InvitePreview {
  name: string;
  member_count: number;
  already_member: boolean;
  family_id: number | null;
}

/** /join/:code — works signed out (sign in / sign up keeps the code) and signed in (confirm). */
export default function JoinPage() {
  useDocumentTitle('Join a family');
  const { code = '' } = useParams();
  const { user, loading, families, switchFamily } = useAuth();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const preview = useQuery({
    queryKey: ['auth', 'invite', code, !!user],
    queryFn: () => api.get<InvitePreview>(`/families/invite/${encodeURIComponent(code)}`),
    retry: false,
    enabled: !loading,
  });

  if (loading || preview.isPending) {
    return (
      <AuthLayout title="Checking your invite…">
        <div className="flex justify-center py-8 text-primary"><Spinner size={28} /></div>
      </AuthLayout>
    );
  }

  if (preview.isError) {
    const tooMany = preview.error instanceof ApiError && preview.error.status === 429;
    return (
      <AuthLayout title="Hmm, that link didn't work">
        <EmptyState
          compact
          icon={Link2Off}
          title={tooMany ? 'Too many attempts' : 'Invite not found'}
          description={tooMany ? errorMessage(preview.error) : 'The invite may have been replaced with a new one. Ask a family admin for a fresh link.'}
          action={
            <Link to={user ? '/home' : '/login'} className={buttonClass('secondary')}>
              {user ? 'Back to Hearth' : 'Sign in'}
            </Link>
          }
        />
      </AuthLayout>
    );
  }

  const inv = preview.data;
  const card = (
    <div className="mb-6 flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <FamilyAvatar family={{ name: inv.name }} size={56} />
      <div className="min-w-0">
        <div className="truncate text-lg font-bold tracking-tight text-fg">{inv.name}</div>
        <div className="flex items-center gap-1.5 text-sm text-muted">
          <Users size={14} /> {plural(inv.member_count, 'member')}
        </div>
      </div>
    </div>
  );

  if (!user) {
    return (
      <AuthLayout title="You're invited!" subtitle={`Join ${inv.name} on Hearth to share calendars, lists, photos and more.`}>
        {card}
        <div className="flex flex-col gap-3">
          <Link to={`/register?code=${encodeURIComponent(code)}`} className={buttonClass('primary', 'lg', 'w-full')}>
            <UserPlus size={18} /> Create an account
          </Link>
          <Link to="/login" state={{ from: `/join/${code}` }} className={buttonClass('secondary', 'lg', 'w-full')}>
            <LogIn size={18} /> I already have an account
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const open = async (familyId: number) => {
    await switchFamily(familyId);
    navigate('/home', { replace: true });
  };

  if (inv.already_member && inv.family_id) {
    return (
      <AuthLayout title={`You're already in ${inv.name}`} subtitle="Nothing to do — jump right in.">
        {card}
        <Button size="lg" block iconRight={ArrowRight} onClick={() => open(inv.family_id!)}>
          Open {inv.name}
        </Button>
      </AuthLayout>
    );
  }

  const join = async () => {
    setJoining(true);
    try {
      const fam = await api.post<Family>('/families/join', { invite_code: code });
      await open(fam.id);
      toast.success(`Welcome to ${fam.name}!`);
    } catch (e) {
      toast.error(errorMessage(e));
      setJoining(false);
    }
  };

  return (
    <AuthLayout title={`Join ${inv.name}?`} subtitle={`You're signed in as ${user.name}.`}>
      {card}
      <div className="flex flex-col gap-3">
        <Button size="lg" block loading={joining} onClick={join} icon={UserPlus}>
          Join {inv.name}
        </Button>
        <Button size="lg" block variant="ghost" onClick={() => navigate(families.length ? '/home' : '/onboarding')} disabled={joining}>
          Not now
        </Button>
      </div>
    </AuthLayout>
  );
}
