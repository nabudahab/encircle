# Indiana pilot API

The Node.js API starts on `127.0.0.1:3001`. The frontend connects through its Vite proxy. The pilot uses loopback access for one rider on their own computer.

## Start

1. Create an empty PostgreSQL database with your local PostgreSQL installation or Docker:

   ```sh
   docker run -d --name encircle-postgres \
     -e POSTGRES_DB=encircle -e POSTGRES_USER=encircle -e POSTGRES_PASSWORD=encircle \
     -p 127.0.0.1:5432:5432 -v encircle-pgdata:/var/lib/postgresql/data postgres:16
   ```

2. From the project root, install the dependencies and start the API:

   ```sh
   npm ci
   npm --prefix server ci
   DATABASE_URL=postgres://encircle:encircle@127.0.0.1:5432/encircle npm --prefix server start
   ```

Set `DATABASE_URL` for the database you created. Its role needs permission to create the schema and tables at startup. `ENCIRCLE_API_PORT` lets you choose a different port.

## API

| Request | Result |
| --- | --- |
| `GET /api/health` | Checks that the server can query PostgreSQL. |
| `GET /api/game` | Returns `cells` with per-year scores, `standings` with statewide held square counts, and `captures` with the best single-ride enclosure for each year. Supply `minColumn`, `minRow`, `maxColumn`, and `maxRow` to limit the returned cells. Bounds use inclusive grid indexes. |
| `POST /api/rides` | Takes `{startedAt, segments}`, where `startedAt` is an ISO timestamp with a time zone and `segments` is an array of tracks containing `[longitude, latitude]` pairs. Returns `{id, playerId, passed, enclosed, duplicate}`. |
| `DELETE /api/rides/:id` | Withdraws the ride and returns `{deleted}`. |

A ride belongs to the year in which it started in the America/Indiana/Indianapolis time zone. Each year acts as one player. The API deduplicates matching timestamps and tracks and writes rides only when they earn Indiana awards. Edits to the timestamp or track can produce a new ride ID. To replace an imported ride, withdraw the old ID and import the edited recording.

## Storage

PostgreSQL holds one row per scored square. Each row includes the positive totals for every year with points there. These totals let a challenger overtake the current leader, and every tied leader counts the square in their standing. The scorer sends compact cell deltas to PostgreSQL for deduplication and withdrawal.

Each import applies a set-based write to the squares that received points. Each withdrawal subtracts the saved contributions from those squares, removing year totals and square rows as they reach zero. The ride ledger and touched squares change atomically. Standings are calculated from the resulting rows.
