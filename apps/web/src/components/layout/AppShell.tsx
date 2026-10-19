import { CreditCard, FolderOpen, LayoutDashboard, LogOut, Plus, Settings } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';
import { queryClient } from '@/lib/query';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { Logo } from './Logo';

const NAV = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/projects', label: 'Projects', icon: FolderOpen, end: false },
  { to: '/app/billing', label: 'Usage & plan', icon: CreditCard, end: false },
  { to: '/app/settings', label: 'Settings', icon: Settings, end: false },
];

export function AppShell() {
  const email = useAuthStore((s) => s.session?.user.email);
  const navigate = useNavigate();
  const signOut = async () => {
    await auth.signOut();
    queryClient.clear();
    navigate('/login');
  };
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/50 p-4 md:flex">
        <Logo to="/app" className="mb-6 px-2" />
        <Button asChild className="mb-4">
          <NavLink to="/app/projects/new">
            <Plus /> New video
          </NavLink>
        </Button>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn('flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground', isActive && 'bg-muted text-foreground')
              }
            >
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border pt-3">
          <p className="truncate px-2 text-xs text-muted-foreground" title={email ?? undefined}>
            {email}
          </p>
          <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => void signOut()}>
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
          <Logo to="/app" />
          <nav className="flex gap-1" aria-label="Main mobile">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} aria-label={label} className={({ isActive }) => cn('rounded-md p-2 text-muted-foreground', isActive && 'bg-muted text-foreground')}>
                <Icon className="size-4" />
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
