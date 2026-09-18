import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, X } from 'lucide-react';
import { post } from '../lib/api';
import { Field, Spinner } from './ui';
import type { Project } from '../lib/types';

/** `My UAT Cluster` -> `my-uat-cluster`. */
const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Create a project.
 *
 * A project is the isolation boundary -- its own targets, credentials, agents, risk
 * policy and kill switch -- so this is how you separate production from a lab
 * rather than trusting one agent to keep them apart.
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () =>
      post<Project>('/projects', {
        name: name.trim(),
        slug: slug.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project);
      reset();
    },
  });

  function reset() {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setDescription('');
    create.reset();
  }

  // Escape closes, matching every other dismissible surface.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const valid = name.trim().length > 0 && /^[a-z0-9-]+$/.test(effectiveSlug);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ground/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="tile w-full max-w-md">
        <header className="flex items-center gap-2.5 border-b border-hairline px-5 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue/15 text-blue">
            <FolderPlus size={16} />
          </span>
          <h2 className="flex-1 text-[15px] font-semibold text-ink">New project</h2>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-white/5 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <Field label="Name">
            <input
              className="input"
              placeholder="Production"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label="Slug" hint="Used in URLs and the API. Lowercase letters, numbers and hyphens.">
            <input
              className="input font-mono text-xs"
              placeholder="production"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
            />
          </Field>

          <Field label="Description" hint="Optional. What this project covers.">
            <input
              className="input"
              placeholder="Customer-facing production estate"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <p className="rounded-inner border border-hairline bg-tile-2/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            A project gets its own targets, credentials, agents and risk policy. Agents in one
            project cannot reach another project's machines — the targets are absent from the
            tools they are given, not merely denied.
          </p>

          {create.error && (
            <p className="text-sm text-red">
              {create.error instanceof Error ? create.error.message : 'Could not create the project'}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!valid || create.isPending}
            onClick={() => {
              if (!slugTouched) setSlug(effectiveSlug);
              create.mutate();
            }}
          >
            {create.isPending ? <Spinner /> : null} Create project
          </button>
        </footer>
      </div>
    </div>
  );
}
