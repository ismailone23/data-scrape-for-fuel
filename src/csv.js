export function csvEscape(value) {
  const text = String(value ?? "");

  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns, rows) {
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map(column => csvEscape(row[column])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

// Table cells come straight from the page, so the grid is written as-is rather
// than keyed by column name.
export function gridToCsv(grid) {
  return `${grid.map(cells => cells.map(csvEscape).join(",")).join("\n")}\n`;
}
