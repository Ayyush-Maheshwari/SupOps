import { create } from 'zustand';

/**
 * Installable-app plumbing: the service worker, the launch splash, and the browser's
 * install prompt. Imported first thing in main.tsx so `beforeinstallprompt` -- which
 * fires once, early -- is never missed.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const isStandalone = (): boolean => {
  try {
    return (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: window-controls-overlay)').matches ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
};

/** iOS never fires an install prompt; installing is Share -> Add to Home Screen. */
const isIOS = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone();

interface InstallState {
  prompt: InstallPromptEvent | null;
  installed: boolean;
}

const useInstallStore = create<InstallState>(() => ({ prompt: null, installed: isStandalone() }));

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own button instead of the mini-infobar
  useInstallStore.setState({ prompt: e as InstallPromptEvent });
});
window.addEventListener('appinstalled', () => useInstallStore.setState({ prompt: null, installed: true }));

/** What the UI needs to offer "Install app": whether it can, and how. */
export function useInstall() {
  const { prompt, installed } = useInstallStore();
  return {
    /** Chromium/Edge: a real one-click install. */
    canPrompt: !installed && !!prompt,
    /** iOS Safari: can only be installed by hand. */
    manualIOS: !installed && !prompt && isIOS(),
    install: async () => {
      if (!prompt) return;
      await prompt.prompt();
      await prompt.userChoice;
      useInstallStore.setState({ prompt: null }); // a prompt can only be used once
    },
  };
}

/**
 * Register the service worker. Production only: in dev it would cache Vite's
 * modules and fight HMR. Needs HTTPS (or localhost) -- browsers refuse otherwise.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* plain-HTTP deployments can't register; the app works the same without it */
    });
  });
}

/** Let the logo intro play at least this long, so it reads as an intro and not a flicker. */
const SPLASH_MIN_MS = 1100;

/** Fade out the launch splash (index.html) once the app has rendered. */
export function dismissSplash(): void {
  const el = document.getElementById('splash');
  if (!el || !document.documentElement.classList.contains('pwa-launch')) return;
  // performance.now() counts from the start of the page load, i.e. when the splash appeared.
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 400);
  }, wait);
}
