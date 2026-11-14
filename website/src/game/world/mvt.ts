/**
 * A small decoder for Mapbox Vector Tiles (the format OpenFreeMap serves: real streets, buildings and water from OpenStreetMap). It
 * reads the protobuf by hand, so the game needs no extra library, and turns each feature's drawing commands into coordinates in the
 * tile's own grid (usually 4096 across). Lines come back as lists of points; polygons as an outer ring followed by its holes.
 */
export type Prop = string | number | boolean;
export type Pt = [number, number];

export interface VFeature {
  props: Record<string, Prop>;
  /** 'point', 'line' or 'polygon'. */
  kind: 'point' | 'line' | 'polygon';
  points: Pt[];
  lines: Pt[][];
  /** Each polygon: its outer ring first, then any holes. */
  polygons: Pt[][][];
}

export interface VLayer {
  name: string;
  extent: number;
  features: VFeature[];
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array, end = buf.length) {
    this.buf = buf;
    this.end = end;
  }
  more(): boolean {
    return this.pos < this.end;
  }
  varint(): number {
    // Values here fit comfortably in 53 bits; the high words are folded in without losing the low ones.
    let lo = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('Truncated tile.');
      const b = this.buf[this.pos++]!;
      lo += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return lo;
      shift += 7;
      if (shift > 63) throw new Error('Bad number in tile.');
    }
  }
  bytes(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Truncated tile.');
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error('Unknown field in tile.');
  }
  string(): string {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  double(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  float(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  packed(): number[] {
    const r = this.bytes();
    const out: number[] = [];
    while (r.more()) out.push(r.varint());
    return out;
  }
}

const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(r: Reader): Prop {
  let v: Prop = '';
  while (r.more()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1) v = r.string();
    else if (field === 2) v = r.float();
    else if (field === 3) v = r.double();
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = r.varint() !== 0;
    else r.skip(wire);
  }
  return v;
}

const area2 = (ring: Pt[]): number => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return a;
};

/** Turns a feature's drawing commands (move, line, close) into points, lines or polygons. */
function geometry(kind: 1 | 2 | 3, cmds: number[]): Pick<VFeature, 'points' | 'lines' | 'polygons'> {
  const points: Pt[] = [];
  const lines: Pt[][] = [];
  const rings: Pt[][] = [];
  let x = 0;
  let y = 0;
  let cur: Pt[] = [];
  for (let i = 0; i < cmds.length; ) {
    const head = cmds[i++]!;
    const id = head & 7;
    const count = Math.floor(head / 8);
    if (id === 7) {
      if (cur.length > 0) rings.push(cur);
      cur = [];
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]!);
      y += zigzag(cmds[i++]!);
      if (id === 1) {
        if (kind === 1) points.push([x, y]);
        else {
          if (cur.length > 0) (kind === 2 ? lines : rings).push(cur);
          cur = [[x, y]];
        }
      } else cur.push([x, y]);
    }
  }
  if (cur.length > 0 && kind === 2) lines.push(cur);
  if (cur.length > 0 && kind === 3) rings.push(cur);
  const polygons: Pt[][][] = [];
  if (kind === 3) {
    // The first ring of a polygon is its outside; the rings that wind the other way are its holes.
    for (const ring of rings) {
      if (ring.length < 3) continue;
      if (area2(ring) > 0 || polygons.length === 0) polygons.push([ring]);
      else polygons[polygons.length - 1]!.push(ring);
    }
  }
  return { points, lines: kind === 2 ? lines : [], polygons };
}

export function decodeTile(buf: Uint8Array): VLayer[] {
  const tile = new Reader(buf);
  const layers: VLayer[] = [];
  while (tile.more()) {
    const tag = tile.varint();
    if (tag === 26) {
      const lr = tile.bytes();
      let name = '';
      let extent = 4096;
      const keys: string[] = [];
      const values: Prop[] = [];
      const raw: { tags: number[]; kind: 1 | 2 | 3; cmds: number[] }[] = [];
      while (lr.more()) {
        const t = lr.varint();
        const field = Math.floor(t / 8);
        const wire = t % 8;
        if (field === 1) name = lr.string();
        else if (field === 2) {
          const fr = lr.bytes();
          let tags: number[] = [];
          let kind: 1 | 2 | 3 = 1;
          let cmds: number[] = [];
          while (fr.more()) {
            const ft = fr.varint();
            const ff = Math.floor(ft / 8);
            const fw = ft % 8;
            if (ff === 2) tags = fr.packed();
            else if (ff === 3) kind = fr.varint() as 1 | 2 | 3;
            else if (ff === 4) cmds = fr.packed();
            else fr.skip(fw);
          }
          raw.push({ tags, kind, cmds });
        } else if (field === 3) keys.push(lr.string());
        else if (field === 4) values.push(readValue(lr.bytes()));
        else if (field === 5) extent = lr.varint();
        else lr.skip(wire);
      }
      const features: VFeature[] = raw.map((f) => {
        const props: Record<string, Prop> = {};
        for (let i = 0; i + 1 < f.tags.length; i += 2) {
          const key = keys[f.tags[i]!];
          const value = values[f.tags[i + 1]!];
          if (key !== undefined && value !== undefined) props[key] = value;
        }
        const g = geometry(f.kind, f.cmds);
        return { props, kind: f.kind === 1 ? 'point' : f.kind === 2 ? 'line' : 'polygon', ...g };
      });
      layers.push({ name, extent, features });
    } else tile.skip(tag % 8);
  }
  return layers;
}
