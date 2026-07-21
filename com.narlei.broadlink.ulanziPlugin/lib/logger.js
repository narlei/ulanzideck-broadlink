import { appendFileSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

function logDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'UlanziDeck');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'UlanziDeck', 'Logs');
  return join(tmpdir(), 'ulanzideck-logs');
}

let logPath = null;
try {
  const dir = logDirectory();
  mkdirSync(dir, { recursive: true });
  logPath = join(dir, 'broadlink.log');
  // Start each session from a bounded file rather than growing forever.
  if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) rmSync(logPath, { force: true });
} catch {
  logPath = null;
}

export const LOG_PATH = logPath;

const stamp = () => new Date().toISOString().slice(11, 23);

/**
 * Writes to both the Studio's stdout pipe and a file on disk. The pipe is
 * invisible unless you are attached to the parent process, which makes a
 * user-reported "it just hangs" impossible to diagnose; the file is something
 * they can send.
 */
export function log(...parts) {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()))
    .join(' ');
  const formatted = `${stamp()} ${line}`;
  console.log('[broadlink]', line);
  if (!logPath) return;
  try {
    appendFileSync(logPath, formatted + '\n');
  } catch {
    /* logging must never take the plugin down */
  }
}

/** Renders an error the way the device meant it, not the way it stringifies. */
export function describeError(err) {
  const raw = String(err?.message ?? '').trim();
  if (!/^\d+$/.test(raw)) return raw || 'unknown error';
  const value = Number(raw);
  const signed = value > 0x7fff ? value - 0x10000 : value;
  const names = {
    '-1': 'authentication failed',
    '-2': 'logged out',
    '-3': 'device offline',
    '-4': 'command not supported',
    // Broadlink's own table calls -5 a storage error, but an RM4 Pro answers
    // -5 on every learning poll right up until the moment it captures — it
    // means "nothing yet" in practice. Labelling it "storage error" sends
    // people hunting for a full device that isn't the problem.
    '-5': 'nothing captured yet',
    '-6': 'structure abnormal',
    '-7': 'control key expired',
    '-8': 'send error',
    '-9': 'write error',
    '-10': 'read error',
    '-4012': 'device control ID error',
  };
  return `code ${signed} (${names[String(signed)] || 'unknown'})`;
}
