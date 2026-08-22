'use client';
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  FolderTree, X, RefreshCw, Eye, EyeOff, FolderSymlink,
} from 'lucide-react';

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// Reveal a path in the OS file manager. Folders open directly; files are
// revealed (selected) inside their parent folder.
function revealInExplorer(entry: { path: string; is_dir: boolean }) {
  const cmd = entry.is_dir ? 'open_in_explorer' : 'show_in_folder';
  invoke(cmd, { path: entry.path }).catch((e) => console.error(`${cmd} failed:`, e));
}

// One row in the tree. Folders lazy-load their children on first expand, so a
// project with node_modules never gets walked up front. Double-click opens a
// file with the OS default app (matches VS Code's double-click-to-open).
// A hover-revealed folder button (LEFT-click — no right-click anywhere) opens
// the item in the OS file explorer.
function TreeNode({
  entry, depth, showHidden,
}: { entry: DirEntry; depth: number; showHidden: boolean }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<DirEntry[]>('list_dir', { path: entry.path, showHidden });
      setChildren(list);
    } catch (e) {
      console.error('list_dir failed:', e);
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [entry.path, showHidden]);

  // Re-fetch an already-open folder when the show-hidden toggle flips.
  useEffect(() => {
    if (open && children !== null) loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const toggleFolder = () => {
    const next = !open;
    setOpen(next);
    if (next && children === null) loadChildren();
  };

  const openFile = () => {
    invoke('open_path', { path: entry.path }).catch((e) => console.error('open_path failed:', e));
  };

  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  // The hover "open in explorer" button, shared by both row types.
  const explorerBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); revealInExplorer(entry); }}
      title={entry.is_dir ? 'Open folder in explorer' : 'Reveal in explorer'}
      className="opacity-0 group-hover:opacity-100 p-1 mr-1 text-white/30 hover:text-brand rounded shrink-0 transition-opacity"
    >
      <FolderSymlink size={12} />
    </button>
  );

  if (entry.is_dir) {
    return (
      <div>
        <div className="group flex items-center hover:bg-white/5 rounded-sm">
          <button
            onClick={toggleFolder}
            style={pad}
            className="flex-1 min-w-0 flex items-center gap-1.5 py-[3px] text-left text-xs text-white/70"
          >
            {open ? <ChevronDown size={12} className="text-white/40 shrink-0" />
                  : <ChevronRight size={12} className="text-white/40 shrink-0" />}
            {open ? <FolderOpen size={13} className="text-amber-300/80 shrink-0" />
                  : <Folder size={13} className="text-amber-300/70 shrink-0" />}
            <span className="truncate">{entry.name}</span>
          </button>
          {explorerBtn}
        </div>
        {open && (
          <div>
            {loading && <div style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }} className="py-1 text-[11px] text-white/25">…</div>}
            {children?.map((c) => (
              <TreeNode key={c.path} entry={c} depth={depth + 1} showHidden={showHidden} />
            ))}
            {children && children.length === 0 && !loading && (
              <div style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }} className="py-1 text-[11px] text-white/20 italic">empty</div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group flex items-center hover:bg-white/5 rounded-sm">
      <button
        onDoubleClick={openFile}
        style={pad}
        title="Double-click to open with the default app"
        className="flex-1 min-w-0 flex items-center gap-1.5 py-[3px] text-left text-xs text-white/55"
      >
        <span className="w-3 shrink-0" />
        <File size={13} className="text-white/35 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
      {explorerBtn}
    </div>
  );
}

// Retractable file-tree overlay, pinned to the right edge of the workspace.
export default function FileExplorer({
  projectPath, onClose,
}: { projectPath: string; onClose: () => void }) {
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<DirEntry[]>('list_dir', { path: projectPath, showHidden });
      setRoots(list);
    } catch (e) {
      console.error('list_dir (root) failed:', e);
      setRoots([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, showHidden]);

  useEffect(() => { load(); }, [load]);

  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';

  return (
    <div className="absolute top-0 right-0 h-full w-72 z-[200] bg-[#141519] border-l border-white/10 shadow-2xl flex flex-col">
      <div className="flex items-center justify-between pl-3 pr-10 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <FolderTree size={13} className="text-brand shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60 truncate">{projectName}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => invoke('open_in_explorer', { path: projectPath }).catch(() => {})} title="Open project folder in explorer" className="p-1 text-white/30 hover:text-brand rounded">
            <FolderSymlink size={13} />
          </button>
          <button onClick={() => setShowHidden((v) => !v)} title={showHidden ? 'Hide node_modules/.git/…' : 'Show hidden folders'} className="p-1 text-white/30 hover:text-white rounded">
            {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button onClick={load} title="Refresh" className="p-1 text-white/30 hover:text-white rounded">
            <RefreshCw size={12} />
          </button>
          <button onClick={onClose} title="Close" className="p-1 text-white/30 hover:text-white rounded">
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading && <div className="px-3 py-2 text-[11px] text-white/25">Loading…</div>}
        {roots?.map((e) => (
          <TreeNode key={e.path} entry={e} depth={0} showHidden={showHidden} />
        ))}
        {roots && roots.length === 0 && !loading && (
          <div className="px-3 py-2 text-[11px] text-white/25 italic">Empty folder</div>
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-white/25 shrink-0">
        Double-click a file to open · hover a row for explorer
      </div>
    </div>
  );
}
