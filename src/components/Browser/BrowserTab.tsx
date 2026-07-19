'use client';
import { useState, useRef, useEffect } from 'react';
import { RefreshCw, ExternalLink, Shield } from 'lucide-react';

interface BrowserTabProps {
  id: string;
  initialUrl?: string;
}

// NOTE: this renders the project URL in a plain <iframe>. It works in dev
// (Tauri host on http://localhost:4321 ↔ iframe on http://localhost:3000 share
// eTLD+1 = `localhost` → cookies are first-party). In installed/prod builds
// the host is http://tauri.localhost so the iframe IS third-party and
// WebView2 silently drops Set-Cookie — Supabase login then loops back to the
// form. The proper fix is a Tauri custom URI proxy that serves localhost:3000
// through the parent's own origin (so the iframe stays first-party even in
// prod). Not done in this version — to be tackled in a follow-up.

export default function BrowserTab({ id, initialUrl }: BrowserTabProps) {
  const [url, setUrl] = useState(initialUrl || 'http://localhost:3000');
  const [inputUrl, setInputUrl] = useState(url);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      setInputUrl(initialUrl);
    }
  }, [initialUrl]);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    let finalUrl = inputUrl;
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = `http://${finalUrl}`;
    }
    setUrl(finalUrl);
  };

  const handleReload = () => {
    if (iframeRef.current) {
      const currentUrl = url;
      setUrl('about:blank');
      setTimeout(() => setUrl(currentUrl), 10);
    }
  };

  return (
    <div className="flex flex-col w-full h-full bg-[#0d0e12]">
      {/* URL Bar */}
      <div className="flex items-center gap-3 p-2 px-4 bg-[#1a1b26] border-b border-white/5">
        <div className="flex items-center gap-2">
          <button
            onClick={handleReload}
            className="p-1.5 rounded-md text-white/40 hover:text-white hover:bg-white/5 transition-colors"
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <form onSubmit={handleNavigate} className="flex-1">
          <div className="relative group">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
              <Shield size={12} className={url.startsWith('https') ? 'text-emerald-400' : 'text-amber-400'} />
            </div>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-[#0d0e12] border border-white/10 rounded-lg text-xs text-white/70 focus:outline-none focus:border-brand-light/40 focus:text-white transition-all"
              placeholder="Enter URL (e.g. localhost:3000)"
            />
          </div>
        </form>

        <button
          onClick={() => window.open(url, '_blank')}
          className="p-1.5 rounded-md text-white/40 hover:text-white hover:bg-white/5 transition-colors"
          title="Open in System Browser"
        >
          <ExternalLink size={14} />
        </button>
      </div>

      {/* Browser View */}
      <div className="flex-1 relative bg-white">
        <iframe
          ref={iframeRef}
          src={url}
          className="absolute inset-0 w-full h-full border-none"
        />

        {/* Connection Tip */}
        {url.includes('localhost') && (
          <div className="absolute bottom-4 right-4 pointer-events-none opacity-50">
            <div className="bg-black/80 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 text-[10px] text-white/50">
              Internal Preview • Ensure your dev server is running
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
