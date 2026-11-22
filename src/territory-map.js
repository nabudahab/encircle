import { cellCorners, cellKey, cellSize, midwestGrid } from "./grid.js";
import { demoAreas } from "./regions.js";

const collection = (features = []) => ({ type: "FeatureCollection", features });
const basemap = "https://tiles.openfreemap.org/styles/liberty";
const localStyle = {
  version: 8,
  sources: {},
  layers: [{ id: "land", type: "background", paint: { "background-color": "#eef0e4" } }],
};

function regionSource(region) {
  return `${import.meta.env.BASE_URL}regions/${region.id}.geojson`;
}

function sharedPattern() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const context = canvas.getContext("2d");
  context.fillStyle = "#d7c499";
  context.fillRect(0, 0, 16, 16);
  context.strokeStyle = "#666757";
  context.lineWidth = 3;
  context.beginPath();
  for (const x of [-16, -8, 0, 8]) {
    context.moveTo(x, 16);
    context.lineTo(x + 16, 0);
  }
  context.stroke();
  return context.getImageData(0, 0, 16, 16);
}

function visibleGrid(map, { cellAt, unproject }) {
  if (map.getZoom() < 11) return collection();
  const bounds = map.getBounds();
  if (!bounds) return collection();
  const corners = [bounds.getSouthWest(), bounds.getSouthEast(), bounds.getNorthEast(), bounds.getNorthWest()];
  const indices = corners.map((point) => cellAt(point.toArray()));
  const left = Math.min(...indices.map(([column]) => column));
  const right = Math.max(...indices.map(([column]) => column)) + 1;
  const bottom = Math.min(...indices.map(([, row]) => row));
  const top = Math.max(...indices.map(([, row]) => row)) + 1;
  const lines = [];
  const line = (from, to) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [unproject(from), unproject(to)] },
  });
  for (let x = left; x <= right; x++) {
    lines.push(line([x * cellSize, bottom * cellSize], [x * cellSize, top * cellSize]));
  }
  for (let y = bottom; y <= top; y++) {
    lines.push(line([left * cellSize, y * cellSize], [right * cellSize, y * cellSize]));
  }
  return collection(lines);
}

