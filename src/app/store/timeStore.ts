import { create } from 'zustand';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// One "work session" on a single project. start_ms is fixed at toggle-on,
// end_ms is checkpointed every minute while running and finalized on stop.
// Field names mirror the Rust struct so serde round-trips cleanly without
// per-field rename.
export interface TimeEntry {
  id: string;
  project_path: string;
  start_ms: number;
  end_ms: number;
  running: boolean;
}

// Cadences. Checkpointing trades a tiny bit of disk I/O for crash safety —
// at worst, an uncleanly-killed app loses ~60s of the in-progress entry.
// Idle check is just a comparison, runs cheaply at 30s. The idle THRESHOLD
// itself (how long no-activity before auto-stop) is user-configurable —
// lives in `settings.idle_threshold_ms`, default 15 min.
const CHECKPOINT_MS = 60_000;
const IDLE_CHECK_MS = 30_000;
const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60_000;

export interface TimeSettings {
  idle_threshold_ms: number;
  idle_sound: boolean;
}

// Short pleasant "ding" — Web Audio API, no asset to ship. Sine wave (no
// harsh harmonics), brief, with a smooth attack/release envelope so it
// fades cleanly instead of clicking on stop.
function playIdleBeep(): void {
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880; // A5
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
    osc.onended = () => ctx.close();
  } catch (e) {
    console.warn('[timeStore] idle beep failed:', e);
  }
}

interface TimeState {
  entries: TimeEntry[];
  // projectPath → entryId for the currently running entry on that project.
  // Source of truth for "is this project being tracked right now?".
  running: Record<string, string>;
  // Epoch ms of the most recent user activity (key/mouse) seen on the app
  // window. Used by idleCheckTick to auto-stop after settings.idle_threshold_ms.
  lastActivity: number;
  loaded: boolean;
  settings: TimeSettings;

  load: () => Promise<void>;
  toggle: (projectPath: string) => void;
  start: (projectPath: string) => void;
  startAt: (projectPath: string, startMs: number) => void;
  stop: (projectPath: string) => void;
  stopAll: (opts?: { silent?: boolean }) => void;
  addManualEntry: (e: { projectPath: string; startMs: number; endMs: number }) => Promise<void>;
  updateEntry: (entry: TimeEntry) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  registerActivity: () => void;
  checkpointTick: () => void;
  idleCheckTick: () => void;
  updateSettings: (patch: Partial<TimeSettings>) => Promise<void>;
}

