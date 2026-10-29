/* global homebridge */

/** @type {{ platform: string, name: string, devices?: object[] }} */
let config = {
  platform: 'TSmart',
  name: 'T-Smart',
  devices: [],
};

const statusEl = () => document.getElementById('status');
const devicesEl = () => document.getElementById('devices');

function setStatus(message, kind = '') {
  const el = statusEl();
  el.textContent = message || '';
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

/** Drop legacy keys so Saves clean old configs. */
function sanitizeDevice(device) {
  const next = { ...device };
  delete next.modes;
  delete next.temperatureMode;
  return next;
}

function sanitizeConfig(raw) {
  return {
    platform: 'TSmart',
    name: 'T-Smart',
    devices: Array.isArray(raw.devices)
      ? raw.devices.map((d) => sanitizeDevice({ ...d }))
      : [],
  };
}

function renderDevices() {
  const root = devicesEl();
  root.innerHTML = '';
  const devices = Array.isArray(config.devices) ? config.devices : [];
  document.getElementById('emptyDevices').style.display = devices.length ? 'none' : 'block';

  devices.forEach((device, index) => {
    const card = document.createElement('section');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const heading = document.createElement('h6');
    heading.className = 'card-heading';
    heading.textContent = device.name?.trim() || `Device ${index + 1}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${heading.textContent}`);
    remove.title = 'Close';
    remove.addEventListener('click', () => {
      config.devices.splice(index, 1);
      renderDevices();
      void pushConfig();
    });

    header.append(heading, remove);

    const body = document.createElement('div');
    body.className = 'card-body';

    const enableRow = document.createElement('div');
    enableRow.className = 'row';
    const enableLabel = document.createElement('label');
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = device.enabled !== false;
    enable.addEventListener('change', () => {
      config.devices[index].enabled = enable.checked;
      void pushConfig();
    });
    enableLabel.append(enable, document.createTextNode(' Enable in HomeKit'));
    enableRow.append(enableLabel);

    const fields = document.createElement('div');
    fields.className = 'row';
    fields.innerHTML = `
      <div class="field"><label>Name</label><input data-field="name" type="text" /></div>
      <div class="field"><label>IP</label><input data-field="ip" type="text" /></div>
      <div class="field"><label>Device ID</label><input data-field="deviceId" type="text" /></div>
    `;
    fields.querySelector('[data-field="name"]').value = device.name || '';
    fields.querySelector('[data-field="ip"]').value = device.ip || '';
    fields.querySelector('[data-field="deviceId"]').value = device.deviceId || '';
    for (const input of fields.querySelectorAll('input')) {
      input.addEventListener('change', () => {
        const field = input.getAttribute('data-field');
        config.devices[index][field] = input.value.trim();
        if (field === 'name') {
          heading.textContent = input.value.trim() || `Device ${index + 1}`;
          remove.setAttribute('aria-label', `Remove ${heading.textContent}`);
        }
        void pushConfig();
      });
    }

    body.append(enableRow, fields);
    card.append(header, body);
    root.append(card);
  });
}

async function pushConfig() {
  config = sanitizeConfig(config);
  await homebridge.updatePluginConfig([config]);
}

async function loadConfig() {
  const blocks = await homebridge.getPluginConfig();
  if (blocks.length > 0) {
    config = sanitizeConfig(blocks[0]);
  }
  renderDevices();
  await pushConfig();
}

async function onScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  setStatus('Scanning LAN for T-Smart heaters…');
  try {
    const merged = await homebridge.request('/scan', {
      devices: config.devices || [],
    });
    config.devices = Array.isArray(merged?.devices) ? merged.devices : config.devices;
    renderDevices();
    await pushConfig();
    const added = merged?.added ?? 0;
    const updated = merged?.updated ?? 0;
    const ipChanged = merged?.ipChanged ?? 0;
    const promoted = merged?.promoted ?? 0;
    if (!added && !updated) {
      setStatus('No heaters found on the LAN.');
    } else {
      const bits = [`${added} new`, `${updated} known`];
      if (ipChanged) {
        bits.push(`${ipChanged} IP updated`);
      }
      if (promoted) {
        bits.push(`${promoted} linked to existing row`);
      }
      setStatus(
        `Scan complete: ${bits.join(', ')}. Enable new ones, then Save (restart if HomeKit did not update).`,
        'ok',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Scan failed: ${message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function onSave() {
  await pushConfig();
  await homebridge.savePluginConfig();
  setStatus('Saved. HomeKit accessories update shortly; restart if anything looks stale.', 'ok');
  homebridge.toast.success('Settings saved');
}

function onAddManual() {
  config.devices = config.devices || [];
  config.devices.push({
    enabled: true,
    name: 'Water Heater',
    ip: '',
  });
  renderDevices();
  void pushConfig();
}

document.getElementById('scanBtn').addEventListener('click', () => void onScan());
document.getElementById('saveBtn').addEventListener('click', () => void onSave());
document.getElementById('addBtn').addEventListener('click', onAddManual);

void loadConfig();
