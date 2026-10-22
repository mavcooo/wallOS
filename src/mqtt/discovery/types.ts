/**
 * Tipi e regole del protocollo Home Assistant MQTT Discovery.
 *
 * Riferimento: l'annuncio è un JSON retained su
 * `<prefix>/<component>/[<node_id>/]<object_id>/config`. I nomi dei campi hanno
 * forme abbreviate ufficiali (`stat_t`, `cmd_t`, `uniq_id`, `dev`, …): qui si
 * espandono subito, così il normalizzatore lavora con un solo vocabolario.
 */

export interface HaDiscoveryDevice {
  identifiers?: string | readonly string[];
  name?: string;
  model?: string;
  manufacturer?: string;
  suggested_area?: string;
  sw_version?: string;
  hw_version?: string;
}

export interface HaAvailabilityEntry {
  topic?: string;
  payload_available?: string;
  payload_not_available?: string;
}

export interface HaDiscoveryConfig {
  name?: string | null;
  unique_id?: string;
  object_id?: string;
  state_topic?: string;
  command_topic?: string;
  value_template?: string;
  unit_of_measurement?: string;
  device_class?: string;
  brightness_state_topic?: string;
  brightness_command_topic?: string;
  brightness_scale?: number;
  color_temp_state_topic?: string;
  color_temp_command_topic?: string;
  min_mireds?: number;
  max_mireds?: number;
  current_temperature_topic?: string;
  temperature_state_topic?: string;
  temperature_command_topic?: string;
  mode_state_topic?: string;
  mode_command_topic?: string;
  min_temp?: number;
  max_temp?: number;
  temp_step?: number;
  payload_on?: string;
  payload_off?: string;
  availability_topic?: string;
  payload_available?: string;
  payload_not_available?: string;
  availability?: HaAvailabilityEntry | HaAvailabilityEntry[];
  device?: HaDiscoveryDevice;
  /** Campi non previsti restano accessibili ma non usati. */
  [key: string]: unknown;
}

/** Abbreviazioni ufficiali HA → nome esteso. */
export const SHORT_KEYS: Readonly<Record<string, string>> = {
  avty: 'availability',
  avty_mode: 'availability_mode',
  avty_t: 'availability_topic',
  avty_tpl: 'availability_template',
  bri_cmd_t: 'brightness_command_topic',
  bri_scl: 'brightness_scale',
  bri_stat_t: 'brightness_state_topic',
  bri_val_tpl: 'brightness_value_template',
  clr_temp_cmd_t: 'color_temp_command_topic',
  clr_temp_stat_t: 'color_temp_state_topic',
  clr_temp_val_tpl: 'color_temp_value_template',
  cmd_t: 'command_topic',
  cmd_tpl: 'command_template',
  curr_temp_t: 'current_temperature_topic',
  curr_temp_tpl: 'current_temperature_template',
  dev: 'device',
  dev_cla: 'device_class',
  e: 'encoding',
  ic: 'icon',
  json_attr_t: 'json_attributes_topic',
  max_mirs: 'max_mireds',
  min_mirs: 'min_mireds',
  mode_cmd_t: 'mode_command_topic',
  mode_stat_t: 'mode_state_topic',
  mode_stat_tpl: 'mode_state_template',
  obj_id: 'object_id',
  off_dly: 'off_delay',
  p: 'platform',
  pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available',
  pl_off: 'payload_off',
  pl_on: 'payload_on',
  qos: 'qos',
  ret: 'retain',
  stat_cla: 'state_class',
  stat_t: 'state_topic',
  stat_tpl: 'state_template',
  temp_cmd_t: 'temperature_command_topic',
  temp_stat_t: 'temperature_state_topic',
  temp_step: 'temp_step',
  uniq_id: 'unique_id',
  unit_of_meas: 'unit_of_measurement',
  val_tpl: 'value_template',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Espande le abbreviazioni anche dentro `availability` (singolo oggetto o array). */
export function expandShortKeys(input: Record<string, unknown>): Record<string, unknown> {
  const expanded: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    expanded[SHORT_KEYS[key] ?? key] = value;
  }

  const availability = expanded['availability'];
  if (isRecord(availability)) {
    expanded['availability'] = expandShortKeys(availability);
  } else if (Array.isArray(availability)) {
    expanded['availability'] = availability.map((entry) =>
      isRecord(entry) ? expandShortKeys(entry) : entry,
    );
  }

  return expanded;
}

/**
 * Parsing difensivo: un payload malformato (o non oggetto) non deve mai
 * abbattere il bridge. `null` = messaggio da ignorare.
 */
export function parseDiscoveryPayload(payload: string): HaDiscoveryConfig | null {
  if (!payload.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return null;
    return expandShortKeys(parsed) as HaDiscoveryConfig;
  } catch {
    return null;
  }
}
