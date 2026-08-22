import { create } from 'zustand';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// A single task. Field names mirror the Rust struct (src-tauri/src/todos.rs)
// so serde round-trips without per-field renames.
//
// Persistence lives entirely on the Rust side, in the app-data dir — NOT in
// the project folders (a shared repo would mean shared lists) and NOT in the
// install dir (an upgrade would wipe them). See todos.rs for the rationale.
export interface Todo {
  id: string;
  /** Registry path of the owning project; '' = Inbox (no project). */
  project_path: string;
  text: string;
  done: boolean;
  priority: boolean;
  created_ms: number;
  /** Last edit to the task itself. Drag-reordering doesn't bump it. */
  updated_ms: number;
  done_ms: number | null;
  order: number;
}

/** Sentinel project_path for tasks not attached to any project. */
export const INBOX = '';

interface TodoState {
  todos: Todo[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (projectPath: string, text: string) => Promise<void>;
  toggle: (id: string) => Promise<void>;
  setText: (id: string, text: string) => Promise<void>;
  togglePriority: (id: string) => Promise<void>;
  move: (id: string, projectPath: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  clearDone: (projectPath: string | null) => Promise<void>;
}

// Every mutation writes through to disk immediately, then updates local
// state. The dataset is tiny (a full rewrite is a sub-millisecond file
// write), so there's no debounce or dirty-tracking to get wrong — what you
// see on screen is always what's on disk.
async function persist(todo: Todo): Promise<void> {
  await invoke('todo_save', { todo });
}

export const useTodoStore = create<TodoState>((set, get) => ({
  todos: [],
  loaded: false,

  load: async () => {
    try {
      const todos = await invoke<Todo[]>('todos_get_all');
      set({ todos, loaded: true });
    } catch (e) {
      console.error('[todoStore] load failed:', e);
      set({ loaded: true });
    }
  },

  add: async (projectPath, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // New tasks land at the top of their project's open list: `order` is one
    // below the current minimum, so no other row needs rewriting.
    const siblings = get().todos.filter((t) => t.project_path === projectPath);
    const minOrder = siblings.length ? Math.min(...siblings.map((t) => t.order)) : 0;
    const todo: Todo = {
      id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      project_path: projectPath,
      text: trimmed,
      done: false,
      priority: false,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      done_ms: null,
      order: minOrder - 1,
    };
    set({ todos: [...get().todos, todo] });
    try {
      await persist(todo);
    } catch (e) {
      console.error('[todoStore] add failed:', e);
      set({ todos: get().todos.filter((t) => t.id !== todo.id) });
    }
  },

  toggle: async (id) => {
    const current = get().todos.find((t) => t.id === id);
    if (!current) return;
    const next: Todo = {
      ...current,
      done: !current.done,
      done_ms: current.done ? null : Date.now(),
      updated_ms: Date.now(),
    };
    set({ todos: get().todos.map((t) => (t.id === id ? next : t)) });
    try {
      await persist(next);
    } catch (e) {
      console.error('[todoStore] toggle failed:', e);
    }
  },

  setText: async (id, text) => {
    const current = get().todos.find((t) => t.id === id);
    const trimmed = text.trim();
    // An emptied field is treated as "no change" rather than as a delete —
    // deleting is an explicit action, never an accidental side effect of
    // clearing an input.
    if (!current || !trimmed || trimmed === current.text) return;
    const next: Todo = { ...current, text: trimmed, updated_ms: Date.now() };
    set({ todos: get().todos.map((t) => (t.id === id ? next : t)) });
    try {
      await persist(next);
    } catch (e) {
      console.error('[todoStore] rename failed:', e);
    }
  },

  togglePriority: async (id) => {
    const current = get().todos.find((t) => t.id === id);
    if (!current) return;
    const next: Todo = { ...current, priority: !current.priority, updated_ms: Date.now() };
    set({ todos: get().todos.map((t) => (t.id === id ? next : t)) });
    try {
      await persist(next);
    } catch (e) {
      console.error('[todoStore] priority failed:', e);
    }
  },

  move: async (id, projectPath) => {
    const current = get().todos.find((t) => t.id === id);
    if (!current || current.project_path === projectPath) return;
    const siblings = get().todos.filter((t) => t.project_path === projectPath);
    const minOrder = siblings.length ? Math.min(...siblings.map((t) => t.order)) : 0;
    const next: Todo = {
      ...current,
      project_path: projectPath,
      order: minOrder - 1,
      updated_ms: Date.now(),
    };
    set({ todos: get().todos.map((t) => (t.id === id ? next : t)) });
    try {
      await persist(next);
    } catch (e) {
      console.error('[todoStore] move failed:', e);
    }
  },

  remove: async (id) => {
    const before = get().todos;
    set({ todos: before.filter((t) => t.id !== id) });
    try {
      await invoke('todo_delete', { id });
    } catch (e) {
      console.error('[todoStore] delete failed:', e);
      set({ todos: before });
    }
  },

  reorder: async (ids) => {
    // Local state mirrors what the backend is about to write: position in
    // `ids` becomes the new `order`.
    const rank = new Map(ids.map((id, i) => [id, i]));
    set({
      todos: get().todos.map((t) => (rank.has(t.id) ? { ...t, order: rank.get(t.id)! } : t)),
    });
    try {
      await invoke('todos_reorder', { ids });
    } catch (e) {
      console.error('[todoStore] reorder failed:', e);
    }
  },

  clearDone: async (projectPath) => {
    const before = get().todos;
    set({
      todos: before.filter(
        (t) => !(t.done && (projectPath === null || t.project_path === projectPath))
      ),
    });
    try {
      await invoke('todos_clear_done', { projectPath });
    } catch (e) {
      console.error('[todoStore] clearDone failed:', e);
      set({ todos: before });
    }
  },
}));

/** Loads the list once per app session. Safe to call from several components. */
export function useTodos(): void {
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
}

/**
 * How the list is ordered.
 *   'manual'  — grouped by project, hand-ordered inside each (drag to sort)
 *   'created' — newest task first, groups flattened
 *   'updated' — most recently touched first, groups flattened
 */
export type SortMode = 'manual' | 'created' | 'updated';

/**
 * Open tasks first (priority-flagged on top, then manual order), completed
 * ones last and most-recently-finished first — so ticking something off
 * moves it straight to the top of the done pile.
 *
 * The date modes ignore the priority flag on purpose: asking for "newest
 * first" and getting flagged items pinned above them isn't newest first.
 */
export function sortTodos(todos: Todo[], mode: SortMode = 'manual'): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.done_ms ?? 0) - (a.done_ms ?? 0);
    if (mode === 'created') return b.created_ms - a.created_ms;
    if (mode === 'updated') return b.updated_ms - a.updated_ms;
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return a.order - b.order;
  });
}

/**
 * Compact stamp for the right of a task row: time for today, weekday for the
 * last week, then day+month, plus the year once it's not the current one.
 * Long enough to be unambiguous, short enough not to crowd the task text.
 */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days >= 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' }),
  });
}
