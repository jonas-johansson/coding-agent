/**
 * Lightweight fuzzy subsequence matcher used by interactive pickers.
 *
 * A query matches a candidate when its characters appear in the candidate in
 * order (case-insensitive). The returned score rewards consecutive runs,
 * matches at word boundaries, and matches near the start of the candidate so
 * that the most relevant results can be sorted to the top.
 */

export type FuzzyMatch = {
  /** Higher is a better match. */
  score: number;
  /** Indices in the candidate string that matched, in ascending order. */
  positions: number[];
};

const BOUNDARY_CHARS = new Set(["/", "-", ".", "_", " ", ":"]);

function isAtBoundary(text: string, index: number): boolean {
  return index === 0 || BOUNDARY_CHARS.has(text[index - 1]);
}

/**
 * Returns match details if every character of `query` appears in `text` in
 * order, otherwise `undefined`. An empty query matches everything with a
 * neutral score so callers can preserve the original ordering.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  if (query.length === 0) {
    return { score: 0, positions: [] };
  }

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;

  // --- Exact-substring bonuses --------------------------------------------
  let exactBonus = 0;
  if (t.startsWith(q)) {
    exactBonus = 300;
  } else {
    let best = 0;
    let idx = t.indexOf(q);
    while (idx !== -1) {
      let bonus = 100;
      if (idx === 0 || BOUNDARY_CHARS.has(t[idx - 1])) {
        bonus = 200;
      }
      best = Math.max(best, bonus);
      idx = t.indexOf(q, idx + 1);
    }
    exactBonus = best;
  }

  // --- DP over text positions ---------------------------------------------
  // Each row is a Map<textPosition, entry> for the corresponding query char.
  type Entry = { pos: number; score: number; pred: number };
  const rows: Map<number, Entry>[] = [];

  // First query character.
  const firstRow = new Map<number, Entry>();
  for (let j = 0; j < n; j++) {
    if (t[j] === q[0]) {
      let score = 1;
      if (isAtBoundary(t, j)) score += 15;
      score += Math.max(0, 10 - j);
      firstRow.set(j, { pos: j, score, pred: -1 });
    }
  }

  if (firstRow.size === 0) {
    return undefined;
  }
  rows.push(firstRow);

  // Remaining query characters.
  for (let i = 1; i < m; i++) {
    const prevRow = rows[i - 1];
    const currRow = new Map<number, Entry>();

    for (let j = 0; j < n; j++) {
      if (t[j] !== q[i]) continue;

      let bestScore = -Infinity;
      let bestPred = -1;

      for (const entry of prevRow.values()) {
        if (entry.pos >= j) break; // must stay in order

        const gap = j - entry.pos - 1;
        let score = entry.score + 1;
        if (gap === 0) {
          score += 20; // consecutive run
        } else {
          score -= gap * 5; // gap penalty
        }
        if (isAtBoundary(t, j)) score += 15;

        if (score > bestScore) {
          bestScore = score;
          bestPred = entry.pos;
        }
      }

      if (bestPred !== -1) {
        currRow.set(j, { pos: j, score: bestScore, pred: bestPred });
      }
    }

    if (currRow.size === 0) {
      return undefined;
    }
    rows.push(currRow);
  }

  // --- Pick the best overall path -----------------------------------------
  let bestEntry: Entry | undefined;
  for (const entry of rows[m - 1].values()) {
    if (!bestEntry || entry.score > bestEntry.score) {
      bestEntry = entry;
    }
  }

  if (!bestEntry) {
    return undefined;
  }

  // --- Reconstruct match positions ----------------------------------------
  const positions = new Array<number>(m);
  let pos = bestEntry.pos;
  for (let i = m - 1; i >= 0; i--) {
    const entry = rows[i].get(pos)!;
    positions[i] = entry.pos;
    pos = entry.pred;
  }

  return { score: bestEntry.score + exactBonus, positions };
}
