import { helloUnicast, describe } from './net.js';
import { log, describeError } from './logger.js';

const CALL_TIMEOUT_MS = 6000;
const HELLO_TIMEOUT_MS = 4000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// node-broadlink's sendPacket registers a bare `socket.once('message')` and
// never arms a timer, so a device that is unplugged mid-session leaves the
// promise pending forever. In a plugin process that lives for days that is a
// permanent leak and a button that stops responding with no error to show.
// The device reports failures as signed codes, which node-broadlink surfaces
// unsigned and stringified — `new Error("65535")` for -1. A message that is
// nothing but digits therefore means the datagram made the round trip and the
// device replied with a status; anything else (our timeout text, discovery
// messages, socket errors) is a transport problem.
const errorCode = (err) => {
  const raw = String(err?.message ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0x7fff ? value - 0x10000 : value;
};

// Codes that mean this session is finished and only a fresh auth will help.
// Everything else the device says — storage, read failures, the errors that
// learning produces on every poll while it waits — leaves the session valid.
const SESSION_DEAD = new Set([
  -1, // authentication failed
  -2, // you have been logged out
  -7, // control key is expired
  -4012, // device control ID error
]);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Keeps one authenticated device per IP and hands out serialized access to it.
 *
 * Serialization is not optional here: the library resolves each request with
 * the next datagram that arrives on the socket, so two commands in flight at
 * once can be handed each other's reply. Every call therefore queues behind
 * the previous one for that device.
 */
export default class DevicePool {
  #entries = new Map();

  #entry(host) {
    let entry = this.#entries.get(host);
    if (!entry) {
      entry = { device: null, queue: Promise.resolve(), info: null };
      this.#entries.set(host, entry);
    }
    return entry;
  }

  // Drops the cached device so the next call builds a fresh one. Also the
  // recovery path after a timeout: the abandoned socket may still be holding a
  // stale `once('message')` listener that would otherwise resolve somebody
  // else's request, so we never reuse it.
  forget(host) {
    const entry = this.#entries.get(host);
    if (!entry) return;
    entry.device = null;
    entry.info = null;
  }

  async #connect(host) {
    const found = await withTimeout(helloUnicast(host, HELLO_TIMEOUT_MS), HELLO_TIMEOUT_MS * 2, `discovery of ${host}`);
    if (!found) throw new Error(`No Broadlink device answered at ${host}`);
    if (found.isLocked) {
      throw new Error(
        `${found.model} at ${host} is locked to the cloud. Open the Broadlink app, ` +
          `find the device properties and turn "Lock device" off.`
      );
    }
    await withTimeout(found.auth(), CALL_TIMEOUT_MS, `auth with ${host}`);
    return found;
  }

  async #exec(host, fn, allowRetry) {
    const entry = this.#entry(host);
    try {
      if (!entry.device) {
        log(`pool: opening a new session with ${host}`);
        entry.device = await this.#connect(host);
        entry.info = describe(entry.device);
        log(`pool: session established with ${entry.info.model} at ${host}`);
      }
      return await withTimeout(Promise.resolve(fn(entry.device)), CALL_TIMEOUT_MS, `command to ${host}`);
    } catch (err) {
      // A device that answers with an error code is a healthy device saying
      // no. Learning leans on this constantly — "nothing captured yet" arrives
      // as an error on every poll — and tearing the session down for those
      // would reconnect once a second and reset the capture the device was
      // just told to start, so nothing is ever learned.
      const code = errorCode(err);
      if (code !== null && !SESSION_DEAD.has(code)) throw err;

      log(`pool: dropping session with ${host} — ${describeError(err)}`);
      this.forget(host);
      // A Broadlink RM rotates its session key when it reboots, so the first
      // call after a power blip always fails with a stale key. One silent
      // reconnect turns that into a non-event instead of a dead button.
      if (allowRetry) return this.#exec(host, fn, false);
      throw err;
    }
  }

  /** Runs `fn(device)` with the device authenticated, queued and time-boxed. */
  run(host, fn, { retry = true } = {}) {
    const entry = this.#entry(host);
    const task = entry.queue.then(
      () => this.#exec(host, fn, retry),
      () => this.#exec(host, fn, retry)
    );
    // Keep the chain alive even when this task rejects, otherwise one failure
    // would poison every later command for this device.
    entry.queue = task.then(
      () => {},
      () => {}
    );
    return task;
  }

  /** Cached metadata (model, RF capability, MAC) for an already-reached device. */
  info(host) {
    return this.#entries.get(host)?.info || null;
  }
}
