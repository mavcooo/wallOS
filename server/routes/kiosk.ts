import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { timestampMs } from '../db.js';
import { HttpError } from '../http.js';
import type { KioskConfigPublisher } from '../services/kioskEvents.js';
import { requireAuth, requireRole } from '../session.js';
import type {
  AuthConfig,
  KioskDisplayFields,
  KioskDisplayRow,
  KioskOrientation,
  KioskScreensaverMode,
} from '../types.js';

export interface KioskDeps {
  db: Database;
  config: AuthConfig;
  /** Notifica real-time ai pannelli; `null` quando il broker non è configurato. */
  publisher: KioskConfigPublisher;
}

/**
 * L'id finisce in una primary key `VARCHAR(64)` e in un topic MQTT: niente
 * spazi, slash o wildcard. Il default generato dal pannello è `kiosk_<uuid>`,
 * l'amministratore può sostituirlo con `tablet_ingresso`.
 */
const kioskIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 'Identificativo display non valido');

/**
 * Payload di `PUT /api/kiosk/:id`: tutti i campi sono opzionali, il pannello
 * manda solo quello che cambia (es. il timeout del dimmer) e l'amministratore
 * dalla scheda Display ne manda più di uno insieme.
 */
const updateKioskSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    defaultRoomId: z.string().trim().max(64).nullable().optional(),
    dimmerTimeoutSec: z.number().int().min(30).max(600).optional(),
    dimmerScreensaverMode: z.enum(['clock_float', 'black', 'off']).optional(),
    performanceMode: z.boolean().optional(),
    highContrast: z.boolean().optional(),
    pinRequired: z.boolean().optional(),
    screenOrientation: z.enum(['landscape', 'portrait']).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

type UpdateKioskBody = z.infer<typeof updateKioskSchema>;

interface KioskDisplayDto {
  id: string;
  name: string;
  defaultRoomId: string | null;
  dimmerTimeoutSec: number;
  dimmerScreensaverMode: KioskScreensaverMode;
  performanceMode: boolean;
  highContrast: boolean;
  pinRequired: boolean;
  screenOrientation: KioskOrientation;
  isActive: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** true se il pannello ha parlato con il server nell'ultimo minuto. */
  online: boolean;
}

/** Oltre questo silenzio il display è considerato offline nella griglia admin. */
const ONLINE_WINDOW_MS = 90_000;

function toDto(row: KioskDisplayRow, now = Date.now()): KioskDisplayDto {
  const lastSeenAt = row.last_seen_at ? timestampMs(row.last_seen_at) : null;
  return {
    id: row.id,
    name: row.name,
    defaultRoomId: row.default_room_id,
    dimmerTimeoutSec: Number(row.dimmer_timeout_sec),
    dimmerScreensaverMode: row.dimmer_screensaver_mode,
    performanceMode: row.performance_mode,
    highContrast: row.high_contrast,
    pinRequired: row.pin_required,
    screenOrientation: row.screen_orientation,
    isActive: row.is_active,
    lastSeenAt,
    createdAt: timestampMs(row.created_at),
    updatedAt: timestampMs(row.updated_at),
    online: lastSeenAt !== null && now - lastSeenAt <= ONLINE_WINDOW_MS,
  };
}

function readId(request: FastifyRequest): string {
  const parsed = kioskIdSchema.safeParse((request.params as { id?: string }).id ?? '');
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_KIOSK_ID', 'Identificativo display non valido');
  }
  return parsed.data;
}

/**
 * Chi può toccare una configurazione: l'amministratore qualunque pannello, il
 * profilo kiosk **solo il proprio** (il suo id è `users.kiosk_device_id`, non
 * quello che dichiara il browser).
 */
function assertCanAccess(request: FastifyRequest, id: string): { admin: boolean } {
  const auth = request.auth;
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
  if (auth.user.role === 'admin') return { admin: true };
  if (auth.user.kiosk_device_id && auth.user.kiosk_device_id === id) return { admin: false };
  throw new HttpError(403, 'FORBIDDEN', 'Permessi insufficienti su questo display');
}

