let settings = {};
let loaded = false;
let lastSentLabel = null;

// Which slot asked for the current learn. Only one learn can run at a time
// plugin-wide, so remembering it here is enough to route the result — including
// across the RF release-confirmation, which arrives as a second round trip.
let pendingSlot = null;

const deviceSelect = new PiSelect(document.getElementById('deviceSelect'), {
  placeholder: 'No device selected',
  onChange: () => {
    clearStatus();
    updateRfAvailability();
    save();
  },
});
const scanBtn = document.getElementById('scanBtn');
const manualHost = document.getElementById('manualHost');
const probeBtn = document.getElementById('probeBtn');
const labelEl = document.getElementById('label');
const codeOnText = document.getElementById('codeOnText');
const codeOffText = document.getElementById('codeOffText');
const statusEl = document.getElementById('status');
const rfConfirmRow = document.getElementById('rfConfirmRow');
const rfContinueBtn = document.getElementById('rfContinueBtn');
const rfCancelBtn = document.getElementById('rfCancelBtn');
const resetStateBtn = document.getElementById('resetStateBtn');

const slotButtons = [...document.querySelectorAll('.slot-btns button')];
const knownDevices = new Map();

const field = (slot) => (slot === 'on' ? 'codeOn' : 'codeOff');
const typeField = (slot) => (slot === 'on' ? 'codeOnType' : 'codeOffType');

function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = `bl-status show ${kind}`;
}

function clearStatus() {
  statusEl.className = 'bl-status';
  statusEl.textContent = '';
}

const currentHost = () => deviceSelect.value || '';

function renderCodes() {
  for (const [slot, el] of [
    ['on', codeOnText],
    ['off', codeOffText],
  ]) {
    const code = settings[field(slot)];
    const kind = settings[typeField(slot)];
    el.textContent = code
      ? `${String(kind || '').toUpperCase()} · ${code.length / 2} bytes`
      : 'not learned';
  }
  resetStateBtn.textContent = `Key currently shows: ${settings.on ? 'ON' : 'OFF'} — flip`;
}

function renderDevices() {
  deviceSelect.value = settings.host || '';
  deviceSelect.setOptions(
    [...knownDevices].map(([host, info]) => ({
      value: host,
      label: `${info.name || info.model} — ${host}`,
      note: info.rf ? '' : 'IR only',
    }))
  );
  updateRfAvailability();
}

function updateRfAvailability() {
  const info = knownDevices.get(currentHost());
  const noRf = info && info.rf === false;
  for (const b of slotButtons) {
    if (b.dataset.mode === 'rf') {
      b.disabled = noRf;
      b.title = noRf ? 'This model is IR-only' : 'Learn a 433/315MHz RF code';
    }
  }
}

function save() {
  if (!loaded) return;
  const host = currentHost();
  const info = knownDevices.get(host);
  settings = {
    ...settings,
    host,
    deviceName: info ? info.name || info.model : settings.deviceName || '',
    deviceMac: info ? info.mac : settings.deviceMac || '',
    label: labelEl.value,
    on: !!settings.on,
  };
  lastSentLabel = settings.label;
  $UD.setSettings(settings);
}

const debouncedSave = Utils.debounce(save, 600);

// `trigger` is the button the user actually pressed. It stays lit and pulsing
// while everything else greys out, so the panel answers "did my click land?"
// at the control itself instead of only in the status line below.
function busy(on, trigger = null) {
  [scanBtn, probeBtn, ...slotButtons, resetStateBtn].forEach((b) => {
    b.disabled = on;
    b.classList.toggle('working', on && b === trigger);
  });
  if (!on) updateRfAvailability();
}

function learn(slot, mode, trigger) {
  const host = currentHost();
  if (!host) {
    setStatus('fail', 'Pick a device first — Scan, or enter its IP.');
    return;
  }
  pendingSlot = slot;
  busy(true, trigger);
  setStatus('busy', mode === 'rf' ? `Starting RF scan for ${slot.toUpperCase()}…` : `Learning the ${slot.toUpperCase()} code…`);
  $UD.sendToPlugin({ type: 'learn', mode, host });
}

function test(slot, trigger) {
  const host = currentHost();
  const code = settings[field(slot)];
  if (!host) return setStatus('fail', 'Pick a device first.');
  if (!code) return setStatus('fail', `Learn the ${slot.toUpperCase()} code first.`);
  busy(true, trigger);
  setStatus('busy', `Sending ${slot.toUpperCase()}…`);
  $UD.sendToPlugin({ type: 'test', host, code, settings });
}

$UD.connect();

$UD.onConnected(() => {
  $UD.getSettings();
  setTimeout(() => {
    loaded = true;
  }, 600);
  document.querySelector('.udpi-wrapper').classList.remove('hidden');
});

