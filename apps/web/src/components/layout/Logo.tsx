import { Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function Logo({ to = '/', className }: { to?: string; className?: string }) {
  return (
    <Link to={to} className={cn('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
        <Zap className="size-4 fill-white text-white" />
      </span>
      ClipForge <span className="text-primary">AI</span>
    </Link>
  );
}
