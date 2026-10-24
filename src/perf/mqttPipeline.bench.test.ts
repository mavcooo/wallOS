import { describe, expect, it } from 'vitest';

import { DEFAULT_BROKER } from '@/config/app.config';
import { combineDevice } from '@/lib/deviceState';
import { getAdapter } from '@/mqtt/adapters';
import { stateTopics } from '@/mqtt/topics';
import { buildTopicIndex } from '@/mqtt/topicIndex';
import { TelemetryUpdateBuffer } from '@/mqtt/updateBuffer';
import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import type { Device } from '@/types/device';

/**
 * Benchmark del percorso caldo di un messaggio MQTT.
 *
 *   npm run bench:mqtt
 *
 * Misura ciò che scala con il numero di device: lookup topic→device, decode
 * dell'adapter, routing critico/telemetria del buffer e patch O(1) nello store.
 * Non misura il trasporto WebSocket di mqtt.js né il commit React (che è
 * isolato per card e verificato in `DeviceCard.isolation.test.tsx`).
 *
 * Il file è escluso dalla suite normale: si attiva con `--mode benchmark`.
 */
const RUN_BENCHMARK = import.meta.env.MODE === 'benchmark';
const DEVICE_COUNT = 50;
const VARIANTS = 2_048;

function cloneDevice(base: Device, index: number): Device {
  const clone = structuredClone(base);
  const suffix = `bench-${index}`;
  clone.id = `${base.id}-${suffix}`;
  clone.name = `${base.name} ${index + 1}`;
  clone.topics = {
    state: `${base.topics.state}/${suffix}`,
    ...(base.topics.command ? { command: `${base.topics.command}/${suffix}` } : {}),
    ...(base.topics.availability
      ? { availability: `${base.topics.availability}/${suffix}` }
      : {}),
  };
  return clone;
}

function scaleDevices(count: number): Device[] {
  return Array.from({ length: count }, (_, index) => {
    const base = SEED_TOPOLOGY.devices[index % SEED_TOPOLOGY.devices.length];
    if (!base) throw new Error('seed device mancante');
    return cloneDevice(base, index);
  });
}

