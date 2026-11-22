import { readFileSync } from "node:fs";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Location from "jsts/org/locationtech/jts/geom/Location.js";
import IndexedPointInAreaLocator from "jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import { cellKey, cellSize, midwestGrid } from "./grid.js";

const { project } = midwestGrid;
export const scoringVersion = 3;
const maxGap = 2_000;
const maxCandidateCells = 200_000;
const factory = new GeometryFactory();
const document = JSON.parse(readFileSync(new URL("../public/regions/indiana.geojson", import.meta.url), "utf8"));
const boundary = document.features.find((feature) => feature.properties.role === "boundary").geometry;
const projectedBoundary = new GeoJSONReader(factory).read({
  type: "MultiPolygon",
  coordinates: (boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates)
    .map((polygon) => polygon.map((ring) => ring.map(project))),
});
const eligibleArea = new IndexedPointInAreaLocator(projectedBoundary);

function splitTracks(segments) {
  const tracks = [];
  for (const segment of segments) {
    let track = [];
    for (const point of segment) {
      // Segments with endpoints this far outside Indiana cannot reach it across an allowed GPS gap.
      const [longitude, latitude] = point;
      if (longitude < -88.2 || longitude > -84.68 || latitude < 37.67 || latitude > 41.87) {
        if (track.length > 1) tracks.push(track);
        track = [];
        continue;
      }
      const [x, y] = project(point).map((value) => Math.round(value * 100) / 100);
      const previous = track.at(-1);
      if (previous) {
        const gap = Math.hypot(x - previous.x, y - previous.y);
        if (gap === 0) continue;
        if (gap > maxGap) {
          if (track.length > 1) tracks.push(track);
          track = [];
        }
      }
      track.push(new Coordinate(x, y));
    }
    if (track.length > 1) tracks.push(track);
  }
  return tracks;
}

function visitCrossedSquares(start, end, visit) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const intervalX = stepX ? cellSize / Math.abs(dx) : Infinity;
  const intervalY = stepY ? cellSize / Math.abs(dy) : Infinity;
  let column = Math.floor(start.x / cellSize);
  let row = Math.floor(start.y / cellSize);
  let edgeX = stepX ? ((column + (stepX > 0 ? 1 : 0)) * cellSize - start.x) / dx : Infinity;
  let edgeY = stepY ? ((row + (stepY > 0 ? 1 : 0)) * cellSize - start.y) / dy : Infinity;
  let t = 0;
  const epsilon = 1e-10;

  while (t < 1 - epsilon) {
    const edge = Math.min(edgeX, edgeY, 1);
    if (edge - t > epsilon) visit(column, row);
    if (edgeX <= edge + epsilon) {
      column += stepX;
      edgeX += intervalX;
    }
    if (edgeY <= edge + epsilon) {
      row += stepY;
      edgeY += intervalY;
    }
    t = edge;
  }
}

function visitEnclosedSquares(crossed, visit) {
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (const [column, row] of crossed.values()) {
    left = Math.min(left, column - 1);
    right = Math.max(right, column + 1);
    bottom = Math.min(bottom, row - 1);
    top = Math.max(top, row + 1);
  }
  const width = right - left + 1;
  const height = top - bottom + 1;
  const indexAt = (column, row) => (row - bottom) * width + column - left;
  const open = 0;
  const wall = 1;
  const exterior = 2;
  const bridge = 3;
  const state = new Uint8Array(width * height);
  for (const [column, row] of crossed.values()) {
    state[indexAt(column, row)] = wall;
  }

  // The empty one-square margin makes the lower-left corner an exterior seed.
  // Four-way traversal treats diagonally touching wall cells as connected.
  const queue = new Int32Array(state.length);
  let size = 0;
  function enter(index) {
    if (state[index] !== open) return;
    state[index] = exterior;
    queue[size++] = index;
  }
  function fillExterior() {
    size = 0;
    enter(0);
    for (let i = 0; i < size; i++) {
      const index = queue[i];
      const column = index % width;
      if (column > 0) enter(index - 1);
      if (column < width - 1) enter(index + 1);
      if (index >= width) enter(index - width);
      if (index + width < state.length) enter(index + width);
    }
  }
  fillExterior();

  let bridged = false;
  function bridgeAt(column, row) {
    const index = indexAt(column, row);
    if (state[index] !== exterior) return;
    state[index] = bridge;
    bridged = true;
  }
  const anchorOffsets = [[2, -2], [2, -1], [2, 0], [2, 1], [2, 2], [-1, 2], [0, 2], [1, 2]];
  for (const [column, row] of crossed.values()) {
    for (const [dx, dy] of anchorOffsets) {
      // A bridge spans exactly one missing square and uses only recorded anchors.
      if (!crossed.has(cellKey(column + dx, row + dy))) continue;
      bridgeAt(column + Math.floor(dx / 2), row + Math.floor(dy / 2));
      bridgeAt(column + Math.ceil(dx / 2), row + Math.ceil(dy / 2));
    }
  }
  if (bridged) {
    for (let i = 0; i < size; i++) {
      if (state[queue[i]] === exterior) state[queue[i]] = open;
    }
    fillExterior();
  }

  let candidates = 0;
  for (let index = 0; index < state.length; index++) {
    // Bridge candidates wholly inside the final outline are ordinary interior
    // squares. Only candidates on the exterior edge act as unscored walls.
    if (state[index] === bridge) {
      if (state[index - 1] === exterior || state[index + 1] === exterior ||
          state[index - width] === exterior || state[index + width] === exterior) continue;
    } else if (state[index] !== open) continue;
    if (++candidates > maxCandidateCells) throw new RangeError("Ride encloses too large an area for a single import.");
    visit(left + index % width, bottom + Math.floor(index / width));
  }
}

export async function scoreIndianaRide(segments) {
  const tracks = splitTracks(segments);
  const crossed = new Map();
  for (const track of tracks) {
    for (let i = 1; i < track.length; i++) {
      visitCrossedSquares(track[i - 1], track[i], (column, row) => {
        const key = cellKey(column, row);
        if (!crossed.has(key)) crossed.set(key, [column, row]);
      });
    }
  }
  if (!crossed.size) return [];

  const awards = [];
  function addAward(column, row, passed, enclosed) {
    const center = new Coordinate((column + 0.5) * cellSize, (row + 0.5) * cellSize);
    if (eligibleArea.locate(center) !== Location.EXTERIOR) {
      awards.push({ column, row, passed, enclosed });
    }
  }
  for (const [column, row] of crossed.values()) addAward(column, row, true, false);
  visitEnclosedSquares(crossed, (column, row) => addAward(column, row, false, true));
  return awards;
}
