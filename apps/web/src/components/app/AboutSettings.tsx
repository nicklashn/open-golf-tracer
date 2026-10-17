'use client';

/**
 * Settings → About: version (root package.json), the PC the app runs on, the data folder, links to
 * the licences and the changelog, "Save diagnostics" (a redacted zip for bug reports) and the
 * opt-out for the daily update check. The update banner itself is UpdateBanner in AppShell.
 */
import { Bug, Download, ExternalLink, FolderOpen, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/misc';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmt } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/client';

const REPO = 'https://github.com/nicklashn/open-golf-tracer';

interface AboutInfo {
  version: string;
  os: string;
  python: string;
  inference: string;
  providers: string[];
  gpus: string[];
  ffmpeg: string;
  dataDir: string;
  notices: boolean;
  canOpenFolder: boolean;
}

export interface UpdateInfo {
  enabled: boolean;
  current: string;
  latest: string | null;
  url: string;
  newer: boolean;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 py-1.5 text-[13px]">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function AboutSettings() {
  const { t } = useI18n();
  const T = t.about;
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    void api<AboutInfo>('/about')
      .then(setInfo)
      .catch(() => undefined);
    void api<UpdateInfo>('/about/update')
      .then(setUpdate)
      .catch(() => undefined);
  }, []);

  if (!info) return <Skeleton className="h-40 w-full" />;

  const openFolder = () => api('/about/open-data-folder', { method: 'POST' }).catch((e) => toast.error(`${T.openFolderFailed} ${errorMessage(e, t)}`));
  const setCheck = (enabled: boolean) =>
    api<UpdateInfo>('/about/update', { method: 'PUT', body: { enabled } })
      .then(setUpdate)
      .catch((e) => toast.error(errorMessage(e, t)));

  return (
    <div className="space-y-6">
      <dl className="divide-y divide-border">
        <Row label={T.version}>
          <span className="font-medium">{info.version}</span>
        </Row>
        <Row label={T.os}>{info.os}</Row>
        <Row label={T.device}>
          {info.inference}
          {info.providers.length ? <span className="text-fg-muted"> ({info.providers.join(', ')})</span> : null}
        </Row>
        <Row label={T.gpu}>{info.gpus.length ? info.gpus.join(', ') : T.none}</Row>
        <Row label={T.ffmpeg}>{info.ffmpeg || T.notFound}</Row>
        <Row label={T.dataFolder}>
          <span className="flex flex-wrap items-center gap-2">
            <code className="break-all text-[12px]">{info.dataDir}</code>
            {info.canOpenFolder ? (
              <Button size="sm" variant="secondary" onClick={() => void openFolder()}>
                <FolderOpen />
                {T.openFolder}
              </Button>
            ) : null}
          </span>
        </Row>
      </dl>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
        <a className="inline-flex items-center gap-1 underline underline-offset-2" href="/api/about/notices" target="_blank" rel="noreferrer">
          {T.notices}
        </a>
        <a className="inline-flex items-center gap-1 underline underline-offset-2" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
          {T.licence}
          <ExternalLink className="size-3" aria-hidden />
        </a>
        <a className="inline-flex items-center gap-1 underline underline-offset-2" href={`${REPO}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer">
          {T.changelog}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>

      <div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <a href="/api/about/diagnostics" download>
              <Download />
              {T.diagnostics}
            </a>
          </Button>
          <Button asChild variant="ghost">
            <a href={`${REPO}/issues/new?template=bug.yml`} target="_blank" rel="noreferrer">
              <Bug />
              {T.reportBug}
            </a>
          </Button>
        </div>
        <p className="mt-2 max-w-prose text-[13px] text-fg-muted">{T.diagnosticsLead}</p>
      </div>

      {update ? (
        <div>
          <label className="flex items-center gap-3 text-[13px] font-medium">
            <Switch checked={update.enabled} onChange={(v) => void setCheck(v)} label={T.updateCheck} />
            {T.updateCheck}
          </label>
          <p className="mt-1 max-w-prose text-[13px] text-fg-muted">{T.updateCheckLead}</p>
          {update.enabled && update.latest ? (
            <p className="mt-2 text-[13px]">
              {update.newer ? (
                <a className="underline underline-offset-2" href={update.url} target="_blank" rel="noreferrer">
                  {fmt(T.updateAvailable, { version: update.latest })} {T.updateLink}
                </a>
              ) : (
                T.upToDate
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const DISMISSED = 'gt_update_dismissed';

/** A slim bar under the header when GitHub has a newer release (checked by the API, once a day). */
export function UpdateBanner() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let dismissed: string | null = null;
    try {
      dismissed = localStorage.getItem(DISMISSED);
    } catch {
      /* storage blocked */
    }
    void api<UpdateInfo>('/about/update')
      .then((u) => setUpdate(u.newer && u.latest !== dismissed ? u : null))
      .catch(() => undefined);
  }, []);

  if (!update?.latest) return null;
  const latest = update.latest;
  return (
    <div role="status" className="border-b border-border bg-surface-sunken">
      <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-1.5 text-[13px] sm:px-6">
        <span>
          {fmt(t.about.updateAvailable, { version: latest })}{' '}
          <a className="font-medium underline underline-offset-2" href={update.url} target="_blank" rel="noreferrer">
            {t.about.updateLink}
          </a>
        </span>
        <button
          type="button"
          className="ml-auto rounded-sm p-1 text-fg-muted hover:text-fg"
          aria-label={t.about.dismiss}
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED, latest);
            } catch {
              /* storage blocked */
            }
            setUpdate(null);
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
