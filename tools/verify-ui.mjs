import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'it-IT',
});
const page = await context.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (error) => errors.push(error.message));

const enterPin = async (pin) => {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (const digit of pin) {
    await dialog.getByRole('button', { name: digit, exact: true }).click();
  }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Overview' }).waitFor();

// Demo state: toggle reale di un dispositivo.
const before = await page.getByText(/^\d+ \/ \d+$/).first().textContent();
await page.getByRole('switch', { name: 'Accendi o spegni Luce principale' }).click();
await page.waitForTimeout(300);
const after = await page.getByText(/^\d+ \/ \d+$/).first().textContent();
console.log('lights counter:', before, '->', after);
if (before === after) throw new Error('Il toggle luce non ha aggiornato lo stato');

// Cambio PIN a 6 cifre (richiede PIN corrente 1234).
await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
await page.getByLabel('Nuovo PIN (4-6 cifre)').fill('432156');
await page.getByLabel('Conferma PIN').fill('432156');
await page.getByRole('button', { name: 'Aggiorna PIN' }).click();
await enterPin('1234');
await page.getByText('PIN aggiornato').waitFor();
console.log('pin change to 6 digits ok');

// Il dialog deve ora chiedere 6 cifre.
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await page.getByRole('button', { name: /Esci/ }).first().click();
await page.getByLabel('PIN di 6 cifre').waitFor();
console.log('pin length propagated ok');
await page.getByRole('dialog').getByRole('button', { name: 'Chiudi' }).click();

// Lockout dopo 3 errori, persistente alla chiusura del dialog.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  await page.getByRole('button', { name: /Esci/ }).first().click();
  await enterPin('999999');
  if (attempt < 3) {
    await page.getByText(/PIN errato/).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Chiudi' }).click();
  }
}
await page.getByText(/Bloccato/).waitFor();
console.log('lockout triggered ok');
await page.getByRole('dialog').getByRole('button', { name: 'Chiudi' }).click();
await page.getByRole('button', { name: /Esci/ }).first().click();
await page.getByText(/Bloccato/).waitFor();
const keyDisabled = await page
  .getByRole('dialog')
  .getByRole('button', { name: '1', exact: true })
  .isDisabled();
console.log('lockout persists after reopen, keypad disabled:', keyDisabled);
if (!keyDisabled) throw new Error('Il tastierino dovrebbe essere disabilitato durante il lockout');
await page.screenshot({ path: 'artifacts/15-pin-lockout.png' });
await page.getByRole('dialog').getByRole('button', { name: 'Chiudi' }).click();

// Anteprima screensaver dalle impostazioni.
await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
await page.getByRole('button', { name: 'Mostra anteprima screensaver' }).click();
await page.getByTestId('kiosk-dimmer-overlay').waitFor();
await page.waitForTimeout(1000);
const visibleOpacity = await page
  .getByTestId('kiosk-dimmer-overlay')
  .evaluate((el) => getComputedStyle(el).opacity);
console.log('screensaver opacity:', visibleOpacity);
await page.mouse.click(683, 500);
await page.waitForTimeout(1100);

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
