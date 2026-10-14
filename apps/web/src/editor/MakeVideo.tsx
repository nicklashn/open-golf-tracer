'use client';

import { Clapperboard, Loader2, MonitorPlay, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n/client';
import { cn } from '@/lib/cn';
import { makeVideo, playedShots, type VideoKind } from './generate';
import { makeShorts } from './shorts';
import { useEditor } from './store';

/**
 * "Make a video": one click from analysed clips to a finished edit – a YouTube video of the
 * round, one highlight short of every shot, or a short per shot. Each opens as its own project,
 * ready to export.
 */
export function MakeVideoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, f, locale } = useI18n();
  const T = t.make;
  const router = useRouter();
  const doc = useEditor((s) => s.doc);
  const [busy, setBusy] = useState<VideoKind | 'shorts' | null>(null);
  const shots = playedShots(doc);
  const holes = new Set(shots.map((s) => doc.media[s.mediaId]?.place?.hole).filter(Boolean)).size;
  const clips = new Set(shots.map((s) => s.mediaId)).size;

  async function run(kind: VideoKind | 'shorts') {
    setBusy(kind);
    try {
      if (kind === 'shorts') {
        const n = await makeShorts((i) => `${doc.name} – Short ${i}`, locale);
        toast.success(f(t.timeline.autoShortsDone, { n }));
        router.push('/app');
        return;
      }
      const id = await makeVideo(kind, `${doc.name} – ${kind === 'youtube' ? 'YouTube' : 'Highlights'}`, locale, t.layers.types);
      toast.success(T.ready, T.readyHint);
      onOpenChange(false);
      router.push(`/app/projects/${id}`);
    } catch (e) {
      toast.error(T.failed, errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }

  const summary = shots.length
    ? [f(T.shots, { n: shots.length }), clips > 1 ? f(T.clips, { n: clips }) : '', holes ? f(T.holes, { n: holes }) : ''].filter(Boolean).join(' · ')
    : T.noShots;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={T.title} description={summary} wide className="max-w-3xl">
        <div className="grid gap-3 sm:grid-cols-3" data-testid="make-video">
          <Choice
            icon={<MonitorPlay className="size-7" />}
            title={T.youtube}
            text={T.youtubeHint}
            busy={busy === 'youtube'}
            disabled={!shots.length || !!busy}
            onClick={() => void run('youtube')}
            primary
          />
          <Choice
            icon={<Smartphone className="size-7" />}
            title={T.highlight}
            text={T.highlightHint}
            busy={busy === 'highlight'}
            disabled={!shots.length || !!busy}
            onClick={() => void run('highlight')}
          />
          <Choice
            icon={<Clapperboard className="size-7" />}
            title={T.perShot}
            text={T.perShotHint}
            busy={busy === 'shorts'}
            disabled={!shots.length || !!busy}
            onClick={() => void run('shorts')}
          />
        </div>
        <p className="mt-4 text-[12px] text-fg-muted">{T.footer}</p>
      </DialogContent>
    </Dialog>
  );
}

function Choice(p: { icon: ReactNode; title: string; text: string; busy: boolean; disabled: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={p.disabled}
      onClick={p.onClick}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface p-4 text-left transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60',
        p.primary ? 'border-2 border-accent' : 'border-border',
      )}
    >
      <span className={cn(p.primary ? 'text-accent-fg' : 'text-fg-muted')}>{p.busy ? <Loader2 className="size-7 animate-spin" /> : p.icon}</span>
      <span className="font-semibold">{p.title}</span>
      <span className="text-[13px] text-fg-muted">{p.text}</span>
    </button>
  );
}
