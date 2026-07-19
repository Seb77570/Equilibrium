'use client';
import { useState, useRef, useEffect } from 'react';
import { useWorkspaceStore, Workspace, TabColor } from '@/app/store/workspaceStore';
import { X, Plus, Terminal, Globe, Maximize2, Minimize2, Sparkles } from 'lucide-react';
import TerminalTab from '../Terminal/TerminalTab';
import BrowserTab from '../Browser/BrowserTab';
import AiDashboard from './AiDashboard';

// Tailwind class sets per color × active-state. Inlined as a lookup so
// Tailwind's JIT scanner sees the literal class names at build time.
const TAB_COLOR_CLASSES: Record<Exclude<TabColor, 'default'>, { active: string; inactive: string }> = {
  green: {
    active:   'bg-emerald-600/45 text-emerald-50',
    inactive: 'bg-emerald-600/15 text-emerald-200/70 hover:text-emerald-50 hover:bg-emerald-600/25',
  },
  red: {
    active:   'bg-rose-600/45 text-rose-50',
    inactive: 'bg-rose-600/15 text-rose-200/70 hover:text-rose-50 hover:bg-rose-600/25',
  },
  pink: {
    active:   'bg-pink-400/45 text-pink-50',
    inactive: 'bg-pink-400/15 text-pink-100/70 hover:text-pink-50 hover:bg-pink-400/25',
  },
  blue: {
    active:   'bg-blue-600/45 text-blue-50',
    inactive: 'bg-blue-600/15 text-blue-200/70 hover:text-blue-50 hover:bg-blue-600/25',
  },
  orange: {
    active:   'bg-orange-500/45 text-orange-50',
    inactive: 'bg-orange-500/15 text-orange-100/70 hover:text-orange-50 hover:bg-orange-500/25',
  },
  purple: {
    active:   'bg-violet-600/45 text-violet-50',
    inactive: 'bg-violet-600/15 text-violet-200/70 hover:text-violet-50 hover:bg-violet-600/25',
  },
  cyan: {
    active:   'bg-cyan-500/45 text-cyan-50',
    inactive: 'bg-cyan-500/15 text-cyan-100/70 hover:text-cyan-50 hover:bg-cyan-500/25',
  },
};

const COLOR_SWATCHES: { value: TabColor; label: string; dot: string }[] = [
  { value: 'default', label: 'Default', dot: 'bg-white/20' },
  { value: 'green',   label: 'Green',   dot: 'bg-emerald-500' },
  { value: 'red',     label: 'Red',     dot: 'bg-rose-500' },
  { value: 'pink',    label: 'Pink',    dot: 'bg-pink-400' },
  { value: 'blue',    label: 'Blue',    dot: 'bg-blue-500' },
  { value: 'orange',  label: 'Orange',  dot: 'bg-orange-500' },
  { value: 'purple',  label: 'Purple',  dot: 'bg-violet-500' },
  { value: 'cyan',    label: 'Cyan',    dot: 'bg-cyan-500' },
];

// Tab detach (one tab → its own OS window) is intentionally NOT exposed in
// the UI. The Rust commands (`open_detached_window`, `get_detached_tab_data`,
// `reattach_tab`) and the DetachedTabView component remain in the codebase
// because the underlying machinery is sound — but Tauri 2 + WebView2 on
// Windows reproducibly creates a blank zombie window that survives the
// crashing webview process and can only be killed via Task Manager. We
// retried with both Tauri 2.0.0-rc.0 and the latest 2.x release; same
// result. Re-enable when this lands fixed upstream.

interface TabPaneProps {
  paneId: string;
  tabIds: string[];
  activeTabId: string | null;
  workspaceId: string;
  metadata?: Workspace['metadata'];
}

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center' | null;

