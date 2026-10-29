/**
 * Verifica end-to-end dell'hardening del broker Mosquitto.
 *
 * Contro un broker con `mosquitto.prod.conf` + `mosquitto/config/acl`:
 *   1. client anonimo TCP (1883) e WebSocket (9001) → Connection Refused (RC 5);
 *   2. `wallos_kiosk` pubblica un comando leggittimo su `cmnd/#`;
 *   3. lo stesso kiosk non può pubblicare su `wallos/system/#` né sovrascrivere
 *      uno stato retained su `stat/#`;
 *   4. `wallos_backend` legge gli stati e scrive gli eventi di sistema.
 *
 * Uso (con .env già provisionato da tools/init-mqtt-auth.sh):
 *   node tools/mqtt-auth-check.mjs
 *
 * Variabili: MQTT_TEST_HOST (127.0.0.1), MQTT_TEST_PORT (1883),
 * MQTT_TEST_WS_PORT (9001), MOSQUITTO_BACKEND_USERNAME/PASSWORD,
 * MOSQUITTO_KIOSK_USERNAME/PASSWORD.
 *
 * Exit code: 0 tutte le verifiche passano · 1 almeno una fallisce · 2 config.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt from 'mqtt';

try {
  // Node >= 20.12: stesso .env usato da compose e dai tool.
  process.loadEnvFile?.();
} catch {
  // Nessun .env: si usano solo le variabili già nell'ambiente.
}

const HOST = process.env.MQTT_TEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MQTT_TEST_PORT ?? 1883);
const WS_PORT = Number(process.env.MQTT_TEST_WS_PORT ?? 9001);
const TCP_URL = `mqtt://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${WS_PORT}/mqtt`;

const BACKEND = {
  username: process.env.MOSQUITTO_BACKEND_USERNAME ?? 'wallos_backend',
  password: process.env.MOSQUITTO_BACKEND_PASSWORD ?? '',
};
const KIOSK = {
  username: process.env.MOSQUITTO_KIOSK_USERNAME ?? 'wallos_kiosk',
  password: process.env.MOSQUITTO_KIOSK_PASSWORD ?? '',
};

if (!BACKEND.password || !KIOSK.password) {
  console.error(
    'Errore: MOSQUITTO_BACKEND_PASSWORD / MOSQUITTO_KIOSK_PASSWORD mancanti.\n' +
      'Esegui prima tools/init-mqtt-auth.sh e carica il .env.',
  );
  process.exit(2);
}

const suffix = Date.now().toString(36);
const CMD_TOPIC = `cmnd/authcheck_${suffix}/POWER`;
const SYSTEM_TOPIC = `wallos/system/authcheck_${suffix}`;
const STATE_TOPIC = `stat/authcheck_${suffix}/POWER`;

const clients = new Set();
const failures = [];

function check(name, ok, detail = '') {
  const label = ok ? 'OK  ' : 'FAIL';
  console.log(`${label} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** Matching minimale dei filtri MQTT (`+` e `#`). */
function matches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let index = 0; index < f.length; index += 1) {
    if (f[index] === '#') return true;
    if (f[index] === '+') {
      if (t[index] === undefined) return false;
      continue;
    }
    if (f[index] !== t[index]) return false;
  }
  return t.length === f.length;
}

function connect(url, credentials) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      clientId: `authcheck-${randomUUID()}`,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 5_000,
      ...(credentials?.username ? { username: credentials.username } : {}),
      ...(credentials?.password ? { password: credentials.password } : {}),
    });
    clients.add(client);

    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`timeout di connessione a ${url}`));
    }, 7_000);

    client.once('connect', () => {
      clearTimeout(timer);
      client.removeListener('error', onError);
      resolve(client);
    });
    function onError(error) {
      clearTimeout(timer);
      client.end(true);
      reject(error);
    }
    client.once('error', onError);
  });
}

/** Il broker deve rifiutare la connessione anonima con RC 5 (Not authorized). */
async function expectRefused(url, label) {
  try {
    const client = await connect(url);
    client.end(true);
    check(label, false, 'connessione anonima accettata');
  } catch (error) {
    const code = error?.connack?.returnCode ?? error?.code;
    const authorized = code === 5 || /not authori[sz]ed|refused/i.test(error?.message ?? '');
    check(label, authorized, error?.message ?? 'connessione rifiutata');
  }
}

