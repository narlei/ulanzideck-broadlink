let settings = {};
let loaded = false;
// Recognizes the deck echoing our own setSettings back through
// didReceiveSettings, so a save mid-typing doesn't clobber the caret.
let lastSentLabel = null;

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
const codeBox = document.getElementById('codeBox');
const codeKind = document.getElementById('codeKind');
const codeHex = document.getElementById('codeHex');
const learnIrBtn = document.getElementById('learnIrBtn');
const learnRfBtn = document.getElementById('learnRfBtn');
const testBtn = document.getElementById('testBtn');
const statusEl = document.getElementById('status');
const rfConfirmRow = document.getElementById('rfConfirmRow');
const rfContinueBtn = document.getElementById('rfContinueBtn');
const rfCancelBtn = document.getElementById('rfCancelBtn');

// Devices the Scan found, plus any IP the user checked by hand. Keyed by IP so
// a manual entry and a discovered one never show up twice.
const knownDevices = new Map();

function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = `bl-status show ${kind}`;
}

function clearStatus() {
  statusEl.className = 'bl-status';
  statusEl.textContent = '';
}

function currentHost() {
  return deviceSelect.value || '';
}

function renderCode() {
  const { code, codeType } = settings;
  if (code) {
    codeBox.classList.remove('empty');
    codeKind.textContent = codeType === 'rf' ? 'RF' : 'IR';
    codeHex.textContent = `${code.slice(0, 28)}… (${code.length / 2} bytes)`;
  } else {
    codeBox.classList.add('empty');
    codeKind.textContent = 'empty';
    codeHex.textContent = 'no code learned yet';
  }
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

// RF learning only exists on the Pro models. Showing the button enabled on an
// IR-only mini just invites a confusing failure 40 seconds later.
function updateRfAvailability() {
  const info = knownDevices.get(currentHost());
  const rfKnownUnsupported = info && info.rf === false;
  learnRfBtn.disabled = rfKnownUnsupported;
  learnRfBtn.title = rfKnownUnsupported ? 'This model is IR-only' : 'Learn a 433/315MHz RF code';
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
  };
  lastSentLabel = settings.label;
  $UD.setSettings(settings);
}

const debouncedSave = Utils.debounce(save, 600);

// `trigger` is the button the user actually pressed. It stays lit and pulsing
// while everything else greys out, so the panel answers "did my click land?"
// at the control itself instead of only in the status line below.
function busy(on, trigger = null) {
  [scanBtn, probeBtn, learnIrBtn, learnRfBtn, testBtn].forEach((b) => {
    b.disabled = on;
    b.classList.toggle('working', on && b === trigger);
  });
  if (!on) updateRfAvailability();
}

function scan() {
  busy(true, scanBtn);
  setStatus('busy', 'Looking for Broadlink devices on your network…');
  $UD.sendToPlugin({ type: 'discover' });
}

function probe() {
  const host = manualHost.value.trim();
  if (!host) {
    setStatus('fail', 'Type an IP address first.');
    return;
  }
  busy(true, probeBtn);
  setStatus('busy', `Checking ${host}…`);
  $UD.sendToPlugin({ type: 'probe', host });
}

function learn(mode) {
  const host = currentHost();
  if (!host) {
    setStatus('fail', 'Pick a device first — Scan, or enter its IP.');
    return;
  }
  busy(true, mode === 'rf' ? learnRfBtn : learnIrBtn);
  setStatus('busy', mode === 'rf' ? 'Starting RF scan…' : 'Putting the device in learning mode…');
  $UD.sendToPlugin({ type: 'learn', mode, host });
}

function test() {
  const host = currentHost();
  if (!host) {
    setStatus('fail', 'Pick a device first.');
    return;
  }
  if (!settings.code) {
    setStatus('fail', 'Learn a code first.');
    return;
  }
  busy(true, testBtn);
  setStatus('busy', 'Sending…');
  $UD.sendToPlugin({ type: 'test', host, code: settings.code, settings });
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
  renderCode();
});

