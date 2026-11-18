import { describe, expect, it } from 'vitest';
import { ALL_RED_S, AMBER_S, CYCLE_S, GREEN_S, armGroup, crosswalkDistance, junctionsFor, junctionsOf, lightFor, roomForCrosswalk, speedToStopIn, stopDistance, targetAtLight } from './junctions.js';
import type { Road, TileWorld } from './worldData.js';

const road = (pts: [number, number][], width = 10, cls = 'primary'): Road => ({ pts, width, cls });
/** Two main roads crossing at the origin. */
const cross = (): Road[] => [road([[-100, 0], [0, 0]]), road([[0, 0], [100, 0]]), road([[0, -100], [0, 0]]), road([[0, 0], [0, 100]])];

describe('finding junctions', () => {
  it('finds a crossing of main roads, with four arms, and puts signals on it', () => {
    const js = junctionsOf(cross());
    expect(js).toHaveLength(1);
    const j = js[0]!;
    expect(j.arms).toHaveLength(4);
    expect([j.x, j.z]).toEqual([0, 0]);
    expect(j.signalised).toBe(true);
    expect(j.id).toBe('0,0');
    expect(Math.hypot(...j.axis)).toBeCloseTo(1);
    // The four arms point out of the junction in the four directions.
    const dirs = j.arms.map((a) => `${Math.round(a.dx)},${Math.round(a.dz)}`).sort();
    expect(dirs).toEqual(['-1,0', '0,-1', '0,1', '1,0']);
  });

  it('does not put signals on small streets, on a bend, on paths, or on a motorway junction', () => {
    expect(junctionsOf([road([[-50, 0], [0, 0]], 6, 'minor'), road([[0, 0], [50, 0]], 6, 'minor'), road([[0, 0], [0, 50]], 6, 'minor')])[0]!.signalised).toBe(false);
    // A road that just bends has two arms at its corner: not a junction.
    expect(junctionsOf([road([[-50, 0], [0, 0], [0, 50]])])).toHaveLength(0);
    // A footpath joining a road does not make a junction.
    expect(junctionsOf([road([[-50, 0], [0, 0], [50, 0]]), road([[0, 0], [0, 40]], 2, 'path')])).toHaveLength(0);
    const motorway = [road([[-100, 0], [0, 0]], 14, 'motorway'), road([[0, 0], [100, 0]], 14, 'motorway'), road([[0, 0], [0, 80]], 10, 'primary')];
    expect(junctionsOf(motorway)[0]!.signalised).toBe(false);
    // A main road with one minor street joining it has only one main arm pair... two main arms (the road itself): that is a T with a main road.
    const t = junctionsOf([road([[-100, 0], [0, 0]], 9, 'secondary'), road([[0, 0], [100, 0]], 9, 'secondary'), road([[0, 0], [0, 60]], 6, 'minor')]);
    expect(t[0]!.signalised).toBe(true);
  });

  it('counts a road that is cut into pieces as one, and a junction drawn as two close nodes as one', () => {
    const split = [road([[-100, 0], [-50, 0], [0, 0]]), road([[0, 0], [60, 0], [100, 0]]), road([[0, -100], [0, -40], [0, 0]]), road([[0, 0], [0, 100]])];
    expect(junctionsOf(split)).toHaveLength(1);
    expect(junctionsOf(split)[0]!.arms).toHaveLength(4);
    // A junction whose middle is two nodes 3 m apart.
    const twin = [road([[-100, 0], [0, 0]]), road([[0, 0], [3, 0]]), road([[3, 0], [100, 0]]), road([[0, 0], [0, 100]]), road([[3, 0], [3, -100]])];
    expect(junctionsOf(twin)).toHaveLength(1);
  });

  it('gives each junction its own beat and a stable name, and works a tile\'s junctions out once', () => {
    const a = junctionsOf([...cross(), ...cross().map((r) => road(r.pts.map(([x, z]) => [x + 500, z + 300] as [number, number]))) ]);
    expect(a).toHaveLength(2);
    expect(a[0]!.offset).not.toBe(a[1]!.offset);
    for (const j of a) {
      expect(j.offset).toBeGreaterThanOrEqual(0);
      expect(j.offset).toBeLessThan(CYCLE_S);
    }
    expect(a.map((j) => j.id).sort()).toEqual(['0,0', '500,300']);
    const world: TileWorld = { buildings: [], roads: cross(), named: [], water: [], waterLines: [], areas: [] };
    expect(junctionsFor(world)).toBe(junctionsFor(world));
  });
});

