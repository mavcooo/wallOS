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
| `npm run dev:auth` | micro-servizio auth Node/Fastify su :8787 |
| `npm run dev:infisical` | Vite con i segreti iniettati: `infisical run --env=dev -- vite` |
| `npm run dev:auth:infisical` | auth con i segreti iniettati: `infisical run --env=dev -- tsx watch server/index.ts` |
| `npm run build` | `tsc -b && vite build` (verifica + bundle di produzione) |
| `npm run typecheck` | `tsc -b --pretty false` |
| `npm run test` | test frontend (`vitest run`) · `npm run test:watch` in sviluppo |
| `npm run test:server` | test del servizio auth (Node + SQLite in memoria) |
| `npm run preview` | serve `dist/` su :3000 |

`build`, `typecheck` e `preview` restano comandi di verifica/produzione e **non**
passano da `infisical run`: su CI e sul pannello reale servono una *machine
identity* (Universal Auth), non il CLI di sviluppo.

## Variabili d'ambiente

La SPA legge dal browser (`import.meta.env`) host, porta, path e credenziali del
broker e li usa come **default**; i valori salvati da *Impostazioni → broker* nel
persist locale del browser hanno la precedenza. Su un profilo già salvato,
quindi, l'ambiente si vede solo dopo un reset delle impostazioni: è il
comportamento voluto, così il pannello può sempre correggere un `.env` sbagliato.

Il micro-servizio auth legge invece `process.env` (o il `.env` caricato da
Node): `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_PIN`, `KIOSK_PIN` e le altre
variabili `AUTH_*` restano sul server. Vite espone di default solo le variabili
`VITE_*`; i nomi `MQTT_*` arrivano all'app perché elencati in `envPrefix` dentro
`vite.config.ts`. Nessuna variabile di auth è in quella lista.

I nomi riservati per l'ambiente `dev` di Infisical sono quelli elencati in
`.env.example` (valore vuoto o placeholder, nessun segreto).

Broker (visibili al browser, utenza dedicata con ACL):

- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_PROTOCOL`
- `MQTT_PATH`
- `MQTT_BASE_TOPIC`
- `MQTT_DISCOVERY_PREFIXES` (prefissi Home Assistant Discovery, separati da
  virgola; default `homeassistant`)
- `MQTT_USERNAME`
- `MQTT_PASSWORD`

Auth (solo server, mai nel bundle):

- `JWT_SECRET` (>= 32 caratteri, obbligatorio in produzione)
- `ADMIN_PASSWORD`, `ADMIN_PIN`, `KIOSK_PIN` (seed del primo avvio)
- `AUTH_HOST`, `AUTH_PORT`, `AUTH_DB_PATH`, `AUTH_TRUST_PROXY`
- `AUTH_PROXY_TARGET` (letto da `vite.config.ts`, non dal browser)
- `CORS_ORIGINS`, `COOKIE_SECURE`, `BCRYPT_ROUNDS`
- `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `KIOSK_REFRESH_TOKEN_TTL`,
  `ELEVATION_TTL`, `SWITCH_PROFILE_TTL`
- `PIN_MAX_ATTEMPTS`, `PIN_LOCKOUT_MS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS`

Se almeno una variabile `MQTT_*` è impostata il kiosk parte con `demoMode`
spento: un ambiente che punta a un broker reale non deve restare in simulazione.

`MQTT_USERNAME` e `MQTT_PASSWORD` sono segreti del broker: qui valgono come
credenziali del client MQTT, che gira nel browser, quindi finiscono comunque nel
bundle servito al pannello. Non metterci altro che la password del broker, e usa
un'utenza dedicata con ACL sui soli topic della casa.

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
