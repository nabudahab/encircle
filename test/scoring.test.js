import assert from "node:assert/strict";
import test from "node:test";
import { cellKey, midwestGrid } from "../src/grid.js";
import { scoreIndianaRide } from "../src/scoring.js";

const [column, row] = midwestGrid.cellAt([-86.9, 40.43]);
const coordinates = (track) => track.map(([x, y]) => midwestGrid.cellCenter(column + x, row + y));
const keyAt = (x, y) => cellKey(column + x, row + y);
const score = (...tracks) => scoreIndianaRide(tracks.map(coordinates));
const captured = (awards) => new Set(awards.filter(({ enclosed }) => enclosed)
  .map(({ column, row }) => cellKey(column, row)));

test("a closed outline fills all of its interior, including cells near corners", async () => {
  const loop = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
  const awards = await score(loop, loop);
  assert.equal(awards.length, 36);
  assert.equal(captured(awards).size, 16);
  assert.ok(captured(awards).has(keyAt(1, 1)));
  assert.ok(awards.every(({ passed, enclosed }) => passed !== enclosed));
});

test("one missing wall square between recorded sections closes the loop", async () => {
  const awards = await score([[0, 0], [2, 0]], [[4, 0], [6, 0], [6, 5], [0, 5], [0, 0]]);
  assert.ok(captured(awards).has(keyAt(3, 2)));
  assert.ok(!awards.some(({ column, row }) => cellKey(column, row) === keyAt(3, 0)));
});

test("two missing wall squares leave a loop open", async () => {
  const awards = await score([[0, 0], [2, 0]], [[5, 0], [6, 0], [6, 5], [0, 5], [0, 0]]);
  assert.equal(captured(awards).size, 0);
});

test("a diagonal outline encloses the grid squares inside it", async () => {
  const awards = await score([[0, 3], [3, 0], [6, 3], [3, 6], [0, 3]]);
  assert.ok(captured(awards).has(keyAt(3, 3)));
});

test("a missing square along a diagonal edge can close the outline", async () => {
  const awards = await score([[0, 3], [1, 2]], [[3, 0], [6, 3], [3, 6], [0, 3]]);
  assert.ok(captured(awards).has(keyAt(3, 3)));
  assert.ok(!awards.some(({ column, row }) => cellKey(column, row) === keyAt(2, 1)));
});

test("a one-square gap at a bend can close the outline", async () => {
  const awards = await score([[0, 0], [2, 0]], [[4, 1], [6, 1], [6, 5], [0, 5], [0, 0]]);
  assert.ok(captured(awards).has(keyAt(3, 2)));
});

test("independent rides retain their own open outlines", async () => {
  const left = [[3, 0], [0, 0], [0, 5], [3, 5]];
  const right = [[3, 5], [6, 5], [6, 0], [3, 0]];
  assert.equal(captured(await score(left)).size, 0);
  assert.equal(captured(await score(right)).size, 0);
  assert.ok(captured(await score(left, right)).has(keyAt(3, 3)));
});
