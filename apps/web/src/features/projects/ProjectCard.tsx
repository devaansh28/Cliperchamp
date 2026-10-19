import type { ProjectSummary } from '@clipforge/shared';
import { Copy, Film, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/utils';

export function ProjectCard({
  project,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: ProjectSummary;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const hasActions = Boolean(onRename ?? onDuplicate ?? onDelete);
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50" data-testid="project-card">
      <Link to={`/app/projects/${project.id}/edit`} className="block" aria-label={`Open ${project.name}`}>
        <div className="flex aspect-[9/12] items-center justify-center bg-muted">
          {project.thumbnailUrl ? (
            <img src={project.thumbnailUrl} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <Film className="size-8 text-muted-foreground" />
          )}
        </div>
        <div className="space-y-0.5 p-3">
          <p className="truncate text-sm font-medium">{project.name}</p>
          <p className="text-xs text-muted-foreground">Edited {relativeTime(project.updatedAt)}</p>
        </div>
      </Link>
      {hasActions ? (
        <div className="absolute right-2 top-2">
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={`Actions for ${project.name}`}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className="opacity-90"
          >
            <MoreVertical />
          </Button>
          {menu ? (
            <div role="menu" className="absolute right-0 z-10 mt-1 w-36 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              {[
                { label: 'Rename', icon: Pencil, fn: onRename },
                { label: 'Duplicate', icon: Copy, fn: onDuplicate },
                { label: 'Delete', icon: Trash2, fn: onDelete, danger: true },
              ]
                .filter((i) => i.fn)
                .map(({ label, icon: Icon, fn, danger }) => (
                  <button
                    key={label}
                    role="menuitem"
                    type="button"
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted ${danger ? 'text-destructive' : ''}`}
                    onClick={() => {
                      setMenu(false);
                      fn?.();
                    }}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
