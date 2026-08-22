'use client';

import { useMemo, useState } from 'react';
import { ListTodo, Plus, Check, Flag, Trash2, X } from 'lucide-react';
import { useTodoStore, useTodos, sortTodos } from '@/app/store/todoStore';

// Retractable to-do overlay, pinned to the right edge of the workspace next
// to the file explorer. Deliberately a reduced version of the full To Do
// view: tick, add, flag, delete — the things you reach for without leaving
// your terminal. Reordering, moving between projects and the cross-project
// view stay in the To Do tab.
//
// It reads and writes the same store as that tab, so a box ticked here is
// already ticked there (and on disk) before the panel closes.
export default function WorkspaceTodo({
  projectPath,
  onClose,
}: {
  projectPath: string;
  onClose: () => void;
}) {
  useTodos();
  const todos = useTodoStore((s) => s.todos);
  const { add, toggle, togglePriority, remove } = useTodoStore();
  const [draft, setDraft] = useState('');
  const [showDone, setShowDone] = useState(false);

  const mine = useMemo(
    () => sortTodos(todos.filter((t) => t.project_path === projectPath)),
    [todos, projectPath]
  );
  const open = mine.filter((t) => !t.done);
  const done = mine.filter((t) => t.done);

  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';

  const submit = () => {
    if (!draft.trim()) return;
    void add(projectPath, draft);
    setDraft('');
  };

  return (
    <div className="absolute top-0 right-0 h-full w-72 z-[200] bg-[#141519] border-l border-white/10 shadow-2xl flex flex-col">
      {/* pr-10 keeps the header controls clear of the app's fullscreen toggle,
          which is pinned to the window corner at z-[400] and would otherwise
          sit on top of the close button. Same clearance as FileExplorer. */}
      <div className="flex items-center justify-between pl-3 pr-10 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ListTodo size={13} className="text-brand shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60 truncate">
            {projectName}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {done.length > 0 && (
            <button
              onClick={() => setShowDone((v) => !v)}
              title={showDone ? 'Hide completed' : `Show ${done.length} completed`}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums transition-colors ${
                showDone ? 'text-white/70 bg-white/10' : 'text-white/30 hover:text-white/60'
              }`}
            >
              ✓ {done.length}
            </button>
          )}
          <button onClick={onClose} title="Close" className="p-1 text-white/30 hover:text-white rounded">
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="px-2 py-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 bg-white/[0.03] border border-white/5 rounded-md px-2 py-1.5 focus-within:border-brand/40 transition-colors">
          <Plus size={12} className="text-white/25 shrink-0" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setDraft('');
            }}
            placeholder="Add a task…"
            className="flex-1 bg-transparent text-[11px] text-white/80 placeholder:text-white/20 outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {open.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-white/25 italic">
            {done.length > 0 ? 'All done here.' : 'No tasks for this project.'}
          </div>
        )}

        {open.map((t) => (
          <PanelRow
            key={t.id}
            text={t.text}
            done={false}
            priority={t.priority}
            onToggle={() => toggle(t.id)}
            onPriority={() => togglePriority(t.id)}
            onRemove={() => remove(t.id)}
          />
        ))}

        {showDone && done.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[9px] uppercase tracking-[0.18em] text-white/20 font-bold">
              Completed
            </div>
            {done.map((t) => (
              <PanelRow
                key={t.id}
                text={t.text}
                done
                priority={t.priority}
                onToggle={() => toggle(t.id)}
                onPriority={() => togglePriority(t.id)}
                onRemove={() => remove(t.id)}
              />
            ))}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-white/25 shrink-0">
        {open.length} open · full list in the To Do tab
      </div>
    </div>
  );
}

function PanelRow({
  text,
  done,
  priority,
  onToggle,
  onPriority,
  onRemove,
}: {
  text: string;
  done: boolean;
  priority: boolean;
  onToggle: () => void;
  onPriority: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-white/[0.03] transition-colors">
      <button
        onClick={onToggle}
        title={done ? 'Mark as not done' : 'Mark as done'}
        className={`w-[14px] h-[14px] mt-[2px] shrink-0 rounded border flex items-center justify-center transition-colors ${
          done
            ? 'bg-alive border-alive text-black'
            : 'border-white/25 hover:border-alive text-transparent hover:text-alive/40'
        }`}
      >
        <Check size={10} strokeWidth={3} />
      </button>

      <span
        className={`flex-1 text-[11px] leading-snug break-words ${
          done ? 'text-white/25 line-through' : 'text-white/75'
        }`}
      >
        {text}
      </span>

      <button
        onClick={onPriority}
        title={priority ? 'Remove flag' : 'Flag as important'}
        className={`shrink-0 mt-[2px] transition-opacity ${
          priority
            ? 'text-amber-400 opacity-100'
            : 'text-white/25 opacity-0 group-hover:opacity-100 hover:text-amber-400'
        }`}
      >
        <Flag size={11} fill={priority ? 'currentColor' : 'none'} />
      </button>

      <button
        onClick={onRemove}
        title="Delete task"
        className="shrink-0 mt-[2px] text-white/25 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
