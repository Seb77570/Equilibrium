import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { disposeTerminalEntry } from '@/lib/terminalRegistry';

// When persisting a tab for the next launch, a Claude terminal must come back
// RESUMING its conversation, not trying to claim a fresh session id. A "new
// conversation" tab was spawned with `--session-id <uuid>`; re-running that on
// restore would collide with the now-existing transcript. Rewriting it to
// `--resume <uuid>` makes the restored tab reload the exact conversation.
// (`--resume <id>` tabs already resume and pass through unchanged.)
const toRestorableTab = (tab: TabConfig): TabConfig => {
  if (tab.type !== 'terminal' || !tab.agentSessionId || !tab.initialCommand) return tab;
  return { ...tab, initialCommand: tab.initialCommand.replace('--session-id', '--resume') };
};

// Kill the backend PTY and dispose the cached xterm instance for a tab.
// Browser tabs don't have either. Fire-and-forget on the IPC side.
const killTerminalIfNeeded = (tab: TabConfig | undefined) => {
  if (tab?.type === 'terminal') {
    invoke('kill_terminal', { id: tab.id }).catch((err) => {
      console.error('[workspaceStore] kill_terminal failed:', err);
    });
    disposeTerminalEntry(tab.id);
  }
};

export type TabType = 'terminal' | 'browser' | 'ai-dashboard';

export type TabColor = 'default' | 'green' | 'red' | 'pink' | 'blue' | 'orange' | 'purple' | 'cyan';

export interface TabConfig {
  id: string;
  type: 'terminal' | 'browser' | 'ai-dashboard';
  title: string;
  color?: TabColor;
  // Terminal specific
  shell?: string;
  cwd?: string;
  initialCommand?: string;
  // Claude Code specific. Set when this terminal runs a Claude session we
  // launched (via --session-id), so we can map the tab to its transcript
  // (~/.claude/projects/.../<agentSessionId>.jsonl) and track its status.
  agentSessionId?: string;
  agentEnv?: 'powershell' | 'wsl';
  // Browser specific
  url?: string;
}

export type LayoutDirection = 'horizontal' | 'vertical';

export type LayoutNode = 
  | { id: string; type: 'pane'; tabIds: string[]; activeTabId: string | null }
  | { id: string; type: 'split'; direction: LayoutDirection; children: LayoutNode[]; sizes: number[] };

export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  allTabs: Record<string, TabConfig>;
  metadata?: {
    projectPath?: string;
    defaultPort?: number;
  };
  // When set, this pane visually covers the whole workspace area. Other
  // panes stay mounted (terminals + listeners intact) but are hidden behind.
  fullscreenPaneId?: string | null;
  // Last pane the user interacted with (clicked or activated a tab in).
  // Drives keyboard shortcuts like Ctrl+Tab that need a "current pane"
  // context. Falls back to the first pane in the layout when missing.
  focusedPaneId?: string | null;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  addWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, newName: string) => void;
  setActiveWorkspace: (id: string) => void;
  
  addTab: (workspaceId: string, tab: TabConfig, paneId?: string) => void;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, newTitle: string) => void;
  setTabColor: (workspaceId: string, tabId: string, color: TabColor) => void;
  setActiveTab: (workspaceId: string, tabId: string, paneId: string) => void;
  
  setFocusedPane: (workspaceId: string, paneId: string) => void;
  // Cycle the active tab inside the currently-focused pane. direction +1 →
  // next tab, -1 → previous, wrapping. No-op if pane has 0 or 1 tab.
  cycleTabInFocusedPane: (workspaceId: string, direction: 1 | -1) => void;

  // Split management
  splitPane: (workspaceId: string, paneId: string, tabId: string, direction: LayoutDirection, side: 'before' | 'after') => void;
  moveTab: (workspaceId: string, tabId: string, targetPaneId: string, position?: number) => void;
  updateLayout: (workspaceId: string, layout: LayoutNode) => void;
  toggleFullscreenPane: (workspaceId: string, paneId: string) => void;
  // Remove a tab from this window's layout WITHOUT killing its PTY — the
  // tab is being moved into a separate detached window which will reconnect
  // to the same backend session via spawn_terminal's reconnect path.
  detachTab: (workspaceId: string, tabId: string) => void;

  // View management
  activeView: string;
  setActiveView: (view: string) => void;

  // Project status tracking
  projectStatuses: Record<string, boolean>;
  setProjectStatus: (path: string, active: boolean) => void;

  // Claude agent status, keyed by agentSessionId: 'working' while the session
  // is generating, 'idle' otherwise. Driven by PTY output activity.
  agentStatus: Record<string, 'working' | 'idle'>;
  setAgentStatus: (sessionId: string, status: 'working' | 'idle') => void;

  // "Unread" flag, keyed by agentSessionId: set true when a session finishes
  // generating (like a pending notification), cleared when the user interacts
  // with that conversation (types, clicks, or switches to it).
  agentUnread: Record<string, boolean>;
  setAgentUnread: (sessionId: string, unread: boolean) => void;
}

