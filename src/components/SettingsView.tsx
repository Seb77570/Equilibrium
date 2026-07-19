'use client';

import { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { Save, Folder, Info } from "lucide-react";

interface AppSettings {
  default_agent_command?: string;
}

// Always start with an editable empty object so the form is usable even if
// `get_settings` throws (used to leave the inputs uneditable forever).
const EMPTY_SETTINGS: AppSettings = { default_agent_command: '' };

export default function SettingsView() {
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const s = await invoke<AppSettings>('get_settings');
        setSettings(s);
      } catch (err) {
        console.error('Failed to fetch settings:', err);
        setMessage({ type: 'error', text: `Could not load settings: ${err}. Edit and save to create a fresh config.` });
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await invoke('save_settings', { settings });
      setMessage({ type: 'success', text: 'Settings saved successfully! Restart the app to apply changes if needed.' });
    } catch (err) {
      console.error('Failed to save settings:', err);
      setMessage({ type: 'error', text: 'Failed to save settings. Check permissions.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-20 text-center text-white/30 italic animate-pulse">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header>
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Settings</h1>
        <p className="text-white/40 font-medium tracking-wide">Configure your Equilibrium experience.</p>
      </header>

      <div className="space-y-8">
        <section className="bg-white/[0.02] border border-white/5 rounded-3xl p-8 space-y-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-brand/10 text-brand rounded-xl">
              <Folder size={20} />
            </div>
            <h2 className="text-xl font-semibold text-white">Workspace Configuration</h2>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs uppercase tracking-widest text-white/30 font-bold ml-1">Default Agent Command</label>
              <div className="flex gap-3">
                <input 
                  type="text"
                  value={settings.default_agent_command || ""}
                  onChange={(e) => setSettings(s => ({ ...s, default_agent_command: e.target.value }))}
                  placeholder="claude --dangerously-skip-permissions"
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-brand/40 transition-colors font-mono"
                />
              </div>
              <p className="text-[10px] text-white/20 ml-1 italic">
                The command pre-typed in new project terminals.
              </p>
            </div>
          </div>
        </section>

        <section className="bg-brand/5 border border-brand/10 rounded-3xl p-6 flex gap-4 items-start">
          <div className="p-2 bg-brand/20 text-brand rounded-lg mt-0.5">
            <Info size={16} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white/80">Data Transparency</h3>
            <p className="text-xs text-white/40 leading-relaxed">
              Equilibrium is designed to be portable and transparent. Your configuration is stored in JSON files:
              <br />• <strong>settings.json</strong>: Application preferences.
              <br />• <strong>projects.json</strong>: Your added projects and their metadata.
              <br />• <strong>dashboard.json</strong>: Section names, colors, and project order.
            </p>
          </div>
        </section>

        <div className="flex items-center justify-between pt-4">
          {message && (
            <div className={`text-sm font-medium ${message.type === 'success' ? 'text-emerald-400' : 'text-red-400'} animate-in fade-in slide-in-from-left-2`}>
              {message.text}
            </div>
          )}
          <div className="flex-1" />
          <button 
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-8 py-3 bg-brand hover:bg-brand-light text-white font-bold rounded-xl transition-all shadow-lg shadow-brand/20 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
            <span>{saving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
