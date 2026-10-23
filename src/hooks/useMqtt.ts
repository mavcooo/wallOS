// Il bundle browser di mqtt.js espone solo il default export (namespace).
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { DISCOVERY, OFFLINE_QUEUE } from '@/config/app.config';
import { getAdapter } from '@/mqtt/adapters';
import {
  createHaDiscoveryBridge,
  type HaDiscoveryBridge,
} from '@/mqtt/discovery/haDiscoveryBridge';
import { captureRollback, optimisticState } from '@/mqtt/optimistic';
import {
  collapseKeyFor,
  commandTimeoutMs,
  describeAction,
  expireQueuedCommands,
  flushOfflineQueue,
  installQueueRuntime,
  reconcileQueuedCommands,
  restorePendingOptimisticState,
  useOfflineQueue,
  type QueuedCommand,
} from '@/mqtt/offlineQueue';
import { buildBrokerUrl, stateTopics, stripBaseTopic, withBaseTopic } from '@/mqtt/topics';
import { TelemetryUpdateBuffer } from '@/mqtt/updateBuffer';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { ControlAction, Device, Scenario, ScenarioId } from '@/types/device';
import type { BrokerSettings, PublishOptions, RawDirection, RawMqttMessage } from '@/types/mqtt';

const PROBE_TOPIC = 'domus/kiosk/ping';
const PROBE_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PAYLOAD_CHARS = 4_000;

type PublishFn = (topic: string, payload: string, options?: PublishOptions) => void;

function logRaw(
  direction: RawDirection,
  topic: string,
  payload: string,
  qos: 0 | 1 | 2 = 0,
  retain = false,
): void {
  const message: RawMqttMessage = {
    id: crypto.randomUUID(),
    direction,
    topic,
    payload:
      payload.length > MAX_PAYLOAD_CHARS ? `${payload.slice(0, MAX_PAYLOAD_CHARS)}…` : payload,
    qos,
    retain,
    at: Date.now(),
  };
  const store = useHomeStore.getState();
  store.appendRaw(message);
  if (direction !== 'system') store.countMessage(direction);
}

/** I device scoperti usano topic assoluti decisi dall'annuncio HA. */
function findDiscoveryDeviceByTopic(devices: Record<string, Device>, topic: string): Device | null {
  for (const device of Object.values(devices)) {
    if (!device.discovery) continue;
    if (stateTopics(device).includes(topic)) return device;
  }
  return null;
}

/** I device statici vivono sotto l'eventuale `baseTopic`. */
function findDeviceByTopic(devices: Record<string, Device>, topic: string): Device | null {
  for (const device of Object.values(devices)) {
    if (device.discovery) continue;
    if (stateTopics(device).includes(topic)) return device;
  }
  return null;
}

function brokerKey(broker: BrokerSettings): string {
  return [
    broker.host,
    broker.port,
    broker.protocol,
    broker.path,
    broker.clientId,
    broker.keepAlive,
    broker.username,
    broker.password,
    broker.baseTopic,
    broker.cleanSession,
    broker.demoMode,
  ].join('|');
}

export interface MqttApi {
  sendAction(deviceId: string, action: ControlAction): void;
  publishRaw(topic: string, payload: string, options?: PublishOptions): void;
  runScenario(id: ScenarioId): Promise<void>;
  reconnect(): void;
}

/**
 * Unica connessione MQTT dell'app.
 *
 * - sottoscrive i topic `stat` + `availability` dei device caricati dal server
 * - decodifica con l'adapter associato al device e applica il patch allo store
 * - riconnessione manuale con backoff esponenziale + jitter (no reconnectPeriod)
 * - latenza reale via topic di echo (fallback: PINGREQ/PINGRESP)
 * - in `demoMode` alimenta lo store con un simulatore locale, senza socket
 */
