import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { BookUser, FolderClosed, KeyRound } from 'lucide-react';
import { useLive } from '../../lib/live';
import { PageHeader, SkeletonList, Tabs } from '../../ui';
import mod from './index';
import { useOverview } from './api';

const ContactsSection = lazy(() => import('./Contacts'));
const DocsSection = lazy(() => import('./Documents'));
const NotesSection = lazy(() => import('./Notes'));

type Section = 'contacts' | 'docs' | 'notes';

export default function VaultPage() {
  useLive('vault');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const overview = useOverview().data;
  const section: Section = pathname.startsWith('/vault/docs') ? 'docs' : pathname.startsWith('/vault/notes') ? 'notes' : 'contacts';
  const titles: Record<Section, string> = { contacts: 'Contacts', docs: 'Documents', notes: 'Info cards' };

  return (
    <div>
      <PageHeader
        title={mod.label}
        subtitle="Important numbers, documents and family info in one safe place"
        icon={mod.icon}
        accent={mod.accent}
        documentTitle={`${titles[section]} · ${mod.label}`}
      >
        <Tabs<Section>
          accent={mod.accent}
          value={section}
          onChange={(id) => navigate(`/vault/${id}`)}
          tabs={[
            { id: 'contacts', label: 'Contacts', icon: BookUser, count: overview?.contacts },
            { id: 'docs', label: <><span className="sm:hidden">Docs</span><span className="max-sm:hidden">Documents</span></>, icon: FolderClosed, count: overview?.documents },
            { id: 'notes', label: <><span className="sm:hidden">Info</span><span className="max-sm:hidden">Info cards</span></>, icon: KeyRound, count: overview?.notes },
          ]}
        />
      </PageHeader>
      <Suspense fallback={<SkeletonList rows={6} />}>
        <Routes>
          <Route index element={<Navigate to="/vault/contacts" replace />} />
          <Route path="contacts/*" element={<ContactsSection />} />
          <Route path="docs/*" element={<DocsSection />} />
          <Route path="notes/*" element={<NotesSection />} />
          <Route path="*" element={<Navigate to="/vault/contacts" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
