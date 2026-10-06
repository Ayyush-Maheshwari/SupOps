import { createLucideIcon } from 'lucide-react';

/**
 * Observability: a heartbeat line seen through a magnifying glass -- watching the
 * signals and looking into them. Drawn on Lucide's 24px grid with its stroke, so it
 * sizes and colours like every other icon in the app.
 */
export const ObservabilityIcon = createLucideIcon('Observability', [
  ['circle', { cx: '10.5', cy: '10.5', r: '7.5', key: 'lens' }],
  ['path', { d: 'M5 10.5h2.25l1.5-3.5 2.5 7 1.5-3.5H15', key: 'pulse' }],
  ['path', { d: 'm21 21-5.2-5.2', key: 'handle' }],
]);
