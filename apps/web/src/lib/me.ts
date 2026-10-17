'use client';

import { create } from 'zustand';
import { api } from './api';

export interface ServerLimits {
  max_upload_bytes: number;
  max_video_seconds: number;
}

/** The local user's settings. There is no login: the app always acts as this one user. */
export interface Me {
  id: string;
  locale: 'da' | 'en';
  units: 'm' | 'yd';
  onboardingDone: boolean;
  /** A video's GPS may be looked up on OpenStreetMap on its own (Settings → Privacy). */
  geoLookup?: boolean;
  /** False when GEO_LOOKUP=0 on the server: the setting can't be turned on. */
  geoLookupAllowed?: boolean;
  /** Upload safety limits of this server. */
  limits: ServerLimits;
  createdAt: string;
}

interface MeState {
  me: Me | null;
  loaded: boolean;
  load: () => Promise<Me | null>;
  set: (me: Me) => void;
  patch: (p: Partial<Me>) => void;
}

export const useMe = create<MeState>((set, get) => ({
  me: null,
  loaded: false,
  load: async () => {
    try {
      const r = await api<{ user: Me }>('/account');
      set({ me: r.user, loaded: true });
      return r.user;
    } catch {
      set({ loaded: true });
      return get().me;
    }
  },
  set: (me) => set({ me, loaded: true }),
  patch: (p) => set((s) => (s.me ? { me: { ...s.me, ...p } } : s)),
}));
