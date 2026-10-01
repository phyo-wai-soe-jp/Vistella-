# 積み付けシミュレータ — web version

The Loading tab as a web page: build boxes, fields and placement methods,
run the planner, and watch the load stack in 3D. It reads and writes the
same JSON as the iPhone app (VisTella's LoadPlanExchange format), so a
library saved on the phone opens here and the other way round.

## Running it

Any static file server works; ES modules need http, not `file://`:

```sh
cd web && python3 -m http.server 8931   # then open http://localhost:8931/
```

## Files

| File | What it holds |
| --- | --- |
| `index.html` | The page: settings bar, Create rail, 3D stage, Simulate bar |
| `styles.css` | Tokens and layout, light and dark, phone to desktop |
| `planner.js` | The planner, ported from the app's Swift: checks, loading orders, scoring, metrics |
| `exchange.js` | Reading and writing the shared library and plan JSON |
| `samples.js` | The library the page opens with, matching the app's samples |
| `random.js` | Makes up a collection from a seed, matching the app's `LoadPlanRandom.swift` |
| `app.js` | State, editors, the canvas renderer and playback |

## Staying identical to the phone

`planner.js` mirrors `LoadPlanModel.swift`, `LoadPlanChecks.swift` and
`LoadPlanner.swift` line for line, including tie-breaks. It was checked by
exporting the app's plan for every sample collection × field × method (18
plans) and re-running each one here: every box landed at the same position,
in the same order, with the same results card.

The random collection maker is checked the same way: the same seed produces
the same boxes on both sides, down to sizes, weights, quantities and
strengths. It runs in 32-bit arithmetic through `Math.imul` on purpose —
a plain multiply in JavaScript passes 2^53 and drifts away from Swift.

Re-run that check after changing either planner:

1. Build a Swift harness from `LoadPlanModel/Checks/Planner/Samples/Exchange`
   plus a `main.swift` that writes `LoadPlanExchange.encodeLibrary(...)` and
   one `encodePlan(...)` per scenario into a `fixtures/` folder.
2. Load `fixtures/library.json` here with `parseLibrary`, run `plan(...)` for
   the same scenarios, and compare placements and metrics.