function subscribe(client, filter) {
  return new Promise((resolve, reject) => {
    client.subscribe(filter, { qos: 1 }, (error, granted) => {
      if (error) {
        reject(error);
        return;
      }
      const denied = (granted ?? []).some((entry) => entry.qos === 128);
      if (denied) {
        reject(new Error(`sottoscrizione negata dal broker: ${filter}`));
        return;
      }
      resolve();
    });
  });
}

function collect(client, filter) {
  const messages = [];
  client.on('message', (topic, payload) => {
    if (matches(filter, topic)) {
      messages.push({ topic, payload: payload.toString('utf8') });
    }
  });
  return messages;
}

function publish(client, topic, payload, options = {}) {
  return new Promise((resolve) => {
    client.publish(topic, payload, { qos: 1, ...options }, (error) => resolve(!error));
  });
}

async function waitUntil(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

console.log(`Broker: ${TCP_URL} (TCP) · ${WS_URL} (WebSocket)\n`);

// 1. Nessun accesso anonimo, su nessuno dei due listener.
await expectRefused(TCP_URL, 'anonimo TCP 1883 rifiutato');
await expectRefused(WS_URL, 'anonimo WebSocket 9001 rifiutato');

// 2. Le utenze provisionate si connettono.
const backend = await connect(TCP_URL, BACKEND);
check('backend autenticato', true, BACKEND.username);

const kiosk = await connect(TCP_URL, KIOSK);
check('kiosk autenticato', true, KIOSK.username);

// 3. Il kiosk legge gli stati...
const kioskState = collect(kiosk, STATE_TOPIC);
await subscribe(kiosk, STATE_TOPIC);

// 4. ...e comanda solo i topic di comando.
const backendCommands = collect(backend, 'cmnd/#');
const backendSystem = collect(backend, 'wallos/system/#');
await subscribe(backend, 'cmnd/#');
await subscribe(backend, 'wallos/system/#');

const commandOk = await publish(kiosk, CMD_TOPIC, 'ON');
const commandDelivered = await waitUntil(() => backendCommands.length > 0, 2_000);
check(
  'kiosk pubblica un comando su cmnd/#',
  commandOk && commandDelivered,
  `${CMD_TOPIC} → ${backendCommands.at(-1)?.payload ?? 'nessun payload'}`,
);

// 5. Publish non autorizzato: il broker lo scarta (nessuna consegna).
await publish(kiosk, SYSTEM_TOPIC, '{"event":"device_deleted"}');
const unauthorizedLeaked = await waitUntil(() => backendSystem.length > 0, 1_000);
check('kiosk non può scrivere su wallos/system/#', !unauthorizedLeaked);

// 6. Stato retained protetto: il kiosk non può sovrascriverlo.
const retainedPublished = await publish(backend, STATE_TOPIC, 'ON', { retain: true });
await sleep(300);
await publish(kiosk, STATE_TOPIC, 'OFF', { retain: true });
await sleep(500);

const reader = await connect(TCP_URL, BACKEND);
const retained = collect(reader, STATE_TOPIC);
await subscribe(reader, STATE_TOPIC);
await waitUntil(() => retained.length > 0, 2_000);
const retainedValue = retained.at(-1)?.payload;
check(
  'kiosk non può sovrascrivere uno stato retained',
  retainedPublished && retainedValue === 'ON',
  `stat retained = ${retainedValue ?? 'assente'}`,
);

// Il kiosk riceve comunque lo stato pubblicato dal backend.
const kioskReceivedState = await waitUntil(() => kioskState.length > 0, 1_000);
check('kiosk legge stat/#', kioskReceivedState, kioskState.at(-1)?.payload ?? 'nessuno');

// 7. Il backend mantiene accesso completo agli eventi di sistema.
const systemDelivered = await publish(backend, SYSTEM_TOPIC, '{"event":"authcheck"}');
const received = await waitUntil(() => backendSystem.length > 0, 2_000);
check('backend scrive wallos/system/#', systemDelivered && received);

for (const client of clients) {
  try {
    client.end(true);
  } catch {
    // Socket già chiusa.
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`Verifiche fallite (${failures.length}): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Hardening broker verificato: anonimo bloccato, ACL least-privilege attive.');
}
