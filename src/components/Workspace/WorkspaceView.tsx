'use client';
import { useState } from 'react';
import { useWorkspaceStore } from '@/app/store/workspaceStore';
import { Terminal, FolderTree } from 'lucide-react';
import SplitLayout from './SplitLayout';
import FileExplorer from './FileExplorer';

export default function WorkspaceView() {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const projectPath = activeWorkspace?.metadata?.projectPath;

  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0f1016]">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Terminal size={32} className="text-white/20" />
          </div>
          <h2 className="text-xl font-bold text-white/40 uppercase tracking-[0.2em]">Select a workspace</h2>
          <p className="text-sm text-white/20 font-medium">Choose a project from the sidebar to begin.</p>
        </div>
      </div>
    );
  }

  return (
    // `relative` so a fullscreen TabPane (absolute inset-0) anchors here
    // and covers exactly the workspace area, not the sidebar.
    <div className="flex-1 flex flex-col min-w-0 bg-[#0f1016] overflow-hidden relative">
      <SplitLayout
        node={activeWorkspace.layout}
        workspaceId={activeWorkspace.id}
        metadata={activeWorkspace.metadata}
      />

      {/* File-explorer toggle — pinned to the right edge. Hidden while the
          panel is open (the panel has its own close button). Only shown when
          the workspace is bound to a project path on disk. */}
      {projectPath && !explorerOpen && (
        <button
          onClick={() => setExplorerOpen(true)}
          title="Show file explorer"
          className="absolute top-2 right-2 z-[150] p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-brand border border-white/10 transition-colors"
        >
          <FolderTree size={15} />
        </button>
      )}

      {projectPath && explorerOpen && (
        <FileExplorer projectPath={projectPath} onClose={() => setExplorerOpen(false)} />
      )}
    </div>
  );
}
