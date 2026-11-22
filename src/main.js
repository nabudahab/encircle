import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import {
  Bike, ChevronDown, Grid2X2, Grid2X2Plus, Layers, LocateFixed, MapPin,
  Maximize, Minus, MousePointer2, Plus, Trophy, Upload, X, createIcons,
} from "lucide";
import "./style.css";
import { demoFor, withYearPlayers } from "./demo.js";
import { regions } from "./regions.js";
import { createTerritoryMap, decorateCells } from "./territory-map.js";
import { readGpx, requestGame } from "./ride-import.js";
import { midwestGrid } from "./grid.js";

const $ = (id) => document.getElementById(id);
const localMode = import.meta.env.VITE_USE_LOCAL_API === "true";
const number = new Intl.NumberFormat("en-US");
const availableRegions = localMode ? regions.filter(({ id }) => id === "indiana") : regions;
let region = availableRegions[0];
let game = localMode ? { cells: [], riders: [], captures: [] } : demoFor(region);
let cells = decorateCells(game.cells, game.riders);
let board = "held";
let selectedRider = null;
let selectedSquare = null;
let liveLoading = localMode;
let liveError = false;

createIcons({
  nameAttr: "data-icon",
  icons: { Bike, ChevronDown, Grid2X2, Grid2X2Plus, Layers, LocateFixed, MapPin, Maximize, Minus, MousePointer2, Plus, Trophy, Upload, X },
  attrs: { "aria-hidden": "true", "stroke-width": 1.8 },
});

let map;
$("region-view").disabled = true;
createTerritoryMap({
  container: $("map"),
  notice: $("map-notice"),
  controls: $("map-controls"),
  initialRegion: region,
  initialCells: cells,
  onSquare: showSquare,
  onPlace: (label) => { $("map-place").textContent = label; },
  onZoom: (zoom, min, max) => {
    $("zoom-in").disabled = zoom >= max;
    $("zoom-out").disabled = zoom <= min;
  },
}).then((controller) => {
  map = controller;
  $("region-view").disabled = !map;
  map?.setGame(region, cells, { focus: localMode ? localFocus() : undefined, recenter: localMode && cells.length > 0 });
  map?.showRider(selectedRider);
}).catch((error) => {
  console.error(error);
  $("map-notice").textContent = "The map could not start. Check WebGL support and reload.";
});

function avatar(rider) {
  const element = document.createElement("span");
  element.className = "rider-avatar";
  element.style.setProperty("--rider-color", rider.color);
  element.textContent = rider.short;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function renderLeaderboard() {
  const captured = new Map(game.captures.map(({ playerId, enclosed }) => [playerId, enclosed]));
  const held = new Map(game.standings?.map(({ playerId, held: count }) => [playerId, count]));
  if (!game.standings) {
    for (const cell of cells) {
      for (const leader of cell.leaders) held.set(leader, (held.get(leader) ?? 0) + 1);
    }
  }
  const scores = board === "held" ? held : captured;
  const rankings = game.riders
    .map((rider) => ({ rider, score: scores.get(rider.id) ?? 0 }))
    .filter(({ score }) => board === "held" || score > 0)
    .sort((a, b) => b.score - a.score || a.rider.name.localeCompare(b.rider.name));

  let lastScore;
  let rank;
  const list = $("rider-list");
  const rows = rankings.map(({ rider, score }, index) => {
    if (score !== lastScore) rank = index + 1;
    lastScore = score;

    const item = document.createElement("li");
    const button = document.createElement("button");
    const position = document.createElement("span");
    const name = document.createElement("span");
    const value = document.createElement("span");
    button.className = "rider-row";
    button.type = "button";
    button.dataset.rider = rider.id;
    button.setAttribute("aria-label", `Rank ${rank}, ${rider.name}, ${number.format(score)} squares. Highlight territory.`);
    button.setAttribute("aria-pressed", String(selectedRider === rider.id));
    position.className = "rider-rank";
    position.textContent = rank;
    name.className = "rider-name";
    name.textContent = rider.name;
    value.className = "rider-value";
    value.textContent = number.format(score);
    button.append(position, avatar(rider), name, value);
    item.append(button);
    return item;
  });

  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "board-empty";
    empty.textContent = liveLoading ? "Loading ride years…" :
      liveError ? "Start the local Encircle server and reload this page." :
      board === "capture" && cells.length ? "No imported ride has closed a loop around a square yet." :
      localMode ? "Import a GPX ride to start the Indiana leaderboard." : "There are no scores in this region yet.";
    rows.push(empty);
  }
  list.replaceChildren(...rows);
}

function showSquare(key) {
  selectedSquare = key;
  const cell = key && cells.find((candidate) => candidate.key === key);
  map?.select(cell?.key);
  $("square-detail").hidden = !cell;
  if (!cell) return;

  const title = cell.leaders.length > 1 ? "Shared square" : "Square scores";
  $("square-title").textContent = title;
  const riders = new Map(game.riders.map((rider) => [rider.id, rider]));
  const results = Object.entries(cell.scores).sort((a, b) => b[1] - a[1]).map(([id, score]) => {
    const rider = riders.get(id);
    const item = document.createElement("li");
    const name = document.createElement("span");
    const value = document.createElement("strong");
    name.textContent = (rider?.name ?? id) + (cell.leaders.includes(id) ? " · in control" : "");
    value.textContent = `${score} ${score === 1 ? "pt" : "pts"}`;
    if (rider) item.append(avatar(rider));
    item.append(name, value);
    return item;
  });
  $("square-scores").replaceChildren(...results);
}

