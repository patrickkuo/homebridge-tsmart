import type { ModeToggleId } from './types.js';

/**
 * Platform name used in Homebridge config.json
 */
export const PLATFORM_NAME = 'TSmart';

/**
 * Must match package.json `name`
 */
export const PLUGIN_NAME = 'homebridge-tsmart';

/** Wait after control_set before treating status as authoritative (matches HA). */
export const AFTER_CONTROL_REFRESH_MS = 2000;

export const POLL_INTERVAL_MS = 30_000;

/** Periodic UDP rediscovery to rebind heaters after IP / network changes. */
export const REDISCOVER_INTERVAL_MS = 5 * 60_000;

/** Debounce when accessories request rediscovery after poll failures. */
export const REDISCOVER_DEBOUNCE_MS = 5_000;

/** Align with tsmart_ha climate limits; device uses 0.1°C units. */
export const TEMP_MIN = 15;
export const TEMP_MAX = 70;
export const TEMP_STEP = 0.5;

export const MAX_STATUS_FAILURES = 3;

/**
 * Default mode switches when `modes` is omitted from config.
 * Keep in sync with config.schema.json default.
 */
export const DEFAULT_MODES: ModeToggleId[] = ['boost', 'away'];
