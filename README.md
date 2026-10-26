# Domus · Kiosk di controllo domotico in LAN

Dashboard mission-critical per pannelli a parete e tablet, pensata per funzionare
**interamente in rete locale**: React 19 + Vite, TypeScript strict, Tailwind CSS v4,
Zustand, MQTT over WebSocket, Radix/shadcn pattern e Lucide. Utenti, PIN e
sessioni e **topologia della casa** vivono in un micro-servizio Node/Fastify +
**PostgreSQL**: nel bundle client non ci sono hash, profili né stanze/dispositivi
hardcoded.

Nessun cloud, nessun font remoto, nessuna dipendenza runtime esterna alla LAN.

---

## 1. Avvio rapido

Prerequisito: un PostgreSQL raggiungibile sulla LAN che ospiti il database
`wallos` (negli esempi `192.168.0.59:5432`). La connessione arriva **solo** dal
`.env`: `DATABASE_URL` (fonte principale) oppure le variabili granulari
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Nessun parametro o
credenziale è hardcoded nel codice: se una variabile manca o è malformata
l'avvio si interrompe elencando tutti i problemi. Parti da `.env.example`.
Il database deve esistere; schema e seed vengono applicati dal servizio
all'avvio.

Verifica la raggiungibilità prima di avviare l'applicazione (stesso `.env`,
nessuna modifica a schema o dati):

```bash
npm run db:check
```

Allo startup il servizio esegue una query di identità (`version()`,
`current_database()`, `current_user`) e logga:

```
[db] connesso · 192.168.0.59:5432/wallos · PostgreSQL 17.4 · utente wallos_user · 3 ms
```

Se la connessione non riesce, il processo termina con un messaggio operativo
(password rifiutata, database inesistente, host irraggiungibile o DNS) senza
stampare la password contenuta nella URL.

`GET /api/health` ripete la verifica a ogni chiamata ed è pensato per il
monitoraggio (non richiede sessione):

```json
{
  "status": "ok",
  "database": { "status": "up", "version": "PostgreSQL 17.4", "latencyMs": 2 }
}
```

Se il database non risponde: HTTP **503** con
`{"status":"degraded","database":{"status":"down","error":"ECONNREFUSED"}}`.
Non vengono esposti host, database, utente o credenziali.

### Monitoraggio periodico e notifiche

`useDatabaseHealthMonitor` (montato in `App`) interroga `/api/health` ogni
**30 s** con timeout di 8 s (`HEALTH_MONITOR` in `src/config/app.config.ts`).

- Notifica **solo le transizioni**: un toast di errore quando il database cade,
  uno di successo quando torna disponibile. Durante un'interruzione prolungata
  non vengono mostrate raffiche di notifiche: il polling continua e rileva il
  recupero al primo controllo riuscito.
- L'header mostra un badge persistente accanto allo stato MQTT: verde con la
  versione (`PG 17.4`), rosso `DB offline` con il codice errore nel tooltip,
  neutro durante il primo controllo. Badge e monitor leggono lo stesso snapshot
  (`databaseHealthStore`): un solo loop di fetch per tutta l'app.
- Il `Toaster` è montato a livello applicazione, quindi gli avvisi compaiono
  anche sul lock screen, prima che la topologia sia caricata.
- Il polling si ferma allo smontaggio dell'app e ogni richiesta viene annullata
  con `AbortController`, senza promesse orfane.

```bash
npm install

# Terminale 1: API auth + topologia (Fastify + PostgreSQL) su :8787
npm run dev:auth

# Terminale 2: UI su :3000, con proxy /api -> :8787
npm run dev

npm run typecheck  # tsc -b (strict, noUncheckedIndexedAccess)
npm run build      # typecheck + bundle di produzione
npm run preview    # serve dist/ su :3000
```

### Accesso da altri dispositivi della LAN
Vite ascolta su `0.0.0.0:3000` (`server.host` in `vite.config.ts`): dal tablet o
dal telefono apri `http://<IP-del-PC>:3000`, non `localhost`.

- Le richieste mutanti (`POST`, `PATCH`, `DELETE`) sono accettate quando
  `Origin` coincide con l'`Host` inoltrato dal proxy: l'IP della LAN non va
  aggiunto a `CORS_ORIGINS`, che resta per origini **diverse** (reverse proxy,
  dominio dedicato).
- Se la pagina non si apre affatto, è il firewall del PC a bloccare la porta
  3000: consenti Node sulle reti private (su Windows regola inbound TCP 3000).
- `AUTH_HOST` può restare `127.0.0.1`: il browser parla solo con Vite, che
  proxa `/api` sul servizio auth in locale.
- Cookie di sessione: da `http://` in LAN servono `COOKIE_SECURE=false`
  (default in sviluppo); con HTTPS davanti al pannello, `COOKIE_SECURE=true`.
- Lo stesso kiosk (`VITE_KIOSK_DEVICE_ID`) può essere aperto da più browser:
  il login non revoca le sessioni già attive, ma le azioni protette chiedono
  comunque il PIN.

Al primo avvio il servizio applica `server/schema.sql` (idempotente) e fa il seed
del database con stanze, dispositivi, scenari e due profili:

| Profilo | Accesso | PIN azioni |
| --- | --- | --- |
| `admin` | username `admin` · password `admin-demo-1234` | `2468` |
| kiosk | device `wall-panel-1` (`VITE_KIOSK_DEVICE_ID`) | `1234` |

Queste credenziali valgono **solo in sviluppo** quando `ADMIN_PASSWORD` /
`ADMIN_PIN` / `KIOSK_PIN` non sono impostate. In produzione il server rifiuta di
partire senza segreti espliciti. Imposta `JWT_SECRET` (>= 32 caratteri) e le
altre variabili di `.env.example` prima di esporre il servizio.

Al primo avvio l'app parte in **modalità demo** (`broker.demoMode = true`): il
simulatore locale aggiorna potenze, temperature e sensori ogni 3 s, così l'intera
UI è verificabile senza hardware. Il PIN si cambia da Impostazioni → PIN pannello
(4 o 6 cifre): la verifica avviene sempre sul gateway, mai nel browser.

Per il campo reale: Impostazioni → disattiva *Modalità demo*, inserisci IP/porta
WebSocket del broker (es. `192.168.1.10:9001`, path `/mqtt`) → *Salva e applica*.
La connessione riparte senza reload con backoff esponenziale.

In alternativa i valori iniziali del broker arrivano dalle variabili d'ambiente
`MQTT_*` (elenco e precedenza in `.env.example` / `INFISICAL.md`): se almeno una
è impostata l'app parte con la modalità demo spenta.

### Docker (API + PostgreSQL + broker MQTT)
`Dockerfile` è multi-stage su Node 24 Alpine: compila solo il servizio
(`npm run build:server`), l'immagine finale contiene le dipendenze di produzione,
gira con l'utente `node` e ha un healthcheck su `/api/health` (503 = unhealthy).
`docker-compose.yml` avvia `api`, `db` (PostgreSQL 17, volume `wallos-db`) e
`mqtt` (Mosquitto con 1883 e WebSocket 9001).

```bash
export POSTGRES_PASSWORD='...'
export JWT_SECRET='...almeno 32 caratteri...'
export ADMIN_PASSWORD='...almeno 10 caratteri...'
export ADMIN_PIN=13579
export KIOSK_PIN=24680
docker compose up -d --build
docker compose logs -f api
```

- API su `http://<host>:8787`. Il frontend statico (`npm run build` → `dist/`)
  va servito da nginx/Caddy con `location /api { proxy_pass http://api:8787; }`:
  il browser resta same-origin e i cookie `SameSite=Strict` continuano a valere.
- Broker: il pannello usa `ws://<host>:9001` (MQTT WebSocket), i dispositivi
  `1883`. La configurazione `docker/mosquitto.conf` è **anonima**: abilita
  `password_file` e ACL per topic prima di esporla fuori dalla LAN.
- **Eventi di topologia in tempo reale**: il container `api` parla con il broker
  dello stack sul listener **TCP** (`1883`), non sul WebSocket. Nel
  `docker-compose.yml` è già impostato
  `MQTT_SERVER_URL=mqtt://mqtt:1883`; per un broker esterno usa
  `MQTT_SERVER_URL=mqtt://<ip>:1883` (oppure `MQTT_HOST` + `MQTT_SERVER_PORT`,
  vedi §4). Senza queste variabili il server logga un warning e i pannelli
  ricevono gli aggiornamenti solo via SSE. Le variabili `MQTT_*` del **browser**
  (`MQTT_HOST`, `MQTT_PORT=9001`, `MQTT_PATH=/mqtt`, `MQTT_BASE_TOPIC`) sono
  invece lette da Vite al momento del `npm run build`: vanno passate alla build
  del frontend, non al container `api`.
