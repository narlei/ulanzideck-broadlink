import UlanziApi from './plugin-common-node/index.js';
import DevicePool from './lib/pool.js';
import { discoverAll, helloUnicast, describe } from './lib/net.js';
import { learnIr, startRfSweep, captureRfPacket, cancelRfSweep, sendCode } from './lib/learn.js';
import { log, describeError, LOG_PATH } from './lib/logger.js';
import { sendingFrame } from './lib/icon.js';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_UUID = 'com.narlei.broadlink.plugin';
const TOGGLE_UUID = 'com.narlei.broadlink.plugin.toggle';

const $UD = new UlanziApi();
const pool = new DevicePool();
const INSTANCES = new Map();

// Learning holds the device in a special mode, so two buttons learning at once
// would fight over it. One at a time, globally.
let learnInFlight = false;

// An RF sweep that found its frequency but is still waiting for the user to
// confirm they let go of the button. Parked here between the two calls.
let pendingRf = null;

// If the panel is closed mid-sweep the confirmation never comes, and the device
// would sit in sweep mode indefinitely. Abandon it rather than leave it stuck.
const RF_CONFIRM_GRACE_MS = 90000;
const REDISCOVER_TIMEOUT_MS = 6000;
const HOST_IDENTITY_TIMEOUT_MS = 1800;

function clearPendingRf() {
  if (!pendingRf) return;
  clearTimeout(pendingRf.timer);
  pendingRf = null;
}

function parkPendingRf(host, frequency) {
  clearPendingRf();
  pendingRf = {
    host,
    frequency,
    timer: setTimeout(() => {
      log('RF confirmation never arrived — leaving sweep mode');
      cancelRfSweep(pool, host);
      pendingRf = null;
      learnInFlight = false;
    }, RF_CONFIRM_GRACE_MS),
  };
}

// Identifies the running build by the mtime of this very file, so the log says
// which code is actually executing without needing a build step.
const BUILD_STAMP = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return 'unknown';
  }
})();

// The action a context belongs to. Messages carry `uuid`, but a context that
// was restored before we ever saw an add event would have none, so the shape of
// the settings stands in for it.
function isToggle(inst) {
  if (inst.uuid) return inst.uuid === TOGGLE_UUID;
  const s = inst.settings || {};
  return 'codeOn' in s || 'codeOff' in s;
}

function renderInstance(inst) {
  if (!inst.active) return;
  const s = inst.settings || {};

  // Address the artwork by state index rather than by file path: index 0/1 is
  // what the key's own state picker in Ulanzi Studio edits, so a custom image
  // dropped there survives. Pushing a path would overwrite it on every render.
  if (isToggle(inst)) {
    const ready = !!s.host && !!s.codeOn && !!s.codeOff;
    // `on` is what the key last sent, so the artwork shows the state the device
    // should currently be in — not the one the next press will move it to.
    // Matches the States order in manifest.json: 0 = off, 1 = on.
    $UD.setStateIcon(inst.context, s.on ? 1 : 0, ready ? s.label || '' : 'setup');
    return;
  }

  const ready = !!s.host && !!s.code;
  $UD.setStateIcon(inst.context, 0, ready ? s.label || '' : 'setup');
}

// A device whose session is already open answers in tens of milliseconds —
// quicker than a single screen refresh. Painted and cleared that fast the
// indicator is invisible and the press still looks ignored, so it is held for a
// floor of BUSY_MIN_MS even once the send has already landed.
// Long enough for one full emit-and-rest cycle of the artwork (8 frames), so a
// fast send never cuts the animation off mid-pulse.
const BUSY_MIN_MS = 700;
const BUSY_TICK_MS = 80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pushed artwork replaces what is drawn on the key but not what the key has
// configured, so renderInstance — which addresses artwork by state index —
// puts the user's own image back when the send finishes.
function paintBusy(inst) {
  if (!inst.active) return;
  $UD.setBaseDataIcon(inst.context, sendingFrame(inst.busyFrame));
  inst.busyFrame += 1;
}

function startBusy(inst) {
  inst.busy = true;
  inst.busyFrame = 0;
  inst.busySince = Date.now();
  paintBusy(inst);
  // Repainting on a timer also heals the indicator if an unrelated settings
  // event repaints the key underneath us mid-send.
  inst.busyTimer = setInterval(() => paintBusy(inst), BUSY_TICK_MS);
}

