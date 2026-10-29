Secrets manager in use: none

# Infisical · segreti di sviluppo (domus-kiosk)

Il repository non usa oggi alcun secrets manager: la SPA e il micro-servizio
auth leggono variabili d'ambiente. In sviluppo i segreti stanno nel `.env`
locale (mai versionato); quando la setup qui sotto sarà completata,
`npm run dev:infisical` avvia Vite e `npm run dev:auth:infisical` avvia il
server auth dentro `infisical run --env=dev`, senza `.env` nel repository.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | sviluppo UI: `vite` → http://localhost:3000 (proxa `/api` su :8787) |
| `npm run dev:auth` | API auth + topologia Node/Fastify su :8787 |
| `npm run dev:infisical` | Vite con i segreti iniettati: `infisical run --env=dev -- vite` |
| `npm run dev:auth:infisical` | auth con i segreti iniettati: `infisical run --env=dev -- tsx watch server/index.ts` |
| `npm run build` | `tsc -b && vite build` + gate segreti su `dist/` |
| `npm run typecheck` | `tsc -b --pretty false` |
| `npm run test` | test frontend (`vitest run`) · `npm run test:watch` in sviluppo |
| `npm run test:server` | test delle API (Node + PostgreSQL WASM via PGlite) |
| `npm run preview` | serve `dist/` su :3000 |

`build`, `typecheck` e `preview` restano comandi di verifica/produzione e **non**
passano da `infisical run`: su CI e sul pannello reale servono una *machine
identity* (Universal Auth), non il CLI di sviluppo.

## Variabili d'ambiente

La SPA legge dal browser (`import.meta.env`) solo variabili `VITE_*`: host,
porta, path, base topic e prefissi discovery del broker. Sono **default
pubblici**; i valori salvati da *Impostazioni → broker* nel persist locale del
browser hanno la precedenza. Su un profilo già salvato, quindi, l'ambiente si
vede solo dopo un reset delle impostazioni: è il comportamento voluto, così il
pannello può sempre correggere un `.env` sbagliato.

Le credenziali del broker **non sono variabili di build**: si inseriscono una
volta sul pannello (Impostazioni → broker, utenza `wallos_kiosk` con ACL di sola
lettura stati e scrittura comandi) e restano nel persist locale del dispositivo.
Nessun segreto deve avere prefisso `VITE_`: `vite.config.ts` blocca il build se
il nome contiene PASSWORD/SECRET/TOKEN/KEY e `tools/verify-build-secrets.mjs`
scansiona `dist/` a ogni `npm run build`.

Il micro-servizio auth legge invece `process.env` (o il `.env` caricato da
Node): `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_PIN`, `KIOSK_PIN` e le altre
variabili `AUTH_*` restano sul server. Anche `MQTT_*` e `MOSQUITTO_*` sono
confinati al server/Compose: Vite espone esclusivamente le `VITE_*`. Nessuna
variabile sensibile è in quella lista.

I nomi riservati per l'ambiente `dev` di Infisical sono quelli elencati in
`.env.example` (valore vuoto o placeholder, nessun segreto).

Broker (pubbliche, visibili al browser):

- `VITE_MQTT_HOST`
- `VITE_MQTT_PORT`
- `VITE_MQTT_PROTOCOL`
- `VITE_MQTT_PATH`
- `VITE_MQTT_BASE_TOPIC`
- `VITE_MQTT_DISCOVERY_PREFIXES` (prefissi Home Assistant Discovery, separati da
  virgola; default `homeassistant`)

Broker (solo server, mai nel bundle):

- `MQTT_SERVER_URL`, `MQTT_HOST`, `MQTT_SERVER_PORT`, `MQTT_BASE_TOPIC`
- `MQTT_USERNAME`, `MQTT_PASSWORD` (utenza `wallos_backend`, `readwrite #`)
- `MOSQUITTO_BACKEND_USERNAME/PASSWORD` e `MOSQUITTO_KIOSK_PASSWORD` (provisioning
  del broker; la password kiosk va poi inserita sul pannello)

Auth (solo server, mai nel bundle):

