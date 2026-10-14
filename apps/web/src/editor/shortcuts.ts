'use client';

import { useEffect } from 'react';
import { timelineDuration } from '@golf/schema';
import { saveNow } from './autosave';
import * as ops from './ops';
import { useEditor } from './store';
import { frameStep } from './Transport';

/** Editor keyboard shortcuts (J/K/L, space, I/O, S, arrows, undo/redo, …). */
export function useShortcuts({ enabled, onHelp, onExport }: { enabled: boolean; onHelp: () => void; onExport: () => void }) {
  useEffect(() => {
    if (!enabled) return;
    let shuttle = 0; // J/K/L speed
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
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="dialog"]')) return;
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
        useEditor.setState({ zoom: Math.min(800, s.zoom * 1.25) });
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        useEditor.setState({ zoom: Math.max(8, s.zoom / 1.25) });
        return;
      }
      if (mod) return;
      const layerSel = s.selection?.kind === 'layer' ? s.selection.ids : null;
      switch (k) {
        case ' ':
          e.preventDefault();
          stopShuttle();
          s.setPlaying(!s.playing);
          break;
        case 'k':
        case 'K':
          stopShuttle();
          s.setPlaying(false);
          break;
        case 'l':
        case 'L':
          shuttle = shuttle <= 0 ? 1 : Math.min(8, shuttle * 2);
          runShuttle();
          break;
        case 'j':
        case 'J':
          shuttle = shuttle >= 0 ? -1 : Math.max(-8, shuttle * 2);
          runShuttle();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = k === 'ArrowLeft' ? -1 : 1;
          if (layerSel && s.selection?.kind === 'layer') {
            const step = (e.shiftKey ? 10 : 1) / 1000;
            ops.moveLayers(layerSel, s.time, dir * step, 0, 'nudge');
          } else if (e.shiftKey) s.setTime(s.time + dir);
          else frameStep(dir as 1 | -1);
          break;
        }
        case 'ArrowUp':
        case 'ArrowDown':
          if (layerSel) {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) / 1000;
            ops.moveLayers(layerSel, s.time, 0, (k === 'ArrowUp' ? -1 : 1) * step, 'nudge');
          }
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
        case ']': {
          const shots = s.doc.shots.filter((x) => x.visible);
          if (!shots.length) break;
          const cur = s.selection?.kind === 'shot' ? shots.findIndex((x) => x.id === (s.selection as { id: string }).id) : -1;
          const next = shots[(cur + (k === ']' ? 1 : -1) + shots.length) % shots.length];
          ops.jumpToShot(next);
          break;
        }
        case 'Backspace':
        case 'Delete':
          if (s.selection?.kind === 'layer') ops.deleteLayers(s.selection.ids);
          else if (s.selection?.kind === 'clip') ops.deleteClip(s.selection.id);
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
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stopShuttle();
    };
  }, [enabled, onHelp, onExport]);
}
