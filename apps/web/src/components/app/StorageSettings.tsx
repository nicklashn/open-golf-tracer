'use client';

/**
 * Settings → Storage: how much each project takes on disk (originals, previews, exports), the
 * map cache and the free space, with ways to make room. Previews are made again when a project
 * is opened; originals go only with their project.
 */
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';

interface Row {
  id: string;
  name: string;
  updatedAt: string;
  originals: number;
  previews: number;
  proxies: number;
  exports: number;
}

interface Overview {
  projects: Row[];
  mapCache: number;
  temp: number;
  free: number;
  total: number;
}

const LOW = 30e9; // a round with previews takes 15–30 GB

export function StorageSettings() {
  const { t, f, locale } = useI18n();
  const T = t.storage;
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Overview>('/storage')
      .then(setData)
      .catch((e) => toast.error(errorMessage(e, t)));
  }, [t]);
  useEffect(load, [load]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      const r = await api<{ freed: number }>(path, { body: body ?? {} });
      if (r.freed > 0) toast.success(f(T.freed, { size: bytes(r.freed, locale) }));
      else toast.info(T.nothingFreed);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!data) return <Skeleton className="h-40 w-full" />;
  const used = data.projects.reduce((n, r) => n + r.originals + r.previews + r.exports, 0);
  return (
    <div className="space-y-4" data-testid="storage-settings">
      <div>
        <p className="tabular text-sm font-medium">
          {f(T.free, { free: bytes(data.free, locale), total: bytes(data.total, locale) })} · {f(T.used, { size: bytes(used, locale) })}
        </p>
        {data.free < LOW ? <p className="mt-1 text-[13px] text-accent-fg">{f(T.low, { size: bytes(LOW, locale) })}</p> : null}
      </div>
      {data.projects.length === 0 ? (
        <p className="text-[13px] text-fg-muted">{T.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-sunken text-left text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{T.project}</th>
                <th className="px-3 py-2 text-right font-medium">{T.originals}</th>
                <th className="px-3 py-2 text-right font-medium">{T.previews}</th>
                <th className="px-3 py-2 text-right font-medium">{T.exports}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.projects.map((r) => (
                <tr key={r.id}>
                  <td className="max-w-[220px] truncate px-3 py-1.5">{r.name}</td>
                  <td className="tabular px-3 py-1.5 text-right">{bytes(r.originals, locale)}</td>
                  <td className="tabular px-3 py-1.5 text-right">{bytes(r.previews, locale)}</td>
                  <td className="tabular px-3 py-1.5 text-right">{bytes(r.exports, locale)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !r.proxies}
                      onClick={() => void act('/storage/previews/delete', { projectIds: [r.id] })}
                    >
                      {T.deletePreviews}
                    </Button>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      aria-label={`${T.deleteExports}: ${r.name}`}
                      title={T.deleteExports}
                      disabled={busy || !r.exports}
                      onClick={() => {
                        if (confirm(f(T.deleteExportsConfirm, { name: r.name }))) void act('/storage/exports/delete', { projectIds: [r.id] });
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[13px] text-fg-muted">{T.previewsHint}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act('/storage/previews/delete', { olderThanDays: 30 })}>
          {T.oldPreviews}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || !data.mapCache} onClick={() => void act('/storage/map-cache/clear')}>
          {T.clearMapCache}
        </Button>
      </div>
      <p className="tabular text-[13px] text-fg-muted">{f(T.mapCache, { size: bytes(data.mapCache, locale) })}</p>
    </div>
  );
}
