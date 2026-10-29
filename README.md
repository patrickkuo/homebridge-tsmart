# homebridge-tsmart

Homebridge plugin for **Tesla T-Smart** and other **EUROICC** water heaters. Control power, setpoint, and modes from Apple Home over the local network — no Home Assistant required.

## Install

1. Install via Homebridge UI (Plugins) searching for `homebridge-tsmart`, or:

   ```bash
   npm install -g homebridge-tsmart
   ```

2. Add a **TSmart** platform in config (UI form or JSON).
3. Give each heater a **static IP** on your LAN (MVP has no discovery).

## Config example

```json
{
  "platforms": [
    {
      "platform": "TSmart",
      "name": "T-Smart",
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
| `temperatureMode` | Which tank sensor Home shows as current temp: `high` (default, matches device display), `low`, or `average` |
| `modes` | Extra HomeKit **Switch**es for device modes. Omit for default `["boost", "away"]`; use `[]` for none. Optional ids: `eco`, `smart` |

### Mode switches

Mode switches are mutually exclusive (radio buttons): turning one on clears the others. **Turning all mode switches off sets Manual mode.** Enabling a mode preserves the current Off/Heat power state (same as the HA integration). Modes the plugin does not expose (e.g. Timer) appear as all switches off.

## What you get in Apple Home

- **Heater** tile: Off / Heat, current temperature, target temperature (15–70 °C)
- Optional switches: Boost, Away (Travel), Eco, Smart

Timer, diagnostics, restart, time sync, and anti-legionella are intentionally not exposed.

## UDP port 1337

The heater protocol uses **UDP port 1337** with no authentication. This plugin binds local port 1337 (`SO_REUSEADDR`) to talk to the device.

**Do not run the Home Assistant `tsmart_ha` integration and this plugin on the same host if both bind port 1337** — they will conflict. Use one or the other on a given machine.

## Protocol attribution

Local UDP framing (status `0xF1`, control `0xF2`, checksum, modes) is ported from the MIT-licensed [andrew-codechimp/tsmart_ha](https://github.com/andrew-codechimp/tsmart_ha) Home Assistant integration (`custom_components/t_smart/tsmart.py`).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
