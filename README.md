# Encircle

Encircle is a cycling territory game for Purdue Cycling Club. Ride through Indiana and Illinois to earn points, close loops to claim more ground, and see who controls the most squares.

## Rules

1. Indiana and Illinois share a grid of 0.2 × 0.2 mile squares.
2. An eligible ride earns one point for each square it passes through. Crossing the same square several times on one ride earns one pass-through point.
3. Closing a loop earns one bonus point in every square it encloses. Count overlapping loop interiors once per square on the same ride.
4. The highest point total controls a square. Riders tied for the lead share control, and the square counts for each of them on the leaderboard.
5. **Squares controlled** counts the squares each rider currently controls, including shared squares. **Largest single capture** ranks riders by the number of distinct enclosed squares on their best eligible ride.

The pass-through and loop details are the proposed scoring defaults. Before a club season, settle the GPS gap and loop closure tolerances, boundary treatment, ride eligibility, and the season start date.

## Run the frontend

Use Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The demo starts around West Lafayette. Use the region selector to explore both states or focus on one, **Full region** to see the active boundary, and a leaderboard row to highlight that rider's squares. Select a colored square to inspect its scores. The two leaderboards use fictional riders and results.

Encircle supports [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/) and Mapbox Outdoors. Mapbox is the map provider [Strava uses for interactive activity maps](https://support.strava.com/en-us/articles/15402176-about-strava-maps). The token-free preview uses [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) with [OpenFreeMap](https://openfreemap.org/) tiles. To switch to Mapbox, copy `.env.example` to `.env.local`, set `VITE_MAPBOX_TOKEN` to your public `pk.` token, and restart Vite. Allow the dev and production origins in the token settings as needed. The browser needs network access for basemap tiles.

```sh
npm run build
```

The build writes the static frontend to `dist/`.

## Test your own Indiana rides

Start local PostgreSQL 16 or newer and the API using the [server setup](server/README.md). In a second terminal, start the dashboard in year-test mode.

```sh
VITE_USE_LOCAL_API=true npm run dev
```

Open the local Vite URL. Select **Import GPX** and choose one or more dated GPX files. Each calendar year in Indianapolis time competes as its own player. The local board begins empty and covers Indiana only.

To use Strava, connect your account once with the [Python setup guide](sync/README.md), then run the importer manually with the API running. Set `--since` on the first run to backfill your ride history. Run the final command daily as needed and reload the dashboard.

```sh
python3 sync/strava_sync.py authorize
python3 sync/strava_sync.py import --local-only --since 2024-01-01
python3 sync/strava_sync.py import --local-only
```

Imports keep raw GPS tracks in memory for scoring. PostgreSQL stores current scores for occupied squares and compact contributions for rides that score in Indiana. Imports and withdrawals update only the affected squares. Matching timestamps and tracks deduplicate. An edited or differently exported track can produce a second ride, and Strava edits or removals currently require [manual withdrawal](server/README.md#api).

The pilot keeps the API and dashboard on loopback for the single rider. It splits recorded tracks at a two-kilometer position gap, and accepts a loop with endpoints up to 40 meters apart. GPX import also preserves recorded segment breaks and splits gaps over five minutes. The Strava collector uses its own stricter gap thresholds. Cell eligibility uses the center and the current Census boundary. Capture credit requires the full square to fit inside the loop.

## Recommended architecture for the club

Start from the pilot's **Node.js API, PostgreSQL, and Python collector**. Keep scoring in the API so imports and standings agree. Add membership and a durable Postgres job table before opening the game to the club. Add PostGIS when trips or viewport queries need server-side spatial indexes and geometry operations.

| Component | Responsibility |
| --- | --- |
| Web frontend | Mapbox map, region selector, square inspection, and both leaderboards. Swap the demo data for club-scoped API responses. |
| API | Invite-only membership and sessions, activity uploads, optional Strava OAuth and webhook endpoint, and authenticated territory and leaderboard reads. |
| Ingestion | The Python command fetches rides for the local pilot. A club worker can process queued imports, edits, and removals through the same scorer. |
| PostgreSQL | Store sparse per-ride contributions and scores for occupied cells. Grid indices support viewport queries. PostGIS can hold versioned region geometry and power vector tiles. |

### Grid and scoring

- Use a metric projection for the game grid. Start with NAD83 / UTM zone 16N (EPSG:26916) and a fixed grid origin for Indiana and Illinois. Each square is 321.8688 meters per side in projected coordinates. Key cells by grid ID, column, and row so a cell keeps the same identity across a state line or a viewport change. Store display geometry in WGS84. Choose a local projection and a new grid ID for distant trips.
- Define a cell as eligible when its center is inside the active boundary. Use authoritative boundary geometry for production and keep the source and grid version with the season. A proper segment/grid traversal finds squares between recorded GPS samples. Split tracks at long time or location gaps so missing data cannot draw shortcuts.
- For loops, snap near-closures within an agreed tolerance, node the track at intersections, polygonize the closed faces, and union the interiors. Count cells fully enclosed by that geometry. Open legs still earn pass-through points. Use fixtures for figure eights, overlapping loops, GPS gaps, border rides, and ties.
- Store one contribution per ride and cell with pass-through and capture flags. Apply contribution changes and affected totals in a single transaction. Give imports a stable source ID, and reconcile the latest source state so duplicate jobs, edits, deletes, and out-of-order events can be retried safely. Derive every tied leader from eligible ride totals.
- Serve occupied cells in the current viewport at close zoom and aggregate geometry or density at statewide zoom. Add vector tiles when measured payload size warrants them. Over two states, a full grid would contain millions of squares.

### Club access and ride sources

Start the multi-rider club rollout with explicitly submitted GPX files from riders' devices. Scope all API reads to club membership. Show club aliases, square scores, and standings, and keep raw ride traces private. Let a rider withdraw a submission and recompute the affected results.

Strava is the intended optional activity source. Its 2026 API policy limits disclosure of athlete data and has separate language for small apps, plus restrictions on storing location data. Confirm with Strava that the club's shared territory map, derived scores, leaderboards, and retention model are permitted before enabling live sync. Strava's Standard Tier supports an initial group of up to 10 athletes, and larger groups require app review. [API Agreement](https://www.strava.com/legal/api) · [API Policy](https://www.strava.com/legal/api_policy) · [Developer FAQ](https://communityhub.strava.com/developers-knowledge-base-14/strava-api-faq-12906)

If approved, put the [OAuth exchange and refresh](https://developers.strava.com/docs/authentication/) on the backend. Acknowledge [webhooks](https://developers.strava.com/docs/webhooks/) quickly, enqueue work, and fetch current activities with the athlete's permission. Support deletion, visibility changes, and disconnection from the start. Use the same scoring engine for uploads and permitted API imports, with source provenance for every ride.

## Add a map

For the frontend, register a map in [src/regions.js](src/regions.js) with its ID, label, boundary and camera bounds, and a matching GeoJSON asset under `public/regions/`. Include features with `role: "boundary"` for the play area and `role: "mask"` for the surrounding area. The optional demo area IDs choose the starting city and sample territories. A region with no demo areas starts at its full boundary. For a distant destination, set `grid` using `createGrid` from [src/grid.js](src/grid.js) and a local metric projection. Indiana and Illinois currently use simplified [U.S. Census Bureau cartographic boundaries](https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html).

Replace the pilot’s year-based player IDs with stable club member IDs when adding players. In the backend, give a trip its own boundary, grid definition, and optional scoring window. A spring-break map can then use the same renderer and rules with separate standings.