export async function createTerritoryMap({
  container, notice, controls, initialRegion, initialCells, onSquare, onPlace, onZoom,
}) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN?.trim();
  const [module] = await (token
    ? Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")])
    : Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]));
  const renderer = module.default ?? module;
  if (!token) {
    const { default: workerUrl } = await import("maplibre-gl/dist/maplibre-gl-worker.mjs?url");
    renderer.setWorkerUrl(workerUrl);
  }
  if (renderer.supported && !renderer.supported()) {
    notice.textContent = "This browser needs WebGL to display the map. Standings are still available.";
    return null;
  }

  let region = initialRegion;
  let cells = initialCells;
  let currentRider = null;
  let selected = "";
  let dataFocus = null;
  let overview = false;
  let styleReady = false;
  let fallback = false;
  let pointFeatures = [];
  const defaultView = demoAreas[region.areas[0]];
  const map = new renderer.Map({
    container,
    style: token ? "mapbox://styles/mapbox/outdoors-v12" : basemap,
    ...(token ? { accessToken: token, projection: "mercator" } : {}),
    center: defaultView?.center ?? region.bounds[0],
    zoom: defaultView?.zoom ?? 6.5,
    maxBounds: region.cameraBounds,
    maxZoom: 17,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    renderWorldCopies: false,
  });
  map.getCanvas().setAttribute("aria-label", "Territory map. Use the arrow keys to pan and plus or minus to zoom.");

  const featureId = ["get", "key"];
  const matchesRider = () => currentRider ? ["in", `|${currentRider}|`, ["get", "owners"]] : true;
  const opacity = (visible, dimmed) => ["case", matchesRider(), visible, dimmed];

  function refreshGrid() {
    map.getSource("grid")?.setData(visibleGrid(map, region.grid ?? midwestGrid));
  }

  function refreshCells() {
    const { cellCenter, unproject } = region.grid ?? midwestGrid;
    const features = [];
    const points = [];
    for (const cell of cells) {
      const { column, row, key, leaders, color } = cell;
      const ring = cellCorners(column, row).map(unproject);
      const properties = { key, color, shared: leaders.length > 1, owners: `|${leaders.join("|")}|` };
      features.push({
        type: "Feature", properties, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      });
      points.push({
        type: "Feature", properties, geometry: { type: "Point", coordinates: cellCenter(column, row) },
      });
    }
    map.getSource("territory")?.setData(collection(features));
    pointFeatures = points;
    refreshPoints();
  }

  function refreshPoints() {
    const features = currentRider
      ? pointFeatures.filter(({ properties }) => properties.owners.includes(`|${currentRider}|`))
      : pointFeatures;
    map.getSource("territory-points")?.setData(collection(features));
  }

  function showRider(id) {
    currentRider = id;
    if (!map.getLayer("territory-fill")) return;
    map.setPaintProperty("territory-fill", "fill-opacity", opacity(0.64, 0.13));
    map.setPaintProperty("territory-shared", "fill-opacity", opacity(0.82, 0.18));
    map.setPaintProperty("territory-outlines", "line-opacity", opacity(0.82, 0.18));
    refreshPoints();
  }

  function select(key) {
    selected = key ?? "";
    if (map.getLayer("territory-selected")) map.setFilter("territory-selected", ["==", featureId, selected]);
  }

  function viewInRegion() {
    if (overview) {
      onPlace(region.label);
      return;
    }
    const center = map.getCenter();
    const area = region.areas.map((id) => demoAreas[id]).find((area) => area &&
      Math.hypot(center.lng - area.center[0], center.lat - area.center[1]) < 0.16);
    onPlace(map.getZoom() >= 10 && area ? area.label : region.label);
  }

  function showOverview(animated = true) {
    overview = true;
    map.fitBounds(region.bounds, { padding: 30, duration: animated ? 550 : 0 });
    viewInRegion();
  }

  function showHome(animated = true) {
    overview = false;
    const local = dataFocus ? { center: dataFocus, zoom: 11.6 } : demoAreas[region.areas[0]];
    if (!local) {
      showOverview(animated);
      return;
    }
    map.easeTo({ ...local, duration: animated ? 500 : 0 });
  }

  map.on("style.load", () => {
    styleReady = true;
    map.addSource("region", { type: "geojson", data: regionSource(region) });
    map.addSource("grid", { type: "geojson", data: collection() });
    map.addSource("territory", { type: "geojson", data: collection() });
    map.addSource("territory-points", { type: "geojson", data: collection(), cluster: true, clusterRadius: 22, clusterMaxZoom: 9 });
    map.addLayer({
      id: "grid-lines", type: "line", source: "grid", minzoom: 11,
      paint: { "line-color": "#668777", "line-width": 0.6, "line-opacity": 0.27 },
    });
    map.addLayer({
      id: "region-mask", type: "fill", source: "region", filter: ["==", ["get", "role"], "mask"],
      paint: { "fill-color": "#e5e8dc", "fill-opacity": 0.84 },
    });
    map.addLayer({
      id: "region-outline", type: "line", source: "region", filter: ["==", ["get", "role"], "boundary"],
      paint: { "line-color": "#52685a", "line-width": 1.65, "line-opacity": 0.8, "line-dasharray": [3, 2] },
    });
    map.addImage("shared-ownership", sharedPattern(), { pixelRatio: 2 });
    map.addLayer({
      id: "territory-fill", type: "fill", source: "territory", minzoom: 9.5,
      filter: ["!", ["get", "shared"]],
      paint: { "fill-color": ["get", "color"], "fill-opacity": opacity(0.64, 0.13) },
    });
    map.addLayer({
      id: "territory-shared", type: "fill", source: "territory", minzoom: 9.5,
      filter: ["get", "shared"],
      paint: { "fill-pattern": "shared-ownership", "fill-opacity": opacity(0.82, 0.18) },
    });
    map.addLayer({
      id: "territory-outlines", type: "line", source: "territory", minzoom: 9.5,
      paint: { "line-color": ["case", ["get", "shared"], "#666757", ["get", "color"]], "line-width": 1.15, "line-opacity": opacity(0.82, 0.18) },
    });
    map.addLayer({
      id: "territory-selected", type: "line", source: "territory", minzoom: 9.5,
      filter: ["==", featureId, selected],
      paint: { "line-color": "#1e3228", "line-width": 3 },
    });
    map.addLayer({
      id: "territory-cluster", type: "circle", source: "territory-points", maxzoom: 9.5,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#b58c4b", "circle-opacity": 0.87, "circle-stroke-color": "#fffdf7", "circle-stroke-width": 2,
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 5, 50, 9, 300, 15],
      },
    });
    map.addLayer({
      id: "territory-dot", type: "circle", source: "territory-points", maxzoom: 9.5,
      filter: ["all", ["!", ["has", "point_count"]], matchesRider()],
      paint: { "circle-color": ["get", "color"], "circle-radius": 3.5, "circle-stroke-color": "#fffdf7", "circle-stroke-width": 1 },
    });
    refreshCells();
    refreshGrid();
    controls.hidden = false;
    notice.hidden = !fallback;
    viewInRegion();
    onZoom(map.getZoom(), map.getMinZoom(), map.getMaxZoom());
  });

  map.on("error", ({ error }) => {
    if (token && (error.status === 401 || error.status === 403 || /valid Mapbox access token/.test(error.message))) {
      notice.textContent = "Check your Mapbox token or remove it to use the OpenFreeMap preview.";
      notice.hidden = false;
      return;
    }
    if (styleReady || fallback || map.getStyle()?.layers?.length) return;
    useLocalStyle();
  });
  const fallbackTimer = window.setTimeout(() => {
    if (!styleReady && !fallback) useLocalStyle();
  }, 8_000);
  map.once("style.load", () => clearTimeout(fallbackTimer));

  function useLocalStyle() {
    fallback = true;
    notice.textContent = "Basemap unavailable. Territory is still visible.";
    map.setStyle(localStyle, { diff: false });
  }

  function featuresAt(point, ids) {
    const layers = ids.filter((id) => map.getLayer(id));
    return layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
  }

  map.on("click", (event) => {
    const [cell] = featuresAt(event.point, ["territory-fill", "territory-shared"]);
    if (cell) {
      onSquare(cell.properties.key);
      return;
    }
    const [point] = featuresAt(event.point, ["territory-cluster", "territory-dot"]);
    if (point) {
      overview = false;
      onSquare(null);
      map.easeTo({ center: point.geometry.coordinates, zoom: 11.6, duration: 500 });
      return;
    }
    onSquare(null);
  });

  map.on("mousemove", (event) => {
    const clickable = featuresAt(event.point, ["territory-fill", "territory-shared", "territory-cluster", "territory-dot"]);
    map.getCanvas().style.cursor = clickable.length ? "pointer" : "";
  });
  map.on("movestart", (event) => {
    if (event.originalEvent) overview = false;
  });
  map.on("moveend", () => {
    refreshGrid();
    viewInRegion();
    onZoom(map.getZoom(), map.getMinZoom(), map.getMaxZoom());
  });
  new ResizeObserver(() => {
    map.resize();
    refreshGrid();
  }).observe(container);

  return {
    setGame(nextRegion, nextCells, { focus, recenter = false } = {}) {
      const changed = region.id !== nextRegion.id;
      region = nextRegion;
      cells = nextCells;
      dataFocus = focus;
      if (changed) {
        map.setMaxBounds(region.cameraBounds);
        map.getSource("region")?.setData(regionSource(region));
      }
      refreshCells();
      if (recenter || changed) showHome(false);
    },
    showRider,
    select,
    showHome,
    showOverview,
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
  };
}

export function decorateCells(cells, riders) {
  const colors = new Map(riders.map(({ id, color }) => [id, color]));
  return cells.map((cell) => {
    const best = Math.max(...Object.values(cell.scores));
    const leaders = Object.keys(cell.scores).filter((id) => cell.scores[id] === best);
    return { ...cell, key: cellKey(cell.column, cell.row), leaders, color: colors.get(leaders[0]) ?? "#7b866d" };
  });
}
