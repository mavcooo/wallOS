/**
 * E2E del percorso MQTT reale (non demo):
 * connessione WebSocket, decode adapter, publish comandi, kill broker,
 * backoff di riconnessione e recovery automatico.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium } from 'playwright';

const CONTROL = 'http://127.0.0.1:9002';
let broker = null;

function startBroker() {
  broker = spawn(process.execPath, ['tools/broker.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  broker.stdout.on('data', (chunk) => process.stdout.write(`[broker] ${chunk}`));
  broker.stderr.on('data', (chunk) => process.stderr.write(`[broker-err] ${chunk}`));
}

async function waitForBroker() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${CONTROL}/health`);
      if (response.ok) return;
    } catch {
      /* ancora in avvio */
    }
    await sleep(100);
  }
  throw new Error('broker non raggiungibile');
}

async function stopBroker() {
  if (!broker) return;
  broker.kill('SIGKILL');
  broker = null;
  await sleep(300);
}

async function publish(topic, payload) {
  const url = `${CONTROL}/publish?topic=${encodeURIComponent(topic)}&payload=${encodeURIComponent(payload)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`publish fallita: ${response.status}`);
}

startBroker();
await waitForBroker();

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'it-IT' });
const page = await context.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (error) => errors.push(error.message));

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
await page.getByLabel('Host / IP broker').fill('127.0.0.1');
await page.getByLabel('Modalità demo').click();
await page.getByRole('button', { name: 'Salva e applica' }).click();

await page.getByText('MQTT · Online').waitFor({ timeout: 15_000 });
console.log('connessione reale al broker: ok');

// Latency probe (echo topic).
await page.waitForTimeout(16_000);
const latencyText = await page.locator('header').getByText(/^\d+ ms$/).first().textContent();
console.log('latenza misurata dal probe:', latencyText);

// Telemetria inbound → adapter Z2M → stato normalizzato in UI.
await publish('zigbee2mqtt/living/main', JSON.stringify({ state: 'ON', brightness: 127 }));
await page.getByRole('button', { name: 'Stanze', exact: true }).click();
await page.waitForTimeout(700);
const brightnessLabel = await page.getByText('Soggiorno · 50%').first().textContent();
console.log('decode Z2M brightness 127 ->', brightnessLabel);

// Comando outbound: toggle luce → payload Z2M sul topic /set.
const commandsBefore = (await (await fetch(`${CONTROL}/commands`)).json()).length;
await page.getByRole('switch', { name: 'Accendi o spegni Luce principale' }).click();
await sleep(500);
const commands = await (await fetch(`${CONTROL}/commands`)).json();
const newCommands = commands.slice(commandsBefore);
console.log('comandi ricevuti dal broker:', newCommands);
const expected = newCommands.some(
  (entry) =>
    entry.topic === 'zigbee2mqtt/living/main/set' && entry.payload.includes('"state":"OFF"'),
);
if (!expected) throw new Error('payload di comando Z2M non corretto');

// Kill del broker → backoff e contatore retry visibile.
await stopBroker();
await page.getByText('MQTT · Riconnessione').waitFor({ timeout: 10_000 });
await page.waitForTimeout(2000);
const headerText = await page.locator('header').innerText();
console.log('header durante il down:', headerText.replace(/\n/g, ' | '));
await page.screenshot({ path: 'artifacts/16-mqtt-reconnect.png' });

// Restart → recovery automatico senza reload.
startBroker();
await waitForBroker();
await page.getByText('MQTT · Online').waitFor({ timeout: 25_000 });
console.log('riconnessione automatica dopo restart: ok');
await page.screenshot({ path: 'artifacts/17-mqtt-recovered.png' });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
await stopBroker();
if (errors.length) process.exitCode = 1;