- `COOKIE_SECURE=false` solo in HTTP locale; con TLS metti `true` e
  `AUTH_TRUST_PROXY=true` dietro il reverse proxy.
- In produzione il servizio rifiuta i PIN demo: `ADMIN_PIN` e `KIOSK_PIN`
  devono essere espliciti e diversi da `2468`/`1234`.

### Discovery Home Assistant (opzionale)

Fuori dalla modalità demo il kiosk si sottoscrive a `homeassistant/+/+/config` e
`homeassistant/+/+/+/config` (prefissi configurabili con
`MQTT_DISCOVERY_PREFIXES=homeassistant,zigbee2mqtt`). Ogni annuncio diventa un
widget: `light`, `switch`, `binary_sensor`, `sensor` e `climate` sono mappati sul
modello interno, `device.suggested_area` crea la stanza e i topic di stato e di
availability vengono sottoscritti subito.

- Il seed dei dispositivi vive in PostgreSQL (`server/seed-data/*` solo per il
  primo inserimento): le entità scoperte hanno id `ha:<component>:<object_id>` e
  non sovrascrivono i device del database.
- Un annuncio con payload vuoto ritira l'entità: il widget sparisce subito.
- I metadati dei device scoperti restano in una cache locale dedicata
  (`domus.discovery.cache`): al riavvio i widget ci sono già, con disponibilità
  `unknown` finché il broker non risponde. Lo stato volatile non viene salvato.

### Amministrazione della topologia (solo admin)

La voce **Amministrazione** nella sidebar apre un pannello con tre schede —
stanze, dispositivi, scenari — che legge e scrive direttamente su PostgreSQL.

- Il ruolo `admin` è l'unico autorizzato: le route usano `requireRole`, non basta
  nascondere il link. Un kiosk elevato non può modificare la topologia.
- Ogni salvataggio invalida la query della topologia e riallinea la UI senza
  riavviare il kiosk (nessuno splash di caricamento).
- Validazione server-side: slug per gli id (`^[a-z0-9][a-z0-9:_-]{0,63}$`),
  stanza esistente per un device, topic obbligatorio di stato, enum per tipo e
  adapter, passi di scenario tipizzati (power, brightness, targetTemp, …).
- Una stanza non si elimina se contiene dispositivi (`409 ROOM_NOT_EMPTY`);
  eliminare un device non ripulisce eventuali passi di scenario che lo citano.
- Gli scenari si compongono con un editor visuale dei passi: dispositivo,
  tipo di azione, valore tipizzato (on/off, 0-100, kelvin, °C, modalità, …),
  ritardo e riordino su/giù. Nessun JSON da scrivere a mano.
- I campi `metadata`/`fieldMap` restano JSONB: la UI espone `fieldMap` per
  l'adapter `custom-json`, mentre `metadata` (stato runtime, discovery) non
  viene sovrascritto da una modifica fatta dal pannello.

Endpoint (tutti con sessione valida, mutazioni solo admin):

| Metodo | Path | Uso |
| --- | --- | --- |
| GET | `/api/topology` | stanze + device + scenari in una risposta |
| POST/PATCH/DELETE | `/api/rooms[/:id]` | CRUD stanze |
| POST/PATCH/DELETE | `/api/devices[/:id]` | CRUD dispositivi |
| POST/PATCH/DELETE | `/api/scenarios[/:id]` | CRUD scenari |

### Bootstrap asincrono, cache e avvio offline

Il client non importa nessun `*.config.ts` di stanze/device/utenti: la casa
arriva da `GET /api/topology`, la sessione da `/api/auth/*`.

- **TanStack Query** con un `QueryClient` per albero (`src/lib/queryClient.ts`):
  `gcTime` 30 min, `retry` 3 con backoff 0,8→1,6→3,2 s, `refetchOnWindowFocus:
  false` (kiosk) e refetch al ritorno della rete. La topologia usa `staleTime`
  15 min: stanze, anagrafica e scenari cambiano solo dall'amministrazione.
- **Separazione Server-State / Client-State**: TanStack Query è l'unica fonte di
  stanze, device (metadati), scenari e utenti. Zustand (`homeStore`) conserva
  solo telemetria volatile, connessione MQTT, log e preferenze. La mappa
  `deviceStates: Record<DeviceId, DeviceRealtimeState>` è indicizzata, quindi
  ogni payload aggiorna la propria riga in O(1).
- `useTopologyQuery` (`src/hooks/useTopologyQuery.ts`) espone la query, l'ultima
  topologia salvata in `localStorage` (`domus.topology.cache`, scadenza 30
  giorni) e i selettori `useDevices`/`useRooms`/`useScenarios`/`useDeviceMetadata`.
  La cache è validata con `parseTopology`: un payload corrotto non idrata mai la UI.
- `TopologyGate`: splash brandizzato durante il caricamento; in errore schermata
  con **Riprova** e, se esiste una cache, **Avvia con i dati salvati** (i comandi
  riprendono quando il broker torna raggiungibile). All'arrivo dei dati crea le
  righe realtime mancanti; `MqttProvider` è montato **dopo**, quindi le
  sottoscrizioni ai topic partono già complete. Il socket usa un indice
  topic→device: lookup O(1) per messaggio, ricostruito solo al cambio topologia.
- Le widget card ricevono solo `deviceId` e selezionano la propria riga: un
  messaggio MQTT non ridisegna `OverviewPage`, `RoomsPage` né le card vicine.

Non esiste uno script `migrate-configs-to-db.ts` perché i vecchi `*.config.ts`
non sono più nel repository: la migrazione è già il seed PostgreSQL
(`server/seed.ts` + `server/seed-data/*`), idempotente al primo avvio e
replicabile su un database esistente con gli endpoint admin.

---

## 2. Struttura del progetto

