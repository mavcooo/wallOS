import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClimateCard } from '@/components/widgets/ClimateCard';
import i18n from '@/i18n';
import { deviceOf } from '@/test/fixtures';

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await i18n.changeLanguage('it');
});

describe('ClimateCard · inglese', () => {
  it('traduce modalità, stato, umidità e controlli', () => {
    render(
      <ClimateCard
        device={deviceOf('climate-living', 'climate')}
        roomName="Soggiorno"
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/Humidity 47%/)).toBeInTheDocument();
    expect(screen.getByText('Heating')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Heat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise setpoint' })).toBeInTheDocument();
    expect(screen.getByText('Fan')).toBeInTheDocument();
    expect(screen.getByText('Oscillation')).toBeInTheDocument();
  });
});
