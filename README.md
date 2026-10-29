# homebridge-tsmart

Homebridge plugin for **Tesla T-Smart** and other **EUROICC** water heaters. Local UDP only — control power and setpoint from Apple Home without Home Assistant.

## Install

In the Homebridge UI: **Plugins** → search **homebridge-tsmart** → **Install**. Then add a **TSmart** platform (or open the plugin **Settings**).

## Setup

1. Open plugin **Settings** — the LAN is scanned automatically (new heaters stay disabled).
2. Enable the heaters you want (↻ rescans if needed).
3. Use Homebridge’s **Save**. Accessories usually update live; restart only if HomeKit looks stale.

Prefer a **static DHCP reservation**. Device id survives IP changes — open Settings (or ↻) after a move to refresh known heaters’ IPs.

Discovery is not periodic; it runs when Settings opens and when you tap ↻.

## Apple Home

| What | Behavior |
| --- | --- |
| Heater tile | Off / Heat, target 15–70 °C, current temp = **High** probe (matches device display) |
| Low | Extra thermometer for the Low probe |
| Writes | Always **Manual** mode |

### Why no Eco / Smart / Timer / Travel / Boost switches

HomeKit has no first-class “preset mode” picker for heaters — only Off/Heat (+ setpoint). Exposing each T-Smart mode as a Switch clutters the accessory and fights Apple Home’s model (mutually exclusive toggles that aren’t a real radio control).

This plugin keeps the heater tile simple and uses **Manual** on every HomeKit write so schedules and automations stay predictable. Use **Apple Home automations** for time-based setpoints and power; leave Eco / Smart / Timer / Travel / Boost to the heater panel or vendor app.

## Config

Usually edited via Settings. JSON shape:

```json
{
  "platforms": [
    {
      "platform": "TSmart",
      "name": "T-Smart",
      "devices": [
        {
          "enabled": true,
          "name": "Water Heater",
          "ip": "192.168.1.50",
          "deviceId": "ABCD"
        }
      ]
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `devices[].enabled` | `false` = listed in config but hidden from HomeKit |
| `devices[].deviceId` | Stable id from discovery (survives IP changes) |

Legacy `modes` / `temperatureMode` keys are ignored if present.

## UDP port 1337

The protocol uses **UDP 1337** with no authentication. This plugin binds that port (`SO_REUSEADDR`) for control and discovery.

**Do not run Home Assistant’s `tsmart_ha` and this plugin on the same host if both bind 1337.**

Host and heater must be on the **same L2 broadcast domain** for discovery.

## Protocol attribution

Local UDP framing is ported from the MIT-licensed [andrew-codechimp/tsmart_ha](https://github.com/andrew-codechimp/tsmart_ha) integration (`custom_components/t_smart/tsmart.py`).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