```
domus-kiosk/
├── index.html
├── vite.config.ts                  # proxy /api -> auth service
├── vitest.config.ts / vitest.config.server.ts
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json / tsconfig.server.json
├── tsconfig.build-server.json      # emit del servizio per l'immagine Docker
├── Dockerfile / docker-compose.yml / .dockerignore
├── docker/mosquitto.conf           # 1883 TCP + 9001 WebSocket (dev/LAN)
├── server/                         # API auth + topologia (Node + TypeScript)
│   ├── index.ts                    # bootstrap, .env, graceful shutdown
│   ├── app.ts                      # Fastify, cookie, CORS, helmet, CSRF origin
│   ├── config.ts                   # env + validazione DB/auth
│   ├── db.ts / schema.sql          # pool PostgreSQL, UUID/JSONB, repository SQL
│   ├── db-check.ts                 # npm run db:check (solo connettività)
│   ├── seed.ts / seed-data/        # stanze, device, scenari, admin + kiosk
│   ├── security.ts                 # bcrypt, JWT, cookie HttpOnly, serializer
│   ├── session.ts                  # autenticazione richiesta + elevation
│   └── routes/
│       ├── auth.ts                 # login, kiosk, refresh, PIN, profili
│       └── topology.ts             # GET topologia + CRUD admin con validazione
├── src/
│   ├── main.tsx                    # bootstrap React 19 + StrictMode + i18n
│   ├── App.tsx                     # AuthGate, view router, RequireRole
│   ├── index.css                   # design token Tailwind v4, base kiosk,
│   │                               # override tema alto contrasto
│   │
│   ├── i18n/
│   │   ├── index.ts                # init i18next, detector, tipi delle chiavi
│   │   └── locales/it|en/          # common, devices, energy, settings, auth
│   │
│   ├── types/
│   │   ├── device.ts               # modello normalizzato (Device, stati, azioni)
│   │   ├── mqtt.ts                 # broker, connection metrics, raw log
│   │   └── user.ts                 # ruoli, SessionUser sanitizzato, PIN policy
│   │
│   ├── config/
│   │   └── app.config.ts           # default broker, timeout kiosk, burn-in
│   ├── lib/
│   │   ├── adminApi.ts             # CRUD stanze/device/scenari (ruolo admin)
│   │   ├── contrast.ts             # preferenza alto contrasto + guard API
│   │   ├── queryClient.ts          # TanStack Query: staleTime, retry LAN
│   │   ├── rooms.ts                # helper puri (slug, etichette), nessun seed
│   │   ├── topologyApi.ts          # GET /api/topology + refresh su 401
│   │   └── topologyCache.ts        # ultima topologia in localStorage (offline)
│   │
│   ├── mqtt/
│   │   ├── adapters/
│   │   │   ├── types.ts            # contratto DeviceAdapter + helper
│   │   │   ├── zigbee2mqtt.ts      # decode/encode Z2M (brightness 0-254, mired…)
│   │   │   ├── shelly.ts           # Gen2 status/RPC
│   │   │   ├── tasmota.ts          # POWER/Dimmer/Setpoint + ENERGY
│   │   │   ├── customJson.ts       # fieldMap a path dot-notation
│   │   │   ├── haDiscovery.ts      # canali Home Assistant Discovery
│   │   │   └── index.ts            # registry adapter
│   │   ├── discovery/
│   │   │   ├── types.ts            # payload HA + abbreviazioni ufficiali
│   │   │   ├── normalize.ts        # annuncio → Device interno + stanza
│   │   │   └── haDiscoveryBridge.ts # debounce, upsert, deletion
│   │   ├── topics.ts               # baseTopic, URL broker, subscription list
│   │   ├── optimistic.ts           # patch locale immediata post-publish
│   │   └── MqttProvider.tsx        # una sola istanza API per l'app
│   │
│   ├── hooks/
│   │   ├── useMqtt.ts              # connessione, subscribe, decode, retry, probe
│   │   ├── useKioskDimmer.ts       # inattività + wake-guard anti-tocco
│   │   ├── useClock.ts             # orologio senza drift
│   │   ├── useSwipeNavigation.ts   # gesture orizzontali pagine/stanze
│   │   ├── useHighContrast.ts      # tema, prefers-contrast, sensore di luce
│   │   ├── useTopologyQuery.ts     # topologia dal gateway + cache offline
│   │   └── useCurrentUser.ts       # sessione server + restrizioni UI
│   │
│   ├── store/
│   │   ├── authStore.ts            # sessione, elevazione PIN, profili (no persist)
│   │   ├── contrastStore.ts        # preferenza alto contrasto + sensore
│   │   ├── homeStore.ts            # Zustand: entità, connessione, UI, preferenze
│   │   └── toastStore.ts           # feedback comandi
│   │
│   ├── lib/
│   │   ├── utils.ts                # cn, formatter it-IT (W, kWh, °C, orologio)
│   │   ├── authApi.ts              # fetch credentialed, refresh single-flight
│   │   ├── pin.ts                  # rate limit PIN persistente + backoff
│   │   └── permissions.ts          # ruoli → restrizioni UI, canView
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn pattern su Radix (button, card, badge,
│   │   │                           # input/label, slider, switch, dialog, tabs)
│   │   ├── auth/                   # AuthGate, LockScreen, RequireRole
│   │   ├── layout/                 # AppShell, Sidebar, Header, Clock, ConnectionBadge
│   │   ├── kiosk/                  # PinProtectionDialog, PinProvider,
│   │   │                           # KioskDimmerOverlay, Toaster
│   │   ├── settings/               # LanguageSwitcher, ContrastToggle,
│   │   │                           # SunlightModeCard
│   │   └── widgets/                # ClimateCard, LightCard, PowerCard, MediaCard,
│   │                               # CameraCard/CameraModal, SensorTile,
│   │                               # ScenarioButton, SummaryCard
│   │
│   └── pages/
│       ├── OverviewPage.tsx        # scenari, KPI, stanze, preferiti
│       ├── RoomsPage.tsx           # tab stanze + gruppi dispositivo
│       ├── EnergyPage.tsx          # carichi, kWh, classifica prese
│       ├── SettingsPage.tsx        # broker, monitor RAW, kiosk, PIN
│       └── UsersPage.tsx           # profili, ruoli, restrizioni
│
├── tools/                          # verifiche opzionali (Playwright + broker aedes)
└── artifacts/                      # screenshot generate dai test (non versionate)
```

### Perché Vite e non Next.js
L'app è un pannello sempre acceso, senza SEO e senza RSC: una SPA statica
servita dal gateway/tablet è più semplice da aggiornare e funziona offline. Il
auth è un processo separato (Fastify) che parla solo HTTP e PostgreSQL: non c'è
accoppiamento con il framework UI, e il livello `mqtt/` + store restano
trasferibili senza riscrivere i widget.

## 2.1 Autenticazione locale (client-server)

```
Tablet / browser
  │  fetch same-origin  /api/*  (proxy Vite o reverse proxy di produzione)
  ▼
Fastify :8787 ── pg Pool ── PostgreSQL 192.168.0.59:5432/wallos
  │  Set-Cookie: domus_access (JWT, 15 min)
  │             domus_refresh (opaco, 30 gg · kiosk 90 gg)
  │             domus_elevation (JWT, 5 min, solo dopo verify-pin)
  ▼
AuthGate → GET /api/auth/me → render app oppure LockScreen
```

### Flusso kiosk (tablet a parete)
1. Al boot `AuthGate` chiama `/api/auth/me`. Se il cookie di access è scaduto,
   tenta un solo `/api/auth/refresh` (single-flight) e riprende la sessione.
2. Senza sessione appare la `LockScreen`: il device invia
   `POST /api/auth/kiosk-session` con `deviceId` + PIN. Il server confronta il
   PIN bcrypt del device, applica il lockout e risponde con i cookie HttpOnly.
3. Dopo un riavvio non serve reinserire il PIN: il refresh kiosk resta valido
   90 giorni e viene ruotato a ogni uso. Il browser non vede mai il token.
4. Un'azione sensibile chiama `usePinGuard()` → `POST /api/auth/verify-pin`.
   Il server verifica e imposta `domus_elevation` (5 min): `/me` espone
   `elevated: true` e le viste Impostazioni/Utenti del kiosk si sbloccano.

### Flusso admin / family
1. `POST /api/auth/login` con username + password bcrypt. Il server emette
   access JWT (15 min) e refresh opaco (30 gg) in cookie HttpOnly.
2. Ogni refresh ruota il token; il riuso di un token già ruotato revoca l'intera
   famiglia di sessioni (rilevamento di token theft).
3. Il PIN è per-utente (4-6 cifre): serve per carichi protetti, cambio PIN e
   cambio profilo. Dopo 3 errori il profilo è bloccato 60 s **lato server**.
4. `POST /api/auth/switch-profile` verifica il PIN dell'attore e crea una
   sessione di 10 minuti per il profilo scelto, **senza** toccare il refresh
   originale: alla scadenza il dispositivo torna al profilo di partenza.
5. `POST /api/auth/logout` revoca la famiglia e cancella i cookie.

### API

| Metodo | Endpoint | Accesso |
| --- | --- | --- |
| `POST` | `/api/auth/login` | pubblico (rate-limited) |
| `POST` | `/api/auth/kiosk-session` | device + PIN (rate-limited) |
| `POST` | `/api/auth/refresh` | cookie refresh, rotazione |
| `GET` | `/api/auth/me` | sessione |
| `POST` | `/api/auth/verify-pin` | sessione, lockout 3/60 s |
| `POST` | `/api/auth/pin` | sessione + elevazione o PIN corrente |
| `POST` | `/api/auth/switch-profile` | admin o kiosk, PIN richiesto |
| `GET` | `/api/auth/users` | admin/family, kiosk elevato |
| `PATCH` | `/api/auth/users/:id` | solo admin |
| `POST` | `/api/auth/logout` | cookie refresh |

### Ruoli e visibilità

| Ruolo | Consumi | Impostazioni | Utenti | Azioni sensibili |
| --- | --- | --- | --- | --- |
| `admin` | sì | sì | sì | no PIN |
| `family` | sì | no | no | PIN |
| `guest` | no | no | no | PIN |
| `kiosk` | sì | solo elevato | solo elevato | PIN |

`RequireRole` è il guard dichiarativo usato in `App.tsx`:

```tsx
<RequireRole roles={['admin', 'family']} allowElevated fallback={<AccessDenied />}>
  <SettingsPage />
</RequireRole>
```

Le restrizioni sono solo UI: ogni endpoint riapplica il ruolo lato server. Il
client accetta anche `Authorization: Bearer <access>` per script di automazione,
ma il pannello usa esclusivamente i cookie HttpOnly (`SameSite=Strict`, `Secure`
attivabile con `COOKIE_SECURE=true`). Le richieste mutanti con un `Origin`
che non coincide con l'`Host` e non è in `CORS_ORIGINS` vengono rifiutate
prima di arrivare alle route (protezione CSRF same-origin + allowlist).