/**
 * Kiosk Profiles & Centralized Hardware Sync.
 *
 * - `GET /api/kiosk` elenca i pannelli registrati (amministratore);
 * - `GET /api/kiosk/:id` idrata il pannello all'avvio e **auto-registra** il
 *   display al primo boot: nessun 404, nessun passaggio manuale;
 * - `PUT /api/kiosk/:id` salva le preferenze e pubblica contestualmente
 *   `wallos/system/kiosk/<id>/config_updated`, così il tablet le applica entro
 *   un secondo senza tocco né reload.
 */
export function registerKioskRoutes(app: FastifyInstance, deps: KioskDeps): void {
  app.get('/api/kiosk', { preHandler: requireRole(deps, ['admin']) }, async () => {
    const rows = await deps.db.listKioskDisplays();
    const now = Date.now();
    return { displays: rows.map((row) => toDto(row, now)) };
  });

  app.get('/api/kiosk/:id', { preHandler: requireAuth(deps) }, async (request) => {
    const id = readId(request);
    assertCanAccess(request, id);

    // `ON CONFLICT` dentro `registerKioskDisplay`: primo avvio = riga nuova con
    // i default, avvii successivi = solo `last_seen_at`.
    const row = await deps.db.registerKioskDisplay(id, `Nuovo Display (${id})`);
    return { display: toDto(row) };
  });

  app.put('/api/kiosk/:id', { preHandler: requireAuth(deps) }, async (request) => {
    const id = readId(request);
    const { admin } = assertCanAccess(request, id);

    const parsed = updateKioskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, 'INVALID_BODY', issue?.message ?? 'Configurazione display non valida', {
        field: issue?.path.join('.') ?? 'body',
      });
    }
    const patch: UpdateKioskBody = parsed.data;

    // Nome e attivazione restano in mano all'amministratore: un pannello non
    // deve potersi ribattezzare o riattivare da solo.
    if (!admin && (patch.name !== undefined || patch.isActive !== undefined)) {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Solo l’amministratore può rinominare o attivare un display',
      );
    }

    const current = await deps.db.findKioskDisplay(id);
    if (!current) throw new HttpError(404, 'KIOSK_NOT_FOUND', 'Display non registrato');

    // La stanza iniziale deve esistere: la FK lo impedirebbe con un errore
    // opaco (500), qui diventa un 400 con il campo colpevole.
    if (patch.defaultRoomId) {
      const room = await deps.db.findRoomById(patch.defaultRoomId);
      if (!room) {
        throw new HttpError(400, 'ROOM_NOT_FOUND', 'La stanza predefinita non esiste', {
          field: 'defaultRoomId',
        });
      }
    }

    const fields: KioskDisplayFields = {
      name: patch.name ?? current.name,
      default_room_id:
        patch.defaultRoomId === undefined ? current.default_room_id : patch.defaultRoomId,
      dimmer_timeout_sec: patch.dimmerTimeoutSec ?? Number(current.dimmer_timeout_sec),
      dimmer_screensaver_mode:
        patch.dimmerScreensaverMode ?? current.dimmer_screensaver_mode,
      performance_mode: patch.performanceMode ?? current.performance_mode,
      high_contrast: patch.highContrast ?? current.high_contrast,
      pin_required: patch.pinRequired ?? current.pin_required,
      screen_orientation: patch.screenOrientation ?? current.screen_orientation,
      is_active: patch.isActive ?? current.is_active,
    };

    const updated = await deps.db.updateKioskDisplay(id, fields);
    if (!updated) throw new HttpError(404, 'KIOSK_NOT_FOUND', 'Display non registrato');

    const display = toDto(updated);
    deps.publisher.publish({ id, config: display, timestamp: Date.now() });

    return { display };
  });
}
