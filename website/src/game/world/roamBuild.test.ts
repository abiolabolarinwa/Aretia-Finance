import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { areasGeometry, bucketTile, buildingsGeometry, cellKey, roadsGeometry, waterLinesGeometry, CELL_M } from './roamBuild.js';
import type { Building, TileWorld } from './worldData.js';

const box = (x: number, z: number, s: number, h: number, minH = 0): Building => ({ rings: [[[x, z], [x + s, z], [x + s, z + s], [x, z + s]]], h, minH });
const empty = (): TileWorld => ({ buildings: [], roads: [], named: [], water: [], waterLines: [], areas: [] });

describe('building the 3D city from map data', () => {
  it('sorts buildings and streets into 200 m cells, a street segment by its middle', () => {
    const w = empty();
    w.buildings.push(box(10, 10, 20, 30), box(250, 10, 20, 30));
    w.roads.push({ pts: [[0, 0], [150, 0], [450, 0]], width: 8, cls: 'primary' });
    const cells = bucketTile(w);
    expect(cells.get(cellKey(20, 20))!.buildings).toHaveLength(1);
    expect(cells.get(cellKey(260, 20))!.buildings).toHaveLength(1);
    expect(cells.get('0,0')!.roads).toHaveLength(1); // 0 to 150, middle at 75
    expect(cells.get('1,0')!.roads).toHaveLength(1); // 150 to 450, middle at 300
    expect(cellKey(-1, -1)).toBe('-1,-1');
    expect(CELL_M).toBe(200);
  });

  it('gives a plain building four walls and a roof, as tall as the map says', () => {
    const g = buildingsGeometry(three, [box(0, 0, 10, 24)], '#232a52')!;
    // four wall quads (8 triangles) and a roof of 2 triangles
    expect(g.getAttribute('position').count).toBe(10 * 3);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBe(24);
    expect(g.boundingBox!.min.y).toBe(0);
    expect(g.boundingBox!.max.x).toBe(10);
    expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
  });

  it('raises a part on legs from its underside, walls a courtyard on the inside, and roofs around it', () => {
    const raised = buildingsGeometry(three, [box(0, 0, 10, 30, 12)], '#000000')!;
    raised.computeBoundingBox();
    expect(raised.boundingBox!.min.y).toBe(12);
    const ring = box(0, 0, 40, 20).rings[0]!;
    const courtyard: Building = { rings: [ring, [[10, 10], [10, 30], [30, 30], [30, 10]]], h: 20, minH: 0 };
    const g = buildingsGeometry(three, [courtyard], '#000000')!;
    // eight wall quads (outer and inner) and a roof with a hole in it, which needs more than two triangles
    expect(g.getAttribute('position').count).toBeGreaterThan(16 * 3 + 6 * 3);
    // No roof triangle covers the courtyard: every roof vertex lies on a ring corner.
    const pos = g.getAttribute('position');
    const roofCentres: number[][] = [];
    for (let i = 0; i < pos.count; i += 3) {
      if ([0, 1, 2].every((k) => pos.getY(i + k) === 20)) {
        roofCentres.push([(pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3]);
      }
    }
    expect(roofCentres.length).toBeGreaterThanOrEqual(6);
    for (const [x, z] of roofCentres) expect(x > 10 && x < 30 && z > 10 && z < 30).toBe(false);
  });

  it('returns nothing for no buildings, and survives a ring that closes on itself or has too few points', () => {
    expect(buildingsGeometry(three, [], '#000000')).toBeNull();
    const closed: Building = { rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]], h: 9, minH: 0 };
    expect(buildingsGeometry(three, [closed], '#000000')!.getAttribute('position').count).toBe(30);
    const sliver: Building = { rings: [[[0, 0], [1, 1]]], h: 9, minH: 0 };
    expect(buildingsGeometry(three, [sliver], '#000000')).toBeNull();
  });

  it('lays a street as a flat strip of the right width, a little higher for a bigger street', () => {
    const g = roadsGeometry(three, [{ pts: [[0, 0], [100, 0]], width: 10, cls: 'primary' }])!;
    g.computeBoundingBox();
    expect(g.getAttribute('position').count).toBe(6);
    expect(g.boundingBox!.max.z).toBeCloseTo(5);
    expect(g.boundingBox!.min.z).toBeCloseTo(-5);
    expect(g.boundingBox!.max.x).toBe(100);
    expect(g.boundingBox!.max.y).toBeGreaterThan(0.05);
    const small = roadsGeometry(three, [{ pts: [[0, 0], [100, 0]], width: 4, cls: 'service' }])!;
    small.computeBoundingBox();
    expect(small.boundingBox!.max.y).toBeLessThan(g.boundingBox!.max.y);
    expect(roadsGeometry(three, [])).toBeNull();
    expect(roadsGeometry(three, [{ pts: [[0, 0], [0, 0]], width: 4, cls: 'minor' }])).toBeNull(); // a zero-length street
  });

  it('draws water, parks and rivers flat on the ground', () => {
    const lake = { rings: [[[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][]], kind: 'grass' as const };
    const g = areasGeometry(three, [lake], 0.03, () => '#1f5d86')!;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(0.03, 5);
    expect(g.getAttribute('position').count).toBe(6);
    const river = waterLinesGeometry(three, [{ pts: [[0, 0], [0, 200]], width: 12 }], 0.035)!;
    river.computeBoundingBox();
    expect(river.boundingBox!.max.x).toBeCloseTo(6);
    expect(areasGeometry(three, [], 0, () => '#000000')).toBeNull();
  });
});