export default function TabPane({ paneId, tabIds, activeTabId, workspaceId, metadata }: TabPaneProps) {
  const allTabs = useWorkspaceStore(s => s.workspaces.find(w => w.id === workspaceId)?.allTabs ?? {});
  const fullscreenPaneId = useWorkspaceStore(s => s.workspaces.find(w => w.id === workspaceId)?.fullscreenPaneId ?? null);
  const setActiveTab = useWorkspaceStore(s => s.setActiveTab);
  const setFocusedPane = useWorkspaceStore(s => s.setFocusedPane);
  const removeTab = useWorkspaceStore(s => s.removeTab);
  const renameTab = useWorkspaceStore(s => s.renameTab);
  const setTabColor = useWorkspaceStore(s => s.setTabColor);
  const splitPane = useWorkspaceStore(s => s.splitPane);
  const moveTab = useWorkspaceStore(s => s.moveTab);
  const addTab = useWorkspaceStore(s => s.addTab);
  const toggleFullscreenPane = useWorkspaceStore(s => s.toggleFullscreenPane);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [colorMenu, setColorMenu] = useState<{ tabId: string; top: number; left: number } | null>(null);

  const startRenaming = (tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditingTabName(currentName);
  };

  const commitRename = () => {
    if (editingTabId && editingTabName.trim()) {
      renameTab(workspaceId, editingTabId, editingTabName.trim());
    }
    setEditingTabId(null);
  };

  const isFullscreen = fullscreenPaneId === paneId;

  const [dropZone, setDropZone] = useState<DropZone>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // The overlay ref is toggled synchronously via direct DOM manipulation (not React state)
  // so pointer-events flip BEFORE any dragover events fire — no async React re-render needed.
  const overlayRef = useRef<HTMLDivElement>(null);

  const activeTab = activeTabId ? allTabs[activeTabId] : null;

  // ── Overlay activation via document dragstart/dragend ──────────────────────
  // Using direct DOM style mutation (not setState) so the toggle is instant.
  useEffect(() => {
    const show = () => {
      if (overlayRef.current) overlayRef.current.style.pointerEvents = 'auto';
    };
    const hide = () => {
      if (overlayRef.current) overlayRef.current.style.pointerEvents = 'none';
      setDropZone(null);
    };

    document.addEventListener('dragstart', show);
    document.addEventListener('dragend', hide);
    document.addEventListener('drop', hide);
    return () => {
      document.removeEventListener('dragstart', show);
      document.removeEventListener('dragend', hide);
      document.removeEventListener('drop', hide);
    };
  }, []);

  // ── Zone calculation ───────────────────────────────────────────────────────
  const calcZone = (e: React.DragEvent): DropZone => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const t = 0.25;
    if (x < r.width * t) return 'left';
    if (x > r.width * (1 - t)) return 'right';
    if (y < r.height * t) return 'top';
    if (y > r.height * (1 - t)) return 'bottom';
    return 'center';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropZone(calcZone(e));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData('text/plain');
    const zone = calcZone(e); // recalculate at drop point
    setDropZone(null);
    if (!tabId || !zone) return;

    if (zone === 'center')  moveTab(workspaceId, tabId, paneId);
    if (zone === 'left')    splitPane(workspaceId, paneId, tabId, 'horizontal', 'before');
    if (zone === 'right')   splitPane(workspaceId, paneId, tabId, 'horizontal', 'after');
    if (zone === 'top')     splitPane(workspaceId, paneId, tabId, 'vertical', 'before');
    if (zone === 'bottom')  splitPane(workspaceId, paneId, tabId, 'vertical', 'after');

    // If we just created a split while fullscreen was active, the new pane
    // would be hidden behind the overlay. Exit fullscreen so the user sees it.
    if (zone !== 'center' && isFullscreen) {
      toggleFullscreenPane(workspaceId, paneId);
    }
  };

  // ── Add tab ────────────────────────────────────────────────────────────────
  const handleAddTab = (type: 'terminal' | 'browser', shell?: string) => {
    const port = metadata?.defaultPort;
    addTab(workspaceId, {
      id: crypto.randomUUID(),
      type,
      title: type === 'browser' ? `Browser${port ? ` :${port}` : ''}` : (shell === 'wsl' ? 'WSL' : 'PowerShell'),
      shell,
      cwd: metadata?.projectPath,
      url: type === 'browser' ? (port ? `http://localhost:${port}` : 'http://localhost:3000') : undefined,
    }, paneId);
    setMenuPosition(null);
  };

  return (
    // Root uses h-full (not flex-1) so it fills the Panel's h-full wrapper from SplitLayout.
    // When fullscreen: position:absolute breaks out of the split's panel and covers the
    // whole workspace area (anchored to WorkspaceView's `relative` wrapper). The pane's
    // place inside SplitLayout still exists in the tree, just empty; other panes stay
    // mounted underneath the z-50 overlay.
    <div
      ref={containerRef}
      data-pane-id={paneId}
      // mousedown (capture) so we win the focus race vs xterm/iframe focus.
      onMouseDownCapture={() => setFocusedPane(workspaceId, paneId)}
      className={
        isFullscreen
          ? 'absolute inset-0 z-40 flex flex-col bg-[#0f1016]'
          : 'h-full w-full flex flex-col bg-[#0f1016] relative'
      }
      onDragOver={handleDragOver}
      onDragLeave={e => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) setDropZone(null);
      }}
      onDrop={handleDrop}
    >

      {/* ── Tab strip ─────────────────────────────────────────────────────
          Outer flex: tabs scroll horizontally on the left, fullscreen toggle
          stays pinned to the right (outside the scroll area). */}
      <div className="flex items-center bg-[#16161a] border-b border-white/5 h-9 shrink-0">
        <div className="flex items-center flex-1 min-w-0 overflow-x-auto">
          {tabIds.map(id => {
            const tab = allTabs[id];
            if (!tab) return null;
            const isActive = id === activeTabId;
            const isEditing = editingTabId === id;
            const color = tab.color && tab.color !== 'default' ? tab.color : null;
            const colorClasses = color
              ? (isActive ? TAB_COLOR_CLASSES[color].active : TAB_COLOR_CLASSES[color].inactive)
              : (isActive ? 'bg-[#0f1016] text-white' : 'text-white/40 hover:text-white/60 hover:bg-white/5');
            return (
              <div
                key={id}
                // Disable drag while renaming so the input can be focused/typed in.
                draggable={!isEditing}
                onDragStart={e => {
                  e.dataTransfer.setData('text/plain', id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => { if (!isEditing) setActiveTab(workspaceId, id, paneId); }}
                onDoubleClick={e => {
                  e.stopPropagation();
                  // Claude conversation tabs (and the AI dashboard) take their
                  // name from the conversation — not user-editable here.
                  if (!tab.agentSessionId && tab.type !== 'ai-dashboard') {
                    startRenaming(id, tab.title);
                  }
                }}
                onContextMenu={e => {
                  // Right-click → color picker. Native menu suppressed.
                  e.preventDefault();
                  e.stopPropagation();
                  setColorMenu({ tabId: id, top: e.clientY + 4, left: e.clientX });
                }}
                className={`
                  group/tab flex items-center gap-1.5 px-3 h-full border-r border-white/5
                  select-none shrink-0 transition-colors
                  ${isEditing ? 'cursor-text' : 'cursor-grab'}
                  ${colorClasses}
                `}
              >
                {tab.type === 'ai-dashboard' || tab.agentSessionId
                  ? <Sparkles size={13} />
                  : tab.type === 'terminal' ? <Terminal size={13} /> : <Globe size={13} />}
                {isEditing ? (
                  <input
                    autoFocus
                    type="text"
                    value={editingTabName}
                    onChange={e => setEditingTabName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') setEditingTabId(null);
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    className="bg-black/40 text-xs text-white px-1 outline-none border border-sky-500/50 rounded max-w-[140px]"
                  />
                ) : (
                  <span className="text-xs font-medium truncate max-w-[110px]">{tab.title}</span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); removeTab(workspaceId, id); }}
                  className="opacity-0 group-hover/tab:opacity-100 hover:text-red-400 p-0.5 rounded transition-all"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
          <button
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenuPosition({ top: r.bottom + 4, left: r.left });
            }}
            className="px-3 h-full text-white/20 hover:text-white hover:bg-white/5 transition-colors shrink-0"
          >
            <Plus size={14} />
          </button>
        </div>
        <button
          onClick={() => toggleFullscreenPane(workspaceId, paneId)}
          title={isFullscreen ? 'Exit fullscreen pane' : 'Fullscreen pane'}
          className="px-3 h-full text-white/20 hover:text-white hover:bg-white/5 border-l border-white/5 transition-colors shrink-0"
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      {/* ── Tab color picker (opens via right-click on a tab) ───────────── */}
      {colorMenu && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={() => setColorMenu(null)} />
          <div
            className="fixed bg-[#18181b] border border-white/10 shadow-2xl rounded-lg p-1.5 z-[200]"
            style={{ top: colorMenu.top, left: colorMenu.left }}
          >
            <div className="flex items-center gap-1">
              {COLOR_SWATCHES.map(({ value, label, dot }) => {
                const current = allTabs[colorMenu.tabId]?.color ?? 'default';
                const selected = current === value;
                return (
                  <button
                    key={value}
                    title={label}
                    onClick={() => {
                      setTabColor(workspaceId, colorMenu.tabId, value);
                      setColorMenu(null);
                    }}
                    className={`w-6 h-6 rounded-full ${dot} transition-all hover:scale-110 ${
                      selected ? 'ring-2 ring-white/80 ring-offset-1 ring-offset-[#18181b]' : 'ring-1 ring-white/10'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Add-tab menu ────────────────────────────────────────────────── */}
      {menuPosition && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={() => setMenuPosition(null)} />
          <div
            className="fixed w-44 bg-[#18181b] border border-white/10 shadow-2xl rounded-lg p-1.5 z-[200]"
            style={{ top: menuPosition.top, left: menuPosition.left }}
          >
            {[
              { label: 'PowerShell', action: () => handleAddTab('terminal', 'powershell.exe') },
              { label: 'WSL Linux',  action: () => handleAddTab('terminal', 'wsl') },
            ].map(({ label, action }) => (
              <button key={label} onClick={action}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-md text-xs text-white/60 hover:text-white transition-colors">
                <Terminal size={13} /> {label}
              </button>
            ))}
            <div className="my-1 border-t border-white/5" />
            <button onClick={() => handleAddTab('browser')}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-md text-xs text-white/60 hover:text-white transition-colors">
              <Globe size={13} />
              Browser
            </button>
          </div>
        </>
      )}

      {/* ── Content area ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* Browser tabs stay MOUNTED for every tab in the pane and are merely
            hidden (visibility, not display) when inactive. Unmounting a
            BrowserTab destroys its <iframe>, which on remount reloads the page
            and drops the Supabase session — the "it reloads every time I come
            back to the tab" symptom. Keeping the node alive (with its real
            dimensions, hence `visibility` rather than `display:none`) preserves
            the loaded page and login across tab switches. Stacked absolute and
            below the drag overlay (z-100). */}
        {tabIds.map(tid => {
          const tab = allTabs[tid];
          if (!tab || tab.type !== 'browser') return null;
          const isActive = tid === activeTabId;
          return (
            <div
              key={tid}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                zIndex: isActive ? 1 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <BrowserTab id={tab.id} initialUrl={tab.url} />
            </div>
          );
        })}

        {/* Terminals already persist their xterm + PTY via terminalRegistry,
            so they restore cleanly on remount — only the active one is rendered.
            key={id} keeps a distinct instance per tab id (no ref carryover). */}
        {activeTab && activeTab.type === 'terminal' && (
          <TerminalTab key={activeTab.id} id={activeTab.id} shell={activeTab.shell} cwd={activeTab.cwd} initialCommand={activeTab.initialCommand} agentSessionId={activeTab.agentSessionId} />
        )}

        {activeTab && activeTab.type === 'ai-dashboard' && (
          <div className="absolute inset-0">
            <AiDashboard
              key={activeTab.id}
              workspaceId={workspaceId}
              paneId={paneId}
              projectPath={activeTab.cwd || ''}
              env={activeTab.agentEnv === 'wsl' ? 'wsl' : 'powershell'}
            />
          </div>
        )}

        {!activeTab && (
          <div className="absolute inset-0 flex items-center justify-center text-white/10 text-xs uppercase tracking-widest">
            No active tab
          </div>
        )}

        {/* ── Drag capture overlay ──────────────────────────────────────────
            Always in the DOM but pointer-events:none by default.
            Switched to pointer-events:auto synchronously (via direct DOM ref)
            on document dragstart — BEFORE the first dragover fires.
            This intercepts drag events that would otherwise be absorbed
            by the xterm.js canvas or the iframe in BrowserTab.           */}
        <div
          ref={overlayRef}
          style={{ pointerEvents: 'none' }}
          className="absolute inset-0 z-[100]"
          onDragOver={handleDragOver}
          onDragLeave={e => {
            // Only clear when cursor truly leaves this container
            if (!containerRef.current?.contains(e.relatedTarget as Node)) setDropZone(null);
          }}
          onDrop={handleDrop}
        />
      </div>

      {/* ── Drop zone visual overlays ────────────────────────────────────── */}
      {dropZone && (
        <div className="absolute inset-0 z-[200] pointer-events-none">
          {dropZone === 'center' && (
            <div className="absolute inset-1 rounded border-2"
              style={{ background: 'rgba(14,165,233,.15)', borderColor: 'rgba(14,165,233,.65)' }} />
          )}
          {dropZone === 'left' && (
            <div className="absolute inset-y-0 left-0 w-1/2"
              style={{ background: 'rgba(14,165,233,.15)', borderRight: '2px solid rgba(14,165,233,.65)' }} />
          )}
          {dropZone === 'right' && (
            <div className="absolute inset-y-0 right-0 w-1/2"
              style={{ background: 'rgba(14,165,233,.15)', borderLeft: '2px solid rgba(14,165,233,.65)' }} />
          )}
          {dropZone === 'top' && (
            <div className="absolute inset-x-0 top-0 h-1/2"
              style={{ background: 'rgba(14,165,233,.15)', borderBottom: '2px solid rgba(14,165,233,.65)' }} />
          )}
          {dropZone === 'bottom' && (
            <div className="absolute inset-x-0 bottom-0 h-1/2"
              style={{ background: 'rgba(14,165,233,.15)', borderTop: '2px solid rgba(14,165,233,.65)' }} />
          )}
        </div>
      )}
    </div>
  );
}
