import UlanziApi from './plugin-common-node/index.js';
import DevicePool from './lib/pool.js';
import { discoverAll, helloUnicast, describe } from './lib/net.js';
import { learnIr, learnRf, sendCode } from './lib/learn.js';

const PLUGIN_UUID = 'com.narlei.broadlink.plugin';

const $UD = new UlanziApi();
const pool = new DevicePool();
const INSTANCES = new Map();

// Learning holds the device in a special mode, so two buttons learning at once
// would fight over it. One at a time, globally.
let learnInFlight = false;

function log(...args) {
  console.log('[broadlink]', ...args);
}

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

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => log('connected'));

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
  const reply = (data) => $UD.sendToPropertyInspector(data, msg.context);

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
      try {
        const result = mode === 'rf' ? await learnRf(pool, host, onProgress) : await learnIr(pool, host, onProgress);
        log('learned', mode, 'code from', host);
        reply({ type: 'learnResult', ok: true, ...result });
      } catch (err) {
        reply({ type: 'learnResult', ok: false, error: err?.message || 'Learning failed' });
      } finally {
        learnInFlight = false;
      }
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