function genId(): string {
  return `time-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useTimeStore = create<TimeState>((set, get) => ({
  entries: [],
  running: {},
  lastActivity: Date.now(),
  loaded: false,
  settings: { idle_threshold_ms: DEFAULT_IDLE_THRESHOLD_MS, idle_sound: true },

  load: async () => {
    if (get().loaded) return;
    try {
      // Rust finalizes any leftover running=true on read, so our in-memory
      // `running` map correctly starts empty after a fresh launch. Settings
      // load in parallel — they're independent files on disk.
      const [entries, settings] = await Promise.all([
        invoke<TimeEntry[]>('time_entries_get_all'),
        invoke<TimeSettings>('time_settings_get'),
      ]);
      set({ entries, running: {}, loaded: true, lastActivity: Date.now(), settings });
    } catch (e) {
      console.error('[timeStore] load failed:', e);
      set({ loaded: true });
    }
  },

  toggle: (projectPath) => {
    if (get().running[projectPath]) get().stop(projectPath);
    else get().start(projectPath);
  },

  start: (projectPath) => {
    if (get().running[projectPath]) return;
    const now = Date.now();
    const entry: TimeEntry = {
      id: genId(),
      project_path: projectPath,
      start_ms: now,
      end_ms: now,
      running: true,
    };
    set((s) => ({
      entries: [...s.entries, entry],
      running: { ...s.running, [projectPath]: entry.id },
      lastActivity: now,
    }));
    invoke('time_entry_save', { entry }).catch((e) =>
      console.error('[timeStore] save (start) failed:', e),
    );
  },

  // Like `start`, but the session begins at a user-chosen past instant —
  // for "I forgot to start the chrono, I actually began at 8:00". The entry
  // is created already running and keeps counting live until stop, exactly
  // like a normal start. start_ms is clamped to now (no future starts).
  startAt: (projectPath, startMs) => {
    if (get().running[projectPath]) return;
    const now = Date.now();
    const start = Math.min(startMs, now);
    const entry: TimeEntry = {
      id: genId(),
      project_path: projectPath,
      start_ms: start,
      end_ms: now,
      running: true,
    };
    set((s) => ({
      entries: [...s.entries, entry],
      running: { ...s.running, [projectPath]: entry.id },
      lastActivity: now,
    }));
    invoke('time_entry_save', { entry }).catch((e) =>
      console.error('[timeStore] save (startAt) failed:', e),
    );
  },

  stop: (projectPath) => {
    const id = get().running[projectPath];
    if (!id) return;
    const now = Date.now();
    let updated: TimeEntry | null = null;
    const entries = get().entries.map((e) => {
      if (e.id === id) {
        updated = { ...e, end_ms: now, running: false };
        return updated;
      }
      return e;
    });
    const { [projectPath]: _gone, ...rest } = get().running;
    set({ entries, running: rest });
    if (updated) {
      invoke('time_entry_save', { entry: updated }).catch((e) =>
        console.error('[timeStore] save (stop) failed:', e),
      );
    }
  },

  stopAll: () => {
    Object.keys(get().running).forEach((p) => get().stop(p));
  },

  addManualEntry: async ({ projectPath, startMs, endMs }) => {
    // Manual / corrective entry — not running, fully bounded. Used by the
    // "Add Record" modal and any future import path.
    const entry: TimeEntry = {
      id: genId(),
      project_path: projectPath,
      start_ms: startMs,
      end_ms: endMs,
      running: false,
    };
    set((s) => ({ entries: [...s.entries, entry] }));
    try {
      await invoke('time_entry_save', { entry });
    } catch (e) {
      console.error('[timeStore] addManualEntry failed:', e);
    }
  },

  updateEntry: async (entry) => {
    set((s) => ({ entries: s.entries.map((e) => (e.id === entry.id ? entry : e)) }));
    try {
      await invoke('time_entry_save', { entry });
    } catch (e) {
      console.error('[timeStore] update failed:', e);
    }
  },

  deleteEntry: async (id) => {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    try {
      await invoke('time_entry_delete', { id });
    } catch (e) {
      console.error('[timeStore] delete failed:', e);
    }
  },

  registerActivity: () => {
    set({ lastActivity: Date.now() });
  },

  checkpointTick: () => {
    const { running, entries } = get();
    if (Object.keys(running).length === 0) return;
    const now = Date.now();
    const updated: TimeEntry[] = [];
    const next = entries.map((e) => {
      if (e.running && running[e.project_path] === e.id) {
        const n = { ...e, end_ms: now };
        updated.push(n);
        return n;
      }
      return e;
    });
    set({ entries: next });
    updated.forEach((entry) => {
      invoke('time_entry_save', { entry }).catch((e) =>
        console.error('[timeStore] checkpoint failed:', e),
      );
    });
  },

  idleCheckTick: () => {
    const { lastActivity, running, settings } = get();
    if (Object.keys(running).length === 0) return;
    if (Date.now() - lastActivity >= settings.idle_threshold_ms) {
      get().stopAll();
      // Only ding when the auto-stop actually triggered — manual stops via
      // the toggle buttons must stay silent.
      if (settings.idle_sound) playIdleBeep();
    }
  },

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    try {
      await invoke('time_settings_save', { settings: next });
    } catch (e) {
      console.error('[timeStore] updateSettings failed:', e);
    }
  },
}));

// ── Display helpers ────────────────────────────────────────────────────────

// Ongoing entries grow toward `now`; finalized ones use their own end_ms.
export function entryDurationMs(e: TimeEntry, now = Date.now()): number {
  return (e.running ? now : e.end_ms) - e.start_ms;
}

// Minutes-only format (user choice). <60min → "42m", ≥60min → "2h07".
export function formatMinutes(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m.toString().padStart(2, '0')}`;
}

// Force a periodic re-render so live durations refresh in the UI. Components
// call this and re-render every `intervalMs`. Default 30s is plenty for a
// minute-granularity display.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(i);
  }, [intervalMs]);
  return now;
}

// ── App-level wiring ───────────────────────────────────────────────────────
// Mount once at the app root. Attaches activity listeners + drives the two
// timer ticks. Idempotent: re-running it tears down and re-attaches cleanly.

export function useTimeTracker() {
  const load = useTimeStore((s) => s.load);
  const registerActivity = useTimeStore((s) => s.registerActivity);
  const checkpointTick = useTimeStore((s) => s.checkpointTick);
  const idleCheckTick = useTimeStore((s) => s.idleCheckTick);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Throttle: registerActivity is called on every mousemove → at 60 Hz
    // that's a flood of state writes the rest of the app subscribes to.
    // 1s resolution is plenty for a 5-minute idle threshold.
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      registerActivity();
    };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));

    // Cross-origin iframes (BrowserTab) swallow keyboard events — they never
    // bubble to our window. While focus is in one of those iframes the user
    // looks idle to us. Catch this by polling document.activeElement: if it's
    // one of our iframe elements, count that as activity.
    const iframeFocusTick = setInterval(() => {
      const ae = document.activeElement;
      if (ae && ae.tagName === 'IFRAME') onActivity();
    }, 2000);

    const checkpointInterval = setInterval(() => checkpointTick(), CHECKPOINT_MS);
    const idleInterval = setInterval(() => idleCheckTick(), IDLE_CHECK_MS);

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity, { capture: true } as EventListenerOptions));
      clearInterval(iframeFocusTick);
      clearInterval(checkpointInterval);
      clearInterval(idleInterval);
    };
  }, [registerActivity, checkpointTick, idleCheckTick]);
}