async function stopBusy(inst) {
  const held = Date.now() - inst.busySince;
  if (held < BUSY_MIN_MS) await sleep(BUSY_MIN_MS - held);
  clearInterval(inst.busyTimer);
  inst.busyTimer = null;
  inst.busy = false;
  renderInstance(inst);
}

function ensureInstance(context, settings, uuid) {
  let inst = INSTANCES.get(context);
  if (!inst) {
    inst = { context, settings: settings || {}, active: true, uuid: uuid || null };
    INSTANCES.set(context, inst);
  } else {
    if (settings) inst.settings = settings;
    if (uuid) inst.uuid = uuid;
  }
  renderInstance(inst);
  return inst;
}

const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const normalizeMac = (value) => String(value || '').trim().toLowerCase();

function deviceLabel(settings) {
  return settings.deviceName || settings.deviceMac || settings.host || 'saved Broadlink device';
}

function matchesSavedDevice(info, settings) {
  if (!info || !settings) return false;

  const savedMac = normalizeMac(settings.deviceMac);
  if (savedMac) return normalizeMac(info.mac) === savedMac;

  const savedName = normalizeName(settings.deviceName);
  if (!savedName) return false;

  return [info.name, info.name || info.model, info.model].some((candidate) => normalizeName(candidate) === savedName);
}

function hasSavedIdentity(settings) {
  return !!(normalizeMac(settings.deviceMac) || normalizeName(settings.deviceName));
}

async function inspectHost(host, timeoutMs = HOST_IDENTITY_TIMEOUT_MS) {
  const device = await helloUnicast(host, timeoutMs);
  return device ? describe(device) : null;
}

async function rediscoverSavedDevice(settings) {
  log(`recovery: discovering Broadlink devices to find ${deviceLabel(settings)}`);
  const devices = (await discoverAll(REDISCOVER_TIMEOUT_MS)).map(describe);
  const matches = devices.filter((device) => matchesSavedDevice(device, settings));

  if (!matches.length) {
    throw new Error(`Could not find ${deviceLabel(settings)} on this network.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one Broadlink matches "${deviceLabel(settings)}" (${matches.map((d) => d.host).join(', ')}). ` +
        'Rename one of them or pick the IP again.'
    );
  }

  return matches[0];
}

function updateInstanceDevice(inst, device) {
  inst.settings = {
    ...(inst.settings || {}),
    host: device.host,
    deviceName: device.name || device.model,
    deviceMac: device.mac,
  };
  $UD.setSettings(inst.settings, inst.context);
  renderInstance(inst);
}

async function resolveInstanceHost(inst) {
  const settings = inst.settings || {};
  const host = String(settings.host || '').trim();
  if (!host || !hasSavedIdentity(settings)) return host;

  const cached = pool.info(host);
  if (cached && matchesSavedDevice(cached, settings)) return host;

  try {
    const current = await inspectHost(host);
    if (current && matchesSavedDevice(current, settings)) {
      if (!settings.deviceMac && current.mac) {
        updateInstanceDevice(inst, current);
      }
      return host;
    }
    if (current) {
      log(
        `recovery: ${host} is ${current.name || current.model} (${current.mac}), ` +
          `not ${deviceLabel(settings)}`
      );
      pool.forget(host);
    }
  } catch (err) {
    log(`recovery: saved host ${host} did not verify — ${describeError(err)}`);
    pool.forget(host);
  }

  const found = await rediscoverSavedDevice(settings);
  if (found.locked) {
    throw new Error(`${found.model} at ${found.host} is locked to the cloud. Turn "Lock device" off in the Broadlink app.`);
  }

  if (found.host !== host) {
    log(`recovery: ${deviceLabel(settings)} moved from ${host} to ${found.host}`);
    updateInstanceDevice(inst, found);
    $UD.toast(`Broadlink IP updated: ${found.host}`);
  }

  return found.host;
}

