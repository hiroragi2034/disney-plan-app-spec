// Display-time derivations over a plan's stored rows: total travel
// time, approximate walking distance, and the tight legs （無理
// ポイント）. Everything here is computed FROM the saved per-leg
// data (each item's travelMin and coordinates) at render time —
// plan rows themselves are never changed, and nothing here feeds
// back into item counts, pin numbers, or the verification gate.
//
// The walking-distance model is the SAME base the server's travel
// time computation uses (see the travel-time section in
// server/src/actions.ts): the straight-line (Haversine) distance
// between the two facilities' coordinates, times the same
// distance-dependent detour factor. The detour table and the
// distance function are duplicated here deliberately — the client
// cannot import server code — and must be kept in step with the
// server's detourFactor / haversineM.

export type MetricsItem = {
  kind: string;
  timeLabel: string | null;
  estWaitMin: number | null;
  travelMin: number | null;
  durationMin: number | null;
  lat: number | null;
  lng: number | null;
};

function detourFactor(distM: number): number {
  if (distM <= 100) return 1.1;
  if (distM <= 300) return 1.2;
  if (distM <= 600) return 1.25;
  return 1.3;
}

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Approximate walking distance of one leg (from the previous real
// stop to this item): straight-line distance × the travel model's
// detour factor. Null when either endpoint has no coordinates —
// the leg's distance is then unknown, never guessed.
export function legWalkDistanceM(
  prev: MetricsItem,
  cur: MetricsItem,
): number | null {
  if (
    prev.lat == null ||
    prev.lng == null ||
    cur.lat == null ||
    cur.lng == null
  ) {
    return null;
  }
  const straight = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
  return straight * detourFactor(straight);
}

export type PlanTravelSummary = {
  // Sum of the stored per-leg travel minutes (server-computed,
  // margin included).
  totalTravelMin: number;
  // Sum of the legs' approximate walking distances, in meters.
  totalWalkM: number;
  // Legs that carry a computed travel time.
  legCount: number;
};

// Totals over all of a plan's travel legs. Purchase-event rows are
// not stops (a pass is bought in the app, wherever the visitor
// stands): they neither consume nor produce a leg, mirroring the
// server's leg computation. The display-only 「最初の10分」 row
// (kind "first10") is not a stop either, for the same reason.
// Returns null when the plan has no leg with a computed travel
// time (older plan sets) — the display then shows nothing rather
// than an invented total.
export function planTravelSummary(
  items: MetricsItem[],
): PlanTravelSummary | null {
  let totalTravelMin = 0;
  let totalWalkM = 0;
  let legCount = 0;
  let prev: MetricsItem | null = null;
  for (const item of items) {
    if (item.kind === "purchase" || item.kind === "first10") continue;
    if (prev) {
      if (item.travelMin != null) {
        legCount++;
        totalTravelMin += item.travelMin;
        const walk = legWalkDistanceM(prev, item);
        if (walk != null) totalWalkM += walk;
      }
    }
    prev = item;
  }
  if (legCount === 0) return null;
  return { totalTravelMin, totalWalkM, legCount };
}

// The exact caution wording the owner specified for a tight leg.
export const TIGHT_LEG_CAUTION_TEXT =
  "この区間の移動はあまり余裕がありません。もしご不安ならAIにもう少し余裕を持たせてと伝えてください。";

// A leg is a tight point （無理ポイント） only when BOTH hold:
// - its approximate walking distance is at least 300 m (a short
//   hop is never flagged, however tight the schedule), and
// - its slack is at most 5 minutes, where slack = the time the
//   schedule allots to the move minus the computed travel time.
//   The allotment mirrors the save-time gap model: from the
//   previous item's start, its estimated wait and its experience
//   time (official duration; 0 when the dictionary has none —
//   the same treatment the server check gives an unknown
//   duration) are consumed first; what remains until the next
//   item's start is the allotment.
// The judgement runs over consecutive TIMED non-purchase items,
// exactly like the server's gap verification (an untimed item in
// between contributes its legs to the span). A span whose travel
// time or distance cannot be derived from the stored data is not
// judged. Returns the indices (into `items`) of the items whose
// incoming leg is tight — the caution renders between that item
// and the previous one.
export function tightLegTargets(items: MetricsItem[]): Set<number> {
  const targets = new Set<number>();
  const parseTime = (label: string | null): number | null => {
    if (!label) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  let prev: { index: number; start: number } | null = null;
  for (const [index, item] of items.entries()) {
    if (item.kind === "purchase" || item.kind === "first10") continue;
    const start = parseTime(item.timeLabel);
    if (prev && start != null) {
      const prevItem = items[prev.index];
      if (prevItem && prevItem.estWaitMin != null) {
        // Restaurant waits are not modeled (prepared in advance):
        // a restaurant row's wait counts as 0 in the allotment,
        // exactly as the server's gap arithmetic treats it.
        const prevWait =
          prevItem.kind === "restaurant" ? 0 : prevItem.estWaitMin;
        // Travel across the span: the stored per-item travel
        // minutes summed (a purchase row's pass-through is 0).
        let travel: number | null = 0;
        for (let i = prev.index + 1; i <= index; i++) {
          const tm = items[i]?.travelMin ?? null;
          if (tm == null) {
            travel = null;
            break;
          }
          travel += tm;
        }
        // Distance across the span: the legs between consecutive
        // real stops inside it, summed.
        let distance: number | null = 0;
        let lastReal: MetricsItem = prevItem;
        for (let i = prev.index + 1; i <= index; i++) {
          const cur = items[i];
          if (!cur || cur.kind === "purchase" || cur.kind === "first10")
            continue;
          const d = legWalkDistanceM(lastReal, cur);
          if (d == null) {
            distance = null;
            break;
          }
          distance += d;
          lastReal = cur;
        }
        if (travel != null && distance != null) {
          const allotment =
            start -
            prev.start -
            prevWait -
            (prevItem.durationMin ?? 0);
          const slack = allotment - travel;
          if (distance >= 300 && slack <= 5) targets.add(index);
        }
      }
    }
    if (start != null) prev = { index, start };
  }
  return targets;
}

// "約850m" / "約1.6km" style label for an approximate distance.
export function formatWalkDistance(m: number): string {
  if (m >= 1000) return `約${(m / 1000).toFixed(1)}km`;
  return `約${Math.round(m / 10) * 10}m`;
}

// Crowd-factor caps by forecast level — the client copy of
// CROWD_WAIT_FACTOR_CAPS in server/src/actions.ts (display only:
// the premise line names the cap; the factors actually applied
// per facility live in the verification record). Owner-set values
// (2026-11-14): the level's value is the cap for the most
// crowd-sensitive headline attractions; 4 is interpolated, 5 is
// the owner's fixed value (Soaring posted 340 minutes on
// 2026-01-06).
export const CROWD_FACTOR_CAPS: Record<number, number> = {
  1: 0.8,
  2: 0.9,
  3: 1.0,
  4: 2.5,
  5: 5.0,
};

export function crowdFactorCap(level: number): number {
  return CROWD_FACTOR_CAPS[level] ?? 1.0;
}

// "×2.5" / "×1.0" style factor label.
export function crowdFactorLabel(factor: number): string {
  return `×${Number.isInteger(factor) ? factor.toFixed(1) : String(factor)}`;
}

// Crowd scenarios (owner's design, 2026-11-14): the three plans of a
// set are differentiated by the crowd premise they are built under,
// derived from the set's forecast level — A assumes it turns out
// BUSIER than forecast, B takes the forecast itself, C assumes it
// turns out QUIETER. The scenario and its effective level are stored
// per plan by the server; these helpers only render them.
export type CrowdScenario = "severe" | "expected" | "light";

export const CROWD_SCENARIO_LABELS: Record<CrowdScenario, string> = {
  severe: "激混み前提",
  expected: "やや混み前提",
  light: "思ったより空いてる前提",
};

export const CROWD_SCENARIO_NOTES: Record<CrowdScenario, string> = {
  severe: "予想より混む側を想定し、実効係数は上限寄り",
  expected: "予想どおりの中心で想定",
  light: "予想より空く側を想定し、実効係数は低め",
};

// The premise line for one plan, e.g.
// 「混雑シナリオ：激混み前提（混雑予想4／5より混む側＝5／5相当で見積もり。予想より混む側を想定し、実効係数は上限寄り）」.
// Returns null when the plan carries no scenario (older sets,
// same-day sets, or a run whose forecast could not be evaluated).
export function crowdScenarioPremiseText(plan: {
  crowdScenario: CrowdScenario | null;
  crowdScenarioLevel: number | null;
}): string | null {
  if (plan.crowdScenario == null || plan.crowdScenarioLevel == null) {
    return null;
  }
  const label = CROWD_SCENARIO_LABELS[plan.crowdScenario];
  const note = CROWD_SCENARIO_NOTES[plan.crowdScenario];
  return `混雑シナリオ：${label}（${plan.crowdScenarioLevel}／5相当で見積もり。${note}）`;
}
