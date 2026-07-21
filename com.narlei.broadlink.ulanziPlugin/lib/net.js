import os from 'node:os';
import broadlink from 'node-broadlink';

// node-broadlink derives the broadcast address octet by octet: "if the netmask
// octet is 255 take the address octet, otherwise 255". That only lands on the
// right address for octet-aligned masks (/8, /16, /24). On a /22 — the default
// for Deco and eero mesh kits — it produces 192.168.255.255 where the real
// broadcast is 192.168.71.255, so discovery silently finds nothing at all.
// Doing it properly is one line of bitwise arithmetic.
export function broadcastFor(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some(Number.isNaN)) return null;
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff)).join('.');
}

function toInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

// Every usable IPv4 interface, each with the broadcast address we computed
// ourselves rather than the one the library would have guessed.
export function localInterfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((ni) => ni && ni.family === 'IPv4' && !ni.internal)
    .map((ni) => ({
      address: ni.address,
      netmask: ni.netmask,
      broadcastAddress: broadcastFor(ni.address, ni.netmask),
    }))
    .filter((ni) => ni.broadcastAddress);
}

// The interface that shares a subnet with `target`, if any. Sending the hello
// from an address on the device's own subnet is what makes unicast discovery
// reliable — the reply carries back to an address the device can actually
// reach without going through a gateway.
export function interfaceFor(target) {
  const t = toInt(target);
  return localInterfaces().find((ni) => (toInt(ni.address) & toInt(ni.netmask)) === (t & toInt(ni.netmask))) || null;
}

function describe(device) {
  return {
    host: device.host.address,
    port: device.host.port,
    name: device.name || '',
    model: device.model || `type 0x${device.deviceType.toString(16)}`,
    deviceType: device.deviceType,
    mac: device.mac.map((b) => b.toString(16).padStart(2, '0')).join(':'),
    locked: !!device.isLocked,
    // Only the Pro line can sweep for RF; the mini models are IR-only.
    rf: typeof device.sweepFrequency === 'function',
  };
}

export { describe };

// Broadcast discovery across every interface, merged over several rounds.
//
// The library fires exactly one UDP datagram per interface per call, and
// broadcast traffic is the first thing a busy access point drops — testing on
// a mesh network, a single round routinely returned one of two devices that
// were both plainly online. Repeating and merging by MAC turns "sometimes my
// device isn't in the list" into a non-issue.
export async function discoverAll(timeoutMs = 5000, rounds = 3) {
  const interfaces = localInterfaces();
  if (!interfaces.length) return [];

  const perRound = Math.max(1200, Math.floor(timeoutMs / rounds));
  const byMac = new Map();

  for (let i = 0; i < rounds; i++) {
    const devices = await broadlink.discover(perRound, interfaces);
    for (const device of devices) {
      const key = device.mac.join(':');
      if (!byMac.has(key)) byMac.set(key, device);
    }
  }
  return [...byMac.values()];
}

// Point a hello straight at one IP. This is the path that survives segmented
// networks: broadcast never crosses a subnet boundary, but unicast does, and
// a device that has been locked to the cloud will often ignore broadcast while
// still answering a direct hello.
export async function helloUnicast(target, timeoutMs = 4000) {
  const preferred = interfaceFor(target);
  const candidates = preferred ? [preferred, ...localInterfaces().filter((ni) => ni !== preferred)] : localInterfaces();

  for (const ni of candidates) {
    const devices = await broadlink.discover(timeoutMs, {
      address: ni.address,
      broadcastAddress: target,
    });
    const match = devices.find((d) => d.host.address === target) || devices[0];
    if (match) return match;
  }
  return null;
}
