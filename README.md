# Domus · Kiosk di controllo domotico in LAN

Dashboard mission-critical per pannelli a parete e tablet, pensata per funzionare
**interamente in rete locale**: React 19 + Vite, TypeScript strict, Tailwind CSS v4,
Zustand, MQTT over WebSocket, Radix/shadcn pattern e Lucide.

Nessun cloud, nessun font remoto, nessuna dipendenza runtime esterna alla LAN.

---

## 1. Avvio rapido

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck  # tsc -b (strict, noUncheckedIndexedAccess)
npm run build      # typecheck + bundle di produzione
npm run preview    # serve dist/ su :3000
```

Al primo avvio l'app parte in **modalità demo** (`broker.demoMode = true`): il
simulatore locale aggiorna potenze, temperature e sensori ogni 3 s, così l'intera
UI è verificabile senza hardware.

**PIN demo: `1234`** (modificabile da Impostazioni → PIN pannello; 4 o 6 cifre).

Per il campo reale: Impostazioni → disattiva *Modalità demo*, inserisci IP/porta
WebSocket del broker (es. `192.168.1.10:9001`, path `/mqtt`) → *Salva e applica*.
La connessione riparte senza reload con backoff esponenziale.

In alternativa i valori iniziali del broker arrivano dalle variabili d'ambiente
`MQTT_*` (elenco e precedenza in `.env.example` / `INFISICAL.md`): se almeno una
è impostata l'app parte con la modalità demo spenta.

### Discovery Home Assistant (opzionale)

Fuori dalla modalità demo il kiosk si sottoscrive a `homeassistant/+/+/config` e
`homeassistant/+/+/+/config` (prefissi configurabili con
`MQTT_DISCOVERY_PREFIXES=homeassistant,zigbee2mqtt`). Ogni annuncio diventa un
widget: `light`, `switch`, `binary_sensor`, `sensor` e `climate` sono mappati sul
modello interno, `device.suggested_area` crea la stanza e i topic di stato e di
availability vengono sottoscritti subito.

- `devices.config.ts` resta il seed statico: le entità scoperte hanno id
  `ha:<component>:<object_id>` e non sovrascrivono i device del seed.
- Un annuncio con payload vuoto ritira l'entità: il widget sparisce subito.
- I device scoperti restano nella cache del persist: al riavvio i widget ci sono
  già, con disponibilità `unknown` finché il broker non risponde.

---

## 2. Struttura del progetto

```
domus-kiosk/
├── index.html
├── vite.config.ts
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── src/
│   ├── main.tsx                    # bootstrap React 19 + StrictMode
│   ├── App.tsx                     # provider, view router, guard profilo
│   ├── index.css                   # design token Tailwind v4 + base kiosk
│   │
│   ├── types/
│   │   ├── device.ts               # modello normalizzato (Device, stati, azioni)
│   │   └── mqtt.ts                 # broker, connection metrics, raw log
│   │
│   ├── config/
│   │   ├── app.config.ts           # default broker, timeout kiosk, regole PIN
│   │   ├── devices.config.ts       # mapping hardware → entità + adapter + topic
│   │   ├── rooms.config.ts         # metadati stanze
│   │   ├── scenarios.config.ts     # scene one-touch (step + delay + protezione)
│   │   └── users.config.ts         # profili locali, ruoli, restrizioni
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
│   │   └── useCurrentUser.ts       # profilo kiosk attivo
│   │
│   ├── store/
│   │   ├── homeStore.ts            # Zustand: entità, connessione, UI, PIN, utenti
│   │   └── toastStore.ts           # feedback comandi
│   │
│   ├── lib/
│   │   ├── utils.ts                # cn, formatter it-IT (W, kWh, °C, orologio)
│   │   └── pin.ts                  # SHA-256 + confronto a tempo costante
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn pattern su Radix (button, card, badge,
│   │   │                           # input/label, slider, switch, dialog, tabs)
│   │   ├── layout/                 # AppShell, Sidebar, Header, Clock, ConnectionBadge
│   │   ├── kiosk/                  # PinProtectionDialog, PinProvider,
│   │   │                           # KioskDimmerOverlay, Toaster
│   │   └── widgets/                # ClimateCard, LightCard, PowerCard, MediaCard,
│   │                               # SensorTile, ScenarioButton, SummaryCard
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
L'app è un pannello sempre acceso, senza SEO, senza RSC e senza server: una SPA
statica servita dal gateway/tablet è più semplice da aggiornare e funziona
offline. Se in futuro servisse autenticazione con sessione o API server, il
livello `mqtt/` e lo store sono indipendenti dal framework e si possono
trasferire in un App Router senza riscrivere i widget.

---

## 3. Modello dati normalizzato

`src/types/device.ts` è il contratto unico tra hardware e UI.

```ts
type DeviceKind = 'light' | 'climate' | 'power' | 'media' | 'sensor';

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

### Come si collega un nuovo dispositivo

1. aggiungi l'entry in `src/config/devices.config.ts` (id, stanza, adapter,
   topic, `fieldMap` se custom);
2. se il firmware è nuovo, implementa il suo adapter;
3. ricarica: subscribe, widget e scenari funzionano senza altre modifiche.

---

## 5. Kiosk, standby e PIN

### `useKioskDimmer`
- timeout configurabile (default **2 min**) con countdown interno;
- attività reale: `pointerdown`, `touchstart`, `keydown`, `wheel`, tab visibile;
- overlay nero con orologio a luminosità ~14% (anti burn-in);
- al tocco il listener in **capture phase** chiama `preventDefault` +
  `stopPropagation` e risveglia: il tap **non** attiva il widget sottostante;
- per 350 ms dopo il risveglio vengono assorbiti `pointerup`/`click` residui;
- il tasto standby in header e l'anteprima in Impostazioni usano lo stesso flusso.

### `PinProtectionDialog` + `PinProvider`
- tastierino 3×4, target 56 px, auto-submit a 4 o 6 cifre;
- hash SHA-256 con salt, confronto a tempo costante, nessun PIN in chiaro;
- feedback errore, vibrazione, **3 tentativi → blocco 60 s**;
- tentativi e lockout vivono nello store: chiudere/riaprire il dialog non li
  azzera (sopravvivono anche al cambio vista);
- qualunque azione sensibile si protegge con una riga:
  ```ts
  requestPin({ title: 'Azione protetta', description: '…', onConfirm: () => sendAction(… ) });
  ```
  Usato da scenario *Esci*, prese protette, spegnimento luci e cambio profilo.
- la lunghezza del PIN (4/6) viene ereditàta dallo store dopo il cambio.

### Profili e restrizioni
`activeUserId` decide viste, stanze visibili e azioni protette. La vista
*Utenti* è raggiungibile dal chip profilo anche per i ruoli ristretti (con PIN),
così un pannello non può restare bloccato fuori dal cambio profilo. La guardia
in `App.tsx` blocca comunque le viste `energy`/`settings` non consentite.

---

## 6. Sicurezza: cosa è reale e cosa va messo sul gateway

Il client browser **non è un confine di sicurezza**. In produzione:

- applicare ACL MQTT per topic (il pannello deve poter scrivere solo sui propri
  `cmnd`), con utenza dedicata e `wss://`/rete isolata;
- replicare la verifica del PIN lato gateway per le azioni critiche (allarme,
  varchi, distacco carichi);
- non salvare le credenziali del broker in chiaro nel browser: in questa demo
  stanno nel persist locale per comodità di setup. In produzione usare un
  provisioning server-side o un token efimero;
- il PIN locale è hashato ma resta un controllo di *interfaccia*: un attaccante
  con accesso fisico al dispositivo può comunque manomettere il client.

---

## 7. Verifiche eseguite

- `npm run typecheck` → 0 errori (strict, `noUncheckedIndexedAccess`).
- `npm run build` → build Vite OK.
- E2E Playwright (Chromium, 1366×900 e 1024×768):
  - navigazione nelle 5 viste, tab stanze, scenario protetto;
  - PIN errato → feedback, PIN corretto → scenario eseguito (11 comandi);
  - cambio PIN a 6 cifre → tastierino a 6 cifre;
  - 3 errori → lockout 60 s persistente alla riapertura del dialog;
  - standby → overlay nero, tap di risveglio senza comandi accidentali;
  - anteprima screensaver dalle impostazioni;
  - nessun errore console.
- E2E MQTT reale con broker `aedes` in WebSocket:
  - connessione WebSocket → `MQTT · Online`;
  - latenza probe misurata ~4 ms;
  - telemetria Z2M `brightness: 127` decodificata in `50%` in UI;
  - toggle UI → payload `{"state":"OFF"}` su `zigbee2mqtt/living/main/set`;
  - kill broker → `Riconnessione` con retry counter, restart → recovery
    automatico senza reload.

Gli script di verifica sono in `tools/` e richiedono dipendenze opzionali
(`playwright`, `aedes`, `websocket-stream`): vedi `tools/README.md`.

---

## 8. Limiti noti / prossimi passi

- Bundle unico ~786 kB (mqtt.js pesa ~300 kB): valutare `manualChunks` o import
  dinamico di mqtt per ridurre il first paint su tablet datati.
- Lo stato dei device non è persistito su disco: al reload si riparte dal
  config finché il broker non ripubblica. Per impianti reali conviene un
  `retain: true` sui topic di stato o un cache layer locale.
- Storico consumi e grafici 24h non sono inclusi: il modello `PowerDevice` è
  pronto per un adapter di serie storica (Influx/SQLite sul gateway).
- Autenticazione utenti solo locale/demo: per ruoli reali serve un backend con
  sessioni e audit log.
- Nessun service worker: aggiungerlo per il boot offline del pannello.
