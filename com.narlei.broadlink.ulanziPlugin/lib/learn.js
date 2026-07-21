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
    let locked = false;
    while (Date.now() < sweepDeadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        if (await pool.run(host, (d) => d.checkFrequency(), { retry: false })) {
          locked = true;
          break;
        }
      } catch {
        /* still sweeping */
      }
    }
    if (!locked) throw new Error('No RF frequency found. Hold the button down and keep the remote close.');

    onProgress('Frequency locked. Now release, then TAP the same button.');
    await sleep(1000);
    await pool.run(host, (d) => d.findRfPacket());

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
