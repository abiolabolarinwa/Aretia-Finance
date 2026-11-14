# Ultimate City Search: photorealistic cities (plan, nothing built yet)

Goal: the cities should look like real places, closer to the GTA-style reference images, instead of extruded map shapes.

## The one realistic route: Google Photorealistic 3D Tiles

Google serves photo-scanned 3D models of many real cities through the Map Tiles API. They are standard 3D Tiles, which three.js can
draw with the open-source `3d-tiles-renderer` library (its Google authentication plugin handles the key and session).

### What it will and will not look like (be honest with players and owners)

- The models come from aerial photography. From the air, or from a car at speed, they look remarkably real.
- **At walking height they do not.** Facades smear, cars and people are baked into the ground, thin things (railings, poles, trees)
  melt, and textures blur within a few metres. The third-person walking view will look worse than the reference images up close.
- Not every city is covered at the same quality. Coverage of all nine game cities has **not been checked**. Step 0 checks it.
- There are no moving cars, people, doors or shop interiors in the scan. Our own traffic and pedestrians would still be drawn on top.

### Rules that come with it (from Google's Map Tiles API policies; read the current text before building)

- The Google logo and data attribution must stay visible, unaltered and not covered by anything, in the game and in promotional videos.
- Map content may not be cached or stored offline except as Google's terms allow. No saving tiles to our own storage or R2.
- Do not build derived datasets from the tiles (for example extracting building shapes). Our own map data stays OpenStreetMap.
- Gaming use is not called out either way in what I read. **Ask a lawyer or Google sales whether a game that shows these tiles is
  allowed**, before launch. Do not assume.

### Cost (check the current pricing page; figures seen on the search date)

- Billed per **root tileset request** (one per play session, valid for a few hours), not per tile. About $6 per 1,000 sessions after a
  free monthly allowance (1,000 at the time of writing), falling at higher volumes. A hard daily quota applies per project.
- The free $200 monthly credit had an end date of 28 February 2025 on Google's page. Do not rely on it.
- A session can still pull tens of megabytes of tiles, so bandwidth and phone data use matter even though Google bills per session.

## How it would fit the game

1. **Key handling.** Create a Google Cloud project with the Map Tiles API enabled and a key. Keep the key off the page: a Cloudflare
   Pages Function requests the root tileset and returns the session to the browser, or the key is locked to our domain. Set a budget
   alert and a daily quota cap so a bot cannot run up the bill.
2. **Renderer.** Load tiles around the player with `3d-tiles-renderer`, placed in the same local-metre frame the game already uses
   (x east, z south, centred on the city), converting from Earth-centred coordinates. The server's speed checks do not change.
3. **Walking and driving surface.** Keep the existing OpenStreetMap colliders for walls and water (they are already tested). Add a
   downward ray against the loaded tile meshes (with `three-mesh-bvh`) so the ground follows real hills, kerbs and bridges.
4. **Hybrid view.** Show scanned tiles beyond roughly 120 m and in cars, and keep our painted streets, trees and lamps close to the
   player where the scan looks poor. This is the compromise most likely to look good; it needs tuning by eye.
5. **Fallback.** If a city has no coverage, the key is missing, or the daily quota is spent, use today's map-based world. The game
   never breaks because of this layer.
6. **Switch.** A build variable (for example `PUBLIC_GOOGLE_3D_TILES=1`) turns it on, off by default like the rest of the game.

## Steps

0. **Spike (about 2 days).** With a test key, load the tiles in a throwaway page for all nine cities. Record: coverage, how it looks at
   walking height and in a car, megabytes per minute, and frame rate on a mid-range laptop and a phone. Decide go or no-go on those
   numbers, not on the demos.
1. Key, budget and quota set-up, and the Cloudflare session function.
2. Tile renderer in the Walk and drive tab, with attribution always visible.
3. Ground-height ray casting and the hybrid near/far blend.
4. Fallbacks, quota handling, tests for everything that is not drawing (session function, fallback logic, frame conversion).
5. Real-device pass: desktop, phone, slow network.

## Decisions needed from the owner

1. Create the Google Cloud project, enable billing and the Map Tiles API, and share the key as a Cloudflare variable (never in chat or
   the repository).
2. Set a monthly spend limit you are comfortable with. Everything above is an estimate.
3. Confirm with Google or a lawyer that a game may show the tiles.
4. Agree to the Step 0 spike first: it is cheap, and it may show the walking view is not good enough to justify the cost.
