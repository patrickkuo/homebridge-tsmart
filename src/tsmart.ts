import dgram from 'node:dgram';

import { SerialQueue } from './serialQueue.js';

export const UDP_PORT = 1337;

const TIMEOUT_MS = 2000;
const MAX_TRIES = 2;
const MAX_INVALID_RESPONSES = 5;
const STATUS_RESPONSE_SIZE = 30;
const CONTROL_RESPONSE_SIZE = 4;

/** Serialize all UDP bind/send on port 1337 across devices. */
const udpQueue = new SerialQueue();

export enum TSmartMode {
  Manual = 0,
  Eco = 1,
  Smart = 2,
  Timer = 3,
  Travel = 4,
  Boost = 5,
}

/** True for device mode bytes 0–5. */
export function isValidDeviceMode(mode: number): mode is TSmartMode {
  return Number.isInteger(mode) && mode >= TSmartMode.Manual && mode <= TSmartMode.Boost;
}

export interface TSmartStatus {
  power: boolean;
  setpoint: number;
  mode: TSmartMode;
  temperatureHigh: number;
  temperatureLow: number;
  temperatureAverage: number;
  relay: boolean;
}

/** Device found via UDP broadcast discovery (cmd 0x01). */
export interface DiscoveredDevice {
  ipAddress: string;
  deviceId: string;
  name: string;
}

export type TSmartLogger = {
  debug: (message: string, ...args: unknown[]) => void;
};

const DISCOVERY_RESPONSE_SIZE = 43; // struct =BBBHL32sBB
const CONFIG_RESPONSE_SIZE = 326; // struct =BBBHL32sBBBBB32s28s32s64s124s
const DISCOVERY_TRIES = 2;

export interface TSmartDeviceIdentity {
  deviceId: string;
  name: string;
}

function xorChecksum(message: Buffer): number {
  let checksum = 0;
  for (let i = 0; i < message.length - 1; i++) {
    checksum ^= message[i]!;
  }
  return checksum ^ 0x55;
}

function isValidChecksum(message: Buffer): boolean {
  return message.length >= 2 && xorChecksum(message) === message[message.length - 1];
}

function applyChecksum(data: Buffer): Buffer {
  data[data.length - 1] = xorChecksum(data);
  return data;
}

function isValidResponse(
  data: Buffer,
  request: Buffer,
  expectedSize: number,
): boolean {
  if (data.length !== expectedSize || data[0] === 0) {
    return false;
  }
  if (data[0] !== request[0] || data[1] !== request[1] || data[2] !== request[2]) {
    return false;
  }
  return isValidChecksum(data);
}

