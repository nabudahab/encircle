CREATE SCHEMA IF NOT EXISTS encircle;

CREATE TABLE IF NOT EXISTS encircle.rides (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    started_at timestamptz NOT NULL,
    player_id text NOT NULL CHECK (player_id ~ '^[0-9]{4}$'),
    passed integer NOT NULL CHECK (passed >= 0),
    enclosed integer NOT NULL CHECK (enclosed >= 0),
    awards jsonb NOT NULL CHECK (jsonb_array_length(awards) > 0)
);

ALTER TABLE encircle.rides ADD COLUMN IF NOT EXISTS scoring_version smallint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS encircle.cells (
    column_index integer NOT NULL,
    row_index integer NOT NULL,
    scores jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'object' AND scores <> '{}'::jsonb),
    PRIMARY KEY (column_index, row_index)
);
