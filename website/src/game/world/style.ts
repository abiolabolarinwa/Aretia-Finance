/**
 * The two looks of the roaming city. "Bright" is a clean, toy-like, daytime look (soft green land, blue water, pastel buildings with
 * coloured roofs, white clouds, floating icons over places, white rounded cards). "Realistic" is the muted golden-hour look with
 * photographed surface detail. Everything that depends on the look is read from one of these, so the rest of the code stays the same.
 */

export type LookId = 'bright' | 'real';
export type AreaKindName = 'grass' | 'wood' | 'sand' | 'paving';

export interface Palette {
  id: LookId;
  label: string;
  sky: { zenith: string; mid: string; haze: string; sun: string; cloudLit: string; cloudShade: string; /** how strong the glare round the sun is */ glow: number };
  fog: [number, number];
  tone: { filmic: boolean; exposure: number };
  light: { hemiSky: string; hemiGround: string; hemi: number; sun: number; env: number };
  /** The plain ground colour where the map has nothing to say. */
  ground: string;
  area: Record<AreaKindName, string>;
  water: string;
  road: { asphalt: Record<string, string>; fallback: string; kerb: string; pavement: string; edge: string; centre: string; centreHighway: string; path: string; pier: string };
  buildings: {
    walls: string[];
    /** Roof colours to choose from; null means a darker shade of the wall. */
    roofs: string[] | null;
    roofShade: number;
    /** How much darker a shop-front ground floor is (1 is no change). */
    shop: number;
    /** The picture in each window: wall, frame, and the glass at the top and bottom. */
    window: { wall: string; slab: string; frame: string; glassTop: string; glassBottom: string; sill: string };
    /** Whether a colour recorded in the map is used for the wall (the bright look keeps its own pastels). */
    useMapColour: boolean;
  };
  tree: { hue: number; hueSpread: number; sat: number; light: number; lightSpread: number; trunk: string };
  /** Whether photographed surface textures are laid over the colours. */
  photoDetail: boolean;
  camera: { pitch: number; foot: number; car: number; fov: number };
  ui: { text: string; shadow: string; card: string; border: string; accent: string; radius: string };
}

export const REAL: Palette = {
  id: 'real',
  label: 'Realistic',
  sky: { zenith: '#4a7fc4', mid: '#9bbbe0', haze: '#dcc7ab', sun: '#ffd9a6', cloudLit: '#ffebcc', cloudShade: '#a8adbd', glow: 1 },
  fog: [140, 950],
  tone: { filmic: true, exposure: 1.05 },
  light: { hemiSky: '#cfe0ff', hemiGround: '#85715a', hemi: 0.7, sun: 2.6, env: 0.85 },
  ground: '#a29f94',
  area: { grass: '#5d8a47', wood: '#3f6b3a', sand: '#d8c690', paving: '#b4b1a7' },
  water: '#3b79a6',
  road: {
    asphalt: { motorway: '#2b2b2f', trunk: '#2e2e33', primary: '#323237', secondary: '#38383d', tertiary: '#3e3e44', minor: '#46464c', service: '#55555b' },
    fallback: '#46464c',
    kerb: '#7d7b74',
    pavement: '#c9c6bb',
    edge: 'rgba(235,235,235,0.7)',
    centre: '#f1f1f1',
    centreHighway: '#e9c84a',
    path: '#b59f78',
    pier: '#8a8272',
  },
  buildings: {
    walls: ['#e6e1d4', '#d6d0c0', '#c6bfae', '#efe9dc', '#b8b2a3', '#dcd2c2', '#cdb9a3', '#d9d9d6'],
    roofs: null,
    roofShade: 0.62,
    shop: 0.78,
    window: { wall: '#f4f1ea', slab: '#dcd8cd', frame: '#3b3f46', glassTop: '#9fb8cc', glassBottom: '#4d6a85', sill: '#e8e4da' },
    useMapColour: true,
  },
  tree: { hue: 0.27, hueSpread: 0.07, sat: 0.45, light: 0.24, lightSpread: 0.12, trunk: '#5b4331' },
  photoDetail: true,
  camera: { pitch: 0.45, foot: 6.2, car: 10.5, fov: 60 },
  ui: { text: '#ffffff', shadow: '0 1px 3px #000,0 0 8px #000', card: 'rgba(0,0,0,.55)', border: 'rgba(255,255,255,.6)', accent: '#2dd36f', radius: '12px' },
};

export const BRIGHT: Palette = {
  id: 'bright',
  label: 'Bright',
  sky: { zenith: '#4aa8f2', mid: '#9fd6fb', haze: '#e6f5ff', sun: '#fff4d6', cloudLit: '#ffffff', cloudShade: '#dbe8f5', glow: 0.35 },
  fog: [260, 1100],
  tone: { filmic: true, exposure: 1.0 },
  light: { hemiSky: '#e8f4ff', hemiGround: '#b9d9a0', hemi: 1.05, sun: 1.9, env: 0.6 },
  ground: '#a5d48f',
  area: { grass: '#92d47e', wood: '#62b86c', sand: '#f4e5ae', paving: '#ececf0' },
  water: '#5cb9ef',
  road: {
    asphalt: { motorway: '#686d7b', trunk: '#6b7080', primary: '#6f7484', secondary: '#737888', tertiary: '#787d8c', minor: '#7e8391', service: '#8b8f9b' },
    fallback: '#7e8391',
    kerb: '#dfe1e6',
    pavement: '#f5f4ef',
    edge: 'rgba(255,255,255,0.85)',
    centre: '#ffffff',
    centreHighway: '#ffd45e',
    path: '#e8d7b0',
    pier: '#cdbd9c',
  },
  buildings: {
    walls: ['#ffffff', '#f7efe3', '#e8f6f1', '#fdeedd', '#e9eefb', '#f6e9f3', '#eef6e0'],
    roofs: ['#3fae8f', '#e5775d', '#5b8fd9', '#f0b84b', '#7cc36a', '#9a7bd1', '#e8688b'],
    roofShade: 1,
    shop: 0.92,
    window: { wall: '#ffffff', slab: '#ececf2', frame: '#ffffff', glassTop: '#a7dcff', glassBottom: '#6fb5ea', sill: '#ffffff' },
    useMapColour: false,
  },
  tree: { hue: 0.31, hueSpread: 0.05, sat: 0.55, light: 0.42, lightSpread: 0.1, trunk: '#9a6b45' },
  photoDetail: false,
  camera: { pitch: 0.72, foot: 8.5, car: 12.5, fov: 55 },
  ui: { text: '#12301f', shadow: 'none', card: 'rgba(255,255,255,.94)', border: 'rgba(0,0,0,.08)', accent: '#16a05a', radius: '999px' },
};

export const PALETTES: Record<LookId, Palette> = { bright: BRIGHT, real: REAL };

const KEY = 'ucs-look';

/** The look the player chose last time (bright the first time). */
export function savedLook(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LookId {
  try {
    const v = storage?.getItem(KEY);
    return v === 'real' || v === 'bright' ? v : 'bright';
  } catch {
    return 'bright';
  }
}

export function saveLook(id: LookId, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // the choice just is not remembered
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const otherLook = (id: LookId): LookId => (id === 'bright' ? 'real' : 'bright');
