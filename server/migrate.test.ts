import { describe, expect, it } from 'vitest';

import { extractUpSection } from './migrate.js';

describe('extractUpSection', () => {
  it('esegue solo la parte UP: il DOWN non deve cancellare lo schema all’avvio', () => {
    const sql = [
      'CREATE TABLE climate_schedules (id uuid);',
      '-- ----------------------------',
      '-- 003_add_climate_schedules.sql - DOWN',
      '-- ----------------------------',
      'DROP TABLE climate_schedules;',
    ].join('\n');

    const up = extractUpSection(sql);
    expect(up).toContain('CREATE TABLE climate_schedules');
    expect(up).not.toContain('DROP TABLE');
    expect(up).not.toContain('DOWN');
  });

  it('lascia intatto un file senza marcatore DOWN', () => {
    const sql = 'CREATE TABLE rooms (id text);';
    expect(extractUpSection(sql)).toBe(sql);
  });
});
