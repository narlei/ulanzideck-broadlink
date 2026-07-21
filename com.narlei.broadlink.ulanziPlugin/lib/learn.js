import { sleep } from './pool.js';

const POLL_INTERVAL_MS = 800;
const IR_TIMEOUT_MS = 30000;
const RF_SWEEP_TIMEOUT_MS = 40000;
const RF_PACKET_TIMEOUT_MS = 30000;

const toHex = (buf) => Buffer.from(buf).toString('hex');

// While the device is waiting for a signal, checkData answers with an error
// code rather than an empty payload. There is no way to tell "nothing captured
// yet" apart from a genuine fault by the code alone, so we treat every failure
// as "keep waiting" and let the deadline be the thing that gives up.
async function pollForCode(pool, host, deadline) {
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const data = await pool.run(host, (d) => d.checkData(), { retry: false });
      if (data && data.length) return toHex(data);
    } catch {
      /* not captured yet */
    }
  }
  return null;
}

/** Puts the RM in IR learning mode and waits for a button press on the remote. */
export async function learnIr(pool, host, onProgress = () => {}) {
  await pool.run(host, (d) => d.enterLearning());
  onProgress('Point your remote at the Broadlink and press the button.');

  const code = await pollForCode(pool, host, Date.now() + IR_TIMEOUT_MS);
  if (code) return { type: 'ir', code };

  await pool.run(host, (d) => d.cancelLearning()).catch(() => {});
  throw new Error('No IR signal captured. Get closer to the device and try again.');
}

// node-broadlink's checkFrequency() throws away the frequency the sweep found
// (it returns just a boolean) and its findRfPacket() sends command 0x1b with an
// empty payload. python-broadlink, which it was ported from, carries the value
// across: check_frequency returns (found, frequency) and find_rf_packet packs
// it back in. Without it the device is told to listen but never told where, so
// stage two waits forever. These two helpers speak 0x1a/0x1b directly.
//
// `send` is marked protected in the library's TypeScript, which is a
// compile-time annotation only — at runtime it is an ordinary prototype method.
// The guard below turns a future refactor upstream into a clear error rather
// than a mystery hang.
function rawSend(device, command, data = []) {
  if (typeof device.send !== 'function') {
    throw new Error('This node-broadlink build does not expose the raw command channel.');
  }
  return device.send(command, data);
}

async function sweepStatus(device) {
  const resp = await rawSend(device, 0x1a);
  // The frequency rides along as a little-endian uint32 right after the flag.
  // We hand the raw value straight back to the device later instead of
  // converting to MHz and back, so nothing is lost to rounding.
  const raw = resp && resp.length >= 5 ? resp.readUInt32LE(1) : 0;
  return { found: !!(resp && resp[0]), raw, mhz: raw / 1000 };
}

function listenOnFrequency(device, raw) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(raw >>> 0, 0);
  return rawSend(device, 0x1b, [...payload]);
}

/**
 * RF learning is a two-stage handshake and the stages need opposite gestures
 * from the user: first a long hold so the RM can sweep the band and lock the
 * frequency, then short taps so it can capture one clean packet. Telling the
 * user which one to do at which moment is the whole difference between this
 * working on the first try and feeling broken.
 */
export async function learnRf(pool, host, onProgress = () => {}) {
  const info = pool.info(host);
  if (info && !info.rf) {
    throw new Error(`${info.model} is an IR-only device. RF learning needs an RM Pro.`);
  }

  try {
    await pool.run(host, (d) => {
      if (typeof d.sweepFrequency !== 'function') {
        throw new Error('This Broadlink model cannot learn RF codes.');
      }
      return d.sweepFrequency();
    });
    onProgress('Scanning frequencies — press and HOLD the remote button.');

    const sweepDeadline = Date.now() + RF_SWEEP_TIMEOUT_MS;
    let locked = null;
    while (Date.now() < sweepDeadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const status = await pool.run(host, (d) => sweepStatus(d), { retry: false });
        if (status.found) {
          locked = status;
          break;
        }
      } catch {
        /* still sweeping */
      }
    }
    if (!locked) throw new Error('No RF frequency found. Hold the button down and keep the remote close.');

    onProgress(
      locked.mhz
        ? `Locked on ${locked.mhz.toFixed(2)} MHz. Release, then TAP the same button.`
        : 'Frequency locked. Release, then TAP the same button.'
    );
    await sleep(1000);
    await pool.run(host, (d) => listenOnFrequency(d, locked.raw));

    const code = await pollForCode(pool, host, Date.now() + RF_PACKET_TIMEOUT_MS);
    if (code) return { type: 'rf', code };

    throw new Error('Frequency found but no packet captured. Try tapping the button a few times.');
  } catch (err) {
    await pool.run(host, (d) => d.cancelSweepFrequency?.()).catch(() => {});
    throw err;
  }
}

/** Fires a stored code. IR and RF are the same call — the packet carries its own kind. */
export async function sendCode(pool, host, code) {
  const hex = String(code || '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Stored code is not valid hex. Learn it again.');
  }
  await pool.run(host, (d) => d.sendData(hex));
}
