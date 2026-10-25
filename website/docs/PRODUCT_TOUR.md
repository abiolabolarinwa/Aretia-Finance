# Product tour

A small guided-walkthrough engine, plain TypeScript, no dependency. It lives in `src/scripts/tour/`.

| File | What it is |
| --- | --- |
| `types.ts` | `TourConfig` and `TourStep`: a tour is just data |
| `session.ts` | The state machine (start, next, back, skip, resume, complete). No DOM |
| `storage.ts` | Saved progress in localStorage, versioned per tour, with an in-memory fallback |
| `placement.ts` | Where the tooltip goes so it stays on screen; a bottom sheet at 640px wide or less |
| `engine.ts` | The DOM part: dimmed overlay, spotlight, tooltip, keys, focus, resume pill |
| `styles.ts` | CSS injected once, built on the site's colour variables (light and dark follow the page) |
| `walletTourConfigs.ts` | The wallet's tours and their copy |
| `walletTours.ts` | Wires the engine into the wallet: header button, Tours list, first-visit start |
| `siteTours.ts` | A small tour of the home page, as an example outside the wallet |

## Add a step

Open `walletTourConfigs.ts`, find the tour, add an object to `steps`:

```ts
{ view: 'swap', target: '.wapp__swap-flip', title: 'Switch sides', body: 'Swap the two tokens round.', placement: 'right' }
```

- `target`: CSS selector. The first one that is on screen is used. Leave it out for a centred step.
- `view`: the wallet page to open first (`dashboard`, `send`, `swap`, `swings`, `launch`, `launchbox`). Only set it on the first step that needs it.
- `beforeShow` / `afterShow`: optional hooks, for example to open a tab before the target is looked for.
- A target that is missing or hidden for about a second is skipped. Nobody is stuck on a step that cannot be shown.

Then **raise the tour's `version`** so people who finished the old one see it again.

Copy rules: short, plain, present tense. Say that fees are shown before signing, that the person's own wallet signs, and that Aretia never holds keys. Do not promise anything the page does not do.

## Add a tour

1. Add a `TourConfig` to `WALLET_TOURS` with a new unique `id` (for example `tour-radar`).
2. To give a wallet page a "Take a tour" button, add `<view>: '<id>'` to `VIEW_TOUR`. The Tours list in the sidebar picks the tour up by itself; set `hidden: true` to keep it out of the list.
3. Run `npx vitest run src/scripts/tour`.

On another page, create an engine and register tours:

```ts
const engine = new TourEngine();          // optional { host: { goToView, isBlocked } }
engine.register(myTour);
engine.start('my-tour');
```

## Behaviour to know

- **First visit.** On the wallet dashboard, about 1.8 s after load, a tour starts once: "Wallet basics" after connecting, or a short "Getting started" before. It never starts while a dialog (`role="dialog"`, `aria-modal`, the swap window, the wallet connect sheet) is open, and if one opens during a tour the tour closes and offers "Resume tour".
- **Leaving.** Escape or Skip saves the step. A "Resume tour" pill appears, the page button changes to "Resume tour", and the Tours list shows "In progress".
- **Keys.** Right arrow or Enter: next. Left arrow: back. Escape: leave.
- **Storage.** Key `aretia-tour:<id>`. If localStorage is blocked the tour works for the visit and is simply not remembered.
- **Motion.** `prefers-reduced-motion` turns the transitions and smooth scrolling off.

## Not covered by tests

The DOM engine is checked by hand in a browser, not by unit tests. The tests cover the state machine, storage, versioning, missing targets and tooltip placement.
