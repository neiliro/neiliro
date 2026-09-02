import { t } from '../lib/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type HouseholdMember, type Project, type Task } from '../lib/api';
import { INBOX_ID, PRIORITIES, PRIORITY_LABEL, buildTree, projectTitle } from '../lib/tasks';
import { plural } from '../lib/format';
import { useLatest } from '../lib/latest';
import { Empty, Page } from '../components/Page';
import { onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { TaskList } from '../components/TaskList';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetail } from '../components/TaskDetail';
import { EntityDialog, PALETTE } from '../components/EntityDialog';

type View = 'list' | 'board';

const control =
  'rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

export function Tasks() {
  const [params, setParams] = useSearchParams();
  const isLatest = useLatest();
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [includeDone, setIncludeDone] = useState(false);
  const [view, setView] = useState<View>('list');
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const loadTasks = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (assignee) params.set('assignee_id', assignee);
    if (priority) params.set('priority', priority);
    if (includeDone || view === 'board') params.set('include_done', 'true');
    const fresh = isLatest();
    try {
      const rows = await api.get<Task[]>(`/tasks?${params}`);
      if (!fresh()) return;
      setTasks(rows);
      setError(null);
    } catch (err) {
      if (!fresh()) return;
      setError(err instanceof Error ? err.message : t('Could not load tasks'));
    }
  }, [projectId, assignee, priority, includeDone, view, isLatest]);

  const loadProjects = useCallback(async () => {
    setProjects(await api.get<Project[]>(`/projects?archived=${showArchived}`));
  }, [showArchived]);

  useEffect(() => {
    void loadProjects();
    void api.get<HouseholdMember[]>('/household').then(setMembers);
  }, [loadProjects]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // In the archive "all projects" is meaningless: with no project chosen
  // the task list is unfiltered and shows items from active projects.
  useEffect(() => {
    if (!showArchived) return;
    if (projectId && projects.some((p) => p.id === projectId)) return;
    setProjectId(projects[0]?.id ?? '');
  }, [showArchived, projects, projectId]);

  const refresh = useCallback(
    (spawned?: Task | null) => {
      if (spawned?.due_date) {
        setNotice(t('Next occurrence scheduled for {date}', { date: spawned.due_date }));
        setTimeout(() => setNotice(null), 4000);
      }
      void loadTasks();
      void loadProjects();
    },
    [loadTasks, loadProjects],
  );

  const tree = useMemo(() => buildTree(tasks ?? []), [tasks]);
  const totalOpen = useMemo(
    () => projects.reduce((sum, p) => sum + (p.open_tasks ?? 0), 0),
    [projects],
  );

  // Arriving from global search: /tasks?open=<id> or /tasks?project=<id>
  useEffect(() => {
    const project = params.get('project');
    const target = params.get('open');
    if (!project && !target) return;
    if (project) setProjectId(project);
    if (target) {
      // One task by id, not the whole family's list filtered client-side:
      // the old version fetched every task including done ones just to
      // find this one, which is what kept that endpoint uncapped.
      void api
        .get<Task>(`/tasks/${target}`)
        .then((found) => {
          setProjectId(found.project_id);
          setSelected(found);
        })
        .catch(() => {});
    }
    setParams({}, { replace: true });
  }, [params, setParams]);

  async function addTask() {
    const title = newTitle.trim();
    if (!title) return;
    const target = projectId || newProject || projects[0]?.id;
    if (!target) return;
    const created = await api.post<Task>('/tasks', { project_id: target, title });
    setNewTitle('');
    refresh();
    setSelected(created);
  }

  return (
    <Page
      title={t('Tasks')}
      eyebrow={t('Projects and tasks')}
      // The board needs its columns more than it needs side margins
      width={view === 'board' ? 'full' : 'default'}
      action={
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {(['list', 'board'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                view === v ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {v === 'list' ? t('List') : t('Board')}
            </button>
          ))}
        </div>
      }
    >
      {/* Projects */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {!showArchived && (
          <button
            type="button"
            onClick={() => setProjectId('')}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
              projectId === ''
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted hover:text-ink'
            }`}
          >
            {t('All projects')}
            {/* The same open-task counter every project has */}
            {totalOpen > 0 && <span className="font-mono text-xs">{totalOpen}</span>}
          </button>
        )}
        {projects.map((p) => (
          <span
            key={p.id}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
              projectId === p.id
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted'
            }`}
          >
            <button
              type="button"
              onClick={() => setProjectId(p.id)}
              className="flex items-center gap-2 hover:text-ink"
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: p.color }}
                aria-hidden
              />
              {projectTitle(p.id, p.title)}
              {p.open_tasks > 0 && <span className="font-mono text-xs">{p.open_tasks}</span>}
            </button>

            {/* Project settings only on the selected one: otherwise the
                chip row turns into a picket fence of gears */}
            {projectId === p.id && p.id !== INBOX_ID && (
              <button
                type="button"
                onClick={() => setEditingProject(p)}
                aria-label={t('Configure project {title}', { title: projectTitle(p.id, p.title) })}
                className="opacity-60 hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 4v2M12 18v2M20 12h-2M6 12H4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4M17.7 17.7l-1.4-1.4M7.7 7.7 6.3 6.3" />
                </svg>
              </button>
            )}
          </span>
        ))}

        {!showArchived && (
          <button
            type="button"
            onClick={() => setCreatingProject(true)}
            className="rounded-full border border-dashed border-line px-3 py-1.5 text-sm text-muted hover:text-ink"
          >
            {t('+ project')}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setShowArchived(!showArchived);
            setProjectId('');
          }}
          className={`ml-auto rounded-full border px-3 py-1.5 text-sm transition-colors ${
            showArchived ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
          }`}
        >
          {t('Archive')}
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={control}>
          <option value="">{t('All assignees')}</option>
          <option value="none">{t('Unassigned')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={control}>
          <option value="">{t('Any priority')}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>

        {view === 'list' && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(e) => setIncludeDone(e.target.checked)}
              className="size-4 accent-[var(--c-accent)]"
            />
            {t('Show completed')}
          </label>
        )}
      </div>

      {/* Quick add. flex-wrap is mandatory: the row does not fit a phone
          screen whole, and without wrapping the select and the button pushed
          the page into a horizontal scroll */}
      {view === 'list' && !showArchived && (
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            value={newTitle}
            placeholder={projectId ? t('New task in this project') : t('New task')}
            onChange={(e) => setNewTitle(e.target.value)}
            onBlur={clearBlankOnBlur(() => setNewTitle(''))}
            onKeyDown={onEnter(() => void addTask())}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent sm:w-auto sm:flex-1"
          />
          {!projectId && (
            <select
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              className={`${control} min-w-0 flex-1 sm:flex-none`}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectTitle(p.id, p.title)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void addTask()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t('Add')}
          </button>
        </div>
      )}

      {notice && (
        <p className="mb-4 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-sm text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-urgent bg-urgent/10 px-4 py-2.5 text-sm text-ink">
          {error}
        </p>
      )}

      {showArchived && projects.length === 0 ? (
        <Empty>{t('The archive is empty. A project gets here from its own settings.')}</Empty>
      ) : tasks === null ? (
        <div className="h-40 animate-pulse rounded-card bg-surface-3" />
      ) : view === 'list' ? (
        <TaskList nodes={tree} onChanged={refresh} onOpen={setSelected} />
      ) : (
        <TaskBoard tasks={tasks} onChanged={() => refresh()} onOpen={setSelected} />
      )}

      {creatingProject && (
        <EntityDialog
          title={t('New project')}
          initial={{ name: '', color: PALETTE[0] }}
          onSave={async (draft) => {
            const created = await api.post<Project>('/projects', {
              title: draft.name,
              color: draft.color,
            });
            await loadProjects();
            setProjectId(created.id);
          }}
          onClose={() => setCreatingProject(false)}
        />
      )}

      {editingProject && (
        <EntityDialog
          title={t('Project')}
          initial={{ name: editingProject.title, color: editingProject.color }}
          archiveLabel={
            editingProject.archived_at ? t('Unarchive') : t('Move to archive')
          }
          deletable={editingProject.total_tasks === 0}
          deleteHint={t('The project has {n} {unit}. Deleting the project deletes its tasks too — archive the project or move them first.',
            {
              n: editingProject.total_tasks,
              unit: plural(editingProject.total_tasks, 'task', 'tasks'),
            },
          )}
          onSave={async (draft) => {
            await api.patch(`/projects/${editingProject.id}`, {
              title: draft.name,
              color: draft.color,
            });
            await loadProjects();
          }}
          onArchive={async () => {
            await api.post(`/projects/${editingProject.id}/archive`, {});
            // The project moved to the other list — follow it, or the
            // screen keeps showing a selection that is no longer there
            setShowArchived(!editingProject.archived_at);
            setProjectId('');
            await loadProjects();
          }}
          onDelete={async () => {
            await api.delete(`/projects/${editingProject.id}`);
            await loadProjects();
            setProjectId('');
          }}
          onClose={() => setEditingProject(null)}
        />
      )}

      {selected && (
        <TaskDetail
          task={selected}
          members={members}
          onSaved={() => refresh()}
          onClose={() => setSelected(null)}
        />
      )}
    </Page>
  );
}