Il PIN viaggia in JSON solo sul canale TLS: un hash calcolato nel browser non
sarebbe un controllo di sicurezza (il client può essere manomesso) e non
sostituisce né bcrypt a riposo né il lockout server-side.

---

## 3. Modello dati normalizzato

`src/types/device.ts` è il contratto unico tra hardware e UI.

```ts
type DeviceKind = 'light' | 'climate' | 'power' | 'media' | 'sensor' | 'camera';

interface DeviceBase {
  id: string; name: string; room: RoomId; kind: DeviceKind;
  adapter: AdapterId; model?: string;
  topics: { state: string; command?: string; availability?: string };
  fieldMap?: Record<string, string>;   // solo custom-json
  availability: DeviceAvailability; lastSeen: number | null;
  favorite: boolean; protected: boolean;
}

interface LightDevice extends DeviceBase {
  kind: 'light';
  state: { on: boolean; brightness: number; colorTemp?: number };
  capabilities: { dimmable: boolean; colorTempRange?: readonly [number, number] };
}

interface ClimateDevice extends DeviceBase {
  kind: 'climate';
  state: {
    mode: 'off'|'heat'|'cool'|'auto'|'fan_only'|'dry';
    targetTemp: number; currentTemp: number; humidity?: number;
    fanSpeed: 'auto'|'low'|'medium'|'high'; swing: boolean;
    action: 'idle'|'heating'|'cooling'|'drying'|'fan';
  };
  minTemp: number; maxTemp: number; tempStep: number;
}

interface CameraDevice extends DeviceBase {
  kind: 'camera';
  state: { live: boolean };
  stream: {
    url: string;                 // WHEP/HLS/MJPEG raggiungibile dal browser
    snapshotUrl?: string;        // fallback JPEG
    protocol: 'webrtc' | 'hls' | 'mjpeg' | 'auto';
    aspectRatio: '16:9' | '4:3';
  };
}
```

`Device` è una **union discriminata** su `kind`: ogni widget riceve il tipo
specifico, lo store aggiorna solo il ramo corretto. Le azioni sono astratte e
tipizzate (`ControlAction`): l'UI non conosce mai un payload MQTT.

```ts
type ControlAction =
  | { type: 'power'; on: boolean }
  | { type: 'brightness'; brightness: number }
  | { type: 'colorTemp'; kelvin: number }
  | { type: 'targetTemp'; targetTemp: number }
  | { type: 'climateMode'; mode: ClimateMode }
  | { type: 'fanSpeed'; fanSpeed: FanSpeed }
  | { type: 'swing'; swing: boolean }
  | { type: 'volume'; volume: number }
  | { type: 'source'; source: string };
```

### Adapter / Normalizer

```ts
interface DeviceAdapter {
  label: string;
  decode(ctx: { device: Device; topic: string; payload: string }): DecodedState | null;
  encode(device: Device, action: ControlAction): EncodedCommand | null;
}
```

| Adapter | Stato in ingresso | Comandi in uscita |
| --- | --- | --- |
| `zigbee2mqtt` | JSON (`state`, `brightness` 0–254, `color_temp` mired, `running_state`…) | JSON su `/set` |
| `shelly` | `status/...` Gen2 (`output`, `apower`, `aenergy.total`…) | RPC JSON (`Switch.Set`, `Light.Set`) |
| `tasmota` | `POWER` / `RESULT` / `SENSOR` (`Dimmer`, `ENERGY`…) | `<cmd>/POWER`, `/Dimmer`, `/Setpoint` |
| `custom-json` | path configurabili (`relay.state`, `meter.p`) | JSON con chiavi `cmd.*` |

Aggiungere un firmware significa aggiungere **un file** in `mqtt/adapters/` e una
voce nel registry: nessun widget viene toccato.

### Telecamere IP e proxy video

Il browser non apre RTSP: la telecamera resta sulla VLAN videosorveglianza e un
proxy locale espone WHEP/WebRTC, HLS o MJPEG. In `devices` i campi dedicati sono
`stream_url`, `snapshot_url`, `stream_protocol` e `aspect_ratio`; lo stato
runtime `{ live: true }` resta in `metadata` come per gli altri device. Le
telecamere **non vengono sottoscritte su MQTT** (`stateTopics` restituisce un
array vuoto): la disponibilità mostrata è quella reale della sessione video.

```sql
UPDATE devices SET
  type = 'camera',
  stream_url = 'http://192.168.0.59:1984/api/webrtc?src=porta_ingresso',
  snapshot_url = 'http://192.168.0.59:1984/api/frame.jpeg?src=porta_ingresso',
  stream_protocol = 'auto',
  aspect_ratio = '16:9'
WHERE id = 'camera-outdoor-gate';
```

Esempio minimo `go2rtc.yaml` sul Raspberry/gateway (il flusso RTSP non esce
mai verso il pannello):

```yaml
streams:
  porta_ingresso: rtsp://utente:password@192.168.0.60:554/Streaming/Channels/101

api:
  listen: ":1984"
webrtc:
  listen: ":8555"
```

```bash
go2rtc -config go2rtc.yaml
# WHEP / WebRTC  http://192.168.0.59:1984/api/webrtc?src=porta_ingresso
# HLS           http://192.168.0.59:1984/api/stream.m3u8?src=porta_ingresso
# snapshot JPEG http://192.168.0.59:1984/api/frame.jpeg?src=porta_ingresso
```

`CameraCard` monta il flusso solo quando la card è visibile (`IntersectionObserver`,
soglia 0.2), quando la pagina è in primo piano e quando il dimmer kiosk è spento.
La modale fullscreen usa lo stesso hook; aprendola la card sospende la propria
sessione per non decodificare due volte. WebRTC chiude peer e sessione WHEP
(`DELETE` sul `Location`), HLS distrugge l'istanza e libera il buffer, il
fallback snapshot fa una richiesta ogni 1,5 s. `auto` sceglie dal suffisso
dell'URL (`.m3u8` → HLS, `.mjpg/.mjpeg` → MJPEG, altrimenti WebRTC). Per gli
endpoint go2rtc `/api/webrtc`, `/api/stream.m3u8` e `/api/frame.jpeg` il player
riscrive solo il path mantenendo host e query, quindi prova automaticamente
WebRTC → HLS → snapshot; un proxy generico resta sul trasporto configurato e
usa il solo snapshot esplicito. Se il pannello è servito in HTTPS, anche il
proxy deve essere HTTPS: i browser bloccano i flussi HTTP come mixed content.

---

## 4. Flusso MQTT

`useMqtt` è montato una sola volta (via `MqttProvider`):