- `JWT_SECRET` (>= 32 caratteri, obbligatorio in produzione)
- `ADMIN_PASSWORD`, `ADMIN_PIN`, `KIOSK_PIN` (seed del primo avvio)
- PostgreSQL: `DATABASE_URL` (fonte principale) oppure `DB_HOST`, `DB_PORT`,
  `DB_NAME`, `DB_USER`, `DB_PASSWORD` (alternative obbligatorie quando la URL
  manca). Aggiungere `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_MS`,
  `DATABASE_CONNECT_TIMEOUT_MS`, `DATABASE_SSL`. Verifica con `npm run db:check`.
- `AUTH_HOST`, `AUTH_PORT`, `AUTH_TRUST_PROXY`
- `AUTH_PROXY_TARGET` (letto da `vite.config.ts`, non dal browser)
- `CORS_ORIGINS`, `COOKIE_SECURE`, `BCRYPT_ROUNDS`
- `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `KIOSK_REFRESH_TOKEN_TTL`,
  `ELEVATION_TTL`, `SWITCH_PROFILE_TTL`
- `PIN_MAX_ATTEMPTS`, `PIN_LOCKOUT_MS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS`

Se almeno una variabile `VITE_MQTT_*` è impostata il kiosk parte con `demoMode`
spento: un ambiente che punta a un broker reale non deve restare in simulazione.

`MQTT_USERNAME` e `MQTT_PASSWORD` sono l'utenza del backend (readwrite #) letta
da `server/index.ts`: non sono le credenziali del pannello e non finiscono nel
bundle. Per il browser usa esclusivamente `wallos_kiosk` dalle Impostazioni, così
una credenziale esposta dal dispositivo non può pubblicare su `wallos/system/#`
o sovrascrivere gli stati retained.

## Finish setup

Un comando per riga: PowerShell 5.1 non supporta `&&`.

**1. Crea il progetto** — https://app.infisical.com, un progetto nuovo per
questo servizio (nasce con gli ambienti `dev`, `staging` e `prod`).

**2. Installa il CLI** — una sola riga, quella del tuo sistema:

```bash
npm install -g @infisical/cli
```

```bash
brew install infisical/get-cli/infisical
```

```bash
scoop bucket add org https://github.com/Infisical/scoop-infisical.git
```

```bash
scoop install infisical
```

**3. Autentica il CLI:**

```bash
infisical login
```

**4. Collega questa cartella al progetto:**

```bash
infisical init
```

`infisical init` scrive `.infisical.json` con l'id del progetto: nessun segreto
dentro, va committato.

**5. Importa il `.env`:** apri *Secrets Overview* dell'ambiente `dev` nel
progetto Infisical e trascina lì il tuo `.env` — tutte le chiavi entrano in un
colpo solo.

**6. Avvia l'app** (due terminali, entrambi dentro `infisical run --env=dev`):

```bash
npm run dev:auth:infisical
```

```bash
npm run dev:infisical
```

**7. Dimostra che i valori arrivano da Infisical:** sposta il `.env` **fuori**
dalla cartella del repository (mai un backup rinominato all'interno: git non lo
ignorerebbe) e riavvia.

```bash
Move-Item .env ..\.env
```

Riavvia `npm run dev:auth:infisical` e `npm run dev:infisical`: con il `.env`
assente i valori arrivano solo dal progetto Infisical.

### CI e produzione

Per CI, server e gateway serve una **machine identity** con Universal Auth
(`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` e `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`
nel secret store della piattaforma), mai una sessione `infisical login`
interattiva: `infisical run --env=prod -- <comando di produzione>`. Anche il
micro-servizio auth va avviato così: con `COOKIE_SECURE=true`, un `JWT_SECRET`
robusto e `ADMIN_PASSWORD`/`ADMIN_PIN`/`KIOSK_PIN` fornite dall'ambiente.

### Se un segreto è finito in git

Un segreto committato resta nella storia di git: cercalo con `infisical scan`,
poi **ruota** il valore (password broker, token, PIN) — rimuoverlo non basta.
