/**
 * Payload MQTT realistici, uno per firmware.
 *
 * Sono stringhe così come arrivano dal broker (non oggetti già parsati): i test
 * degli adapter devono esercitare il parsing vero, compresi JSON malformati,
 * payload vuoti e numeri serializzati come stringa.
 */

/** Zigbee2MQTT: stato, sensori e meter di un plug. */
export const ZIGBEE2MQTT_PAYLOADS = {
  /** Luce accesa al massimo, temperatura colore in mired. */
  lightOn: '{"state":"ON","brightness":254,"color_temp":300,"linkquality":190}',
  lightOff: '{"state":"OFF","brightness":0}',
  /** Numeri come stringhe: alcuni firmware/coordinator li serializzano così. */
  lightNumericStrings: '{"state":"ON","brightness":"254","color_temp":"300"}',
  /** Sensore ambientale completo: linkquality e battery non fanno parte del modello. */
  sensorClimate:
    '{"temperature":21.4,"humidity":48,"battery":92,"linkquality":120,"voltage":3000}',
  plugMetering:
    '{"state":"ON","power":12.5,"voltage":230,"current":0.05,"energy_today":0.4,"energy":12.3}',
  thermostat:
    '{"system_mode":"heat","occupied_heating_setpoint":21.5,"local_temperature":19.8,"humidity":55,"fan_mode":"low","swing_mode":"on","running_state":"heat"}',
  contactClosed: '{"contact":true,"battery":100,"linkquality":80}',
  invalidJson: '{"state":',
  empty: '',
} as const;

/** Shelly Gen2 (Plus/Pro): status dei canali e telemetria `aenergy`. */
export const SHELLY_PAYLOADS = {
  switchOn: '{"id":0,"output":true,"source":"WS_in","apower":1180,"voltage":231,"current":5.1,"aenergy":{"total":843700}}',
  switchOff: '{"id":0,"output":false,"apower":0,"voltage":230,"current":0}',
  lightOn: '{"id":1,"output":true,"brightness":72,"source":"MQTT"}',
  /** Gen1 (Shelly 1PM / Plug S stock): `ison`/`power`, dialetto non gestito. */
  gen1Relay: '{"ison":true,"power":20.4,"voltage":230,"total":1234.5}',
  /** Payload RPC di risposta a Switch.Set. */
  rpcResult: '{"id":1,"src":"domus-kiosk","dst":"shellyplus1pm-abc123","result":{"was_on":false}}',
  /** Telemetria senza i campi opzionali (link, uptime). */
  minimalPower: '{"output":true}',
  invalidJson: 'not-json',
  empty: '',
} as const;

/** Tasmota: POWER in chiaro, tele/STATE, tele/SENSOR, stat/RESULT. */
export const TASMOTA_PAYLOADS = {
  powerOn: 'ON',
  powerOff: 'OFF',
  /** tele/STATE di una presa con meter. */
  state: '{"Time":"2026-10-23T08:00:00","Uptime":"1T02:00:00","POWER":"ON","Wifi":{"AP":1,"RSSI":82}}',
  /** stat/RESULT dopo un comando POWER. */
  result: '{"POWER":"ON"}',
  /** tele/SENSOR di una presa con ENERGY. */
  sensorEnergy:
    '{"Time":"2026-10-23T08:00:00","ENERGY":{"TotalStartTime":"2026-01-01T00:00:00","Total":412.1,"Yesterday":0.3,"Today":0.36,"Power":1180,"Voltage":231,"Current":5.1}}',
  /** Canali multipli: POWER assente, solo POWER1/POWER2. */
  multiPower: '{"POWER1":"ON","POWER2":"OFF"}',
  /** tele/SENSOR di un sensore di temperatura con ANALOG. */
  sensorAnalog: '{"Time":"2026-10-23T08:00:00","ANALOG":{"Temperature":21.4}}',
  /** stat/RESULT di una plafoniera dimmerabile. */
  dimmerResult: '{"POWER":"ON","Dimmer":80,"CT":300}',
  invalidJson: '{"POWER":',
  empty: '',
} as const;
