// Il bundle browser di mqtt.js espone solo il default export (namespace).
import { useQueryClient } from '@tanstack/react-query';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { DISCOVERY, OFFLINE_QUEUE } from '@/config/app.config';
import { useRooms } from '@/hooks/useTopologyQuery';
import i18n from '@/i18n';
import { availabilityChannels, parseAvailabilityPayload } from '@/lib/availability';
import { combineDevice, seedDeviceRealtimeState } from '@/lib/deviceState';
import {
  forgetDiscoveredDevice,
  rememberDiscoveredDevice,
  withDiscoveredDevice,
  withoutDiscoveredDevice,
} from '@/lib/discovery';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import type { Topology } from '@/lib/topologyApi';
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
import { isValidTopicFilter } from '@/mqtt/sniffer';
import { buildBrokerUrl, stripBaseTopic, withBaseTopic } from '@/mqtt/topics';
import { buildTopicIndex } from '@/mqtt/topicIndex';
import { TelemetryUpdateBuffer } from '@/mqtt/updateBuffer';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type {
  ControlAction,
  Device,
  DeviceMetadata,
  Scenario,
  ScenarioId,
} from '@/types/device';
import type { BrokerSettings, PublishOptions, RawDirection, RawMqttMessage } from '@/types/mqtt';

const PROBE_TOPIC = 'domus/kiosk/ping';
const PROBE_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PAYLOAD_CHARS = 4_000;
/** Dopo questo tempo offline il broker diventa un allarme critico. */
const BROKER_WATCHDOG_MS = 60_000;
const WATCHDOG_TICK_MS = 10_000;

type AlarmKind = 'smoke' | 'flood' | 'intrusion';

/** Booleani o stringhe (`true`, `"alarm"`) usati dai vari firmware. */
function isAlarmFlag(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === 'string' && /^(alarm|alarm_active|detected|true)$/i.test(value.trim());
}

/** Stato esplicito di allarme: `{"state": "ALARM"}`. */
function isAlarmState(value: unknown): boolean {
  return typeof value === 'string' && /^(alarm|alarm_active|detected)$/i.test(value.trim());
}

/** Tipo di allarme dedotto dal sensore quando il payload non lo dichiara. */
function sensorAlarmKind(device: Device): AlarmKind {
  if (device.kind === 'sensor') {
    if (device.state.type === 'smoke') return 'smoke';
    if (device.state.type === 'motion' || device.state.type === 'contact') return 'intrusion';
  }
  return 'intrusion';
}

/**
 * Riconosce gli allarmi nei payload dei sensori (Zigbee2MQTT, Tasmota, JSON
 * custom): restituisce `null` per la telemetria normale.
 */
function detectAlarm(device: Device, payload: string): AlarmKind | null {
  if (device.kind !== 'sensor') return null;

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (isAlarmFlag(data['smoke']) || isAlarmFlag(data['smoke_detected'])) return 'smoke';
  if (
    isAlarmFlag(data['water_leak']) ||
    isAlarmFlag(data['flood']) ||
    isAlarmFlag(data['water_detected'])
  ) {
    return 'flood';
  }
  if (isAlarmFlag(data['intrusion']) || isAlarmFlag(data['tamper']) || isAlarmFlag(data['alarm'])) {
    return 'intrusion';
  }
  if (isAlarmState(data['state']) || isAlarmState(data['status'])) return sensorAlarmKind(device);
  return null;
}

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
  /** Forza la riconciliazione dei topic (post-mutazione topologia). */
  refreshSubscriptions(): void;
  /** Ascolto temporaneo di filtri wildcard; il cleanup annulla ciò che non serve più. */
  subscribeSniffer(filters: readonly string[]): () => void;
}

