'use client';

/**
 * Editor state. Every change to the project document goes through `edit()`, which records
 * what changed (history.ts: list items by id, so server merges in between cannot shift an undo
 * onto another shot or clip) – the command pattern behind undo/redo. Rapid edits with the same
 * key (dragging a slider or a handle) are merged into one undo step.
 */
import { produce, type Draft } from 'immer';
import { useMemo } from 'react';
import { create } from 'zustand';
import { LIMITS, timelineDuration, type Project } from '@golf/schema';
import { applyOps, diff, type Op } from './history';

export interface ThumbsInfo {
  count: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  interval: number;
}

export interface MediaInfo {
  id: string;
  kind: 'video' | 'audio' | 'image';
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  hdr: boolean;
  hasAudio: boolean;
  geo?: { lat: number; lon: number; acc?: number } | null;
  recordedAt?: string | null;
  recordedAtSource?: 'metadata' | 'filename' | 'file' | null;
  status: string;
  urls: Partial<Record<'original' | 'proxy' | 'poster' | 'thumbs' | 'thumbs_meta' | 'waveform', string>>;
  thumbs?: ThumbsInfo | null;
}

/**
 * What is selected. One kind at a time; layers and clips can be several (shift/ctrl-click).
 * For clips, `id` is the one last clicked (shown in the inspector) and `ids` all of them.
 */
export type Selection =
  { kind: 'shot'; id: string } | { kind: 'layer'; ids: string[] } | { kind: 'clip'; id: string; ids?: string[] } | { kind: 'audio'; id: string } | null;

/** The selected clips (several with shift/ctrl-click). */
export function selectedClipIds(s: Selection): string[] {
  return s?.kind === 'clip' ? (s.ids?.length ? s.ids : [s.id]) : [];
}

/** drawPath: three clicks on the video (start, apex, landing) replace the selected shot's flight. */
export type Tool = 'select' | 'addPoint' | 'addShot' | 'reframe' | 'drawPath';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** Why the last save failed: shown in the save badge with what to do about it. */
export interface SaveError {
  /** invalid/too_large/unknown_media wait for the next edit; network/server are retried. */
  reason: 'invalid' | 'too_large' | 'unknown_media' | 'network' | 'server';
  message: string;
  /** invalid: the field the server rejected ("shots/3/params"). */
  path?: string;
}

/** A project cap an edit would break (LIMITS in packages/schema); the edit is not applied. */
export interface LimitHit {
  what: 'shots' | 'layers' | 'keyframes' | 'clips';
  max: number;
}

/** The first cap `next` breaks that `prev` did not. */
export function limitHit(prev: Project, next: Project): LimitHit | null {
  if (next.shots.length > LIMITS.shots && next.shots.length > prev.shots.length) return { what: 'shots', max: LIMITS.shots };
  if (next.layers.length > LIMITS.layers && next.layers.length > prev.layers.length) return { what: 'layers', max: LIMITS.layers };
  if (next.clips.length > LIMITS.clips && next.clips.length > prev.clips.length) return { what: 'clips', max: LIMITS.clips };
  if (next.layers !== prev.layers) {
    const before = new Map(prev.layers.map((l) => [l.id, l.keyframes.length]));
    for (const l of next.layers)
      if (l.keyframes.length > LIMITS.keyframes && l.keyframes.length > (before.get(l.id) ?? 0)) return { what: 'keyframes', max: LIMITS.keyframes };
  }
  return null;
}

let onLimit: ((hit: LimitHit) => void) | null = null;
/** Who tells the user an edit was blocked by a cap (the editor shows a toast). */
export function onLimitHit(fn: ((hit: LimitHit) => void) | null): void {
  onLimit = fn;
}

interface HistoryEntry {
  label: string;
  forward: Op[];
  inverse: Op[];
  key?: string;
  at: number;
}

export interface AnalysisState {
  running: boolean;
  progress: number;
  message: string;
  mediaId: string | null;
}

export interface EditorState {
  projectId: string;
  doc: Project;
  docVersion: number;
  media: Record<string, MediaInfo>;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: Selection;
  tool: Tool;
  time: number;
  playing: boolean;
  inPoint: number | null;
  outPoint: number | null;
  zoom: number;
  snapping: boolean;
  saveState: SaveState;
  saveError: SaveError | null;
  /** Params shown while a handle is dragged, before the drag is committed. */
  live: Record<string, number[]>;
  analysis: AnalysisState;
  /** The "Make video" dialog (opened from the header, the shots panel and the analysis toast). */
  makeOpen: boolean;
  retracking: Record<string, string>;
  ingesting: Record<string, number>;
  revision: number;

  init: (p: { projectId: string; doc: Project; docVersion: number; media: MediaInfo[] }) => void;
  /** Returns false when the edit was blocked by a project cap (the user is told why). */
  edit: (label: string, recipe: (d: Draft<Project>) => void, opts?: { key?: string; select?: Selection }) => boolean;
  /** Replace the document without history (server merges, e.g. new shots from analysis). */
  silently: (recipe: (d: Draft<Project>) => void) => void;
  /** The saved document from the server replaces this one (another tab saved, a version was
   *  restored): history goes, the playhead and selection stay where they still exist. */
  adopt: (p: { doc: Project; docVersion: number; media?: MediaInfo[] }) => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  setTool: (t: Tool) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setLive: (shotId: string, params: number[] | null) => void;
  setMedia: (m: MediaInfo) => void;
  set: (p: Partial<EditorState>) => void;
}

