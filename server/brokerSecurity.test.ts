import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Invarianti di sicurezza del broker: git può sempre ripristinare un file di
 * configurazione per errore, quindi queste regole vengono verificate a ogni
 * `npm run test:server` senza bisogno di Docker.
 *
 * La verifica *funzionale* (connessione anonima rifiutata, ACL applicate,
 * retained protetti) è `tools/mqtt-auth-check.mjs` contro un broker reale.
 */

const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

/** Righe attive di un file Mosquitto, senza commenti né righe vuote. */
function activeLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Porzione di ACL di una singola utenza (fino al blocco `user` successivo). */
function aclBlock(acl: string, user: string): string {
  const lines = acl.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `user ${user}`);
  if (start === -1) throw new Error(`blocco ACL mancante per ${user}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^user\s+/.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('Mosquitto: configurazione di produzione', () => {
  const conf = activeLines(read('mosquitto/config/mosquitto.prod.conf'));

  it('non ammette alcun accesso anonimo', () => {
    expect(conf).toContain('allow_anonymous false');
    expect(conf.some((line) => /^allow_anonymous\s+true$/.test(line))).toBe(false);
  });

  it('richiede password_file e acl_file', () => {
    expect(conf).toContain('password_file /mosquitto/config/auth/passwd');
    expect(conf).toContain('acl_file /mosquitto/config/acl');
  });

  it('applica la stessa policy a TCP e WebSocket', () => {
    expect(conf).toContain('listener 1883 0.0.0.0');
    expect(conf).toContain('listener 9001 0.0.0.0');
    expect(conf).toContain('protocol websockets');
    // `per_listener_settings true` permetterebbe a un listener di scivolare
    // su anonymous: deve restare il default globale.
    expect(conf).not.toContain('per_listener_settings true');
  });
});

describe('ACL: privilegio minimo', () => {
  const acl = read('mosquitto/config/acl');

  it('il backend mantiene l’accesso completo necessario al rule engine', () => {
    expect(aclBlock(acl, 'wallos_backend')).toMatch(/^topic readwrite #$/m);
  });

  it('il kiosk legge gli stati e scrive solo sui topic di comando', () => {
    const block = aclBlock(acl, 'wallos_kiosk');
    expect(block).toMatch(/^topic read stat\/#$/m);
    expect(block).toMatch(/^topic write cmnd\/#$/m);
    expect(block).not.toMatch(/^topic readwrite #$/m);
    expect(block).not.toMatch(/^topic write #$/m);
    expect(block).not.toMatch(/^topic write wallos\/system\//m);
  });

  it('il kiosk non può sovrascrivere stati o telemetrie retained', () => {
    const writes = aclBlock(acl, 'wallos_kiosk')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('topic write '));

    expect(writes.length).toBeGreaterThan(0);
    for (const rule of writes) {
      expect(rule).not.toMatch(/(^|\s)(stat|tele)\//);
      expect(rule).not.toContain('wallos/system/');
    }
  });
});

describe('docker-compose: esposizione e identità', () => {
  const compose = read('docker-compose.yml');

  it('pubblica le porte solo sull’interfaccia configurata (default loopback)', () => {
    expect(compose).toContain("'${MOSQUITTO_BIND_IP:-127.0.0.1}:1883:1883'");
    expect(compose).toContain("'${MOSQUITTO_BIND_IP:-127.0.0.1}:9001:9001'");
    expect(compose).not.toMatch(/['"]0\.0\.0\.0:\d+:/);
    expect(compose).not.toMatch(/['"]1883:1883['"]/);
    expect(compose).not.toMatch(/['"]9001:9001['"]/);
  });

  it('avvia il broker di produzione con la validazione bloccante', () => {
    expect(compose).toContain("profiles: ['prod']");
    expect(compose).toContain("profiles: ['dev']");
    expect(compose).toContain("MQTT_REQUIRE_AUTH: 'true'");
    expect(compose).toContain('MQTT_CONFIG: /mosquitto/config/mosquitto.prod.conf');
    expect(compose).toContain('/mosquitto/entrypoint.sh');
  });

  it('passa al backend credenziali distinte da quelle del browser', () => {
    expect(compose).toContain(
      'MQTT_USERNAME: ${MOSQUITTO_BACKEND_USERNAME:-wallos_backend}',
    );
    expect(compose).toContain('MQTT_PASSWORD: ${MOSQUITTO_BACKEND_PASSWORD:-}');
  });
});

describe('bundle client: nessuna credenziale MQTT', () => {
  it('Vite espone esclusivamente il prefisso pubblico VITE_', () => {
    const config = read('vite.config.ts');

    expect(config).toContain("const publicEnvPrefixes = ['VITE_'];");
    expect(config).not.toMatch(/envPrefix:\s*\[[^\]]*'MQTT_'/);
  });

  it('la configurazione client non legge utente o password del broker', () => {
    const clientConfig = read('src/config/app.config.ts');

    expect(clientConfig).toContain('VITE_MQTT_HOST');
    expect(clientConfig).not.toMatch(/\bMQTT_(?:USERNAME|PASSWORD)\b/);
  });

  it('il template .env non offre credenziali al bundle', () => {
    const envExample = read('.env.example');

    expect(envExample).toMatch(/^VITE_MQTT_HOST=/m);
    // Nessuna variabile pubblica può essere una credenziale. `MQTT_USERNAME`/
    // `MQTT_PASSWORD` restano nel template solo come utenza backend del server.
    expect(envExample).not.toMatch(/^VITE_\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY)\w*=/m);
    expect(envExample).not.toMatch(/^VITE_MQTT_(?:USERNAME|PASSWORD)=/m);
    // La password kiosk vive solo nel provisioning Mosquitto/Compose e va
    // inserita a mano sul pannello, mai passata alla build.
    expect(envExample).toMatch(/^MOSQUITTO_KIOSK_PASSWORD=/m);
  });
});

describe('provisioning delle credenziali', () => {
  it('l’entrypoint interrompe l’avvio con allow_anonymous true', () => {
    const entrypoint = read('mosquitto/entrypoint.sh');
    expect(entrypoint).toContain('allow_anonymous[[:space:]]+true');
    expect(entrypoint).toContain('MQTT_REQUIRE_AUTH');
    expect(entrypoint).toContain('password_file vuoto o assente');
  });

  it('i segreti del backend non usano il prefisso MQTT_ (bundle Vite)', () => {
    const envExample = read('.env.example');
    expect(envExample).toContain('MOSQUITTO_BACKEND_PASSWORD=');
    expect(envExample).not.toContain('MQTT_BACKEND_PASSWORD');
  });
});
