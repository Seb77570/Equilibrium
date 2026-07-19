// Bumps the patch version in package.json AND src-tauri/tauri.conf.json before
// a Tauri build, so every `npm run tauri:build` produces a fresh, version-
// incremented installer (e.g. Equilibrium_1.0.1_x64-setup.exe) instead of
// overwriting the previous one. Both files are kept in sync.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');

// Matches the first `"version": "x.y.z"` — targeted replace keeps each file's
// existing formatting (no full JSON re-serialization, so diffs stay minimal).
const VERSION_RE = /("version":\s*")(\d+)\.(\d+)\.(\d+)(")/;

const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
const m = pkgRaw.match(VERSION_RE);
if (!m) {
  console.error('[bump-version] no "version" field found in package.json');
  process.exit(1);
}
const current = `${m[2]}.${m[3]}.${m[4]}`;
const next = `${m[2]}.${m[3]}.${Number(m[4]) + 1}`;

fs.writeFileSync(pkgPath, pkgRaw.replace(VERSION_RE, `$1${next}$5`));
const confRaw = fs.readFileSync(confPath, 'utf8');
fs.writeFileSync(confPath, confRaw.replace(VERSION_RE, `$1${next}$5`));

console.log(`[bump-version] ${current} -> ${next}`);