export function useMqtt(scenarios: readonly Scenario[]): MqttApi {
  const broker = useHomeStore((state) => state.broker);
  const telemetrySettings = useHomeStore((state) => state.telemetry);
  const key = useMemo(() => brokerKey(broker), [broker]);
  const publishRef = useRef<PublishFn | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const bufferRef = useRef<TelemetryUpdateBuffer | null>(null);

  // La finestra è tarabile a runtime senza riaprire la connessione MQTT.
  useEffect(() => {
    bufferRef.current?.setSettings(telemetrySettings);
  }, [telemetrySettings]);

  // Dopo un refresh accidentale la coda persistita viene riallineata alla UI;
  // il timer scarta i comandi scaduti anche se il tablet resta offline.
  useEffect(() => {
    restorePendingOptimisticState();
    expireQueuedCommands();
    const timer = window.setInterval(
      () => expireQueuedCommands(),
      OFFLINE_QUEUE.sweepIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const settings = useHomeStore.getState().broker;
    const store = useHomeStore.getState();
    const { patchConnection, setAvailability, setStatus } = store;
    const base = (topic: string) => withBaseTopic(settings, topic);

    // Un buffer per connessione: al reconnect viene svuotato e ricreato, così
    // nessun campione della sessione precedente può finire in quella nuova.
    const buffer = new TelemetryUpdateBuffer(
      {
        getDevice: (deviceId) => useHomeStore.getState().devices[deviceId] ?? null,
        applyCritical: (deviceId, decoded) =>
          useHomeStore.getState().applyDecoded(deviceId, decoded),
        applyTelemetry: (updates) => useHomeStore.getState().applyTelemetryBatch(updates),
      },
      useHomeStore.getState().telemetry,
    );
    bufferRef.current = buffer;

    let disposed = false;
    let client: MqttClient | null = null;
    let reconnectTimer: number | undefined;
    let probeTimer: number | undefined;
    let attempts = 0;
    let queueRuntimeCleanup: (() => void) | null = null;
    const pendingProbes = new Map<number, number>();

    function detachQueueRuntime() {
      queueRuntimeCleanup?.();
      queueRuntimeCleanup = null;
    }

    function closeClient() {
      detachQueueRuntime();
      if (!client) return;
      client.removeAllListeners();
      client.end(true);
      client = null;
    }

    /**
     * Publish di un comando in coda. Per i QoS 1 la Promise si chiude solo al
     * PUBACK (o all'ack timeout): è la conferma che consente il dequeue.
     */
    function publishQueuedCommand(
      instance: MqttClient,
      command: QueuedCommand,
    ): Promise<boolean> {
      return new Promise((resolve) => {
        if (disposed || !instance.connected) {
          resolve(false);
          return;
        }

        logRaw('out', command.topic, command.payload, command.qos, command.retain);
        let settled = false;
        const timeout = window.setTimeout(() => settle(false), OFFLINE_QUEUE.ackTimeoutMs);

        function settle(ok: boolean) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(ok);
        }

        try {
          instance.publish(
            withBaseTopic(settings, command.topic),
            command.payload,
            { qos: command.qos, retain: command.retain },
            (error) => settle(!error),
          );
        } catch {
          settle(false);
        }
      });
    }

    function scheduleReconnect(reason: string) {
      if (disposed) return;
      attempts += 1;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempts - 1));
      const wait = Math.round(delay + Math.random() * 400);
      setStatus('reconnecting');
      patchConnection({ reconnectAttempts: attempts, lastError: reason, latencyMs: null });
      logRaw('system', 'client', `Retry #${attempts} tra ${wait}ms · ${reason}`);
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        if (!disposed) openSocket();
      }, wait);
    }

    const subscribedTopics = new Set<string>();

    /** Un device scoperto dichiara topic assoluti; gli statici vivono sotto `baseTopic`. */
    function wireTopic(device: Device, topic: string): string {
      return device.discovery ? topic : base(topic);
    }

    /**
     * Sottoscrive i topic mancanti: discovery, probe e canali di ogni device.
     * Gira al connect e dopo ogni entità scoperta, così la sottoscrizione è
     * immediata senza riaprire il socket.
     */
    function subscribeAll(instance: MqttClient) {
      const desired = new Set<string>([base(PROBE_TOPIC)]);
      for (const prefix of DISCOVERY.prefixes) {
        // `<prefix>/<component>/<object_id>/config` e la variante con node_id.
        desired.add(`${prefix}/+/+/config`);
        desired.add(`${prefix}/+/+/+/config`);
      }
      for (const device of Object.values(useHomeStore.getState().devices)) {
        for (const topic of stateTopics(device)) desired.add(wireTopic(device, topic));
      }

      const missing = [...desired].filter((topic) => !subscribedTopics.has(topic));
      if (missing.length === 0) return;
      for (const topic of missing) subscribedTopics.add(topic);

      instance.subscribe(missing, { qos: 0 }, (error) => {
        logRaw(
          'system',
          'subscribe',
          error ? `Errore: ${error.message}` : `${missing.length} topic attivi`,
        );
      });
    }

    /** Stato o availability di un device, decodificato dall'adapter giusto. */
    function handleDeviceMessage(device: Device, topic: string, payload: string): void {
      if (device.topics.availability === topic) {
        setAvailability(device.id, payload.trim() === 'online' ? 'online' : 'offline');
        return;
      }

      const availability = device.discovery?.availability.find(
        (entry) => entry.topic === topic,
      );
      if (availability) {
        const expected = availability.payloadAvailable ?? 'online';
        setAvailability(device.id, payload.trim() === expected ? 'online' : 'offline');
        return;
      }

      const decoded = getAdapter(device.adapter).decode({ device, topic, payload });
      if (!decoded) return;
      // Se lo `stat` conferma un comando in coda, il comando è già applicato.
      reconcileQueuedCommands(device.id, decoded);
      // Il buffer separa campi critici (flush immediato) da telemetria
      // (coalescing + finestra configurabile).
      buffer.push(device.id, decoded);
    }

    const discoveryBridge: HaDiscoveryBridge = createHaDiscoveryBridge({
      prefixes: DISCOVERY.prefixes,
      onUpsert: (device) => {
        useHomeStore.getState().applyDiscoveryUpsert(device);
        logRaw(
          'system',
          'discovery',
          `+ ${device.name} · ${device.discovery?.configTopic ?? ''}`,
        );
        // I topic dell'entità appena scoperta vanno sottoscritti subito.
        if (client?.connected) subscribeAll(client);
      },
      onRemove: (entityId) => {
        useHomeStore.getState().applyDiscoveryRemove(entityId);
        logRaw('system', 'discovery', `− ${entityId}`);
      },
    });

    function openSocket() {
      if (disposed) return;
      closeClient();
      // Un socket nuovo riparte da zero con le sottoscrizioni.
      subscribedTopics.clear();
      setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
      logRaw('system', 'client', `Connessione a ${buildBrokerUrl(settings)}`);

      const options: IClientOptions = {
        clientId: settings.clientId,
        keepalive: settings.keepAlive,
        clean: settings.cleanSession,
        reconnectPeriod: 0,
        connectTimeout: 8_000,
        protocolVersion: 4,
      };
      if (settings.username) options.username = settings.username;
      if (settings.password) options.password = settings.password;

      try {
        client = mqtt.connect(buildBrokerUrl(settings), options);
      } catch (error) {
        scheduleReconnect(error instanceof Error ? error.message : 'Connessione non avviata');
        return;
      }

      publishRef.current = (topic, payload, publishOptions) => {
        client?.publish(topic, payload, {
          qos: publishOptions?.qos ?? 0,
          retain: publishOptions?.retain ?? false,
        });
      };

      const instance = client;

      // La coda riprende a pubblicare solo su questa istanza e solo da connessa.
      queueRuntimeCleanup = installQueueRuntime({
        isConnected: () => !disposed && client === instance && instance.connected,
        publish: (command) => publishQueuedCommand(instance, command),
      });

      instance.on('connect', () => {
        if (disposed || client !== instance) return;
        attempts = 0;
        setStatus('connected');
        patchConnection({ connectedAt: Date.now(), reconnectAttempts: 0, lastError: null });
        logRaw('system', 'client', 'Connesso · sottoscrizione topic');
        subscribeAll(instance);
        window.clearInterval(probeTimer);
        probeTimer = window.setInterval(() => {
          if (!client?.connected) return;
          instance.publish(base(PROBE_TOPIC), String(Date.now()), { qos: 0 });
        }, PROBE_INTERVAL_MS);
        // Flush FIFO di quanto accumulato mentre il tablet era offline.
        void flushOfflineQueue({ announce: true });
      });

      instance.on('message', (topic, payload, packet) => {
        if (disposed) return;
        const rawPayload = payload.toString();

        // Annuncio Home Assistant: config nuova, aggiornata o ritirata ("").
        if (discoveryBridge.matches(topic)) {
          discoveryBridge.handleMessage(topic, rawPayload);
          return;
        }

        if (topic === base(PROBE_TOPIC)) {
          const sentAt = Number.parseInt(rawPayload, 10);
          if (Number.isFinite(sentAt)) {
            patchConnection({ latencyMs: Math.max(0, Date.now() - sentAt) });
          }
          return;
        }

        const discovered = findDiscoveryDeviceByTopic(
          useHomeStore.getState().devices,
          topic,
        );
        if (discovered) {
          logRaw('in', topic, rawPayload, packet.qos as 0 | 1 | 2, packet.retain);
          handleDeviceMessage(discovered, topic, rawPayload);
          return;
        }

        const localTopic = stripBaseTopic(settings, topic);
        const device = findDeviceByTopic(useHomeStore.getState().devices, localTopic);
        logRaw('in', localTopic, rawPayload, packet.qos as 0 | 1 | 2, packet.retain);
        if (!device) return;
        handleDeviceMessage(device, localTopic, rawPayload);
      });

      instance.on('close', () => {
        if (disposed || client !== instance) return;
        setStatus('offline');
        patchConnection({ latencyMs: null });
        scheduleReconnect('Connessione chiusa dal broker');
      });

      instance.on('error', (error) => {
        if (disposed || client !== instance) return;
        patchConnection({ lastError: error.message, status: 'error' });
        logRaw('system', 'client', `Errore: ${error.message}`);
        // mqtt.js emette `close` subito dopo: il retry è gestito lì.
      });

      instance.on('packetsend', (packet) => {
        if (packet.cmd === 'pingreq' && 'messageId' in packet && packet.messageId !== undefined) {
          pendingProbes.set(packet.messageId, performance.now());
        }
      });
      instance.on('packetreceive', (packet) => {
        if (
          packet.cmd === 'pingresp' &&
          'messageId' in packet &&
          packet.messageId !== undefined
        ) {
          const sentAt = pendingProbes.get(packet.messageId);
          if (sentAt !== undefined) {
            pendingProbes.delete(packet.messageId);
            patchConnection({ latencyMs: Math.round(performance.now() - sentAt) });
          }
        }
      });
    }

    reconnectRef.current = () => {
      window.clearTimeout(reconnectTimer);
      attempts = 0;
      openSocket();
    };

    if (settings.demoMode) {
      setStatus('connecting');
      publishRef.current = () => {
        /* il simulatore applica i comandi in locale */
      };
      // Anche in demo la coda usa lo stesso percorso: publish locale + ACK.
      queueRuntimeCleanup = installQueueRuntime({
        isConnected: () =>
          !disposed && useHomeStore.getState().connection.status === 'connected',
        publish: (command) => {
          logRaw('out', command.topic, command.payload, command.qos, command.retain);
          return Promise.resolve(!disposed);
        },
      });
      reconnectRef.current = () => {
        setStatus('connected');
        patchConnection({ connectedAt: Date.now(), lastError: null, reconnectAttempts: 0 });
        void flushOfflineQueue({ announce: true });
      };
      const startTimer = window.setTimeout(() => {
        if (disposed) return;
        setStatus('connected');
        patchConnection({
          connectedAt: Date.now(),
          reconnectAttempts: 0,
          lastError: null,
          latencyMs: 9,
        });
        logRaw('system', 'client', 'DEMO · simulatore locale attivo');
        void flushOfflineQueue({ announce: true });
      }, 400);
      const demoTimer = window.setInterval(() => {
        if (!disposed) useHomeStore.getState().simulateTelemetry();
      }, 3_000);
      return () => {
        disposed = true;
        publishRef.current = null;
        reconnectRef.current = null;
        bufferRef.current = null;
        buffer.dispose();
        detachQueueRuntime();
        discoveryBridge.dispose();
        window.clearTimeout(startTimer);
        window.clearInterval(demoTimer);
      };
    }

    openSocket();

    return () => {
      disposed = true;
      publishRef.current = null;
      reconnectRef.current = null;
      bufferRef.current = null;
      // Flush finale: l'ultimo campione non va perso allo smontaggio.
      buffer.dispose();
      discoveryBridge.dispose();
      window.clearTimeout(reconnectTimer);
      window.clearInterval(probeTimer);
      closeClient();
    };
  }, [key]);

  const publishRaw = useCallback((topic: string, payload: string, options?: PublishOptions) => {
    const settings = useHomeStore.getState().broker;
    logRaw('out', topic, payload, options?.qos ?? 0, options?.retain ?? false);
    publishRef.current?.(withBaseTopic(settings, topic), payload, options);
  }, []);

  const sendAction = useCallback((deviceId: string, action: ControlAction) => {
    const state = useHomeStore.getState();
    const device = state.devices[deviceId];
    if (!device) return;
    const encoded = getAdapter(device.adapter).encode(device, action);
    if (!encoded) {
      useToastStore.getState().push({
        title: 'Comando non supportato',
        description: `${device.name} non accetta questa azione.`,
        tone: 'error',
      });
      return;
    }
    const optimistic = optimisticState(device, action);
    // Lo stato "prima" va letto prima di applicare la patch ottimistica: serve
    // al rollback se il TTL scade o il broker non conferma mai il comando.
    const rollback = captureRollback(device, optimistic);
    // `applyOptimistic` non marca il device come online: durante un blackout
    // il comando è solo intenzione locale, non telemetria ricevuta.
    if (optimistic) state.applyOptimistic(deviceId, optimistic);

    useOfflineQueue.getState().enqueue({
      deviceId,
      deviceName: device.name,
      topic: encoded.topic,
      payload: encoded.payload,
      qos: encoded.qos,
      retain: encoded.retain ?? false,
      timeoutMs: commandTimeoutMs(action),
      collapseKey: collapseKeyFor(action),
      label: describeAction(action),
      optimistic,
      rollback,
    });

    // Da connessi il flush parte subito; da offline il comando resta in coda
    // e verrà ripreso dall'handler `connect` alla riconnessione.
    void flushOfflineQueue();
  }, []);

  const runScenario = useCallback(
    async (id: ScenarioId) => {
      const scenario = scenarios.find((item) => item.id === id);
      if (!scenario) return;
      let elapsed = 0;
      for (const step of scenario.steps) {
        const delay = step.delayMs ?? 0;
        elapsed += delay;
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        sendAction(step.deviceId, step.action);
      }
      const offline = useHomeStore.getState().connection.status !== 'connected';
      const queued = useOfflineQueue.getState().commands.length;
      useToastStore.getState().push({
        title: offline
          ? `Scenario “${scenario.label}” in coda`
          : `Scenario “${scenario.label}” avviato`,
        description: offline
          ? `${queued} comandi in attesa di connessione: saranno inviati al ripristino (entro il TTL).`
          : `${scenario.steps.length} comandi inviati in ${elapsed} ms`,
        tone: offline ? 'info' : 'success',
      });
    },
    [scenarios, sendAction],
  );

  return { sendAction, publishRaw, runScenario, reconnect: () => reconnectRef.current?.() };
}
