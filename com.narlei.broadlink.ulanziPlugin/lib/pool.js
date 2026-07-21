import { helloUnicast, describe } from './net.js';

const CALL_TIMEOUT_MS = 6000;
const HELLO_TIMEOUT_MS = 4000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// node-broadlink's sendPacket registers a bare `socket.once('message')` and
// never arms a timer, so a device that is unplugged mid-session leaves the
// promise pending forever. In a plugin process that lives for days that is a
// permanent leak and a button that stops responding with no error to show.
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
        entry.device = await this.#connect(host);
        entry.info = describe(entry.device);
      }
      return await withTimeout(Promise.resolve(fn(entry.device)), CALL_TIMEOUT_MS, `command to ${host}`);
    } catch (err) {
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
