import { readFileSync } from "node:fs";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import Envelope from "jsts/org/locationtech/jts/geom/Envelope.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Location from "jsts/org/locationtech/jts/geom/Location.js";
import IndexedPointInAreaLocator from "jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js";
import STRtree from "jsts/org/locationtech/jts/index/strtree/STRtree.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import { cellKey, cellSize, midwestGrid } from "./grid.js";

const { project } = midwestGrid;
const maxGap = 2_000;
const closeDistance = 40;
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
const bounds = projectedBoundary.getEnvelopeInternal();

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
    if (edge - t > epsilon) visit(column, row, "passed");
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

function enclosedArea(tracks) {
  const lines = tracks.map((track) => {
    const start = track[0];
    const end = track.at(-1);
    const gap = start.distance(end);
    const closed = track.length > 2 && gap > 0 && gap <= closeDistance ? [...track, start] : track;
    return factory.createLineString(closed);
  });
  const noded = UnaryUnionOp.union(factory.createMultiLineString(lines));
  const polygonizer = new Polygonizer();
  polygonizer.add(noded);
  const polygons = polygonizer.getPolygons();
  return polygons.isEmpty() ? null : UnaryUnionOp.union(polygons);
}

function coverageCheck(polygon) {
  const locator = new IndexedPointInAreaLocator(polygon);
  const edges = new STRtree();
  for (let ring = -1; ring < polygon.getNumInteriorRing(); ring++) {
    const line = ring < 0 ? polygon.getExteriorRing() : polygon.getInteriorRingN(ring);
    const coordinates = line.getCoordinates();
    for (let i = 1; i < coordinates.length; i++) {
      edges.insert(new Envelope(coordinates[i - 1], coordinates[i]), true);
    }
  }
  return (column, row) => {
    const center = new Coordinate((column + 0.5) * cellSize, (row + 0.5) * cellSize);
    if (locator.locate(center) === Location.EXTERIOR) return false;
    const envelope = new Envelope(column * cellSize, (column + 1) * cellSize, row * cellSize, (row + 1) * cellSize);
    if (edges.query(envelope).isEmpty()) return true;
    return RelateOp.covers(polygon, factory.toGeometry(envelope));
  };
}

export async function scoreIndianaRide(segments) {
  const tracks = splitTracks(segments);
  if (tracks.length === 0) return [];

  const awards = new Map();
  const outside = new Set();
  function visit(column, row, kind) {
    const key = cellKey(column, row);
    if (outside.has(key)) return;
    let award = awards.get(key);
    if (!award) {
      const center = new Coordinate((column + 0.5) * cellSize, (row + 0.5) * cellSize);
      if (eligibleArea.locate(center) === Location.EXTERIOR) {
        outside.add(key);
        return;
      }
      award = { column, row, passed: false, enclosed: false };
      awards.set(key, award);
    }
    award[kind] = true;
  }

  for (const track of tracks) {
    for (let i = 1; i < track.length; i++) visitCrossedSquares(track[i - 1], track[i], visit);
  }

  const enclosed = enclosedArea(tracks);
  let candidates = 0;
  for (let i = 0; enclosed && i < enclosed.getNumGeometries(); i++) {
    const polygon = enclosed.getGeometryN(i);
    const area = polygon.getEnvelopeInternal().intersection(bounds);
    if (area.isNull()) continue;

    const covers = coverageCheck(polygon);
    const west = Math.floor(area.getMinX() / cellSize);
    const east = Math.floor(area.getMaxX() / cellSize);
    const south = Math.floor(area.getMinY() / cellSize);
    const north = Math.floor(area.getMaxY() / cellSize);
    candidates += (east - west + 1) * (north - south + 1);
    if (candidates > maxCandidateCells) throw new RangeError("Ride encloses too large an area for a single import.");

    for (let column = west; column <= east; column++) {
      for (let row = south; row <= north; row++) {
        if (covers(column, row)) visit(column, row, "enclosed");
      }
    }
  }
  return [...awards.values()];
}
