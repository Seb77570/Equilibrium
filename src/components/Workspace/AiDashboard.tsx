'use client';
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore, LayoutNode } from '@/app/store/workspaceStore';
import { Sparkles, Plus, Pencil, Check, X, Loader2, GitBranch, RefreshCw } from 'lucide-react';

interface SessionMeta {
  session_id: string;
  title: string;
  label: string | null;
  // Claude's own /rename — wins over `label` and `title` when set.
  // See claude_sessions.rs (read_session_names).
  claude_name: string | null;
  last_activity: string | null;
  git_branch: string | null;
  env: string;
  mtime: number | null;
}

// Display name precedence — single source of truth for the dashboard.
function sessionDisplay(s: SessionMeta): string {
  return s.claude_name || s.label || s.title;
}

interface AiDashboardProps {
  workspaceId: string;
  paneId: string;
  projectPath: string;
  env: 'powershell' | 'wsl';
}

function findPaneIdForTab(node: LayoutNode, tabId: string): string | null {
  if (node.type === 'pane') return node.tabIds.includes(tabId) ? node.id : null;
  for (const child of node.children) {
    const found = findPaneIdForTab(child, tabId);
    if (found) return found;
  }
  return null;
}

function timeAgo(iso: string | null, mtime: number | null): string {
  const t = iso ? Date.parse(iso) : mtime ? mtime * 1000 : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Module-level cache (survives tab-switch remounts) so the list shows instantly
// instead of flashing "Loading…" and re-fetching every time you switch back.
const sessionCache = new Map<string, { list: SessionMeta[]; at: number }>();
// Auto-refresh cadence. Matches the Sidebar's session-title refresh so a
// `/rename` typed inside Claude propagates to BOTH places on the same beat —
// the user shouldn't see one update while the other lags.
const AUTO_REFRESH_MS = 10_000; // 10s

export default function AiDashboard({ workspaceId, paneId, projectPath, env }: AiDashboardProps) {
  const cacheKey = `${env}::${projectPath}`;
  const [sessions, setSessions] = useState<SessionMeta[]>(() => sessionCache.get(cacheKey)?.list ?? []);
  const [loading, setLoading] = useState(() => !sessionCache.has(cacheKey));
  const [refreshing, setRefreshing] = useState(false);
  const [agentBase, setAgentBase] = useState('claude --dangerously-skip-permissions');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const agentStatus = useWorkspaceStore((s) => s.agentStatus);
  const agentUnread = useWorkspaceStore((s) => s.agentUnread);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const renameTab = useWorkspaceStore((s) => s.renameTab);

  // Map of sessionId → open tab id, for "is this conversation open?".
  const openTabs: Record<string, string> = {};
  if (workspace) {
    for (const tab of Object.values(workspace.allTabs)) {
      if (tab.agentSessionId) openTabs[tab.agentSessionId] = tab.id;
    }
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await invoke<SessionMeta[]>('list_claude_sessions', { env, projectPath });
      setSessions(list);
      sessionCache.set(cacheKey, { list, at: Date.now() });
    } catch (e) {
      console.error('list_claude_sessions failed:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [env, projectPath, cacheKey]);

  useEffect(() => {
    invoke<any>('get_settings')
      .then((res) => { if (res?.default_agent_command) setAgentBase(res.default_agent_command); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // On (re)mount: always kick a refresh — even with a fresh cache — so
    // the list picks up renames that happened while this tab was hidden
    // (e.g. user typed `/rename` inside a Claude conversation in another
    // tab). The cached list still drives the initial paint, so there's no
    // loading flash; the fetched list slots in once it arrives.
    refresh();
    const iv = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  const buildCmd = (flag: string) => {
    const base = agentBase.trim();
    return /^claude\b/.test(base) ? base.replace(/^claude\b/, `claude ${flag}`) : base;
  };

  const shell = env === 'wsl' ? 'wsl' : 'powershell.exe';

  const openConversation = (s: SessionMeta) => {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const existingTabId = Object.values(ws.allTabs).find((t) => t.agentSessionId === s.session_id)?.id;
    if (existingTabId) {
      const pid = findPaneIdForTab(ws.layout, existingTabId) ?? paneId;
      setActiveTab(workspaceId, existingTabId, pid);
      return;
    }
    const tabId = crypto.randomUUID();
    const initialCommand = buildCmd(`--resume ${s.session_id}`);
    addTab(
      workspaceId,
      {
        id: tabId,
        type: 'terminal',
        title: sessionDisplay(s),
        shell,
        cwd: projectPath,
        initialCommand,
        agentSessionId: s.session_id,
        agentEnv: env,
      } as any,
      paneId
    );
  };

  const newConversation = () => {
    const uuid = crypto.randomUUID();
    const tabId = crypto.randomUUID();
    addTab(
      workspaceId,
      {
        id: tabId,
        type: 'terminal',
        title: 'New conversation',
        shell,
        cwd: projectPath,
        initialCommand: buildCmd(`--session-id ${uuid}`),
        agentSessionId: uuid,
        agentEnv: env,
      } as any,
      paneId
    );
  };

  const startRename = (s: SessionMeta) => {
    setEditingId(s.session_id);
    setEditingValue(sessionDisplay(s));
  };

  const commitRename = async (s: SessionMeta) => {
    const value = editingValue.trim();
    setEditingId(null);
    try {
      await invoke('set_session_label', { sessionId: s.session_id, label: value });
    } catch (e) {
      console.error('set_session_label failed:', e);
    }
    // If the conversation is open, also rename the live tab and ask Claude
    // itself to rename (durable in Claude's own picker) via its /rename command.
    const openTabId = openTabs[s.session_id];
    if (openTabId) {
      // Clearing the Equilibrium label falls back to Claude's /rename (if any),
      // then the ai-title — mirrors the priority used everywhere else.
      renameTab(workspaceId, openTabId, value || s.claude_name || s.title);
      if (value) {
        invoke('write_to_terminal', { id: openTabId, data: `/rename ${value}\r` }).catch(() => {});
      }
    }
    refresh();
  };

  const envLabel = env === 'wsl' ? 'WSL' : 'PowerShell';

  return (
    <div className="w-full h-full overflow-y-auto custom-scrollbar bg-[#0A0C10] text-white">
      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-brand/15 text-brand-light">
              <Sparkles size={20} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Claude Conversations</h1>
              <p className="text-[11px] text-white/40 font-mono truncate max-w-[28rem]">
                {projectPath} · <span className="text-brand-light/70">{envLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={refreshing}
              title="Refresh"
              className="p-2 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={newConversation}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark transition-all shadow-lg shadow-brand/20 text-xs font-bold uppercase tracking-wider"
            >
              <Plus size={14} /> New conversation
            </button>
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="text-center text-white/30 text-sm py-12">Loading conversations…</div>
        ) : sessions.length === 0 ? (
          <div className="text-center text-white/30 text-sm py-12">
            No conversations yet for this project in {envLabel}.<br />
            Start one with “New conversation”.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sessions.map((s) => {
              const isOpen = !!openTabs[s.session_id];
              const isWorking = isOpen && agentStatus[s.session_id] === 'working';
              const isUnread = isOpen && !!agentUnread[s.session_id];
              const isEditing = editingId === s.session_id;
              const display = sessionDisplay(s);
              return (
                <div
                  key={s.session_id}
                  onClick={() => !isEditing && openConversation(s)}
                  className={`group relative flex items-center gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                    isOpen
                      ? 'bg-brand/10 border-brand-light/30 hover:bg-brand/15'
                      : 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06] hover:border-white/10'
                  }`}
                >
                  {/* Status indicator: working → spinner, finished-unread →
                      green dot, open(read) → faint white, closed → faint grey. */}
                  <div className="w-4 flex justify-center shrink-0">
                    {isWorking ? (
                      <Loader2 size={13} className="text-amber-400 animate-spin" />
                    ) : isUnread ? (
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
                    ) : isOpen ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-white/15" />
                    )}
                  </div>

                  {/* Title + meta */}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(s);
                          else if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full bg-black/50 border border-brand-light/40 rounded px-2 py-1 text-sm text-white focus:outline-none"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{display}</span>
                        {(s.label || s.claude_name) && (
                          <span className="text-[8px] uppercase tracking-wider text-brand-light/60 border border-brand-light/20 rounded px-1 py-0.5 shrink-0">
                            renamed
                          </span>
                        )}
                      </div>
                    )}
                    {!isEditing && (
                      <div className="flex items-center gap-3 mt-0.5 text-[10px] text-white/30">
                        <span>{timeAgo(s.last_activity, s.mtime)}</span>
                        {s.git_branch && (
                          <span className="flex items-center gap-1">
                            <GitBranch size={9} /> {s.git_branch}
                          </span>
                        )}
                        {isOpen && <span className="text-emerald-400/70 uppercase tracking-wider">open</span>}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {isEditing ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); commitRename(s); }}
                        className="p-1.5 rounded-md text-emerald-400 hover:bg-white/10"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                        className="p-1.5 rounded-md text-white/40 hover:bg-white/10"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(s); }}
                      title="Rename conversation"
                      className="p-1.5 rounded-md text-white/20 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
