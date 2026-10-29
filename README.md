# homebridge-tsmart

Homebridge plugin for **Tesla T-Smart** and other **EUROICC** water heaters. Control power and setpoint from Apple Home over the local network — no Home Assistant required.

## Install

The Homebridge UI Plugins search only finds packages on the **npm registry**. Until this plugin is published there, install on the **Homebridge host** (SSH or UI Terminal), not on your laptop:

```bash
sudo hb-service add github:patrickkuo/homebridge-tsmart
sudo hb-service restart
```

If `hb-service add` does not accept a GitHub URL:

```bash
cd /var/lib/homebridge
sudo npm install github:patrickkuo/homebridge-tsmart
sudo hb-service restart
```

Then add a **TSmart** platform in config (UI form or JSON).

**“Cannot find module …/dist/index.js”** means an old GitHub install without a build. On the Homebridge host:

```bash
cd /var/lib/homebridge/node_modules/homebridge-tsmart
sudo npm install --include=dev
sudo npm run build
sudo hb-service restart
```

## Setup

1. Open the plugin **Settings** — the LAN is scanned automatically (new heaters appear disabled).
2. Enable the heaters you want (↻ refreshes the scan if needed).
3. Use Homebridge’s **Save**. Accessories usually update live; restart only if HomeKit looks stale.

Prefer a **static DHCP reservation** when you can; device id tracking survives IP changes — open Settings (or hit ↻) after a move if needed (known ids get their IP updated; IP-only manual rows are linked when the same IP answers with an id).

Discovery is **not** periodic. It runs when Settings opens (and when you tap ↻).

## Config example

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
| `devices[].enabled` | Expose in Apple Home (`false` = listed but hidden) |

## What you get in Apple Home

- **Heater** tile (device name): Off / Heat, current temp = **High** probe, target temperature (15–70 °C)
- **Low** thermometer under the same accessory
- HomeKit writes use **Manual** mode (use Apple Home automations for schedules; Eco/Smart/Timer/Travel/Boost stay on the device / vendor app)

## UDP port 1337

The heater protocol uses **UDP port 1337** with no authentication. This plugin binds local port 1337 (`SO_REUSEADDR`) to talk to the device and for discovery broadcasts.

**Do not run the Home Assistant `tsmart_ha` integration and this plugin on the same host if both bind port 1337.**

Discovery requires the Homebridge host and heater on the **same L2 broadcast domain**.

## Protocol attribution

Local UDP framing is ported from the MIT-licensed [andrew-codechimp/tsmart_ha](https://github.com/andrew-codechimp/tsmart_ha) Home Assistant integration (`custom_components/t_smart/tsmart.py`).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
