import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './lib/auth';
import { AppShell } from './layout/AppShell';
import { LogoMark } from './layout/Logo';
import { modules } from './modules/registry';
import { PageSpinner } from './ui';
import Login from './pages/Login';
import NotFound from './pages/NotFound';

const Register = lazy(() => import('./pages/Register'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const FamilyPage = lazy(() => import('./pages/Family'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const JoinPage = lazy(() => import('./pages/Join'));
const UiKit = lazy(() => import('./pages/UiKit'));

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <LogoMark size={56} className="animate-pulse" />
    </div>
  );
}

/** Signed-in users only; remembers where they were going. */
function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Requires an active family, otherwise → onboarding. */
function RequireFamily({ children }: { children: ReactNode }) {
  const { family, families, loading } = useAuth();
  if (loading) return <Splash />;
  if (!families.length) return <Navigate to="/onboarding" replace />;
  if (!family) return <Splash />;
  return <>{children}</>;
}

/** Login/Register: bounce signed-in users into the app. */
function PublicOnly({ children, allowNoFamily }: { children: ReactNode; allowNoFamily?: boolean }) {
  const { user, families, loading } = useAuth();
  const location = useLocation();
  const code = new URLSearchParams(location.search).get('code');
  const from = (location.state as { from?: string } | null)?.from ?? (code && location.pathname === '/register' ? `/join/${code}` : undefined);
  if (loading) return <Splash />;
  if (user && from?.startsWith('/join/')) return <Navigate to={from} replace />;
  if (user && families.length) return <Navigate to={from || '/home'} replace />;
  if (user && !allowNoFamily) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export default function App() {
  // Lazy pages outside the AppShell (register, join, onboarding) show the splash while loading.
  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/register" element={<PublicOnly allowNoFamily><Register /></PublicOnly>} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route element={<RequireFamily><AppShell /></RequireFamily>}>
            <Route index element={<Navigate to="/home" replace />} />
            {modules.map((m) => (
              <Route
                key={m.id}
                path={`${m.path}/*`}
                element={
                  <Suspense fallback={<PageSpinner />}>
                    <m.element />
                  </Suspense>
                }
              />
            ))}
            <Route path="/family" element={<FamilyPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/profile" element={<Navigate to="/settings" replace />} />
            <Route path="/ui-kit" element={<UiKit />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
