import type { AuthConfig } from './types.js';
import type { AuthDb } from './db.js';
import { hashSecret, pinLengthOf, randomId } from './security.js';

/**
 * Inserisce admin e kiosk solo se assenti. Non sovrascrive mai credenziali
 * esistenti: un riavvio del gateway non riporta il PIN ai valori di default.
 */
export async function seedDatabase(db: AuthDb, config: AuthConfig): Promise<void> {
  if (!db.findUserByUsername(config.seed.adminUsername)) {
    db.insertUser({
      id: randomId(),
      username: config.seed.adminUsername,
      displayName: config.seed.adminDisplayName,
      passwordHash: await hashSecret(config.seed.adminPassword, config.bcryptRounds),
      role: 'admin',
      pinHash: await hashSecret(config.seed.adminPin, config.bcryptRounds),
      pinLength: pinLengthOf(config.seed.adminPin),
      isKioskDevice: false,
      kioskDeviceId: null,
      allowedRooms: null,
    });
  }

  if (!db.findKioskByDeviceId(config.seed.kioskDeviceId)) {
    db.insertUser({
      id: randomId(),
      username: config.seed.kioskUsername,
      displayName: config.seed.kioskDisplayName,
      // Un device kiosk non ha password: si autentica solo con device+PIN.
      passwordHash: null,
      role: 'kiosk',
      pinHash: await hashSecret(config.seed.kioskPin, config.bcryptRounds),
      pinLength: pinLengthOf(config.seed.kioskPin),
      isKioskDevice: true,
      kioskDeviceId: config.seed.kioskDeviceId,
      allowedRooms: null,
    });
  }
}
