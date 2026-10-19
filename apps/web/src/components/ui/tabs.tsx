import * as React from 'react';
import { cn } from '@/lib/utils';

/** Minimal accessible tab list (roving focus with arrow keys). */
export function TabList<T extends string>({
  tabs,
  value,
  onChange,
  orientation = 'horizontal',
  className,
  label,
}: {
  tabs: { id: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  label: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = orientation === 'vertical' ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
    const dir = e.key === next[0] ? 1 : e.key === next[1] ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const j = (i + dir + tabs.length) % tabs.length;
    refs.current[j]?.focus();
    onChange(tabs[j]!.id);
  };
  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className={cn('flex gap-1', orientation === 'vertical' && 'flex-col', className)}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer',
            orientation === 'vertical' && 'flex-col gap-1 px-2 py-2.5 [&_svg]:size-5',
            value === t.id && 'bg-muted text-foreground',
          )}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