async function sendCodeForInstance(inst, code) {
  const firstHost = await resolveInstanceHost(inst);
  try {
    await sendCode(pool, firstHost, code);
    return firstHost;
  } catch (err) {
    const settings = inst.settings || {};
    if (!firstHost || !hasSavedIdentity(settings)) throw err;

    log(`recovery: send via ${firstHost} failed — ${describeError(err)}`);
    pool.forget(firstHost);

    const found = await rediscoverSavedDevice(settings);
    if (found.locked) {
      throw new Error(`${found.model} at ${found.host} is locked to the cloud. Turn "Lock device" off in the Broadlink app.`);
    }
    if (found.host === firstHost) throw err;

    log(`recovery: retrying ${deviceLabel(settings)} at ${found.host}`);
    updateInstanceDevice(inst, found);
    await sendCode(pool, found.host, code);
    $UD.toast(`Broadlink IP updated: ${found.host}`);
    return found.host;
  }
}

// Stamped at startup so a log file can be matched against the build that
// produced it — a stale plugin process silently serving old code is otherwise
// indistinguishable from a fix that did not work.
log('='.repeat(60));
log(`plugin starting — pid ${process.pid}, node ${process.version}`);
log(`build ${BUILD_STAMP}`);
log(`log file: ${LOG_PATH || '(disabled)'}`);

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => log('connected to Ulanzi Studio'));

$UD.onAdd((msg) => {
  log(`add: uuid=${msg.uuid || '(none)'} key=${msg.key || '?'}`);
  ensureInstance(msg.context, msg.param || {}, msg.uuid);
});
$UD.onParamFromApp((msg) => ensureInstance(msg.context, msg.param || {}, msg.uuid));
$UD.onParamFromPlugin((msg) => ensureInstance(msg.context, msg.param || {}, msg.uuid));

// Edits made in the Property Inspector arrive here; without this the running
// instance never sees the code that was just learned.
$UD.onDidReceiveSettings((msg) => {
  ensureInstance(msg.context, msg.settings || msg.param || {}, msg.uuid);
});

$UD.onSetActive((msg) => {
  const inst = INSTANCES.get(msg.context);
  if (!inst) return;
  inst.active = !!msg.active;
  if (inst.active) renderInstance(inst);
});

$UD.onClear((msg) => {
  if (!msg.param) return;
  for (const item of msg.param) INSTANCES.delete(item.context);
});

$UD.onRun(async (msg) => {
  const inst = INSTANCES.get(msg.context) || ensureInstance(msg.context, msg.param || {}, msg.uuid);
  const s = inst.settings || {};
  const toggle = isToggle(inst);

  if (!s.host) {
    $UD.toast('Pick a Broadlink device in the button settings first');
    $UD.showAlert(msg.context);
    return;
  }

  // A toggle alternates: whatever it sent last time, send the other one now.
  const code = toggle ? (s.on ? s.codeOff : s.codeOn) : s.code;
  if (!code) {
    $UD.toast(
      toggle
        ? `Learn the ${s.on ? 'OFF' : 'ON'} code in the button settings first`
        : 'Learn a code in the button settings first'
    );
    $UD.showAlert(msg.context);
    return;
  }

  // The send is a network round trip (plus possible device recovery), so a
  // second press before the first lands would race it — for a toggle that
  // could flip the state twice off the same stale `s.on`. Ignore repeats
  // instead of queuing them.
  if (inst.busy) return;

  startBusy(inst);

  try {
    const host = await sendCodeForInstance(inst, code);
    if (toggle) {
      // Only flip once the send actually landed, so a failed press does not
      // leave the key claiming a state the device never reached.
      inst.settings = { ...inst.settings, on: !s.on };
      $UD.setSettings(inst.settings, msg.context);
      $UD.sendParamFromPlugin(inst.settings, msg.context);
      log(`toggled ${s.label || 'button'} -> ${inst.settings.on ? 'ON' : 'OFF'} via ${host}`);
    } else {
      log('sent', s.label || code.slice(0, 12), '->', host);
    }
  } catch (err) {
    const reason = err?.message || 'unknown error';
    log('send failed:', reason);
    $UD.toast(`Broadlink: ${reason}`.slice(0, 140));
    $UD.showAlert(msg.context);
  } finally {
    await stopBusy(inst);
  }
});

// ---------------------------------------------------------------------------
// Property Inspector bridge
// ---------------------------------------------------------------------------

