import { LayoutDashboard, Settings, FolderClosed, Github, Globe, Terminal, Plus, X, Keyboard, ChevronDown, ChevronRight, ChevronUp, History, Loader2, Sparkles, Clock, Pause } from "lucide-react";
import { useState, useEffect } from 'react';
import { useWorkspaceStore, Workspace, LayoutNode, TabConfig, TabColor } from '@/app/store/workspaceStore';
import { useTimeStore } from '@/app/store/timeStore';
import { BackdateStartModal } from './ProjectCard';
import { invoke } from '@tauri-apps/api/core';

// Background+text classes per tab color, for the Claude sub-tab rows in the
// sidebar. Mirrors TabPane's TAB_COLOR_CLASSES so a tab tinted green there
// reads as the same green here. `active` = the user is currently viewing
// this tab; `inactive` = it exists but is in the background.
const SUB_TAB_COLOR_CLASSES: Record<Exclude<TabColor, 'default'>, { active: string; inactive: string }> = {
  green:  { active: 'bg-emerald-600/40 text-emerald-50', inactive: 'bg-emerald-600/10 text-emerald-200/70 hover:bg-emerald-600/20 hover:text-emerald-50' },
  red:    { active: 'bg-rose-600/40 text-rose-50',     inactive: 'bg-rose-600/10 text-rose-200/70 hover:bg-rose-600/20 hover:text-rose-50' },
  pink:   { active: 'bg-pink-400/40 text-pink-50',     inactive: 'bg-pink-400/10 text-pink-100/70 hover:bg-pink-400/20 hover:text-pink-50' },
  blue:   { active: 'bg-blue-600/40 text-blue-50',     inactive: 'bg-blue-600/10 text-blue-200/70 hover:bg-blue-600/20 hover:text-blue-50' },
  orange: { active: 'bg-orange-500/40 text-orange-50', inactive: 'bg-orange-500/10 text-orange-100/70 hover:bg-orange-500/20 hover:text-orange-50' },
  purple: { active: 'bg-violet-600/40 text-violet-50', inactive: 'bg-violet-600/10 text-violet-200/70 hover:bg-violet-600/20 hover:text-violet-50' },
  cyan:   { active: 'bg-cyan-500/40 text-cyan-50',     inactive: 'bg-cyan-500/10 text-cyan-100/70 hover:bg-cyan-500/20 hover:text-cyan-50' },
};

// Small right-side dot shown on the ACTIVE conversation row when the tab has
// a custom color — the active row itself always wears the blue gradient, so
// the tab color is carried by this dot instead of the row background.
const TAB_COLOR_DOT: Record<Exclude<TabColor, 'default'>, string> = {
  green: 'bg-emerald-400',
  red: 'bg-rose-400',
  pink: 'bg-pink-400',
  blue: 'bg-blue-400',
  orange: 'bg-orange-400',
  purple: 'bg-violet-400',
  cyan: 'bg-cyan-400',
};

// Swatches for the right-click color picker on conversation rows — same set
// as TabPane's tab color menu so both entry points feel identical.
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

// Return the pane node containing a given tab id (or null), so we can check
// whether that pane currently has the tab activated — i.e. the user is
// actually looking at this tab right now. A workspace with split panes can
// have several panes active simultaneously, so we check per-pane.
function findContainingPane(node: LayoutNode, tabId: string): LayoutNode | null {
  if (node.type === 'pane') return node.tabIds.includes(tabId) ? node : null;
  for (const child of node.children) {
    const found = findContainingPane(child, tabId);
    if (found) return found;
  }
  return null;
}

// Walk the layout tree to find which pane currently holds a given tab.
function findPaneIdForTab(node: LayoutNode, tabId: string): string | null {
  if (node.type === 'pane') {
    return node.tabIds.includes(tabId) ? node.id : null;
  }
  for (const child of node.children) {
    const found = findPaneIdForTab(child, tabId);
    if (found) return found;
  }
  return null;
}

