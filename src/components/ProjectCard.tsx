import { useState, useEffect } from "react";
import { ExternalLink, Github, Folder, Cloud, GripVertical, Settings, Save, X, Trash2, Plus, Globe, Link, Code2, Terminal, Sparkles, Clock, Pause } from "lucide-react";
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from "@/app/store/workspaceStore";
import { useTimeStore, entryDurationMs, formatMinutes, useNow } from "@/app/store/timeStore";
import { DateTimeFlipField } from './DateTimeFlip';

interface ProjectCardProps {
  name: string;
  project_type: string;
  description?: string;
  status?: string;
  port?: number;
  path: string;
  dev_command?: string;
  instructions?: string;
  install_path?: string;
  executable_path?: string;
  claude_env?: string;
  links?: {
    github?: string;
    vercel?: string;
    aws?: string;
    other?: string[];
  };
  isDragging?: boolean;
  dragHandleProps?: any;
  onUpdate?: () => void;
  accentColor?: string;
}

export default function ProjectCard({ name, project_type, description, status = "local", port, path, dev_command, instructions, install_path, executable_path, claude_env, links, isDragging, dragHandleProps, onUpdate, accentColor = "#3b82f6" }: ProjectCardProps) {
  const { addWorkspace } = useWorkspaceStore();
  const [isPortActive, setIsPortActive] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [formData, setFormData] = useState({
    name,
    project_type: project_type || "",
    path: path || "",
    description: description || "",
    instructions: instructions || "",
    port: port?.toString() || "",
    dev_command: dev_command || "",
    install_path: install_path || "",
    executable_path: executable_path || "",
    claude_env: claude_env || "powershell",
    github: links?.github || "",
    vercel: links?.vercel || "",
    aws: links?.aws || "",
    other_links: links?.other || []
  });

  const [activeTab, setActiveTab] = useState<'info' | 'ai' | 'links'>('info');

  // Human-readable label for the terminal environment (claude_env), shown as a
  // badge on the card. Empty/unset falls back to the dropdown's "Default (CMD)".
  const envLabel = claude_env === 'wsl' ? 'WSL' : claude_env === 'powershell' ? 'PowerShell' : 'Default';

  useEffect(() => {
    if (!port) return;

    const checkStatus = async () => {
      if (isDragging) return; // Skip polling if dragging to avoid re-renders
      try {
        const active = await invoke<boolean>('is_port_open', { port });
        setIsPortActive(active);
      } catch (err) {
        console.error('Status check failed:', err);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, [port, isDragging]);

  const resolvePath = (target: string) => {
    if (!target) return target;
    // Check if absolute (Windows style C:\ or Unix style /)
    if (target.includes(':') || target.startsWith('/') || target.startsWith('\\\\')) {
      return target;
    }
    // Otherwise join with project path and normalize slashes for Windows
    return `${path}/${target}`.replace(/\//g, '\\');
  };

  const handleShowInFolder = async (targetPath: string) => {
    try {
      await invoke('show_in_folder', { path: resolvePath(targetPath) });
    } catch (err) {
      console.error('Failed to show in folder:', err);
    }
  };

  const handleOpenVSCode = async () => {
    try {
      await invoke('open_in_vscode', { path });
    } catch (err) {
      console.error('Failed to open VS Code:', err);
      alert(String(err));
    }
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_in_explorer', { path });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const handleOpenPath = async (targetPath: string) => {
    try {
      await invoke('open_path', { path: resolvePath(targetPath) });
    } catch (err) {
      console.error('Failed to open path:', err);
    }
  };

  const handleRunDev = async () => {
    console.log('[ProjectCard] handleRunDev:', { name, port, path });
    if (!dev_command) {
      alert('No dev command detected for this project. Please add one in equilibrium.json');
      return;
    }
    
    // Open a workspace with two tabs: first the dev-server terminal (active),
    // then the project's AI Dashboard for its default environment — so the dev
    // server and Claude are both ready in one shot.
    //
    // Dev terminal is ALWAYS PowerShell, regardless of the project's Claude
    // env. Dev servers (Next, Vite, etc.) run fine in PowerShell on Windows
    // and the port-forwarding / file-watcher quirks of WSL aren't worth
    // inheriting for the dev shell. The Claude (ai-dashboard) tab below
    // still honors claude_env so Claude runs under the right account.
    const devShell = 'powershell.exe';
    const agentEnv: 'powershell' | 'wsl' = claude_env === 'wsl' ? 'wsl' : 'powershell';
    const agentShell = agentEnv === 'wsl' ? 'wsl' : 'powershell.exe';
    const envLabelShort = agentEnv === 'wsl' ? 'WSL' : 'PS';

    const workspaceId = crypto.randomUUID();
    const devTabId = crypto.randomUUID();
    const dashTabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();

    addWorkspace({
      id: workspaceId,
      name: name,
      layout: {
        id: paneId,
        type: 'pane',
        tabIds: [devTabId, dashTabId],
        activeTabId: devTabId,
      },
      allTabs: {
        [devTabId]: {
          id: devTabId,
          type: 'terminal',
          title: `localhost:${port || 'dev'}`,
          shell: devShell,
          cwd: path,
          initialCommand: dev_command,
        },
        [dashTabId]: {
          id: dashTabId,
          type: 'ai-dashboard',
          title: `Claude · ${envLabelShort}`,
          cwd: path,
          agentEnv,
        },
      },
      // metadata.agentShell tracks the AGENT (Claude) shell, NOT the dev
      // shell — handleOpenClaude looks it up by agent shell to reuse this
      // workspace when the user later clicks "Open Claude" for the same env.
      metadata: { projectPath: path, defaultPort: port, agentShell },
    } as any);

    // Navigate to workspaces view
    useWorkspaceStore.getState().setActiveView('workspaces');
  };

  // Open Claude for this project. If a workspace already exists for the project
  // (e.g. opened via localhost), switch to it instead of spawning a duplicate.
  // Otherwise create one whose shell matches the project's AI Environment so
  // Claude runs under the right account (WSL vs PowerShell).
  // Open the project's AI Dashboard for the given environment: a tab listing
  // all of that env's Claude conversations (resume / new / rename live there).
  const handleOpenClaude = async (shell: 'powershell.exe' | 'wsl') => {
    const store = useWorkspaceStore.getState();
    const agentEnv: 'powershell' | 'wsl' = shell === 'wsl' ? 'wsl' : 'powershell';

    // Reuse the project's workspace for this env if it's already open.
    const existing = store.workspaces.find(
      (w) => w.metadata?.projectPath === path && (w.metadata as any)?.agentShell === shell
    );
    if (existing) {
      store.setActiveWorkspace(existing.id);
      store.setActiveView('workspaces');
      return;
    }

    const envLabelShort = shell === 'wsl' ? 'WSL' : 'PS';
    const workspaceId = crypto.randomUUID();
    const tabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();

    addWorkspace({
      id: workspaceId,
      name: `${name} · ${envLabelShort}`,
      layout: { id: paneId, type: 'pane', tabIds: [tabId], activeTabId: tabId },
      allTabs: {
        [tabId]: {
          id: tabId,
          type: 'ai-dashboard',
          title: `Claude · ${envLabelShort}`,
          cwd: path,        // the AI dashboard reads this project path
          agentEnv,         // …in this environment
        },
      },
      metadata: { projectPath: path, defaultPort: port, agentShell: shell },
    } as any);

    store.setActiveView('workspaces');
  };

  const handleSave = async () => {
    try {
      const updatedConfig = {
        name: formData.name,
        path: formData.path || null,
        description: formData.description,
        type: formData.project_type || null,
        dev: {
          port: formData.port ? parseInt(formData.port) : null,
          command: formData.dev_command || null
        },
        instructions: formData.instructions || null,
        install_path: formData.install_path || null,
        executable_path: formData.executable_path || null,
        claude_env: formData.claude_env || null,
        links: {
          github: formData.github || null,
          vercel: formData.vercel || null,
          aws: formData.aws || null,
          other: formData.other_links.length > 0 ? formData.other_links.filter(link => link) : null
        }
      };
      
      // Remove the flat link fields used for the form
      delete (updatedConfig as any).github;
      delete (updatedConfig as any).vercel;
      delete (updatedConfig as any).aws;
      delete (updatedConfig as any).other_links;

      await invoke('save_project_config', { 
        path, 
        configJson: JSON.stringify(updatedConfig) 
      });
      
      setIsEditing(false);
      if (onUpdate) onUpdate();
    } catch (err) {
      console.error('Failed to save config:', err);
      alert('Failed to save configuration: ' + err);
    }
  };

  const handleRemove = async () => {
    setConfirmRemove(false);
    try {
      await invoke('remove_project', { path });
      setIsEditing(false);
      if (onUpdate) onUpdate();
    } catch (err) {
      console.error('Failed to remove project:', err);
      alert('Failed to remove project: ' + err);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      const checked = (e.target as HTMLInputElement).checked;
      setFormData(prev => ({ ...prev, [name]: checked }));
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleOpenLink = async (url?: string) => {
    if (url) {
      try {
        await invoke('open_url', { url });
      } catch (err) {
        console.error('Failed to open link:', err);
      }
    }
  };

  return (
    <div
      className={`relative group bg-surface border border-line rounded-[10px] p-6 transition-all duration-300 flex flex-col h-full hover:-translate-y-[3px] ${isDragging ? 'opacity-50' : ''}`}
      style={{
        boxShadow: isDragging
          ? `0 0 40px -10px ${accentColor}66`
          : 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 24px -16px rgba(0,0,0,0.9)',
      } as any}
    >
      <div
        className="absolute inset-0 rounded-[10px] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{
          boxShadow: `inset 0 0 0 1px ${accentColor}55, 0 20px 40px -24px ${accentColor}55`
        }}
      />
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            {isEditing ? (
              <input 
                name="name"
                value={formData.name}
                onChange={handleInputChange}
                className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xl font-semibold text-white w-full focus:outline-none focus:border-brand-light/40"
              />
            ) : (
            <h3 className="text-xl font-semibold transition-colors" style={{ color: accentColor }}>{name}</h3>
            )}
            
            <Tooltip text={isEditing ? "Close settings" : "Project Settings"}>
              <button
                onClick={() => setIsEditing(!isEditing)}
                className={`p-1 px-2 transition-colors rounded hover:bg-white/5 ${isEditing ? 'text-brand-light bg-brand-light/10' : 'text-white/20 hover:text-brand-light'}`}
              >
                <Settings size={14} />
              </button>
            </Tooltip>

            <ChronoToggle projectPath={path} />

            {dragHandleProps && (
              <Tooltip text="Drag to reorder">
                <div
                  {...dragHandleProps}
                  className="p-1 px-2 cursor-grab active:cursor-grabbing text-white/10 hover:text-white/30 transition-colors rounded hover:bg-white/5"
                >
                  <GripVertical size={18} />
                </div>
              </Tooltip>
            )}

            {!isEditing && (
              <Tooltip text={links?.github ? "View Source (GitHub)" : "No GitHub link configured"}>
                <button
                  onClick={() => links?.github && handleOpenLink(links.github)}
                  disabled={!links?.github}
                  className={`p-1.5 rounded-md bg-white/5 transition-all flex items-center gap-1.5 ${
                    links?.github ? "text-white/30 hover:text-white hover:bg-white/10" : "opacity-30 cursor-not-allowed text-white/10"
                  }`}
                >
                  <Github size={14} />
                  <span className="text-[10px] uppercase tracking-tighter font-bold">Repo</span>
                </button>
              </Tooltip>
            )}
          </div>

          {isEditing ? (
            <textarea 
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="Description"
              className="bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-white/60 w-full h-16 focus:outline-none focus:border-brand-light/40 mt-2 resize-none"
            />
          ) : (
            <p className="text-sm text-ink-dim mb-3 line-clamp-2">{description || "Local development project"}</p>
          )}

          {isEditing ? (
            <div className="flex flex-col gap-2 mt-2">
              <label className="text-[9px] uppercase tracking-widest text-white/30 font-bold ml-1">Instructions / Context</label>
              <textarea 
                name="instructions"
                value={formData.instructions}
                onChange={handleInputChange}
                placeholder="AI Instructions or project context..."
                className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/60 w-full h-16 focus:outline-none focus:border-brand-light/40 resize-none font-mono"
              />
            </div>
          ) : instructions && (
            <p className="text-[10px] text-brand-light/40 italic mt-1 line-clamp-1 border-l-2 border-brand-light/10 pl-2">
              {instructions}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-3">
            {isEditing ? (
              <input
                name="project_type"
                value={formData.project_type}
                onChange={handleInputChange}
                placeholder="Type (e.g. Tauri)"
                className="bg-white/5 border border-white/10 rounded-full px-3 py-1 text-xs text-brand-light w-36 focus:outline-none focus:border-brand-light/40 transition-all"
              />
            ) : (
              <Tooltip text={`Project type${project_type === 'Unknown' ? ' — not auto-detected, set it in settings' : ''}`}>
                <span className="text-xs font-medium px-2.5 py-1 rounded-md bg-surface-raised text-ink-dim border border-line">
                  {project_type}
                </span>
              </Tooltip>
            )}

            {!isEditing && (
              <Tooltip text={`AI environment: ${envLabel}`} className="shrink-0">
                <span className="text-xs font-medium px-2.5 py-1 rounded-md bg-surface-raised text-ink-dim border border-line flex items-center gap-1.5">
                  <Terminal size={11} className="text-ink-dim" />
                  {envLabel}
                </span>
              </Tooltip>
            )}

            {isEditing ? (
              <div className="flex items-center gap-2 flex-1">
                <span className="text-[10px] text-white/20 uppercase font-bold">Port:</span>
                <input 
                  name="port"
                  value={formData.port}
                  onChange={handleInputChange}
                  placeholder="Port"
                  className="bg-white/5 border border-white/10 rounded px-2 py-0.5 text-xs text-brand-light w-20 focus:outline-none focus:border-brand-light/40"
                />
              </div>
            ) : (
              <Tooltip text={!port ? 'No port configured' : dev_command ? `Launch dev server: ${dev_command}` : 'No dev command'}>
                <button
                  onClick={handleRunDev}
                  disabled={!port}
                  className={`text-xs font-mono px-2 py-1 rounded-md border transition-all duration-200 hover:scale-105 active:scale-95 ${
                    !port ? "opacity-30 cursor-not-allowed border-line text-ink-faint"
                    : isPortActive
                      ? "text-[#06210f] font-semibold shadow-lg"
                      : "text-ink-dim bg-surface-raised border-line hover:border-white/25 hover:text-ink"
                  }`}
                  style={{
                    backgroundColor: isPortActive ? '#22C55E' : undefined,
                    borderColor: isPortActive ? '#22C55E' : undefined,
                    boxShadow: isPortActive ? '0 0 15px -5px #22C55E' : undefined
                  }}
                >
                  localhost:{port || "----"}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        {!isEditing && <StatusBadge status={status} />}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-white/10">
          <EditField label="Folder Path" name="path" value={formData.path} onChange={handleInputChange} placeholder="C:\\path\\to\\project" />
          <EditField label="Dev Cmd" name="dev_command" value={formData.dev_command} onChange={handleInputChange} placeholder="e.g. npm run dev" />
          <EditField label="Install" name="install_path" value={formData.install_path} onChange={handleInputChange} placeholder="Relative or absolute path" />
          <EditField label="App Path" name="executable_path" value={formData.executable_path} onChange={handleInputChange} placeholder="Relative or absolute path" />

          <div className="flex flex-col gap-1">
            <label className="text-[9px] uppercase tracking-widest text-white/30 font-bold ml-1">AI Environment</label>
            <div className="flex gap-1.5">
              {[
                { value: 'powershell', label: 'PowerShell' },
                { value: 'wsl', label: 'WSL' },
                { value: '', label: 'Default' },
              ].map((opt) => {
                const selected = (formData.claude_env || '') === opt.value;
                return (
                  <button
                    key={opt.value || 'default'}
                    type="button"
                    onClick={() => setFormData((prev) => ({ ...prev, claude_env: opt.value }))}
                    className={`flex-1 h-[30px] rounded-md border text-[9px] font-bold uppercase tracking-wider transition-all ${
                      selected
                        ? 'bg-brand/20 border-brand-light/40 text-brand-light'
                        : 'bg-white/5 border-white/10 text-white/40 hover:text-white hover:border-white/20'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-2 mt-1">
            <EditField label="GitHub" name="github" value={formData.github} onChange={handleInputChange} placeholder="URL" />
            <EditField label="Vercel" name="vercel" value={formData.vercel} onChange={handleInputChange} placeholder="URL" />
            <EditField label="AWS" name="aws" value={formData.aws} onChange={handleInputChange} placeholder="URL" />
            
            <div className="col-span-3 space-y-2 mt-2">
              <label className="text-[9px] uppercase tracking-widest text-white/30 font-bold ml-1">Other Links</label>
              {formData.other_links.map((link, index) => (
                <div key={index} className="flex gap-2">
                  <input 
                    value={link}
                    onChange={(e) => {
                      const newLinks = [...formData.other_links];
                      newLinks[index] = e.target.value;
                      setFormData(prev => ({ ...prev, other_links: newLinks }));
                    }}
                    placeholder="Custom Link URL"
                    className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/60 focus:outline-none focus:border-brand-light/40"
                  />
                  <button 
                    onClick={() => {
                      const newLinks = formData.other_links.filter((_, i) => i !== index);
                      setFormData(prev => ({ ...prev, other_links: newLinks }));
                    }}
                    className="p-1 text-white/20 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button 
                onClick={() => setFormData(prev => ({ ...prev, other_links: [...prev.other_links, ""] }))}
                className="w-full py-1.5 border border-dashed border-white/10 rounded text-[10px] text-white/30 hover:text-white/50 hover:border-white/20 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={12} /> Add Custom Link
              </button>
            </div>
          </div>

          <div className="flex justify-between items-center gap-2 mt-4">
            <Tooltip text="Remove this project from the dashboard (does not delete the folder)">
              <button
                onClick={() => setConfirmRemove(true)}
                className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400/80 hover:bg-red-500/20 hover:text-red-400 transition-colors text-xs font-bold uppercase tracking-wider flex items-center gap-2"
              >
                <Trash2 size={14} /> Remove
              </button>
            </Tooltip>
            <div className="flex gap-2">
            <button
              onClick={() => setIsEditing(false)}
              className="px-4 py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 transition-colors text-xs font-bold uppercase tracking-wider flex items-center gap-2"
            >
              <X size={14} /> Cancel
            </button>
            <button 
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark transition-all shadow-lg shadow-brand/20 text-xs font-bold uppercase tracking-wider flex items-center gap-2"
            >
              <Save size={14} /> Save Config
            </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-[1.125rem] mt-auto pt-4 border-t border-line-soft">
          {/* Group 1: Local Folder — folders on disk */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold w-24 shrink-0 whitespace-nowrap">Local Folder</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ActionButton
                icon={<Folder size={14} />}
                label="Project Folder"
                onClick={handleOpenFolder}
                title="Open in Explorer"
              />

              <ActionButton
                icon={<Folder size={14} />}
                label="Install Folder"
                onClick={() => install_path && handleShowInFolder(install_path)}
                disabled={!install_path}
                title={install_path ? "Show Installer in Folder" : "No install path configured"}
              />
            </div>
          </div>

          {/* Group 2: AI Edition — Claude in each shell */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold w-24 shrink-0 whitespace-nowrap">AI Edition</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ActionButton
                icon={<Sparkles size={14} />}
                label="Claude PS"
                onClick={() => handleOpenClaude('powershell.exe')}
                primary={claude_env === 'powershell'}
                title="Open Claude in PowerShell"
              />

              <ActionButton
                icon={<Sparkles size={14} />}
                label="Claude WSL"
                onClick={() => handleOpenClaude('wsl')}
                primary={claude_env === 'wsl'}
                title="Open Claude in WSL"
              />
            </div>
          </div>

          {/* Group 3: Apps — external programs */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold w-24 shrink-0 whitespace-nowrap">Apps</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ActionButton
                icon={<Code2 size={14} />}
                label="VS Code"
                onClick={handleOpenVSCode}
                title="Open in Visual Studio Code"
              />

              <ActionButton
                icon={<ExternalLink size={14} />}
                label="Launch Program"
                onClick={() => executable_path && handleOpenPath(executable_path)}
                disabled={!executable_path}
                title={executable_path ? "Launch Application" : "No executable path configured"}
              />
            </div>
          </div>

          {/* Group 4: Links */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold w-24 shrink-0 whitespace-nowrap">Links</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ActionButton
                icon={<Github size={14} />}
                label="GitHub"
                onClick={() => links?.github && handleOpenLink(links.github)}
                disabled={!links?.github}
                title={links?.github ? "Open GitHub repository" : "No GitHub link configured"}
              />
              <ActionButton
                icon={<Globe size={14} />}
                label="Vercel"
                onClick={() => links?.vercel && handleOpenLink(links.vercel)}
                disabled={!links?.vercel}
                title={links?.vercel ? "Open Vercel deployment" : "No Vercel link configured"}
              />
              <ActionButton
                icon={<Cloud size={14} />}
                label="AWS"
                onClick={() => links?.aws && handleOpenLink(links.aws)}
                disabled={!links?.aws}
                title={links?.aws ? "Open AWS console" : "No AWS link configured"}
              />
              {links?.other?.map((url, i) => (
                <ActionButton
                  key={i}
                  icon={<Link size={14} />}
                  label={`Link ${i + 1}`}
                  onClick={() => handleOpenLink(url)}
                  title={url}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmRemove && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setConfirmRemove(false)}
        >
          <div
            className="w-full max-w-sm bg-[#18181b] border border-white/10 shadow-2xl rounded-[10px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <Trash2 size={16} className="text-red-400" />
              <h3 className="text-sm font-bold text-white">Remove “{name}”?</h3>
            </div>
            <p className="text-xs text-white/50 mb-6 leading-relaxed">
              This only removes it from the Equilibrium dashboard. The folder on your disk is left untouched.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(false)}
                className="px-4 py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 transition-colors text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={handleRemove}
                className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-xs font-bold uppercase tracking-wider flex items-center gap-2"
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditField({ label, name, value, onChange, placeholder }: { label: string, name: string, value: string, onChange: (e: any) => void, placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] uppercase tracking-widest text-white/30 font-bold ml-1">{label}</label>
      <input 
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white/70 w-full focus:outline-none focus:border-brand-light/40 transition-all font-mono"
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    online: "bg-emerald-500/20 text-emerald-400 border-emerald-500/20",
    local: "bg-brand-light/20 text-brand-light border-brand-light/20",
    deployed: "bg-purple-500/20 text-purple-400 border-purple-500/20",
  };
  
  const badgeClass = colors[status] || "bg-white/5 text-white/40 border-white/5";

  return (
    <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded border ${badgeClass}`}>
      {status}
    </span>
  );
}

// Styled hover bubble. Pure CSS via a *named* group (`group/tip`) so it never
// collides with the card's own `group` hover. Renders children untouched when
// there's no text. Bubble sits above the trigger and is click-through.
function Tooltip({ text, children, className = "" }: { text?: string; children: React.ReactNode; className?: string }) {
  if (!text) return <>{children}</>;
  return (
    <span className={`relative group/tip inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-md border border-white/10 bg-[#0A0C10] px-2 py-1 text-[10px] font-medium text-white/80 opacity-0 shadow-xl transition-all duration-150 group-hover/tip:translate-y-0 group-hover/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function ActionButton({ icon, label, onClick, title, primary = false, disabled = false }: { icon: React.ReactNode, label?: string, onClick?: () => void, title?: string, primary?: boolean, disabled?: boolean }) {
  return (
    <Tooltip text={title} className="shrink-0">
      <button
        onClick={disabled ? undefined : onClick}
        aria-label={title || label}
        disabled={disabled}
        className={`
        flex items-center gap-1.5 px-2 py-1.5 rounded-md transition-all duration-200 border text-xs font-medium shrink-0
        ${disabled ? "opacity-30 cursor-not-allowed border-line grayscale pointer-events-none" : ""}
        ${!disabled && primary
          ? "bg-alive text-[#06210f] border-alive shadow-lg shadow-alive/20 hover:brightness-110"
          : !disabled ? "bg-surface-raised text-ink-dim border-line hover:bg-surface-hi hover:text-ink hover:border-white/20" : ""}
      `}>
        {icon}
        {label && <span className="uppercase tracking-wider text-[9px] font-bold">{label}</span>}
      </button>
    </Tooltip>
  );
}

// Per-project time-tracking toggle shown in the card header. When running:
// pause icon + live "Nm" badge on an amber pulsing background. When idle:
// clock icon, dim. Multiple of these can be active at once across projects
// (timers compose freely — see useTimeStore).
function ChronoToggle({ projectPath }: { projectPath: string }) {
  const entries = useTimeStore((s) => s.entries);
  const running = useTimeStore((s) => s.running);
  const toggle = useTimeStore((s) => s.toggle);
  const [backdating, setBackdating] = useState(false);
  const runningId = running[projectPath];
  const runningEntry = runningId ? entries.find((e) => e.id === runningId) : undefined;
  // Only animate / re-render when this card is actually counting — saves
  // ticking 50 idle ProjectCards every 30s on a busy dashboard.
  const now = useNow(runningEntry ? 30_000 : 60_000);
  const liveMs = runningEntry ? entryDurationMs(runningEntry, now) : 0;
  const isRunning = !!runningEntry;
  return (
    <>
      <Tooltip text={isRunning ? `Tracking · click to stop` : `Start tracking · right-click to backdate the start`}>
        <button
          onClick={(e) => { e.stopPropagation(); toggle(projectPath); }}
          // Right-click on the idle toggle = "I started earlier than now".
          // Opens a picker to backdate the start while keeping it running.
          onContextMenu={(e) => {
            if (isRunning) return;
            e.preventDefault();
            e.stopPropagation();
            setBackdating(true);
          }}
          className={`p-1 px-2 rounded transition-colors flex items-center gap-1.5 ${
            isRunning
              ? 'bg-amber-500/25 text-amber-300 hover:bg-amber-500/35'
              : 'text-white/45 hover:text-amber-300 hover:bg-white/5'
          }`}
        >
          {isRunning ? <Pause size={14} /> : <Clock size={14} />}
          {isRunning && (
            <span className="text-[10px] font-mono font-bold tabular-nums tracking-tight">
              {formatMinutes(liveMs)}
            </span>
          )}
        </button>
      </Tooltip>
      {backdating && (
        <BackdateStartModal projectPath={projectPath} onClose={() => setBackdating(false)} />
      )}
    </>
  );
}

// "datetime-local" wants "YYYY-MM-DDTHH:mm" in LOCAL time (mirror of the
// helpers in TimeView — kept local to avoid a cross-component export).
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Backdated-start picker. Opened by right-clicking an idle ChronoToggle.
// Creates a RUNNING entry beginning at the chosen past instant and counting
// live until the user stops it — "I actually started at 8:00, keep tracking".
// Default seed: the end of this project's most recent session today (the
// natural "resume where the last block ended" case), else 30 min ago.
// Exported so the sidebar's WorkspaceChronoToggle can reuse the same picker.
export function BackdateStartModal({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const entries = useTimeStore((s) => s.entries);
  const startAt = useTimeStore((s) => s.startAt);

  const defaultStart = (() => {
    const now = Date.now();
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    let lastEnd = 0;
    for (const e of entries) {
      if (e.project_path === projectPath && !e.running) lastEnd = Math.max(lastEnd, e.end_ms);
    }
    return lastEnd >= startOfToday.getTime() ? lastEnd : now - 30 * 60_000;
  })();

  const [start, setStart] = useState(() => toDatetimeLocal(defaultStart));
  const [error, setError] = useState<string | null>(null);

  const commit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sMs = Date.parse(start);
    if (Number.isNaN(sMs)) { setError('Invalid date/time'); return; }
    if (sMs > Date.now()) { setError('Start cannot be in the future'); return; }
    startAt(projectPath, sMs);
    onClose();
  };

  const elapsedMin = Math.max(0, Math.round((Date.now() - (Date.parse(start) || Date.now())) / 60_000));

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div className="w-full max-w-xl bg-[#18181b] border border-white/10 rounded-[10px] shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-white uppercase tracking-[0.2em]">Backdate start</h3>
          <button onClick={onClose} className="p-1 text-white/30 hover:text-white"><X size={14} /></button>
        </div>
        <p className="text-xs text-white/40 mb-5">
          Start the chrono at a past time and keep tracking live until you stop it.
        </p>

        <DateTimeFlipField label="Started at" value={start} onChange={setStart} />
        <p className="text-[11px] text-white/35 mb-2">≈ {formatMinutes(elapsedMin * 60_000)} ago — counting continues from here.</p>

        {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md bg-white/5 text-white/60 hover:bg-white/10 text-xs font-bold uppercase tracking-wider transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="px-4 py-2 rounded-md bg-brand text-white hover:bg-brand-dark text-xs font-bold uppercase tracking-wider transition-colors"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
