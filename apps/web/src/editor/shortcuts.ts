'use client';

import { useEffect } from 'react';
import { timelineDuration } from '@golf/schema';
import { saveNow } from './autosave';
import * as ops from './ops';
import { editPoints, stepTo } from './ripple';
import { selectedClipIds, useEditor } from './store';
import { fitTimeline, setZoom } from './Timeline';
import { frameStep } from './Transport';

/** Moves the playhead to the previous/next shot (just before its launch) and selects it. */
export function stepShot(dir: 1 | -1): boolean {
  const s = useEditor.getState();
  const cues = s.doc.shots
    .filter((x) => x.visible)
    .map((x) => ({ x, t: ops.shotLaunchTime(s.doc, x) }))
    .filter((c): c is { x: (typeof s.doc.shots)[number]; t: number } => c.t != null)
    .map((c) => ({ x: c.x, t: Math.max(0, c.t - 0.6) }));
  const to = stepTo(
    cues.map((c) => c.t),
    s.time,
    dir,
  );
  const hit = to == null ? null : cues.find((c) => c.t === to);
  if (!hit) return false;
  ops.jumpToShot(hit.x);
  return true;
}

/** Moves the playhead to the previous/next cut on the main track. */
export function stepCut(dir: 1 | -1): boolean {
  const s = useEditor.getState();
  const to = stepTo(editPoints(s.doc.clips), s.time, dir);
  if (to == null) return false;
  s.setPlaying(false);
  s.setTime(to);
  return true;
}

/**
 * Editor keyboard shortcuts: J/K/L shuttle (K+J/L: one frame), space, ←/→ frames, ↑/↓ cuts,
 * [ ] shots, I/O, S split, Q/W trim to playhead, ⌫ ripple delete, Alt+←/→ move the selection
 * in time, \ fit, undo/redo, … (listed in the shortcuts dialog).
 */
