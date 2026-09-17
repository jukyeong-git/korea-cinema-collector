// Seat tokens are indivisible; the suffix counts omitted seats, not ranges.
export function formatReleasedSeats(labels: string[]): string {
  const sorted = [...new Set(labels)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const tokens: Array<{ text: string; count: number }> = [];
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i], match = /^([A-Z]+)([1-9]\d*)$/.exec(start);
    if (!match) throw Error("Invalid notification seat label");
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === `${match[1]}${Number(match[2]) + end + 1 - i}`) end++;
    tokens.push({ text: end > i ? `${start}–${sorted[end]}` : start, count: end - i + 1 });
    i = end + 1;
  }
  for (let keep = tokens.length; keep >= 0; keep--) {
    const selected = tokens.slice(0, keep), omitted = sorted.length - selected.reduce((n, t) => n + t.count, 0);
    const line = `🪑 ${[...selected.map(t => t.text), ...(omitted ? [`+${omitted}석`] : [])].join(" · ")}`;
    if ([...line].length <= 60) return line;
  }
  throw Error("Cannot format seat labels");
}
