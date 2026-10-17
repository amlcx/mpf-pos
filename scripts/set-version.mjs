// Writes one version (from the release tag) into every place that carries it,
// so nobody edits version numbers by hand.
// Usage: node scripts/set-version.mjs 1.4.0
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/set-version.mjs X.Y.Z');
  process.exit(1);
}

// fileURLToPath, not .pathname: the installer is built on Windows.
const root = fileURLToPath(new URL('..', import.meta.url));
const changed = [];

function setJsonVersion(path) {
  if (!existsSync(path)) return;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  // tauri.conf.json may point "version" at a package.json instead of a
  // number; that package.json is updated below, so leave the pointer alone.
  if (typeof json.version === 'string' && json.version.endsWith('.json')) return;
  // Packages without a version (internal workspace libraries) stay that way.
  if (!('version' in json)) return;
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  changed.push(path);
}

function setCargoVersion(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  // A crate that inherits its version takes it from the workspace root.
  if (/\[package\][^[]*?\nversion\.workspace\s*=\s*true/.test(text)) {
    setWorkspaceCargoVersion(join(root, 'Cargo.toml'));
    return;
  }
  // Only the version line inside [package], not dependency versions.
  const next = text.replace(
    /(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (next === text) throw new Error(`No [package] version found in ${path}`);
  writeFileSync(path, next);
  changed.push(path);
}

function setWorkspaceCargoVersion(path) {
  const text = readFileSync(path, 'utf8');
  const next = text.replace(
    /(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (next === text) throw new Error(`No [workspace.package] version in ${path}`);
  writeFileSync(path, next);
  changed.push(path);
}

setJsonVersion(join(root, 'package.json'));
for (const group of ['apps', 'packages']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    setJsonVersion(join(dir, name, 'package.json'));
  }
}
setJsonVersion(join(root, 'apps/desktop/src-tauri/tauri.conf.json'));
setCargoVersion(join(root, 'apps/desktop/src-tauri/Cargo.toml'));

console.log(`Set version ${version} in:\n  ${changed.join('\n  ')}`);
