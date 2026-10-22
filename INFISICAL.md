Secrets manager in use: none

# Infisical · segreti di sviluppo (domus-kiosk)

Il repository non usa oggi alcun secrets manager: il codice non legge variabili
d'ambiente, quindi `npm run dev` è un semplice `vite`. Quando la setup qui sotto
sarà completata, `npm run dev:infisical` avvia il dev server dentro
`infisical run --env=dev`, con i segreti del progetto già in ambiente e senza
`.env` nel repository.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | sviluppo locale: `vite` → http://localhost:3000 (nessun segreto richiesto) |
| `npm run dev:infisical` | come sopra ma con i segreti iniettati: `infisical run --env=dev -- vite` |
| `npm run build` | `tsc -b && vite build` (verifica + bundle di produzione) |
| `npm run typecheck` | `tsc -b --pretty false` |
| `npm run test` | `vitest run` (un giro) · `npm run test:watch` in sviluppo |
| `npm run preview` | serve `dist/` su :3000 |

`build`, `typecheck` e `preview` restano comandi di verifica/produzione e **non**
passano da `infisical run`: su CI e sul pannello reale servono una *machine
identity* (Universal Auth), non il CLI di sviluppo.

## Variabili d'ambiente

L'app è una SPA Vite statica. All'avvio `src/config/app.config.ts` legge dal
browser (`import.meta.env`) host, porta, path e credenziali del broker e li usa
come **default**; i valori salvati da *Impostazioni → broker* nel persist locale
del browser hanno la precedenza. Su un profilo già salvato, quindi, l'ambiente
si vede solo dopo un reset delle impostazioni: è il comportamento voluto, così
il pannello può sempre correggere un `.env` sbagliato.

Vite espone di default solo le variabili `VITE_*`: i nomi `MQTT_*` arrivano
all'app perché sono elencati in `envPrefix` dentro `vite.config.ts`.

I nomi riservati per l'ambiente `dev` di Infisical sono quelli del broker, gli
stessi elencati in `.env.example` (valore vuoto o placeholder, nessun segreto):

- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_PROTOCOL`
- `MQTT_PATH`
- `MQTT_BASE_TOPIC`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`

Se almeno una di queste è impostata il kiosk parte con `demoMode` spento: un
ambiente che punta a un broker reale non deve restare in simulazione.

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

**6. Avvia l'app** (gira dentro `infisical run --env=dev`, da qui in poi `npm run dev:infisical`):

```bash
npm run dev
```

**7. Dimostra che i valori arrivano da Infisical:** sposta il `.env` **fuori**
dalla cartella del repository (mai un backup rinominato all'interno: git non lo
ignorerebbe) e riavvia.

```bash
Move-Item .env ..\.env
```

```bash
npm run dev
```

### CI e produzione

Per CI, server e gateway serve una **machine identity** con Universal Auth
(`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` e `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`
nel secret store della piattaforma), mai una sessione `infisical login`
interattiva: `infisical run --env=prod -- <comando di produzione>`.

### Se un segreto è finito in git

Un segreto committato resta nella storia di git: cercalo con `infisical scan`,
poi **ruota** il valore (password broker, token, PIN) — rimuoverlo non basta.
