import { readFile } from 'node:fs/promises';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');

// Serializing writes keeps a cell's scores consistent across imports and removals.
async function writeTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(730219, 1)');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(pool) {
  await writeTransaction(pool, (client) => client.query(schema));
}

export async function getRide(connection, id) {
  const { rows } = await connection.query(
    `SELECT player_id AS "playerId", passed, enclosed, scoring_version AS "scoringVersion"
     FROM encircle.rides WHERE id = $1`,
    [id],
  );
  return rows[0];
}

export async function saveRide(pool, ride, awards) {
  return writeTransaction(pool, async (client) => {
    const existing = await getRide(client, ride.id);
    if (existing?.scoringVersion >= ride.scoringVersion) return false;
    if (existing) await withdrawRide(client, ride.id);
    if (!awards.length) return true;

    await client.query(
      `INSERT INTO encircle.rides (id, started_at, player_id, passed, enclosed, awards, scoring_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ride.id, ride.startedAt, ride.playerId, ride.passed, ride.enclosed, JSON.stringify(awards), ride.scoringVersion],
    );

    await client.query(
      `INSERT INTO encircle.cells (column_index, row_index, scores)
       SELECT (award->>0)::integer, (award->>1)::integer,
              jsonb_build_object($1::text, (award->>2)::integer)
       FROM encircle.rides, LATERAL jsonb_array_elements(awards) AS entries(award)
       WHERE id = $2
       ON CONFLICT (column_index, row_index) DO UPDATE
       SET scores = cells.scores || jsonb_build_object(
         $1::text,
         COALESCE((cells.scores->>$1)::integer, 0) + (EXCLUDED.scores->>$1)::integer
       )`,
      [ride.playerId, ride.id],
    );
    return true;
  });
}

async function withdrawRide(client, id) {
  const { rows } = await client.query(
    `WITH removed AS (
       DELETE FROM encircle.rides WHERE id = $1 RETURNING player_id, awards
     ), affected AS (
       SELECT cells.column_index, cells.row_index,
              CASE WHEN (cells.scores->>removed.player_id)::integer = (award->>2)::integer
                   THEN cells.scores - removed.player_id
                   ELSE cells.scores || jsonb_build_object(
                     removed.player_id,
                     (cells.scores->>removed.player_id)::integer - (award->>2)::integer
                   )
              END AS scores
       FROM removed
       CROSS JOIN LATERAL jsonb_array_elements(removed.awards) AS entries(award)
       JOIN encircle.cells ON cells.column_index = (award->>0)::integer
                          AND cells.row_index = (award->>1)::integer
     ), updated AS (
       UPDATE encircle.cells
       SET scores = affected.scores
       FROM affected
       WHERE cells.column_index = affected.column_index
         AND cells.row_index = affected.row_index
         AND affected.scores <> '{}'::jsonb
     ), emptied AS (
       DELETE FROM encircle.cells
       USING affected
       WHERE cells.column_index = affected.column_index
         AND cells.row_index = affected.row_index
         AND affected.scores = '{}'::jsonb
     )
     SELECT EXISTS(SELECT 1 FROM removed) AS deleted`,
    [id],
  );
  return rows[0].deleted;
}

export async function removeRide(pool, id) {
  return writeTransaction(pool, (client) => withdrawRide(client, id));
}

export async function getGame(pool, bounds) {
  const { rows } = await pool.query(
    `WITH cell_rankings AS (
       SELECT score.player_id,
              rank() OVER (
                PARTITION BY cells.column_index, cells.row_index
                ORDER BY score.points::integer DESC
              ) AS cell_rank
       FROM encircle.cells
       CROSS JOIN LATERAL jsonb_each_text(cells.scores) AS score(player_id, points)
     ), holdings AS (
       SELECT player_id, count(*)::integer AS held
       FROM cell_rankings
       WHERE cell_rank = 1
       GROUP BY player_id
     ), best_captures AS (
       SELECT player_id AS "playerId", max(enclosed) AS enclosed
       FROM encircle.rides
       GROUP BY player_id
     ), standings AS (
       SELECT best_captures."playerId", COALESCE(holdings.held, 0) AS held
       FROM best_captures
       LEFT JOIN holdings ON holdings.player_id = best_captures."playerId"
     ), viewport AS (
       SELECT column_index AS "column", row_index AS "row", scores
       FROM encircle.cells
       WHERE $1::integer IS NULL
          OR (column_index BETWEEN $1 AND $3 AND row_index BETWEEN $2 AND $4)
     )
     SELECT COALESCE((SELECT jsonb_agg(viewport) FROM viewport), '[]'::jsonb) AS cells,
            COALESCE((SELECT jsonb_agg(best_captures) FROM best_captures), '[]'::jsonb) AS captures,
            COALESCE((SELECT jsonb_agg(standings) FROM standings), '[]'::jsonb) AS standings`,
    bounds ?? [null, null, null, null],
  );
  return rows[0];
}