/** Valore plausibile per un campo normalizzato, variabile a ogni tick. */
function sampleValue(field: string, device: Device, tick: number): unknown {
  switch (field) {
    case 'on':
    case 'power':
      return true;
    case 'brightness':
      return 60 + (tick % 40);
    case 'colorTemp':
      return 2700;
    case 'mode':
      return 'heat';
    case 'targetTemp':
      return 21.5;
    case 'currentTemp':
      return Number((20.4 + (tick % 10) / 10).toFixed(1));
    case 'humidity':
      return 47;
    case 'watts':
      return Number((40 + (tick % 1000) / 10).toFixed(1));
    case 'voltage':
      return 231;
    case 'current':
      return 0.18;
    case 'energyTodayKwh':
      return 1.42;
    case 'energyTotalKwh':
      return 523.1;
    case 'volume':
      return 35;
    case 'muted':
      return false;
    case 'nowPlaying':
      return 'Radio';
    case 'value': {
      if (device.kind !== 'sensor') return 0;
      if (device.state.type === 'contact') return false;
      if (device.state.type === 'motion') return true;
      if (device.state.type === 'smoke') return false;
      return Number((21.4 + (tick % 100) / 10).toFixed(1));
    }
    default:
      return undefined;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let node = target;
  for (const key of keys) {
    const child = node[key];
    if (typeof child !== 'object' || child === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

function payloadFor(device: Device, tick: number): string {
  const numeric = (base: number) => Number((base + (tick % 100) / 10).toFixed(1));

  switch (device.adapter) {
    case 'shelly': {
      if (device.kind === 'power') {
        return JSON.stringify({
          output: true,
          apower: numeric(42),
          voltage: 231,
          current: 0.18,
          aenergy: { total: 523100 },
        });
      }
      if (device.kind === 'climate') return JSON.stringify({ tC: numeric(20), humidity: 47 });
      if (device.kind === 'light') return JSON.stringify({ output: true, brightness: 72 });
      if (device.kind === 'sensor') {
        switch (device.state.type) {
          case 'temperature':
            return JSON.stringify({ tC: numeric(21) });
          case 'humidity':
            return JSON.stringify({ humidity: 47 });
          case 'contact':
            return JSON.stringify({ window: false });
          case 'motion':
            return JSON.stringify({ motion: true });
          default:
            return JSON.stringify({ tC: numeric(21) });
        }
      }
      return '{}';
    }
    case 'tasmota': {
      if (device.kind === 'power') {
        return JSON.stringify({
          POWER: 'ON',
          ENERGY: {
            Power: numeric(42),
            Voltage: 231,
            Current: 0.18,
            Today: 1.42,
            Total: 523.1,
          },
        });
      }
      if (device.kind === 'light') {
        return JSON.stringify({ POWER: 'ON', Dimmer: 72, CT: 250 });
      }
      if (device.kind === 'climate') {
        return JSON.stringify({
          Setpoint: 21.5,
          Temperature: numeric(20),
          Humidity: 47,
          Mode: 'heat',
          POWER: 'ON',
        });
      }
      return JSON.stringify({ ANALOG: { Temperature: numeric(21) } });
    }
    case 'custom-json': {
      const data: Record<string, unknown> = {};
      for (const [field, path] of Object.entries(device.fieldMap ?? {})) {
        if (field.startsWith('cmd.')) continue;
        const value = sampleValue(field, device, tick);
        if (value !== undefined) setPath(data, path, value);
      }
      return JSON.stringify(data);
    }
    default: {
      // Zigbee2MQTT: un payload JSON per tipo di device.
      if (device.kind === 'light') {
        return JSON.stringify({ state: 'ON', brightness: 180, color_temp: 250 });
      }
      if (device.kind === 'climate') {
        return JSON.stringify({
          system_mode: 'heat',
          occupied_heating_setpoint: 21.5,
          local_temperature: numeric(20),
          humidity: 47,
          running_state: 'heat',
          fan_mode: 'auto',
          swing_mode: 'off',
        });
      }
      if (device.kind === 'power') {
        return JSON.stringify({
          state: 'ON',
          power: numeric(42),
          voltage: 231,
          current: 0.18,
          energy_today: 1.42,
          energy: 523.1,
        });
      }
      if (device.kind === 'sensor') {
        switch (device.state.type) {
          case 'temperature':
            return JSON.stringify({ temperature: numeric(21) });
          case 'humidity':
            return JSON.stringify({ humidity: 47 });
          case 'co2':
            return JSON.stringify({ co2: 620 + (tick % 50) });
          case 'illuminance':
            return JSON.stringify({ illuminance: 340 });
          case 'contact':
            return JSON.stringify({ contact: false });
          case 'motion':
            return JSON.stringify({ occupancy: true });
          case 'smoke':
            return JSON.stringify({ smoke: false });
          default:
            return JSON.stringify({ temperature: numeric(21) });
        }
      }
      return JSON.stringify({ volume: 35 });
    }
  }
}

interface Timing {
  label: string;
  iterations: number;
  meanUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  messagesPerSecond: number;
}

function time(label: string, iterations: number, run: (index: number) => void): Timing {
  const warmup = Math.min(5_000, iterations);
  for (let index = 0; index < warmup; index += 1) run(index);

  const samples = new Float64Array(iterations);
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const tick = performance.now();
    run(index);
    samples[index] = performance.now() - tick;
  }
  const elapsed = performance.now() - started;
  samples.sort();

  const percentile = (ratio: number) =>
    samples[Math.min(iterations - 1, Math.floor(ratio * iterations))] ?? 0;

  return {
    label,
    iterations,
    meanUs: (elapsed / iterations) * 1000,
    p50Us: percentile(0.5) * 1000,
    p95Us: percentile(0.95) * 1000,
    p99Us: percentile(0.99) * 1000,
    messagesPerSecond: Math.round(iterations / (elapsed / 1000)),
  };
}

describe.skipIf(!RUN_BENCHMARK)('benchmark · costo per messaggio MQTT', () => {
  it(`${DEVICE_COUNT} dispositivi: lookup, decode, buffer e store`, () => {
    const devices = scaleDevices(DEVICE_COUNT);
    const topicIndex = buildTopicIndex(devices, DEFAULT_BROKER);
    const stateTopicsOfDevices = devices.map((device) => device.topics.state);
    const payloads = new Map(
      devices.map((device) => [
        device.id,
        Array.from({ length: VARIANTS }, (_, tick) => payloadFor(device, tick)),
      ]),
    );

    useHomeStore.getState().syncDeviceStates(devices);

    const buffer = new TelemetryUpdateBuffer(
      {
        applyCritical: (deviceId, decoded) =>
          useHomeStore.getState().applyDecoded(deviceId, decoded),
        applyTelemetry: (updates) => useHomeStore.getState().applyTelemetryBatch(updates),
      },
      { throttleMs: 1_000, significantDeltaRatio: 0.02 },
    );

    const lookupOnly = time('lookup O(1) + composizione view-model', 200_000, (index) => {
      const topic = stateTopicsOfDevices[index % stateTopicsOfDevices.length] ?? '';
      const metadata = topicIndex.get(topic);
      if (!metadata) throw new Error(`topic non indicizzato: ${topic}`);
      combineDevice(metadata, useHomeStore.getState().deviceStates[metadata.id]);
    });

    // Baseline dello store pre-refactor: scansione lineare con `stateTopics`.
    const linear = time('lookup lineare (baseline: find + stateTopics)', 5_000, (index) => {
      const topic = stateTopicsOfDevices[index % stateTopicsOfDevices.length] ?? '';
      const found = devices.find((device) => stateTopics(device).includes(topic));
      if (!found) throw new Error(`topic non trovato: ${topic}`);
      return found;
    });

    // End-to-end del percorso caldo. `flush()` a ogni messaggio è il caso
    // peggiore: in produzione il buffer coalesce la telemetria su una finestra.
    const endToEnd = time('end-to-end (lookup + decode + buffer + store)', 100_000, (index) => {
      const topic = stateTopicsOfDevices[index % stateTopicsOfDevices.length] ?? '';
      const metadata = topicIndex.get(topic);
      if (!metadata) throw new Error(`topic non indicizzato: ${topic}`);
      const device = combineDevice(
        metadata,
        useHomeStore.getState().deviceStates[metadata.id],
      );
      if (!device) throw new Error(`device non composto: ${metadata.id}`);

      const variants = payloads.get(metadata.id);
      if (!variants) throw new Error(`payload mancante: ${metadata.id}`);
      const decoded = getAdapter(device.adapter).decode({
        device,
        topic,
        payload: variants[index % variants.length] ?? '{}',
      });
      if (!decoded) return;

      buffer.push(device, decoded);
      buffer.flush();
    });

    buffer.dispose();

    // Il lookup non deve dipendere dal numero di device: 10 → 500 resta piatto.
    const scaling = [10, 50, 100, 500].map((size) => {
      const sized = size === DEVICE_COUNT ? devices : scaleDevices(size);
      const index = buildTopicIndex(sized, DEFAULT_BROKER);
      const topics = sized.map((device) => device.topics.state);
      const timing = time(`lookup · ${size} device`, 100_000, (indexInLoop) => {
        const topic = topics[indexInLoop % topics.length] ?? '';
        if (!index.get(topic)) throw new Error(`topic non indicizzato: ${topic}`);
      });
      return {
        devices: size,
        'lookup ns/msg': Math.round(timing.meanUs * 1000),
        'msg/s': timing.messagesPerSecond,
      };
    });

    const results = [endToEnd, lookupOnly, linear];
    console.log(`\nMQTT hot path · ${DEVICE_COUNT} dispositivi · Node ${process.version}`);
    console.table(
      results.map((result) => ({
        scenario: result.label,
        'mean µs/msg': Number(result.meanUs.toFixed(2)),
        'p50 µs': Number(result.p50Us.toFixed(2)),
        'p95 µs': Number(result.p95Us.toFixed(2)),
        'p99 µs': Number(result.p99Us.toFixed(2)),
        'msg/s': result.messagesPerSecond,
      })),
    );
    console.log(
      `lookup O(1): ${(lookupOnly.meanUs * 1000).toFixed(0)} ns/msg · ` +
        `lineare: ${(linear.meanUs * 1000).toFixed(0)} ns/msg · ` +
        `accelerazione ${(linear.meanUs / lookupOnly.meanUs).toFixed(1)}×\n`,
    );
    console.table(scaling);
    console.log('');

    // Sanity: ogni device ha una riga e un topic indicizzato.
    expect(Object.keys(useHomeStore.getState().deviceStates)).toHaveLength(DEVICE_COUNT);
    expect(topicIndex.size).toBeGreaterThanOrEqual(DEVICE_COUNT);
    // Guardrail larghi: intercettano regressioni patologiche, non il rumore.
    expect(endToEnd.meanUs).toBeLessThan(250);
    expect(lookupOnly.meanUs).toBeLessThan(linear.meanUs);
  });
});
