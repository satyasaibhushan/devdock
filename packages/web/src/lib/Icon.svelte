<script lang="ts" module>
  export type IconName =
    | 'play'
    | 'stop'
    | 'restart'
    | 'hammer'
    | 'plus'
    | 'x'
    | 'more'
    | 'chevron-down'
    | 'chevron-right'
    | 'terminal'
    | 'search'
    | 'branch'
    | 'expand'
    | 'collapse'
    | 'check'
    | 'alert'
    | 'external'
    | 'monitor'
    | 'unplug'
    | 'inbox'
    | 'layers'

  // Stroke geometry on a 24-unit grid. `play` and `stop` are filled so the
  // lifecycle verbs read as solid glyphs at 12px next to outlined ones.
  const PATHS: Record<IconName, string> = {
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>',
    restart: '<path d="M21 12a9 9 0 1 1-6.2-8.5"/><path d="M21 3v6h-6"/>',
    hammer:
      '<path d="m15 12-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4L12.6 9.6"/><path d="m18 15 3-3"/><path d="m21.5 11.5-1.9-1.9a2 2 0 0 1-.6-1.4V7l-2.3-2.3a6 6 0 0 0-4.2-1.7l-3.5.7.9.8a6.2 6.2 0 0 1 2.1 4.6V10l2 2h1.2a2 2 0 0 1 1.4.6l1.9 1.9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    branch: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 6v12"/><path d="M18 10a6 6 0 0 1-6 6H6"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    collapse: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    unplug: '<path d="M18.4 5.6 5.6 18.4"/><path d="m8 8 2 2M16 16l-2-2"/><path d="M9 3 6 6a4 4 0 0 0 0 5.7l1.5 1.5L13.2 7.5 11.7 6A4 4 0 0 0 9 3z"/><path d="m15 21 3-3a4 4 0 0 0 0-5.7l-1.5-1.5-5.7 5.7 1.5 1.5a4 4 0 0 0 2.7 0z"/>',
    inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 4h14l2 9v7H3v-7z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  }
  const FILLED = new Set<IconName>(['play', 'stop'])
</script>

<script lang="ts">
  let { name, size = 14 }: { name: IconName; size?: number } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={FILLED.has(name) ? 'currentColor' : 'none'}
  stroke={FILLED.has(name) ? 'none' : 'currentColor'}
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {@html PATHS[name]}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
