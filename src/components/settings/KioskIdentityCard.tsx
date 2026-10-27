import { Fingerprint, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { useKioskQuery, useUpdateKiosk } from '@/hooks/useKioskProfile';
import { useToastStore } from '@/store/toastStore';
import { getKioskId, sanitizeKioskId, setKioskId } from '@/utils/kioskIdentity';

/**
 * Identità e nome di **questo** pannello.
 *
 * Il `kiosk_id` è l'àncora della configurazione centralizzata: il tablet lo
 * conserva in localStorage + cookie decennale e lo usa per idratarsi
 * (`GET /api/kiosk/:id`) e per ascoltare le modifiche dell'amministratore.
 * Qui si può correggerlo (`tablet_ingresso`, `pannello_cucina`) o dare un nome
 * leggibile che compare nella griglia di Admin → Display.
 */
export function KioskIdentityCard() {
  const { t } = useTranslation('settings');
  const [id, setId] = useState(getKioskId);
  const { data: display, isPending } = useKioskQuery(id);
  const update = useUpdateKiosk();
  const pushToast = useToastStore((state) => state.push);

  const [name, setName] = useState('');
  const [idDraft, setIdDraft] = useState(id);
  const [idError, setIdError] = useState<string | null>(null);

  useEffect(() => {
    if (display) setName(display.name);
  }, [display?.updatedAt, display?.name]);

  const saveName = () => {
    if (!display) return;
    update.mutate(
      { id, patch: { name: name.trim() } },
      {
        onSuccess: () =>
          pushToast({ title: t('display.saved'), tone: 'success' }),
        onError: (cause) =>
          pushToast({
            title: t('display.saveError'),
            description: cause instanceof Error ? cause.message : undefined,
            tone: 'error',
          }),
      },
    );
  };

  const applyId = () => {
    const next = sanitizeKioskId(idDraft);
    if (!next) {
      setIdError(t('display.invalidId'));
      return;
    }
    setIdError(null);
    const applied = setKioskId(next);
    if (!applied) {
      setIdError(t('display.invalidId'));
      return;
    }
    setId(applied);
    pushToast({
      title: t('display.idApplied'),
      description: t('display.idAppliedHint', { id: applied }),
      tone: 'info',
    });
  };

  return (
    <Card data-testid="kiosk-identity-card">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="size-4 text-accent" /> {t('display.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('display.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Label>{t('display.name')}</Label>
          <div className="mt-1.5 flex gap-2">
            <Input
              value={name}
              maxLength={128}
              disabled={isPending || !display}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('display.namePlaceholder')}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={!display || update.isPending || name.trim().length === 0}
              onClick={saveName}
            >
              <Save className="size-4" /> {t('display.save')}
            </Button>
          </div>
        </div>

        <div>
          <Label>{t('display.id')}</Label>
          <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">{id}</p>
          <div className="mt-1.5 flex gap-2">
            <Input
              value={idDraft}
              maxLength={64}
              onChange={(event) => setIdDraft(event.target.value)}
              aria-invalid={idError !== null}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={applyId}
            >
              {t('display.applyId')}
            </Button>
          </div>
          {idError ? (
            <p role="alert" className="mt-1 text-[10px] text-danger">
              {idError}
            </p>
          ) : (
            <p className="mt-1 text-[10px] leading-relaxed text-fg-subtle">
              {t('display.idHint')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
