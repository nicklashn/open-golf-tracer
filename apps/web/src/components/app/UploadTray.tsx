'use client';

import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { ProgressBar } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';
import { cancelUpload, useUploads } from '@/lib/upload';

export function UploadTray() {
  const { t, f, locale } = useI18n();
  const items = useUploads((s) => s.items);
  const remove = useUploads((s) => s.remove);
  if (!items.length) return null;
  return (
    <section aria-label={t.upload.section} className="fixed bottom-4 left-4 z-40 w-[360px] max-w-[calc(100vw-32px)] space-y-2" aria-live="polite">
      {items.map((it) => {
        const pct = it.size ? it.sent / it.size : 0;
        const left = it.speed > 0 ? Math.max(0, (it.size - it.sent) / it.speed) : null;
        return (
          <div key={it.key} className="rounded-md border border-border bg-surface-raised p-3 text-sm shadow-md">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {it.status === 'error' ? `${t.upload.failed}: ${it.name}` : it.status === 'done' ? it.name : f(t.upload.uploading, { name: it.name })}
                </p>
                <p className="tabular mt-0.5 text-[12px] text-fg-muted">
                  {it.status === 'waiting'
                    ? t.upload.waiting
                    : it.status === 'preparing'
                      ? t.upload.preparing
                      : it.status === 'validating'
                        ? t.upload.validating
                        : it.status === 'done'
                          ? t.upload.done
                          : it.status === 'error'
                            ? errorMessage(it.error, t)
                            : it.status === 'canceled'
                              ? t.jobs.canceled
                              : `${bytes(it.sent, locale)} / ${bytes(it.size, locale)}${it.speed ? ` · ${f(t.upload.speed, { speed: bytes(it.speed, locale) })}` : ''}${left != null ? ` · ${f(t.upload.remaining, { time: left > 90 ? `${Math.ceil(left / 60)} min` : `${Math.ceil(left)} s` })}` : ''}`}
                </p>
              </div>
              {it.status === 'done' ? (
                <CheckCircle2 className="size-5 text-[var(--color-success)]" aria-hidden />
              ) : it.status === 'error' ? (
                <span className="flex items-center gap-1">
                  <AlertCircle className="size-5 text-accent-fg" aria-hidden />
                  <button type="button" onClick={() => remove(it.key)} aria-label={t.upload.dismiss} className="rounded-sm p-0.5 text-fg-muted hover:text-fg">
                    <X className="size-4" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => cancelUpload(it.key)}
                  aria-label={t.upload.cancel}
                  className="rounded-sm p-0.5 text-fg-muted hover:text-fg"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            {it.status === 'uploading' || it.status === 'preparing' || it.status === 'validating' ? (
              <ProgressBar className="mt-2" value={it.status === 'uploading' ? pct : null} label={it.name} />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
