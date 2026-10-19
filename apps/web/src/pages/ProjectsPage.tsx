import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectSummary } from '@clipforge/shared';
import { Film, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, Notice, Skeleton } from '@/components/ui/misc';
import { ProjectCard } from '@/features/projects/ProjectCard';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';

type Sort = 'updated' | 'created' | 'name';

export function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const projects = useQuery({ queryKey: qk.projects(search, sort), queryFn: () => api.listProjects({ search, sort }) });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.allProjects });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateProject(id, { name }),
    onSuccess: () => {
      toast.success('Project renamed');
      setRenaming(null);
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateProject(id),
    onSuccess: (copy) => {
      toast.success(`Created “${copy.name}”`);
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      toast.success('Project deleted');
      setDeleting(null);
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground">All your videos in one place.</p>
        </div>
        <Button onClick={() => navigate('/app/projects/new')}>
          <Plus /> New video
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search projects" placeholder="Search projects" className="pl-9" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <Select aria-label="Sort projects" className="w-44" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="updated">Recently edited</option>
          <option value="created">Newest first</option>
          <option value="name">Name A–Z</option>
        </Select>
      </div>

      {projects.isPending ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/14]" />
          ))}
        </div>
      ) : projects.isError ? (
        <Notice tone="error">{errorMessage(projects.error)}</Notice>
      ) : projects.data.length === 0 ? (
        search ? (
          <EmptyState icon={<Search />} title="No matches" description={`Nothing matches “${search}”.`} />
        ) : (
          <EmptyState icon={<Film />} title="No projects yet" action={<Button asChild><Link to="/app/projects/new">Create a video</Link></Button>} />
        )
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {projects.data.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onRename={() => {
                setRenaming(p);
                setNewName(p.name);
              }}
              onDuplicate={() => duplicate.mutate(p.id)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      )}

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming && newName.trim()) rename.mutate({ id: renaming.id, name: newName.trim() });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Rename project</DialogTitle>
            </DialogHeader>
            <Input aria-label="Project name" autoFocus maxLength={120} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || rename.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete project?"
        description={`“${deleting?.name ?? ''}” and its exported videos will be deleted. Uploaded media stays in your library. This cannot be undone.`}
        confirmLabel="Delete project"
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