/**
 * Unica connessione MQTT dell'app.
 *
 * - i metadati arrivano da TanStack Query (`devices`): qui non viene copiata
 *   nessuna topologia nello store
 * - i topic sono indicizzati: lookup O(1) per messaggio
 * - decodifica con l'adapter associato e patch O(1) della riga realtime
 * - riconnessione manuale con backoff esponenziale + jitter (no reconnectPeriod)
 * - latenza reale via topic di echo (fallback: PINGREQ/PINGRESP)
 * - in `demoMode` alimenta lo store con un simulatore locale, senza socket
 */
export function useMqtt(
  scenarios: readonly Scenario[],
  devices: readonly DeviceMetadata[],
): MqttApi {
  const queryClient = useQueryClient();
  const broker = useHomeStore((state) => state.broker);
  const telemetrySettings = useHomeStore((state) => state.telemetry);
  // Nomi stanza per il testo dell'allarme (le stanze vivono in TanStack Query).
  const rooms = useRooms();
  const roomNames = useMemo(
    () => new Map(rooms.map((room) => [room.id, room.label] as const)),
    [rooms],
  );
  const roomNamesRef = useRef(roomNames);
  const key = useMemo(() => brokerKey(broker), [broker]);
  const publishRef = useRef<PublishFn | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const bufferRef = useRef<TelemetryUpdateBuffer | null>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const subscribeAllRef = useRef<((instance: MqttClient) => void) | null>(null);
  // Filtri dello sniffer con conteggio: più dialog aperti non si annullano a vicenda.
  const snifferFiltersRef = useRef<Map<string, number>>(new Map());
  // Topic effettivamente sottoscritti sul socket corrente: condiviso con lo
  // sniffer, così una cancellazione non lascia la mappa "già iscritta".
  const subscribedTopicsRef = useRef<Set<string>>(new Set());

  const deviceIndex = useMemo(
    () => new Map(devices.map((device) => [device.id, device] as const)),
    [devices],
  );
  const topicIndex = useMemo(() => buildTopicIndex(devices, broker), [devices, broker]);
  const deviceIndexRef = useRef(deviceIndex);
  const topicIndexRef = useRef(topicIndex);

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
    deviceIndexRef.current = deviceIndex;
  }, [deviceIndex]);

  useEffect(() => {
    roomNamesRef.current = roomNames;
  }, [roomNames]);

  // Refetch/discovery: aggiorna l'indice e, se il socket è già connesso,
  // sottoscrive i nuovi topic senza riaprire la connessione.
  useEffect(() => {
    topicIndexRef.current = topicIndex;
    const client = clientRef.current;
    if (client?.connected) subscribeAllRef.current?.(client);
  }, [topicIndex]);

  useEffect(() => {
    const settings = useHomeStore.getState().broker;
    const store = useHomeStore.getState();
    const { patchConnection, setAvailability, setStatus } = store;
    const base = (topic: string) => withBaseTopic(settings, topic);

    // Un buffer per connessione: al reconnect viene svuotato e ricreato, così
    // nessun campione della sessione precedente può finire in quella nuova.
    const buffer = new TelemetryUpdateBuffer(
      {
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
    let watchdogTimer: number | undefined;
    let attempts = 0;
    let queueRuntimeCleanup: (() => void) | null = null;
    const pendingProbes = new Map<number, number>();
    // Allarmi già notificati: un payload retained non deve generare raffiche.
    const activeAlarms = new Set<string>();
    let brokerOfflineSince: number | null = null;
    let brokerAlertId: string | null = null;

    function detachQueueRuntime() {
      queueRuntimeCleanup?.();
      queueRuntimeCleanup = null;
    }

    function closeClient() {
      detachQueueRuntime();
      clientRef.current = null;
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

    const subscribedTopics = subscribedTopicsRef.current;

    /**
     * Riconcilia le sottoscrizioni: aggiunge i topic mancanti e annulla quelli
     * rimasti orfani dopo una cancellazione o un cambio di `state_topic`.
     * Lo sniffer contribuisce con i propri filtri finché è aperto.
     */
    function subscribeAll(instance: MqttClient) {
      const desired = new Set<string>([base(PROBE_TOPIC)]);
      for (const prefix of DISCOVERY.prefixes) {
        // `<prefix>/<component>/<object_id>/config` e la variante con node_id.
        desired.add(`${prefix}/+/+/config`);
        desired.add(`${prefix}/+/+/+/config`);
      }
      for (const topic of topicIndexRef.current.keys()) desired.add(topic);
      for (const filter of snifferFiltersRef.current.keys()) desired.add(filter);

      const stale = [...subscribedTopics].filter((topic) => !desired.has(topic));
      if (stale.length > 0) {
        for (const topic of stale) subscribedTopics.delete(topic);
        instance.unsubscribe(stale);
        logRaw('system', 'unsubscribe', `${stale.length} topic rimossi`);
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

    /**
     * Stato o availability di un device, decodificato dall'adapter giusto.
     *
     * LWT: il payload (Tasmota `Online`, Zigbee2MQTT `{"state":"online"}`,
     * Shelly `true`) viene normalizzato da un unico parser e tocca **solo**
     * `availability`/`isAvailable`: le metriche restano quelle dell'ultima
     * lettura, così la card mostra il dato congelato ma non interattivo.
     */
    function handleDeviceMessage(device: Device, topic: string, payload: string): void {
      const channel = availabilityChannels(device).find((entry) => entry.topic === topic);
      if (channel) {
        const state = parseAvailabilityPayload(payload, {
          payloadOnline: channel.payloadOnline,
          payloadOffline: channel.payloadOffline,
        });
        // Payload vuoto o sconosciuto: nessun cambio di stato.
        if (state) setAvailability(device.id, state);
        return;
      }

      // Allarmi: il payload di un sensore fumo/allagamento può non produrre
      // telemetria, quindi il controllo precede il decode.
      const alarm = detectAlarm(device, payload);
      if (alarm) {
        const key = `${device.id}:${alarm}`;
        if (!activeAlarms.has(key)) {
          activeAlarms.add(key);
          const roomName = roomNamesRef.current.get(device.room) ?? device.room;
          useToastStore.getState().addCritical({
            title: i18n.t(`alarm.types.${alarm}`),
            description: `${device.name} · ${roomName}`,
            metadata: { type: alarm, sensorId: device.id, room: device.room, roomName },
          });
        }
      } else if (device.kind === 'sensor') {
        // Sensore tornato in quiete: il prossimo allarme deve suonare di nuovo.
        for (const key of activeAlarms) {
          if (key.startsWith(`${device.id}:`)) activeAlarms.delete(key);
        }
      }

      const decoded = getAdapter(device.adapter).decode({ device, topic, payload });
      if (!decoded) return;
      // Se lo `stat` conferma un comando in coda, il comando è già applicato.
      reconcileQueuedCommands(device.id, decoded);
      // Il buffer separa campi critici (flush immediato) da telemetria
      // (coalescing + finestra configurabile). Riusa lo snapshot già composto
      // per il decode: nessuna seconda composizione lungo il percorso caldo.
      buffer.push(device, decoded);
    }

    const discoveryBridge: HaDiscoveryBridge = createHaDiscoveryBridge({
      prefixes: DISCOVERY.prefixes,
      onUpsert: (announced) => {
        // I metadati scoperti estendono la topologia in cache: nessun dato
        // strutturale entra in homeStore.
        const current = queryClient.getQueryData<Topology>(TOPOLOGY_QUERY_KEY);
        const { topology, device, room } = withDiscoveredDevice(
          current ?? { rooms: [], devices: [], scenarios: [] },
          announced,
        );
        if (current) queryClient.setQueryData(TOPOLOGY_QUERY_KEY, topology);
        rememberDiscoveredDevice(device, room);
        // Riga realtime immediata: lo stato retained può arrivare prima che
        // TopologyGate sincronizzi la mappa.
        if (!useHomeStore.getState().deviceStates[device.id]) {
          useHomeStore.getState().setBulkDeviceStates({
            [device.id]: seedDeviceRealtimeState(device),
          });
        }
        logRaw(
          'system',
          'discovery',
          `+ ${device.name} · ${device.discovery?.configTopic ?? ''}`,
        );
        // I topic dell'entità appena scoperta vanno sottoscritti subito.
        if (client?.connected) subscribeAll(client);
      },
      onRemove: (entityId) => {
        const current = queryClient.getQueryData<Topology>(TOPOLOGY_QUERY_KEY);
        if (current) {
          queryClient.setQueryData(
            TOPOLOGY_QUERY_KEY,
            withoutDiscoveredDevice(current, entityId),
          );
        }
        forgetDiscoveredDevice(entityId);
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
      clientRef.current = client;

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

        // Lookup O(1): la mappa è ricostruita solo al cambio di topologia.
        const metadata = topicIndexRef.current.get(topic);
        if (!metadata) {
          logRaw('in', stripBaseTopic(settings, topic), rawPayload, packet.qos as 0 | 1 | 2, packet.retain);
          return;
        }

        const device = combineDevice(
          metadata,
          useHomeStore.getState().deviceStates[metadata.id],
        );
        if (!device) return;

        const localTopic = device.discovery ? topic : stripBaseTopic(settings, topic);
        logRaw('in', localTopic, rawPayload, packet.qos as 0 | 1 | 2, packet.retain);
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

    subscribeAllRef.current = subscribeAll;

    // Watchdog broker: un'offline persistente diventa un allarme critico.
    watchdogTimer = window.setInterval(() => {
      if (disposed) return;
      if (useHomeStore.getState().connection.status === 'connected') {
        brokerOfflineSince = null;
        if (brokerAlertId) {
          useToastStore.getState().acknowledgeCritical(brokerAlertId);
          brokerAlertId = null;
        }
        return;
      }
      if (brokerOfflineSince === null) {
        brokerOfflineSince = Date.now();
        return;
      }
      if (brokerAlertId || Date.now() - brokerOfflineSince < BROKER_WATCHDOG_MS) return;
      brokerAlertId = useToastStore.getState().addCritical({
        title: i18n.t('alarm.watchdog.brokerTitle'),
        description: i18n.t('alarm.watchdog.brokerDescription'),
        metadata: { type: 'connection', source: 'broker' },
      });
    }, WATCHDOG_TICK_MS);

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
        subscribeAllRef.current = null;
        clientRef.current = null;
        buffer.dispose();
        detachQueueRuntime();
        discoveryBridge.dispose();
        window.clearTimeout(startTimer);
        window.clearInterval(demoTimer);
        window.clearInterval(watchdogTimer);
        if (brokerAlertId) useToastStore.getState().acknowledgeCritical(brokerAlertId);
      };
    }

    openSocket();

    return () => {
      disposed = true;
      publishRef.current = null;
      reconnectRef.current = null;
      bufferRef.current = null;
      subscribeAllRef.current = null;
      // Flush finale: l'ultimo campione non va perso allo smontaggio.
      buffer.dispose();
      discoveryBridge.dispose();
      window.clearTimeout(reconnectTimer);
      window.clearInterval(probeTimer);
      window.clearInterval(watchdogTimer);
      if (brokerAlertId) useToastStore.getState().acknowledgeCritical(brokerAlertId);
      closeClient();
    };
  }, [key, queryClient]);

  const refreshSubscriptions = useCallback(() => {
    const client = clientRef.current;
    if (client?.connected) subscribeAllRef.current?.(client);
  }, []);

  /**
   * Sniffer: sottoscrive filtri wildcard aggiuntivi. Al cleanup annulla solo i
   * filtri che non sono più richiesti né dallo sniffer né dalla topologia.
   */
  const subscribeSniffer = useCallback((filters: readonly string[]) => {
    const normalized = [...new Set(filters.map((filter) => filter.trim()))].filter(
      isValidTopicFilter,
    );
    const settings = useHomeStore.getState().broker;
    const base = settings.baseTopic.trim().replace(/^\/+|\/+$/g, '');
    // I topic dei device vivono sotto il base topic: anche lo sniffer ascolta
    // lì, altrimenti `tele/#` non vedrebbe `casa/tele/...`.
    const entries = normalized.map((filter) => ({
      local: filter,
      broker:
        base && filter !== base && !filter.startsWith(`${base}/`)
          ? `${base}/${filter}`
          : filter,
    }));

    for (const entry of entries) {
      snifferFiltersRef.current.set(
        entry.broker,
        (snifferFiltersRef.current.get(entry.broker) ?? 0) + 1,
      );
    }

    const brokerFilters = [...new Set(entries.map((entry) => entry.broker))];
    const client = clientRef.current;
    if (client?.connected && brokerFilters.length > 0) {
      for (const filter of brokerFilters) subscribedTopicsRef.current.add(filter);
      client.subscribe(brokerFilters, { qos: 0 }, (error) => {
        logRaw(
          'system',
          'sniffer',
          error ? `Errore: ${error.message}` : `${brokerFilters.length} filtri in ascolto`,
        );
      });
    }

    return () => {
      const stale: string[] = [];
      for (const filter of brokerFilters) {
        const count = (snifferFiltersRef.current.get(filter) ?? 1) - 1;
        if (count > 0) {
          snifferFiltersRef.current.set(filter, count);
          continue;
        }
        snifferFiltersRef.current.delete(filter);
        const topologyTopic =
          filter === withBaseTopic(settings, PROBE_TOPIC) ||
          DISCOVERY.prefixes.some(
            (prefix) =>
              filter === `${prefix}/+/+/config` || filter === `${prefix}/+/+/+/config`,
          ) ||
          topicIndexRef.current.has(filter);
        if (!topologyTopic) {
          stale.push(filter);
          subscribedTopicsRef.current.delete(filter);
        }
      }

      const current = clientRef.current;
      if (current?.connected && stale.length > 0) {
        current.unsubscribe(stale);
        logRaw('system', 'sniffer', `${stale.length} filtri rimossi`);
      }
    };
  }, []);

  const publishRaw = useCallback((topic: string, payload: string, options?: PublishOptions) => {
    const settings = useHomeStore.getState().broker;
    logRaw('out', topic, payload, options?.qos ?? 0, options?.retain ?? false);
    publishRef.current?.(withBaseTopic(settings, topic), payload, options);
  }, []);

  const sendAction = useCallback((deviceId: string, action: ControlAction) => {
    const metadata = deviceIndexRef.current.get(deviceId);
    const realtime = useHomeStore.getState().deviceStates[deviceId];
    const device = combineDevice(metadata, realtime);
    if (!device || !realtime) return;
    const encoded = getAdapter(device.adapter).encode(device, action);
    if (!encoded) {
      useToastStore.getState().push({
        title: 'Comando non supportato',
        description: `${device.name} non accetta questa azione.`,
        tone: 'error',
      });
      return;
    }
    const optimistic = optimisticState(realtime, action);
    // Lo stato "prima" va letto prima di applicare la patch ottimistica: serve
    // al rollback se il TTL scade o il broker non conferma mai il comando.
    const rollback = captureRollback(realtime, optimistic);
    // `applyOptimistic` non marca il device come online: durante un blackout
    // il comando è solo intenzione locale, non telemetria ricevuta.
    if (optimistic) useHomeStore.getState().applyOptimistic(deviceId, optimistic);

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
        title: i18n.t(
          offline ? 'scenarioToast.queuedTitle' : 'scenarioToast.startedTitle',
          { label: scenario.label },
        ),
        description: i18n.t(
          offline ? 'scenarioToast.queuedDescription' : 'scenarioToast.sentDescription',
          { count: offline ? queued : scenario.steps.length, elapsed },
        ),
        tone: offline ? 'info' : 'success',
      });
    },
    [scenarios, sendAction],
  );

  return {
    sendAction,
    publishRaw,
    runScenario,
    reconnect: () => reconnectRef.current?.(),
    refreshSubscriptions,
    subscribeSniffer,
  };
}
