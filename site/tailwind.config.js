/** Builds site/landing.css from site/landing.src.css. See the note in site/README.md. */
export default {
  content: ['./landing.html'],
  // The approval demo builds these class names in JavaScript, so the scanner cannot see them.
  safelist: [
    'bg-green', 'bg-red', 'bg-amber', 'text-green', 'text-red', 'text-amber',
    'border-green/40', 'border-red/40', 'border-amber/40',
    'bg-green/5', 'bg-red/5', 'bg-amber/5',
  ],
  theme: {
    extend: {
      colors: {
        ground: 'rgb(var(--ground) / <alpha-value>)',
        tile: 'rgb(var(--tile) / <alpha-value>)',
        'tile-2': 'rgb(var(--tile-2) / <alpha-value>)',
        hairline: 'rgb(var(--hairline) / <alpha-value>)',
        edge: 'rgb(var(--edge) / <alpha-value>)',
        ink: 'rgb(var(--text) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        dim: 'rgb(var(--dim) / <alpha-value>)',
        blue: 'rgb(var(--blue) / <alpha-value>)',
        'blue-text': 'rgb(var(--blue-text) / <alpha-value>)',
        green: 'rgb(var(--green) / <alpha-value>)',
        amber: 'rgb(var(--amber) / <alpha-value>)',
        red: 'rgb(var(--red) / <alpha-value>)',
        cyan: 'rgb(var(--cyan) / <alpha-value>)',
        violet: 'rgb(var(--violet) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { tile: 'var(--radius-tile)', inner: 'var(--radius-inner)' },
    },
  },
};
