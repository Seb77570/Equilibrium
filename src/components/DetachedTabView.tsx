'use client';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeftToLine, Terminal as TerminalIcon, Globe } from 'lucide-react';
import TerminalTab from './Terminal/TerminalTab';
import BrowserTab from './Browser/BrowserTab';
import type { TabConfig } from '@/app/store/workspaceStore';

// Matches Rust `DetachedTabData` (serde uses snake_case by default).
interface DetachedTabData {
  workspace_id: string;
  pane_id: string;
  tab_json: string;
}

interface ResolvedData {
  workspaceId: string;
  paneId: string;
  tab: TabConfig;
}

export default function DetachedTabView() {
  const [data, setData] = useState<ResolvedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reattaching, setReattaching] = useState(false);

  // Fetch our tab data from Rust state (keyed by this window's label).
  useEffect(() => {
    console.log('[DetachedTabView] mount, calling get_detached_tab_data...');
    invoke<DetachedTabData>('get_detached_tab_data')
      .then((d) => {
        console.log('[DetachedTabView] got data:', d);
        try {
          const tab = JSON.parse(d.tab_json) as TabConfig;
          setData({ workspaceId: d.workspace_id, paneId: d.pane_id, tab });
        } catch (parseErr) {
          console.error('[DetachedTabView] parse error:', parseErr);
          setError(`Could not parse tab data: ${parseErr}`);
        }
      })
      .catch((err) => {
        console.error('[DetachedTabView] get_detached_tab_data failed:', err);
        setError(`Could not load detached tab data: ${err}`);
      });
  }, []);

  // Set the window title once we know the tab.
  useEffect(() => {
    if (!data) return;
    getCurrentWindow().setTitle(`${data.tab.title} — detached`).catch(() => {});
  }, [data]);

  // OS close handler: if the user closes the window without reattaching and
  // the tab is a terminal, kill the PTY so the dev server doesn't orphan.
  useEffect(() => {
    if (!data) return;
    const win = getCurrentWindow();
    let unlistenFn: (() => void) | undefined;
    win.onCloseRequested(async () => {
      if (reattaching) return; // reattach path closes us programmatically
      if (data.tab.type === 'terminal') {
        try {
          await invoke('kill_terminal', { id: data.tab.id });
        } catch (err) {
          console.error('Failed to kill terminal on detached close:', err);
        }
      }
    }).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, [data, reattaching]);

  const handleReattach = async () => {
    if (!data) return;
    setReattaching(true);
    try {
      await invoke('reattach_tab');
      // Rust closes the window on success.
    } catch (err) {
      console.error('Reattach failed:', err);
      setReattaching(false);
    }
  };

  if (error) {
    return (
      <div className="w-screen h-screen bg-[#0f1016] flex items-center justify-center text-red-400 text-sm p-8 text-center">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="w-screen h-screen bg-[#0f1016] flex items-center justify-center text-white/30 text-xs uppercase tracking-widest">
        Loading detached tab…
      </div>
    );
  }

  const { tab } = data;

  return (
    <div className="w-screen h-screen flex flex-col bg-[#0f1016] overflow-hidden">
      <div className="flex items-center gap-3 h-9 shrink-0 bg-[#16161a] border-b border-white/5 px-3">
        <button
          onClick={handleReattach}
          disabled={reattaching}
          title="Send this tab back to the main window"
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-bold text-white/60 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowLeftToLine size={13} />
          <span>Reattach</span>
        </button>
        <div className="h-4 w-px bg-white/10" />
        <div className="flex items-center gap-1.5 text-white/50 text-xs">
          {tab.type === 'terminal' ? <TerminalIcon size={12} /> : <Globe size={12} />}
          <span className="font-medium truncate">{tab.title}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {tab.type === 'terminal' ? (
          <TerminalTab
            id={tab.id}
            shell={tab.shell}
            cwd={tab.cwd}
            initialCommand={tab.initialCommand}
            agentSessionId={tab.agentSessionId}
          />
        ) : (
          <BrowserTab id={tab.id} initialUrl={tab.url} />
        )}
      </div>
    </div>
  );
}
