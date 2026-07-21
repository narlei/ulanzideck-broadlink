<div align="center">

<img src="com.narlei.broadlink.ulanziPlugin/resources/icon.svg" alt="Broadlink IR/RF" width="96" />

# Broadlink IR/RF — Ulanzi Deck Plugin

**Turn any Deck key into a remote control.** Learn a code from your original remote, tap the key, the device obeys.

No Broadlink account. No cloud round-trip. Everything happens on your local network.

</div>

---

## What it does

Talks directly to a Broadlink RM over your LAN using the same local protocol Home Assistant uses. Point your original remote at the RM, press Learn, and the captured code is stored with that Deck button.

- **IR** — works on every RM model. Lights, TVs, air conditioners, fans, projectors.
- **RF 433/315MHz** — works on the RM Pro line. Blinds, garage doors, ceiling fans.
- **Local only** — no account, no internet dependency, ~10–30ms instead of a cloud round-trip.
- **Test button** — fire the code from the settings panel before you ever touch the physical key.

## Two actions

**Send Command** — one key, one code. Tap it, the code goes out.

**Toggle On/Off** — one key, two codes, alternating. For anything whose remote has separate on and off buttons: instead of burning two keys on one lamp, this holds both codes and sends whichever one is not the last one it sent. The key artwork shows which state it thinks the device is in — dark when off, lit when on.

The state only flips once a send actually lands, so a failed press does not leave the key claiming a state the device never reached. The key cannot read the device, though — IR and RF are one-way — so if someone uses the original remote the two can drift apart. The settings panel has a flip control to line them back up.

## Requirements

- A Broadlink RM device (RM4 Mini, RM4 Pro, RM3, RM Pro…) already on your Wi-Fi
- The **original physical remote** for whatever you want to control
- macOS 10.15+ or Windows 10+

> **Heads up:** the RM does not store codes. Your buttons in the Broadlink app live in Broadlink's cloud, and there is no local API to read them — the device only knows how to *learn* and *emit*. So you re-learn each code here once, from the physical remote. It takes about five seconds per button.

## Setup

1. Add a **Send Command** action to a key (or **Toggle On/Off** for a two-code key).
2. Hit **Scan**. Pick your device from the list.
3. Give the button a name (it shows on the key).
4. Press **Learn IR**, point the remote at the RM, press the button on the remote.
5. Press **Test** to confirm. Done.

On a Toggle key the two slots are learned separately — **On** and **Off** each have their own Learn and Test.

### If Scan finds nothing

Broadcast discovery cannot cross a subnet — this is how IP works, not a bug. If your smart home lives on a separate IoT network, guest network, or VLAN, type the device's IP into the **"…or enter the IP directly"** field and press **Check**. A direct unicast hello reaches devices that broadcast never will.

Find the IP in your router's client list, or in the Broadlink app under the device's properties.

Worth doing either way: give the RM a **DHCP reservation** in your router. If its IP changes, the button stops working.

### Learning RF codes

RF capture is a two-stage handshake and each stage needs the opposite gesture:

1. Press **Learn RF** → **press and hold** the remote button while the RM sweeps the band.
2. It reports the frequency it locked onto. **Let go of the button**, then hit **"I let go — capture now"**.
3. Now **tap** the same button, short presses, a few times.

That middle confirmation is not ceremony. The capture command has to reach the device *after* the transmitter stops holding the channel down — otherwise there is no packet boundary to find and the device waits forever. Only you know when you actually let go, so the panel asks instead of guessing.

## Troubleshooting

**"…is locked to the cloud"** — the Broadlink app has locked the device to cloud-only control. Open the app, go to the device's properties, and turn **Lock device** off. No reset needed.

**Scan finds nothing but the device is definitely online** — see *If Scan finds nothing* above. Also confirm the device isn't on a guest network, which is isolated by design on most routers.

**Worked yesterday, dead today** — the RM's IP probably changed. Set a DHCP reservation.

## Development

```bash
make install    # bundle deps, install into Ulanzi Studio, restart it
make package    # build the distributable ZIP
make bump_patch # bump version in package.json + manifest.json
```

## Credits

Built on [`node-broadlink`](https://github.com/ThomasTavernier/broadlink-iot), a JavaScript port of [`python-broadlink`](https://github.com/mjg59/python-broadlink).

## License

MIT
