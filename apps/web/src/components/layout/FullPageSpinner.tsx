import { Spinner } from '@/components/ui/misc';

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center gap-3 text-sm text-muted-foreground" role="status">
      <Spinner />
      {label}…
    </div>
  );
}
