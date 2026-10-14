'use client';

/**
 * Editor state. Every change to the project document goes through `edit()`, which records
 * immer patches – the command pattern behind undo/redo. Rapid edits with the same key
 * (dragging a slider or a handle) are merged into one undo step.
 */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import { timelineDuration, type Project } from '@golf/schema';

enablePatches();

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
  status: string;
  urls: Partial<Record<'original' | 'proxy' | 'poster' | 'thumbs' | 'thumbs_meta' | 'waveform', string>>;
  thumbs?: ThumbsInfo | null;
}

export type Selection = { kind: 'shot'; id: string } | { kind: 'layer'; ids: string[] } | { kind: 'clip'; id: string } | { kind: 'audio'; id: string } | null;

export type Tool = 'select' | 'addPoint' | 'addShot' | 'reframe';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
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
  /** Params shown while a handle is dragged, before the drag is committed. */
  live: Record<string, number[]>;
  analysis: AnalysisState;
  /** The "Make video" dialog (opened from the header, the shots panel and the analysis toast). */
  makeOpen: boolean;
  retracking: Record<string, string>;
  ingesting: Record<string, number>;
  revision: number;

  init: (p: { projectId: string; doc: Project; docVersion: number; media: MediaInfo[] }) => void;
  edit: (label: string, recipe: (d: Draft<Project>) => void, opts?: { key?: string; select?: Selection }) => void;
  /** Replace the document without history (server merges, e.g. new shots from analysis). */
  silently: (recipe: (d: Draft<Project>) => void) => void;
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
      live: {},
      revision: 0,
      inPoint: null,
      outPoint: null,
    }),

  edit: (label, recipe, opts = {}) => {
    const { doc, past } = get();
    const [next, patches, inverse] = produceWithPatches(doc, recipe);
    if (!patches.length) {
      if (opts.select !== undefined) set({ selection: opts.select });
      return;
    }
    const now = Date.now();
    const last = past[past.length - 1];
    let newPast: HistoryEntry[];
    if (opts.key && last && last.key === opts.key && now - last.at < MERGE_MS) {
      newPast = [...past.slice(0, -1), { ...last, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], at: now }];
    } else {
      newPast = [...past, { label, patches, inverse, key: opts.key, at: now }].slice(-MAX_HISTORY);
    }
    set((s) => ({
      doc: next,
      past: newPast,
      future: [],
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      revision: s.revision + 1,
      ...(opts.select !== undefined ? { selection: opts.select } : {}),
    }));
  },

  silently: (recipe) => {
    const [next, patches] = produceWithPatches(get().doc, recipe);
    if (patches.length) set((s) => ({ doc: next, revision: s.revision + 1, saveState: s.saveState === 'saved' ? 'dirty' : s.saveState }));
  },

  undo: () => {
    const { past, doc, future } = get();
    const e = past[past.length - 1];
    if (!e) return;
    set((s) => ({
      doc: applyPatches(doc, e.inverse),
      past: past.slice(0, -1),
      future: [...future, { ...e, key: undefined }],
      saveState: 'dirty',
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
      doc: applyPatches(doc, e.patches),
      future: future.slice(0, -1),
      past: [...past, e],
      saveState: 'dirty',
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
}

/** The document with live drag params applied (what the preview draws). */
export function useLiveDoc(): Project {
  const doc = useEditor((s) => s.doc);
  const live = useEditor((s) => s.live);
  if (!Object.keys(live).length) return doc;
  return { ...doc, shots: doc.shots.map((s) => (live[s.id] ? { ...s, params: live[s.id] } : s)) };
}

export const editor = () => useEditor.getState();
