import { cellKey, midwestGrid } from "./grid.js";

export const colors = ["#bc8e3b", "#7187d2", "#469e80", "#c56e91", "#54a5bd", "#b77953", "#9273b7"];

const names = ["Maya Chen", "Jordan Reyes", "Avery Patel", "Sam Brooks", "Riley Moore"];
const riders = names.map((name, index) => ({
  id: String(index),
  name,
  short: name.split(" ").map((word) => word[0]).join(""),
  color: colors[index],
}));

const patches = {
  lafayette: [
    [[-86.975, 40.449], 0, ["..xxx..", ".xxxxxx", "xxxxxxx", "xxxxx..", ".xxx...", "..xx..."]],
    [[-86.951, 40.427], 1, ["..xxx..", ".xxxx..", "xxxxsxx", "xxxxsss", ".xxxxx.", "..xxxx."]],
    [[-86.925, 40.440], 2, ["...xxx.", ".xxxxxx", ".xxxxxx", "xxxxxx.", "xx....."]],
    [[-86.908, 40.411], 0, ["...xxxx", ".xxxxxx", "xxxxxss", "xxxxsss", "xxxxxx.", "..xxxx.", "..xx..."]],
    [[-86.886, 40.453], 3, ["..xx...", ".xxxx..", "xxxxxxx", ".xxxxx.", "..xx..."]],
    [[-86.891, 40.397], 4, ["...xx..", "..xxxxx", ".xxxxxx", "xxxx...", ".xx...."]],
    [[-86.971, 40.397], 2, ["..xx...", ".xxxx..", "xxxxxxx", ".xxxxxx", "..xxx.."]],
    [[-86.863, 40.427], 1, ["...x...", ".xxxx..", "xxxxxxx", ".xxxxx.", ".xx...."]],
    [[-86.928, 40.469], 0, ["...xxx.", "..xxxxx", "xxxxxxx", ".xxxxx.", ".xxx..."]],
    [[-86.912, 40.380], 0, ["..xxx..", ".xxxx..", ".xxxxx.", "xxxx...", "xx....."]],
  ],
  champaign: [
    [[-88.283, 40.135], 3, ["...xx..", "..xxxx.", "xxxxxxx", "xxxxss.", ".xx...."]],
    [[-88.250, 40.106], 0, ["..xxx..", ".xxxxxx", "xxxssxx", "xxxxsss", "xxxxxx.", "..xxx.."]],
    [[-88.221, 40.122], 1, ["...xxx.", ".xxxxx.", "xxxxxxx", "xxxxxx.", ".xxx..."]],
    [[-88.213, 40.089], 2, ["..xx...", ".xxxx..", "xxxxxxx", ".xxxxx.", "....xx."]],
    [[-88.268, 40.078], 4, ["..x....", ".xxxxx.", "xxxxxxx", ".xx...."]],
  ],
};

const records = {
  lafayette: [34, 48, 22, 28, 14],
  champaign: [24, 19, 11, 31, 15],
};

export function demoFor(region) {
  const { cellAt } = region.grid ?? midwestGrid;
  const cells = new Map();
  const best = new Map();

  for (const area of region.areas) {
    for (const [center, owner, pattern] of patches[area] ?? []) {
      const [originColumn, originRow] = cellAt(center);
      pattern.forEach((line, y) => {
        [...line].forEach((symbol, x) => {
          if (symbol === ".") return;
          const column = originColumn + x - Math.floor(line.length / 2);
          const row = originRow - y + Math.floor(pattern.length / 2);
          const score = 2 + (x + 2 * y) % 5;
          const challenger = (owner + 1) % riders.length;
          const scores = { [owner]: score, [challenger]: symbol === "s" ? score : score - 1 };
          cells.set(cellKey(column, row), { column, row, scores });
        });
      });
    }
    records[area]?.forEach((value, index) => {
      const id = String(index);
      best.set(id, Math.max(best.get(id) ?? 0, value));
    });
  }

  return {
    riders,
    cells: [...cells.values()],
    captures: [...best].map(([playerId, enclosed]) => ({ playerId, enclosed })),
  };
}

export function withYearPlayers(game) {
  const ids = new Set(game.captures.map(({ playerId }) => playerId));
  for (const { scores } of game.cells) {
    for (const id of Object.keys(scores)) ids.add(id);
  }
  return {
    ...game,
    riders: [...ids].sort().map((id) => ({
      id,
      name: id,
      short: id.slice(-2),
      color: colors[Number(id) % colors.length],
    })),
  };
}