// Helper to find a pane and its parent in the layout tree
const findPane = (node: LayoutNode, paneId: string): { pane: any; parent: any; index: number } | null => {
  if (node.type === 'pane') {
    return node.id === paneId ? { pane: node, parent: null, index: -1 } : null;
  }
  
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'pane' && child.id === paneId) {
      return { pane: child, parent: node, index: i };
    }
    const result = findPane(child, paneId);
    if (result) return result;
  }
  return null;
};

// Helper to find the first leaf pane in a layout (DFS).
const findFirstPane = (node: LayoutNode): { id: string; tabIds: string[]; activeTabId: string | null } | null => {
  if (node.type === 'pane') return node;
  for (const child of node.children) {
    const r = findFirstPane(child);
    if (r) return r;
  }
  return null;
};

// Helper to find which pane contains a tab
const findPaneByTab = (node: LayoutNode, tabId: string): any | null => {
  if (node.type === 'pane') {
    return node.tabIds.includes(tabId) ? node : null;
  }
  for (const child of node.children) {
    const result = findPaneByTab(child, tabId);
    if (result) return result;
  }
  return null;
};

// Helper to remove a tab from any pane it might be in
const removeTabFromLayout = (node: LayoutNode, tabId: string): boolean => {
  if (node.type === 'pane') {
    if (node.tabIds.includes(tabId)) {
      node.tabIds = node.tabIds.filter(id => id !== tabId);
      if (node.activeTabId === tabId) {
        node.activeTabId = node.tabIds[0] || null;
      }
      return true;
    }
    return false;
  }
  for (const child of node.children) {
    if (removeTabFromLayout(child, tabId)) return true;
  }
  return false;
};

// Compact the layout tree:
// - drop empty panes from splits
// - if a split ends up with one child, replace it with that child
// - re-normalize sizes when children are removed
// Returns the compacted node (or null if it should be removed entirely).
const compactLayout = (node: LayoutNode): LayoutNode | null => {
  if (node.type === 'pane') {
    return node.tabIds.length === 0 ? null : node;
  }

  const compactedChildren: LayoutNode[] = [];
  const keptIndices: number[] = [];
  node.children.forEach((child, i) => {
    const c = compactLayout(child);
    if (c) {
      compactedChildren.push(c);
      keptIndices.push(i);
    }
  });

  if (compactedChildren.length === 0) return null;
  if (compactedChildren.length === 1) return compactedChildren[0];

  const oldSizes = node.sizes ?? compactedChildren.map(() => 100 / compactedChildren.length);
  const keptSizes = keptIndices.map(i => oldSizes[i] ?? 100 / compactedChildren.length);
  const total = keptSizes.reduce((s, v) => s + v, 0) || 1;
  const normalized = keptSizes.map(s => (s / total) * 100);

  return { ...node, children: compactedChildren, sizes: normalized };
};

// Make sure the workspace always has at least one pane at the root.
const ensureRoot = (node: LayoutNode | null): LayoutNode => {
  if (node) return node;
  return { id: `pane-${Date.now()}`, type: 'pane', tabIds: [], activeTabId: null };
};