// Working → amber spinner. Finished-but-unread → green dot (notification).
// Read/idle → nothing.
function AgentStatusDot({ working, unread, size = 8 }: { working: boolean; unread: boolean; size?: number }) {
  if (working) {
    return <Loader2 size={size + 2} className="text-amber-400 animate-spin shrink-0" />;
  }
  if (unread) {
    return (
      <span
        className="rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)] shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return null;
}

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
}

export default function Sidebar({ activeView, onNavigate }: SidebarProps) {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, addWorkspace, removeWorkspace, renameWorkspace, projectStatuses, agentStatus, agentUnread, setActiveTab, renameTab, setTabColor } = useWorkspaceStore();
  // Right-click color picker for a conversation row (mirrors TabPane's).
  const [convColorMenu, setConvColorMenu] = useState<{ wId: string; tabId: string; top: number; left: number } | null>(null);
  // Workspaces are expanded by default; we track the ones the user collapsed.
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [dashboardConfig, setDashboardConfig] = useState<any>(null);
  const [filterActive, setFilterActive] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showShellModal, setShowShellModal] = useState(false);
  const [pendingProject, setPendingProject] = useState<any>(null);
  const [defaultAgentCommand, setDefaultAgentCommand] = useState("claude --dangerously-skip-permissions");

  useEffect(() => {
    invoke('get_projects').then((res: any) => setProjects(res)).catch(console.error);
    invoke('get_dashboard_config').then((res: any) => setDashboardConfig(res)).catch(console.error);
    invoke<any>('get_settings').then((res) => {
      if (res.default_agent_command) setDefaultAgentCommand(res.default_agent_command);
    }).catch(console.error);
  }, []);

  // Keep Claude tab names in sync with the conversation's ai-title. (Working/
  // idle status is detected in TerminalTab from the terminal's "to interrupt"
  // marker — file mtime/size are unreliable here because Windows updates them
  // lazily for files Claude holds open.)
  useEffect(() => {
    let cancelled = false;
    const refreshSessions = async () => {
      for (const w of useWorkspaceStore.getState().workspaces) {
        const projectPath = w.metadata?.projectPath;
        if (!projectPath) continue;
        for (const tab of Object.values(w.allTabs)) {
          if (!tab.agentSessionId || !tab.agentEnv) continue;
          try {
            const meta = await invoke<any>('read_session_title', {
              env: tab.agentEnv,
              projectPath,
              sessionId: tab.agentSessionId,
            });
            if (cancelled) return;
            if (!meta) continue;
            // Priority: Claude's native /rename > Equilibrium label > ai-title.
            // /rename wins because it's the most direct user intent — typed
            // inside Claude itself, in <home>/.claude/sessions/<pid>.json.
            const title = meta.claude_name || meta.label || meta.title;
            if (title && title !== '(untitled)' && title !== tab.title) {
              renameTab(w.id, tab.id, title);
            }
          } catch { /* transcript not ready yet — leave name as-is */ }
        }
      }
    };
    refreshSessions();
    const iv = setInterval(refreshSessions, 10000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [renameTab]);

  const handleAddWorkspace = (project?: any, shell?: string, isBrowser?: boolean) => {
    console.log('[Sidebar] handleAddWorkspace:', { project, shell, isBrowser });
    if (!shell && !isBrowser) {
      setPendingProject(project || null);
      setShowShellModal(true);
      setShowAddMenu(false);
      return;
    }

    const workspaceId = crypto.randomUUID();
    const tabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    
    addWorkspace({
      id: workspaceId,
      name: project ? project.name : isBrowser ? 'Browser Workspace' : `Terminal (${shell === 'wsl' ? 'WSL' : 'PS'})`,
      layout: {
        id: paneId,
        type: 'pane',
        tabIds: [tabId],
        activeTabId: tabId
      },
      allTabs: {
        [tabId]: {
          id: tabId,
          type: isBrowser ? 'browser' : 'terminal',
          title: isBrowser ? 'Browser' : (shell === 'wsl' ? 'WSL' : 'PowerShell'),
          cwd: project ? project.path : undefined,
          url: project?.port ? `http://localhost:${project.port}` : undefined,
          shell,
          initialCommand: project ? defaultAgentCommand : undefined
        }
      },
      metadata: project ? {
        projectPath: project.path,
        defaultPort: project.port
      } : undefined
    });
    setShowAddMenu(false);
    setShowShellModal(false);
    setPendingProject(null);
    onNavigate('workspaces');
  };

  const toggleExpanded = (id: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Activate a specific Claude conversation tab from the sidebar tree.
  const openClaudeTab = (w: Workspace, tab: TabConfig) => {
    const paneId = findPaneIdForTab(w.layout, tab.id);
    setActiveWorkspace(w.id);
    if (paneId) setActiveTab(w.id, tab.id, paneId);
    onNavigate('workspaces');
  };

  return (
    <aside className="w-64 glass-sidebar h-full p-6 flex flex-col z-50 relative">
      <div className="mb-8 flex items-center space-x-3 px-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-alive to-brand shadow-lg shadow-alive/30 flex-shrink-0" />
        <span className="text-xl font-bold tracking-tight text-ink">Equilibrium</span>
      </div>

      <nav className="flex-1 flex flex-col gap-6">
        {/* Main Nav */}
        <div className="space-y-2">
          <NavItem
            icon={<LayoutDashboard size={20} />}
            label="Dashboard"
            active={activeView === 'dashboard'}
            onClick={() => onNavigate('dashboard')}
          />
          <NavItem
            icon={<Clock size={20} />}
            label="Time"
            active={activeView === 'time'}
            onClick={() => onNavigate('time')}
          />
          <NavItem
            icon={<Keyboard size={20} />}
            label="Cheat Sheet"
            active={activeView === 'cheatsheet'}
            onClick={() => onNavigate('cheatsheet')}
          />
        </div>

        {/* Workspaces Section */}
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center justify-between px-4 mb-2 relative z-[100]">
            <span className="text-xs font-semibold text-ink-faint uppercase tracking-wider">Workspaces</span>
            <div className="relative">
              <button 
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="text-white/40 hover:text-white transition-colors"
                title="Add Workspace"
              >
                <Plus size={16} />
              </button>
              
              {showAddMenu && (
                <>
                  <div className="fixed inset-0 z-[150] bg-black/40 backdrop-blur-sm" onClick={() => setShowAddMenu(false)}></div>
                  <div className="fixed top-20 left-72 w-[340px] bg-[#1c1c1f]/95 backdrop-blur-2xl border border-white/10 rounded-[10px] shadow-[0_30px_60px_rgba(0,0,0,0.7)] z-[200] overflow-hidden animate-in fade-in slide-in-from-left-4 duration-300">
                    <div className="p-5 border-b border-white/5">
                      <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                        <Plus size={16} className="text-brand-light" /> Create Workspace
                      </h3>
                    </div>

                    <div className="p-4 space-y-4">
                      <button 
                        onClick={() => handleAddWorkspace()}
                        className="w-full flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition-all group"
                      >
                        <div className="p-2 rounded-lg bg-white/5 text-white/70 group-hover:bg-brand/20 group-hover:text-brand-light transition-colors">
                          <Terminal size={18} />
                        </div>
                        <div className="text-left">
                          <span className="block text-sm font-medium text-white">New Blank Session</span>
                          <span className="text-[10px] text-white/30">Manual configuration</span>
                        </div>
                      </button>

                      <div className="relative">
                        <div className="flex items-center justify-between mb-3 px-1">
                          <div className="text-[10px] font-bold text-white/30 uppercase tracking-[0.2em]">Project Workspaces</div>
                          <button 
                            onClick={() => setFilterActive(!filterActive)}
                            className={`text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded-md transition-all ${filterActive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-white/5 text-white/30 border border-transparent hover:border-white/10'}`}
                          >
                            {filterActive ? '● Running Only' : 'Show All'}
                          </button>
                        </div>
                        
                        <input 
                          type="text"
                          placeholder="Search projects..."
                          value={projectSearch}
                          onChange={(e) => setProjectSearch(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-brand/50 mb-3"
                        />
                        
                        <div className="max-h-[400px] overflow-y-auto custom-scrollbar space-y-4 pr-1">
                          {dashboardConfig?.sections.map((section: any) => {
                            const sectionProjects = section.project_paths
                              .map((path: string) => projects.find(p => p.path === path))
                              .filter((p: any) => p && p.name.toLowerCase().includes(projectSearch.toLowerCase()))
                              .filter((p: any) => !filterActive || projectStatuses[p.path]);

                            if (sectionProjects.length === 0) return null;

                            return (
                              <div key={section.id} className="space-y-1.5">
                                <div className="flex items-center gap-2 px-1 mb-2">
                                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: section.color }} />
                                  <span className="text-[9px] font-bold text-white/20 uppercase tracking-widest">{section.title}</span>
                                </div>
                                {sectionProjects.map((p: any) => {
                                  const isActive = projectStatuses[p.path];
                                  return (
                                    <button 
                                      key={p.path}
                                      onClick={() => handleAddWorkspace(p)}
                                      className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-all flex items-center gap-3 group"
                                    >
                                      <div className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${isActive ? 'bg-emerald-500/20 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'bg-white/5 text-white/40'}`}>
                                        {p.name.charAt(0)}
                                      </div>
                                      <span className="truncate flex-1 font-medium">{p.name}</span>
                                      {isActive && (
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                      )}
                                      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Plus size={12} className="text-white/40" />
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })}
                          
                          {/* Fallback for projects not in any section */}
                          {(() => {
                            const categorizedPaths = new Set(dashboardConfig?.sections.flatMap((s: any) => s.project_paths) || []);
                            const uncategorized = projects
                              .filter(p => !categorizedPaths.has(p.path))
                              .filter(p => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
                              .filter(p => !filterActive || projectStatuses[p.path]);
                            
                            if (uncategorized.length === 0) return null;

                            return (
                              <div className="space-y-1.5 pt-2 border-t border-white/5">
                                <div className="flex items-center gap-2 px-1 mb-2">
                                  <div className="w-1.5 h-1.5 rounded-full bg-white/10" />
                                  <span className="text-[9px] font-bold text-white/20 uppercase tracking-widest">Uncategorized</span>
                                </div>
                                {uncategorized.map((p: any) => {
                                  const isActive = projectStatuses[p.path];
                                  return (
                                    <button 
                                      key={p.path}
                                      onClick={() => handleAddWorkspace(p)}
                                      className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-all flex items-center gap-3 group"
                                    >
                                      <div className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${isActive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/40'}`}>
                                        {p.name.charAt(0)}
                                      </div>
                                      <span className="truncate flex-1 font-medium">{p.name}</span>
                                      {isActive && (
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          
          <div className="space-y-1.5 overflow-y-auto custom-scrollbar">
            {workspaces.map(w => {
              const isActive = activeView === 'workspaces' && activeWorkspaceId === w.id;
              const claudeTabs = Object.values(w.allTabs).filter(t => t.agentSessionId);
              const hasClaude = claudeTabs.length > 0;
              const expanded = !collapsedWorkspaces.has(w.id);
              const anyWorking = claudeTabs.some(t => agentStatus[t.agentSessionId!] === 'working');
              const anyUnread = claudeTabs.some(t => agentUnread[t.agentSessionId!]);
              return (
                <div key={w.id}>
                  {/* Workspace row: active = dark blue gradient (brand sky →
                      cyan family), inactive = gray raised surface — both
                      clearly distinct from the flat dark Claude sub-tab list
                      under it. Tab colors live on the per-tab rows below,
                      not on the workspace itself — coloring the workspace
                      was misleading (a single colored tab made the whole
                      project look colored). */}
                  <div
                    onClick={() => {
                      // Expand/collapse lives exclusively on the edge badge —
                      // clicking the pill always just opens the workspace.
                      setActiveWorkspace(w.id);
                      onNavigate('workspaces');
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingWorkspaceId(w.id);
                      setEditingName(w.name);
                    }}
                    className={`
                      relative px-2.5 py-2 rounded-lg border
                      transition-all duration-200 cursor-pointer group
                      ${isActive
                        ? "bg-gradient-to-r from-sky-900 to-cyan-900 border-sky-700/50 text-sky-50 shadow-lg"
                        : "bg-surface-hi border-line text-ink-dim hover:border-sky-700/50 hover:text-ink"}
                      ${hasClaude && !expanded ? 'mb-4' : ''}
                    `}
                  >
                    {/* Line 1 — the name gets the full width. */}
                    <div className="flex items-center gap-2">
                    {editingWorkspaceId === w.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => {
                          if(editingName.trim()) renameWorkspace(w.id, editingName.trim());
                          setEditingWorkspaceId(null);
                        }}
                        onKeyDown={(e) => {
                          if(e.key === 'Enter') {
                            if(editingName.trim()) renameWorkspace(w.id, editingName.trim());
                            setEditingWorkspaceId(null);
                          } else if(e.key === 'Escape') {
                            setEditingWorkspaceId(null);
                          }
                        }}
                        className="flex-1 bg-black/50 text-sm text-white px-1 outline-none border border-blue-500 rounded"
                      />
                    ) : (
                      <span className="font-semibold text-sm truncate flex-1 text-center select-none tracking-tight">{w.name}</span>
                    )}

                    {hasClaude && <AgentStatusDot working={anyWorking} unread={anyUnread} />}
                    </div>

                    {/* Line 2 — segmented action bar: chrono · backdate · close. */}
                    <WorkspaceActionBar
                      projectPath={w.metadata?.projectPath}
                      isActive={isActive}
                      onClose={() => removeWorkspace(w.id)}
                    />

                    {/* Expand/collapse badge straddling the pill's bottom
                        edge — the ONLY control for the conversation list.
                        Chevron down = expand, up = collapse. White ring,
                        blue fill when the workspace is selected. */}
                    {hasClaude && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpanded(w.id); }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={expanded ? 'Hide conversations' : 'Show conversations'}
                        className={`absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full border flex items-center justify-center cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-sky-800 border-white/60 text-white hover:bg-sky-700'
                            : 'bg-surface-hi border-white/30 text-white/70 hover:border-white/60 hover:text-white'
                        }`}
                      >
                        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                    )}
                  </div>

                  {hasClaude && expanded && (
                    // Sub-tab list: smaller + dimmer than the workspace card
                    // so it reads as a child group, not another peer entry.
                    {/* pt-5 (not a margin on the pill) so the left rail runs
                        uninterrupted from the pill's bottom edge down to the
                        first conversation. */}
                    <div className="ml-[18px] pt-5 mb-1 space-y-0.5 border-l border-white/25 pl-2">
                      {claudeTabs.map(t => {
                        const working = agentStatus[t.agentSessionId!] === 'working';
                        const unread = !!agentUnread[t.agentSessionId!];
                        // "Currently viewing this tab" = it's the activeTab of
                        // its pane AND the user is on the workspaces view of
                        // this workspace. Split layouts can have several panes
                        // active at once, so we check the tab's own pane.
                        const pane = findContainingPane(w.layout, t.id);
                        const isTabActive =
                          pane !== null && pane.type === 'pane' &&
                          pane.activeTabId === t.id &&
                          activeView === 'workspaces' &&
                          activeWorkspaceId === w.id;
                        const color = t.color && t.color !== 'default' ? t.color : null;
                        // The ACTIVE conversation always wears the same blue
                        // gradient as the active workspace pill — a custom tab
                        // color is demoted to a small dot on the right so the
                        // "you are here" blue stays unmistakable. Inactive
                        // rows keep their tinted/plain treatment.
                        const rowClass = isTabActive
                          ? 'bg-gradient-to-r from-sky-900 to-cyan-900 text-sky-50'
                          : color
                            ? SUB_TAB_COLOR_CLASSES[color].inactive
                            : 'text-white/35 hover:text-white hover:bg-white/5';
                        return (
                          <div
                            key={t.id}
                            onClick={() => openClaudeTab(w, t)}
                            onContextMenu={(e) => {
                              // Right-click → color picker, same as tabs.
                              e.preventDefault();
                              e.stopPropagation();
                              setConvColorMenu({ wId: w.id, tabId: t.id, top: e.clientY + 4, left: e.clientX });
                            }}
                            title={t.title}
                            className={`flex items-center gap-2 px-2 py-1 rounded-lg text-[11px] font-normal cursor-pointer transition-colors ${rowClass}`}
                          >
                            {/* Sparkles inherits the row text color when the
                                row is tinted, so it matches the highlight. */}
                            <Sparkles size={10} className={`shrink-0 ${color || isTabActive ? 'opacity-80' : 'text-violet-300/50'}`} />
                            <span className="truncate flex-1">{t.title}</span>
                            {isTabActive && color && (
                              <span className={`w-2 h-2 rounded-full shrink-0 ${TAB_COLOR_DOT[color]}`} title={`Tab color: ${color}`} />
                            )}
                            <AgentStatusDot working={working} unread={unread} size={6} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            
            {workspaces.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-white/30">
                No workspaces yet.
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Shell Selection Modal */}
      {showShellModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[#18181b] border border-white/10 shadow-2xl p-8">
            <h3 className="text-sm font-bold text-white uppercase tracking-[0.2em] mb-1">
              {pendingProject ? pendingProject.name : 'New Workspace'}
            </h3>
            <p className="text-[10px] text-white/30 uppercase tracking-widest mb-8 font-bold">Select Environment</p>
            
            <div className="grid grid-cols-1 gap-2">
              <button 
                onClick={() => handleAddWorkspace(pendingProject, 'powershell.exe')}
                className="flex items-center gap-4 p-4 bg-white/[0.02] hover:bg-white/10 border border-white/5 transition-all group w-full"
              >
                <div className="p-2 bg-white/5 text-white/40 group-hover:text-white transition-colors">
                  <Terminal size={18} />
                </div>
                <div className="text-left">
                  <span className="block text-xs font-bold text-white/70 group-hover:text-white uppercase tracking-wider">PowerShell</span>
                  <span className="text-[9px] text-white/20 uppercase tracking-tight">Native Windows Terminal</span>
                </div>
              </button>

              <button 
                onClick={() => handleAddWorkspace(pendingProject, 'wsl')}
                className="flex items-center gap-4 p-4 bg-white/[0.02] hover:bg-white/10 border border-white/5 transition-all group w-full"
              >
                <div className="p-2 bg-white/5 text-white/40 group-hover:text-white transition-colors">
                  <Terminal size={18} />
                </div>
                <div className="text-left">
                  <span className="block text-xs font-bold text-white/70 group-hover:text-white uppercase tracking-wider">WSL Linux</span>
                  <span className="text-[9px] text-white/20 uppercase tracking-tight">Ubuntu Environment</span>
                </div>
              </button>

              <button 
                onClick={() => handleAddWorkspace(pendingProject, undefined, true)}
                className="flex items-center gap-4 p-4 bg-white/[0.02] hover:bg-white/10 border border-white/5 transition-all group w-full"
              >
                <div className="p-2 bg-white/5 text-white/40 group-hover:text-white transition-colors">
                  <Globe size={18} />
                </div>
                <div className="text-left">
                  <span className="block text-xs font-bold text-white/70 group-hover:text-white uppercase tracking-wider">Browser</span>
                  <span className="text-[9px] text-white/20 uppercase tracking-tight">Web Preview</span>
                </div>
              </button>
            </div>

            <button 
              onClick={() => setShowShellModal(false)}
              className="w-full mt-4 py-3 text-[9px] font-bold text-white/20 hover:text-white uppercase tracking-[0.3em] transition-colors border-t border-white/5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Conversation color picker (right-click on a sidebar conv) ───── */}
      {convColorMenu && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={() => setConvColorMenu(null)} />
          <div
            className="fixed bg-[#18181b] border border-white/10 shadow-2xl rounded-lg p-1.5 z-[200]"
            style={{ top: convColorMenu.top, left: convColorMenu.left }}
          >
            <div className="flex items-center gap-1">
              {COLOR_SWATCHES.map(({ value, label, dot }) => {
                const current =
                  workspaces.find((ws) => ws.id === convColorMenu.wId)?.allTabs[convColorMenu.tabId]?.color ?? 'default';
                const selected = current === value;
                return (
                  <button
                    key={value}
                    title={label}
                    onClick={() => {
                      setTabColor(convColorMenu.wId, convColorMenu.tabId, value);
                      setConvColorMenu(null);
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
    </aside>
  );
}

function NavItem({ icon, label, active = false, onClick }: { icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`
      relative flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 cursor-pointer
      ${active
        ? "bg-surface-raised text-ink"
        : "text-ink-dim hover:text-ink hover:bg-surface-raised"}
    `}>
      {active && <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r-full bg-alive" />}
      {icon}
      <span className="font-medium text-sm">{label}</span>
    </div>
  );
}


// Segmented action bar under the workspace name: three equal sections filling
// the pill width — chrono toggle, backdate-start, close. Always visible for
// the active workspace or while its chrono runs (the amber cue must never
// hide); hover-revealed on quiet rows so the list stays compact. Workspaces
// without a bound project only get the close section. Subscribes only to the
// boolean "is this project running?", so flipping unrelated chronos doesn't
// re-render every row.
function WorkspaceActionBar({ projectPath, isActive, onClose }: { projectPath?: string; isActive: boolean; onClose: () => void }) {
  const isRunning = useTimeStore((s) => (projectPath ? !!s.running[projectPath] : false));
  const toggle = useTimeStore((s) => s.toggle);
  const [backdating, setBackdating] = useState(false);
  const visible = isActive || isRunning;
  const base = 'flex items-center justify-center py-1.5 rounded-md transition-colors cursor-pointer';
  return (
    <>
      {/* Collapsible wrapper — animating grid-template-rows 0fr → 1fr gives a
          smooth height unfold (no fixed max-height guess), paired with a
          fade. `visible` rows stay expanded; others unfold on row hover. */}
      <div
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] group-hover:grid-rows-[1fr]'
        }`}
      >
      <div className="overflow-hidden min-h-0">
      <div
        className={`grid ${projectPath ? 'grid-cols-3' : 'grid-cols-1'} gap-1 mt-2 transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {projectPath && (
          <button
            onClick={() => toggle(projectPath)}
            title={isRunning ? 'Tracking time · click to stop' : 'Start tracking'}
            className={`${base} ${
              isRunning
                ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                : 'bg-black/20 text-white/50 hover:bg-black/40 hover:text-amber-300'
            }`}
          >
            {isRunning ? <Pause size={13} /> : <Clock size={13} />}
          </button>
        )}
        {projectPath && (
          <button
            onClick={() => { if (!isRunning) setBackdating(true); }}
            disabled={isRunning}
            title={isRunning ? 'Already tracking' : 'Backdate start — begin at a past time and keep tracking'}
            className={`${base} ${
              isRunning
                ? 'bg-black/10 text-white/20 cursor-default'
                : 'bg-black/20 text-white/50 hover:bg-black/40 hover:text-amber-300'
            }`}
          >
            <History size={13} />
          </button>
        )}
        <button
          onClick={onClose}
          title="Close workspace"
          className={`${base} bg-black/20 text-white/50 hover:bg-black/40 hover:text-red-400`}
        >
          <X size={13} />
        </button>
      </div>
      </div>
      </div>
      {backdating && projectPath && (
        <BackdateStartModal projectPath={projectPath} onClose={() => setBackdating(false)} />
      )}
    </>
  );
}
