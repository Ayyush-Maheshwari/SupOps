import { create } from 'zustand';
import { getToken, setToken } from './api';

interface User {
  id: string;
  email: string;
  name: string;
  globalRole: string;
}

interface AppState {
  user: User | null;
  token: string | null;
  /** The active project. Everything in the UI is scoped to it. */
  projectId: string | null;
  sidebarCollapsed: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => void;
  setUser: (user: User | null) => void;
  setProjectId: (id: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean, remember?: boolean) => void;
  toggleSidebar: () => void;
}

const PROJECT_KEY = 'supops.projectId';
const SIDEBAR_KEY = 'supops.sidebarCollapsed';

/**
 * Below this width the sidebar starts retracted regardless of the stored
 * preference -- a 240px rail on a phone leaves almost nothing for the content.
 */
export const SIDEBAR_BREAKPOINT = 1024;

const readProject = (): string | null => {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
};

const readCollapsed = (): boolean => {
  if (typeof window !== 'undefined' && window.innerWidth < SIDEBAR_BREAKPOINT) return true;
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
};

export const useApp = create<AppState>((set) => ({
  user: null,
  token: getToken(),
  projectId: readProject(),
  sidebarCollapsed: readCollapsed(),
  signIn: (token, user) => {
    setToken(token);
    set({ token, user });
  },
  signOut: () => {
    setToken(null);
    set({ token: null, user: null });
  },
  setUser: (user) => set({ user }),
  /**
   * `remember: false` is used by the responsive watcher, so being forced shut on a
   * narrow window never overwrites what the user chose on a wide one.
   */
  setSidebarCollapsed: (collapsed, remember = true) => {
    if (remember) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () => {
    const next = !useApp.getState().sidebarCollapsed;
    useApp.getState().setSidebarCollapsed(next);
  },
  setProjectId: (id) => {
    try {
      if (id) localStorage.setItem(PROJECT_KEY, id);
      else localStorage.removeItem(PROJECT_KEY);
    } catch {
      /* ignore */
    }
    set({ projectId: id });
  },
}));