function selectRider(id) {
  selectedRider = selectedRider === id ? null : id;
  map?.showRider(selectedRider);
  for (const row of $("rider-list").querySelectorAll("[data-rider]")) {
    row.setAttribute("aria-pressed", String(row.dataset.rider === selectedRider));
  }
  $("map-filter").hidden = !selectedRider;
  if (selectedRider) {
    const rider = game.riders.find(({ id }) => id === selectedRider);
    $("clear-rider").textContent = `${rider.name} ×`;
    $("clear-rider").setAttribute("aria-label", `Clear ${rider.name} highlight`);
  }
}

function localFocus() {
  const neighborhoods = new Map();
  for (const cell of cells) {
    const key = `${Math.floor(cell.column / 32)}:${Math.floor(cell.row / 32)}`;
    const cluster = neighborhoods.get(key) ?? { column: 0, row: 0, count: 0 };
    cluster.column += cell.column;
    cluster.row += cell.row;
    cluster.count++;
    neighborhoods.set(key, cluster);
  }
  const [largest] = [...neighborhoods.values()].sort((a, b) => b.count - a.count);
  if (!largest) return undefined;
  return (region.grid ?? midwestGrid).cellCenter(largest.column / largest.count, largest.row / largest.count);
}

function applyGame(nextGame, recenter = false) {
  game = nextGame;
  cells = decorateCells(game.cells, game.riders);
  if (selectedRider && !game.riders.some(({ id }) => id === selectedRider)) selectRider(null);
  renderLeaderboard();
  map?.setGame(region, cells, { focus: localMode ? localFocus() : undefined, recenter });
  if (selectedSquare) showSquare(selectedSquare);
}

async function refreshLiveGame(recenter = false) {
  try {
    const data = await requestGame("game");
    liveError = false;
    liveLoading = false;
    applyGame(withYearPlayers(data), recenter);
  } catch (error) {
    liveLoading = false;
    liveError = true;
    renderLeaderboard();
    throw error;
  }
}

for (const item of availableRegions) $("region").add(new Option(item.label, item.id));
$("region").addEventListener("change", (event) => {
  region = availableRegions.find(({ id }) => id === event.target.value);
  selectRider(null);
  showSquare(null);
  applyGame(demoFor(region), true);
});
$("region-view").addEventListener("click", () => {
  showSquare(null);
  map?.showOverview();
});
$("map-home").addEventListener("click", () => {
  showSquare(null);
  map?.showHome();
});
$("zoom-in").addEventListener("click", () => map?.zoomIn());
$("zoom-out").addEventListener("click", () => map?.zoomOut());
$("close-square").addEventListener("click", () => showSquare(null));
$("clear-rider").addEventListener("click", () => selectRider(null));
$("rider-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-rider]");
  if (button) selectRider(button.dataset.rider);
});
for (const button of document.querySelectorAll("[data-board]")) {
  button.addEventListener("click", () => {
    board = button.dataset.board;
    for (const tab of document.querySelectorAll("[data-board]")) {
      tab.setAttribute("aria-pressed", String(tab === button));
    }
    renderLeaderboard();
  });
}
function markNavigation() {
  const active = location.hash === "#standings" ? "#standings" : "#territory";
  for (const link of document.querySelectorAll(".site-nav a")) {
    if (link.getAttribute("href") === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", markNavigation);
markNavigation();

$("open-rules").addEventListener("click", () => $("rules").showModal());
$("open-import").addEventListener("click", () => $("import-dialog").showModal());

$("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const files = [...$("gpx-files").files];
  if (!files.length) return;
  const results = $("import-results");
  const status = $("import-status");
  const submit = $("submit-import");
  results.hidden = true;
  results.replaceChildren();
  status.hidden = false;
  submit.disabled = true;
  let scored = 0;
  let duplicates = 0;
  let outside = 0;
  let failed = 0;
  for (const [index, file] of files.entries()) {
    status.textContent = `Scoring ride ${index + 1} of ${files.length}…`;
    try {
      const ride = await readGpx(file);
      const result = await requestGame("rides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ride),
      });
      if (result.duplicate) duplicates++;
      else if (!result.passed && !result.enclosed) outside++;
      else scored++;
    } catch (error) {
      failed++;
      const item = document.createElement("li");
      item.textContent = `${file.name} — ${error.message}`;
      results.append(item);
      results.hidden = false;
    }
  }
  const summary = [
    scored && `${scored} scored`, duplicates && `${duplicates} already imported`,
    outside && `${outside} with no Indiana squares`, failed && `${failed} failed`,
  ].filter(Boolean).join(", ") + ".";
  status.textContent = summary;
  if (scored) {
    await refreshLiveGame(!cells.length).catch(() => { status.textContent += " Reload the map to see the updated scores."; });
  }
  submit.disabled = false;
  $("gpx-files").value = "";
});

if (localMode) {
  $("mode-label").textContent = "Local year test";
  $("mode-badge").classList.add("local-mode");
  $("intro-description").textContent = "Your Indiana rides compete by the year you rode them.";
  $("standings-title").textContent = "Year standings";
  $("rank-label").textContent = "Rank / year";
  $("standings-summary").textContent = "One player per ride year";
  $("open-import").hidden = false;
  $("region").disabled = true;
  refreshLiveGame(true).catch(() => {});
}
renderLeaderboard();
