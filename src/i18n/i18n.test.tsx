import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useTranslation } from 'react-i18next';

import i18n, { LANGUAGE_STORAGE_KEY, NAMESPACES, resources } from '@/i18n';
import { LanguageSwitcher } from '@/components/settings/LanguageSwitcher';

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function Probe() {
  const { t } = useTranslation();
  return <p>{t('nav.settings')}</p>;
}

afterEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('it');
});

describe('i18n', () => {
  it('italiano e inglese espongono esattamente le stesse chiavi', () => {
    for (const namespace of NAMESPACES) {
      const italian = flatten(resources.it[namespace]).sort();
      const english = flatten(resources.en[namespace]).sort();
      expect(english, `namespace ${namespace}`).toEqual(italian);
    }
  });

  it('ricade sull’italiano quando una chiave manca nella lingua attiva', () => {
    expect(i18n.options.fallbackLng).toContain('it');
  });

  it('cambia lingua a caldo e salva la scelta nel localStorage', async () => {
    render(
      <>
        <Probe />
        <LanguageSwitcher />
      </>,
    );

    expect(screen.getByText('Impostazioni')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Lingua dell’interfaccia' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /English/ }));

    expect(await screen.findByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Interface language' })).toBeInTheDocument();
    expect(i18n.resolvedLanguage).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('le chiavi sono tipizzate: una chiave inesistente non compila', () => {
    const energy = i18n.getFixedT(null, 'energy');
    // @ts-expect-error 'invalidKey' non esiste nel namespace energy
    expect(energy('invalidKey')).toBe('invalidKey');
  });
});
