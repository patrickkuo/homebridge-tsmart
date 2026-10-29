import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import { mergeDiscoveredIntoDevices } from '../dist/configStore.js';
import { discoverDevices } from '../dist/tsmart.js';

/**
 * Settings-modal backend. Spawned when the user opens plugin settings;
 * terminated when the modal closes. Discovery runs here so Scan does not
 * require saving config or restarting Homebridge.
 */
class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/scan', this.handleScan.bind(this));
    this.ready();
  }

  async handleScan(payload = {}) {
    const found = await discoverDevices();
    const hits = found.map((hit) => ({
      name: hit.name,
      ip: hit.ipAddress,
      deviceId: hit.deviceId,
    }));

    const existing = Array.isArray(payload.devices) ? payload.devices : [];
    const merged = mergeDiscoveredIntoDevices(existing, hits, { addNew: true });

    return merged;
  }
}

(() => new UiServer())();