/** device_id @ offset 5 (uint32 LE), name @ offset 9 (32 bytes) — discovery + 0x21. */
function parsePackedIdentity(data: Buffer): TSmartDeviceIdentity {
  const deviceId = data.readUInt32LE(5).toString(16).toUpperCase().padStart(4, '0');
  const name = data
    .subarray(9, 41)
    .toString('utf8')
    .replace(/\0.*$/, '')
    .trim();

  return {
    deviceId,
    name: name.length > 0 ? name : `T-Smart ${deviceId}`,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDiscoveryResponse(
  data: Buffer,
  request: Buffer,
): Omit<DiscoveredDevice, 'ipAddress'> | null {
  if (data.length === request.length) {
    // Echo of our own broadcast
    return null;
  }
  if (data.length !== DISCOVERY_RESPONSE_SIZE || data[0] === 0) {
    return null;
  }
  if (data[0] !== request[0] || data[1] !== request[1] || data[2] !== request[2]) {
    return null;
  }
  if (!isValidChecksum(data)) {
    return null;
  }

  return parsePackedIdentity(data);
}

/**
 * Broadcast-discover T-Smart heaters on the LAN (same as tsmart_ha).
 * Holds the global UDP lock for the full listen window.
 */
export async function discoverDevices(
  log?: TSmartLogger,
  tries = DISCOVERY_TRIES,
): Promise<DiscoveredDevice[]> {
  return udpQueue.enqueue(() => discoverDevicesUnlocked(log, tries));
}

async function discoverDevicesUnlocked(
  log: TSmartLogger | undefined,
  tries: number,
): Promise<DiscoveredDevice[]> {
  const request = applyChecksum(Buffer.from([0x01, 0, 0, 0]));
  const found = new Map<string, DiscoveredDevice>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(UDP_PORT, () => {
        socket.setBroadcast(true);
        resolve();
      });
    });

    socket.on('message', (msg, rinfo) => {
      const parsed = parseDiscoveryResponse(msg, request);
      if (!parsed) {
        return;
      }
      if (found.has(rinfo.address)) {
        return;
      }
      const device: DiscoveredDevice = {
        ipAddress: rinfo.address,
        deviceId: parsed.deviceId,
        name: parsed.name,
      };
      found.set(rinfo.address, device);
      log?.debug('Discovered %s (%s) at %s', device.name, device.deviceId, device.ipAddress);
    });

    for (let attempt = 0; attempt < tries; attempt++) {
      await new Promise<void>((resolve, reject) => {
        socket.send(request, UDP_PORT, '255.255.255.255', (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await sleep(TIMEOUT_MS);
    }
  } finally {
    socket.removeAllListeners();
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  return [...found.values()];
}

/** @internal Exported for unit tests only. */
export const __test__ = { parseDiscoveryResponse };

/**
 * Local UDP client for Tesla T-Smart / EUROICC heaters.
 * Protocol ported from andrew-codechimp/tsmart_ha (MIT).
 */
export class TSmartClient {
  constructor(
    readonly ipAddress: string,
    private readonly log?: TSmartLogger,
  ) {}

  async getStatus(): Promise<TSmartStatus> {
    const request = applyChecksum(Buffer.from([0xf1, 0, 0, 0]));
    const response = await udpQueue.enqueue(() =>
      this.requestUnlocked(request, STATUS_RESPONSE_SIZE),
    );

    const modeByte = response[6]!;
    if (!isValidDeviceMode(modeByte)) {
      throw new Error(`Invalid mode byte from ${this.ipAddress}: ${modeByte}`);
    }

    const power = response[3] !== 0;
    const setpoint = response.readUInt16LE(4) / 10;
    const tHigh = response.readUInt16LE(7) / 10;
    const relay = response[9] !== 0;
    const tLow = response.readUInt16LE(11) / 10;

    return {
      power,
      setpoint,
      mode: modeByte,
      temperatureHigh: tHigh,
      temperatureLow: tLow,
      // Matches HA: (raw_high + raw_low) / 20 after converting from 0.1°C units
      temperatureAverage: (tHigh + tLow) / 2,
      relay,
    };
  }

  async controlSet(power: boolean, mode: TSmartMode, setpoint: number): Promise<void> {
    if (!isValidDeviceMode(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }

    const request = Buffer.alloc(8);
    request[0] = 0xf2;
    request[3] = power ? 1 : 0;
    request.writeUInt16LE(Math.round(setpoint * 10), 4);
    request[6] = mode;
    applyChecksum(request);

    await udpQueue.enqueue(() =>
      this.requestUnlocked(request, CONTROL_RESPONSE_SIZE),
    );
  }

  /** Read device id + name (cmd 0x21) — used to bind stable identity for static IPs. */
  async getIdentity(): Promise<TSmartDeviceIdentity> {
    const request = applyChecksum(Buffer.from([0x21, 0, 0, 0]));
    const response = await udpQueue.enqueue(() =>
      this.requestUnlocked(request, CONFIG_RESPONSE_SIZE),
    );

    return parsePackedIdentity(response);
  }

  private async requestUnlocked(
    request: Buffer,
    expectedSize: number,
  ): Promise<Buffer> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        return await this.sendOnce(request, expectedSize);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log?.debug(
          'T-Smart request failed (attempt %d/%d) to %s: %s',
          attempt + 1,
          MAX_TRIES,
          this.ipAddress,
          lastError.message,
        );
      }
    }

    throw lastError ?? new Error(`No response from ${this.ipAddress}`);
  }

  private sendOnce(request: Buffer, expectedSize: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      let invalidCount = 0;

      const cleanup = () => {
        socket.removeAllListeners();
        try {
          socket.close();
        } catch {
          // already closed
        }
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      };

      const succeed = (msg: Buffer) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(msg);
      };

      const timer = setTimeout(() => {
        fail(new Error(`Timeout waiting for response from ${this.ipAddress}`));
      }, TIMEOUT_MS);

      socket.once('error', (error) => fail(error));

      socket.on('message', (msg) => {
        if (!isValidResponse(msg, request, expectedSize)) {
          invalidCount += 1;
          this.log?.debug(
            'Ignoring invalid UDP response from %s (%d bytes, %d/%d)',
            this.ipAddress,
            msg.length,
            invalidCount,
            MAX_INVALID_RESPONSES,
          );
          if (invalidCount >= MAX_INVALID_RESPONSES) {
            fail(new Error(`Too many invalid responses from ${this.ipAddress}`));
          }
          return;
        }
        succeed(msg);
      });

      // Bind local 1337 then connect so we only receive from this heater (matches HA).
      socket.bind(UDP_PORT, () => {
        socket.connect(UDP_PORT, this.ipAddress, () => {
          socket.send(request, (error) => {
            if (error) {
              fail(error);
            } else {
              this.log?.debug('Sent UDP request to %s', this.ipAddress);
            }
          });
        });
      });
    });
  }
}
