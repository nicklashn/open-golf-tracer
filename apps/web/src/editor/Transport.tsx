'use client';

import { ChevronFirst, ChevronLast, Pause, Play, StepBack, StepForward } from 'lucide-react';
import { clipAt, timelineDuration } from '@golf/schema';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { timecode } from '@/lib/format';
import { useI18n } from '@/lib/i18n/client';
import { fpsOf } from './ops';
import { useEditor } from './store';

export function frameStep(dir: 1 | -1, frames = 1) {
  const s = useEditor.getState();
  s.setPlaying(false);
  const hit = clipAt(s.doc.clips, s.time);
  const fps = hit ? fpsOf(hit.clip.mediaId) : 30;
  const speed = hit && hit.clip.kind === 'video' ? hit.clip.speed : 1;
  s.setTime(s.time + (dir * frames) / fps / speed);
}

/** The running timecode: the only part of the transport that changes on every playhead tick. */
function Timecode() {
  const label = useEditor((s) => {
    const hit = clipAt(s.doc.clips, s.time);
    const fps = hit ? fpsOf(hit.clip.mediaId) : 30;
    return `${timecode(s.time, fps, true)}|${timecode(timelineDuration(s.doc), fps, true)}`;
  });
  const [now, total] = label.split('|');
  return (
    <div className="tabular w-36 text-[13px] text-fg">
      {now} <span className="text-fg-subtle">/ {total}</span>
    </div>
  );
}

export function Transport() {
  const { t } = useI18n();
  const playing = useEditor((s) => s.playing);
  const total = useEditor((s) => timelineDuration(s.doc));
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);
  const set = useEditor.getState();

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border px-3">
      <Timecode />
      <div className="flex flex-1 items-center justify-center gap-0.5">
        <Tooltip label={t.shortcuts.items.inOut} shortcut="Home">
          <Button variant="ghost" size="iconSm" aria-label="Start" onClick={() => set.setTime(inPoint ?? 0)}>
            <ChevronFirst />
          </Button>
        </Tooltip>
        <Tooltip label={t.tracer.prevFrame} shortcut="←">
          <Button variant="ghost" size="iconSm" aria-label={t.tracer.prevFrame} onClick={() => frameStep(-1)}>
            <StepBack />
          </Button>
        </Tooltip>
        <Tooltip label={t.timeline.playPause} shortcut="Space">
          <Button variant="ghost" size="icon" aria-label={t.timeline.playPause} onClick={() => set.setPlaying(!playing)} data-testid="play">
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
        </Tooltip>
        <Tooltip label={t.tracer.nextFrame} shortcut="→">
          <Button variant="ghost" size="iconSm" aria-label={t.tracer.nextFrame} onClick={() => frameStep(1)}>
            <StepForward />
          </Button>
        </Tooltip>
        <Tooltip label="End" shortcut="End">
          <Button variant="ghost" size="iconSm" aria-label="End" onClick={() => set.setTime(outPoint ?? total)}>
            <ChevronLast />
          </Button>
        </Tooltip>
      </div>
      <div className="tabular w-36 text-right text-[12px] text-fg-subtle">
        {inPoint != null || outPoint != null ? `I ${timecode(inPoint ?? 0)} · O ${timecode(outPoint ?? total)}` : ''}
      </div>
    </div>
  );
}
