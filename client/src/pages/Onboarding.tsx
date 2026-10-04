import { Link, Navigate, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { firstName } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { AuthLayout } from './AuthLayout';
import { FamilySetup } from './FamilySetup';

/** Shown to signed-in users without a family (or with ?add=1 to add another one). */
export default function Onboarding() {
  useDocumentTitle('Set up your family');
  const { user, families, logout } = useAuth();
  const [params] = useSearchParams();
  const adding = params.get('add') === '1';
  if (families.length && !adding) return <Navigate to="/home" replace />;
  return (
    <AuthLayout
      title={adding ? 'Add another family' : `Welcome, ${firstName(user?.name)}!`}
      subtitle={adding ? 'Create a new family space or join one with an invite code.' : "Let's get your family space set up."}
    >
      <FamilySetup initialCode={params.get('code') ?? ''} />
      <div className="mt-6 text-center text-sm">
        {adding ? (
          <Link to="/home" className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline">
            <ArrowLeft size={15} /> Back to Hearth
          </Link>
        ) : (
          <button type="button" onClick={() => logout()} className="font-medium text-muted hover:text-fg">
            Sign out
          </button>
        )}
      </div>
    </AuthLayout>
  );
}
