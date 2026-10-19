import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { FullPageSpinner } from './components/layout/FullPageSpinner';
import { AuthPage } from './pages/AuthPage';
import { BillingPage } from './pages/BillingPage';
import { CreateProjectPage } from './pages/CreateProjectPage';
import { DashboardPage } from './pages/DashboardPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useAuthStore } from './stores/auth-store';

// The editor pulls in the Remotion player and composition; load it on demand.
const EditorPage = lazy(() => import('./pages/EditorPage'));

function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signed-out') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function GuestOnly() {
  const status = useAuthStore((s) => s.status);
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signed-in') return <Navigate to="/app" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/register', element: <AuthPage mode="register" /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/app',
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/new', element: <CreateProjectPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'billing', element: <BillingPage /> },
        ],
      },
      {
        path: '/app/projects/:projectId/edit',
        element: (
          <Suspense fallback={<FullPageSpinner label="Opening editor" />}>
            <EditorPage />
          </Suspense>
        ),
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
