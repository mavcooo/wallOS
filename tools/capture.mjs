import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });

const errors = [];

async function newPage(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'it-IT' });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return page;
}

const page = await newPage({ width: 1366, height: 900 });
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `artifacts/${name}.png` });
  console.log(`screenshot ${name}`);
};

const enterPin = async (pin) => {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (const digit of pin) {
    await dialog.getByRole('button', { name: digit, exact: true }).click();
  }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Overview' }).waitFor();
await page.waitForTimeout(1200);
await shot('01-overview');

await page.getByRole('button', { name: 'Stanze', exact: true }).click();
await page.getByRole('tab', { name: 'Soggiorno' }).waitFor();
await shot('02-rooms');

await page.getByRole('tab', { name: 'Cucina' }).click();
await page.waitForTimeout(300);
await shot('03-rooms-kitchen');

await page.getByRole('button', { name: 'Consumi', exact: true }).click();
await page.getByRole('heading', { name: 'Prese smart' }).waitFor();
await shot('04-energy');

await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
await page.getByRole('heading', { name: 'Broker MQTT' }).waitFor();
await shot('05-settings');

// Il profilo pannello non vede la voce Utenti: si passa dal chip profilo (PIN).
await page.getByRole('button', { name: /Pannello Parete/ }).last().click();
await page.getByRole('heading', { name: 'Profili pannello' }).waitFor();
await shot('06-users-panel');

await page.getByRole('button', { name: /Marco Bellini/ }).click();
await enterPin('1234');
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.getByText('Profilo Marco Bellini attivo').waitFor();
console.log('profile switch ok');
await shot('07-users-admin');

// PIN scenario: errore poi successo.
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await page.getByRole('button', { name: /Esci/ }).first().click();
await page.getByRole('dialog').waitFor();
await shot('08-pin-dialog');
await enterPin('9999');
await page.getByText(/PIN errato/).waitFor();
console.log('pin error feedback ok');
await shot('09-pin-error');
await enterPin('1234');
await page.getByRole('dialog').waitFor({ state: 'detached' });
console.log('pin success ok');
await shot('10-pin-success-toast');

// Standby / dimmer.
await page.getByRole('button', { name: 'Standby schermo' }).click();
await page.getByTestId('kiosk-dimmer-overlay').waitFor();
await page.waitForTimeout(1100);
await shot('11-standby');
await page.mouse.click(683, 500);
await page.waitForTimeout(1300);
const overlayOpacity = await page
  .getByTestId('kiosk-dimmer-overlay')
  .evaluate((el) => getComputedStyle(el).opacity);
console.log('overlay opacity after wake:', overlayOpacity);
const dialogsAfterWake = await page.getByRole('dialog').count();
console.log('dialog after wake (atteso 0):', dialogsAfterWake);
await shot('12-after-wake');

// Tablet kiosk 1024x768.
const tablet = await newPage({ width: 1024, height: 768 });
await tablet.goto(BASE, { waitUntil: 'networkidle' });
await tablet.getByRole('heading', { name: 'Overview' }).waitFor();
await tablet.waitForTimeout(900);
await tablet.screenshot({ path: 'artifacts/13-tablet-overview.png' });
await tablet.getByRole('button', { name: 'Stanze', exact: true }).click();
await tablet.waitForTimeout(500);
await tablet.screenshot({ path: 'artifacts/14-tablet-rooms.png' });
console.log('tablet screenshots ok');

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
