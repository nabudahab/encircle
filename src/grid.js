import proj4 from "proj4";

export const cellSize = 321.8688;
export const midwestProjection = "+proj=utm +zone=16 +datum=NAD83 +units=m +no_defs";

export function createGrid(definition) {
  const projection = proj4("WGS84", definition);
  const project = (coordinates) => projection.forward(coordinates.slice(0, 2));
  const unproject = (coordinates) => projection.inverse(coordinates);

  function cellAt(coordinates) {
    const [x, y] = project(coordinates);
    return [Math.floor(x / cellSize), Math.floor(y / cellSize)];
  }

  function cellCenter(column, row) {
    return unproject([(column + 0.5) * cellSize, (row + 0.5) * cellSize]);
  }

  return { project, unproject, cellAt, cellCenter };
}

export const midwestGrid = createGrid(midwestProjection);

export function cellCorners(column, row) {
  const x = column * cellSize;
  const y = row * cellSize;
  return [[x, y], [x + cellSize, y], [x + cellSize, y + cellSize], [x, y + cellSize]];
}

export function cellKey(column, row) {
  return `${column}:${row}`;
}
