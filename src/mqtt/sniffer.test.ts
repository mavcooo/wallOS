import { describe, expect, it } from 'vitest';

import {
  isValidDeviceTopic,
  isValidTopicFilter,
  suggestFromTopic,
} from '@/mqtt/sniffer';

describe('sniffer · topic filter', () => {
  it('accetta le wildcard MQTT solo nella posizione corretta', () => {
    expect(isValidTopicFilter('tele/#')).toBe(true);
    expect(isValidTopicFilter('#')).toBe(true);
    expect(isValidTopicFilter('shellies/+/relay/0')).toBe(true);
    expect(isValidTopicFilter('casa/+/stato/+')).toBe(true);

    expect(isValidTopicFilter('tele/#/stato')).toBe(false);
    expect(isValidTopicFilter('tele/stato#')).toBe(false);
    expect(isValidTopicFilter('shellies/+shelly')).toBe(false);
    expect(isValidTopicFilter('')).toBe(false);
    expect(isValidTopicFilter('tele/ stanza')).toBe(false);
  });

  it('rifiuta wildcard nei topic di un device', () => {
    expect(isValidDeviceTopic('zigbee2mqtt/pianta')).toBe(true);
    expect(isValidDeviceTopic('zigbee2mqtt/pianta/set')).toBe(true);
    expect(isValidDeviceTopic('zigbee2mqtt/+/set')).toBe(false);
    expect(isValidDeviceTopic('zigbee2mqtt/#')).toBe(false);
    expect(isValidDeviceTopic('')).toBe(false);
  });
});

describe('sniffer · rilevamento adapter', () => {
  it('riconosce Zigbee2MQTT e deriva il topic di comando', () => {
    expect(suggestFromTopic('zigbee2mqtt/luce_garage')).toMatchObject({
      adapter: 'zigbee2mqtt',
      name: 'Luce Garage',
      stateTopic: 'zigbee2mqtt/luce_garage',
      commandTopic: 'zigbee2mqtt/luce_garage/set',
      availabilityTopic: 'zigbee2mqtt/luce_garage/availability',
    });

    expect(suggestFromTopic('zigbee2mqtt/luce_garage/set')).toMatchObject({
      stateTopic: 'zigbee2mqtt/luce_garage',
      commandTopic: 'zigbee2mqtt/luce_garage/set',
    });
  });

  it('riconosce Tasmota e propone tele/cmnd/LWT', () => {
    expect(suggestFromTopic('stat/presa/RESULT')).toMatchObject({
      adapter: 'tasmota',
      stateTopic: 'tele/presa/STATE',
      commandTopic: 'cmnd/presa/POWER',
      availabilityTopic: 'tele/presa/LWT',
    });

    expect(suggestFromTopic('tele/presa/STATE')).toMatchObject({
      stateTopic: 'tele/presa/STATE',
    });
  });

  it('riconosce Shelly e il canale relè', () => {
    expect(suggestFromTopic('shellies/shelly-1/relay/0')).toMatchObject({
      adapter: 'shelly',
      stateTopic: 'shellies/shelly-1/relay/0',
      commandTopic: 'shellies/shelly-1/relay/0/command',
      availabilityTopic: 'shellies/shelly-1/online',
    });
  });

  it('ricade su custom-json per topic sconosciuti', () => {
    expect(suggestFromTopic('casa/pompa/state')).toMatchObject({
      adapter: 'custom-json',
      stateTopic: 'casa/pompa/state',
      commandTopic: 'casa/pompa/set',
    });
  });
});