describe('the lights', () => {
  it('give each group a green, an amber and a red, in order, and never green to both groups at once', () => {
    expect(lightFor(0, 0)).toBe('green');
    expect(lightFor(0, GREEN_S - 0.1)).toBe('green');
    expect(lightFor(0, GREEN_S + 0.1)).toBe('amber');
    expect(lightFor(0, GREEN_S + AMBER_S + 0.1)).toBe('red');
    expect(lightFor(1, 0)).toBe('red');
    for (let t = 0; t < CYCLE_S * 3; t += 0.1) {
      const a = lightFor(0, t, 7);
      const b = lightFor(1, t, 7);
      expect(a === 'green' && b === 'green').toBe(false);
      expect(a !== 'red' && b !== 'red').toBe(false); // never both moving: at least one is red
      expect(a === 'green' && b === 'amber').toBe(false);
    }
  });

  it('keeps everyone waiting for a moment between one group and the next', () => {
    // After group 0's amber ends, both are red for the all-red time before group 1 turns green.
    const t = GREEN_S + AMBER_S + ALL_RED_S / 2;
    expect(lightFor(0, t)).toBe('red');
    expect(lightFor(1, t)).toBe('red');
    expect(lightFor(1, CYCLE_S / 2 + 0.1)).toBe('green');
  });

  it('repeats every round, handles negative times, and shifts by the junction\'s offset', () => {
    for (const t of [0, 5, 13, 20, 29]) expect(lightFor(0, t + CYCLE_S)).toBe(lightFor(0, t));
    expect(lightFor(0, -CYCLE_S + 1)).toBe('green');
    expect(lightFor(0, 0, GREEN_S + 0.5)).toBe('amber');
    expect(CYCLE_S).toBe(2 * (GREEN_S + AMBER_S + ALL_RED_S));
  });

  it('sorts roads into the group along the main axis and the group across it', () => {
    const j = { axis: [1, 0] as [number, number] };
    expect(armGroup(j, 1, 0)).toBe(0);
    expect(armGroup(j, -1, 0)).toBe(0);
    expect(armGroup(j, 0, 1)).toBe(1);
    expect(armGroup(j, 0, -1)).toBe(1);
    expect(armGroup(j, 0.9, 0.43)).toBe(0); // a slight angle still counts as along
  });
});

