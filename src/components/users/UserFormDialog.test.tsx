import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/hooks/useUsers', () => ({
  useCreateUser: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateUser: () => ({ mutateAsync: mocks.update, isPending: false }),
}));

const { UserFormDialog } = await import('@/components/users/UserFormDialog');
const { useAuthStore } = await import('@/store/authStore');

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue({});
  mocks.update.mockReset().mockResolvedValue({});
  useAuthStore.setState({
    pinPolicy: { minLength: 4, maxLength: 6, maxAttempts: 3, lockoutMs: 60_000 },
    user: null,
  });
});

async function fillCreateForm() {
  await userEvent.type(screen.getByLabelText('Username'), 'giulia');
  await userEvent.type(screen.getByLabelText('PIN iniziale'), '1357');
  await userEvent.type(screen.getByLabelText('Conferma PIN'), '1357');
  await userEvent.type(screen.getByLabelText('Password iniziale'), 'family-pass-123');
}

describe('UserFormDialog', () => {
  it('crea un profilo family con PIN e password', async () => {
    const onOpenChange = vi.fn();
    render(<UserFormDialog open onOpenChange={onOpenChange} />);

    await fillCreateForm();
    await userEvent.click(screen.getByRole('button', { name: 'Crea profilo' }));

    expect(mocks.create).toHaveBeenCalledWith({
      username: 'giulia',
      displayName: 'giulia',
      role: 'family',
      isKioskDevice: false,
      pin: '1357',
      password: 'family-pass-123',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('rifiuta PIN non coincidenti senza chiamare la API', async () => {
    render(<UserFormDialog open onOpenChange={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Username'), 'giulia');
    await userEvent.type(screen.getByLabelText('PIN iniziale'), '1357');
    await userEvent.type(screen.getByLabelText('Conferma PIN'), '2468');
    await userEvent.type(screen.getByLabelText('Password iniziale'), 'family-pass-123');
    await userEvent.click(screen.getByRole('button', { name: 'Crea profilo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('I due PIN non coincidono');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('converte il flag kiosk in ruolo kiosk e rende la password opzionale', async () => {
    render(<UserFormDialog open onOpenChange={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Username'), 'panel-cucina');
    await userEvent.type(screen.getByLabelText('PIN iniziale'), '4321');
    await userEvent.type(screen.getByLabelText('Conferma PIN'), '4321');
    await userEvent.click(screen.getByRole('switch', { name: 'Dispositivo kiosk' }));
    await userEvent.click(screen.getByRole('button', { name: 'Crea profilo' }));

    expect(mocks.create).toHaveBeenCalledWith({
      username: 'panel-cucina',
      displayName: 'panel-cucina',
      role: 'kiosk',
      isKioskDevice: true,
      kioskDeviceId: 'panel-cucina',
      pin: '4321',
    });
  });
});