const MERGE_MS = 900;
const MAX_HISTORY = 300;

export const useEditor = create<EditorState>((set, get) => ({
  projectId: '',
  doc: null as unknown as Project,
  docVersion: 0,
  media: {},
  past: [],
  future: [],
  selection: null,
  tool: 'select',
  time: 0,
  playing: false,
  inPoint: null,
  outPoint: null,
  zoom: 80,
  snapping: true,
  saveState: 'saved',
  saveError: null,
  live: {},
  analysis: { running: false, progress: 0, message: '', mediaId: null },
  makeOpen: false,
  retracking: {},
  ingesting: {},
  revision: 0,

  init: ({ projectId, doc, docVersion, media }) =>
    set({
      projectId,
      doc,
      docVersion,
      media: Object.fromEntries(media.map((m) => [m.id, m])),
      past: [],
      future: [],
      selection: null,
      time: 0,
      playing: false,
      saveState: 'saved',
      saveError: null,
      live: {},
      revision: 0,
      inPoint: null,
      outPoint: null,
    }),

  edit: (label, recipe, opts = {}) => {
    const { doc, past } = get();
    const next = produce(doc, recipe);
    const { forward, inverse } = next === doc ? { forward: [], inverse: [] } : diff(doc, next);
    if (!forward.length) {
      if (opts.select !== undefined) set({ selection: opts.select });
      return true;
    }
    const hit = limitHit(doc, next);
    if (hit) {
      onLimit?.(hit);
      return false;
    }
    const now = Date.now();
    const last = past[past.length - 1];
    let newPast: HistoryEntry[];
    if (opts.key && last && last.key === opts.key && now - last.at < MERGE_MS) {
      newPast = [...past.slice(0, -1), { ...last, forward: [...last.forward, ...forward], inverse: [...inverse, ...last.inverse], at: now }];
    } else {
      newPast = [...past, { label, forward, inverse, key: opts.key, at: now }].slice(-MAX_HISTORY);
    }
    set((s) => ({
      doc: next,
      past: newPast,
      future: [],
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      revision: s.revision + 1,
      ...(opts.select !== undefined ? { selection: opts.select } : {}),
    }));
    return true;
  },

  silently: (recipe) => {
    const doc = get().doc;
    const next = produce(doc, recipe);
    if (next !== doc) set((s) => ({ doc: next, revision: s.revision + 1, saveState: s.saveState === 'saved' ? 'dirty' : s.saveState }));
  },

  adopt: ({ doc, docVersion, media }) => {
    set((s) => ({
      doc,
      docVersion,
      ...(media ? { media: { ...s.media, ...Object.fromEntries(media.map((m) => [m.id, m])) } } : {}),
      past: [],
      future: [],
      saveState: 'saved',
      saveError: null,
      live: {},
      revision: s.revision + 1,
      time: Math.min(s.time, Math.max(0, timelineDuration(doc))),
    }));
    fixSelection();
  },

  undo: () => {
    const { past, doc, future } = get();
    const e = past[past.length - 1];
    if (!e) return;
    set((s) => ({
      doc: applyOps(doc, e.inverse),
      past: past.slice(0, -1),
      future: [...future, { ...e, key: undefined }],
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      revision: s.revision + 1,
      live: {},
    }));
    fixSelection();
  },

  redo: () => {
    const { past, doc, future } = get();
    const e = future[future.length - 1];
    if (!e) return;
    set((s) => ({
      doc: applyOps(doc, e.forward),
      future: future.slice(0, -1),
      past: [...past, e],
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      revision: s.revision + 1,
      live: {},
    }));
    fixSelection();
  },

  select: (selection) => set({ selection }),
  setTool: (tool) => set({ tool }),
  setTime: (t) => {
    const d = timelineDuration(get().doc);
    set({ time: Math.min(Math.max(0, t), Math.max(0, d)) });
  },
  setPlaying: (playing) => set({ playing }),
  setLive: (shotId, params) =>
    set((s) => {
      const live = { ...s.live };
      if (params) live[shotId] = params;
      else delete live[shotId];
      return { live };
    }),
  setMedia: (m) => set((s) => ({ media: { ...s.media, [m.id]: m } })),
  set: (p) => set(p),
}));

/** Drop a selection that no longer exists after undo/redo. */
function fixSelection() {
  const { selection, doc } = useEditor.getState();
  if (!selection) return;
  const exists =
    selection.kind === 'shot'
      ? doc.shots.some((s) => s.id === selection.id)
      : selection.kind === 'layer'
        ? selection.ids.some((id) => doc.layers.some((l) => l.id === id))
        : selection.kind === 'clip'
          ? doc.clips.some((c) => c.id === selection.id)
          : doc.audioTracks.some((a) => a.id === selection.id);
  if (!exists) useEditor.setState({ selection: null });
  else if (selection.kind === 'clip' && selection.ids) {
    const ids = selection.ids.filter((id) => doc.clips.some((c) => c.id === id));
    if (ids.length !== selection.ids.length) useEditor.setState({ selection: { ...selection, ids } });
  }
}

/** The document with live drag params applied (what the preview draws). */
export function useLiveDoc(): Project {
  const doc = useEditor((s) => s.doc);
  const live = useEditor((s) => s.live);
  return useMemo(
    () => (Object.keys(live).length ? { ...doc, shots: doc.shots.map((s) => (live[s.id] ? { ...s, params: live[s.id] } : s)) } : doc),
    [doc, live],
  );
}

export const editor = () => useEditor.getState();