describe('crosswalks and stopping', () => {
  const j = junctionsOf(cross())[0]!;

  it('puts the crosswalk clear of the widest road, and the stop line before it', () => {
    expect(crosswalkDistance(j)).toBe(5 + 3);
    expect(stopDistance(j)).toBeCloseTo(crosswalkDistance(j) + 3.2);
    expect(roomForCrosswalk(j, j.arms[0]!)).toBe(true); // 100 m arms
    expect(roomForCrosswalk(j, { ...j.arms[0]!, len: 9 })).toBe(false);
  });

  it('slows evenly to stop exactly at the line', () => {
    expect(speedToStopIn(0)).toBe(0);
    expect(speedToStopIn(-3)).toBe(0);
    expect(speedToStopIn(20)).toBeGreaterThan(speedToStopIn(5));
    // Following that speed down from far away never needs more than the comfortable braking.
    let gap = 60;
    let v = 12;
    for (let i = 0; i < 4000 && v > 0.05; i++) {
      const target = speedToStopIn(gap);
      const dv = Math.max(-3.8 * 0.01, Math.min(3.8 * 0.01, target - v));
      v += dv;
      gap -= v * 0.01;
    }
    expect(gap).toBeGreaterThan(-1);
    expect(gap).toBeLessThan(2);
  });

  it('goes on green, stops for red, and on amber stops only when it comfortably can', () => {
    expect(targetAtLight('green', 5, 10, 11)).toBe(11);
    expect(targetAtLight('red', 40, 10, 11)).toBeLessThanOrEqual(11);
    expect(targetAtLight('red', 40, 10, 11)).toBeGreaterThan(8); // far away: still nearly full speed
    expect(targetAtLight('red', 3, 10, 11)).toBeLessThan(5);
    expect(targetAtLight('red', 0.2, 1, 11)).toBe(0);
    // Amber with room to stop: stops. Amber too close to stop at this speed: carries on.
    expect(targetAtLight('amber', 30, 10, 11)).toBe(11); // still far off: no need to slow yet
    expect(targetAtLight('amber', 12, 10, 11)).toBeLessThan(11); // close enough that braking is due, and there is room to stop
    expect(targetAtLight('amber', 6, 12, 12)).toBe(12);
    // Over the line and still moving fast: committed, goes through. Well into the junction: never stops there. Just over the line and
    // nearly stopped (a stop that ran on a little): stays put until green.
    expect(targetAtLight('red', -1, 5, 11)).toBe(11);
    expect(targetAtLight('red', -4, 0.5, 11)).toBe(11);
    expect(targetAtLight('red', -0.5, 0.3, 11)).toBe(0);
    expect(targetAtLight('green', -0.5, 0.3, 11)).toBe(11);
  });

  it('a simulated car (with the game\'s own speed smoothing) stops before the line on red, waits, and sets off on green', () => {
    const cruise = 12;
    const dt = 1 / 60;
    let speed = cruise;
    let gap = 90; // metres from the nose to the stop line
    let light: 'green' | 'red' = 'red';
    let t = 0;
    let stoppedAt: number | null = null;
    let minGap = gap;
    for (; t < 40; t += dt) {
      const target = targetAtLight(light, gap, speed, cruise);
      speed += (target - speed) * Math.min(1, dt * 3);
      gap -= speed * dt;
      minGap = Math.min(minGap, gap);
      if (stoppedAt === null && speed < 0.05) stoppedAt = t;
    }
    expect(stoppedAt).not.toBeNull();
    expect(minGap).toBeGreaterThan(-1.2); // never runs past the line by more than a metre
    expect(gap).toBeLessThan(2.5); // and does not stop miles short
    expect(speed).toBeLessThan(0.05); // and is still waiting
    light = 'green';
    for (let i = 0; i < 60 * 6; i++) {
      speed += (targetAtLight(light, gap, speed, cruise) - speed) * Math.min(1, dt * 3);
      gap -= speed * dt;
    }
    expect(speed).toBeGreaterThan(8); // away again within a few seconds
    expect(gap).toBeLessThan(-5);
  });

  it('a car that cannot stop for amber goes through, and one that can, stops, with no car ever stopping inside the junction', () => {
    const dt = 1 / 60;
    for (const start of [40, 30, 20, 14, 9]) {
      let speed = 12;
      let gap = start;
      let stoppedInside = false;
      for (let t = 0; t < 12; t += dt) {
        // Amber for the first 2.5 s, then red.
        const light = t < 2.5 ? 'amber' : 'red';
        speed += (targetAtLight(light, gap, speed, 12) - speed) * Math.min(1, dt * 3);
        gap -= speed * dt;
        if (gap < -3 && speed < 0.5) stoppedInside = true;
      }
      expect(stoppedInside, `starting ${start} m away`).toBe(false);
    }
  });
});
