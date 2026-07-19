'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Keyboard } from 'lucide-react';
import cheatsheet from '@/content/cheatsheet.md';

// Last-updated stamp — shown in the header so we can tell at a glance whether
// the bundled cheat sheet is still current vs. recent Claude Code releases.
// Bump this date whenever you edit src/content/cheatsheet.md.
const LAST_UPDATED = '2026-05-10';

export default function CheatSheetView() {
  return (
    <div className="max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="mb-10 flex items-end justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-brand/10 text-brand rounded-2xl">
            <Keyboard size={28} />
          </div>
          <div>
            <h1 className="text-4xl font-bold text-white tracking-tight">Claude Code Cheat Sheet</h1>
            <p className="text-white/40 text-sm font-medium tracking-wide mt-1">
              Reference for shortcuts, slash commands and CLI flags.
            </p>
          </div>
        </div>
        <span className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-bold whitespace-nowrap">
          Updated {LAST_UPDATED}
        </span>
      </header>

      <article className="cheatsheet-prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{cheatsheet}</ReactMarkdown>
      </article>
    </div>
  );
}
