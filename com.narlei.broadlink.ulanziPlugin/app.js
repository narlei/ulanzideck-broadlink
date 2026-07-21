import UlanziApi from './plugin-common-node/index.js';
import DevicePool from './lib/pool.js';
import { discoverAll, helloUnicast, describe } from './lib/net.js';
import { learnIr, startRfSweep, captureRfPacket, cancelRfSweep, sendCode } from './lib/learn.js';
import { log, describeError, LOG_PATH } from './lib/logger.js';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_UUID = 'com.narlei.broadlink.plugin';

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

function renderInstance(inst) {
  if (!inst.active) return;
  const { host, code, label } = inst.settings || {};
  const ready = !!host && !!code;
  $UD.setPathIcon(inst.context, 'resources/icon.svg', ready ? label || '' : 'setup');
}

function ensureInstance(context, settings) {
  let inst = INSTANCES.get(context);
  if (!inst) {
    inst = { context, settings: settings || {}, active: true };
    INSTANCES.set(context, inst);
  } else if (settings) {
    inst.settings = settings;
  }
  renderInstance(inst);
  return inst;
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

$UD.onAdd((msg) => ensureInstance(msg.context, msg.param || {}));
$UD.onParamFromApp((msg) => ensureInstance(msg.context, msg.param || {}));
$UD.onParamFromPlugin((msg) => ensureInstance(msg.context, msg.param || {}));

// Edits made in the Property Inspector arrive here; without this the running
// instance never sees the code that was just learned.
$UD.onDidReceiveSettings((msg) => {
  ensureInstance(msg.context, msg.settings || msg.param || {});
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
  const inst = INSTANCES.get(msg.context) || ensureInstance(msg.context, msg.param || {});
  const { host, code, label } = inst.settings || {};

  if (!host) {
    $UD.toast('Pick a Broadlink device in the button settings first');
    $UD.showAlert(msg.context);
    return;
  }
  if (!code) {
    $UD.toast('Learn a code in the button settings first');
    $UD.showAlert(msg.context);
    return;
  }

  try {
    await sendCode(pool, host, code);
    log('sent', label || code.slice(0, 12), '->', host);
  } catch (err) {
    const reason = err?.message || 'unknown error';
    log('send failed:', reason);
    $UD.toast(`Broadlink: ${reason}`.slice(0, 140));
    $UD.showAlert(msg.context);
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
        await sendCode(pool, host, payload.code);
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
