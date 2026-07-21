#!/usr/bin/env node
/**
 * Drops dependencies that nothing actually imports.
 *
 * @aksel/structjs — the only real dependency of node-broadlink — declares
 * `npm-name` in its package.json, which drags in `ky`, `registry-auth-token`
 * and 20-odd others. Its entire source is one 3.5KB file that never imports
 * npm-name; the entry is simply a mistake upstream. Shipping it would put an
 * HTTP client and an npmrc token reader inside every user's plugin folder for
 * no reason at all.
 *
 * package.json also overrides npm-name to ^8.1.0. That is a separate concern:
 * pruning keeps the shipped ZIP clean, but the lockfile is what security
 * scanners read, and npm-name@5 resolved url-regex 5.0.0 (CVE-2020-7661) with
 * no fixed release available. npm-name@8 reaches is-url-superb 6, which uses
 * the native URL API instead. Both mechanisms are still needed — the override
 * makes the lockfile honest, this script keeps the payload small.
 *
 * Rather than hardcode a delete list, this walks the real dependency graph
 * from package.json and removes whatever is unreachable. The guard below means
 * that if a future structjs genuinely starts importing npm-name, this exits
 * non-zero instead of quietly shipping something broken.
 */
import { readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');

if (!existsSync(modules)) {
  console.error('node_modules not found — run npm install first.');
  process.exit(1);
}

const readPkg = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

// Confirm the upstream bug is still just a bug before acting on it.
const structDir = join(modules, '@aksel', 'structjs');
if (existsSync(structDir)) {
  const sources = readdirSync(structDir).filter((f) => f.endsWith('.js'));
  const importsNpmName = sources.some((f) => readFileSync(join(structDir, f), 'utf8').includes('npm-name'));
  if (importsNpmName) {
    console.error('@aksel/structjs now imports npm-name — pruning would break it. Aborting.');
    process.exit(1);
  }
}

const IGNORED_DEPS = new Set(['npm-name']);

// Walk from the plugin's own dependencies, skipping edges we know are phantom.
const keep = new Set();
const queue = Object.keys(readPkg(root)?.dependencies || {});
while (queue.length) {
  const name = queue.shift();
  if (keep.has(name) || IGNORED_DEPS.has(name)) continue;
  keep.add(name);
  const pkg = readPkg(join(modules, name));
  if (!pkg) continue;
  for (const dep of Object.keys(pkg.dependencies || {})) {
    if (!keep.has(dep) && !IGNORED_DEPS.has(dep)) queue.push(dep);
  }
}

// Enumerate what is actually on disk, handling @scope/name folders.
const installed = [];
for (const entry of readdirSync(modules)) {
  if (entry.startsWith('.')) continue;
  const full = join(modules, entry);
  if (!statSync(full).isDirectory()) continue;
  if (entry.startsWith('@')) {
    for (const sub of readdirSync(full)) installed.push(`${entry}/${sub}`);
  } else if (entry !== '.bin') {
    installed.push(entry);
  }
}

let removed = 0;
let bytes = 0;
const sizeOf = (dir) => {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return total;
};

for (const name of installed) {
  if (keep.has(name)) continue;
  const dir = join(modules, name);
  bytes += sizeOf(dir);
  rmSync(dir, { recursive: true, force: true });
  removed++;
}

// Emptying a scope leaves the @scope folder behind; don't ship those.
for (const entry of readdirSync(modules)) {
  if (!entry.startsWith('@')) continue;
  const dir = join(modules, entry);
  if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

console.log(`Pruned ${removed} unused package(s), ${(bytes / 1024).toFixed(0)}KB.`);
