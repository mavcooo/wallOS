import { useCallback, useEffect, useMemo, useState } from 'react';

import { useMqttApi } from '@/mqtt/MqttProvider';
import { isValidTopicFilter, SNIFFER_FILTERS } from '@/mqtt/sniffer';
import { useHomeStore } from '@/store/homeStore';
import type { RawMqttMessage } from '@/types/mqtt';

const MAX_CAPTURED = 40;

export interface MqttSniffer {
  active: boolean;
  filters: readonly string[];
  messages: readonly RawMqttMessage[];
  start(): void;
  stop(): void;
  toggle(): void;
  clear(): void;
  addFilter(filter: string): boolean;
  removeFilter(filter: string): void;
}

/**
 * Cattura i messaggi in arrivo durante l'aggiunta guidata di un device.
 *
 * Le sottoscrizioni wildcard sono temporanee (`subscribeSniffer`): alla
 * chiusura del dialog vengono annullate dal client MQTT, senza toccare i topic
 * dichiarati nella topologia. I messaggi arrivano dal raw log già alimentato
 * dal pipeline, quindi lo sniffer non duplica il parsing.
 */
export function useMqttSniffer(): MqttSniffer {
  const { subscribeSniffer } = useMqttApi();
  const rawLog = useHomeStore((state) => state.rawLog);
  const baseTopic = useHomeStore((state) => state.broker.baseTopic);
  const [active, setActive] = useState(false);
  const [filters, setFilters] = useState<readonly string[]>([...SNIFFER_FILTERS]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const filterKey = filters.join('|');

  useEffect(() => {
    if (!active) return;
    return subscribeSniffer(filters);
  }, [active, baseTopic, filterKey, filters, subscribeSniffer]);

  const start = useCallback(() => {
    setStartedAt(Date.now());
    setActive(true);
  }, []);

  const stop = useCallback(() => {
    setActive(false);
    setStartedAt(null);
  }, []);

  const toggle = useCallback(() => {
    setActive((current) => {
      if (!current) setStartedAt(Date.now());
      else setStartedAt(null);
      return !current;
    });
  }, []);

  const clear = useCallback(() => setStartedAt(Date.now()), []);

  const addFilter = useCallback((filter: string) => {
    const value = filter.trim();
    if (!isValidTopicFilter(value)) return false;
    setFilters((current) => (current.includes(value) ? current : [...current, value]));
    return true;
  }, []);

  const removeFilter = useCallback((filter: string) => {
    setFilters((current) => current.filter((candidate) => candidate !== filter));
  }, []);

  const messages = useMemo(() => {
    if (startedAt === null) return [] as RawMqttMessage[];
    return rawLog
      .filter((entry) => entry.direction === 'in' && entry.at >= startedAt)
      .slice(0, MAX_CAPTURED);
  }, [rawLog, startedAt]);

  return { active, filters, messages, start, stop, toggle, clear, addFilter, removeFilter };
}