export const useWorkspaceStore = create<WorkspaceState>()(persist((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  addWorkspace: (workspace) => set((state) => ({
    workspaces: [...state.workspaces, workspace],
    activeWorkspaceId: workspace.id,
  })),

  removeWorkspace: (id) => {
    // Kill every terminal PTY in this workspace before dropping it from state,
    // otherwise the dev server (and its grandchildren like `node`) keeps the
    // port open and the dashboard still shows the project as active.
    const workspace = get().workspaces.find(w => w.id === id);
    if (workspace) {
      Object.values(workspace.allTabs).forEach(killTerminalIfNeeded);
    }
    set((state) => {
      const newWorkspaces = state.workspaces.filter(w => w.id !== id);
      return {
        workspaces: newWorkspaces,
        activeWorkspaceId: state.activeWorkspaceId === id
          ? (newWorkspaces[0]?.id || null)
          : state.activeWorkspaceId
      };
    });
  },

  renameWorkspace: (id, newName) => set((state) => ({
    workspaces: state.workspaces.map(w => w.id === id ? { ...w, name: newName } : w)
  })),

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  addTab: (workspaceId, tab, paneId) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      
      const newAllTabs = { ...w.allTabs, [tab.id]: tab };
      const newLayout = JSON.parse(JSON.stringify(w.layout));
      
      // If paneId is provided, add to that pane. Otherwise find any pane or create root.
      const targetPane = paneId ? findPane(newLayout, paneId)?.pane : null;
      
      if (targetPane && targetPane.type === 'pane') {
        targetPane.tabIds.push(tab.id);
        targetPane.activeTabId = tab.id;
      } else {
        // Find first pane or just use the root if it's a pane
        const firstPane = (function findFirst(n: LayoutNode): any {
          if (n.type === 'pane') return n;
          return findFirst(n.children[0]);
        })(newLayout);
        
        firstPane.tabIds.push(tab.id);
        firstPane.activeTabId = tab.id;
      }

      return { ...w, allTabs: newAllTabs, layout: newLayout };
    }),
  })),

  removeTab: (workspaceId, tabId) => {
    const tab = get().workspaces.find(w => w.id === workspaceId)?.allTabs[tabId];
    killTerminalIfNeeded(tab);
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const newLayout = JSON.parse(JSON.stringify(w.layout));
        removeTabFromLayout(newLayout, tabId);
        const newAllTabs = { ...w.allTabs };
        delete newAllTabs[tabId];
        return { ...w, layout: ensureRoot(compactLayout(newLayout)), allTabs: newAllTabs };
      }),
    }));
  },

  renameTab: (workspaceId, tabId, newTitle) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      return {
        ...w,
        allTabs: {
          ...w.allTabs,
          [tabId]: { ...w.allTabs[tabId], title: newTitle },
        },
      };
    }),
  })),

  setTabColor: (workspaceId, tabId, color) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      return {
        ...w,
        allTabs: {
          ...w.allTabs,
          [tabId]: { ...w.allTabs[tabId], color },
        },
      };
    }),
  })),

  setActiveTab: (workspaceId, tabId, paneId) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const newLayout = JSON.parse(JSON.stringify(w.layout));
      const target = findPane(newLayout, paneId);
      if (target && target.pane.type === 'pane') {
        target.pane.activeTabId = tabId;
      }
      return { ...w, layout: newLayout, focusedPaneId: paneId };
    }),
  })),

  setFocusedPane: (workspaceId, paneId) => set((state) => ({
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, focusedPaneId: paneId } : w,
    ),
  })),

  cycleTabInFocusedPane: (workspaceId, direction) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      // Resolve the target pane: explicit focused one, or the first pane in
      // the layout as fallback (layouts always have ≥1 pane after compact).
      let paneId = w.focusedPaneId ?? null;
      let target = paneId ? findPane(w.layout, paneId) : null;
      if (!target) {
        const firstPane = findFirstPane(w.layout);
        if (!firstPane) return w;
        paneId = firstPane.id;
        target = findPane(w.layout, paneId);
      }
      if (!target || target.pane.type !== 'pane') return w;
      const tabs = target.pane.tabIds as string[];
      if (tabs.length < 2) return w;
      const currentIdx = Math.max(0, tabs.indexOf(target.pane.activeTabId));
      const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
      const nextTabId = tabs[nextIdx];
      const newLayout = JSON.parse(JSON.stringify(w.layout));
      const t = findPane(newLayout, paneId!);
      if (t && t.pane.type === 'pane') t.pane.activeTabId = nextTabId;
      return { ...w, layout: newLayout, focusedPaneId: paneId };
    }),
  })),

  splitPane: (workspaceId, paneId, tabId, direction, side) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;

      // Reject no-op: dragging the only tab of a single-tab pane onto its own
      // edge would just create an empty source pane that gets cleaned up,
      // which looks like nothing happened.
      const sourcePane = findPaneByTab(w.layout, tabId);
      if (sourcePane && sourcePane.id === paneId && sourcePane.tabIds.length === 1) {
        return w;
      }

      const newLayout = JSON.parse(JSON.stringify(w.layout));
      const target = findPane(newLayout, paneId);
      if (!target) return w;

      const { pane, parent, index } = target;
      const stamp = Date.now();
      const newPaneId = `pane-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
      const newPane: LayoutNode = { id: newPaneId, type: 'pane', tabIds: [tabId], activeTabId: tabId };

      // Remove tab from original location (after we captured target by id)
      removeTabFromLayout(newLayout, tabId);

      let nextLayout: LayoutNode;
      if (!parent) {
        // Splitting the root
        const children = side === 'before' ? [newPane, newLayout] : [newLayout, newPane];
        nextLayout = {
          id: `split-${stamp}`,
          type: 'split',
          direction,
          children,
          sizes: [50, 50]
        };
      } else {
        if (parent.direction === direction) {
          parent.children.splice(side === 'before' ? index : index + 1, 0, newPane);
          parent.sizes = parent.children.map(() => 100 / parent.children.length);
        } else {
          const oldPane = pane;
          const children = side === 'before' ? [newPane, oldPane] : [oldPane, newPane];
          parent.children[index] = {
            id: `split-${stamp}`,
            type: 'split',
            direction,
            children,
            sizes: [50, 50]
          };
        }
        nextLayout = newLayout;
      }

      return { ...w, layout: ensureRoot(compactLayout(nextLayout)) };
    }),
  })),

  moveTab: (workspaceId, tabId, targetPaneId) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;

      const newLayout = JSON.parse(JSON.stringify(w.layout));

      // Remove from old
      removeTabFromLayout(newLayout, tabId);

      // Add to new
      const target = findPane(newLayout, targetPaneId);
      if (target && target.pane.type === 'pane') {
        target.pane.tabIds.push(tabId);
        target.pane.activeTabId = tabId;
      }

      return { ...w, layout: ensureRoot(compactLayout(newLayout)) };
    }),
  })),

  updateLayout: (workspaceId, layout) => set((state) => ({
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, layout } : w
    ),
  })),

  toggleFullscreenPane: (workspaceId, paneId) => set((state) => ({
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, fullscreenPaneId: w.fullscreenPaneId === paneId ? null : paneId }
        : w
    ),
  })),

  detachTab: (workspaceId, tabId) => set((state) => ({
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const newLayout = JSON.parse(JSON.stringify(w.layout));
      removeTabFromLayout(newLayout, tabId);
      const newAllTabs = { ...w.allTabs };
      delete newAllTabs[tabId];
      return { ...w, layout: ensureRoot(compactLayout(newLayout)), allTabs: newAllTabs };
    }),
  })),

  projectStatuses: {},
  setProjectStatus: (path, active) => set((state) => ({
    projectStatuses: { ...state.projectStatuses, [path]: active }
  })),

  agentStatus: {},
  setAgentStatus: (sessionId, status) => set((state) => {
    // Return the SAME state ref when unchanged. Returning {} would still make
    // Zustand build a new state object and notify every subscriber (e.g. the
    // Sidebar) — re-rendering on each PTY chunk / keystroke and causing lag.
    if (state.agentStatus[sessionId] === status) return state;
    return { agentStatus: { ...state.agentStatus, [sessionId]: status } };
  }),

  agentUnread: {},
  setAgentUnread: (sessionId, unread) => set((state) => {
    if (!!state.agentUnread[sessionId] === unread) return state; // true no-op
    const next = { ...state.agentUnread };
    if (unread) next[sessionId] = true; else delete next[sessionId];
    return { agentUnread: next };
  }),

  activeView: 'dashboard',
  setActiveView: (view) => set({ activeView: view }),
}), {
  // ── Session persistence ────────────────────────────────────────────────
  // Saves the open workspaces, their split layout, every tab (type, title,
  // COLOR, shell, and Claude agentSessionId) and the active view to
  // localStorage, so closing the app or rebooting restores the exact set of
  // projects + conversations + tab colors on next launch. Live, non-restorable
  // runtime state (PTY status, unread flags, project running-status) is
  // deliberately excluded — it's rebuilt from scratch as terminals re-spawn.
  name: 'equilibrium-workspace-session',
  version: 1,
  // File-backed via Rust, NOT localStorage. localStorage is scoped to the
  // page origin INCLUDING the port, and release builds serve the UI from
  // http://localhost:<random port> — a different (empty) storage bucket on
  // every launch, which is why session restore silently never worked in
  // installed builds. The session JSON now lives in the app-data dir next to
  // the rest of the config. getItem falls back to localStorage once so an
  // existing dev session migrates instead of vanishing.
  // SSR/build-safe: Next.js prerenders this in Node where window/invoke are
  // undefined — a no-op store is used there; the real one runs in the webview.
  storage: createJSONStorage(() =>
    typeof window !== 'undefined'
      ? {
          getItem: async (name: string): Promise<string | null> => {
            try {
              const fromFile = await invoke<string | null>('session_load');
              if (fromFile) return fromFile;
            } catch (e) {
              console.error('[workspaceStore] session_load failed:', e);
            }
            // One-time migration path from the pre-file localStorage era.
            return window.localStorage.getItem(name);
          },
          setItem: async (_name: string, value: string): Promise<void> => {
            try {
              await invoke('session_save', { value });
            } catch (e) {
              console.error('[workspaceStore] session_save failed:', e);
            }
          },
          removeItem: async (_name: string): Promise<void> => {
            try {
              await invoke('session_save', { value: '' });
            } catch (e) {
              console.error('[workspaceStore] session clear failed:', e);
            }
          },
        }
      : { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
  ),
  partialize: (state) => ({
    workspaces: state.workspaces.map((w) => ({
      ...w,
      fullscreenPaneId: null, // never restore stuck in fullscreen
      allTabs: Object.fromEntries(
        Object.entries(w.allTabs).map(([id, tab]) => [id, toRestorableTab(tab)])
      ),
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    activeView: state.activeView,
  }),
}));