$UD.onSendToPropertyInspector((msg) => {
  const payload = msg && msg.payload;
  if (!payload) return;

  switch (payload.type) {
    case 'devices': {
      busy(false);
      if (!payload.ok) {
        setStatus('fail', payload.error || 'Discovery failed.');
        return;
      }
      knownDevices.clear();
      for (const d of payload.devices) knownDevices.set(d.host, d);

      if (!knownDevices.size) {
        setStatus(
          'fail',
          'No devices found.\nIf your Broadlink sits on a separate IoT or guest network, ' +
            'broadcast cannot reach it — enter its IP directly above instead.'
        );
        return;
      }
      // Nothing chosen yet? Take the first hit so the common case is one click.
      if (!settings.host) {
        settings.host = payload.devices[0].host;
        save();
      }
      renderDevices();
      const locked = payload.devices.filter((d) => d.locked);
      if (locked.length) {
        setStatus(
          'fail',
          `Found ${knownDevices.size}, but ${locked.map((d) => d.host).join(', ')} ` +
            `is locked to the cloud. Turn "Lock device" off in the Broadlink app.`
        );
      } else {
        setStatus('ok', `Found ${knownDevices.size} device${knownDevices.size > 1 ? 's' : ''}.`);
      }
      return;
    }

    case 'probeResult': {
      busy(false);
      if (!payload.ok) {
        setStatus('fail', payload.error || 'No answer.');
        return;
      }
      const d = payload.device;
      knownDevices.set(d.host, d);
      settings.host = d.host;
      renderDevices();
      save();
      setStatus(
        d.locked ? 'fail' : 'ok',
        d.locked
          ? `${d.model} answered but is locked to the cloud. Turn "Lock device" off in the Broadlink app.`
          : `${d.model} at ${d.host} answered${d.rf ? ' — IR and RF capable.' : ' — IR only.'}`
      );
      return;
    }

    case 'learnProgress':
      setStatus('busy', payload.message);
      return;

    // The sweep found the frequency, but the capture command must not go out
    // while the button is still held down. Wait for the user to say they let
    // go rather than guessing at a delay.
    case 'rfLocked': {
      rfConfirmRow.style.display = 'flex';
      setStatus(
        'ok',
        `Locked on ${payload.mhz ? payload.mhz.toFixed(2) + ' MHz' : 'a frequency'}.\n` +
          'Let go of the button, then hit the button below.'
      );
      return;
    }

    case 'learnCancelled':
      rfConfirmRow.style.display = 'none';
      busy(false);
      clearStatus();
      return;

    case 'learnResult': {
      busy(false);
      rfConfirmRow.style.display = 'none';
      if (!payload.ok) {
        setStatus('fail', payload.error || 'Learning failed.');
        return;
      }
      settings = { ...settings, code: payload.code, codeType: payload.codeType };
      renderCode();
      save();
      setStatus('ok', `${String(payload.codeType || '').toUpperCase()} code learned. Hit Test to make sure it works.`);
      return;
    }

    case 'testResult': {
      busy(false);
      if (payload.ok) setStatus('ok', 'Sent. Did the device react?');
      else setStatus('fail', payload.error || 'Send failed.');
      return;
    }

    // A reply the panel does not recognise leaves the UI frozen mid-operation
    // with no clue why — which is exactly how a mistyped message name hides.
    // Say so instead of returning quietly.
    default: {
      console.warn('[broadlink] unrecognised message from plugin:', payload.type, payload);
      busy(false);
      setStatus('fail', `Unexpected reply "${payload.type}" from the plugin. Check the log.`);
      return;
    }
  }
});

rfContinueBtn.addEventListener('click', () => {
  rfConfirmRow.style.display = 'none';
  setStatus('busy', 'Listening for the packet…');
  $UD.sendToPlugin({ type: 'rfCapture' });
});
rfCancelBtn.addEventListener('click', () => {
  rfConfirmRow.style.display = 'none';
  $UD.sendToPlugin({ type: 'learnCancel' });
});
scanBtn.addEventListener('click', scan);
probeBtn.addEventListener('click', probe);
learnIrBtn.addEventListener('click', () => learn('ir'));
learnRfBtn.addEventListener('click', () => learn('rf'));
testBtn.addEventListener('click', test);
labelEl.addEventListener('input', debouncedSave);
labelEl.addEventListener('change', save);
manualHost.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    probe();
  }
});
