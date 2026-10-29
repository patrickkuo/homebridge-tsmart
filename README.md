# homebridge-tsmart

Homebridge plugin for **Tesla T-Smart** and other **EUROICC** water heaters. Control power, setpoint, and modes from Apple Home over the local network — no Home Assistant required.

## Install

1. Install via Homebridge UI (Plugins) searching for `homebridge-tsmart`, or from GitHub:

   ```bash
   npm install -g patrickkuo/homebridge-tsmart
   ```

2. Add a **TSmart** platform in config (UI form or JSON).
3. Prefer a **static DHCP reservation** when you can; the plugin also tracks heaters by **device id** so HomeKit identity survives IP changes.

## Config example

Discovery is **on by default** (same UDP broadcast as the HA integration). Minimal config:

```json
{
  "platforms": [
    {
      "platform": "TSmart",
      "name": "T-Smart"
    }
  ]
}
```

With overrides / static devices:

```json
{
  "platforms": [
    {
      "platform": "TSmart",
      "name": "T-Smart",
      "discovery": true,
      "temperatureMode": "high",
      "modes": ["boost", "away"],
      "devices": [
        {
          "name": "Water Heater",
          "ip": "192.168.1.50",
          "temperatureMode": "high",
          "modes": ["boost", "away"]
        }
      ]
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `discovery` | UDP broadcast discover on port 1337 (default `true`). Set `false` to use only `devices[]`. |
| `temperatureMode` | Platform default current-temp sensor: `high` (device display), `low`, or `average` |
| `modes` | Platform default mode switches. Omit for `["boost", "away"]`; use `[]` for none |
| `devices` | Optional. Always registered (even if offline at discover time). Matching IPs override discovered name/modes |

### IP changes & network loss

Heaters are tracked by a stable **device id** (from discovery or a config read) so Apple Home keeps the same accessory if the IP changes.

- **Every 5 minutes** the plugin rebroadcasts discovery and rebinds any known heater to a new IP
- After repeated poll failures it **rediscovers sooner** (debounced) without waiting for the interval
- Offline heaters are **not removed** while discovery is enabled — they come back when the network returns

### Mode switches

Mode switches are mutually exclusive (radio buttons): turning one on clears the others. **Turning all mode switches off sets Manual mode.** Enabling a mode preserves the current Off/Heat power state (same as the HA integration). Modes the plugin does not expose (e.g. Timer) appear as all switches off.

## What you get in Apple Home

- **Heater** tile: Off / Heat, current temperature, target temperature (15–70 °C)
- Optional switches: Boost, Away (Travel), Eco, Smart

Timer, diagnostics, restart, time sync, and anti-legionella are intentionally not exposed.

## UDP port 1337

The heater protocol uses **UDP port 1337** with no authentication. This plugin binds local port 1337 (`SO_REUSEADDR`) to talk to the device and for discovery broadcasts.

**Do not run the Home Assistant `tsmart_ha` integration and this plugin on the same host if both bind port 1337** — they will conflict. Use one or the other on a given machine.

Discovery requires the Homebridge host and heater on the **same L2 broadcast domain** (typical home LAN). Routed VLANs usually will not see the broadcast.

## Protocol attribution

Local UDP framing (discovery `0x01`, status `0xF1`, control `0xF2`, checksum, modes) is ported from the MIT-licensed [andrew-codechimp/tsmart_ha](https://github.com/andrew-codechimp/tsmart_ha) Home Assistant integration (`custom_components/t_smart/tsmart.py`).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