$UD.onSendToPlugin(async (msg) => {
  const payload = msg.payload || {};
  log(`PI -> plugin: ${payload.type || '(no type)'}${payload.mode ? ' mode=' + payload.mode : ''}${payload.host ? ' host=' + payload.host : ''}`);
  const reply = (data) => {
    log(`plugin -> PI: ${data.type}${data.ok === false ? ' FAILED: ' + data.error : ''}`);
    $UD.sendToPropertyInspector(data, msg.context);
  };

  switch (payload.type) {
    case 'discover': {
      try {
        const devices = await discoverAll(5000);
        reply({ type: 'devices', ok: true, devices: devices.map(describe) });
      } catch (err) {
        reply({ type: 'devices', ok: false, error: err?.message || 'Discovery failed' });
      }
      return;
    }

    // Manual IP is a first-class path, not a fallback: broadcast cannot cross a
    // subnet, so anyone running their smart home on a separate SSID or VLAN can
    // only ever reach the device by naming it directly.
    case 'probe': {
      const host = (payload.host || '').trim();
      if (!host) {
        reply({ type: 'probeResult', ok: false, error: 'Type an IP address first.' });
        return;
      }
      try {
        const device = await helloUnicast(host, 4000);
        if (!device) {
          reply({ type: 'probeResult', ok: false, error: `Nothing answered at ${host}.` });
          return;
        }
        reply({ type: 'probeResult', ok: true, device: describe(device) });
      } catch (err) {
        reply({ type: 'probeResult', ok: false, error: err?.message || 'Probe failed' });
      }
      return;
    }

    case 'learn': {
      const host = (payload.host || '').trim();
      const mode = payload.mode === 'rf' ? 'rf' : 'ir';
      if (!host) {
        reply({ type: 'learnResult', ok: false, error: 'Pick a device first.' });
        return;
      }
      if (learnInFlight) {
        reply({ type: 'learnResult', ok: false, error: 'Another button is learning right now.' });
        return;
      }

      learnInFlight = true;
      const onProgress = (message) => reply({ type: 'learnProgress', message });

      if (mode === 'rf') {
        // Stop after the sweep and hand control back to the panel. The capture
        // command must not go out until the user confirms the button is
        // released — see startRfSweep for why.
        try {
          const locked = await startRfSweep(pool, host, onProgress);
          parkPendingRf(host, locked.raw);
          reply({ type: 'rfLocked', ok: true, mhz: locked.mhz });
        } catch (err) {
          learnInFlight = false;
          reply({ type: 'learnResult', ok: false, error: err?.message || 'RF sweep failed' });
        }
        return;
      }

      try {
        const { codeType, code } = await learnIr(pool, host, onProgress);
        log('learned ir code from', host);
        reply({ type: 'learnResult', ok: true, codeType, code });
      } catch (err) {
        reply({ type: 'learnResult', ok: false, error: err?.message || 'Learning failed' });
      } finally {
        learnInFlight = false;
      }
      return;
    }

    case 'rfCapture': {
      if (!pendingRf) {
        learnInFlight = false;
        reply({ type: 'learnResult', ok: false, error: 'The RF scan expired. Start again.' });
        return;
      }
      const { host, frequency } = pendingRf;
      clearPendingRf();
      try {
        const { codeType, code } = await captureRfPacket(pool, host, frequency, (message) =>
          reply({ type: 'learnProgress', message })
        );
        log('learned rf code from', host);
        reply({ type: 'learnResult', ok: true, codeType, code });
      } catch (err) {
        reply({ type: 'learnResult', ok: false, error: err?.message || 'Capture failed' });
      } finally {
        learnInFlight = false;
      }
      return;
    }

    case 'learnCancel': {
      if (pendingRf) {
        const { host } = pendingRf;
        clearPendingRf();
        await cancelRfSweep(pool, host);
      }
      learnInFlight = false;
      reply({ type: 'learnCancelled' });
      return;
    }

    case 'test': {
      const host = (payload.host || '').trim();
      try {
        const testSettings = { ...(payload.settings || {}), host };
        const inst = INSTANCES.get(msg.context) || ensureInstance(msg.context, testSettings, msg.uuid);
        inst.settings = { ...(inst.settings || {}), ...testSettings };
        await sendCodeForInstance(inst, payload.code);
        reply({ type: 'testResult', ok: true });
      } catch (err) {
        reply({ type: 'testResult', ok: false, error: err?.message || 'Send failed' });
      }
      return;
    }

    default:
      return;
  }
});

$UD.onError((err) => log('socket error', err));
$UD.onClose(() => log('socket closed'));
