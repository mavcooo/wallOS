# Verifiche opzionali

Script di QA usati per validare l'interfaccia e il percorso MQTT reale.
Non fanno parte del bundle e non sono richiesti per lo sviluppo.

```bash
# dipendenze opzionali (non salvate in package.json)
npm install --no-save playwright@1.49.1 aedes@0.51.3 websocket-stream@5.5.2
npx playwright install chromium

# il dev server deve girare su http://localhost:3000
node tools/verify-ui.mjs     # toggle reale, PIN 4/6, lockout, screensaver
node tools/capture.mjs       # screenshot delle viste in artifacts/
node tools/mqtt-e2e.mjs      # broker aedes: connect, decode, comandi, reconnect
```

## Convenzioni di naming

```bash
npm run lint:filenames   # node tools/lint-naming-conventions.mjs
```

Controllo bloccante in CI (nessuna dipendenza): pattern e unicità delle
migrazioni, PascalCase di componenti e hook, camelCase dei moduli, suffisso
dei test. Le regole e l'eccezione per le migrazioni storiche sono in
`README.md` → *Convenzioni di naming e linee guida file*.

## Hardening del broker

Con lo stack di produzione attivo (`docker compose --profile prod up -d`) e le
credenziali provisionate:

```bash
./tools/init-mqtt-auth.sh     # crea mosquitto/auth/passwd (PBKDF2)
npm run test:mqtt-auth        # anonimo bloccato, ACL e retained protetti
```

Lo script legge `.env` (o l'ambiente) per `MOSQUITTO_BACKEND_*` e
`MOSQUITTO_KIOSK_*`. Non fa parte di `npm test`: richiede un broker reale.

La password kiosk non va mai nella build: inseriscila una volta sul pannello in
*Impostazioni → broker* (utente `wallos_kiosk`). Dopo il bundle,
`npm run verify:build-secrets` (già eseguito da `npm run build`) scansiona
`dist/` e blocca il rilascio se trova il valore di un segreto noto, un
riferimento a `MQTT_PASSWORD`/`JWT_SECRET`/... o un URL con credenziali.

`tools/broker.mjs` avvia un broker WebSocket di test su `127.0.0.1:9001/mqtt` con
API HTTP di controllo su `127.0.0.1:9002` (`/publish`, `/commands`, `/health`).

Su Linux minimale può servire `npx playwright install-deps chromium` (richiede
root) per le librerie di sistema del browser.