1. calcola l'URL da host/porta/protocollo/path e crea il client con
   `reconnectPeriod: 0` (retry controllato dall'app);
2. al `connect` sottoscrive `topics.state` + `topics.availability` di tutti i
   device, con il prefisso `baseTopic` opzionale;
3. ogni messaggio viene normalizzato dall'adapter e applicato allo store come
   patch (`applyDecoded`), con aggiornamento di `lastSeen` e availability;
4. i comandi dell'UI passano da `optimistic.ts` (feedback immediato) e vengono
   pubblicati dal client; lo stato reale arriva poi dal topic `stat`;
5. **riconnessione**: backoff `1s → 2s → 4s … 30s` + jitter, contatore
   `reconnectAttempts` mostrato nell'header, reset al primo `connect`;
6. **latenza**: probe echo su `domus/kiosk/ping` ogni 15 s, fallback sui pacchetti
   `PINGREQ/PINGRESP` del keepalive;
7. **test topic**: ogni messaggio in/out (e gli eventi di sistema) finisce in un
   ring buffer di 200 voci visibile in Impostazioni, senza bloccare la UI.

In `demoMode` l'effetto non apre socket: un simulatore locale aggiorna potenze,
temperature e sensori; i comandi restano ottimistici e coerenti.

### Sincronizzazione topologia in tempo reale

Ogni mutazione confermata su PostgreSQL (creazione, modifica, eliminazione o
riordino di **stanze, dispositivi e scenari**) viene diffusa a tutti i pannelli
della casa in meno di un secondo: nessun tocco, nessun reload, nessuna attesa
dello `staleTime` di TanStack Query.

**Canale primario — MQTT.** A ogni CRUD completata il server pubblica su
`<baseTopic>/wallos/system/topology_changed` un payload compatto:

```json
{
  "event": "device_updated",
  "entity": "device",
  "id": "light-living-main",
  "timestamp": 1730000000000,
  "sourceClientId": "admin-pc"
}
```

- `event` è `<entity>_<created|updated|deleted|reordered>`: `reordered`
  distingue il solo cambio di `displayOrder`;
- `sourceClientId` arriva dall'header `X-Client-Id` che il browser allega alle
  CRUD: quel pannello ha già invalidato in locale e ignora il messaggio, così
  una modifica non produce due refetch;
- la pubblicazione avviene **dopo** il commit, con QoS 1 e coda lato
  `server/services/topologyEvents.ts`: un broker momentaneamente giù non perde
  l'evento; il topic è uguale a lato client perché entrambi leggono
  `MQTT_BASE_TOPIC`.

**Canale di ripiego — SSE.** Quando la socket MQTT non è viva (broker in
manutenzione, porta WebSocket bloccata, demo mode) il client apre
`GET /api/topology/events` (`text/event-stream`, stessa sessione delle altre
rotte, `retry: 3000` gestito dal browser). Lo stream porta lo stesso payload e
viene chiuso appena MQTT torna connesso: **mai due canali attivi insieme**.

**Schema dei due canali**:

```text
CRUD admin
   │  POST / PATCH / DELETE su /api/rooms, /api/devices, /api/scenarios
   ▼
Fastify · routes/topology.ts
   │  commit PostgreSQL (annuncio post-commit)
   ▼
topologyEvents.publish(event)
   ├─▶ MQTT   QoS 1, retain=false
   │      <base>/wallos/system/topology_changed → broker :1883
   │      → pannelli con socket MQTT viva
   └─▶ SSE    frame `data: {...}`
          GET /api/topology/events · text/event-stream · retry 3000
          → pannelli senza broker (o in demo mode)

useTopologySync · debounce 300 ms (Impostazioni)
   ▼
invalidate ['topology'] → refetch GET /api/topology
```

Un pannello usa **un solo canale per volta**: lo stream SSE si apre solo se
`connection.status !== 'connected'` (o in demo mode) e si chiude appena MQTT
ritorna; qualunque sia la sorgente, l'evento finisce nella stessa coda con
debounce. Il server non ha bisogno di sapere quali pannelli sono su MQTT: il
payload è identico sui due canali.

**Lato client** (`src/hooks/useTopologySync.ts`, montato in `App.tsx` dentro
`<MqttProvider>`):

1. ogni evento, da qualunque canale, entra in una coda con **debounce**
   configurabile da Impostazioni → *Sincronizzazione topologia* (`0 … 2 s`,
   default **300 ms**): una raffica di modifiche produce un solo
   `queryClient.invalidateQueries({ queryKey: ['topology'] })`;
2. `['topology']` è l'unica chiave della topologia: stanze, dispositivi e
   scenari vivono sotto quella chiave (`select` nei vari hook), quindi il
   refetch riallinea tutto;
3. a refetch avvenuto `refreshSubscriptions()` sottoscrive i `state_topic` dei
   device appena creati, senza riaprire la connessione;
4. se l'evento proviene da un altro client compare un toast non bloccante
   “Topologia aggiornata in tempo reale”;
5. **riconnessione** MQTT o **riapertura** dello stream SSE → refetch di
   sicurezza senza toast, per allineare il client anche se durante il blackout
   sono persi eventi (il topic non è retained).

**Variabili d'ambiente del server** (il `.env` è letto sia da Vite sia da
`server/index.ts` con `loadEnvFile`):

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `MQTT_SERVER_URL` | — | Endpoint usato dal server per pubblicare gli eventi. Ha precedenza su tutto e accetta `mqtt://`, `mqtts://`, `ws://`, `wss://` (es. `mqtt://192.168.0.10:1883`, il **listener TCP**: il 9001 è il WebSocket del browser). |
| `MQTT_SERVER_PORT` | `1883` | Porta TCP con cui viene composto l'endpoint da `MQTT_HOST`. |
| `MQTT_HOST` | — | Host del broker, condiviso con il browser (dove compone l'URL WebSocket con `MQTT_PORT`). Se né `MQTT_SERVER_URL` né `MQTT_HOST` sono impostati la pubblicazione MQTT resta disabilitata: il server avverte nel log e gli eventi arrivano comunque via SSE. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | — | Credenziali del broker, condivise tra server e browser (utenza dedicata con ACL topic). |
| `MQTT_BASE_TOPIC` | — | Prefisso applicato a tutti i topic, identico a lato client. |

**Verifica rapida** (due finestre affiancate sullo stesso pannello):

```bash
# 1. osserva gli eventi di sistema sul broker
mosquitto_sub -h 192.168.0.10 -p 1883 -t 'wallos/system/#' -v

# 2. genera una mutazione autenticata: l'altra finestra si riallinea da sola
curl -s -c /tmp/w.cookies -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}' http://localhost:3000/api/auth/login
curl -s -b /tmp/w.cookies -H 'Content-Type: application/json' \
  -H 'X-Client-Id: admin_cli' -X PATCH \
  -d '{"name":"Salotto","shortLabel":"Salotto","icon":"sofa","displayOrder":0}' \
  http://localhost:3000/api/rooms/living
```

Per simulare un evento senza toccare il server:

```bash
mosquitto_pub -h 192.168.0.10 -p 1883 -t 'wallos/system/topology_changed' \
  -m '{"event":"device_updated","entity":"device","id":"light-living-main","timestamp":1730000000000}'
```

### Come si collega un nuovo dispositivo

1. aggiungi la riga in `devices` (id, `room_id`, tipo, adapter, topic,
   `metadata` JSONB con stato iniziale e `fieldMap` se custom) oppure nel seed
   `server/seed-data/devices.ts` per un impianto nuovo;
2. se il firmware è nuovo, implementa il suo adapter lato client;
3. per una telecamera usa `type = 'camera'` e valorizza `stream_url`,
   `snapshot_url`, `stream_protocol`, `aspect_ratio` (vedi sopra);
4. ricarica: `GET /api/topology` restituisce il device, subscribe e widget
   funzionano senza altre modifiche.

---

## 5. Kiosk, standby e PIN

### `useKioskDimmer`
- timeout configurabile (default **2 min**) con countdown interno;
- attività reale: `pointerdown`, `touchstart`, `keydown`, `wheel`, tab visibile;
- overlay nero con orologio a luminosità bassa (default 30%, regolabile);
- al tocco il listener in **capture phase** chiama `preventDefault` +
  `stopPropagation` e risveglia: il tap **non** attiva il widget sottostante;
- per 350 ms dopo il risveglio vengono assorbiti `pointerup`/`click` residui;
- il tasto standby in header e l'anteprima in Impostazioni usano lo stesso flusso.

### `useScreenWakeLock` (Wake Lock API)
- montato **una sola volta** a livello root in `App.tsx`, indipendente dal
  dimmer: il dimmer software resta l'unico gestore dello "spegnimento" visivo,
  mentre il Wake Lock impedisce al browser/SO di mettere lo schermo in standby
  dopo pochi minuti di inattività (power management di Android/iPadOS);
- `navigator.wakeLock.request('screen')` con controllo di supporto
  (`'wakeLock' in navigator`): se l'API manca l'hook è un no-op e lo stato
  "non supportato" viene mostrato in Impostazioni;
- riacquisizione automatica: il browser rilascia il sentinel quando la scheda
  perde visibilità, quindi su `visibilitychange → visible` la richiesta viene
  emessa di nuovo; l'evento `release` del sentinel aggiorna lo stato interno;
- `releaseWakeLock()` ferma la riacquisizione (nessun loop invisibile),
  `requestWakeLock()` la riprende; entrambe sono idempotenti, con un contatore
  di gara che scarta le risposte orfane di `request()` in arrivo dopo lo
  smontaggio;
- pulizia completa allo smontaggio: `sentinel.release()` + rimozione dei
  listener `release` e `visibilitychange`;
- interfaccia: `{ isSupported, isActive, error, requestWakeLock, releaseWakeLock }`;
- diagnostica: in **Impostazioni → Kiosk** una riga mostra lo stato
  ("Schermo bloccato (WakeLock attivo)" / "WakeLock non supportato dal
  browser" / errore), utile durante l'installazione su tablet fisici.

### PWA installata (manifest + service worker)
- `vite-plugin-pwa` con `registerType: 'autoUpdate'`: il nuovo service worker
  prende il controllo e ricarica alla prima occasione utile (nessun prompt sul
  kiosk);
- manifest: `name: "wallOS Dashboard"`, `short_name: "wallOS"`,
  `start_url: '/'`, `display: 'fullscreen'` (fallback `standalone` via
  `display_override`), `orientation: 'landscape'`, `theme_color` e
  `background_color` a `#000000` (nessun flash bianco al boot);
- icone PNG 192/512 con `purpose: "any"` più `maskable-512` per il ritaglio
  Android e un SVG a risoluzione qualsiasi;
- workbox: precache di `js/css/html/svg/png/ico/webmanifest/woff2`,
  `navigateFallback: '/index.html'` con denylist su `/api/` e `/mqtt` (gli errori
  JSON del gateway non vengono mai sostituiti dall'HTML della SPA);
- `index.html`: viewport anti-zoom (`maximum-scale=1.0, user-scalable=no,
  viewport-fit=cover`) e meta Apple (`apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style: black-translucent`,
  `apple-mobile-web-app-title`) per l'installazione da Safari "Aggiungi a
  Home" su iPadOS;
- gesture neutrate in `src/index.css`: `overscroll-behavior: none` su `html` e
  `body` (niente pull-to-refresh né rubber-banding), `user-select: none`,
  `-webkit-touch-callout: none`, `touch-action: pan-x pan-y`; i contenitori
  scrollabili usano la utility `.kiosk-scroll` con
  `overscroll-behavior: contain`, quindi il bounce resta isolato al pannello.

#### Verifica su tablet (Android / iPad)
1. **Android (Chrome):** `chrome://inspect` dal desktop (oppure Chrome Remote
   Debugging USB) → seleziona la scheda wallOS → pesta **manifest** per
   verificare nome/icone/`display: fullscreen` e **Service Workers** per il
   worker attivo; da `chrome://settings/siteData` o dal menu ⋮ → "Installa
   app" l'app appare come standalone a schermo intero in orizzontale.
2. **iPad (Safari):** Condivisione → "Aggiungi a Home" → apri wallOS: deve
   partire senza barra URL, con status bar nera traslente e orientamento
   orizzontale; verifica in Impostazioni → Kiosk che la riga Wake Lock dica
   "non supportato" (iPadOS non espone ancora l'API) oppure "attivo".
3. **Stato Wake Lock:** in Impostazioni → Kiosk la riga "Wake Lock schermo"
   deve mostrare "Schermo bloccato (WakeLock attivo)"; per il debug remoto su
   Android aprire `chrome://inspect` → console e verificare
   `navigator.wakeLock` e `document.visibilityState`.

### `usePixelShift` (protezione burn-in)
- dashboard attiva: micro-spostamenti di 1-4 px attorno all'origine, ogni 60 s;
- standby: l'orologio vaga su coordinate bounds-safe (viewport meno bounding box e
  32 px di margine) oppure oscilla di pochi px con `mode: 'subtle-shift'`;
- solo `transform: translate3d(...)` con transizione lenta: niente `top`/`left`,
  niente repaint di layout, nessun layer promosso quando è spento;
- impostazioni in `homeStore.burnIn` (`mode`, `shiftIntervalMs`,
  `dimClockOpacity`) e persistite insieme al resto;
- il movimento non emette eventi: non risveglia il dimmer; il primo tocco azzera
  la traslazione e rimuove l'overlay.

### `PinProtectionDialog` + `PinProvider`
- tastierino 3×4, target 56 px, auto-submit a 4 o 6 cifre;
- il PIN **non viene mai confrontato nel browser**: `verify()` chiama
  `POST /api/auth/verify-pin` e mostra solo l'esito (`ok`, tentativi residui,
  `lockedUntil`) restituito dal gateway;
- lockout server-side: **3 tentativi → 60 s**, per profilo/dispositivo; chiudere
  e riaprire il dialog non azzera il blocco;
- rate limiting locale persistente (`src/lib/pin.ts`): contatore e scadenza in
  `localStorage` per profilo, blocco iniziale di 30 s che raddoppia a ogni nuovo
  blocco (tetto 5 min). Tastierino ed eventuale tastiera fisica restano
  disabilitati durante il blocco, con countdown e riabilitazione automatica;
  il lockout del gateway resta il limite autorevole (si usa sempre la scadenza
  più lunga tra client e server);
- feedback di errore con tentativi rimasti e animazione *shake* sul display;
- un esito positivo azzera contatore e moltiplicatore e imposta il cookie di
  elevazione (5 min), sbloccando le viste riservate al kiosk;
- qualunque azione sensibile si protegge con una riga:
  ```ts
  requestPin({
    title: 'Azione protetta',
    description: '…',
    onConfirm: (pin) => confirmSensitiveAction(pin),
  });
  ```
  Usato da scenario *Esci*, prese protette, spegnimento luci e cambio profilo.
- la lunghezza del PIN (4/6) e la policy arrivano da `/api/auth/me`.

### Navigazione touch (swipe)
`useSwipeNavigation` (`src/hooks/useSwipeNavigation.ts`, basato su
`react-swipeable`) collega il gesto orizzontale allo store: Sidebar, header e
dots si aggiornano subito perché la navigazione passa da `setView`/`setRoom`.

- Pagine: Overview → Stanze → Consumi → Impostazioni, filtrate con `canView`;
  lo swipe non porta mai a una schermata non consentita.
- Stanze: dentro `RoomsPage` il carosello locale ha priorità (lo swipe pagina è
  spento). Agli estremi scatta un bounce di 200 ms, senza cambiare pagina.
- Esclusioni: slider Radix, manopola clima, input, pulsanti, link, tab e ogni
  elemento `.ignore-swipe` / `[data-swipe-ignore]` non innescano la navigazione.
  Slider e manopola clima hanno già la classe `ignore-swipe`.
- Transizioni: `animate-slide-in-right/left`, solo `transform`/`opacity`
  (`translate3d` 26 px, 260 ms), disattivate con `prefers-reduced-motion`.
- Indicatori: dots pagine fissi in basso (`pointer-events-none`), dots stanze
  sotto le tab e cliccabili.

Calibrazione consigliata su tablet a parete:

| Parametro | Valore | Note |
| --- | --- | --- |
| `delta` | 60 px | 50–75 px: sotto resta un tap |
| `trackMouse` | `false` | `true` solo per test manuali desktop |
| `preventScrollOnSwipe` | `true` | blocca il pan orizzontale del browser |
| `swipeDurationMs` | 800 | gesti più lenti non navigano |
| CSS `touch-action` | `pan-y` | lo scroll verticale resta nativo |

```tsx
const swipe = useSwipeNavigation<RoomId>({
  items: rooms.map((room) => room.id),
  current: active.id,
  onChange: setRoom,
  onEdge: () => bounce(),
});
return <div {...swipe.handlers} style={{ touchAction: 'pan-y' }}>…</div>;
```

### Internazionalizzazione (i18n)
L'interfaccia non contiene più testo italiano hardcoded: ogni stringa vive in
`src/i18n/locales/<lingua>/<namespace>.json` ed è letta con `useTranslation()`.

- Librerie: `i18next`, `react-i18next`, `i18next-browser-languagedetector`.
- Namespace: `common` (shell, ruoli, errori, form admin), `devices` (widget e
  comandi), `energy`, `settings` (impostazioni, lingua, utenti) e `auth`
  (lock screen e dialog PIN). `common` è il default e il fallback.
- Lingue: `it` (fallback) ed `en`; il detector legge **solo** `localStorage`
  (`domus.language`), senza auto-switch sul `navigator`: un pannello nuovo resta
  in italiano finché l'utente non sceglie.
- Cambio a caldo: il selettore in Impostazioni chiama `i18n.changeLanguage`,
  react-i18next ridisegna i componenti e il detector salva la preferenza (la
  scelta sopravvive al riavvio del tablet). Anche `document.documentElement.lang`
  viene aggiornato.
- Formati: `formatWatts`, `formatKwh`, `formatTemp`, `formatTime`, `formatDate`
  e i numeri dei sensori usano `Intl` con la locale attiva (`it-IT` / `en-GB`,
  orologio a 24 ore).

Le chiavi sono tipizzate: `src/i18n/index.ts` estende `CustomTypeOptions` di
`i18next` con le risorse italiane, quindi una chiave inesistente è un errore di
compilazione e l'autocompletamento propone solo `nav.*`, `devices.climate.*`, ecc.

```tsx
const { t } = useTranslation('devices');
return <span>{t('climate.modes.heat')}</span>; // "Caldo" / "Heat"
```

Per aggiungere una lingua: copia `src/i18n/locales/en` in `<codice>/`,
traduci i cinque file, aggiungi il codice a `SUPPORTED_LANGUAGES` e le risorse in
`resources`, poi aggiungi l'opzione in `LanguageSwitcher`.

Nomi di stanze, device e scenari sono dati (righe PostgreSQL), non copy: restano
nella lingua con cui l'amministratore li ha inseriti.

### Alto contrasto / leggibilità al sole
Il tema nativo è pensato per un ambiente scuro: vicino a una finestra o in pieno
sole i grigi attenuati e i bordi traslucidi spariscono. La modalità **Alta
leggibilità** ricalibra i token, non i singoli componenti.

- Attivazione: pulsante sole/contrasto nell'header (sempre visibile) e card in
  Impostazioni con switch e tre modalità: **Automatica**, **Sempre**, **Mai**.
- Token: `html[data-contrast="high"]` in `src/index.css` sovrascrive
  `--color-bg` (`#000000`), `--color-panel`, `--color-line` (bianco pieno),
  `--color-fg-muted` (bianco: nessun testo attenuato) e porta l'accento ad ambra
  `#facc15`. I rapporti misurati vanno da **10.2:1** a **21:1**, sopra il minimo
  WCAG AAA di 7:1.
- Delimitatori e tipografia: ogni utility `border*` passa a 2px, `font-normal`
  sale a 500, ombre e `backdrop-blur` vengono spenti (riflettono la luce).
- Slider: track con bordo bianco, range ambra, thumb da 40 px con anello bianco
  da 3px. Switch: track bordato e indicatori di forma (`|` ON, `O` OFF) oltre al
  colore, pollice controbordato bianco/nero.
- `useHighContrast` applica `<html data-contrast>` prima del paint, salva la
  scelta in `localStorage` (`domus.contrast`) e ascolta:
  - `prefers-contrast: more` via `matchMedia`;
  - `AmbientLightSensor`, quando il browser lo espone: oltre **1000 lux**
    attiva la modalità. Permesso negato o API assente → degradazione silenziosa,
    resta l'attivazione manuale.
  La scelta manuale (`Sempre`/`Mai`) vince su sistema e sensore; i listener sono
  registrati una sola volta anche con header e Impostazioni montati insieme.

### Profili e restrizioni
La sessione (id, ruolo, stanze, lunghezza PIN) arriva da `/api/auth/me`; non
esiste più `activeUserId` nel persist locale. `AuthGate` non monta nessuna vista
senza sessione confermata, `LockScreen` gestisce kiosk (device + PIN) e account
(username + password), `RequireRole` protegge le viste riservate. Il kiosk non
elevato vede un pulsante *Sblocca* nell'header: il PIN imposta l'elevazione di 5
minuti e abilita Impostazioni/Utenti. Admin e family vedono l'elenco profili dal
gateway; solo admin può attivare/disattivare utenti, e solo admin o kiosk elevato
possono cambiare profilo (con PIN e sessione temporanea di 10 minuti).

---

## 6. Sicurezza

Il perimetro è stato spostato sul gateway: il bundle client non contiene più
password, PIN, hash o ruoli statici. Restano comunque necessari questi passi per
un impianto reale:

- **HTTPS** davanti al pannello e `COOKIE_SECURE=true`: senza TLS i cookie
  `Secure` non vengono inviati. In alternativa, solo su LAN fisicamente isolata,
  `COOKIE_SECURE=false` è un compromesso esplicito;
- `JWT_SECRET` robusto e ruotato, `ADMIN_PASSWORD`/`ADMIN_PIN`/`KIOSK_PIN`
  forniti dall'ambiente (il server rifiuta i default in produzione);
- `CORS_ORIGINS` limitato all'origine reale del pannello (il controllo
  `Origin` blocca le richieste mutanti da origini sconosciute);
- credenziali PostgreSQL dedicate (solo `SELECT/INSERT/UPDATE/DELETE` sulle
  tabelle applicative, schema di proprietà del deploy): il DB contiene hash
  bcrypt, refresh token, contatori di lockout e la topologia della casa;
- backup coerenti del database (`pg_dump`) e connessione cifrata/TLS se il DB
  non è sulla stessa LAN fidata;
- ACL MQTT per topic: l'autenticazione UI non autorizza i comandi sul broker, il
  pannello deve poter scrivere solo sui propri `cmnd`, con utenza dedicata e
  `wss://` in rete isolata;
- replicare la verifica PIN lato gateway per azioni fisiche critiche (allarme,
  varchi, distacco carichi): un attaccante con accesso fisico può manomettere il
  client, anche se non può più leggere le credenziali dal bundle;
- le credenziali del broker MQTT restano nel client (il socket gira nel browser):
  usare un'utenza con ACL minime e, se possibile, un token efimero provisionato
  dal gateway.

---

## 7. Verifiche eseguite

### Suite Vitest, copertura e CI
- `vitest.config.ts`: jsdom, alias `@`, setup globale (`jest-dom` + cleanup
  RTL), coverage V8 con report `text`/`html`/`lcov` in `coverage/` (in
  `.gitignore`).
- Soglie per il contratto IoT (`src/mqtt/adapters/**`): statement 95%, righe
  95%, funzioni 100%, rami 80%. I payload reali dei firmware stanno in
  `src/test/fixtures/mqtt.ts` (JSON validi, numeri come stringa, payload vuoti
  e malformati).
- Adapter: 78 test su Zigbee2MQTT, Shelly Gen2, Tasmota e custom JSON, con
  decode, edge-case e encoding dei comandi (`Switch.Set`, `/POWER`, `/Dimmer`,
  `cmd.*`).
- Widget: `PowerCard` copre stato iniziale normalizzato, tap, offline (ultime
  metriche note) e patch successive senza rimontaggio; `LightCard` copre dimmer,
  preset colore e stato spento.
- Telecamere: 8 test sulle scelte URL/protocollo e sul backoff, 3 sul hook
  (`IntersectionObserver`, sospensione, WHEP con chiusura sessione), 2 su
  `CameraCard`/modale e un test API che crea/aggiorna una camera con PGlite.
- CI GitHub Actions (`.github/workflows/ci.yml`): `npm ci`, typecheck,
  coverage con soglie, test server, build e artifact `coverage/`.

```bash
npm test               # una passata
npm run test:watch     # TDD
npm run test:coverage  # report + soglie
npm run test:ui        # interfaccia Vitest
npm run test:server    # Fastify + PGlite
npm run test:all       # frontend + server
```

- `npm run typecheck` → 0 errori (strict, `noUncheckedIndexedAccess`).
- `npm run build` → build Vite OK.
- `npm run build:server` → emit ESM in `dist-server/` (stesso comando usato dal
  Dockerfile).
- `npm test` → 49 file, 306 test frontend (jsdom); 1 benchmark è saltato di
  default.
- `npm run test:server` → 43 test Fastify + PGlite.
- `npm run test:coverage` → adapters: 96.7% statement, 99.2% righe, 100%
  funzioni, 82.4% rami (sopra le soglie).
- Bootstrap: 3 test RTL su `TopologyGate` (splash brandizzato, retry che
  rifà la query, avvio dalla cache con store idratato) e 4 sulla cache
  (`localStorage`, scadenza, JSON corrotto, topologia malformata).
- i18n: parità chiavi `it`/`en` per tutti i namespace, cambio lingua a caldo con
  persistenza in `localStorage` e `document.documentElement.lang`, fallback
  italiano e test a compile time sulle chiavi tipizzate.
- Alto contrasto: 9 test (toggle header con persistenza di `domus.contrast`,
  listener `prefers-contrast`, soglia 1000 lux con override manuale, card
  Impostazioni con motivazione, `data-slot` e indicatori di forma di slider e
  switch).
- Swipe: 9 test sul hook (soglia 60 px, esclusioni slider/pulsanti, fine
  corsa, gesti verticali, `preventScrollOnSwipe`, `trackMouse`), 3 su
  `RoomsPage` (cambio stanza, bounce alla prima, nessun cambio partendo da uno
  slider) e 2 su `App` (lock screen senza shell; swipe Overview → Stanze con
  header e Sidebar sincronizzati).
- Rate limiting PIN: 13 test sul modulo (soglia 3–5, backoff 30→60→120→tetto,
  persistenza per profilo, reset al PIN corretto, lockout server più lungo) e 4
  test sul dialog (shake, tastierino e tastiera bloccati, riapertura, countdown).
- `npm run test:server` → 37 test Fastify/PostgreSQL (PGlite, PostgreSQL WASM
  con lo schema reale):
  - configurazione `.env`: `DATABASE_URL` o `DB_*`, URL/porta/database/utente/
    password mancanti o incoerenti, pool e timeout malformati → avvio bloccato;
  - check di connessione all'avvio e con `npm run db:check`: log compatto senza
    credenziali ed errore rilanciato per il messaggio operativo;
  - cookie access/refresh `HttpOnly` + `SameSite=Strict` e payload senza hash;
  - lockout login e PIN dopo la soglia, anche con PIN corretto durante il lock;
  - sessione kiosk device+PIN e refresh della stessa famiglia;
  - riuso del refresh → revoca dell'intera famiglia;
  - RBAC su elenco/modifica profili, self-disable vietato, switch kiosk→family
    con refresh che riporta al kiosk;
  - `Origin` cross-site non consentita → 403, mentre il pannello aperto da un
    altro IP della LAN (Origin == Host) accede; porta diversa → 403;
  - `GET /api/topology` protetta, con stanze/device/scenari ricostruiti dal DB;
  - CRUD admin con validazione (slug, stanza inesistente, stanza popolata, passi
    scenario), 403 per kiosk/family su rooms/devices/scenarios, 404 su PATCH e
    DELETE di entità inesistenti e 409 sui duplicati.
- Smoke test HTTP con `dev:auth` + `npm run dev`: `/api/health` attraverso il
  proxy Vite, login admin con Set-Cookie verificato, `/me`, lockout PIN al terzo
  errore, sessione kiosk, elevazione PIN e rotazione refresh.
- `npm run db:check` verso `192.168.0.59:5432`: con le credenziali placeholder
  del `.env` il server risponde `28P01` (password rifiutata), il comando esce
  con codice 1 e suggerisce la correzione senza stampare la password.
- Verifica sul PostgreSQL reale `192.168.0.59:5432`: `dev:auth` avviato, log di
  startup `PostgreSQL connesso · … · PostgreSQL 17.4`, schema e seed applicati,
  login admin, `GET /api/topology` con 7 stanze / 19 device / 4 scenari, CRUD di
  stanza+device+scenario creati e poi eliminati (204), stanza popolata protetta
  con 409.

Gli script di verifica MQTT in `tools/` richiedono dipendenze opzionali
(`playwright`, `aedes`, `websocket-stream`): vedi `tools/README.md`.

---

## 8. Limiti noti / prossimi passi

- Bootstrap JS ~946 kB raw / ~299 kB gzip, già diviso in vendor (mqtt.js
  ~338 kB, React ~209 kB, UI Radix ~74 kB). `hls.js` usa la build `light`
  (~371 kB) ed è caricato solo quando una telecamera HLS è visibile: non entra
  nel first paint né nella shell delle pagine senza telecamere.
- Lo stato runtime dei device non è persistito nel database: al reload si
  riparte dallo stato del seed finché il broker non ripubblica. Per impianti
  reali conviene `retain: true` sui topic di stato o un cache layer locale.
- L'adapter `shelly` copre solo Gen2 (`output`, `apower`, `aenergy.total`):
  una Shelly Gen1 (`ison`, `power`) viene parsata ma non produce campi
  normalizzati. Un test caratterizza il payload Gen1; per supportarlo serve un
  fallback dedicato (o un adapter separato).
- La disponibilità per-device (`availability`) è nello store ma non è mostrata
  nei widget: l'header espone solo lo stato del broker. Il test widget verifica
  che un device `offline` continui a renderizzare le ultime metriche note.
- La Picture-in-Picture nativa resta legata al `<video>` della modale: chiudendo
  la modale o cambiando pagina il browser chiude la finestrella. Per un
  mini-player persistente serve un host video a livello App (fuori dal ciclo di
  vita della pagina), con una sola sessione condivisa.
- Lo storage è PostgreSQL (PGlite nei test): SQLite non è implementato. Per un
  driver aggiuntivo va astratto il repository in `server/db.ts`; la URL resta
  l'unico punto di configurazione (`DATABASE_URL`).
- Il bootstrap non espone l'elenco profili a tutti i ruoli: `/api/topology`
  restituisce stanze/device/scenari, mentre utenti e PIN restano dietro
  `/api/auth/users` (admin o kiosk elevato). È una scelta di sicurezza, non una
  mancanza: un pannello kiosk non deve leggere username e ruoli della casa.
- Docker non è installato in questo ambiente: immagine e compose sono stati
  verificati con `npm run build:server` e revisione statica, non con un
  `docker compose up` reale.
- La UI di amministrazione non gestisce ancora `metadata` (discovery e stato
  iniziale): per adapter complessi si interviene con SQL o col seed.
- L'editor dei passi non blocca l'eliminazione di un device citato da uno
  scenario: il passo resta ma viene ignorato a runtime finché non lo si corregge
  (manca una foreign key su JSONB).
- Storico consumi e grafici 24h non sono inclusi: il modello `PowerDevice` è
  pronto per un adapter di serie storica (Influx/SQLite sul gateway).
- Il PIN è di 4-6 cifre: l'entropia è bassa per natura. Il lockout server-side
  (3 tentativi/60 s) è la difesa principale; per ambienti più esposti valutare
  PIN a 6 cifre e passaggio ad argon2id.
- PostgreSQL non ha ancora un audit log applicativo né backup automatici:
  aggiungerli prima di un impianto multi-utente.
- La sessione kiosk dipende dal cookie di refresh (90 giorni): se il browser
  cancella i cookie serve reinserire il PIN del device.
- Nessun service worker: aggiungerlo per il boot offline del pannello.

---

## Migrazioni versionate del database

Il servizio usa ora **node-pg-migrate** per migrazioni PostgreSQL versionate e sequenziali.
Tutte le evoluzioni dello schema risiedono in `server/migrations/` come file SQL con blocchi `UP` e `DOWN`:

| File | Descrizione |
| --- | --- |
| `001_initial_schema.sql` | Tabelle base: users, rooms, devices, scenarios con FK, indici e JSONB |
| `002_add_camera_entity.sql` | Colonne stream/metadata camera nella tabella devices + tabella cameras dedicata |

### Script npm

| Comando | Descrizione |
| --- | --- |
| `npm run migrate:up` | Applica tutte le migrazioni pendenti in ordine cronologico |
| `npm run migrate:down` | Rollback dell'ultima migrazione applicata |
| `npm run migrate:create <nome>` | Crea un nuovo file di migrazione timestamped nella cartella `server/migrations/` |

### Bootstrap all'avvio

All'avvio del micro-servizio, il backend esegue automaticamente `migrate:up` prima di ascoltare le richieste HTTP. Se il database è già aggiornato o le migrazioni terminano con successo, il server parte regolarmente. In caso di errore DDL bloccante, il bootstrap si interrompe con `process.exit(1)` per prevenire incoerenze nello schema.

Per ulteriori dettagli consulta `server/migrate.ts` e i file in `server/migrations/`.

---

## Backup e ripristino del database

Script dedicato per backup coerenti e ripristino rapido:

### Generazione backup

Eseguire `npm run db:backup` per creare un dump compressato con `pg_dump` + `gzip`.
Il file verrà nominato `wallos_backup_YYYY-MM-DD_HH-mm-ss.sql.gz` nella directory specificata da `BACKUP_DIR` (default `./backups`).

### Retention policy

I backup vecchi vengono automaticamente rimossi in base a una delle due policy:
- `RETENTION_DAYS=7`: mantieni gli ultimi 7 giorni di backup
- `RETENTION_COUNT=10`: mantieni gli ultimi 10 file di backup

La pulizia avviene dopo ogni generazione di backup.

### Ripristino d'emergenza

Eseguire `npm run db:backup -- --restore <path>` per ripristinare il database da un backup precedentemente generato.

### Variabili d'ambiente opzionali

| Variabile | Descrizione | Default |
| --- | --- | --- |
| `BACKUP_DIR` | Directory di destinazione dei backup | `./backups` |
| `RETENTION_DAYS` | Mantieni gli ultimi N giorni di backup | `7` |
| `RETENTION_COUNT` | Mantieni gli ultimi N file di backup | `10` |

Per schedulare un backup notturno, aggiungi una voce cron:

```bash
0 3 * * * /usr/local/bin/node $(pwd)/tools/db-backup.mjs >> $(pwd)/tools/backup.log 2>&1
```

Per maggiori dettagli consulta `tools/db-backup.mjs`.

---

## Limiti noti / prossimi passi

- PostgreSQL non ha ancora un audit log applicativo né backup automatici:
  aggiungerli prima di un impianto multi-utente.
- La sessione kiosk dipende dal cookie di refresh (90 giorni): se il browser
  cancella i cookie serve reinserire il PIN del device.
- Nessun service worker: aggiungerlo per il boot offline del pannello.