export function useShortcuts({ enabled, onHelp, onExport }: { enabled: boolean; onHelp: () => void; onExport: () => void }) {
  useEffect(() => {
    if (!enabled) return;
    let shuttle = 0; // J/K/L speed
    let kHeld = false; // K held + J/L: one frame
    let shuttleTimer: ReturnType<typeof setInterval> | null = null;
    const stopShuttle = () => {
      shuttle = 0;
      if (shuttleTimer) clearInterval(shuttleTimer);
      shuttleTimer = null;
    };
    const runShuttle = () => {
      if (shuttleTimer) clearInterval(shuttleTimer);
      const s = useEditor.getState();
      if (shuttle === 1) {
        s.setPlaying(true);
        return;
      }
      s.setPlaying(false);
      shuttleTimer = setInterval(() => {
        const st = useEditor.getState();
        st.setTime(st.time + (shuttle * 1) / 30);
      }, 1000 / 30);
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="slider"], [role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="radiogroup"]',
        )
      )
        return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && k.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow(true);
        return;
      }
      if (mod && k.toLowerCase() === 'e') {
        e.preventDefault();
        onExport();
        return;
      }
      if (mod && k.toLowerCase() === 'd' && s.selection?.kind === 'layer') {
        e.preventDefault();
        ops.duplicateLayers(s.selection.ids);
        return;
      }
      if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        setZoom(s.zoom * 1.25);
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        setZoom(s.zoom / 1.25);
        return;
      }
      if (mod && k.toLowerCase() === 'a') {
        e.preventDefault();
        const ids = s.doc.clips.map((c) => c.id);
        if (ids.length) s.select({ kind: 'clip', id: ids[0], ids });
        return;
      }
      if (mod) return;
      const layerSel = s.selection?.kind === 'layer' ? s.selection.ids : null;
      const clipSel = selectedClipIds(s.selection);
      switch (k) {
        case ' ':
          e.preventDefault();
          stopShuttle();
          s.setPlaying(!s.playing);
          break;
        case 'k':
        case 'K':
          kHeld = true;
          stopShuttle();
          s.setPlaying(false);
          break;
        case 'l':
        case 'L':
          if (kHeld) {
            frameStep(1);
            break;
          }
          shuttle = shuttle <= 0 ? 1 : Math.min(8, shuttle * 2);
          runShuttle();
          break;
        case 'j':
        case 'J':
          if (kHeld) {
            frameStep(-1);
            break;
          }
          shuttle = shuttle >= 0 ? -1 : Math.max(-8, shuttle * 2);
          runShuttle();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = k === 'ArrowLeft' ? -1 : 1;
          if (e.altKey) {
            // Alt+arrows: the selection in time – a clip one place earlier/later, layers and music by frames.
            const frames = (e.shiftKey ? 10 : 1) / 30;
            if (clipSel.length === 1) {
              const i = s.doc.clips.findIndex((c) => c.id === clipSel[0]);
              if (i >= 0) ops.moveClip(i, i + dir);
            } else if (layerSel) ops.shiftLayers(layerSel, dir * frames);
            else if (s.selection?.kind === 'audio') {
              const a = s.doc.audioTracks.find((x) => x.id === (s.selection as { id: string }).id);
              if (a) ops.updateMusic(a.id, { start: Math.max(0, a.start + dir * frames) }, 'nudge');
            }
          } else if (layerSel && s.selection?.kind === 'layer') {
            const step = (e.shiftKey ? 10 : 1) / 1000;
            ops.moveLayers(layerSel, s.time, dir * step, 0, 'nudge');
          } else if (e.shiftKey) s.setTime(s.time + dir);
          else frameStep(dir as 1 | -1);
          break;
        }
        case 'ArrowUp':
        case 'ArrowDown':
          e.preventDefault();
          if (layerSel) {
            const step = (e.shiftKey ? 10 : 1) / 1000;
            ops.moveLayers(layerSel, s.time, 0, (k === 'ArrowUp' ? -1 : 1) * step, 'nudge');
          } else stepCut(k === 'ArrowUp' ? -1 : 1);
          break;
        case 'q':
        case 'Q':
          ops.trimToPlayhead('start');
          break;
        case 'w':
        case 'W':
          ops.trimToPlayhead('end');
          break;
        case '\\':
          fitTimeline();
          break;
        case 'z':
        case 'Z':
          if (e.shiftKey) fitTimeline();
          else return;
          break;
        case 'Home':
          s.setTime(0);
          break;
        case 'End':
          s.setTime(timelineDuration(s.doc));
          break;
        case 'i':
        case 'I':
          useEditor.setState({ inPoint: s.time, outPoint: s.outPoint != null && s.outPoint <= s.time ? null : s.outPoint });
          break;
        case 'o':
        case 'O':
          useEditor.setState({ outPoint: s.time, inPoint: s.inPoint != null && s.inPoint >= s.time ? null : s.inPoint });
          break;
        case 'x':
        case 'X':
          useEditor.setState({ inPoint: null, outPoint: null });
          break;
        case 's':
        case 'S':
          ops.splitAt(s.time);
          break;
        case '[':
        case ']':
          stepShot(k === ']' ? 1 : -1);
          break;
        case 'Backspace':
        case 'Delete':
          if (s.selection?.kind === 'layer') ops.deleteLayers(s.selection.ids);
          else if (clipSel.length) ops.deleteClips(clipSel);
          else if (s.selection?.kind === 'shot') ops.deleteShot(s.selection.id);
          else if (s.selection?.kind === 'audio') ops.removeMusic(s.selection.id);
          break;
        case 'Escape':
          s.setTool('select');
          s.select(null);
          break;
        case '?':
          onHelp();
          break;
        default:
          return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'k' || e.key === 'K') kHeld = false;
    };
    const onBlur = () => (kHeld = false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      stopShuttle();
    };
  }, [enabled, onHelp, onExport]);
}
