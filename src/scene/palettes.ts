export interface Palette {
  name: string;
  background: string;
  floor: string;
  colors: string[];
  statics: string; // colour for static scenery (containers, ramps...)
}

export const PALETTES: Record<string, Palette> = {
  sorbet: {
    name: 'Sorbet', background: '#f3e9e1', floor: '#efe3d9', statics: '#e6d7cb',
    colors: ['#ff8fa3', '#ffc36b', '#ffe68a', '#9be3b5', '#82c7ff', '#b49cff'],
  },
  candy: {
    name: 'Candy', background: '#fde2ef', floor: '#fbd6e8', statics: '#f6c7dd',
    colors: ['#ff5d8f', '#ff9ebb', '#ffd166', '#06d6a0', '#7bdff2', '#b388eb'],
  },
  mint: {
    name: 'Mint', background: '#dff3ec', floor: '#d3eee4', statics: '#c2e6d8',
    colors: ['#2a9d8f', '#8ab17d', '#e9c46a', '#f4a261', '#e76f51', '#264653'],
  },
  ocean: {
    name: 'Ocean', background: '#d9ecf7', floor: '#cfe5f3', statics: '#bcd8ec',
    colors: ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8', '#ffb703'],
  },
  sunset: {
    name: 'Sunset', background: '#2b1b3d', floor: '#2f1f44', statics: '#3a2853',
    colors: ['#ff6d00', '#ff8500', '#ff9e00', '#ff5d8f', '#c77dff', '#7b2cbf'],
  },
  neon: {
    name: 'Neon', background: '#07070d', floor: '#0b0b14', statics: '#15152a',
    colors: ['#00f5d4', '#00bbf9', '#9b5de5', '#f15bb5', '#fee440', '#ff5400'],
  },
  mono: {
    name: 'Monochrome', background: '#e9e9e9', floor: '#e3e3e3', statics: '#d2d2d2',
    colors: ['#111111', '#3a3a3a', '#6b6b6b', '#a1a1a1', '#d9d9d9', '#f6f6f6'],
  },
  noir: {
    name: 'Noir & Gold', background: '#0e0e10', floor: '#121214', statics: '#1c1c20',
    colors: ['#d4af37', '#f1d27a', '#1f1f23', '#b08d2e', '#efe6cf', '#3b3b42'],
  },
  bauhaus: {
    name: 'Bauhaus', background: '#efe9dc', floor: '#e9e1d1', statics: '#ddd3bf',
    colors: ['#d62828', '#f7b801', '#1d3557', '#111111', '#f1faee', '#457b9d'],
  },
  forest: {
    name: 'Forest', background: '#e6ebdf', floor: '#dde4d4', statics: '#cdd6c0',
    colors: ['#344e41', '#3a5a40', '#588157', '#a3b18a', '#dad7cd', '#bc6c25'],
  },
  rainbow: {
    name: 'Rainbow', background: '#f4f4f6', floor: '#ececf0', statics: '#dcdce4',
    colors: ['#ff595e', '#ff924c', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'],
  },
  lava: {
    name: 'Lava', background: '#140b0b', floor: '#1a0f0e', statics: '#2a1715',
    colors: ['#ff2400', '#ff6a00', '#ffae00', '#ffd900', '#7a0b00', '#ffffff'],
  },
};

export const PALETTE_KEYS = Object.keys(PALETTES);

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB [0,1] -> linear */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** Samples a palette continuously (t in [0,1]) with smooth interpolation in linear space. */
export function samplePalette(p: Palette, t: number): [number, number, number] {
  const cols = p.colors;
  const x = Math.min(Math.max(t, 0), 1) * (cols.length - 1);
  const i = Math.min(Math.floor(x), cols.length - 2);
  const f = x - i;
  const a = hexToLinear(cols[i]);
  const b = hexToLinear(cols[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