$UD.onDidReceiveSettings((msg) => {
  const p = msg && (msg.param || msg.settings);
  loaded = true;
  if (!p) return;
  const isSelfEcho = lastSentLabel !== null && (p.label || '') === lastSentLabel;
  settings = { ...settings, ...p };
  if (!isSelfEcho) labelEl.value = p.label || '';
  renderDevices();
  renderCodes();
});

$UD.onSendToPropertyInspector((msg) => {
  const payload = msg && msg.payload;
  if (!payload) return;

  switch (payload.type) {
    case 'devices': {
      busy(false);
      if (!payload.ok) return setStatus('fail', payload.error || 'Discovery failed.');
      knownDevices.clear();
      for (const d of payload.devices) knownDevices.set(d.host, d);
      if (!knownDevices.size) {
        return setStatus(
          'fail',
          'No devices found.\nIf your Broadlink sits on a separate IoT or guest network, ' +
            'broadcast cannot reach it — enter its IP directly above instead.'
        );
      }
      if (!settings.host) {
        settings.host = payload.devices[0].host;
        save();
      }
      renderDevices();
      const locked = payload.devices.filter((d) => d.locked);
      setStatus(
        locked.length ? 'fail' : 'ok',
        locked.length
          ? `Found ${knownDevices.size}, but ${locked.map((d) => d.host).join(', ')} is locked to the cloud.`
          : `Found ${knownDevices.size} device${knownDevices.size > 1 ? 's' : ''}.`
      );
      return;
    }

    case 'probeResult': {
      busy(false);
      if (!payload.ok) return setStatus('fail', payload.error || 'No answer.');
      const d = payload.device;
      knownDevices.set(d.host, d);
      settings.host = d.host;
      renderDevices();
      save();
      setStatus(
        d.locked ? 'fail' : 'ok',
        d.locked
          ? `${d.model} answered but is locked to the cloud.`
          : `${d.model} at ${d.host} answered${d.rf ? ' — IR and RF capable.' : ' — IR only.'}`
      );
      return;
    }

    case 'learnProgress':
      setStatus('busy', payload.message);
      return;

    case 'rfLocked':
      rfConfirmRow.style.display = 'flex';
      setStatus(
        'ok',
        `Locked on ${payload.mhz ? payload.mhz.toFixed(2) + ' MHz' : 'a frequency'}.\n` +
          'Let go of the button, then hit the button below.'
      );
      return;

    case 'learnCancelled':
      rfConfirmRow.style.display = 'none';
      pendingSlot = null;
      busy(false);
      clearStatus();
      return;

    case 'learnResult': {
      busy(false);
      rfConfirmRow.style.display = 'none';
      const slot = pendingSlot;
      pendingSlot = null;
      if (!payload.ok) return setStatus('fail', payload.error || 'Learning failed.');
      if (!slot) return setStatus('fail', 'Learned a code but lost track of which slot. Try again.');
      settings = { ...settings, [field(slot)]: payload.code, [typeField(slot)]: payload.codeType };
      renderCodes();
      save();
      setStatus('ok', `${slot.toUpperCase()} code learned. Hit its Test to make sure it works.`);
      return;
    }

    case 'testResult':
      busy(false);
      setStatus(payload.ok ? 'ok' : 'fail', payload.ok ? 'Sent. Did the device react?' : payload.error || 'Send failed.');
      return;

    default:
      console.warn('[broadlink] unrecognised message from plugin:', payload.type, payload);
      busy(false);
      setStatus('fail', `Unexpected reply "${payload.type}" from the plugin. Check the log.`);
      return;
  }
});

for (const b of slotButtons) {
  b.addEventListener('click', () => {
    if (b.dataset.test) test(b.dataset.slot, b);
    else learn(b.dataset.slot, b.dataset.mode, b);
  });
}

rfContinueBtn.addEventListener('click', () => {
  rfConfirmRow.style.display = 'none';
  setStatus('busy', 'Listening for the packet…');
  $UD.sendToPlugin({ type: 'rfCapture' });
});
rfCancelBtn.addEventListener('click', () => {
  rfConfirmRow.style.display = 'none';
  $UD.sendToPlugin({ type: 'learnCancel' });
});

resetStateBtn.addEventListener('click', () => {
  settings = { ...settings, on: !settings.on };
  renderCodes();
  save();
});

scanBtn.addEventListener('click', () => {
  busy(true, scanBtn);
  setStatus('busy', 'Looking for Broadlink devices on your network…');
  $UD.sendToPlugin({ type: 'discover' });
});
probeBtn.addEventListener('click', () => {
  const host = manualHost.value.trim();
  if (!host) return setStatus('fail', 'Type an IP address first.');
  busy(true, probeBtn);
  setStatus('busy', `Checking ${host}…`);
  $UD.sendToPlugin({ type: 'probe', host });
});
manualHost.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    probeBtn.click();
  }
});
labelEl.addEventListener('input', debouncedSave);
labelEl.addEventListener('change', save);
