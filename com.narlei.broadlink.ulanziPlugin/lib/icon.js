// Artwork generated as SVG data URIs and pushed with setBaseDataIcon.
//
// The key's own `textData` is not a usable channel here: a key carrying a
// custom image keeps `Text: ""` in its ViewParam and the host never draws the
// plugin's text over it, so a text-only indicator is invisible. Drawing the
// whole icon ourselves is the only feedback the host reliably renders — the
// same approach the Tuya plugin uses for its temperature readout.

const SIZE = 144;
const C = SIZE / 2;

// Arcs leaving an emitter: the one metaphor that says "a signal is going out"
// rather than the generic "something is loading" a spinner would say.
//
// Expanding concentric rings were the first attempt and they fail at key size —
// three evenly spaced rings on screen at once read as a bullseye, not as
// emission. Fixing the arcs in place and travelling only the *highlight* keeps
// the shape recognisable when it is 72px wide, and the moving highlight is what
// carries the motion.
const ARCS = 3;
const FRAMES = 8;

// Emitter sits bottom-centre firing straight up the key, so the signal reads as
// going *forward* — away from the viewer at whatever it controls. The cone is
// centred on -90° (up); pulling the emitter to the middle keeps the fan
// symmetrical, which a corner-mounted emitter cannot be.
const EX = SIZE / 2;
const EY = 98;
const ARC_FROM = -123;
const ARC_TO = -51;

// Borrowed from resources/icon.svg so the indicator reads as this plugin
// rather than as generic chrome.
const BACKGROUND = '#170B04';
const EMITTER = '#FFC38F';
const WAVE = '#FF9A4D';

const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const point = (radius, degrees) => {
  const rad = (degrees * Math.PI) / 180;
  return `${(EX + radius * Math.cos(rad)).toFixed(1)} ${(EY + radius * Math.sin(rad)).toFixed(1)}`;
};

const arc = (radius, opacity) =>
  `<path d="M${point(radius, ARC_FROM)} A${radius} ${radius} 0 0 1 ${point(radius, ARC_TO)}" ` +
  `fill="none" stroke="${WAVE}" stroke-opacity="${opacity.toFixed(3)}" ` +
  `stroke-width="9" stroke-linecap="round"/>`;

function sending(frame) {
  // The highlight travels one arc per step and then spends a step past the last
  // arc, so every cycle ends with a beat of near-darkness. Without that gap the
  // loop has no visible seam and the motion stops reading as repeated pulses
  // leaving the emitter.
  const head = (frame / FRAMES) * (ARCS + 1);

  const waves = Array.from({ length: ARCS }, (_, i) =>
    arc(30 + i * 20, 0.16 + 0.84 * Math.max(0, 1 - Math.abs(head - i)))
  ).join('');

  // The emitter breathes on the same cycle, so the pulse reads as leaving the
  // source rather than the arcs merely blinking in turn.
  const beat = 9.5 + Math.max(0, 1 - Math.abs(head)) * 2.2;

  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
      `<defs><radialGradient id="g">` +
      `<stop offset="0" stop-color="${EMITTER}" stop-opacity="0.5"/>` +
      `<stop offset="1" stop-color="${EMITTER}" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<rect width="${SIZE}" height="${SIZE}" rx="26" fill="${BACKGROUND}"/>` +
      `<circle cx="${EX}" cy="${EY}" r="26" fill="url(#g)"/>` +
      `${waves}<circle cx="${EX}" cy="${EY}" r="${beat.toFixed(2)}" fill="${EMITTER}"/></svg>`
  );
}

// Every frame is fixed artwork, so build them once at load instead of
// re-encoding base64 on every tick of every press.
const CACHE = Array.from({ length: FRAMES }, (_, i) => sending(i));

export const sendingFrame = (i) => CACHE[((i % FRAMES) + FRAMES) % FRAMES];
