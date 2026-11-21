// Actions for the Disney plan app (我が家のディズニー計画).
//
// TAB1 = AI chat (messages), TAB2 = conditions form (single-row conditions),
// TAB3+ = one plan set per generation run (plan_sets -> plans A/B/C ->
// plan_items). TAB1/TAB2 are fixed by construction: they are not rows and
// can never be deleted; plan sets can.
//
// Disney facility data is NEVER bundled. On each generation request, a
// background agent task reads the official Tokyo Disney Resort site for the
// chosen park and date, resolves coordinates from OpenStreetMap, drafts the
// three plans, and writes them back through savePlanSet into this DB only.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { FACILITY_SEED, FACILITY_SEED_STAMP_MS } from "./facility_seed";

// ---------- shared shapes ----------

const parkEnum = z.enum(["land", "sea"]);
const slotEnum = z.enum(["A", "B", "C"]);
const walkingSpeedEnum = z.enum([
  "slow",
  "slightly_slow",
  "slightly_fast",
  "fast",
]);
type WalkingSpeed = z.infer<typeof walkingSpeedEnum>;
const kindEnum = z.enum([
"attraction",
"show",
"parade",
"restaurant",
"break",
"move",
"other",
// A DPA purchase event row: the moment a Premier Access pass is
// bought. DPA cost is counted on this row, once per purchase
// instance (facility × purchase event) — never on the usage row.
"purchase",
// Display-only 「最初の10分」 block (owner's feature, 2026-11-16):
// one row per plan immediately after the entry row, listing what
// to do in the first ten minutes after entering (the plan's first
// DPA purchase; the lottery entry for each エントリー受付対象 show
// in the plan) followed by the fixed guidance sentence. It is not
// a place and not a stop: no coordinates, the travel computation
// passes through it like a purchase row, and no gate judges it.
"first10",
]);

// The fixed guidance sentence that closes every 「最初の10分」
// block, verbatim (owner's exact wording, 2026-11-16). The
// generation assignments interpolate this constant, so the saved
// row's note carries the sentence byte-for-byte.
const FIRST10_GUIDANCE =
"当日も何か予定外や突然の変更点などあれば、下のAIチャットでお伝えください。いつでもスケジュールを組み直します。";

const conditionsShape = z.object({
park: parkEnum,
visitDate: z.string().nullable(),
entryTime: z.string().nullable(),
exitTime: z.string().nullable(),
budgetJpy: z.number().nullable(),
adults: z.number(),
children: z.number(),
childrenAges: z.string().nullable(),
stayHotel: z.string().nullable(),
// The ONE 「重視する点」 free-text field, applied to all three plans
// (the per-plan priority fields and the common priority were
// abolished by the owner's 2026-11-14 design change; plans are
// differentiated by crowd scenario instead).
priority: z.string().nullable(),
walkingSpeed: walkingSpeedEnum,
});

type Conditions = z.infer<typeof conditionsShape>;

// The structured condition CHANGES a chat judgement returns (see
// 【条件の変更点の受け渡しルール】 in sendMessage's prompt): only the
// fields whose VALUES the user's instruction changes, each with its
// new value; every other field stays null. Returned on every
// judgement kind — a stated value change must never be dropped into
// a bare 「作り直し」 judgement (2026-11-20 incident: 「退園を19:30に
// して」 was judged a rebuild and the 19:30 reached nothing, so the
// rebuild silently ran on the original 19:00 exit time).
const conditionChangesShape = z.object({
  park: parkEnum.nullable(),
  visitDate: z.string().max(20).nullable(),
  entryTime: z.string().max(10).nullable(),
  exitTime: z.string().max(10).nullable(),
  budgetJpy: z.number().int().min(0).nullable(),
  adults: z.number().int().min(0).max(20).nullable(),
  children: z.number().int().min(0).max(20).nullable(),
  childrenAges: z.string().max(300).nullable(),
  priority: z.string().max(2000).nullable(),
  walkingSpeed: walkingSpeedEnum.nullable(),
});

type ConditionChanges = z.infer<typeof conditionChangesShape>;

const planItemShape = z.object({
id: z.number(),
sortOrder: z.number(),
timeLabel: z.string().nullable(),
name: z.string(),
kind: kindEnum,
area: z.string().nullable(),
note: z.string().nullable(),
passType: z.string().nullable(),
// For DPA rows: the time of day the pass is to be bought, stated in
// the plan and verified at save time (60-minute purchase rule).
// Null for non-DPA rows and older plan sets.
dpaPurchaseTime: z.string().nullable(),
// Unit price (1名分） stated on a DPA purchase-event row
// (kind = "purchase"); cross-checked against the normalized-fact
// price by the gate. Null elsewhere (a usage row never carries a
// counted price).
unitPriceJpy: z.number().nullable(),
// Headcount a purchase-event row is bought for (owner's ruling,
// 2026-11-17): DPA money is unit price × this count — the people
// who actually use the facility — not automatically the whole
// party. Null on non-purchase rows and on purchase rows saved
// before the field existed; read-time derivations fall back to
// the party size for those legacy rows only.
purchaseCount: z.number().nullable(),
// Estimated wait in minutes (generation-time estimate from the wait-time
// reference sites); shown large at the right end of each schedule row.
// Always present for attraction rows in new plan sets, 0 included.
estWaitMin: z.number().nullable(),
// Travel minutes from the previous item, computed deterministically
// by the server at save time (see plan_items.travel_min). Null when
// the leg was 未確認 (coordinates unknown), for the first item, and
// for plan sets saved before travel times existed.
travelMin: z.number().nullable(),
// Official duration （所要時間） in minutes from the facility
// dictionary, when one is recorded for this item's facility. Used
// at display time for the tight-leg （無理ポイント） judgement —
// the same duration the save-time gap verification used. Null when
// the dictionary has none (the display judgement then treats the
// experience time as 0, exactly like the server's check does).
durationMin: z.number().nullable(),
lat: z.number().nullable(),
lng: z.number().nullable(),
// Resolved URL of the item's owned intro-photo blob; null when the item
// has no photo.
imageUrl: z.string().nullable(),
// Where the photo came from: the official site, or a Wikimedia Commons
// reference photo used as fallback. Null when there is no photo.
imageSource: z.enum(["official", "reference"]).nullable(),
// URL of the facility's official detail page (recorded from the page
// the retrieval agent actually opened); null when unconfirmed.
officialUrl: z.string().nullable(),
// Row-level unconfirmed element (§9.4): when this row places a value
// that could not be confirmed from official sources on its run, the
// row itself carries the short reason (shown as the row's
// 「未確定（理由）」 mark) and the explanation (shown when the mark is
// tapped). A non-null reason IS the unconfirmed flag. The row is the
// single source: the verification record's 未確認 entry for it is
// derived from these fields at save time. Null for confirmed rows
// and plan sets saved before this existed.
unconfirmedReason: z.string().nullable(),
unconfirmedNote: z.string().nullable(),
// Restaurant classification derived AT READ TIME from the
// restaurant fact layer (restaurant_facts — grounded facts read
// from the facility's own official detail page) — never stored on
// the row itself, so rows saved before a fact existed gain the
// display without any data rewrite. Present only for restaurant
// rows whose facility is identified (a current fact, or a facility
// dictionary entry); a meal row with no identified facility
// (店名のない食事行） carries null and renders no classification.
// An identified facility with no current fact is derived as
// "unknown" here: the row displays 未確認 explicitly instead of a
// blank that would read as "nothing needed".
restaurantInfo: z
.object({
reservationType: z.enum(["required", "ps", "none", "unknown"]),
mobileOrder: z.enum(["available", "unavailable", "unknown"]),
})
.nullable(),
});

const costLineShape = z.object({
label: z.string(),
amountJpy: z.number().nullable(),
note: z.string().nullable(),
});

// Premise note for a plan containing restaurant rows (spec §18):
// restaurant waits are not modelled, so the plan's premise states
// so explicitly. Derived AT READ TIME from the plan's own rows by
// restaurantWaitNoteFor below and carried in the read payloads
// (getState and getPlanPdfData) — never stored on the plan row,
// so saved plans gain the note without any data rewrite.
const RESTAURANT_WAIT_NOTE_TEXT =
"レストランの待ち時間は含まれていません。レストランは事前に準備してある前提で組んでいます";

function restaurantWaitNoteFor(
items: { kind: string }[],
): string | null {
return items.some((it) => it.kind === "restaurant")
? RESTAURANT_WAIT_NOTE_TEXT
: null;
}

// Under-5 child note （ひざ上利用の説明帯， spec §18/§16・記録AS):
// when the party recorded in a set's conditions snapshot includes a
// child under 5, every plan of the set carries this explanation —
// Disney judges ride eligibility by posture, not age, and lap
// riding is a per-facility exception stated on the facility's own
// official page, so the grounds and the final on-the-day caveat are
// shown with the plan. Derived AT READ TIME from the set's stored
// conditions snapshot (the same read-time derivation pattern as
// restaurantWaitNote) and carried in BOTH read payloads (getState's
// planShape and getPlanPdfData's exportDataShape) — never stored,
// so already-saved sets gain the band without any data rewrite.
// When no child age can be read from the snapshot, no band is shown.
const LAP_CHILD_NOTE_TEXT =
"小さなお子さまの利用について：アトラクションなどの利用可否は、年齢ではなく姿勢が基準です。公式の定義では、最後まで座席に背中と腰をつけて座った状態を保てることが必要です。ひざの上に乗せての利用は、施設の公式ページに『お子さまをひざの上に乗せてご利用可』とある施設だけの例外で、施設によって異なります。このプランでは公式ページを確認して施設を選んでいますが、最終的な利用可否は当日の施設の判断になります。";

// True when the children ages recorded in a conditions snapshot
// (the （…） part of the 人数 line — the free-text childrenAges the
// user entered, e.g. "1歳、1歳" or "4歳と8歳") include a child
// under 5. Ages are read ONLY from explicit age statements in that
// text: "N歳" (full-width digits normalized) or "Nか月" under 60
// months. No readable age → false (the band is not shown).
function snapshotHasChildUnder5(snapshot: string | null): boolean {
if (!snapshot) return false;
const agesM = /人数[:：][^\n]*（([^）]+)）/.exec(snapshot);
if (!agesM) return false;
const agesText = (agesM[1] ?? "").replace(/[０-９]/g, (ch) =>
String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
);
for (const m of agesText.matchAll(/(\d+)\s*[歳才]/g)) {
if (Number(m[1]) < 5) return true;
}
for (const m of agesText.matchAll(/(\d+)\s*か月/g)) {
if (Number(m[1]) < 60) return true;
}
return false;
}

function lapChildNoteFor(set: {
conditionsSnapshot: string | null;
}): string | null {
return snapshotHasChildUnder5(set.conditionsSnapshot)
? LAP_CHILD_NOTE_TEXT
: null;
}

// Plan-head summary statistics (owner's design, 2026-11-17): the
// executive-summary numbers shown at the head of every plan (and in
// its PDF). Derived AT READ TIME from the plan's stored rows, the
// set's conditions snapshot and the set row — the same read-time
// derivation pattern as restaurantInfo / restaurantWaitNote — and
// carried in BOTH read payloads (getState's planShape and
// getPlanPdfData's exportDataShape) so the screen and the PDF always
// show the same values. Stored rows are NEVER rewritten for this.
const summaryStatsShape = z.object({
// 費用概算 = the plan's stored total (estimatedCostJpy).
totalCostJpy: z.number().nullable(),
// うちDPA: sum over purchase rows of unitPriceJpy × the row's
// purchaseCount (the people who actually use that facility —
// owner's ruling, 2026-11-17). A legacy purchase row saved before
// purchaseCount existed carries no count and falls back to the
// party size (adults + children of the set's conditions snapshot;
// a same-day set's own party columns win, as everywhere else), so
// existing sets keep their amounts. dpaCount is the number of
// purchase rows.
dpaAmountJpy: z.number(),
dpaCount: z.number(),
// 予算 = the conditions snapshot's budgetJpy; budgetDiffJpy is
// budget − total (positive = 残り, negative = 超過 by its absolute
// value). Null when either side is unknown.
budgetJpy: z.number().nullable(),
budgetDiffJpy: z.number().nullable(),
attractionCount: z.number(),
// うちDPA（アトラクションのみ）: purchase rows whose facility is
// an attraction in this plan — a purchase row's name is the
// facility's official name, so it matches the plan's attraction
// usage row of the same name. Show / parade DPA purchases are NOT
// counted here (they still count in dpaCount / dpaAmountJpy).
// attractionDpaRatePct is round(100 × attractionDpaCount /
// attractionCount); null when the plan has no attraction rows, in
// which case the rate is not shown.
attractionDpaCount: z.number(),
attractionDpaRatePct: z.number().nullable(),
// 待ち時間合計 = sum of estWaitMin over the rows that carry one
// (the read payload already reports restaurant rows' waits as
// null, so they drop out naturally; purchase / first10 rows carry
// none). longestWait is the row with the largest estWaitMin, null
// when no row carries a wait.
totalWaitMin: z.number(),
longestWait: z
.object({ name: z.string(), waitMin: z.number() })
.nullable(),
// 移動時間合計 / 歩行距離概算: the SAME derivation the plan tab's
// former travel-totals line used (client planTravelSummary):
// over consecutive real stops (purchase / first10 rows are not
// stops), a leg counts when its stored travelMin exists; its
// walking distance is the straight-line (Haversine) distance
// between the two stops' coordinates × the travel model's detour
// factor, counted only for legs that count. Both null when the
// plan has no leg with a computed travel time (older sets).
totalTravelMin: z.number().nullable(),
totalWalkM: z.number().nullable(),
// 滞在時間: entry〜exit of the conditions snapshot; for a same-day
// set, its start time (sameDayStartTime, falling back to the
// snapshot's entry time) 〜 the closing time read from the set's
// stored parkHours. Labels are "H:MM" (unpadded hour).
stayStartLabel: z.string().nullable(),
stayEndLabel: z.string().nullable(),
stayMinutes: z.number().nullable(),
showCount: z.number(),
paradeCount: z.number(),
restaurantCount: z.number(),
// うちショーレストラン: restaurant rows whose read-time
// restaurantInfo reservationType is "required" (a restaurant with
// no fact is never counted).
showRestaurantCount: z.number(),
// 未確認: the rows carrying an unconfirmedReason, in plan order.
unconfirmed: z.array(
z.object({ name: z.string(), reason: z.string() }),
),
});

// The closing time (minutes since midnight) stated in a stored
// parkHours text ("9:00～21:00" and friends), or null when the text
// carries no readable range.
function parkHoursEndMin(parkHours: string | null): number | null {
if (!parkHours) return null;
const m = /(\d{1,2}):(\d{2})\s*[～~\-–−]\s*(\d{1,2}):(\d{2})/.exec(
parkHours,
);
if (!m) return null;
return Number(m[3]) * 60 + Number(m[4]);
}

type SummarySetInfo = {
park: "land" | "sea";
visitDate: string | null;
conditionsSnapshot: string | null;
walkingSpeed: WalkingSpeed | null;
setType: string;
sameDayAdults: number | null;
sameDayChildren: number | null;
sameDayStartTime: string | null;
parkHours: string | null;
};

function summaryStatsForPlan(
set: SummarySetInfo,
estimatedCostJpy: number | null,
items: z.infer<typeof planItemShape>[],
): z.infer<typeof summaryStatsShape> {
const cond = parseSnapshotConditions(set).conditions;
const snapshotParty = parseSnapshotParty(set.conditionsSnapshot);
const party =
set.setType === "same_day" && set.sameDayAdults != null
? {
adults: set.sameDayAdults,
children: set.sameDayChildren ?? 0,
}
: (snapshotParty ?? {
adults: cond.adults,
children: cond.children,
});
const partySize = party.adults + party.children;
let dpaAmountJpy = 0;
let dpaCount = 0;
let attractionCount = 0;
let attractionDpaCount = 0;
const attractionNames = new Set(
items.filter((it) => it.kind === "attraction").map((it) => it.name),
);
let showCount = 0;
let paradeCount = 0;
let restaurantCount = 0;
let showRestaurantCount = 0;
let totalWaitMin = 0;
let longestWait: { name: string; waitMin: number } | null = null;
const unconfirmed: { name: string; reason: string }[] = [];
for (const it of items) {
if (it.kind === "purchase") {
dpaCount++;
if (attractionNames.has(it.name)) {
attractionDpaCount++;
}
if (it.unitPriceJpy != null) {
dpaAmountJpy += it.unitPriceJpy * (it.purchaseCount ?? partySize);
}
} else if (it.kind === "attraction") {
attractionCount++;
} else if (it.kind === "show") {
showCount++;
} else if (it.kind === "parade") {
paradeCount++;
} else if (it.kind === "restaurant") {
restaurantCount++;
if (it.restaurantInfo?.reservationType === "required") {
showRestaurantCount++;
}
}
if (it.estWaitMin != null) {
totalWaitMin += it.estWaitMin;
if (!longestWait || it.estWaitMin > longestWait.waitMin) {
longestWait = { name: it.name, waitMin: it.estWaitMin };
}
}
if (it.unconfirmedReason) {
unconfirmed.push({ name: it.name, reason: it.unconfirmedReason });
}
}
// Travel + walking totals, mirroring the client's planTravelSummary
// leg-for-leg so the summary, the (removed) plan-tab line, the PDF
// and the verification package all agree on the same values.
let totalTravelMin = 0;
let totalWalkM = 0;
let legCount = 0;
let prev: z.infer<typeof planItemShape> | null = null;
for (const item of items) {
if (item.kind === "purchase" || item.kind === "first10") continue;
if (prev) {
if (item.travelMin != null) {
legCount++;
totalTravelMin += item.travelMin;
if (
prev.lat != null &&
prev.lng != null &&
item.lat != null &&
item.lng != null
) {
const straight = haversineM(prev.lat, prev.lng, item.lat, item.lng);
totalWalkM += straight * detourFactor(straight);
}
}
}
prev = item;
}
let stayStartMin: number | null;
let stayEndMin: number | null;
if (set.setType === "same_day") {
stayStartMin =
parseTimeLabel(set.sameDayStartTime) ??
parseTimeLabel(cond.entryTime);
stayEndMin = parkHoursEndMin(set.parkHours);
} else {
stayStartMin = parseTimeLabel(cond.entryTime);
stayEndMin = parseTimeLabel(cond.exitTime);
}
return {
totalCostJpy: estimatedCostJpy,
dpaAmountJpy,
dpaCount,
budgetJpy: cond.budgetJpy,
budgetDiffJpy:
cond.budgetJpy != null && estimatedCostJpy != null
? cond.budgetJpy - estimatedCostJpy
: null,
attractionCount,
attractionDpaCount,
attractionDpaRatePct:
attractionCount > 0
? Math.round((attractionDpaCount / attractionCount) * 100)
: null,
totalWaitMin,
longestWait,
totalTravelMin: legCount > 0 ? totalTravelMin : null,
totalWalkM: legCount > 0 ? totalWalkM : null,
stayStartLabel:
stayStartMin != null ? fmtMinutesOfDay(stayStartMin) : null,
stayEndLabel: stayEndMin != null ? fmtMinutesOfDay(stayEndMin) : null,
stayMinutes:
stayStartMin != null && stayEndMin != null && stayEndMin >= stayStartMin
? stayEndMin - stayStartMin
: null,
showCount,
paradeCount,
restaurantCount,
showRestaurantCount,
unconfirmed,
};
}

const planShape = z.object({
id: z.number(),
slot: slotEnum,
title: z.string(),
summary: z.string().nullable(),
estimatedCostJpy: z.number().nullable(),
costBreakdown: z.array(costLineShape),
// The crowd scenario this plan was built under and the effective
// forecast level its waits were estimated at (see schema.plans).
// Null for plans saved before scenarios existed, same-day sets,
// and runs whose forecast could not be evaluated.
crowdScenario: z.enum(["severe", "expected", "light"]).nullable(),
crowdScenarioLevel: z.number().nullable(),
items: z.array(planItemShape),
// Read-time derived premise note (see RESTAURANT_WAIT_NOTE_TEXT):
// the note text itself when this plan contains at least one
// restaurant row, null when it contains none. Derived on every
// read from the plan's rows; never stored.
restaurantWaitNote: z.string().nullable(),
// Read-time derived under-5 child note (see LAP_CHILD_NOTE_TEXT):
// the note text when the set's conditions snapshot records a child
// under 5, null otherwise. Derived on every read from the set's
// snapshot; never stored.
lapChildNote: z.string().nullable(),
// Read-time derived plan-head summary statistics (see
// summaryStatsShape / summaryStatsForPlan): derived on every read
// from the plan's rows and the set's conditions snapshot; never
// stored.
summaryStats: summaryStatsShape,
});

const planProgressEnum = z.enum(["waiting", "generating", "done", "failed"]);

// One facility's normalized DPA fact as recorded in a verification
// record: the fact the gate judged by (status / price / period),
// plus its grounds — the verbatim evidence excerpt and the canonical
// snapshot it came from (kind, URL, fetch instant). Records saved
// before the normalized-source layer existed carry no facts.
const dpaFactShape = z.object({
name: z.string(),
status: z.enum(["eligible", "not_eligible", "unknown"]),
priceJpy: z.number().nullable(),
effectiveFrom: z.string().nullable(),
effectiveTo: z.string().nullable(),
unknownReason: z.string().nullable(),
evidence: z.string().nullable(),
evidenceKind: z.string().nullable(),
snapshotKind: z.string().nullable(),
snapshotUrl: z.string().nullable(),
snapshotFetchedAt: z.string().nullable(),
});

// One value change the registration-time diff gate ACCEPTED as a
// legitimate制度変更: the new fact differed from the baseline
// build's fact but carried a strictly newer effectiveFrom. Recorded
// on the build (fact_builds.value_changes_json) — a changed value
// never passes silently. oldValue / newValue are display strings
// ("1,500円" for a price, "対象" / "対象外" for a status).
const factValueChangeShape = z.object({
name: z.string(),
field: z.enum(["price", "status"]),
oldValue: z.string(),
newValue: z.string(),
effectiveFrom: z.string().nullable(),
});

// One fact the registration-time diff gate KNOCKED DOWN to unknown:
// its value differed from the baseline build's fact without a newer
// effectiveFrom to justify the change, so the server refused to let
// the unverified value stand as canonical. Recorded on the build
// (fact_builds.value_diff_knockdowns_json); the fact itself is
// stored as unknown with `reason` as its unknownReason.
const factValueKnockdownShape = z.object({
name: z.string(),
field: z.enum(["price", "status"]),
baselineValue: z.string(),
submittedValue: z.string(),
reason: z.string(),
});

// The completeness summary of one fact build: how many facilities
// the mother set (the build's facility_list snapshot) held, how the
// facts break down, and every unknown with its reason — so a gap in
// coverage is visible in the record, never silent. The value-diff
// fields (baselineBuildId / valueChanges / valueDiffKnockdowns)
// disclose the registration-time diff gate's outcome against the
// park's previous canonical build; builds registered before the
// diff gate existed carry null / empty values here.
const factSummaryShape = z.object({
universeCount: z.number(),
eligibleCount: z.number(),
notEligibleCount: z.number(),
unknownCount: z.number(),
complete: z.boolean(),
unknowns: z.array(z.object({ name: z.string(), reason: z.string()})),
baselineBuildId: z.number().nullable(),
valueChanges: z.array(factValueChangeShape),
valueDiffKnockdowns: z.array(factValueKnockdownShape),
});

// The verification record of one plan set: the deterministic
// cross-check savePlanSet ran against the official data fetched on
// that generation run, immediately before completion. `checks` says
// what was verified, against which official page, and when that page
// was fetched; `unverified` lists what could NOT be checked （未確認）
// instead of passing silently. DPA judgement runs ONLY on the
// normalized facts of one fact build: `factBuildId` names that
// build, `factSummary` is its completeness summary, and `dpaFacts`
// carries every fact the gate could judge by, with its grounds.
// `dpaExtracted` is retained for older records (the eligibility list
// the pre-normalization extraction produced); new records fill it
// from the build's eligible facts so price displays keep working.
// Null (the whole record) for sets saved before the verification
// step existed.
const verificationShape = z.object({
checkedAt: z.string().nullable(),
checks: z.array(
z.object({
label: z.string(),
result: z.string(),
sourceTitle: z.string().nullable(),
sourceUrl: z.string().nullable(),
fetchedAt: z.string().nullable(),
}),
),
unverified: z.array(z.string()),
dpaExtracted: z.array(
z.object({
name: z.string(),
priceJpy: z.number(),
effectiveFrom: z.string().nullable(),
effectiveTo: z.string().nullable(),
periodEvidence: z.string().nullable(),
}),
),
factBuildId: z.number().nullable(),
factSummary: factSummaryShape.nullable(),
dpaFacts: z.array(dpaFactShape),
// Per-facility EFFECTIVE crowd factors the generation task
// actually applied to the base wait estimates (each at or below
// the level's cap in CROWD_WAIT_FACTOR_CAPS). Reported by the task
// at save time so the coefficient multiplication stays traceable
// facility by facility. Empty for sets created before the crowd
// forecast existed, and when a task reported no breakdown.
crowdFactors: z.array(
z.object({
name: z.string(),
factor: z.number(),
// The plan (slot) this factor was applied in: the three plans
// are built under different crowd scenarios, so the same
// facility can carry a different effective factor per plan.
// Null for records saved before scenarios existed (one flat
// list shared by the set).
slot: slotEnum.nullable(),
}),
),
});

// One bulk re-verification （一括検証） run against a finished plan
// set: when it ran, what the fresh official data showed, and the
// outcome — the problems found (each naming the plan, the row, and
// the change that invalidated it) and what stayed 未確認. Appended
// to the set's re-verification history by savePlanVerification; the
// creation-time verification record is never rewritten.
const reverificationShape = z.object({
checkedAt: z.string(),
fetchedAt: z.string().nullable(),
problems: z.array(z.string()),
unverified: z.array(z.string()),
sources: z.array(z.object({ title: z.string(), url: z.string()})),
parkHours: z.string().nullable(),
dpaExtracted: z.array(
z.object({
name: z.string(),
priceJpy: z.number(),
effectiveFrom: z.string().nullable(),
effectiveTo: z.string().nullable(),
periodEvidence: z.string().nullable(),
}),
),
factBuildId: z.number().nullable(),
factSummary: factSummaryShape.nullable(),
dpaFacts: z.array(dpaFactShape),
});

// The "重視する点" premise of a plan set, parsed from its stored
// conditions snapshot (plan_sets.conditions_snapshot). New-model
// snapshots carry one unified field; legacy snapshots carry the
// per-slot priorities (A/B/C) plus the common priority. Null = that
// field was 未入力 at generation time (or the snapshot carries no
// premise at all, e.g. a 当日検索 set).
const snapshotPrioritiesShape = z.object({
A: z.string().nullable(),
B: z.string().nullable(),
C: z.string().nullable(),
common: z.string().nullable(),
// The single unified 「重視する点」 of the new conditions model
// (snapshots written since the 2026-11-14 design change). When the
// snapshot carries the unified label at all, this is the premise
// and A/B/C/common stay null; legacy snapshots keep the old four.
unified: z.string().nullable(),
// Which conditions model the snapshot was written under: "legacy"
// (per-plan priorities + common) or "unified" (one 重視する点）.
// Surfaces render the premise accordingly and never rewrite an old
// snapshot into the new form.
model: z.enum(["legacy", "unified"]),
});

const planSetShape = z.object({
id: z.number(),
title: z.string(),
park: parkEnum,
visitDate: z.string().nullable(),
status: z.enum(["generating", "done", "failed"]),
// Per-plan generation progress （待機/作成中/完了/失敗）, tracked per slot
// rather than per set: a plan is 完了 only once it has actually been
// saved, and a partial operation can put one plan back to 作成中 while
// the others stay 完了.
planProgress: z.object({
A: planProgressEnum,
B: planProgressEnum,
C: planProgressEnum,
}),
// Start of the current whole-set generation run (ISO instant),
// recorded server-side at start and reset by a user-pressed
// リトライ: the generating view's elapsed clock (stuck-generation
// safeguard) counts from this, so a reload never resets it. Null
// unless the set is generating; sets created before the timestamp
// column existed report their createdAt, which is their start.
generationStartedAt: z.string().nullable(),
// Per-slot start of an in-flight partial operation （部分差し替え /
// 当日リスケ) on a finished set (ISO instant), from the operation
// record written at its start (pending_ops_json); null for slots
// with no operation in flight. The 差し替え中 view's elapsed clock
// counts from this.
partialOpStarts: z.object({
A: z.string().nullable(),
B: z.string().nullable(),
C: z.string().nullable(),
}),
// Per-slot failure text of a partial operation the task manager
// ended after exhausting its attempts （裏タスク管理クラス）: the
// slot stands at 失敗 (not 作成中） with this text, its request
// still recorded so リトライ re-runs it. Null for slots with no
// such failure.
partialOpFailures: z.object({
A: z.string().nullable(),
B: z.string().nullable(),
C: z.string().nullable(),
}),
error: z.string().nullable(),
// Pre-completion verification record (see verificationShape); null
// for plan sets saved before the verification step existed.
verification: verificationShape.nullable(),
// When this set's plans were last verified against official data
// (ISO instant): the creation verification's checkedAt, advanced by
// each bulk re-verification. Null when never verified.
lastVerifiedAt: z.string().nullable(),
// Bulk re-verification （一括検証） history, oldest first; the
// creation-time record above is the baseline and is never in here.
reverifications: z.array(reverificationShape),
// True while a bulk re-verification of this set is running.
verificationRunning: z.boolean(),
// Generation measurements reported by the generation task: pages it
// opened and seconds per phase. Null when the set was saved before
// metrics existed (or the task did not report them).
generationMetrics: z
.object({
pagesOpened: z.number().nullable(),
phases: z.array(
z.object({ name: z.string(), seconds: z.number()}),
),
})
.nullable(),
// Id of the original plan set this one was rebuilt from (same park and
// visit date), or null when the run was not started as a rebuild — a
// プラン作成 tab button start is always a fresh creation, even when a
// same-park/same-date set exists. The client renders the 作り直し版
// marker from this, and the chat context names the relation.
rebuiltFromSetId: z.number().nullable(),
// Creation route of this set: "standard" (pre-trip 3-plan generation)
// or "same_day" （当日検索 — one plan from the visitor's current
// location at a specified time through closing). The client renders
// the 当日検索 badge / single-plan layout from this.
setType: z.enum(["standard", "same_day"]),
// 当日検索 inputs snapshotted at start; null for standard sets.
sameDay: z
.object({
location: z.string(),
startTime: z.string(),
request: z.string().nullable(),
})
.nullable(),
// Walking speed this set's travel times were computed with
// (snapshotted from the conditions at generation start). Null for
// plan sets created before travel times existed.
walkingSpeed: walkingSpeedEnum.nullable(),
// Crowd forecast （混雑予想） for the visit date, evaluated by the
// generation task (never chosen by the user in the form): a 1–5
// level and its short basis. The saved estimated waits already
// carry the per-facility effective crowd factors (see the
// verification record's crowdFactors). Null for sets created
// before the forecast existed — the UI shows nothing then.
crowdLevel: z.number().nullable(),
crowdBasis: z.string().nullable(),
// The 「重視する点」 premise parsed from this set's stored
// conditions snapshot — the premise each plan was generated under,
// so the user can see what they asked for on the plan itself.
priorities: snapshotPrioritiesShape,
// The full search conditions this set was generated under, parsed
// back from the set's stored conditions snapshot (never the live
// TAB2 form, which may have changed since): the plan tab's 「条件」
// panel renders exactly this, so the conditions behind a tab's
// plans are visible on the tab itself. Null when the set carries
// no conditions snapshot at all (nothing honest to show).
conditions: conditionsShape.nullable(),
// Labels of snapshot fields parseSnapshotConditions could not read
// (empty when the snapshot read completely). Those fields' parsed
// values are neutral fallbacks, so the panel marks them 読み取れ
// なかった instead of presenting a fallback as the real condition.
conditionsMissing: z.array(z.string()),
imagesStatus: z.enum(["idle", "fetching", "done", "failed"]),
notes: z.string().nullable(),
parkHours: z.string().nullable(),
sources: z.array(z.object({ title: z.string(), url: z.string()})),
// Wait-time reference sites consulted as estimation material for this
// set — deliberately a separate list from the official `sources`.
// fetchedAt is the date the generation actually read the site.
estimateSources: z.array(
z.object({
title: z.string(),
url: z.string(),
fetchedAt: z.string().nullable(),
}),
),
createdAt: z.string(),
plans: z.array(planShape),
});

const waitTimeSourceShape = z.object({
id: z.number(),
name: z.string(),
url: z.string(),
park: z.enum(["land", "sea", "both"]),
provides: z.string().nullable(),
// How this site was fetched successfully last time (per-site
// acquisition know-how): "script" = static fetch sufficed,
// "browser" = browser rendering was needed, "failed" = neither
// worked last time. Null = not recorded yet.
fetchMethod: z.enum(["script", "browser", "failed"]).nullable(),
lastCheckedAt: z.string().nullable(),
});

const stateResponse = z.object({
conditions: conditionsShape,
messages: z.array(
z.object({
id: z.number(),
role: z.enum(["user", "assistant"]),
text: z.string(),
createdAt: z.string(),
}),
),
planSets: z.array(planSetShape),
// True while a chat fact-check (公式サイトでの調査) is running; the
// client polls and shows a "確認中" indicator in the chat meanwhile.
researchPending: z.boolean(),
// Registered wait-time reference sites （待ち時間参考サイト tab).
waitTimeSources: z.array(waitTimeSourceShape),
// True while an add/remove/re-search instruction for the reference
// sites is being carried out by a background task.
waitTimeSourcesPending: z.boolean(),
// True while any bulk re-verification （一括検証） is running; the
// client polls and shows a 「検証中」 indicator meanwhile.
verificationPending: z.boolean(),
// The day-before （前日） dialog target: a finished standard plan
// set whose visit date is tomorrow (Asia/Tokyo) and whose dialog has
// never been shown. Null when no set qualifies — the client shows
// the dialog at most once per set, only while this is non-null.
eveVerification: z
.object({
planSetId: z.number(),
title: z.string(),
visitDate: z.string(),
})
.nullable(),
// A task-manager dialog notice awaiting display: raised when one
// of the auxiliary production processings (wait-time site list
// update / image fetch / restaurant fact correction) exhausted
// its attempts. Carries the one common congestion text verbatim;
// the client shows it as a dialog once and marks it shown via
// markMgrDialogShown. Null when no notice is waiting.
mgrDialogNotice: z
.object({
id: z.number(),
text: z.string(),
})
.nullable(),
});

const DEFAULT_CONDITIONS: Conditions = {
park: "land",
visitDate: null,
entryTime: null,
exitTime: null,
budgetJpy: null,
adults: 2,
children: 0,
childrenAges: null,
stayHotel: null,
priority: null,
walkingSpeed: "slightly_slow",
};

function parkName(park: "land" | "sea"): string {
return park === "land"? "東京ディズニーランド": "東京ディズニーシー";
}

// A photo fetch whose background task never reports back (task error,
// timeout, lost delivery) would otherwise leave imagesStatus stuck at
// "fetching" forever: no photos, and no way to retry. A fetch running
// longer than this is treated as dead — getState reports it as failed
// (so the retry button comes back) and requestItemImages may start a
// fresh fetch. Rows written before imagesFetchStartedAt existed have it
// null while "fetching"; those are stale by definition.
const IMAGES_FETCH_STALE_MS = 10 * 60 * 1000;

function isStaleImageFetch(set: {
imagesStatus: "idle" | "fetching" | "done" | "failed";
imagesFetchStartedAt: Date | null;
}): boolean {
if (set.imagesStatus!== "fetching") return false;
if (!set.imagesFetchStartedAt) return true;
return Date.now() - set.imagesFetchStartedAt.getTime() > IMAGES_FETCH_STALE_MS;
}

// Same dead-task guard for chat research: a research task that never
// reports back must not leave the chat showing "確認中" forever.
const RESEARCH_STALE_MS = 10 * 60 * 1000;

// Bulk re-verification （一括検証） fetches several official pages
// (calendar, DPA, entertainment, tickets) — heavier than a single
// fact-check, lighter than a full generation. A pending request past
// this window means its task died without reporting back.
const VERIFICATION_STALE_MS = 20 * 60 * 1000;

// Plan generation is heavier than a fact-check (official-site survey +
// three drafted plans), so its dead-task window is longer. The window
// is measured from the set's LAST PROGRESS RECORD (progressUpdatedAt:
// the latest updatePlanProgress report or saved plan), not from the
// set's creation: a generation that keeps recording progress is alive
// however long it takes, and only one that has gone silent past the
// window is treated as a dead task and failed once by getState.
const GENERATION_STALE_MS = 20 * 60 * 1000;

// Footer link for the exported plan PDF: the note article
// introducing this app. There is no article URL yet, so the PDF
// footer currently renders as plain text; when the article exists,
// put its URL here — the PDF export payload (getPlanPdfData) carries
// it from this single place.
const SHARE_NOTE_URL: string | null = null;

// Announcement channel (spec §22.1): the distributor publishes
// announce.json in the same GitHub repository as the spec; every
// copy fetches this fixed raw URL when the space is opened
// (checkAnnouncement). Read-only; a failed fetch is ignored
// completely. This is the one declared exception to the rule that
// the app body itself performs no external fetches (spec §19).
const ANNOUNCE_URL =
  "https://raw.githubusercontent.com/hiroragi2034/disney-plan-app-spec/main/announce.json";

// Allowlist HTML sanitizer for the announcement body (spec §22.1).
// The body arrives from the distributor's remote announce.json feed;
// as far as a viewer's browser is concerned it is unauthored markup,
// so it must never reach the dialog as raw HTML — whoever controls
// or compromises the feed could otherwise place event-handler
// markup (<img onerror>, <a href="javascript:…">) that executes in
// every viewer's browser. The body is therefore sanitized in
// checkAnnouncement, at save time, before it is stored or returned:
// only a small formatting vocabulary survives (paragraphs, line
// breaks, emphasis, lists, and https links), every other tag is
// dropped (its text kept, except script/style whose contents go
// too), all attributes are dropped except an https-only href on
// <a>, and all text is escaped. Tags are REBUILT from the parsed
// name (+ the validated href) instead of passing source markup
// through, so malformed or nested tag tricks have nothing to
// smuggle past.
const ANNOUNCEMENT_ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ul",
  "ol",
  "li",
]);

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeAnnouncementHtml(html: string): string {
  // Comments are removed first so their contents can never be
  // re-read as markup.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  let out = "";
  let rest = noComments;
  while (rest.length > 0) {
    const lt = rest.indexOf("<");
    if (lt === -1) {
      out += escapeHtmlText(rest);
      break;
    }
    if (lt > 0) out += escapeHtmlText(rest.slice(0, lt));
    const gt = rest.indexOf(">", lt);
    if (gt === -1) {
      // A "<" with no closing ">": literal text, not a tag.
      out += escapeHtmlText(rest.slice(lt));
      break;
    }
    const rawTag = rest.slice(lt, gt + 1);
    rest = rest.slice(gt + 1);
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)\/?>$/.exec(
      rawTag,
    );
    if (!m) continue; // not a recognizable tag: dropped entirely
    const closing = (m[1] ?? "") === "/";
    const name = (m[2] ?? "").toLowerCase();
    if ((name === "script" || name === "style") && !closing) {
      // Drop the element AND its contents up to its close tag.
      const closeAt = rest.toLowerCase().indexOf(`</${name}`);
      if (closeAt === -1) break;
      const closeGt = rest.indexOf(">", closeAt);
      rest = closeGt === -1 ? "" : rest.slice(closeGt + 1);
      continue;
    }
    if (name === "a") {
      if (closing) {
        out += "</a>";
        continue;
      }
      const attrs = m[3] ?? "";
      const hrefM =
        /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/i.exec(attrs);
      const href = (hrefM?.[1] ?? hrefM?.[2] ?? hrefM?.[3] ?? "").trim();
      // https only: no javascript:/data:/protocol-relative URLs,
      // and no character that could break out of the attribute.
      if (/^https:\/\/[^\s"'<>`]+$/.test(href)) {
        out += `<a href="${escapeHtmlText(href)}" target="_blank" rel="noreferrer">`;
      } else {
        out += "<a>";
      }
      continue;
    }
    if (!ANNOUNCEMENT_ALLOWED_TAGS.has(name)) continue;
    if (name === "br") {
      if (!closing) out += "<br>";
      continue;
    }
    out += closing ? `</${name}>` : `<${name}>`;
  }
  return out;
}

// Facility-dictionary freshness windows, per attribute group.
// Coordinates have NO TTL: once resolved they are reused forever (a
// facility's position does not move), so the first fetch is the only
// one ever paid. Static attributes (area / official URL / official
// duration) and intro photos change rarely, so they carry a long TTL
// and are re-fetched only after it lapses. Date-dependent facts (park
// hours, closures, show times) are never in the dictionary at all, and
// wait-time estimation material is re-fetched on every generation.
const STATIC_ATTR_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const IMAGE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// ---------- restaurant fact layer （レストラン事実レイヤー) ----------
//
// A restaurant's classification (reservation form / mobile order) is
// a normalized FACT grounded in that restaurant's own official
// detail page — the same snapshot → grounded-fact discipline as the
// DPA layer — never a facility-dictionary column and never an
// inference from a label. (The dictionary-column approach recorded
// ケープコッド・クックオフ as 予約必須 from its "show restaurant"
// label; its own detail page states no reservation requirement at
// all — only the separately-listed show-dining area of the same
// name requires one.) Facts are valid for 180 days from
// registration, following the dictionary TTL discipline.
const RESTAURANT_FACT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Phrases that, when present in an evidence excerpt, support each
// POSITIVE classification value. Registration refuses a positive
// value whose excerpt contains none of its supporting phrases.
const RESTAURANT_REQUIRED_EVIDENCE_MARKERS = [
"予約必須",
"予約が必要です",
"予約が必要",
"事前予約が必要",
"ご予約が必要",
];
const RESTAURANT_PS_EVIDENCE_MARKERS = ["プライオリティ・シーティング"];
const RESTAURANT_MOBILE_AVAILABLE_EVIDENCE_MARKERS = ["モバイルオーダー対象"];
const RESTAURANT_MOBILE_NOT_AVAILABLE_EVIDENCE_MARKERS = [
"モバイルオーダー対象外",
"モバイルオーダーの対象外",
"モバイルオーダーはご利用いただけません",
"モバイルオーダー対象店舗ではありません",
];

// Presence markers for the ABSENCE grounds of a negative
// classification: the server verifies that NONE of the axis's
// markers occur anywhere in the facility's full detail-page
// snapshot before a "none" / "not_available" fact may be
// registered, and the checked list is recorded on the fact. If any
// marker IS present, absence grounds fail — the value must then be
// grounded in an excerpt, or held as unknown with a reason.
const RESTAURANT_RESERVATION_ABSENCE_MARKERS = [
"プライオリティ・シーティング",
"予約必須",
"予約が必要です",
"予約が必要",
"事前予約",
"ショーレストラン",
"予約案内",
];
const RESTAURANT_MOBILE_ABSENCE_MARKERS = [
"モバイルオーダー対象",
"ディズニー・モバイルオーダー",
"モバイルオーダー",
];

type RestaurantAxisInput = {
type: string;
evidenceKind: "excerpt" | "absence";
evidence: string;
unknownReason?: string | null;
};

type RestaurantFactInput = {
name: string;
serviceType?: string | null;
snapshotId: number;
reservation: RestaurantAxisInput;
mobileOrder: RestaurantAxisInput;
};

// Machine validation of ONE restaurant fact against its grounding
// snapshot — the same level as saveNormalizedFacts: every evidence
// excerpt must be a verbatim substring of the stored snapshot text;
// a positive value's excerpt must contain a supporting phrase; a
// negative value grounded in absence is re-verified HERE against
// the full text (the marker list is never taken on trust); an
// unknown value requires a reason. Returns the list of problems
// (empty = registrable) plus the absence marker lists the server
// itself verified, which are what gets stored on the fact.
function validateRestaurantFact(
snap: SnapshotRow,
fact: RestaurantFactInput,
): { errors: string[]; reservationMarkers: string[] | null; mobileMarkers: string[] | null } {
const errors: string[] = [];
const name = fact.name;
if (snap.kind !== "restaurant_detail") {
errors.push(
`「${name}」：根拠スナップショット（id=${snap.id}）はレストラン詳細ページ（restaurant_detail）ではありません。分類の根拠は、その施設自身の公式レストラン詳細ページのスナップショットだけです`,
);
}
if (
fact.serviceType != null &&
fact.serviceType.trim() !== "" &&
!snap.rawText.includes(fact.serviceType)
) {
errors.push(
`「${name}」：種別（serviceType「${fact.serviceType}」）が根拠スナップショットの本文に逐語で含まれていません。公式ページの表記そのままを入れてください`,
);
}
const checkAxis = (
axisLabel: string,
value: string,
axis: RestaurantAxisInput,
positiveMarkers: string[] | null,
negativeValue: string,
negativeExcerptMarkers: string[] | null,
absenceMarkers: string[],
): string[] | null => {
if (!snap.rawText.includes(axis.evidence)) {
errors.push(
`「${name}」：${axisLabel}の根拠抜粋が、根拠スナップショット（id=${snap.id}）の生テキストに逐語で含まれていません。保存したスナップショットのテキストから、一字も変えずに抜粋してください`,
);
return null;
}
if (value === "unknown") {
if (axis.evidenceKind !== "excerpt") {
errors.push(
`「${name}」：${axisLabel}が未確認（unknown）の場合、根拠種別は excerpt（その施設の詳細ページを読んだことの抜粋）でなければなりません`,
);
}
if (!(axis.unknownReason ?? "").trim()) {
errors.push(
`「${name}」：${axisLabel}が未確認（unknown）のファクトには理由（unknownReason）が必須です。黙って「なし」に倒さず、読めなかった理由を書いてください`,
);
}
if (!facilityNameKey(axis.evidence).includes(facilityNameKey(name))) {
errors.push(
`「${name}」：${axisLabel}の未確認の根拠抜粋には、その施設名が含まれていなければなりません（その施設のページを読んだ根拠にするため）`,
);
}
return null;
}
if (value === negativeValue) {
if (axis.evidenceKind === "absence") {
// The absence proof is re-run HERE, server-side, against the
// full stored text — the registrant's claim is never trusted.
const present = absenceMarkers.filter((m) => snap.rawText.includes(m));
if (present.length > 0) {
errors.push(
`「${name}」：${axisLabel}の不在の根拠が成立しません。詳細ページ全文に、存在マーカー（${present.join("、")}）が含まれています。不在では登録できないので、抜粋による根拠にするか、未確認（unknown）＋理由で登録してください`,
);
return null;
}
if (!facilityNameKey(axis.evidence).includes(facilityNameKey(name))) {
errors.push(
`「${name}」：${axisLabel}の不在の根拠抜粋（同一性の錨）には、その施設名が含まれていなければなりません`,
);
return null;
}
return absenceMarkers;
}
if (!negativeExcerptMarkers) {
errors.push(
`「${name}」：${axisLabel}の否定分類（${value}）は抜粋では登録できません。不在の根拠（evidenceKind="absence"：詳細ページ全文に存在マーカーが無いことをサーバーが確認する形）で登録してください`,
);
} else if (
!negativeExcerptMarkers.some((m) => axis.evidence.includes(m))
) {
errors.push(
`「${name}」：${axisLabel}の根拠抜粋の中に、対象外であることを示す表記（${negativeExcerptMarkers.join("／")}）が含まれていません。対象外の表記を含む範囲を抜粋するか、不在の根拠（evidenceKind="absence"）で登録してください`,
);
}
return null;
}
// Positive value: excerpt grounds with a supporting phrase.
if (axis.evidenceKind !== "excerpt") {
errors.push(
`「${name}」：${axisLabel}の肯定分類（${value}）は、不在の根拠では登録できません。分類を裏づける表記を含む抜粋で登録してください`,
);
return null;
}
if (
positiveMarkers &&
!positiveMarkers.some((m) => axis.evidence.includes(m))
) {
errors.push(
`「${name}」：${axisLabel}の根拠抜粋の中に、分類（${value}）を裏づける表記（${positiveMarkers.join("／")}）が含まれていません。ラベルからの推測では登録できません。その施設自身の公式ページの記述を含む範囲を抜粋してください`,
);
}
return null;
};
const reservationMarkers = checkAxis(
"予約形態",
fact.reservation.type,
fact.reservation,
fact.reservation.type === "required"
? RESTAURANT_REQUIRED_EVIDENCE_MARKERS
: fact.reservation.type === "ps"
? RESTAURANT_PS_EVIDENCE_MARKERS
: null,
"none",
null,
RESTAURANT_RESERVATION_ABSENCE_MARKERS,
);
const mobileMarkers = checkAxis(
"モバイルオーダー",
fact.mobileOrder.type,
fact.mobileOrder,
fact.mobileOrder.type === "available"
? RESTAURANT_MOBILE_AVAILABLE_EVIDENCE_MARKERS
: null,
"not_available",
RESTAURANT_MOBILE_NOT_AVAILABLE_EVIDENCE_MARKERS,
RESTAURANT_MOBILE_ABSENCE_MARKERS,
);
return { errors, reservationMarkers, mobileMarkers };
}

type RestaurantFactRow = typeof schema.restaurantFacts.$inferSelect;

// The current fact for one restaurant: the newest registration for
// the park + normalized name, or null when there is none or it has
// passed the 180-day validity window (an expired fact is no fact —
// the display falls back to 未確認， never to the stale value).
async function findCurrentRestaurantFact(
ctx: Ctx,
park: "land" | "sea",
name: string,
): Promise<RestaurantFactRow | null> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.restaurantFacts)
.where(
and(
eq(schema.restaurantFacts.park, park),
eq(schema.restaurantFacts.nameKey, facilityNameKey(name)),
),
)
.orderBy(desc(schema.restaurantFacts.id))
.limit(1);
const row = rows[0];
if (!row) return null;
if (Date.now() - row.createdAt.getTime() > RESTAURANT_FACT_TTL_MS) {
return null;
}
return row;
}

// Dictionary key normalization: the same facility written with
// different spacing / width / case variants must hit one entry.
function facilityNameKey(name: string): string {
return name
.normalize("NFKC")
.replace(/[\s　]+/g, "")
.toLowerCase();
}

async function loadWaitTimeSources(
ctx: Ctx,
): Promise<z.infer<typeof waitTimeSourceShape>[]> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.waitTimeSources)
.orderBy(asc(schema.waitTimeSources.id));
return rows.map((r) => ({
id: r.id,
name: r.name,
url: r.url,
park: r.park,
provides: r.provides,
fetchMethod: r.fetchMethod,
lastCheckedAt: r.lastCheckedAt? r.lastCheckedAt.toISOString(): null,
}));
}

// Canonical "HH:MM" (zero-padded hour) form for a conditions time.
// The app's TEXT convention is the unpadded "9:00" form (schedule
// rows, snapshot text, chat extraction of the user's own words all
// produce it), but an HTML <input type="time"> accepts ONLY the
// zero-padded form — a value of "9:00" is invalid there and the
// control renders BLANK (the reported bug: a 9:00 entry time never
// showed in the プラン作成 form, while 21:00 exit times worked
// because they are two-digit to begin with). Every boundary that
// feeds a Conditions object or the client form therefore passes
// times through here: loadConditions, saveConditions,
// parseSnapshotConditions, the chat seal, and getState's same-day
// block. A string that is not an H:MM time at all is returned
// unchanged (nothing is silently dropped or invented); null stays
// null.
function padTimeOfDay(v: string | null): string | null {
if (v == null) return null;
const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
if (!m) return v;
const hour = Number(m[1]);
const minute = Number(m[2]);
if (hour > 23 || minute > 59) return v;
return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

// No 宿泊 line (owner's decision, 2026-11-16): the stay field was
// removed from the form — it had no mechanical effect, and its only
// coupling (gating the 8:45 Happy Entry entry-time option) made the
// form inconsistent. New snapshots therefore carry no stay line;
// parseSnapshotConditions still reads the line from OLD snapshots
// (history is never rewritten) but never reports it missing.
function conditionsToText(c: Conditions): string {
const lines: string[] = [
`パーク: ${parkName(c.park)}`,
`日付: ${c.visitDate?? "未定"}`,
`入園〜退園: ${c.entryTime?? "未定"} 〜 ${c.exitTime?? "未定"}`,
`予算: ${c.budgetJpy!= null? `${c.budgetJpy.toLocaleString("ja-JP")}円（総額・チケット代込み）`: "未定"}`,
`人数: 大人${c.adults}人 / 子ども${c.children}人${c.childrenAges? `（${c.childrenAges}）`: ""}`,
`重視する点: ${c.priority?? "未入力"}`,
`歩く速さ: ${WALKING_SPEED_LABELS[c.walkingSpeed]}（移動時間の計算に使う）`,
];
return lines.join("\n");
}

// Parses the 「重視する点」 premise back out of a stored conditions
// snapshot (the text conditionsToText produced at generation start).
// The snapshot is the only record of what the user asked for on that
// run — the live conditions form may have changed since — so every
// surface that shows a plan's premise reads from here. Two models
// exist: snapshots written since the 2026-11-14 design change carry
// ONE unified 「重視する点」 label (model "unified"); older snapshots
// carry the per-plan labels （プランA/B/Cの重視すること） plus the
// common one (model "legacy") and are parsed exactly as before —
// history is never rewritten into the new form. Values written as
// 未入力 (or left empty) read as null. Both the unified field and
// the legacy common field are textareas and may span several lines:
// lines after the label, up to the next known label （歩く速さ）,
// belong to the field.
function parseSnapshotPriorities(
snapshot: string | null,
): z.infer<typeof snapshotPrioritiesShape> {
const out: z.infer<typeof snapshotPrioritiesShape> = {
A: null,
B: null,
C: null,
common: null,
unified: null,
model: "legacy",
};
if (!snapshot) return out;
const clean = (v: string): string | null => {
const t = v.trim();
return t === "" || t === "未入力" ? null : t;
};
const lines = snapshot.split("\n");
let inCommon = false;
const commonParts: string[] = [];
let inUnified = false;
const unifiedParts: string[] = [];
for (const line of lines) {
const unified = /^重視する点[:：]\s*(.*)$/.exec(line);
if (unified) {
out.model = "unified";
inUnified = true;
inCommon = false;
unifiedParts.push(unified[1] ?? "");
continue;
}
const a = /^プランAの重視すること[:：]\s*(.*)$/.exec(line);
if (a) {
out.A = clean(a[1] ?? "");
inCommon = false;
inUnified = false;
continue;
}
const b = /^プランBの重視すること[:：]\s*(.*)$/.exec(line);
if (b) {
out.B = clean(b[1] ?? "");
inCommon = false;
inUnified = false;
continue;
}
const cMatch = /^プランCの重視すること[:：]\s*(.*)$/.exec(line);
if (cMatch) {
out.C = clean(cMatch[1] ?? "");
inCommon = false;
inUnified = false;
continue;
}
const common = /^共通して重視すること[:：]\s*(.*)$/.exec(line);
if (common) {
inCommon = true;
inUnified = false;
commonParts.push(common[1] ?? "");
continue;
}
if (/^歩く速さ[:：]/.test(line)) {
inCommon = false;
inUnified = false;
continue;
}
if (inCommon) commonParts.push(line);
if (inUnified) unifiedParts.push(line);
}
if (commonParts.length > 0) {
out.common = clean(commonParts.join("\n"));
}
if (unifiedParts.length > 0) {
out.unified = clean(unifiedParts.join("\n"));
}
return out;
}

// Parses the party recorded in a set's conditions snapshot (the text
// conditionsToText produced at generation start, or the 当日検索
// variant of it). The snapshot is the ONLY authority for the party a
// run was started under: the live conditions form may have been
// edited since, and money checks (DPA recompute) must run against
// the party the plan was actually made for — a chat-started run for
// 大人2人＋子ども2人 must never be re-checked against a form that
// still says 大人2人. Null when the snapshot carries no party line
// (callers then fall back to the form, for pre-snapshot legacy rows).
function parseSnapshotParty(
snapshot: string | null,
): { adults: number; children: number} | null {
if (!snapshot) return null;
const m = /人数[:：]\s*大人(\d+)人\s*\/\s*子ども(\d+)人/.exec(snapshot);
if (!m) return null;
return { adults: Number(m[1]), children: Number(m[2])};
}

// Parses the visit date and park recorded in a set's conditions
// snapshot, for the correspondence check at save time: the set row's
// own park / visitDate must agree with the snapshot stored on it —
// a payload produced under different conditions (a re-run of another
// run's plan) must not be able to complete under this set.
function parseSnapshotDatePark(snapshot: string | null): {
visitDate: string | null;
park: "land" | "sea" | null;
} {
const out: { visitDate: string | null; park: "land" | "sea" | null} = {
visitDate: null,
park: null,
};
if (!snapshot) return out;
const d = /日付[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(snapshot);
if (d) out.visitDate = d[1] ?? null;
if (/パーク[:：]\s*東京ディズニーランド/.test(snapshot)) out.park = "land";
else if (/パーク[:：]\s*東京ディズニーシー/.test(snapshot)) out.park = "sea";
return out;
}

function formatDateJa(iso: string | null): string | null {
if (!iso) return null;
const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
if (!m) return iso;
return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

// One-line statement of the conditions a set was ACTUALLY created
// under, read back from its stored snapshot and row (never the live
// form): date, park, party. Used in the start / completion / failure
// lines so the words always match the run that really happened.
function setConditionsSummary(set: {
conditionsSnapshot: string | null;
park: "land" | "sea";
visitDate: string | null;
setType?: string;
sameDayAdults?: number | null;
sameDayChildren?: number | null;
}): string {
const party =
set.setType === "same_day" && set.sameDayAdults != null
? {
adults: set.sameDayAdults,
children: set.sameDayChildren ?? 0,
}
: parseSnapshotParty(set.conditionsSnapshot);
const parts: string[] = [];
const dateJa = formatDateJa(set.visitDate);
if (dateJa) parts.push(dateJa);
parts.push(parkName(set.park));
if (party) {
parts.push(
party.children > 0
? `大人${party.adults}人＋子ども${party.children}人`
: `大人${party.adults}人`,
);
}
return parts.join("・");
}

// Correspondence between a plan set's row and the conditions
// snapshot stored on it (class 11): if the snapshot names a
// different date or park than the set itself, the submitted plans
// were produced under different conditions than the set records and
// must not complete under it.
function snapshotCorrespondenceViolations(set: {
conditionsSnapshot: string | null;
park: "land" | "sea";
visitDate: string | null;
}): string[] {
const snap = parseSnapshotDatePark(set.conditionsSnapshot);
const out: string[] = [];
const tag = "クラス11（プランの最低内容不足・条件対応）";
if (snap.visitDate && set.visitDate && snap.visitDate!== set.visitDate) {
out.push(
`対象日の不一致: セットの日付（${set.visitDate}）と、保存された条件スナップショットの日付（${snap.visitDate}）が一致しません（${tag}）。このセットの条件で作られたプランだけを保存してください。`,
);
}
if (snap.park && snap.park!== set.park) {
out.push(
`パークの不一致: セットのパーク（${parkName(set.park)}）と、保存された条件スナップショットのパーク（${parkName(snap.park)}）が一致しません（${tag}）。このセットの条件で作られたプランだけを保存してください。`,
);
}
return out;
}

type FloorPlanInput = {
slot: "A" | "B" | "C";
title: string;
summary?: string | null;
estimatedCostJpy?: number | null;
costBreakdown?:
| { label: string; amountJpy?: number | null}[]
| null;
items: {
name: string;
kind: string;
estWaitMin?: number | null;
}[];
};

// Class 11 — プランの最低内容 (the content floor). The other
// verification classes check a plan's CONSISTENCY (DPA facts, sums,
// schedule arithmetic); a nearly EMPTY plan contradicts nothing and
// used to sail through to 完了 — a set whose plan A was the single
// line 「21:00 退園」 completed and was announced as done. This
// floor is what a plan must minimally BE before consistency is even
// a question: a real title (not the slot letter), a non-empty
// summary, a computed cost total with an itemized breakdown, at
// least one real attraction/show item (not just entry/exit marker
// rows), and an estimated wait on every attraction AND show row.
//
// SUBSTANTIVE FLOORS (owner decision, 2026-11-15): the formal floor
// above let a fixture-shaped submission through — titles
// 「Aテスト／Bテスト／Cテスト」, summary "x", total ¥100 with a
// single ¥100 ticket line, one schedule row — because every check
// was about SHAPE, not substance. On top of the formal floor, each
// plan must now also clear:
// (f) a content-row floor: attraction + show + restaurant rows
//     must total at least CONTENT_ROW_FLOOR (6) — standard sets
//     only; a same-day set keeps only the legacy >=1 floor, since
//     its single plan covers a partial day;
// (g) a cost floor: the plan's total must not fall below the
//     party's ticket cost computed from the OFFICIAL 1-day passport
//     unit prices fetched on that run (see resolveTicketFloor —
//     the unit prices are machine-checked against the stored
//     ticket_prices snapshot, never taken from the payload's own
//     breakdown, so a ¥100 ticket line cannot talk its way past);
// (h) a summary-substance floor: a one-character summary, a
//     boilerplate-only summary, or fewer than 10 non-whitespace
//     characters is not a summary;
// (i) placeholder title patterns: titles that read as test /
//     placeholder text （テスト, test, 仮置き, ダミー, sample …)
//     are refused on top of the slot-letter check.
const CONTENT_ROW_FLOOR = 6;
const SUMMARY_MIN_CHARS = 10;
const PLACEHOLDER_TITLE_RE =
  /(テスト|てすと|test|仮タイトル|仮置き|ダミー|dummy|サンプル|sample|下書き|draft)/i;
const SUMMARY_BOILERPLATE_RE =
  /^(テスト|てすと|test|サンプル|sample|仮|仮置き|ダミー|dummy|未定|要約|説明文?|プラン[ABC](の)?(要約|説明|プラン)?|xxx+|・・・+|\.+|ー+|あとで書く|後で書く)$/i;

type FloorOptions = {
  // (f) Minimum content-row count per plan; null = not applied
  // (same-day sets).
  contentRowFloor?: number | null;
  // (g) Ticket-cost floor in JPY for this set's party, resolved
  // and machine-checked by resolveTicketFloor. Null = not applied
  // (same-day sets, whose cost excludes tickets by design).
  ticketFloorJpy?: number | null;
  // Human-readable basis of the ticket floor (unit prices × party)
  // for refusal messages.
  ticketFloorBasis?: string | null;
};

function planFloorViolations(
  plans: FloorPlanInput[],
  opts: FloorOptions = {},
): string[] {
const out: string[] = [];
const tag = "クラス11（プランの最低内容不足）";
for (const plan of plans) {
const title = (plan.title?? "").trim();
if (
title === "" ||
title === plan.slot ||
title === `プラン${plan.slot}`
) {
out.push(
`プラン${plan.slot}: タイトルが仮タイトル（「${title === ""? "空": title}」）のままです。プランの内容を表すタイトルを付けてください（${tag}）。`,
);
} else if (PLACEHOLDER_TITLE_RE.test(title)) {
out.push(
`プラン${plan.slot}: タイトル「${title}」がテスト／仮置きを示すパターンに一致します。プランの内容を表す実タイトルを付けてください（${tag}・タイトルの仮置きパターン）。`,
);
}
if (!(plan.summary?? "").trim()) {
out.push(`プラン${plan.slot}: 要約（summary）が空です（${tag}）。`);
} else {
const summaryChars = (plan.summary ?? "").replace(/\s+/g, "");
const boilerplate =
SUMMARY_BOILERPLATE_RE.test(summaryChars) ||
new Set(summaryChars).size === 1;
if (summaryChars.length < SUMMARY_MIN_CHARS || boilerplate) {
out.push(
`プラン${plan.slot}: 要約（summary）が実質を欠いています（空白を除いて${summaryChars.length}文字${boilerplate ? "・定型文／無内容のパターンに一致" : ""}）。そのプランの狙いが分かる${SUMMARY_MIN_CHARS}文字以上の実質のある要約を書いてください（${tag}・要約の実質）。`,
);
}
}
if (plan.estimatedCostJpy == null || plan.estimatedCostJpy <= 0) {
out.push(
`プラン${plan.slot}: 費用合計（estimatedCostJpy）が計算されていません（${tag}）。`,
);
}
if (
opts.ticketFloorJpy != null &&
plan.estimatedCostJpy != null &&
plan.estimatedCostJpy > 0 &&
plan.estimatedCostJpy < opts.ticketFloorJpy
) {
out.push(
`プラン${plan.slot}: 費用合計（¥${plan.estimatedCostJpy.toLocaleString("ja-JP")}）が、公式チケット単価から計算した人数分のチケット代の床（${opts.ticketFloorBasis ?? `¥${opts.ticketFloorJpy.toLocaleString("ja-JP")}`}）を下回っています。チケット代を含む1日分の総額として計算し直してください（${tag}・費用の床）。`,
);
}
const lines = plan.costBreakdown?? [];
if (lines.length === 0) {
out.push(
`プラン${plan.slot}: 費用の内訳（costBreakdown）がありません（${tag}）。`,
);
} else if (lines.some((l) => l.amountJpy == null)) {
out.push(
`プラン${plan.slot}: 費用の内訳に金額の入っていない項目があります（${tag}）。`,
);
}
const realItems = plan.items.filter(
(i) => i.kind === "attraction" || i.kind === "show",
);
if (realItems.length === 0) {
out.push(
`プラン${plan.slot}: アトラクション／ショーの実項目が1つもありません（入園・退園などのマーカー行だけの骨組みプランは保存できません）（${tag}）。`,
);
}
if (opts.contentRowFloor != null) {
const contentRows = plan.items.filter(
(i) =>
i.kind === "attraction" ||
i.kind === "show" ||
i.kind === "restaurant",
).length;
if (contentRows < opts.contentRowFloor) {
out.push(
`プラン${plan.slot}: 実項目（アトラクション・ショー・食事の行）が${contentRows}行しかありません（最低${opts.contentRowFloor}行必要）。入園・退園・移動・休憩・購入イベントの行は実項目に数えません（${tag}・実項目数の床）。`,
);
}
}
for (const item of plan.items) {
if (
(item.kind === "attraction" || item.kind === "show") &&
item.estWaitMin == null
) {
out.push(
`プラン${plan.slot}「${item.name}」: ${item.kind === "show"? "ショー": "アトラクション"}に推定待ち時間（estWaitMin）がありません。0分でも必ず入れてください（${tag}）。`,
);
}
}
}
return out;
}

// The ticket-price basis a save payload must carry for the class-11
// cost floor (g): the OFFICIAL 1-day passport unit prices for the
// visit date as fetched on that run (adult / child), plus the id of
// the ticket_prices source snapshot they were read from. The gate
// machine-checks the claimed prices against that stored snapshot's
// raw text — the payload's own cost breakdown is NEVER the basis,
// so a self-declared ¥100 ticket line cannot lower the floor.
const ticketPricesShape = z.object({
  adultJpy: z.number().int().min(1).max(100000),
  childJpy: z.number().int().min(1).max(100000).nullable().optional(),
  snapshotId: z.number().int().min(1),
});
type TicketPricesInput = z.infer<typeof ticketPricesShape>;

// Whether a price figure appears in a fetched page's raw text, in
// either grouped ("10,900") or plain ("10900") notation.
function priceAppearsInText(price: number, rawText: string): boolean {
  const grouped = price.toLocaleString("en-US");
  if (rawText.includes(grouped)) return true;
  return rawText.replace(/,/g, "").includes(String(price));
}

// Resolves the class-11 cost floor (g) for a set: the party's total
// ticket cost at the official unit prices the run fetched. Returns
// basis violations (class 11) when the payload carries no basis, a
// basis that cannot be tied to a stored ticket_prices snapshot of
// the set's park, a claimed unit price the snapshot text does not
// contain, or no child price for a party with children. Same-day
// sets are exempt: their plan cost excludes tickets by design.
async function resolveTicketFloor(
  ctx: Ctx,
  set: {
    park: "land" | "sea";
    setType: string;
    conditionsSnapshot: string | null;
    sameDayAdults?: number | null;
    sameDayChildren?: number | null;
  },
  ticketPrices: TicketPricesInput | null | undefined,
): Promise<{
  floorJpy: number | null;
  basis: string | null;
  violations: string[];
}> {
  const tag = "クラス11（プランの最低内容不足）";
  if (set.setType === "same_day") {
    return { floorJpy: null, basis: null, violations: [] };
  }
  const db = ctx.db<typeof schema>();
  let party = parseSnapshotParty(set.conditionsSnapshot);
  if (!party) {
    const form = await loadConditions(ctx);
    party = { adults: form.adults, children: form.children };
  }
  if (!ticketPrices) {
    return {
      floorJpy: null,
      basis: null,
      violations: [
        `チケット単価の根拠（ticketPrices：この回に公式から取得した対象日の1デーパスポート単価と、その取得元であるチケット価格スナップショットの id）が提出に含まれていないため、費用の床を検証できません。公式のチケット価格ページを取得して ticket_prices スナップショットとして保存し、その単価を根拠として提出してください（${tag}・費用の床の根拠なし）。`,
      ],
    };
  }
  const snapRows = await db
    .select()
    .from(schema.sourceSnapshots)
    .where(eq(schema.sourceSnapshots.id, ticketPrices.snapshotId))
    .limit(1);
  const snap = snapRows[0];
  if (!snap || snap.kind !== "ticket_prices" || snap.park !== set.park) {
    return {
      floorJpy: null,
      basis: null,
      violations: [
        `チケット単価の根拠スナップショット（id=${ticketPrices.snapshotId}）が、このパークのチケット価格（ticket_prices）スナップショットとして確認できません。公式のチケット価格ページをこの回に取得し、保存したスナップショットの id を根拠として提出してください（${tag}・費用の床の根拠なし）。`,
      ],
    };
  }
  const violations: string[] = [];
  if (!priceAppearsInText(ticketPrices.adultJpy, snap.rawText)) {
    violations.push(
      `申告された大人チケット単価（¥${ticketPrices.adultJpy.toLocaleString("ja-JP")}）が、根拠スナップショット「${snap.title ?? "チケット価格"}」の本文に確認できません。対象日の公式1デーパスポート単価をそのまま申告してください（${tag}・費用の床の根拠）。`,
    );
  }
  if (party.children > 0) {
    if (ticketPrices.childJpy == null) {
      violations.push(
        `子ども${party.children}人を含む構成なのに、子どもチケット単価の根拠が提出に含まれていません。公式の子ども単価も根拠として提出してください（${tag}・費用の床の根拠）。`,
      );
    } else if (!priceAppearsInText(ticketPrices.childJpy, snap.rawText)) {
      violations.push(
        `申告された子どもチケット単価（¥${ticketPrices.childJpy.toLocaleString("ja-JP")}）が、根拠スナップショット「${snap.title ?? "チケット価格"}」の本文に確認できません。対象日の公式1デーパスポート単価をそのまま申告してください（${tag}・費用の床の根拠）。`,
      );
    }
  }
  if (violations.length > 0) {
    return { floorJpy: null, basis: null, violations };
  }
  const floorJpy =
    ticketPrices.adultJpy * party.adults +
    (ticketPrices.childJpy ?? 0) * party.children;
  const basis =
    `公式チケット単価 大人¥${ticketPrices.adultJpy.toLocaleString("ja-JP")}×${party.adults}名` +
    (party.children > 0
      ? `＋子ども¥${(ticketPrices.childJpy ?? 0).toLocaleString("ja-JP")}×${party.children}名`
      : "") +
    `＝¥${floorJpy.toLocaleString("ja-JP")}`;
  return { floorJpy, basis, violations: [] };
}

// Class 12 — 条件対応の不一致 (spec §9.2): the party the COSTS were
// computed for must be the party in the set's conditions snapshot.
// The observable trace of the party in a submission is the ticket
// line of the cost breakdown: a line labelled as tickets must equal
// the snapshot party's ticket total at the submitted (snapshot-
// checked) official unit prices. A different amount means the plan
// was costed for a different party — e.g. a 3-person ticket line
// (¥32,700) on a 2-adult set (¥21,800) — and is refused here. Plans
// whose breakdown has no ticket-labelled line are not judged by
// this check (the class-11 cost floor still guards the total).
const TICKET_LINE_RE = /チケット|パスポート|入園料|入場料/;
function ticketLinePartyViolations(
  slot: string,
  costBreakdown:
    | { label: string; amountJpy?: number | null }[]
    | null
    | undefined,
  party: { adults: number; children: number } | null,
  ticketPrices: TicketPricesInput | null | undefined,
): string[] {
  if (!party || !ticketPrices) return [];
  if (party.children > 0 && ticketPrices.childJpy == null) return [];
  const expected =
    ticketPrices.adultJpy * party.adults +
    (ticketPrices.childJpy ?? 0) * party.children;
  const out: string[] = [];
  for (const line of costBreakdown ?? []) {
    if (!TICKET_LINE_RE.test(line.label)) continue;
    if (line.amountJpy == null) continue;
    if (line.amountJpy !== expected) {
      out.push(
        `プラン${slot}: 費用の内訳のチケット代（${line.amountJpy.toLocaleString("ja-JP")}円）が、条件の人数（大人${party.adults}人${party.children > 0 ? `＋子ども${party.children}人` : ""}）に公式チケット単価を掛けた金額（${expected.toLocaleString("ja-JP")}円）と一致しません。費用計算に用いた人数が、このセットの条件スナップショットの人数と異なります（条件対応の不一致・クラス12）。条件の人数で費用を計算し直して再保存してください。`,
      );
    }
  }
  return out;
}

// ---------- crowd forecast: decide once per date （変更2） ----------
//
// A visit date's crowd forecast is decided ONCE (owner decision,
// 2026-11-15): when a finished set for the same park + visit date
// already carries a decided forecast (crowdLevel / crowdBasis),
// later runs for that date REUSE it instead of re-evaluating —
// per-run re-evaluation made the same date's level swing between
// generations (4/5/4 for one date), and every plan of the date
// inherits the swing. The generation assignment states the held
// forecast up front (startGeneration looks it up), and savePlanSet
// enforces it at the storage layer: the stored premise is always
// the held one, with the reuse traceable in the stored basis.
type HeldCrowdForecast = {
  setId: number;
  title: string;
  level: number;
  basis: string | null;
};

async function findHeldCrowdForecast(
  ctx: Ctx,
  park: "land" | "sea",
  visitDate: string | null,
  excludeSetId?: number,
): Promise<HeldCrowdForecast | null> {
  if (!visitDate) return null;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.planSets)
    .where(
      and(
        eq(schema.planSets.park, park),
        eq(schema.planSets.visitDate, visitDate),
        eq(schema.planSets.status, "done"),
        isNotNull(schema.planSets.crowdLevel),
        ...(excludeSetId != null
          ? [ne(schema.planSets.id, excludeSetId)]
          : []),
      ),
    )
    .orderBy(desc(schema.planSets.id))
    .limit(1);
  const row = rows[0];
  if (!row || row.crowdLevel == null) return null;
  return {
    setId: row.id,
    title: row.title,
    level: row.crowdLevel,
    basis: row.crowdBasis,
  };
}

// The basis stored on a set that reused a held forecast: the held
// basis (with any earlier reuse trace stripped, so traces never
// stack) plus THIS reuse's trace, naming the deciding set.
function reusedCrowdBasis(held: HeldCrowdForecast): string {
  const trace = `混雑予想は日付ごとに1回だけ決めるため、この日付について先に決定済みの予想（セット「${held.title}」で決定した段階${held.level}／5）を再評価せず再利用した`;
  const base = (held.basis ?? "").split("（混雑予想は日付ごとに1回だけ決めるため")[0]?.trim() ?? "";
  return base ? `${base}（${trace}）` : `（${trace}）`;
}

async function loadConditions(ctx: Ctx): Promise<Conditions> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.conditions)
.where(eq(schema.conditions.id, 1))
.limit(1);
const row = rows[0];
if (!row) return {...DEFAULT_CONDITIONS};
return {
park: row.park,
visitDate: row.visitDate,
// Padded on the way out (see padTimeOfDay): rows stored before
// the normalization carry the unpadded "9:00" form, which the
// form's time inputs cannot display. The stored row itself is
// not rewritten here — the padded form persists the next time
// the user saves the conditions.
entryTime: padTimeOfDay(row.entryTime),
exitTime: padTimeOfDay(row.exitTime),
budgetJpy: row.budgetJpy,
adults: row.adults,
children: row.children,
childrenAges: row.childrenAges,
stayHotel: row.stayHotel,
priority: row.priority,
walkingSpeed: row.walkingSpeed,
};
}

// ---------- facility dictionary （施設辞書） ----------

type FacilityRow = typeof schema.facilities.$inferSelect;

// What one fetch learned about one facility. A field left undefined
// means "not fetched this time" and never touches the stored value;
// the group timestamps advance only for groups actually fetched.
type FacilityFetch = {
name: string;
area?: string | null;
officialUrl?: string | null;
durationMin?: number | null;
// Restaurant classification, read from the official restaurant
// detail page's own wording on the same fetch. Undefined = not
// read this time (stored value untouched); an explicit "unknown"
// IS a recorded value (the page was read and the point could not
// be determined) and overwrites like any other classification.
reservationType?: "required" | "ps" | "none" | "unknown" | null;
mobileOrder?: "available" | "unavailable" | "unknown" | null;
lat?: number | null;
lng?: number | null;
image?: { blobKey: string; source: "official" | "reference"} | null;
};

async function findFacility(
ctx: Ctx,
park: "land" | "sea",
name: string,
): Promise<FacilityRow | undefined> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.facilities)
.where(
and(
eq(schema.facilities.park, park),
eq(schema.facilities.nameKey, facilityNameKey(name)),
),
)
.limit(1);
return rows[0];
}

// Cached per-name official-duration （所要時間） lookup over the
// facility dictionary, for the display surfaces (plan tab / PDF):
// the tight-leg judgement needs the same duration the save-time
// gap verification used, and the dictionary is its only source.
function makeDurationLookup(
ctx: Ctx,
park: "land" | "sea",
): (name: string) => Promise<number | null> {
const cache = new Map<string, number | null>();
return async (name: string): Promise<number | null> => {
const key = facilityNameKey(name);
if (!cache.has(key)) {
const row = await findFacility(ctx, park, name);
cache.set(key, row?.durationMin ?? null);
}
return cache.get(key) ?? null;
};
}

// Restaurant classification lookup over the restaurant FACT layer
// (restaurant_facts), for the display surfaces (plan tab / PDF): a
// restaurant row's reservation / mobile-order display is derived
// from the current grounded fact for the row's facility name —
// never from the facility dictionary's legacy classification
// columns, which are no longer read anywhere. Returns null when the
// facility is not identified at all (no fact and no dictionary
// entry under that name — the row is out of classification scope);
// an identified facility with no current fact derives as "unknown"
// on both axes, never as "none" / "unavailable". The fact layer's
// mobile value "not_available" is mapped to the display shape's
// "unavailable".
function makeRestaurantLookup(
ctx: Ctx,
park: "land" | "sea",
): (
name: string,
) => Promise<{
reservationType: "required" | "ps" | "none" | "unknown";
mobileOrder: "available" | "unavailable" | "unknown";
} | null> {
const cache = new Map<
string,
{
reservationType: "required" | "ps" | "none" | "unknown";
mobileOrder: "available" | "unavailable" | "unknown";
} | null
>();
return async (name: string) => {
const key = facilityNameKey(name);
if (!cache.has(key)) {
const fact = await findCurrentRestaurantFact(ctx, park, name);
if (fact) {
cache.set(key, {
reservationType: fact.reservationType,
mobileOrder:
fact.mobileOrder === "not_available"
? "unavailable"
: fact.mobileOrder,
});
} else {
const row = await findFacility(ctx, park, name);
cache.set(
key,
row
? { reservationType: "unknown", mobileOrder: "unknown" }
: null,
);
}
}
return cache.get(key) ?? null;
};
}

// Per-group freshness of one dictionary row. Coordinates are usable
// whenever present (no expiry); static attributes and the photo are
// fresh only within their TTL of the group's last fetch.
function facilityFreshness(
row: FacilityRow,
now: number,
): { coordsUsable: boolean; staticFresh: boolean; imageFresh: boolean} {
return {
coordsUsable: row.lat != null && row.lng != null,
staticFresh:
row.staticFetchedAt != null &&
now - row.staticFetchedAt.getTime() <= STATIC_ATTR_TTL_MS,
imageFresh:
row.imageBlobKey != null &&
row.imageFetchedAt != null &&
now - row.imageFetchedAt.getTime() <= IMAGE_TTL_MS,
};
}

async function upsertFacilityFromFetch(
ctx: Ctx,
park: "land" | "sea",
f: FacilityFetch,
): Promise<{ droppedCoords: boolean}> {
const db = ctx.db<typeof schema>();
const now = new Date();
const nameKey = facilityNameKey(f.name);
// Park-range check (spec §10): coordinates outside the park's
// bounding box are NOT stored as fact — the row is saved without
// coordinates and the caller can report the drop. Every dictionary
// write funnels through here (saveFacilities, the save paths'
// fetched-attribute recording, Nominatim tier-1 heals, photo
// paths), so this one filter covers them all.
const droppedCoords =
f.lat != null &&
f.lng != null &&
!coordsInParkRange(park, f.lat, f.lng);
let hasCoords = f.lat != null && f.lng != null && !droppedCoords;
const hasStatic =
f.area !== undefined || f.officialUrl !== undefined ||
f.durationMin !== undefined;
const existing = await findFacility(ctx, park, f.name);
// Park-wide shows: a supplied pair is a name-matched node, never
// the show's own location (see the park-wide section below) —
// store the park's representative point instead, or no
// coordinates when no representative point can be derived yet,
// so the dictionary itself can never be poisoned with an
// out-of-park node for a park-wide show.
if (
hasCoords &&
(f.area?? existing?.area?? null) === PARKWIDE_AREA_NAME
) {
const rep = await parkRepresentativePoint(ctx, park);
if (rep) {
f = { ...f, lat: rep.lat, lng: rep.lng};
} else {
hasCoords = false;
}
}
if (!existing) {
await db.insert(schema.facilities).values({
park,
nameKey,
name: f.name,
area: f.area?? null,
officialUrl: f.officialUrl?? null,
durationMin: f.durationMin?? null,
reservationType: f.reservationType?? null,
mobileOrder: f.mobileOrder?? null,
lat: hasCoords? (f.lat as number): null,
lng: hasCoords? (f.lng as number): null,
imageBlobKey: f.image? f.image.blobKey: null,
imageSource: f.image? f.image.source: null,
coordsFetchedAt: hasCoords? now: null,
staticFetchedAt: hasStatic? now: null,
imageFetchedAt: f.image? now: null,
updatedAt: now,
});
return { droppedCoords };
}
const patch: Partial<FacilityRow> = { updatedAt: now};
if (f.area != null) patch.area = f.area;
if (f.officialUrl != null) patch.officialUrl = f.officialUrl;
if (f.durationMin != null) patch.durationMin = f.durationMin;
if (f.reservationType != null) patch.reservationType = f.reservationType;
if (f.mobileOrder != null) patch.mobileOrder = f.mobileOrder;
if (hasCoords) {
patch.lat = f.lat as number;
patch.lng = f.lng as number;
patch.coordsFetchedAt = now;
}
if (hasStatic) patch.staticFetchedAt = now;
if (f.image) {
patch.imageBlobKey = f.image.blobKey;
patch.imageSource = f.image.source;
patch.imageFetchedAt = now;
}
await db
.update(schema.facilities)
.set(patch)
.where(eq(schema.facilities.id, existing.id));
return { droppedCoords };
}

// A photo this app already owns for the same facility in ANOTHER plan
// set of the same park (typically the plan set a rebuild was made
// from). The facility dictionary is the designated cross-set photo
// store, but a set generated before the dictionary existed — or whose
// photos arrived through a path that never recorded them there —
// leaves the dictionary photo-less while its own plan items still
// carry the photos. Without this fallback, a rebuild of such a set
// silently loses every thumbnail: the generation task is told photos
// are reused (dictionary / carry-over), so it supplies no imageUrl,
// and the save finds neither a dictionary photo nor a URL. Reusing an
// already-owned blob of the very same facility needs no fetch and no
// task cooperation, so photo carry-over holds regardless.
async function findOwnedFacilityPhoto(
ctx: Ctx,
park: "land" | "sea",
name: string,
excludePlanSetId: number,
): Promise<{ key: string; source: "official" | "reference"} | null> {
const db = ctx.db<typeof schema>();
const key = facilityNameKey(name);
const rows = await db
.select({
planSetId: schema.plans.planSetId,
name: schema.planItems.name,
imageBlobKey: schema.planItems.imageBlobKey,
imageSource: schema.planItems.imageSource,
})
.from(schema.planItems)
.innerJoin(schema.plans, eq(schema.planItems.planId, schema.plans.id))
.innerJoin(
schema.planSets,
eq(schema.plans.planSetId, schema.planSets.id),
)
.where(
and(
eq(schema.planSets.park, park),
eq(schema.planSets.status, "done"),
),
);
for (const row of rows) {
if (!row.imageBlobKey) continue;
if (row.planSetId === excludePlanSetId) continue;
if (facilityNameKey(row.name)!== key) continue;
return {
key: row.imageBlobKey,
source: row.imageSource?? "official",
};
}
return null;
}

// ---------- save-time coordinate resolution （座標の安全網） ----------
//
// Generation / replacement tasks resolve coordinates themselves via
// Nominatim, but their attempts are not reliable: facilities that a
// plain direct query resolves immediately (ピーターパンのネバーランド
// アドベンチャー, ニモ＆フレンズ・シーライダー — the latter only once
// the ＆ is dropped) were recorded by tasks as "Nominatimで引けなかっ
// た", and a partial replacement that adds such a facility then saves
// it coordinate-less: no map pin, no route number — exactly the
// failure reported for センター・オブ・ジ・アース in plan B. So both
// save paths re-run the resolution HERE, deterministically, before
// travel legs are computed:
//
//   tier 1: the server re-queries Nominatim — the ONLY geocoder this
//     app may use (the user's settled rule) — with mechanical name
//     variants. A hit inside the resort vicinity becomes the
//     facility's coordinates and is recorded into the facility
//     dictionary, so the gap heals permanently.
//   tier 2: when the facility itself is genuinely absent from OSM
//     （センター・オブ・ジ・アース has no Nominatim feature under any
//     name variant — verified by direct queries on 2026-11-13), the
//     item falls back to its AREA's representative point: the area's
//     own Nominatim point, else the coordinates of an already-
//     resolved stop in the same area — the same convention move
//     items and the same-day origin already use. Area points are
//     NEVER recorded into the dictionary as the facility's own
//     coordinates, and every tier-2 use is disclosed in the set's
//     verification record / notes.

const NOMINATIM_UA =
"MuseDisneyPlanner/1.0 (personal pre-trip planning; coordinate lookup)";
// Tokyo Disney Resort vicinity: a Nominatim hit counts only inside
// this box, so a same-named place elsewhere can never be mistaken
// for a park facility.
const TDR_VICINITY = {
minLat: 35.608,
maxLat: 35.65,
minLng: 139.866,
maxLng: 139.904,
};

// ---------- park coordinate bounds （パーク範囲チェック, spec §10) ----------
//
// Per-park bounding boxes (owner's spec values): a coordinate
// outside its park's box is never stored as fact — not in the
// facility dictionary, not on a plan item, not from a server-side
// Nominatim re-resolution or a repair write. The failure this
// exists for is a digit-level transcription error (a longitude
// copied ~1.0° off puts the pin ~90 km away), which no semantic
// check can catch; a numeric range check can. Coordinates inside
// the box are stored exactly as before, and area representative
// points are judged by the same box.
const PARK_COORD_BOUNDS: Record<
"land" | "sea",
{ minLat: number; maxLat: number; minLng: number; maxLng: number}
> = {
land: { minLat: 35.618, maxLat: 35.652, minLng: 139.862, maxLng: 139.902 },
sea: { minLat: 35.608, maxLat: 35.645, minLng: 139.862, maxLng: 139.902 },
};

function coordsInParkRange(
park: "land" | "sea",
lat: number,
lng: number,
): boolean {
const b = PARK_COORD_BOUNDS[park];
return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

// The official duration a plan item's note states in the app's
// 「所要約◯分」 notation — the fallback duration source for the
// class-4 end-side check when the facility dictionary has no
// durationMin for the facility (spec §9.2 class 4).
function noteDurationMin(note: string | null | undefined): number | null {
if (!note) return null;
const m = /所要(?:時間)?[：:]?\s*約?\s*(\d+)\s*分/.exec(note);
return m ? Number(m[1]) : null;
}

let lastNominatimAt = 0;

async function nominatimQuery(
query: string,
): Promise<{ lat: number; lng: number} | null> {
// Nominatim's usage policy allows at most 1 request per second.
const wait = lastNominatimAt + 1100 - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
lastNominatimAt = Date.now();
try {
const url =
`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=jp&q=${encodeURIComponent(query)}`;
const res = await fetch(url, {
signal: AbortSignal.timeout(10000),
headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json"},
});
if (!res.ok) return null;
const data = (await res.json()) as { lat?: string; lon?: string}[];
for (const r of data) {
const lat = Number(r.lat);
const lng = Number(r.lon);
if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
if (lat < TDR_VICINITY.minLat || lat > TDR_VICINITY.maxLat) continue;
if (lng < TDR_VICINITY.minLng || lng > TDR_VICINITY.maxLng) continue;
return { lat, lng};
}
return null;
} catch {
return null;
}
}

// Mechanical variants of a facility's official name, most specific
// first: as-is, parenthetical suffix dropped, then the separator
// strips in COMBINATION (＆ dropped with ・ kept — the form OSM
// actually carries for ニモ＆フレンズ・シーライダー — ・ dropped with
// ＆ kept, and both dropped). Spec §10 bans qualifying the query with
// the park or area name at EVERY stage (an appended park name can
// zero out facilities the bare name would have found), so no
// park-name variant is tried here.
function facilityQueryVariants(
name: string,
park: "land" | "sea",
): string[] {
void park;
const noParen = name
.replace(/（[^）]*）/g, "")
.replace(/\([^)]*\)/g, "")
.trim();
const noAmp = noParen.replace(/＆/g, "").replace(/&/g, "").trim();
const noSep = noParen.replace(/・/g, "");
const noBoth = noSep.replace(/＆/g, "").replace(/&/g, "").trim();
const variants = [name, noParen, noAmp, noSep, noBoth];
return [...new Set(variants.filter((v) => v.length > 0))].slice(0, 6);
}

type CoordResolution = {
lat: number;
lng: number;
via: "nominatim" | "area" | "venue";
areaName: string | null;
// For via === "venue" (spec §10 step (4)): the venue name read
// from the run's official sources, whose own point stands in for
// the show's pin. Null for the other routes.
venueName?: string | null;
};

// Venue step (spec §10 step (4)): for a stage / theatre show the
// name ladder cannot resolve, the venue name stated by THIS run's
// official sources (the saved show / facility snapshots) is queried
// on Nominatim as-is, and the venue's own point becomes the show's
// pin — disclosed as 会場の地点 in the verification record. The
// venue name comes ONLY from the saved official texts (never from
// a bundled table); when no source states a venue, the step is
// skipped. Extraction is deliberately narrow: the venue label
// （会場 / 公演場所）must appear within a short window after the
// show's own name in the same text.
function extractVenueName(text: string, showName: string): string | null {
const variants = [
showName,
showName.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim(),
];
for (const v of variants) {
if (!v) continue;
const idx = text.indexOf(v);
if (idx < 0) continue;
const window = text.slice(idx, idx + 500);
const m = window.match(
/(?:会場|公演場所)\s*[:：]\s*([^\s、。・,，\n（(）)]{2,30})/,
);
if (m?.[1]) return m[1].trim();
}
return null;
}

async function findVenueNameFromSnapshots(
ctx: Ctx,
park: "land" | "sea",
showName: string,
): Promise<string | null> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.park, park))
.orderBy(desc(schema.sourceSnapshots.id))
.limit(40);
for (const r of rows) {
if (r.kind !== "show_schedule" && r.kind !== "facility_list") continue;
const v = extractVenueName(r.rawText, showName);
if (v) return v;
}
return null;
}

// Resolves coordinates for the facilities still missing them after
// payload + dictionary. `siblingsByArea` maps an area name to the
// coordinates of an already-resolved stop in that area (same plan /
// set); `dictByArea` is the same from the facility dictionary.
// Tier-1 hits are written into the dictionary here, so the caller's
// normal dictionary backfill picks them up everywhere. Returns a map
// keyed by facilityNameKey containing ONLY tier-2 (area) results —
// tier-1 results are visible through the dictionary instead.
async function resolveMissingFacilityCoords(
ctx: Ctx,
park: "land" | "sea",
missing: { name: string; area: string | null; kind?: string | null }[],
siblingsByArea: Map<string, { lat: number; lng: number}>,
dictByArea: Map<string, { lat: number; lng: number}>,
): Promise<Map<string, CoordResolution>> {
const out = new Map<string, CoordResolution>();
const byKey = new Map<
string,
{ name: string; area: string | null; kind?: string | null }
>();
for (const m of missing) {
const key = facilityNameKey(m.name);
if (!byKey.has(key)) byKey.set(key, m);
}
const areaPointCache = new Map<
string,
{ lat: number; lng: number} | null
>();
const areaPoint = async (
area: string,
): Promise<{ lat: number; lng: number} | null> => {
if (!areaPointCache.has(area)) {
let p = await nominatimQuery(area);
// Area representative points are judged by the park range too
// (spec §10): a point outside the park's box is not adopted.
if (p && !coordsInParkRange(park, p.lat, p.lng)) p = null;
if (!p) p = siblingsByArea.get(area)?? dictByArea.get(area)?? null;
areaPointCache.set(area, p);
}
return areaPointCache.get(area)?? null;
};
let networkBudget = 8;
for (const m of byKey.values()) {
const key = facilityNameKey(m.name);
let hit: { lat: number; lng: number} | null = null;
if (networkBudget > 0) {
networkBudget--;
for (const q of facilityQueryVariants(m.name, park)) {
hit = await nominatimQuery(q);
if (hit) break;
}
}
if (hit && coordsInParkRange(park, hit.lat, hit.lng)) {
await upsertFacilityFromFetch(ctx, park, {
name: m.name,
lat: hit.lat,
lng: hit.lng,
});
continue;
}
// A Nominatim hit outside the park's bounding box is not adopted
// as the facility's coordinates (spec §10) — fall through to the
// area representative point instead.
hit = null;
// Venue step (spec §10 step (4)): a stage / theatre show the name
// ladder could not resolve takes the point of the venue the run's
// official sources name for it. Tried before the area fallback;
// skipped entirely when no saved source states a venue.
if (m.kind === "show" || m.kind === "parade") {
const venueName = await findVenueNameFromSnapshots(ctx, park, m.name);
if (venueName) {
const vhit = await nominatimQuery(venueName);
if (vhit && coordsInParkRange(park, vhit.lat, vhit.lng)) {
// The venue point is NOT the facility's own coordinates,
// so it is never written into the facility dictionary (a
// dictionary entry would make later saves treat the pin as
// the facility's own point and drop this step's disclosure).
// It lives only in this save's resolution map, and every
// save re-derives and re-discloses it.
out.set(key, {
lat: vhit.lat,
lng: vhit.lng,
via: "venue",
areaName: m.area,
venueName,
});
continue;
}
}
}
if (m.area) {
const p = await areaPoint(m.area);
if (p) {
out.set(key, {
lat: p.lat,
lng: p.lng,
via: "area",
areaName: m.area,
});
}
}
}
return out;
}

// ---------- park-wide shows （パークワイド) ----------
//
// A park-wide show (area パークワイド — the fireworks スカイ・フル・
// オブ・カラーズ, seasonal park-wide entertainment) is viewable
// across the whole park: it HAS no single location of its own. A
// name-matched Nominatim node for such a show is therefore never
// its location — for スカイ・フル・オブ・カラーズ the only OSM node
// carrying the name sits on たる橋, a bridge OUTSIDE Tokyo
// DisneySea, and a generation task recorded that node into the
// facility dictionary and its plan items, so the map pin landed
// outside the park (the owner's report: 「スカイフルオブカラーズの
// 地図の場所がおかしい」). The park-range box cannot catch this —
// the bridge is inside the box; the point is simply not the show.
// The app's own convention for a park-wide show （ニューデイ、
// ニュードリームス in the dictionary) is the park's representative
// point — for Sea the Mediterranean Harbor point, where the
// fireworks are mainly watched and where entry/exit already pin.
// So, deterministically: an item whose area is パークワイド is
// pinned at the park's representative point, overriding payload
// and dictionary coordinates alike, and the dictionary write
// funnel substitutes the same point, so a task re-recording the
// bridge node can never re-poison the data. Every use is disclosed
// in the verification record / notes, like the tier-2 fallback.
const PARKWIDE_AREA_NAME = "パークワイド";
// The area whose representative point stands in for a park-wide
// show's pin, per park.
const PARK_REPRESENTATIVE_AREA: Record<"land" | "sea", string> = {
sea: "メディテレーニアンハーバー",
land: "ワールドバザール",
};

// The park's representative point, derived from data the app
// already holds: a facility dictionary row in the representative
// area (the harbor / World Bazaar rows carry the area's Nominatim
// point), else the area's own Nominatim point, park-range checked.
// Null when neither source yields a point — callers then keep the
// existing behaviour rather than invent a location.
async function parkRepresentativePoint(
ctx: Ctx,
park: "land" | "sea",
): Promise<{ lat: number; lng: number} | null> {
const repArea = PARK_REPRESENTATIVE_AREA[park];
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.facilities)
.where(eq(schema.facilities.park, park));
for (const r of rows) {
if (
r.area === repArea &&
r.lat != null &&
r.lng != null &&
coordsInParkRange(park, r.lat, r.lng)
) {
return { lat: r.lat, lng: r.lng};
}
}
const p = await nominatimQuery(repArea);
if (p && coordsInParkRange(park, p.lat, p.lng)) return p;
return null;
}

// Builds the tier-2 fallback map + disclosure notices for one save:
// scans the given plans' items (payload coordinates first, facility
// dictionary as backfill — the same effective values the save will
// store), collects the facilities still missing coordinates, and
// runs the deterministic resolution above. Tier-1 hits land in the
// dictionary (callers must run this BEFORE their dictionary caches
// fill); tier-2 results come back in the returned map, keyed by
// facilityNameKey, for the caller to consult alongside the
// dictionary.
async function buildCoordFallback(
ctx: Ctx,
park: "land" | "sea",
planItems: { name: string; kind?: string | null; area?: string | null; lat?: number | null; lng?: number | null}[][],
): Promise<{
fallback: Map<string, CoordResolution>;
parkWide: Map<string, { lat: number; lng: number; areaName: string}>;
notices: string[];
parkWideNotices: string[];
}> {
const db = ctx.db<typeof schema>();
const siblingsByArea = new Map<string, { lat: number; lng: number}>();
const missing: { name: string; area: string | null; kind: string | null}[] = [];
const seenMissing = new Set<string>();
// Park-wide facilities present in this save, by name key (display
// name kept for the disclosure notice). They are handled by the
// representative-point rule below, never by the missing-coords
// resolution: a name-matched OSM node for a park-wide show can be
// a point outside the park (see the park-wide section above).
const parkWideNames = new Map<string, string>();
for (const items of planItems) {
for (const item of items) {
const dict = await findFacility(ctx, park, item.name);
const area = item.area?? dict?.area?? null;
if (area === PARKWIDE_AREA_NAME) {
const key = facilityNameKey(item.name);
if (!parkWideNames.has(key)) parkWideNames.set(key, item.name);
}
// Park-range check (spec §10): a payload or dictionary pair
// outside the park's bounding box does not count as the
// facility having coordinates — it is neither a sibling point
// for other facilities nor a reason to skip the re-resolution.
const payloadPair =
item.lat != null &&
item.lng != null &&
coordsInParkRange(park, item.lat, item.lng)
? { lat: item.lat as number, lng: item.lng as number}
: null;
const dictPair =
dict?.lat != null &&
dict?.lng != null &&
coordsInParkRange(park, dict.lat, dict.lng)
? { lat: dict.lat, lng: dict.lng}
: null;
const lat = payloadPair ? payloadPair.lat : dictPair?.lat?? null;
const lng = payloadPair ? payloadPair.lng : dictPair?.lng?? null;
if (lat != null && lng != null) {
if (area && !siblingsByArea.has(area)) {
siblingsByArea.set(area, { lat, lng});
}
} else if (area !== PARKWIDE_AREA_NAME) {
const key = facilityNameKey(item.name);
if (!seenMissing.has(key)) {
seenMissing.add(key);
missing.push({ name: item.name, area, kind: item.kind?? null});
}
}
}
}
const notices: string[] = [];
const dictRows = await db
.select()
.from(schema.facilities)
.where(eq(schema.facilities.park, park));
const dictByArea = new Map<string, { lat: number; lng: number}>();
for (const r of dictRows) {
if (
r.area &&
r.lat != null &&
r.lng != null &&
coordsInParkRange(park, r.lat, r.lng) &&
!dictByArea.has(r.area)
) {
dictByArea.set(r.area, { lat: r.lat, lng: r.lng});
}
}
const fallback = await resolveMissingFacilityCoords(
ctx,
park,
missing,
siblingsByArea,
dictByArea,
);
for (const m of missing) {
const r = fallback.get(facilityNameKey(m.name));
if (r?.via === "area") {
notices.push(
`「${m.name}」の座標：施設自体はNominatimで引けなかったため、エリア「${r.areaName?? m.area?? ""}」の代表地点の座標で地図ピンを表示しています（施設の正確な位置ではありません）`,
);
}
if (r?.via === "venue") {
notices.push(
`「${m.name}」の座標：施設自体はNominatimで引けなかったため、公式ソースに示された会場「${r.venueName?? ""}」の地点の座標で地図ピンを表示しています（会場の地点です）`,
);
}
}
// Park-wide shows: the representative point, when one can be
// derived from this save's own stops, the dictionary, or the
// area's Nominatim point. Callers apply it OVER payload and
// dictionary coordinates — a park-wide show's recorded node is
// never its location (see the park-wide section above).
const parkWide = new Map<
string,
{ lat: number; lng: number; areaName: string}
>();
const parkWideNotices: string[] = [];
if (parkWideNames.size > 0) {
const repArea = PARK_REPRESENTATIVE_AREA[park];
const p =
siblingsByArea.get(repArea) ??
dictByArea.get(repArea) ??
(await parkRepresentativePoint(ctx, park));
if (p) {
for (const [key, name] of parkWideNames) {
parkWide.set(key, { lat: p.lat, lng: p.lng, areaName: repArea});
parkWideNotices.push(
`「${name}」の座標：パークワイドのショーのため、エリア「${repArea}」の代表地点の座標で地図ピンを表示しています（ショーはパーク全域で見られます）`,
);
}
}
}
return {
fallback,
parkWide,
notices: [...notices, ...parkWideNotices],
parkWideNotices,
};
}

// True when a task-supplied 未確認 entry claims the named facility
// has no coordinates ("X：座標が未確認…") — stale once the save-time
// resolution gave the facility coordinates after all. Leg entries
// （移動時間（A→B）：…) never match: they do not start with a facility
// name.
function isStaleCoordClaim(entry: string, healedNames: string[]): boolean {
if (!entry.includes("座標")) return false;
return healedNames.some(
(n) => entry.startsWith(n) || entry.startsWith(`「${n}」`),
);
}

// ---------- travel times （移動時間） ----------
//
// Travel time between two consecutive plan items is computed HERE,
// deterministically, never estimated by the generation task — so a
// saved plan's travel minutes can be audited and reproduced from its
// inputs (the user's chosen yardstick: an earlier plan cannot be
// trusted if its numbers cannot be re-derived).
//
// Formula (the user's design, approved 2026-11-13):
// 1. Straight-line (Haversine) distance between the two facilities'
//    coordinates — payload coordinates first, facility-dictionary
//    coordinates as the backfill, exactly like the save path stores.
//    A straight line is a LOWER bound on the real walk, never an
//    overestimate.
// 2. Distance-based minutes = distance / walking speed × a detour
//    factor that grows with distance (short hops are nearly straight;
//    longer ones pick up more path overhead):
//    ≤100m ×1.1 / ≤300m ×1.2 / ≤600m ×1.25 / >600m ×1.3.
//    Walking speeds (straight-line basis, m/min): ゆっくり 55 /
//    少しゆっくり 70 / 少し急いで 85 / 急いで 100. Calibration anchors
//    (user-checked against Google walking search): Sea end-to-end
//    ≈1.6km ≈ 25 min at 少し急いで (1600/85×1.3 ≈ 24.5); Land
//    end-to-end ≈800m ≈ 10 min.
// 3. Area matrix: when a typical-minutes value exists for the two
//    items' areas, take the MAX of the distance-based value and the
//    matrix value (both are lower bounds, so max is the correct
//    composition — it is what rescues pairs like a harbour crossing,
//    where the straight line is short but the walk goes around).
//    Matrix values are stored at the 少しゆっくり (70 m/min) baseline
//    and scaled by 70 / speed.
// 4. Margin: ×1.2 always (crowds slow everyone down; a plan that
//    arrives early is trusted, one that arrives late is not),
//    rounded UP to whole minutes, minimum 5 minutes for any leg that
//    involves moving.
//
// A leg whose either endpoint has no resolvable coordinates is
// UNVERIFIED （未確認）: no travelMin is stored, save-time verification
// falls back to the legacy floor (wait + 10 minutes) for that gap,
// and the leg is recorded in the verification record's 未確認 list.

const WALKING_SPEED_M_PER_MIN: Record<WalkingSpeed, number> = {
slow: 55,
slightly_slow: 70,
slightly_fast: 85,
fast: 100,
};

const WALKING_SPEED_LABELS: Record<WalkingSpeed, string> = {
slow: "ゆっくり",
slightly_slow: "少しゆっくり",
slightly_fast: "少し急いで",
fast: "急いで",
};

// The speed the area matrix's minutes are stated at.
const AREA_MATRIX_BASE_M_PER_MIN = 70;

// ---------- crowd forecast coefficients （混雑係数） ----------
//
// The generation task evaluates the visit date's expected crowd
// level on a 1–5 scale (1 = 空いている … 5 = 激混み） from the day of
// week, the season, running events and past congestion data, and
// stores the level + its basis on the plan set (plan_sets.crowd_*).
// Estimated waits are saved AFTER a crowd coefficient is applied:
// the values below are CAPS — the factor for the most crowd-
// sensitive headline attractions (Soaring / Frozen class). Every
// other facility gets an effective factor at or below the cap,
// estimated per facility by the generation task from demand ×
// supply (popularity, capacity, turnover), and the effective factor
// actually applied per facility is reported back and kept in the
// verification record (crowdFactors) so the multiplication is never
// a black box.
//
// Owner-set values (2026-11-14, adjustable constants — change them
// here and in the client copy in plan_metrics.ts): 1 → 0.8,
// 2 → 0.9, 3 → 1.0, 4 → 2.0 (owner-set 2026-11-19 from measured
// level-4/level-3 wait ratios), 5 → 5.0 (owner's fixed
// value: Soaring posted a 340-minute wait on 2026-01-06, so a
// peak-day headline wait can reach five times the base estimate).
const CROWD_WAIT_FACTOR_CAPS: Record<number, number> = {
1: 0.8,
2: 0.9,
3: 1.0,
4: 2.0,
5: 5.0,
};

function crowdFactorCap(level: number): number {
return CROWD_WAIT_FACTOR_CAPS[level] ?? 1.0;
}

// "×2.0" / "×1.0" style factor label for records and displays.
function crowdFactorLabel(factor: number): string {
return `×${Number.isInteger(factor) ? factor.toFixed(1) : String(factor)}`;
}

// ---------- crowd scenarios （混雑シナリオ） ----------
//
// The three plans of a standard set are differentiated by crowd
// scenario (owner's design, 2026-11-14), derived deterministically
// from the slot and the set's forecast level: plan A is built as if
// the day turns out BUSIER than forecast ("severe" — 激混み前提）,
// plan B on the forecast itself ("expected" — やや混み前提）, and
// plan C as if it turns out QUIETER ("light" — 思ったより空いてる
// 前提）. Each scenario's effective level (forecast ±1, clamped to
// 1–5) sets the CAP for that plan's per-facility effective factors.
// The server stamps scenario + level onto each plan row at save
// time; the generation task only reports the factors it applied.
type CrowdScenario = "severe" | "expected" | "light";

const CROWD_SCENARIO_BY_SLOT: Record<"A" | "B" | "C", CrowdScenario> = {
A: "severe",
B: "expected",
C: "light",
};

const CROWD_SCENARIO_LABELS: Record<CrowdScenario, string> = {
severe: "激混み前提",
expected: "やや混み前提",
light: "思ったより空いてる前提",
};

function crowdScenarioLevel(
forecastLevel: number,
scenario: CrowdScenario,
): number {
if (scenario === "severe") return Math.min(5, forecastLevel + 1);
if (scenario === "light") return Math.max(1, forecastLevel - 1);
return forecastLevel;
}

// The scenario + effective level to stamp on a plan row, or nulls
// when the run has no forecast (or is a same-day set, whose waits
// come from current postings and carry no coefficient at all).
function planScenarioFor(
slot: "A" | "B" | "C",
forecastLevel: number | null | undefined,
isSameDay: boolean,
): { scenario: CrowdScenario | null; level: number | null } {
if (isSameDay || forecastLevel == null) {
return { scenario: null, level: null };
}
const scenario = CROWD_SCENARIO_BY_SLOT[slot];
return { scenario, level: crowdScenarioLevel(forecastLevel, scenario) };
}

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

// Canonical matrix-pair key from two area names (either order), or
// null when the pair is meaningless (missing area, or same area).
function areaPairKey(areaA: string, areaB: string): string | null {
const ka = facilityNameKey(areaA);
const kb = facilityNameKey(areaB);
if (!ka || !kb || ka === kb) return null;
return ka < kb? `${ka}|${kb}`: `${kb}|${ka}`;
}

type AreaMatrixEntry = {
areaA: string;
areaB: string;
minutes: number;
sourceTitle: string | null;
sourceUrl: string | null;
fetchedAt: string | null;
};

async function loadAreaMatrix(
ctx: Ctx,
park: "land" | "sea",
): Promise<Map<string, AreaMatrixEntry>> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.areaTravelTimes)
.where(eq(schema.areaTravelTimes.park, park));
const map = new Map<string, AreaMatrixEntry>();
for (const r of rows) {
map.set(`${r.areaAKey}|${r.areaBKey}`, {
areaA: r.areaA,
areaB: r.areaB,
minutes: r.minutes,
sourceTitle: r.sourceTitle,
sourceUrl: r.sourceUrl,
fetchedAt: r.fetchedAt,
});
}
return map;
}

// The registered matrix pairs for one park, formatted for a
// generation assignment: what the task may rely on, and what it
// still has to research (missing pairs are distance-only until a
// task registers them from a real guide source).
function areaMatrixLinesFor(
matrix: Map<string, AreaMatrixEntry>,
): string {
if (matrix.size === 0) {
return `【エリア間マトリクス（エリア同士の典型徒歩時間）】このパークにはまだ登録がありません。`;
}
const lines = [...matrix.values()].map(
(e) => `- ${e.areaA} ⇔ ${e.areaB}: 約${e.minutes}分`,
);
return [
`【エリア間マトリクス（登録済み・少しゆっくり＝70m/分基準の典型徒歩時間）】`,
...lines,
].join("\n");
}

// The deterministic travel minutes for one leg. Pure function of
// (distance, speed, matrix minutes) — the audit surface of the whole
// system: given the same inputs it always returns the same number.
function computeTravelMin(
distM: number,
speed: WalkingSpeed,
matrixMinutes: number | null,
): number {
const speedM = WALKING_SPEED_M_PER_MIN[speed];
let base = (distM / speedM) * detourFactor(distM);
if (matrixMinutes != null) {
base = Math.max(
base,
matrixMinutes * (AREA_MATRIX_BASE_M_PER_MIN / speedM),
);
}
return Math.max(5, Math.ceil(base * 1.2));
}

// One resolved plan item for travel computation: effective
// coordinates / area / official duration after the dictionary
// backfill (the same values the save path will store).
type ResolvedItem = {
name: string;
kind: string;
lat: number | null;
lng: number | null;
area: string | null;
durationMin: number | null;
};

type LegResult = {
travelMin: number | null;
distM: number | null;
matrixUsed: boolean;
matrixEntry: AreaMatrixEntry | null;
};

// Computes the leg INTO each item (legs[i] is the travel from item
// i-1 to item i; legs[0] is null — there is no previous stop).
function computeLegs(
items: ResolvedItem[],
speed: WalkingSpeed,
matrix: Map<string, AreaMatrixEntry>,
): (LegResult | null)[] {
const legs: (LegResult | null)[] = [];
// Index of the last real stop: a purchase-event row is not a place
// visit (a DPA is bought in the app, wherever the visitor stands),
// so it neither consumes nor produces a travel leg — its leg is a
// zero pass-through and the next real item's leg is computed from
// the last real stop, keeping gap sums across it exact. The
// display-only 「最初の10分」 row (kind "first10") is transparent
// for exactly the same reason: it is not a place either.
let prevIdx = -1;
for (let i = 0; i < items.length; i++) {
const cur = items[i];
if (!cur) {
legs.push(null);
continue;
}
if (cur.kind === "purchase" || cur.kind === "first10") {
legs.push({
travelMin: 0,
distM: 0,
matrixUsed: false,
matrixEntry: null,
});
continue;
}
if (prevIdx < 0) {
legs.push(null);
prevIdx = i;
continue;
}
const prev = items[prevIdx];
if (
!prev ||
prev.lat == null || prev.lng == null ||
cur.lat == null || cur.lng == null
) {
legs.push({
travelMin: null,
distM: null,
matrixUsed: false,
matrixEntry: null,
});
prevIdx = i;
continue;
}
const distM = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
let matrixEntry: AreaMatrixEntry | null = null;
if (prev.area && cur.area) {
const key = areaPairKey(prev.area, cur.area);
if (key) matrixEntry = matrix.get(key)?? null;
}
const distOnly = computeTravelMin(distM, speed, null);
const travelMin = computeTravelMin(
distM,
speed,
matrixEntry? matrixEntry.minutes: null,
);
legs.push({
travelMin,
distM,
matrixUsed: matrixEntry != null && travelMin > distOnly,
matrixEntry,
});
prevIdx = i;
}
return legs;
}

// The travel allowance for the gap between the timed item at index
// `from` and the timed item at index `to` (from < to): the sum of the
// legs between them when every leg is verified, else null (the gap
// then verifies against the legacy floor and the unverified legs are
// reported). Summing matters when an untimed item (e.g. a break with
// no clock time) sits between two timed ones.
function gapTravelMin(
legs: (LegResult | null)[],
from: number,
to: number,
): number | null {
let sum = 0;
for (let i = from + 1; i <= to; i++) {
const leg = legs[i];
if (!leg || leg.travelMin == null) return null;
sum += leg.travelMin;
}
return sum;
}

// One facility's ELIGIBLE normalized fact, in the shape the
// verification record's legacy `dpaExtracted` list carries: the unit
// price plus the application period （適用期間） the fact states.
// effectiveFrom / effectiveTo are ISO dates (YYYY-MM-DD); both null
// means the fact carries no period, in which case the facility is
// treated as part of the lineup in force at fetch time.
// periodEvidence is the fact's verbatim evidence excerpt, kept so
// the record shows its grounds. Dates are never guessed: a period
// exists on a fact only when its evidence excerpt states one (the
// registration check enforces exactly that).
type DpaExtractedEntry = {
name: string;
priceJpy: number;
effectiveFrom: string | null;
effectiveTo: string | null;
periodEvidence: string | null;
};

function isIsoDate(s: string | null | undefined): s is string {
return s != null && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// "H:MM" / "HH:MM" at the start of a label -> minutes since
// midnight, or null. Module-level twin of the parseTime closures
// inside the save actions, for the re-verification checks.
function parseTimeLabel(label: string | null | undefined): number | null {
if (!label) return null;
const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
if (!m) return null;
return Number(m[1]) * 60 + Number(m[2]);
}

function fmtMinutesOfDay(min: number): string {
return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

// The park-local (Asia/Tokyo) calendar day of an instant, as an ISO
// date string. The day-before dialog is judged on THIS day — the
// park's day, not the viewer's.
function jstTodayIso(now: Date = new Date()): string {
return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// The ISO day before an ISO date (pure calendar arithmetic on UTC
// midnights, so no timezone ever shifts the result).
function isoDayBefore(iso: string): string | null {
if (!isIsoDate(iso)) return null;
const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
const dt = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000);
return dt.toISOString().slice(0, 10);
}

// A verification record's checkedAt string -> the instant it names.
// checkedAt is the fetch DATE as the task reported it ("2026/11/13"
// in ja-JP form, or an ISO date); it is read as that calendar day in
// Asia/Tokyo (noon JST, so the day survives any display timezone).
// Null when the string names no readable date — the caller then
// falls back instead of inventing one.
function checkedAtToDate(s: string | null | undefined): Date | null {
if (!s) return null;
const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s.trim());
if (!m) return null;
const y = Number(m[1]);
const mo = Number(m[2]);
const d = Number(m[3]);
if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
return new Date(Date.UTC(y, mo - 1, d, 3, 0, 0));
}

// ISO date (YYYY-MM-DD) -> Japanese display (2026年11月30日）.
function isoDateJa(iso: string): string {
const [y = "", m = "", d = ""] = iso.split("-");
return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

function dpaPeriodRangeText(e: {
effectiveFrom: string | null;
effectiveTo: string | null;
}): string {
if (e.effectiveFrom && e.effectiveTo) {
return `${isoDateJa(e.effectiveFrom)}〜${isoDateJa(e.effectiveTo)}`;
}
if (e.effectiveFrom) return `${isoDateJa(e.effectiveFrom)}から`;
if (e.effectiveTo) return `${isoDateJa(e.effectiveTo)}まで`;
return "";
}

// Why an extracted DPA entry is NOT valid on the visit date, or
// null when it is valid then — or when no judgement is possible
// (the entry carries no period, or the visit date is not a usable
// ISO date). Eligibility is judged against the lineup in force ON
// THE VISIT DATE, never against the lineup at fetch time alone.
function dpaPeriodExclusionReason(
e: { effectiveFrom: string | null; effectiveTo: string | null},
visitDate: string | null,
): string | null {
if (!isIsoDate(visitDate)) return null;
if (e.effectiveFrom && visitDate < e.effectiveFrom) {
return `適用開始日（${isoDateJa(e.effectiveFrom)}）より前`;
}
if (e.effectiveTo && visitDate > e.effectiveTo) {
return `適用終了日（${isoDateJa(e.effectiveTo)}）より後`;
}
return null;
}

// The application-period part of a verification record's DPA
// eligibility check: which eligible facts carry a period, and which
// of those fall outside the visit date. When NO eligible fact
// carries a period, the record says so — the judgement then ran on
// the lineup in force at fetch time, and that limitation is stated
// rather than silent.
function dpaPeriodRecordText(
extracted: Map<string, DpaExtractedEntry>,
visitDate: string | null,
factsPresent: boolean,
): string {
const withPeriod = [...extracted.values()].filter(
(e) => e.effectiveFrom || e.effectiveTo,
);
if (withPeriod.length === 0) {
return factsPresent
? "適用期間が記録されたファクトはなかったため、取得時点で有効な現行ラインナップとして判定"
: "";
}
let text = `適用期間がファクトに記録された施設：${withPeriod
.map((e) => `${e.name}（${dpaPeriodRangeText(e)}）`)
.join("、")}`;
if (isIsoDate(visitDate)) {
const excluded = withPeriod.filter(
(e) => dpaPeriodExclusionReason(e, visitDate)!= null,
);
text += `。来園日（${isoDateJa(visitDate)}）時点で有効な対象だけで判定`;
if (excluded.length > 0) {
text += `（来園日時点で対象外：${excluded
.map((e) => `${e.name}（${dpaPeriodRangeText(e)}）`)
.join("、")}）`;
}
} else {
text += "。来園日が定まっていないため、適用期間との照合はしていない";
}
return text;
}

// ---------- normalized source layer: gate access ----------
//
// The DPA gate's ONLY judgement source: one fact build's normalized
// facts. A build is loaded with its facts and each fact's evidence
// snapshot, and shaped three ways: a lookup map for the gate, the
// record's display facts (fact + grounds), and the legacy eligible
// list the record's price displays read.

type FactBuildRow = typeof schema.factBuilds.$inferSelect;
type FactRow = typeof schema.normalizedFacts.$inferSelect;
type SnapshotRow = typeof schema.sourceSnapshots.$inferSelect;

type DpaFactGate = {
build: FactBuildRow | null;
factsByKey: Map<string, FactRow>;
summary: z.infer<typeof factSummaryShape> | null;
displayFacts: z.infer<typeof dpaFactShape>[];
eligibleEntries: Map<string, DpaExtractedEntry>;
missingNames: string[];
};

const SNAPSHOT_KIND_LABELS: Record<string, string> = {
dpa_page: "DPA案内ページ",
facility_list: "施設全一覧",
operations: "営業時間・休止情報",
show_schedule: "公演スケジュール",
ticket_prices: "チケット価格",
announcements: "告知・ニュース一覧",
};

async function loadDpaFactGate(
ctx: Ctx,
factBuildId: number | null | undefined,
park: "land" | "sea",
): Promise<DpaFactGate> {
const empty: DpaFactGate = {
build: null,
factsByKey: new Map(),
summary: null,
displayFacts: [],
eligibleEntries: new Map(),
missingNames: [],
};
if (factBuildId == null) return empty;
const db = ctx.db<typeof schema>();
const buildRows = await db
.select()
.from(schema.factBuilds)
.where(eq(schema.factBuilds.id, factBuildId))
.limit(1);
const build = buildRows[0];
if (!build || build.park !== park) return empty;
const factRows = await db
.select()
.from(schema.normalizedFacts)
.where(eq(schema.normalizedFacts.buildId, build.id))
.orderBy(asc(schema.normalizedFacts.id));
const snapshotIds = [...new Set(factRows.map((f) => f.snapshotId))];
const snapshotById = new Map<number, SnapshotRow>();
if (snapshotIds.length > 0) {
const snapRows = await db
.select()
.from(schema.sourceSnapshots)
.where(inArray(schema.sourceSnapshots.id, snapshotIds));
for (const s of snapRows) snapshotById.set(s.id, s);
}
const factsByKey = new Map<string, FactRow>();
for (const f of factRows) factsByKey.set(f.nameKey, f);
const parseNameList = (json: string | null): string[] => {
if (!json) return [];
try {
const v: unknown = JSON.parse(json);
return Array.isArray(v)
? v.filter((x): x is string => typeof x === "string")
: [];
} catch {
return [];
}
};
const parseUnknowns = (
json: string | null,
): { name: string; reason: string}[] => {
if (!json) return [];
try {
const v: unknown = JSON.parse(json);
return Array.isArray(v)
? v
.filter(
(u): u is { name: string; reason: string} =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
typeof (u as { reason?: unknown }).reason === "string",
)
.map((u) => ({ name: u.name, reason: u.reason }))
: [];
} catch {
return [];
}
};
const missingNames = parseNameList(build.missingJson);
const parseValueChanges = (
json: string | null,
): z.infer<typeof factValueChangeShape>[] => {
if (!json) return [];
try {
const v: unknown = JSON.parse(json);
return Array.isArray(v)
? v
.filter(
(u): u is z.infer<typeof factValueChangeShape> =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
((u as { field?: unknown }).field === "price" ||
(u as { field?: unknown }).field === "status") &&
typeof (u as { oldValue?: unknown }).oldValue === "string" &&
typeof (u as { newValue?: unknown }).newValue === "string",
)
.map((u) => ({
name: u.name,
field: u.field,
oldValue: u.oldValue,
newValue: u.newValue,
effectiveFrom:
typeof u.effectiveFrom === "string" ? u.effectiveFrom : null,
}))
: [];
} catch {
return [];
}
};
const parseValueKnockdowns = (
json: string | null,
): z.infer<typeof factValueKnockdownShape>[] => {
if (!json) return [];
try {
const v: unknown = JSON.parse(json);
return Array.isArray(v)
? v
.filter(
(u): u is z.infer<typeof factValueKnockdownShape> =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
((u as { field?: unknown }).field === "price" ||
(u as { field?: unknown }).field === "status") &&
typeof (u as { baselineValue?: unknown }).baselineValue ===
"string" &&
typeof (u as { submittedValue?: unknown }).submittedValue ===
"string" &&
typeof (u as { reason?: unknown }).reason === "string",
)
.map((u) => ({
name: u.name,
field: u.field,
baselineValue: u.baselineValue,
submittedValue: u.submittedValue,
reason: u.reason,
}))
: [];
} catch {
return [];
}
};
const summary: z.infer<typeof factSummaryShape> = {
universeCount: build.universeCount,
eligibleCount: build.eligibleCount,
notEligibleCount: build.notEligibleCount,
unknownCount: build.unknownCount,
complete: build.complete === 1 && missingNames.length === 0,
unknowns: parseUnknowns(build.unknownJson),
// Value-diff disclosure: the baseline this build was diffed
// against at registration, the changes accepted as legitimate,
// and the facts knocked down to unknown. Builds registered
// before the diff gate existed carry no record (null / empty).
baselineBuildId: build.baselineBuildId ?? null,
valueChanges: parseValueChanges(build.valueChangesJson),
valueDiffKnockdowns: parseValueKnockdowns(
build.valueDiffKnockdownsJson,
),
};
const displayFacts: z.infer<typeof dpaFactShape>[] = factRows.map((f) => {
const snap = snapshotById.get(f.snapshotId);
return {
name: f.name,
status: f.status,
priceJpy: f.priceJpy,
effectiveFrom: f.effectiveFrom,
effectiveTo: f.effectiveTo,
unknownReason: f.unknownReason,
evidence: f.evidence,
evidenceKind: f.evidenceKind,
snapshotKind: snap ? (SNAPSHOT_KIND_LABELS[snap.kind] ?? snap.kind) : null,
snapshotUrl: snap ? snap.url : null,
snapshotFetchedAt: snap ? snap.fetchedAt.toISOString() : null,
};
});
const eligibleEntries = new Map<string, DpaExtractedEntry>();
for (const f of factRows) {
if (f.status === "eligible" && f.priceJpy != null) {
eligibleEntries.set(f.nameKey, {
name: f.name,
priceJpy: f.priceJpy,
effectiveFrom: f.effectiveFrom,
effectiveTo: f.effectiveTo,
periodEvidence: f.evidence,
});
}
}
return {
build,
factsByKey,
summary,
displayFacts,
eligibleEntries,
missingNames,
};
}

// ---------- DPA purchase instances （購入インスタンス) ----------
//
// Ruling (2026-11-13): DPA money moves at PURCHASE, so DPA cost is
// counted on purchase events — once per purchase instance
// (facility × purchase event) — and NEVER on usage rows. A plan
// represents one purchase either as an explicit purchase-event row
// (kind = "purchase", carrying the fact unit price as unitPriceJpy)
// or, in the legacy shape, only through the usage row's
// dpaPurchaseTime; both shapes group into the SAME instance when
// facility and purchase time match, so one purchase can never be
// counted twice no matter how many rows mention it. A unit price
// stated on a USAGE row is ignored entirely: not counted, never a
// rejection reason. Only a PURCHASE row's stated price is
// cross-checked against the fact price (a mismatch is a class-2
// rejection: DPA費用の計上不一致).

// Ruling (2026-11-17, extends the 2026-11-13 ruling above): the
// multiplier is NOT the party size. Each purchase-event row
// carries purchaseCount — the number of people who actually use
// that facility in that plan (riders for an attraction; viewers
// in the DPA viewing area for a show; the whole party only when
// everyone uses it) — and the instance's cost is fact unit price
// × purchaseCount. The save-time gates refuse a purchase row
// whose count is missing, below 1, or above the party size as
// class 2, rather than silently counting the whole party.
// Instances in the legacy shape (no purchase-event row, or a
// stored purchase row saved before purchaseCount existed) keep
// the party-size multiplier in READ-TIME derivations only, so
// existing sets' amounts never change; stored rows are never
// rewritten.

// ---------- row-level unconfirmed elements (§9.4) ----------
//
// The verification-record 未確認 entry for one row-level unconfirmed
// element, DERIVED from the row's own reason / explanation — the row
// is the single source of truth, so the record can never drift from
// what the row itself displays. Show/parade rows name the
// performance time (the aspect the class-5 gate judges); other rows
// use the plain form and let the reason carry the aspect (e.g. an
// assumed DPA usage time band). Returns null for a confirmed row.
function rowUnconfirmedRecordEntry(item: {
name: string;
kind: string;
unconfirmedReason?: string | null;
unconfirmedNote?: string | null;
}): string | null {
const reason = item.unconfirmedReason?.trim();
if (!reason) return null;
const note = item.unconfirmedNote?.trim();
const aspect =
item.kind === "show" || item.kind === "parade" ? "の公演時刻" : "";
return `${item.name}${aspect}：未確認（${reason}）${note ? `。${note}` : ""}`;
}

type DpaRowLike = {
name: string;
kind: string;
passType?: string | null;
dpaPurchaseTime?: string | null;
timeLabel?: string | null;
unitPriceJpy?: number | null;
// Headcount the purchase is bought for (owner's ruling,
// 2026-11-17): a purchase-event row carries it as purchaseCount
// and DPA money is unit price × this count. Absent on usage rows
// and on legacy purchase rows saved before the field existed.
purchaseCount?: number | null;
};

type DpaPurchaseInstance<Row extends DpaRowLike> = {
key: string;
// The facility's display name (the purchase row's name when the
// instance has one — it names the facility exactly).
name: string;
purchaseRows: Row[];
usageRows: Row[];
};

function groupDpaPurchaseInstances<Row extends DpaRowLike>(
rows: readonly Row[],
isDpa: (passType: string | null | undefined) => boolean,
parseTime: (label: string | null | undefined) => number | null,
): DpaPurchaseInstance<Row>[] {
const instances: DpaPurchaseInstance<Row>[] = [];
const byKey = new Map<string, DpaPurchaseInstance<Row>>();
rows.forEach((row, index) => {
if (!isDpa(row.passType)) return;
const purchaseMin =
row.kind === "purchase"
? (parseTime(row.dpaPurchaseTime) ?? parseTime(row.timeLabel))
: parseTime(row.dpaPurchaseTime);
// An instance is one facility bought in one purchase event. A
// row whose purchase time cannot be read cannot be shown to be
// the same event as another row, so it forms its own instance.
const key =
purchaseMin != null
? `${facilityNameKey(row.name)}|${purchaseMin}`
: `${facilityNameKey(row.name)}|row${index}`;
let inst = byKey.get(key);
if (!inst) {
inst = { key, name: row.name, purchaseRows: [], usageRows: [] };
byKey.set(key, inst);
instances.push(inst);
}
if (row.kind === "purchase") {
inst.purchaseRows.push(row);
inst.name = row.name;
} else {
inst.usageRows.push(row);
}
});
return instances;
}

// The headcount ONE purchase instance is counted at (owner's
// ruling, 2026-11-17), judged by the save-time gates. An instance
// WITH purchase-event rows counts at the purchase row's
// purchaseCount — the people who actually use the facility — and
// every purchase row of the instance is validated: a missing
// count, a count below 1, a count above the party size, or
// purchase rows of one instance disagreeing on the count are all
// class-2 violations (DPA費用の計上不一致） — the gate never
// silently falls back to the whole party for a row that was
// submitted in the new shape. An instance WITHOUT any
// purchase-event row (the legacy usage-row-only shape) keeps the
// party-size multiplier, exactly as before this ruling.
function dpaInstanceCount(
inst: DpaPurchaseInstance<DpaRowLike>,
partySize: number,
prefix: string,
): { count: number; violations: string[] } {
const violations: string[] = [];
if (inst.purchaseRows.length === 0) {
return { count: partySize, violations };
}
let count: number | null = null;
for (const prow of inst.purchaseRows) {
const c = prow.purchaseCount;
if (c == null) {
violations.push(
`${prefix}: 購入イベント行に対象人数（purchaseCount）が設定されていません。DPAは参加者全員分ではなく、その施設を実際に利用する人数で計算します。その購入で実際に利用する人数（全員が利用する場合のみ参加者総数${partySize}名）を購入イベント行に設定して再保存してください（DPA費用の計上不一致・クラス2）。`,
);
continue;
}
if (!Number.isInteger(c) || c < 1) {
violations.push(
`${prefix}: 購入イベント行の対象人数（${c}名）が正しくありません。対象人数は1名以上で、その購入でその施設を実際に利用する人数を設定して再保存してください（DPA費用の計上不一致・クラス2）。`,
);
continue;
}
if (c > partySize) {
violations.push(
`${prefix}: 購入イベント行の対象人数（${c}名）が、参加者総数（${partySize}名）を超えています。対象人数は、その購入でその施設を実際に利用する人数（参加者総数以下）でなければなりません（DPA費用の計上不一致・クラス2）。`,
);
continue;
}
if (count == null) {
count = c;
} else if (count !== c) {
violations.push(
`${prefix}: 同じ購入の購入イベント行で対象人数が一致していません（${count}名と${c}名）。1回の購入の対象人数は1つに定めて再保存してください（DPA費用の計上不一致・クラス2）。`,
);
}
}
return { count: count ?? partySize, violations };
}

// Why a fact build is incomplete, stated accurately: facilities with
// no fact at all, and/or facilities whose fact is unknown (with the
// recorded reason). A build knocked incomplete by an unknown fact
// has an EMPTY missing list, so a message naming only the missing
// list states a false reason with an empty enumeration (observed in
// testing, 2026-11-20).
function incompleteBuildDetail(gate: DpaFactGate): string {
const parts: string[] = [];
if (gate.missingNames.length > 0) {
parts.push(
`ファクトが無い施設があります：${gate.missingNames.slice(0, 10).join("、")}${gate.missingNames.length > 10 ? " ほか" : ""}`,
);
}
const unknowns = gate.summary?.unknowns ?? [];
if (unknowns.length > 0) {
parts.push(
`状態が不明な施設があります：${unknowns
.slice(0, 10)
.map((u) => `${u.name}（${u.reason}）`)
.join("、")}${unknowns.length > 10 ? " ほか" : ""}`,
);
}
return parts.length > 0 ? parts.join("。") : "完全性の条件を満たしていません";
}

// Judges ONE DPA-premise row against the fact gate. Returns the
// unit price when the row passes; otherwise the violation text
// (already carrying the caller's row prefix) and, for the unknown
// cases, the 未確認 entry the record must keep. The classes mirror
// the brief: not_eligible and out-of-period are class-1 rejections
// (the DPA does not exist for this visit), unknown rejects the row
// and stays on the record as 未確認 with its reason, and a missing
// or incomplete build rejects every DPA row at full strength.
function judgeDpaFact(
gate: DpaFactGate,
prefix: string,
name: string,
visitDate: string | null,
):
| { ok: true; priceJpy: number}
| { ok: false; violation: string; unverified?: string} {
if (!gate.build || !gate.summary) {
return {
ok: false,
violation: `${prefix}: 正規化ファクトのビルド（factBuildId）が渡されていないため、DPA対象かどうかを照合できません。公式情報を取得して saveSourceSnapshots でスナップショットを保存し、saveNormalizedFacts でファクトを構築・登録して、その factBuildId を渡すか、DPA前提をやめて再保存してください。`,
};
}
if (!gate.summary.complete) {
return {
ok: false,
violation: `${prefix}: ファクトビルド（#${gate.build.id}）が不完全なため、DPA対象の照合ができません（母集合${gate.summary.universeCount}施設のうち、${incompleteBuildDetail(gate)}）。欠けた施設を unknown＋理由つきで埋めてファクトを再登録し、完全なビルドの factBuildId を渡すか、DPA前提をやめて再保存してください。`,
};
}
const fact = gate.factsByKey.get(facilityNameKey(name));
if (!fact) {
return {
ok: false,
violation: `${prefix}: 正規化ファクトのビルド（#${gate.build.id}）にこの施設のファクトが無いため、DPA対象かどうかを照合できません。DPA前提をやめ、スタンバイの推定待ち時間で組み直すか、この項目を外して再保存してください。`,
unverified: `${name}のDPA：未確認（正規化ファクトのビルドの母集合にこの施設が含まれていないため）`,
};
}
if (fact.status === "not_eligible") {
return {
ok: false,
violation: `${prefix}: 正規化ファクト（ビルド #${gate.build.id}）でディズニー・プレミアアクセスの対象外と記録されている施設に、DPA前提の行があります。対象外の施設のDPAは存在しません。DPA前提をやめ、スタンバイの推定待ち時間で組み直すか、この項目を外して再保存してください。`,
};
}
if (fact.status === "unknown") {
return {
ok: false,
violation: `${prefix}: 正規化ファクト（ビルド #${gate.build.id}）でこの施設のDPA状態が「不明」のため、DPA前提は付けられません（不明理由：${fact.unknownReason ?? "理由なし"}）。DPA前提をやめ、スタンバイの推定待ち時間で組み直すか、この項目を外して再保存してください。`,
unverified: `${name}のDPA：未確認（正規化ファクトで状態が不明のため：${fact.unknownReason ?? "理由なし"}）`,
};
}
const periodReason = isIsoDate(visitDate)
? dpaPeriodExclusionReason(fact, visitDate)
: null;
if (periodReason) {
return {
ok: false,
violation: `${prefix}: 正規化ファクト（ビルド #${gate.build.id}）に記録された適用期間（${dpaPeriodRangeText(fact)}）では、来園日（${isoDateJa(visitDate ?? "")}）は${periodReason}のため、この来園日時点ではディズニー・プレミアアクセスの対象外です。DPA前提をやめ、スタンバイの推定待ち時間で組み直すか、この項目を外して再保存してください。`,
};
}
if (fact.priceJpy == null) {
// Registration requires a price on eligible facts, so this is
// unreachable in practice; refuse rather than guess a price.
return {
ok: false,
violation: `${prefix}: 正規化ファクト（ビルド #${gate.build.id}）の単価が記録されていないため、DPA費用を照合できません。DPA前提をやめて再保存してください。`,
unverified: `${name}のDPA単価：未確認（正規化ファクトに単価が記録されていないため）`,
};
}
return { ok: true, priceJpy: fact.priceJpy};
}

// The gate-level 未確認 entries a save must record about the fact
// build itself (distinct from per-facility unknowns, which the row
// loop adds through judgeDpaFact).
function factGateLevelUnverified(gate: DpaFactGate): string[] {
if (!gate.build || !gate.summary) {
return [
"DPA対象・単価：未確認（正規化ファクトのビルド（factBuildId）が渡されなかったため、DPAの照合材料がありません）",
];
}
if (!gate.summary.complete) {
return [
`DPA対象・単価：未確認（ファクトビルド #${gate.build.id} が不完全なため：母集合${gate.summary.universeCount}施設のうち、${incompleteBuildDetail(gate)}）`,
];
}
return [];
}

// ---------- spec-change suspicion （仕様変更の疑い） ----------
//
// The owner's rule: when the app DETECTS that its premises may no
// longer match Disney's current system — a fact build that stayed
// incomplete, DPA / hours / show-time facts that could not be
// confirmed, a re-verification that found mismatches against the
// current official data — the guidance for what to do next rides
// IN that detection message itself, not only in the help tab
// (nobody reads the help tab at the moment it matters). The action
// it names is the owner's: ask their own Muse, in the MAIN chat,
// to fix this app against the current Disney system. The in-app AI
// cannot change the app, so the guidance is the honest hand-off.
//
// Whether the guidance attaches is decided by STATE, not by
// matching keywords in the unverified entries' free text (spec
// §12.8): it attaches when that run's fact build was incomplete,
// or when an unverified entry of FACT origin remains. Unverified
// entries are therefore classified by their ORIGIN at generation
// time: the save and re-verification paths collect the fact-origin
// entries (fact-gate level, park hours, show times, DPA fact
// judgements, the row-derived §9.4 entries) into a separate
// factUnverified list alongside the full unverified list.
// Travel-leg and coordinate unverified entries do NOT count as
// fact origin by classification: an unresolvable coordinate is a
// data gap, not a system change, and flagging it would make the
// guidance noise. Entries the task itself reported are not
// classified by their wording either, and never enter the list.
function factsUnconfirmed(gate: DpaFactGate, factUnverified: readonly string[]): boolean { return gate.build == null || gate.summary?.complete !== true || factUnverified.length > 0; }
// The repair guidance itself, in the app's plain voice. Surfaces
// add their own short lead-in so the sentence does not repeat
// word-for-word identically everywhere it appears.
const SPEC_REPAIR_GUIDANCE =
"このアプリの前提が、現在のディズニーの仕様と合わなくなっている可能性があります。直す場合は、Museのメインのチャットで「現在のディズニーの仕様に合わせて、このアプリを直してください」と伝えてください。";

// ---------- 無理ゲート (impossibility gate) + 分類つき拒否 ----------
//
// Spec §6.2.1 / §12.9 (owner's design, 2026-11-15): before any plan
// drafting starts — new creation, rebuild, partial replacement,
// day-of reschedule, same-day search — the request is judged against
// a FIXED list of impossibility patterns, and only those:
//   nonexistent   — a required facility/show that is not in the
//                   target park, or is confirmed closed / not
//                   performed on the target date. Anything that
//                   cannot be confirmed is NOT "nonexistent".
//   time          — the required items, summed under the LOOSEST
//                   assumptions (quietest crowd scenario, lowest
//                   waits, every trade-off bent in the user's
//                   favour), still do not fit entry→exit / park hours.
//   budget        — even the minimum spend (tickets + the minimum
//                   cost of explicitly mandatory paid items) exceeds
//                   the budget.
//   contradiction — requirements that directly cannot coexist (two
//                   places at the same time, etc.).
// The judgement always leans optimistic: anything a trade-off can
// rescue (fewer DPAs fit the budget, reordering resolves a clash,
// a wait estimate decides whether it fits) is NEVER rejected, and
// borderline cases proceed to normal generation. The pattern list
// is closed — no other kind of "impossible" may be invented.
//
// The gate runs at two layers:
//  (1) Entry layer (here): at every start route, BEFORE a plan set
//      is created or a task spawned, a bounded inference judges the
//      requirements as presented (chat text / form priority /
//      same-day request). A hit returns the §12.9 rejection and
//      nothing starts — no plan set, no task.
//  (2) Task layer: the generation assignments repeat the judgement
//      after their materials (official facility list, the date's
//      operations/closures, the normalized facts) are in hand and
//      before drafting (closures on the target date are only
//      knowable there), and a drafting-time discovery of true
//      incompatibility is reported through reportImpossibleRequest
//      instead of saving a skeleton plan. The §9.2 class-11
//      substance floor stays as the mechanical last resort.
//
// The rejection format is fixed (§12.9): (1) a frank apology,
// (2) the cause classification with concrete names (approximate is
// fine), (3) the fixed guidance line below. The cause explanation
// stops at stating objective fact (owner's line, spec §12.9 記録U,
// 2026-11-15): classification + concrete names + a statement of the
// objective fact itself (e.g. "同じ時刻に2か所にはいられない") is
// allowed and kind. A concrete remedy / prescription beyond that is
// forbidden in BOTH shapes — the counterfactual promise ("○○を
// 外せば作れます") and the mere suggestion ("どちらか一方を〜する
// など", "〜に変更すれば"): a suggested fix is never calculated or
// verified, so a user who follows it and is refused again loses
// trust in the guidance itself (the double-refusal problem). The
// only forward-looking guidance allowed is the fixed line below.
const IMPOSSIBILITY_GUIDANCE_LINE =
  "最初は緩めの条件で作り、できたプランへ修正を重ねていく方が良いですよ。";

type ImpossibilityCategory =
  | "nonexistent"
  | "time"
  | "budget"
  | "contradiction";

const IMPOSSIBILITY_CATEGORY_LABELS: Record<ImpossibilityCategory, string> = {
  nonexistent: "存在しない",
  time: "時間が足りない",
  budget: "予算オーバー",
  contradiction: "矛盾する要求",
};

// Sentences that promise the plan WOULD work if something were
// dropped are counterfactual promises and must never reach a
// rejection text (§12.9). A sentence carrying one is dropped whole:
// its result clause ("作れます") is meaningless on its own, so
// clause-level surgery cannot save it.
const COUNTERFACTUAL_CLAUSE =
  /(外せば|除けば|省けば|やめれば|ずらせば|をずらすと|変更すれば|変えれば|を変えると|なければ(可能|でき|作れ)|を外すと|を除くと|(減らせば|にすれば|変更すれば|ずらせば)[^。]*(作れ|でき|可能|収ま|両立))/;

// Suggestion-form prescriptions (§12.9 記録U): a clause that
// proposes a specific remedy — move one of the two, change it to
// another time, shift it — without promising anything. These are
// removed CLAUSE by clause (split on 、), never sentence by
// sentence, so a legitimate statement of objective fact sharing the
// sentence survives: "10:00ちょうどに両方に乗ることは、同時に
// 2か所にはいられないためできません" contains no pattern below
// and passes through untouched. What cannot be separated
// mechanically is left to the prompt layer, which now states the
// same boundary explicitly at every reason-writing site.
const PRESCRIPTION_CLAUSE =
  /(どちらか一方|どちらか|片方|もう一方)を[^、]*(する|し|ずら|変え|変更|外す)|別の(時間|時刻|日)に(する|して|変更|ずら|移)|(ずらして|変更して|変えて|外して)(ください|みて)|(する|ずらす|変更する|変える|外す)など/;

function sanitizeImpossibilityReason(reason: string): string {
  const kept: string[] = [];
  for (const sentence of reason.split(/(?<=。)/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (COUNTERFACTUAL_CLAUSE.test(s)) continue;
    const endsWithPeriod = s.endsWith("。");
    const body = endsWithPeriod ? s.slice(0, -1) : s;
    const clauses = body
      .split("、")
      .filter((c) => !PRESCRIPTION_CLAUSE.test(c));
    if (clauses.length === 0) continue;
    kept.push(clauses.join("、") + (endsWithPeriod ? "。" : ""));
  }
  return kept.join("").trim();
}

// Composes the fixed §12.9 rejection text from classified findings.
// Each finding's reason is a concrete sentence (facility names, the
// clashing requirements, amounts, times); the formatter guarantees
// the apology, the classification lead-ins, and the guidance line
// are always present and identically shaped, whatever the judge or
// the generation task supplied.
function formatImpossibilityRejection(
  findings: { category: ImpossibilityCategory; reason: string }[],
): string {
  const lines = findings
    .map((f) => {
      const label = IMPOSSIBILITY_CATEGORY_LABELS[f.category];
      let reason = sanitizeImpossibilityReason(f.reason);
      // A reason that itself opens with the classification word
      // ("矛盾する要求：…" / "矛盾する要求です。…") would print the
      // label twice; the label is the formatter's to attach, so
      // strip the reason's own leading copy of it. Only a label
      // followed by a delimiter is stripped — a reason that merely
      // begins with the same words as prose ("時間が足りないため…")
      // is untouched.
      const labelLead = new RegExp(`^${label}(：|:|です。|です|、)`);
      while (labelLead.test(reason)) {
        reason = reason.replace(labelLead, "").trim();
      }
      return reason
        ? `・${label}：${reason}`
        : `・${label}です。`;
    })
    .filter((l) => l.length > 0);
  return [
    "申し訳ありません。その条件ではプランを作ることができませんでした。",
    "理由は次のとおりです。",
    ...(lines.length > 0 ? lines : ["・条件同士が両立しませんでした。"]),
    IMPOSSIBILITY_GUIDANCE_LINE,
  ].join("\n");
}

const impossibilityFindingSchema = z.object({
  category: z.enum(["nonexistent", "time", "budget", "contradiction"]),
  // One or two concrete sentences naming the facility / requirement /
  // amount / time involved, in the classification's own words (e.g.
  // 「スプラッシュ・マウンテンは東京ディズニーランドの施設で、
  // シーには存在しません」). Approximate is fine. The reason stops
  // at stating objective fact (§12.9 記録U): a concrete remedy must
  // never be written here, neither as a counterfactual promise
  // ("○○を外せば作れます") nor as a suggestion ("どちらか一方を
  // 〜するなど").
  reason: z.string().min(1).max(500),
});

// The entry-layer gate judgement: a bounded inference over the
// requirements AS PRESENTED, against the fixed pattern list only.
// Returns the findings when a pattern clearly hits, or null when
// generation may proceed (including when the judgement itself
// fails — the gate never blocks on its own error; the task layer
// re-judges with real materials in hand).
async function judgeImpossibility(
  ctx: Ctx,
  input: {
    park: "land" | "sea";
    visitDate: string | null;
    entryTime: string | null;
    exitTime: string | null;
    budgetJpy: number | null;
    adults: number;
    children: number;
    // The requirements to judge: the user's own words (chat message /
    // decided change / same-day request) plus the 「重視する点」 text.
    requirements: string;
  },
): Promise<{ category: ImpossibilityCategory; reason: string }[] | null> {
  const requirements = input.requirements.trim();
  if (!requirements) return null;
  try {
    const result = await ctx.inference.complete(
      [
        `あなたは我が家のディズニー計画の「無理ゲート」の判定役です。プラン作成の要求が、次の固定された無理パターンのいずれかに「明らかに」当たるかどうかだけを判定してください。パターンはこの4種類だけです。これ以外の理由で「無理」と判定してはいけません。`,
        ``,
        `【対象の条件】`,
        `パーク: ${parkName(input.park)}`,
        `日付: ${input.visitDate ?? "未定"}`,
        `入園〜退園: ${input.entryTime ?? "未定"} 〜 ${input.exitTime ?? "未定"}`,
        `予算: ${input.budgetJpy != null ? `${input.budgetJpy.toLocaleString("ja-JP")}円` : "指定なし"}`,
        `人数: 大人${input.adults}人・子ども${input.children}人`,
        ``,
        `【判定する要求（利用者の言葉）】`,
        requirements,
        ``,
        `【無理パターン（固定リスト）】`,
        `1. nonexistent（存在しない）: 必須と明示された施設・ショーが、対象パークの施設ではないことが明らかな場合だけ（例：シーの日にランドの施設を必須とする）。両パークの代表的な施設の所属はあなたの知識で判断してよい。対象日に休止・公演なしかどうかは、この段階では確認できないので理由にしない。確認できない・曖昧なものは「存在しない」と断定しない（当たらない）。`,
        `2. time（時間が足りない）: 必須と明示された項目を、最も緩い前提（一番空いた側の混雑前提、待ち時間は下限側、DPAは規則の範囲で最大限に使うなど、トレードオフを全て利用者に有利な側へ倒す）で粗く合計しても、入園〜退園の枠に明らかに収まらない場合だけ。例：対象パークの全アトラクション制覇の必須指定、同一施設への過剰な回数（5回など）の必須指定。枠（入園・退園時刻）が分からない場合は当たらない。待ちの見積もり次第で収まるものは当たらない。`,
        `3. budget（予算オーバー）: 最小の支出でも予算を超えることが明らかな場合だけ。最小の支出 = チケット代（楽観側に倒し、大人・子どもとも1デーパスポートの最安側 約7,900円 × 人数で見積もる）＋「絶対」「必ず」と明示された有料項目の最小費用（DPAなら最安単価1,500円 × 回数 × 人数）。DPAを「使いたい」「できれば」程度の希望は必須費用に入れない（DPAを減らせば予算内に収まる要求は、トレードオフで救済できるので絶対に当たらない）。食事・お土産は削れるものとして必須費用に入れない。予算の指定が無い場合は当たらない。`,
        `4. contradiction（矛盾する要求）: 要求同士が直接両立しない場合だけ。例：同じ時刻に2か所にいる指定、同一対象への排他的な指定（「絶対に乗る」と「絶対に乗らない」等）。希望が多いこと、言い回しが曖昧なこと自体は矛盾ではない。順序を変えれば両立するものは当たらない。`,
        ``,
        `【判定の倒し方（厳守）】判定は常に楽観側に倒してください。トレードオフで救済できる要求（DPAを減らせば予算が収まる、順序を変えれば両立する、待ち次第で時間内に収まる）は絶対に当てはめない。粗い計算で境界に近い場合も「当たらない」としてください。弾いてよいのは、どう計算しても無理と明確に言えるものだけです。必須と明示されていない希望（「できれば」「〜もいいな」程度）は、どのパターンの対象にもしないでください。`,
        ``,
        `【出力】当たる場合は impossible=true とし、findings に当たったパターンごとに {category, reason} を入れてください。reason は「分類の言葉＋具体名（施設名・衝突している要求・金額・時刻）＋客観的事実の指摘」までの1〜2文にしてください（例：「スプラッシュ・マウンテンは東京ディズニーランドの施設で、東京ディズニーシーには存在しません」）。明確な矛盾については、客観的事実そのものを述べてかまいません（例：「同じ時刻に2か所にはいられない」）。ただし、そこから先の具体的な改善案・処方箋は絶対に書かないでください。禁止は約束の形（「○○を外せば作れます」「○○がなければ可能です」）だけでなく、提案の形（「どちらか一方を〜するなど」「片方を〜」「〜に変更すれば」「〜を別の時間に」等）にも及びます。具体案の成立は検証できず保証がないためで、提案に従って直した利用者が再び拒否されると案内そのものへの信用が損なわれます。前向きの案内はアプリ側の固定文が担います。当たらない場合は impossible=false、findings は空にしてください。`,
      ].join("\n"),
      {
        schema: z.object({
          impossible: z.boolean(),
          findings: z.array(impossibilityFindingSchema).max(4),
        }),
      },
    );
    if (!result.impossible || result.findings.length === 0) return null;
    return result.findings;
  } catch {
    // The gate never blocks generation on its own failure: the
    // generation task re-judges with the fetched materials in hand.
    return null;
  }
}

// ---------- 車椅子：対応範囲外の明示 (owner's decision, 記録AR) ----------
//
// Whether a facility can be used with a wheelchair depends on each
// facility's official usage criteria and the day's operations, and
// this app has NO mechanism that judges wheelchair usability on
// official grounds (no fact layer, no save-time check). The owner's
// decision (2026-11-17): never build a plan on the premise that
// something without official information is rideable; when a
// wheelchair user is among the participants, say plainly that the
// app cannot handle it. This is NOT the §12.9 impossibility gate:
// no cause classification (budget / time / existence /
// contradiction) is attached, and the fixed guidance line
// （最初は緩めの条件で…） is NOT appended — loosening the conditions
// cannot make this buildable. After the refusal, the official
// mechanisms are presented by their formal names as INFORMATION
// only; no schedule is ever built on the premise of using them.
//
// The check runs at EVERY generation entrance, before any material
// fetch or task spawn: the chat start judgement (sendMessage — new
// creation, rebuild, partial replacement, day-of reschedule), the
// conditions form button (requestPlanGeneration), the same-day
// form (requestSameDaySearch), and the day-of reschedule buttons
// (requestDpaReschedule / requestLotteryReschedule, judged on the
// target set's stored conditions + the user's report). A hit
// creates no plan set and starts no task.
const WHEELCHAIR_OUT_OF_SCOPE_TEXT = [
  "車椅子の方が参加者に含まれる場合、本アプリでは対応できません。",
  "",
  "車椅子で利用できるかどうかは、施設ごとの公式の利用基準と当日の運用によって決まります。このアプリには、車椅子での利用可否を公式の根拠をもって判定する仕組みがないため、利用できる前提でプランを組むことはしません。",
  "",
  "代わりに、東京ディズニーリゾート公式の仕組みを、情報としてご案内します。",
  "",
  "・ディスアビリティアクセスサービス（DAS）：障害者手帳等の証明書をお持ちの方が対象です。列に並ばず、待ち時間を別の場所で過ごすことができます（待ち時間そのものが短くなるわけではありません）。",
  "・合流利用サービス：証明書は不要です。ご本人は別の場所で待ち（介助者1名まで一緒に待つことができます）、同行者が列に並び、乗り場で合流します。",
  "・公式サイトのバリアフリー案内「肢体不自由の方、車イスをご利用の方へ」には、車椅子で利用できる施設の一覧が掲載されています。",
  "",
  "なお、この案内は情報の提示までです。これらの仕組みを使う前提のスケジュールを、このアプリで組むことはできません。",
].join("\n");

// Contextual judgement (NOT phrase matching): does the presented
// requirements text, read for its meaning, say that a wheelchair
// user is among the visiting party? A research request about
// wheelchair accessibility itself — where no participant is stated
// to be a wheelchair user — is NOT a hit and proceeds as research,
// as before. A stroller （ベビーカー) is not a wheelchair. Like the
// impossibility gate, a failure of the judgement itself never
// blocks generation (returns false).
async function judgeWheelchairParticipant(
  ctx: Ctx,
  requirements: string,
): Promise<boolean> {
  const text = requirements.trim();
  if (!text) return false;
  try {
    const result = await ctx.inference.complete(
      [
        `あなたは我が家のディズニー計画の入口判定役です。提示された条件・要求の文面から、「来園する参加者の中に、車椅子を利用する方が含まれる」ことが、文脈・意味から読み取れるかどうかだけを判定してください。特定のフレーズの有無ではなく、意味で判断してください。`,
        ``,
        `【複数の要求が含まれる場合の切り分け】文面には、今回開始しようとしている要求（【今回の要求】）のほかに、先行する別の要求が含まれることがあります。判定の対象は「今回の要求で作るプランの参加者」だけです。先行メッセージは、今回の要求の条件を補うものとして提示されている場合（条件が複数メッセージに分かれて提示され、今回の要求がそれを受けて開始を求めている場合）にだけ数えてください。先行する要求が独立した別の条件提示であり（すでに回答済みの場合を含む）、今回の要求が独自の条件を完結して提示している場合は、先行の要求に車椅子利用者への言及があっても、今回の参加者には含めないでください。`,
        ``,
        `【判定する文面（利用者の条件・要求）】`,
        text,
        ``,
        `【wheelchairParticipant=true とする場合】`,
        `・参加者の誰か（本人・家族・同行者）が車椅子を利用することが、条件として述べられている場合。例：「祖母が車椅子利用者です」「車椅子の母と一緒に行きます」「車椅子ユーザーを含む5人で」。`,
        `・車椅子利用を前提にしたプラン作成の要求で、作る相手の参加者に車椅子利用者がいることが前提になっている場合。例：「車椅子でも楽しめるプランを作って」「車椅子で回れるように組んで」。`,
        ``,
        `【false とする場合】`,
        `・車椅子対応の有無そのものを調べる調査・質問で、参加者に車椅子利用者がいるとは述べられていない場合。例：「車椅子対応のアトラクションを調べて」「スモールワールドは車椅子で乗れますか」。これは調査として扱います。`,
        `・車椅子の貸出の有無など、設備・サービス一般についての質問で、参加者の利用が述べられていない場合。`,
        `・ベビーカー（バギー）の利用だけが述べられている場合。ベビーカーは車椅子ではありません。`,
        `・参加者に車椅子利用者がいないことが明らかな場合。`,
        ``,
        `【判定の倒し方】参加者に車椅子利用者が含まれることが意味から読み取れる場合だけ true にしてください。読み取れない・曖昧な場合は false にしてください。`,
      ].join("\n"),
      {
        schema: z.object({
          wheelchairParticipant: z.boolean(),
        }),
      },
    );
    return result.wheelchairParticipant;
  } catch {
    // Same rule as the impossibility gate: the check never blocks
    // generation on its own failure.
    return false;
  }
}

// Whether a price figure appears in an evidence excerpt, in any of
// the notations the official pages use (grouped "2,000", plain
// "2000", full-width digits after NFKC).
function evidenceContainsPrice(evidence: string, priceJpy: number): boolean {
const grouped = priceJpy.toLocaleString("en-US");
const plain = String(priceJpy);
if (evidence.includes(grouped) || evidence.includes(plain)) return true;
const norm = evidence.normalize("NFKC");
return norm.includes(grouped) || norm.includes(plain);
}

// Whether an ISO date appears in an evidence excerpt, in the
// Japanese notations the official pages use (2026年11月30日 with or
// without zero padding, 2026/11/30, or the ISO form itself).
function evidenceContainsDate(evidence: string, iso: string): boolean {
const [y = "", m = "", d = ""] = iso.split("-");
const forms = [
iso,
isoDateJa(iso),
`${y}年${m}月${d}日`,
`${y}/${Number(m)}/${Number(d)}`,
`${y}/${m}/${d}`,
];
if (forms.some((f) => evidence.includes(f))) return true;
const norm = evidence.normalize("NFKC");
return forms.some((f) => norm.includes(f));
}

// ---------- canonical snapshot provenance (spec §6.2.2, revision W) ----------
//
// A stored snapshot used to become "canonical" by existing: facts
// were machine-checked against snapshots, but snapshots themselves
// were checked against nothing, so a partial text (the DPA page's
// text extraction returns only the initially-rendered state — the
// Sea attraction list stops at 6 of the declared 9) was registered
// as ground truth. The server now decides canonicality at save time:
// canonical = 1 only when the save carried a fetch method recording
// a REAL-BROWSER fetch (fetchMethod exactly "browser"; added
// 2026-11-18 after a generation failed because the task tried to
// obtain the tabbed/expandable official DPA page by text extraction
// — a GET fetch never becomes canonical, so "get by with GET only"
// cannot ground facts) AND a
// completeness declaration with result "passed" AND the machine
// check below found no mismatch AND at least one machine-verifiable
// ANCHOR in the text itself checked out (revision X: a text with no
// machine-readable declaration has zero mismatches by construction,
// so "no mismatch" alone let a free-text declaration canonicalize a
// story-only text — T141). Anything else is stored with
// canonical = 0 (the save itself is never refused — the guarantee is
// that a partial text is never SILENTLY canonical).

// Machine check of a snapshot's own declared section counts — the
// ANCHORS （錨） of the canonical gate (spec §6.2.2 / §4, revision X).
// Two declaration shapes are machine-readable in the text itself:
//   (a) priced sections: a line whose trimmed text ENDS with
//       「全N件」 opens a section that runs until the next
//       declaration line (or end of text); its items are counted by
//       their price notation (円/回, half- or full-width slash).
//   (b) unpriced enumeration declarations: a line ending with
//       「…一覧 N件」 (e.g. a facility list's 「パレード/ショー一覧
//       11件」) opens a section whose enumerated rows are counted
//       as its non-empty lines.
//   (c) title declarations: a section header line ending with
//       「（全N件）」 (e.g. 「【公式】アトラクション | 東京ディズニー
//       シー（全15件）」) — the count sits inside the title's
//       parentheses; the enumerated rows are the non-empty lines
//       that follow, up to the next declaration or the next
//       【公式】 section header. (A record-W verification fixture
//       in exactly this shape was judged complete and canonical;
//       without this shape the anchor rule would demote it — a
//       false fire on a real complete text.)
// A section whose declared count EQUALS its enumerated count is a
// VERIFIED ANCHOR; a section that enumerates items but disagrees
// with its declaration is a MISMATCH. Sections enumerating nothing
// at all are not judged (the declaration is not machine-readable
// in this sense — e.g. a facility list's title line 「（全33件）」
// does not even end with the declaration). Canonicality REQUIRES
// at least one verified anchor and zero mismatches: a text with no
// machine-readable declaration at all can no longer become
// canonical on a free-text declaration alone (the T141 hole — a
// story-only text whose "expectation" existed only in the task's
// own words had zero mismatches by construction and passed).
// Tuned against the production complete snapshot (id=177:
// 「アトラクション（東京ディズニーシー） 全9件」 followed by 9 priced
// items, 「パレード/ショー … 全3件」 by 3, 「… 全6件」 by 6 — no false
// fire), the partial shape (the same 全9件 heading with only the
// first 6 priced items — a certain mismatch), and the complete
// facility list whose show side declares 「一覧 11件」 over 11
// enumerated rows while its attraction side declares nothing.
type SectionAnchor = {
  kind: "priced" | "list" | "title";
  declared: number;
  listed: number;
  label: string;
};

function checkDeclaredSectionCounts(rawText: string): {
  checked: { declared: number; listed: number }[];
  mismatches: { declared: number; listed: number }[];
  anchors: SectionAnchor[];
} {
  const lines = rawText.split(/\r?\n/);
  const sections: {
    kind: "priced" | "list" | "title";
    declared: number;
    label: string;
    body: string[];
  }[] = [];
  let current: (typeof sections)[number] | null = null;
  for (const line of lines) {
    const t = line.trim();
    const priced = t.match(/全(\d+)件$/);
    const list = t.match(/一覧\s*(\d+)\s*件$/);
    const title = t.match(/[（(]全(\d+)件[）)]$/);
    if (title) {
      current = {
        kind: "title",
        declared: Number(title[1]),
        label: t,
        body: [],
      };
      sections.push(current);
    } else if (/^[【〖]公式/.test(t)) {
      // A new top-level 【公式】 section header closes the current
      // section (its own line is a header, never an enumerated
      // row) — unless it carried a title declaration, handled
      // above.
      current = null;
    } else if (priced && !t.includes("円/回") && !t.includes("円／回")) {
      current = {
        kind: "priced",
        declared: Number(priced[1]),
        label: t,
        body: [],
      };
      sections.push(current);
    } else if (list && !priced) {
      current = {
        kind: "list",
        declared: Number(list[1]),
        label: t,
        body: [],
      };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  const checked: { declared: number; listed: number }[] = [];
  const mismatches: { declared: number; listed: number }[] = [];
  const anchors: SectionAnchor[] = [];
  for (const s of sections) {
    const listed =
      s.kind === "priced"
        ? s.body.reduce(
            (n, l) => n + (l.match(/円[/／]回/g) ?? []).length,
            0,
          )
        : s.body.filter((l) => l.trim().length > 0).length;
    if (listed === 0) continue;
    const entry = { declared: s.declared, listed };
    checked.push(entry);
    if (listed !== s.declared) {
      mismatches.push(entry);
    } else {
      anchors.push({ kind: s.kind, declared: s.declared, listed, label: s.label });
    }
  }
  return { checked, mismatches, anchors };
}

// The 3-step canonical-fetch procedure (spec §6.2.2), interpolated
// into every task assignment that fetches the canonical source set
// (new generation / rebuilds / same-day / re-verification): step 0
// identity check (relocate the source when the known URL no longer
// is the expected page), step 1 real-browser fetch (all tabs, all
// expansions), step 2 the completeness declaration at save time.
// The scope boundary (spec §12.10), stated at the entrance of every
// generation-type task, BEFORE the impossibility gate (§6.2.1 — the
// gate's fixed patterns themselves are untouched by this): this app
// is a Disney trip-planning app, not a general-purpose one. A
// request unrelated to Disney trip planning, or meaningless as a
// planning request, is not planned at all.
const SCOPE_BOUNDARY_STEP = `【適用範囲の境界（入口判定・無理ゲートの前段）】このアプリはディズニー旅行計画のためのアプリであり、万能アプリではない。元のリクエストがディズニー旅行計画と無関係な場合、または計画リクエストとして意味をなさない場合は、プラン制作自体を行わず、その旨を簡潔に正直に伝えて終了すること（失敗報告にその旨を簡潔に書く）。無理にプラン化したり、骨組みを完了扱いにしたりしないこと。境界に近い場合（計画依頼として解釈できる余地がある場合）は制作を止めず、不足分を聞き返す通常の流れで扱うこと。`;

const CANONICAL_FETCH_STEPS = `【正典ソース取得の3段手順（必須）】ステップ0（同一性チェック）：既知のURLを開いたら、まず「期待したページか」を判定すること（期待する種類のページで、期待するリストが存在するか）。ダメな場合（移動・消滅・別物化）は、そのURLでの取得に進まず、まず現在の正しいページを探し、新しいURLで取得すること（ソース位置の再配置）。ステップ1（ブラウザ取得・必須要件）：取得は必ず実ブラウザ（タブ切替・「もっと見る」等の展開・スクロールでの遅延読み込みを実際に操作できるライブブラウザ）で行い、全タブを切り替え、展開要素は全て開き、分割された内容は全て取得すること。GET／静的フェッチ／テキスト抽出だけで得たテキストを、正典スナップショットの本文として保存してはならない。これは手順の好みではなくアプリの必須要件である：サーバーは fetchMethod="browser" で保存されたスナップショットしか正典にしない（GET取得の本文は、完全性照合の申告が passed でも、本文に錨があっても、正典にならず、ファクトの根拠に一切使えない）。したがって、正典ソース集合（DPA案内ページ・施設全一覧・運営/休止情報・公演スケジュール・チケット価格・告知一覧）とレストラン詳細ページの取得に、一括取得スクリプトや静的フェッチを使ってはならない（保管庫（Cloudflare）の束／スナップショット経由はこの限りではない：保管庫の本文は保管庫側が実ブラウザ相当の取得をしたもので、出所は fetchMethod="storehouse" として記録する）（静的フェッチのスクリプトは辞書の静的属性＝座標・エリア・所要時間・写真URLの取得専用。正典ソースの読み取り自体は、実ブラウザを操作する読み取り用スクリプトで1ページずつ行ってよい——その場合の取得方法は実ブラウザであり、下記の「読み取りの区切りの時刻」はそのスクリプトが記録する）。実ブラウザで取得できないソースは、GETで代替せず「取得できなかった」として扱うこと（DPAページが実ブラウザで取れなければファクトは作れないので、DPA前提の行は作らない。レストラン詳細ページが実ブラウザで取れなければ、その店のファクトは登録しない。ただしレストラン詳細ページは保管庫の束が原則の取得経路であり、束にある店はその本文（fetchMethod="storehouse"、sourceFetchedAt＝保管庫の取得時刻で保存したもの）を根拠にファクトを登録できる。また正典ソースの自前のブラウザ取得が失敗した場合は、最後の手段として保管庫のスナップショットを同じ形（fetchMethod="storehouse"・sourceFetchedAtつき）で材料にできる。保管庫由来の本文を "browser" と偽ることは捏造であり絶対にしないこと。保管庫由来のスナップショットは正典にはならない（正典化の条件は従来どおり）。fetchMethod には実際の取得方法を正直に入れること（GETで取った本文を "browser" と偽る申告は捏造であり、絶対にしてはならない）。ステップ2（完全性照合の申告）：saveSourceSnapshots の保存時には、各スナップショットに取得方法（fetchMethod）と完全性照合の申告（completeness）を必ず渡すこと。期待値はソース自身から導く（優先順位：(1) ページ自身の宣言・構造。例：「全N件」の宣言と列挙件数の一致。(2) 兄弟ソースとの整合。例：DPA対象は施設全一覧の部分集合。(3) 同じソースの過去スナップショットとの連続性）。期待値が導けない場合や照合に失敗した場合は、その旨を正直に申告すること（result＝not_derivable／failed）。そのスナップショットは正典にならない（正典かどうかはサーバーが決める）ので、取り直すか、それに基づくファクトは未確認として扱うこと。部分的なテキストを完全なものとして申告してはならない。なお正典化には、本文の中にサーバーが機械検証できる錨（「全N件」の宣言と価格つき列挙件数の一致、「…一覧 N件」の宣言と列挙行数の一致など）が少なくとも1つ存在し、その照合が一致することが必須である。自由文の期待値申告だけでは正典にならない（錨の無いテキストは、申告が「passed」でも正典化されない）。【読み取りの区切りの時刻（必須）】公式ページの読み取りは、実ブラウザを操作する読み取り用スクリプトが1ページずつ行い（静的フェッチではなく、タブ切替・「もっと見る」の展開・スクロール等の操作を実ブラウザで行うもの）、スクリプト自身の時計で次の区切りを記録すること：(a) ページを開き始めた時刻、(b) ページの読み込みが終わった時刻、(c) 必要な操作（タブの状態確認、「もっと見る」の展開、チケットページでのカレンダー部分までのスクロール等）が終わった時刻（操作が無いページでは null）、(d) 文章を取り出した時刻。記録した区切りは、写しの保存時に saveSourceSnapshots の readTimings（{openStartedAt, loadCompletedAt, operationsCompletedAt, textExtractedAt}、ISO形式）として、そのページの写しと一緒に渡すこと。サーバーが、保存時にこの区切り（区間ごとの秒数つき）を過程記録に残し、写しの記録にも残す。これにより、読み込み待ち・操作・文章の取り出しのどこに時間がかかったかが、プログラムの時計の記録から直接分かる。タスク自身の開始／終了の自己申告は、読み取りについては完全に廃止する（書かないこと）。なお、スクリプトが担うのは、ブラウザでページを開いて文章を取り出すところと、その区切りの時刻を打つところまでである。取り出した文章を読み、施設ごとの事実に構造化する部分（ファクト構築）は、ページの構造が変わっても対応できるようにするための設計であり、従来どおりAIが本文を読んで行うこと——スクリプトで事実を抜く形に変えてはならない。今回変えるのは記録と計測の仕方だけであり、内容の読み取り方そのものは変えない。`;

// ---------- acquisition plan layer v3 （取得計画層） ----------
//
// The plan layer's shared machinery (owner's design, 2026-11-19,
// finalised as "acquisition plan v3 — sitemap-rooted"). The plan
// is a TREE built from the official sitemap: sitemap.xml is a
// plain HTTP GET (no browser), and its URL paths ARE the site
// tree — trunk and branches (hub pages; list pages in directory
// form). Detail pages and dated daily pages are absent from the
// sitemap by construction: the daily node hangs under the daily
// branch, and restaurant detail pages are leaves under the
// restaurant-list node, enumerated from the list pages (and, in
// this implementation, registered via the storehouse / own
// snapshots — see acquisition_restaurant_leaves).
//
// ONE clock: the plan and every snapshot are valid for 3 hours.
// The rebuild decision uses ONLY the clock — the server never
// fetches the sitemap itself (owner's decision, 2026-11-19: the
// app server's plain HTTP fetch to the official site does not
// complete, so the sitemap-carrying role moved to the fetching
// task / AI layer). planAcquisition answers an expired (or
// missing) plan with planState="rebuild" + needsSitemap=true and
// attempts no fetch of its own; the task then reads the sitemap
// URL set from the Cloudflare storehouse (getStorehouseSitemap —
// the storehouse fetches sitemap.xml with Browser Run and serves
// the Japanese-only set; the sitemap URL heads its circulation
// list) and hands it to submitSitemap, falling back to a plain
// GET of sitemap.xml in its own environment only when the
// storehouse holds none. submitSitemap validates the set
// (official domain only),
// compares the branch-restricted set against the stored one,
// persists the whole tree atomically, and returns the same
// decision shape as planAcquisition. If the task cannot fetch
// the sitemap either, it discloses that and proceeds on the
// existing plan skeleton — the creation instant is not advanced,
// so the next turn retries the rebuild. After a rebuild, the
// WHOLE tree is replaced (never a partial revision), and the
// rebuild's fetches double as that run's execution material.
// If the sitemap URL set restricted to the branches the plan uses
// shows no added / removed / moved branch, the skeleton counts as
// identical. Execution never changes the plan mid-run; a fetch
// failure is left in the run's fetch record and becomes material
// for the next rebuild.
//
// planAcquisition (below, in the Actions map) is the deterministic
// decision function over the stored tree plus stored snapshots:
// reuse is decided ONLY by "a snapshot of that node's URL exists
// and was fetched within 3 hours of the evaluation instant" —
// canonicality does not enter the decision (the canonical gate in
// saveSourceSnapshots / saveNormalizedFacts is unchanged and
// still governs what may ground facts). The daily node is the one
// exception to pure freshness: its snapshots must be ABOUT the
// target date, and when the target date is the evaluation day,
// the daily node is always fetched.
//
// Canonicality itself is UNCHANGED: only a real-browser fetch
// whose anchor the server verified becomes canonical
// (saveSourceSnapshots decides), and only canonical snapshots
// ground normalized facts. Storehouse material (below) is
// recorded with fetchMethod "storehouse" and its own fetch time —
// never relabelled "browser" — and never becomes canonical.

const SITEMAP_URL = "https://www.tokyodisneyresort.jp/sitemap.xml";
const STOREHOUSE_BASE_URL =
"https://disney-storehouse.hinoragi2034.workers.dev";
const PLAN_VALIDITY_MS = 3 * 60 * 60 * 1000;

type PlanNodeDef = {
nodeKey: string;
scope: "common" | "park";
kinds: string[];
urlTemplate: string;
urlMatch: string;
stateFragmentLand: string | null;
stateFragmentSea: string | null;
operations: string;
anchor: string;
note: string | null;
// Sitemap branch prefixes (path templates, {P} = tdl/tds) whose
// presence in the sitemap URL set proves this node's branch
// exists. List pages appear in the sitemap in directory form,
// so prefixes are branch roots, not the page URLs themselves.
branchPrefixes: string[];
};

// The tree's node definitions (spec: acquisition plan v3 §4).
// {P} = tdl/tds, {D} = target date YYYYMMDD. Counts in anchors are
// never fixed values: they are measured on every rebuild/fetch
// from the page's own declarations.
const PLAN_NODE_DEFS: PlanNodeDef[] = [
{
nodeKey: "dpa",
scope: "common",
kinds: ["dpa_page"],
urlTemplate: "tdr/guide/app_service/disneypremieraccess.html",
urlMatch: "disneypremieraccess.html",
stateFragmentLand: "#tab-6546897=tdl&attraction-more-7103730=open",
stateFragmentSea: "#tab-6546897=tds&attraction-more-7040603=open",
operations:
"主：対象パークの状態つきURLで開く（シーは stateFragmentSea、ランドは stateFragmentLand を付けたURL）。読み込み後に錨で判定し、合わなければ対象パークのタブを押し、節ごとに錨まで「もっと見る」を押して開く。対象パーク分のみ取る。対象パークでない側は開かない。スクロール不要",
anchor:
"節ごとの宣言件数と、価格つき列挙件数が一致すること（対象パーク分のみ）",
note: null,
branchPrefixes: ["tdr/guide/app_service/"],
},
{
nodeKey: "announcements",
scope: "common",
kinds: ["announcements"],
urlTemplate: "tdr/news/update.html",
urlMatch: "news/update.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations: "開くのみ。スクロール不要",
anchor:
"一覧が存在し、ページの注記「最新の20件のみ表示」があること",
note: "正典の選択（更新情報／大切なお知らせ）は未決のまま変えない",
branchPrefixes: ["tdr/news/"],
},
{
nodeKey: "attraction",
scope: "park",
kinds: ["facility_list"],
urlTemplate: "{P}/attraction.html",
urlMatch: "attraction.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations: "開くのみ（操作なし）。スクロール不要",
anchor:
"ページ自身の件数宣言と列挙件数が一致すること（件数は作り直しのたびに実測し、固定値にしない）",
note: null,
branchPrefixes: ["{P}/attraction"],
},
{
nodeKey: "show",
scope: "park",
kinds: ["facility_list"],
urlTemplate: "{P}/show.html",
urlMatch: "show.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations: "開くのみ（操作なし）。スクロール不要",
anchor:
"ページ自身の件数宣言と列挙件数が一致すること（件数は作り直しのたびに実測し、固定値にしない）",
note: "一覧外の「サービス・情報」は母集合に入れない",
branchPrefixes: ["{P}/show"],
},
{
nodeKey: "daily",
scope: "park",
kinds: ["operations", "show_schedule"],
urlTemplate: "{P}/daily/calendar/{D}/",
urlMatch: "daily/calendar",
stateFragmentLand: null,
stateFragmentSea: null,
operations:
"開く→折りたたみのうちアトラクション／ショー／レストランの3つだけ開く（他のカテゴリは開かない）。スクロール不要",
anchor:
"開園時間の表記・当日の大人価格・公演セクションの存在が確認できること。遠い日付で公演が「未定」なのは異常ではない",
note: "デイリーはサイトマップに載らない葉（日付ページ）。枝は {P}/daily の存在で判定する",
branchPrefixes: ["{P}/daily"],
},
{
nodeKey: "monthly",
scope: "park",
kinds: ["monthly_calendar"],
urlTemplate: "{P}/monthly/calendar.html",
urlMatch: "monthly/calendar.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations: "開くのみ。スクロール不要",
anchor: "対象月の表示が存在すること",
note: null,
branchPrefixes: ["{P}/monthly"],
},
{
nodeKey: "ticket",
scope: "park",
kinds: ["ticket_prices"],
urlTemplate: "{P}/ticket/index.html",
urlMatch: "ticket/index.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations:
"開く→ページ下部の「カレンダー」部分までスクロールし、日別の1デーパスポート価格が本文に現れてから取り込むこと。カレンダー部分が本文に無い取得は未完了として扱うこと（価格表だけで取り終えてはならない）",
anchor:
"価格表が存在し、カレンダー部分に対象日の1デーパスポート（大人）価格が表示されていること",
note: null,
branchPrefixes: ["{P}/ticket"],
},
{
nodeKey: "restaurant_list",
scope: "park",
kinds: ["restaurant_list"],
urlTemplate: "{P}/restaurant/list.html",
urlMatch: "restaurant/list.html",
stateFragmentLand: null,
stateFragmentSea: null,
operations:
"保管庫のスナップショット（GET /snapshot）から読むのが原則。保管庫に無い時だけ実ブラウザで開く（開くのみ・スクロール不要）。詳細ページはこの一覧の下の葉であり、取得は保管庫の束を原則とする（計画層の手順参照）",
anchor: "一覧が存在すること",
note: null,
branchPrefixes: ["{P}/restaurant"],
},
];

type AcquisitionPlanNode = PlanNodeDef & {
branchParks: { land: boolean; sea: boolean};
};

function parseStringArray(json: string | null | undefined): string[] {
if (!json) return [];
try {
const parsed: unknown = JSON.parse(json);
if (Array.isArray(parsed)) {
return parsed.filter((v): v is string => typeof v === "string");
}
} catch {
return [];
}
return [];
}

function planBranchPathPrefixes(): string[] {
const prefixes: string[] = [];
for (const def of PLAN_NODE_DEFS) {
for (const bp of def.branchPrefixes) {
if (bp.includes("{P}")) {
prefixes.push("/" + bp.replaceAll("{P}", "tdl"));
prefixes.push("/" + bp.replaceAll("{P}", "tds"));
} else {
prefixes.push("/" + bp);
}
}
}
return prefixes;
}

// Reduce a sitemap URL set (full URLs, extracted from sitemap.xml
// by the fetching task and carried in via submitSitemap) to the
// URL paths (Japanese tree only; the /en/ /tc/ /sc/ /kr/ trees are
// the same site in other languages and are not the plan's
// branches) under the branches the plan uses. Throws when the set
// is empty or carries any URL that is not on the official domain:
// a submission that is not the official sitemap must never become
// the plan's basis.
function reduceSitemapUrls(urls: string[]): {
paths: string[];
totalCount: number;
} {
if (urls.length === 0) {
throw new Error("submitSitemap: URLが1件も渡されていません。");
}
const prefixes = planBranchPathPrefixes();
const paths = new Set<string>();
for (const raw of urls) {
let parsed: URL;
try {
parsed = new URL(raw);
} catch {
throw new Error(
`submitSitemap: URLとして読めない値が含まれています: ${raw}`,
);
}
if (parsed.hostname !== "www.tokyodisneyresort.jp") {
throw new Error(
`submitSitemap: 公式ドメイン以外のURLが含まれています: ${raw}`,
);
}
const path = parsed.pathname;
if (/^\/(en|tc|sc|kr)\//.test(path)) continue;
if (prefixes.some((p) => path.startsWith(p))) paths.add(path);
}
return { paths: [...paths].sort(), totalCount: urls.length};
}

function materializePlanNodes(
pathSet: ReadonlySet<string> | null,
): AcquisitionPlanNode[] {
return PLAN_NODE_DEFS.map((def) => {
if (!pathSet) {
// No sitemap evidence (its GET failed and no plan was ever
// stored): assume the branches exist; the next successful
// rebuild replaces this with measured presence.
return {...def, branchParks: { land: true, sea: true}};
}
const present = (parkCode: "tdl" | "tds"): boolean =>
def.branchPrefixes.some((bp) => {
const prefix = "/" + bp.replaceAll("{P}", parkCode);
for (const p of pathSet) {
if (p.startsWith(prefix)) return true;
}
return false;
});
return {
...def,
branchParks: { land: present("tdl"), sea: present("tds")},
};
});
}

async function loadAcquisitionPlanNodes(
ctx: Ctx,
): Promise<AcquisitionPlanNode[]> {
const db = ctx.db<typeof schema>();
const rows = await db.select().from(schema.acquisitionPlanNodes);
const order = new Map(PLAN_NODE_DEFS.map((d, i) => [d.nodeKey, i]));
return rows
.map((r): AcquisitionPlanNode => {
let branchParks = { land: true, sea: true};
try {
const parsed: unknown = JSON.parse(r.branchParksJson);
if (parsed!= null && typeof parsed === "object") {
const p = parsed as { land?: unknown; sea?: unknown};
branchParks = {
land: p.land === true,
sea: p.sea === true,
};
}
} catch {
branchParks = { land: true, sea: true};
}
const def = PLAN_NODE_DEFS.find((d) => d.nodeKey === r.nodeKey);
return {
nodeKey: r.nodeKey,
scope: r.scope,
kinds: parseStringArray(r.kindsJson),
urlTemplate: r.urlTemplate,
urlMatch: r.urlMatch,
stateFragmentLand: r.stateFragmentLand,
stateFragmentSea: r.stateFragmentSea,
operations: r.operations,
anchor: r.anchor,
note: r.note,
branchPrefixes: def?.branchPrefixes?? [],
branchParks,
};
})
.sort(
(a, b) =>
(order.get(a.nodeKey)?? 99) - (order.get(b.nodeKey)?? 99),
);
}

type AcquisitionPlanEnsured = {
planState: "fresh" | "rebuild";
planCreatedAt: Date | null;
skeletonSame: boolean | null;
needsSitemap: boolean;
sitemapUrls: string[];
sitemapTotalCount: number | null;
nodes: AcquisitionPlanNode[];
};

// Persist a whole plan tree atomically: the plan row (sitemap URL
// set + creation instant), the full node set, in ONE batch (the
// runtime's transaction unit). A rebuild either lands completely
// or not at all — a half-written tree (plan row without nodes, or
// nodes without a creation instant) would corrupt the single
// clock every later fresh/rebuild judgement depends on.
async function persistAcquisitionPlan(
ctx: Ctx,
existingPlanId: number | null,
nodes: AcquisitionPlanNode[],
values: {
sitemapUrlsJson: string;
sitemapTotalCount: number;
planCreatedAt: Date;
sitemapFetchedAt: Date | null;
},
): Promise<void> {
const db = ctx.db<typeof schema>();
const statements: BatchItem<"sqlite">[] = [];
statements.push(db.delete(schema.acquisitionPlanNodes));
for (const n of nodes) {
statements.push(
db.insert(schema.acquisitionPlanNodes).values({
nodeKey: n.nodeKey,
scope: n.scope,
kindsJson: JSON.stringify(n.kinds),
urlTemplate: n.urlTemplate,
urlMatch: n.urlMatch,
stateFragmentLand: n.stateFragmentLand,
stateFragmentSea: n.stateFragmentSea,
operations: n.operations,
anchor: n.anchor,
note: n.note,
branchParksJson: JSON.stringify(n.branchParks),
}),
);
}
const planValues = {
sitemapUrl: SITEMAP_URL,
sitemapUrlsJson: values.sitemapUrlsJson,
sitemapTotalCount: values.sitemapTotalCount,
planCreatedAt: values.planCreatedAt,
sitemapFetchedAt: values.sitemapFetchedAt,
updatedAt: new Date(),
};
if (existingPlanId != null) {
statements.push(
db
.update(schema.acquisitionPlans)
.set(planValues)
.where(eq(schema.acquisitionPlans.id, existingPlanId)),
);
} else {
statements.push(db.insert(schema.acquisitionPlans).values(planValues));
}
const [first, ...rest] = statements;
if (first) await db.batch([first, ...rest]);
}

// The rebuild decision — clock ONLY. The server never fetches
// the sitemap (see the layer header): while a complete plan is
// stored and inside its 3 hours, the plan is fresh and reads come
// from the stored rows. Past expiry (or with no complete plan
// stored), this returns planState="rebuild" with needsSitemap=true
// and attempts NO fetch: the fetching task carries the sitemap
// URL set in through submitSitemap, which does the comparison
// and the atomic persist. Until a set is submitted, decisions
// are computed on the existing skeleton — the stored tree, or the
// default tree (branch presence assumed, assembled in memory
// only, never persisted) when nothing is stored — and the
// creation instant is NOT advanced, so the next turn retries
// the rebuild.
async function ensureAcquisitionPlan(
ctx: Ctx,
at: Date,
): Promise<AcquisitionPlanEnsured> {
const db = ctx.db<typeof schema>();
const metaRows = await db.select().from(schema.acquisitionPlans).limit(1);
const meta = metaRows[0];
const storedNodes = await loadAcquisitionPlanNodes(ctx);
// A stored plan counts only as a complete unit: the plan row AND
// every node of the tree. Anything less (e.g. a legacy partial
// write) is treated as "no plan" and rebuilt + persisted whole.
const hasStoredPlan =
meta != null && storedNodes.length >= PLAN_NODE_DEFS.length;
if (
hasStoredPlan &&
at.getTime() - meta.planCreatedAt.getTime() <= PLAN_VALIDITY_MS
) {
return {
planState: "fresh",
planCreatedAt: meta.planCreatedAt,
skeletonSame: null,
needsSitemap: false,
sitemapUrls: parseStringArray(meta.sitemapUrlsJson),
sitemapTotalCount: meta.sitemapTotalCount,
nodes: storedNodes,
};
}
return {
planState: "rebuild",
planCreatedAt: hasStoredPlan ? (meta?.planCreatedAt ?? null) : null,
skeletonSame: null,
needsSitemap: true,
sitemapUrls: hasStoredPlan ? parseStringArray(meta?.sitemapUrlsJson) : [],
sitemapTotalCount: hasStoredPlan ? (meta?.sitemapTotalCount ?? null) : null,
nodes: hasStoredPlan ? storedNodes : materializePlanNodes(null),
};
}

// Accept the sitemap URL set carried in by the fetching task
// (the submitSitemap action): validate it (official domain only
// — reduceSitemapUrls throws otherwise), compare the
// branch-restricted set against the stored one
// (skeletonSameAsPrevious; null when no earlier set was ever
// stored, i.e. there is no basis for comparison), persist the
// plan row, the whole node set, the sitemap URL set and the
// creation instant together (persistAcquisitionPlan), and return
// the rebuilt plan in the same ensured shape planAcquisition
// consumes. The returned tree is re-read from the stored rows.
async function submitAcquisitionPlanSitemap(
ctx: Ctx,
urls: string[],
at: Date,
): Promise<AcquisitionPlanEnsured> {
const db = ctx.db<typeof schema>();
const reduced = reduceSitemapUrls(urls);
const metaRows = await db.select().from(schema.acquisitionPlans).limit(1);
const meta = metaRows[0];
const prevPaths = meta ? parseStringArray(meta.sitemapUrlsJson) : null;
const skeletonSame =
prevPaths != null && prevPaths.length > 0
? prevPaths.length === reduced.paths.length &&
prevPaths.every((p, i) => p === reduced.paths[i])
: null;
const nodes = materializePlanNodes(new Set(reduced.paths));
await persistAcquisitionPlan(ctx, meta?.id ?? null, nodes, {
sitemapUrlsJson: JSON.stringify(reduced.paths),
sitemapTotalCount: reduced.totalCount,
planCreatedAt: at,
sitemapFetchedAt: new Date(),
});
return {
planState: "rebuild",
planCreatedAt: at,
skeletonSame,
needsSitemap: false,
sitemapUrls: reduced.paths,
sitemapTotalCount: reduced.totalCount,
nodes: await loadAcquisitionPlanNodes(ctx),
};
}

// The per-node decision computation shared by planAcquisition
// and submitSitemap: for one park + target date, decide per tree
// node whether the run FETCHES the page (returning the
// materialized URL and the node's operations) or REUSES a stored
// snapshot (returning its id and fetch time), or SKIPS the node
// (its branch is absent from the sitemap the plan was built
// from). Reuse is judged ONLY by snapshot existence and
// freshness: a snapshot of the node's URL fetched within 3 hours
// of the evaluation instant. Canonicality, fetch method and
// completeness declarations do NOT enter the decision. The daily
// node additionally requires its snapshots to be about the
// target date, and when the target date is the evaluation day
// the daily node is always fetched regardless of freshness. The
// restaurant_list node is storehouse-first: with no fresh local
// snapshot its decision is "storehouse". Restaurant detail
// leaves are never fetched by the run: each is "storehouse".
async function computeAcquisitionDecisions(
ctx: Ctx,
plan: AcquisitionPlanEnsured,
park: "land" | "sea",
targetDate: string,
at: Date,
) {
const db = ctx.db<typeof schema>();
const isToday = targetDate === jstTodayIso(at);
// Snapshot metadata for this park, newest first. Raw texts are
// not loaded here: the decision needs only existence + fetch
// time (plus the completeness note for the facility_list anchor
// exception in snapshotMatchesPlanNode).
const snaps = await db
.select({
id: schema.sourceSnapshots.id,
kind: schema.sourceSnapshots.kind,
targetDate: schema.sourceSnapshots.targetDate,
url: schema.sourceSnapshots.url,
completenessNote: schema.sourceSnapshots.completenessNote,
fetchedAt: schema.sourceSnapshots.fetchedAt,
})
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.park, park))
.orderBy(desc(schema.sourceSnapshots.fetchedAt))
.limit(1000);
const usable = snaps.filter((s) => s.fetchedAt.getTime() <= at.getTime());
type SnapMeta = (typeof usable)[number];

type NodeDecision = {
nodeKey: string;
kinds: string[];
decision: "reuse" | "fetch" | "skip" | "storehouse";
reason: string;
url: string | null;
operations: string | null;
anchor: string;
snapshotId: number | null;
snapshotIds: number[];
snapshotFetchedAt: string | null;
};
const decisions: NodeDecision[] = [];
for (const node of plan.nodes) {
if (!node.branchParks[park]) {
decisions.push({
nodeKey: node.nodeKey,
kinds: node.kinds,
decision: "skip",
reason:
"この枝は、計画を作ったサイトマップに存在しないため取得しない（前提の崩れとして扱う）",
url: null,
operations: null,
anchor: node.anchor,
snapshotId: null,
snapshotIds: [],
snapshotFetchedAt: null,
});
continue;
}
const matched = usable.filter((s) => snapshotMatchesPlanNode(s, node));
// The snapshots this node would adopt. The daily node is
// date-bound and produces one snapshot per kind: every kind
// must have a snapshot about targetDate, and the OLDEST of
// them governs the node's freshness. Every other node adopts
// its latest matching snapshot.
let adopted: SnapMeta[] = [];
if (node.nodeKey === "daily") {
const perKind: SnapMeta[] = [];
let completeSet = node.kinds.length > 0;
for (const kind of node.kinds) {
const latest = matched.find(
(s) => s.kind === kind && s.targetDate === targetDate,
);
if (latest) perKind.push(latest);
else completeSet = false;
}
adopted = completeSet ? perKind : [];
} else {
const latest = matched[0];
adopted = latest ? [latest] : [];
}
const effectiveFetchedAt =
adopted.length > 0
? new Date(Math.min(...adopted.map((s) => s.fetchedAt.getTime())))
: null;
let decision: "reuse" | "fetch";
let reason: string;
if (node.nodeKey === "daily" && isToday) {
decision = "fetch";
reason = "対象日が当日のため、デイリーは鮮度に関係なく取得する";
} else if (adopted.length === 0) {
decision = "fetch";
reason = "再利用できるスナップショットが無いため取得する";
} else if (
effectiveFetchedAt != null &&
at.getTime() - effectiveFetchedAt.getTime() > PLAN_VALIDITY_MS
) {
decision = "fetch";
reason = "最新の取得から3時間を超えたため取得する";
} else {
decision = "reuse";
reason = "そのURLのスナップショットがあり、取得から3時間以内のため再利用する";
}
// The restaurant list is storehouse-first (owner's correction,
// 2026-11-19): when it is not reusable locally, its decision is
// "storehouse" — read the storehouse's snapshot of the list URL,
// and fetch it with the own browser only when the storehouse
// holds none. The URL and operations travel with the decision
// for that fallback.
const storehouseFirst =
node.nodeKey === "restaurant_list" && decision === "fetch";
decisions.push({
nodeKey: node.nodeKey,
kinds: node.kinds,
decision: storehouseFirst ? "storehouse" : decision,
reason: storehouseFirst
? "レストラン一覧は保管庫のスナップショットから読むのが原則のため、まず保管庫を引く（保管庫に無ければ自前で取得する）"
: reason,
url:
decision === "fetch"
? expandAcquisitionPlanUrl(node, park, targetDate)
: null,
operations: decision === "fetch" ? node.operations : null,
anchor: node.anchor,
snapshotId: decision === "reuse" ? (adopted[0]?.id ?? null) : null,
snapshotIds: decision === "reuse" ? adopted.map((s) => s.id) : [],
snapshotFetchedAt:
decision === "reuse" && effectiveFetchedAt
? effectiveFetchedAt.toISOString()
: null,
});
}
const leaves = await db
.select({ url: schema.acquisitionRestaurantLeaves.url })
.from(schema.acquisitionRestaurantLeaves)
.where(eq(schema.acquisitionRestaurantLeaves.park, park))
.orderBy(asc(schema.acquisitionRestaurantLeaves.url));
return {
nodes: decisions,
restaurantLeaves: leaves.map((l) => ({
url: l.url,
decision: "storehouse" as const,
})),
};
}

// The verified anchors recorded by the server's machine check in
// the snapshot's completenessNote.
function snapshotVerifiedAnchors(
completenessNote: string | null,
): { kind: string; declared: number; listed: number; label: string}[] {
if (!completenessNote) return [];
try {
const parsed: unknown = JSON.parse(completenessNote);
if (parsed!= null && typeof parsed === "object" && "machineCheck" in parsed) {
const mc = (parsed as { machineCheck: unknown}).machineCheck;
if (mc!= null && typeof mc === "object" && "anchors" in mc) {
const anchors = (mc as { anchors: unknown}).anchors;
if (Array.isArray(anchors)) {
return anchors
.filter(
(a): a is { kind: string; declared: number; listed: number; label: string} =>
a!= null &&
typeof a === "object" &&
typeof (a as { declared: unknown}).declared === "number" &&
typeof (a as { listed: unknown}).listed === "number",
)
.map((a) => ({
kind: typeof a.kind === "string"? a.kind: "",
declared: a.declared,
listed: a.listed,
label: typeof a.label === "string"? a.label: "",
}));
}
}
}
} catch {
return [];
}
return [];
}

// A stored snapshot belongs to a plan node when its kind is one of
// the node's kinds and its URL carries the node's match fragment.
// One exception, grounded in how the official pages actually are:
// the attraction page itself enumerates BOTH lists (attractions
// and parades/shows), so a single facility_list snapshot saved
// from it verifiably carries the show list too. Such a snapshot
// also belongs to the other list's node when the server's machine
// check verified THAT list's anchor in its text — the anchor is
// the identity (the plan's own common rule: identity is judged by
// the fetched page's own anchor), never the URL alone.
function snapshotMatchesPlanNode(
snap: { kind: string; url: string; completenessNote?: string | null},
node: AcquisitionPlanNode,
): boolean {
if (!node.kinds.includes(snap.kind)) return false;
if (snap.url.includes(node.urlMatch)) return true;
if (snap.kind === "facility_list" && snap.completenessNote) {
const anchors = snapshotVerifiedAnchors(snap.completenessNote);
if (node.nodeKey === "attraction") {
return anchors.some((a) => a.label.includes("アトラクション"));
}
if (node.nodeKey === "show") {
return anchors.some(
(a) => a.label.includes("ショー") || a.label.includes("パレード"),
);
}
}
return false;
}

// Expand a plan node's URL template for one run: {P} = tds/tdl,
// {D} = target date as YYYYMMDD. The DPA node's per-park state
// fragment (tab + expansion state) is appended so the page opens
// directly in the target park's expanded state.
function expandAcquisitionPlanUrl(
node: AcquisitionPlanNode,
park: "land" | "sea",
targetDate: string,
): string {
const parkCode = park === "sea"? "tds": "tdl";
const path = node.urlTemplate
.replaceAll("{P}", parkCode)
.replaceAll("{D}", targetDate.replaceAll("-", ""));
let url = `https://www.tokyodisneyresort.jp/${path}`;
const fragment =
park === "sea"? node.stateFragmentSea: node.stateFragmentLand;
if (fragment) url += fragment;
return url;
}

// ---------- storehouse (Cloudflare 保管庫） ----------
//
// The storehouse is a Cloudflare Worker + KV that drip-fetches the
// registered official URLs with Browser Run and serves the texts
// back read-only. Copies never write content to it; the only write
// is the URL list (POST /urls, sanity-gated on the storehouse
// side: official domain only, 20–500 URLs). The sitemap heads the
// circulation list: the storehouse serves its Japanese-only URL
// set through GET /sitemap, which is the principal sitemap source
// for the acquisition plan layer (getStorehouseSitemap).
// Restaurant detail
// pages are read from it as a bundle in principle, and the
// restaurant list pages are read from its snapshots in principle
// (own fetch only when the storehouse holds none); any other page
// may be read from it only as the last resort when the copy's own
// browser fetch failed. Material that came from the storehouse is
// recorded with fetchMethod "storehouse" and the storehouse's own
// fetch time (sourceFetchedAt) — never relabelled "browser".

// The fixed URLs of the circulation list, in order: FIRST the
// sitemap itself (the storehouse fetches it with Browser Run and
// serves the Japanese-only URL set back through GET /sitemap —
// see getStorehouseSitemap), then the fixed 13: the DPA page's
// two state URLs (one per park), the announcements page, and per
// park the attraction / show / monthly / ticket /
// restaurant-list pages. The daily pages are NOT on the list
// (they are dated; each copy fetches its target date live), and
// neither are detail pages — those join the list as the
// restaurant leaves.
function storehouseFixedUrls(): string[] {
const byKey = new Map(PLAN_NODE_DEFS.map((d) => [d.nodeKey, d]));
const mk = (key: string, park: "land" | "sea"): string | null => {
const def = byKey.get(key);
if (!def) return null;
const parkCode = park === "sea"? "tds": "tdl";
let url = `https://www.tokyodisneyresort.jp/${def.urlTemplate.replaceAll("{P}", parkCode)}`;
const fragment =
park === "sea"? def.stateFragmentSea: def.stateFragmentLand;
if (fragment) url += fragment;
return url;
};
const urls: (string | null)[] = [
SITEMAP_URL,
mk("dpa", "sea"),
mk("dpa", "land"),
mk("announcements", "sea"),
];
for (const park of ["land", "sea"] as const) {
for (const key of ["attraction", "show", "monthly", "ticket", "restaurant_list"]) {
urls.push(mk(key, park));
}
}
return urls.filter((u): u is string => u!= null);
}

function parkOfDetailUrl(url: string): "land" | "sea" | null {
if (url.includes("/tds/restaurant/detail/")) return "sea";
if (url.includes("/tdl/restaurant/detail/")) return "land";
return null;
}

// Register newly learned restaurant detail URLs as plan leaves.
// On conflict only the last-seen instant advances — the recorded
// source (where the URL was first learned) is kept.
async function upsertRestaurantLeaves(
ctx: Ctx,
entries: { url: string; park: "land" | "sea"; source: "storehouse" | "snapshot"}[],
): Promise<void> {
if (entries.length === 0) return;
const db = ctx.db<typeof schema>();
const now = new Date();
for (const e of entries) {
await db
.insert(schema.acquisitionRestaurantLeaves)
.values({
url: e.url,
park: e.park,
source: e.source,
firstSeenAt: now,
lastSeenAt: now,
})
.onConflictDoUpdate({
target: schema.acquisitionRestaurantLeaves.url,
set: { lastSeenAt: now},
});
}
}

// ---------- storehouse reads save themselves (owner's fix, 2026-11-20) ----------
//
// Bug this closes: a run read the restaurant list from the
// storehouse (getStorehouseSnapshot returned the text and the
// read was recorded), but the task never saved that text as a
// snapshot of the run — so the run's record carried the list as
// UNCONFIRMED ("存在は確認したが、この回ではスナップショットと
// して保存していない") and the completion message warned that
// current-spec items were unconfirmed, even though the material
// was in hand. Material the server itself read must not depend
// on the task remembering to save it: when getStorehouseSnapshot
// returns a text, the SERVER saves it here, at read time, as a
// snapshot of the run — fetchMethod "storehouse", fetchedAt =
// the storehouse's own fetch time (the sourceFetchedAt contract,
// same as a task-side saveSourceSnapshots of storehouse
// material). Storehouse material still NEVER becomes canonical
// (canonicality requires exactly "browser"), and the daily
// pages are never saved from the storehouse: they have no
// storehouse substitute (the dated page is fetched live, always).
//
// The snapshot's kind and park are derived from the URL alone:
// a restaurant detail URL is a restaurant_detail of its park;
// every other URL is matched against the plan tree's node
// definitions (urlMatch). A park-scoped node's park is in its
// path (/tds/ / /tdl/); the common DPA page carries the park in
// its state fragment; the common announcements page carries no
// park, so the open run's plan-set park is used (the same park
// a task-side save would record). When kind or park cannot be
// determined the read still stands — only the save is skipped,
// and the caller states that in the run record. An identical
// storehouse snapshot (same URL, same storehouse fetch time)
// already stored — by an earlier read or by the task itself —
// is adopted instead of duplicated.
type StorehouseSnapshotKind =
| "dpa_page"
| "facility_list"
| "operations"
| "show_schedule"
| "ticket_prices"
| "announcements"
| "monthly_calendar"
| "restaurant_list"
| "restaurant_detail";

const STOREHOUSE_SNAPSHOT_KINDS: readonly string[] = [
"dpa_page",
"facility_list",
"operations",
"show_schedule",
"ticket_prices",
"announcements",
"monthly_calendar",
"restaurant_list",
"restaurant_detail",
];

async function saveStorehouseReadSnapshot(
ctx: Ctx,
args: { url: string; text: string; fetchedAt: string | null },
): Promise<number | null> {
try {
const db = ctx.db<typeof schema>();
// The daily pages have no storehouse substitute: never save
// one from a storehouse read, whatever the storehouse holds.
if (args.url.includes("daily/calendar")) return null;
let kind: StorehouseSnapshotKind | null = null;
let park: "land" | "sea" | null = null;
const detailPark = parkOfDetailUrl(args.url);
if (detailPark) {
kind = "restaurant_detail";
park = detailPark;
} else {
const def = PLAN_NODE_DEFS.find(
(d) => d.kinds.length === 1 && args.url.includes(d.urlMatch),
);
const defKind = def?.kinds[0];
if (def && defKind && STOREHOUSE_SNAPSHOT_KINDS.includes(defKind)) {
kind = defKind as StorehouseSnapshotKind;
if (def.scope === "park") {
if (args.url.includes("/tds/")) park = "sea";
else if (args.url.includes("/tdl/")) park = "land";
} else {
// Common pages: the DPA page's state fragment names the
// park; the announcements page names none.
let rest = args.url;
try {
const u = new URL(args.url);
rest = u.pathname + u.search + u.hash;
} catch {
// Keep the raw URL as the search space.
}
if (rest.includes("tds")) park = "sea";
else if (rest.includes("tdl")) park = "land";
}
}
}
const openRuns = await db
.select({
id: schema.runLogs.id,
planSetId: schema.runLogs.planSetId,
})
.from(schema.runLogs)
.where(eq(schema.runLogs.status, "open"))
.orderBy(desc(schema.runLogs.id))
.limit(1);
const openRun = openRuns[0] ?? null;
if (park == null && openRun) {
const setRows = await db
.select({ park: schema.planSets.park })
.from(schema.planSets)
.where(eq(schema.planSets.id, openRun.planSetId))
.limit(1);
park = setRows[0]?.park ?? null;
}
if (kind == null || park == null) return null;
const sourceFetchedDate = args.fetchedAt
? new Date(args.fetchedAt)
: null;
const hasSourceDate =
sourceFetchedDate != null &&
!Number.isNaN(sourceFetchedDate.getTime());
// Dedupe: the same storehouse material (same URL, same
// storehouse fetch time — or, when the storehouse gave no
// fetch time, the identical text) is already this run's
// snapshot; adopt it instead of storing a second copy.
const existing = await db
.select({ id: schema.sourceSnapshots.id })
.from(schema.sourceSnapshots)
.where(
and(
eq(schema.sourceSnapshots.url, args.url),
eq(schema.sourceSnapshots.fetchMethod, "storehouse"),
...(hasSourceDate && sourceFetchedDate
? [eq(schema.sourceSnapshots.fetchedAt, sourceFetchedDate)]
: [eq(schema.sourceSnapshots.rawText, args.text)]),
),
)
.orderBy(desc(schema.sourceSnapshots.id))
.limit(1);
if (existing[0]) return existing[0].id;
const machine = checkDeclaredSectionCounts(args.text);
const completenessNote = JSON.stringify({
declaration: null,
fetchMethod: "storehouse",
readTimings: null,
sourceFetchedAt: args.fetchedAt ?? null,
browserFetched: false,
machineCheck: {
sectionsChecked: machine.checked,
mismatches: machine.mismatches,
anchors: machine.anchors,
anchorMissing: machine.anchors.length === 0,
serverNote:
"保管庫からの読み取り（getStorehouseSnapshot）の時点で、サーバーが自動で保存したスナップショットです（タスクの保存操作は不要です）。取得方法が実ブラウザ（fetchMethod=\"browser\"）ではないため、このスナップショットは正典にしません。",
},
canonical: false,
});
const inserted = await db
.insert(schema.sourceSnapshots)
.values({
kind,
park,
targetDate: null,
url: args.url,
title: null,
rawText: args.text,
batchId: openRun ? `storehouse-run-${openRun.id}` : "storehouse-read",
fetchMethod: "storehouse",
canonical: 0,
completenessNote,
...(hasSourceDate && sourceFetchedDate
? { fetchedAt: sourceFetchedDate }
: {}),
})
.returning({ id: schema.sourceSnapshots.id });
const row = inserted[0];
if (!row) return null;
if (kind === "restaurant_detail") {
await upsertRestaurantLeaves(ctx, [
{ url: args.url, park, source: "storehouse" as const },
]);
}
ctx.invalidateQueries();
return row.id;
} catch {
// The read's result stands regardless of the save; the
// caller records that no snapshot was saved.
return null;
}
}

// The decision shape returned by both planAcquisition and
// submitSitemap (identical by design: a task that carried the
// sitemap in continues on the returned decision exactly as if
// planAcquisition had produced it on a fresh plan).
const planDecisionResponse = z.object({
park: parkEnum,
targetDate: z.string(),
atTime: z.string(),
planState: z.enum(["fresh", "rebuild"]),
planCreatedAt: z.string().nullable(),
skeletonSameAsPrevious: z.boolean().nullable(),
needsSitemap: z.boolean(),
nodes: z.array(
z.object({
nodeKey: z.string(),
kinds: z.array(z.string()),
decision: z.enum(["reuse", "fetch", "skip", "storehouse"]),
reason: z.string(),
url: z.string().nullable(),
operations: z.string().nullable(),
anchor: z.string(),
snapshotId: z.number().nullable(),
snapshotIds: z.array(z.number()),
snapshotFetchedAt: z.string().nullable(),
}),
),
restaurantLeaves: z.array(
z.object({
url: z.string(),
decision: z.literal("storehouse"),
}),
),
});

// The plan-layer instruction interpolated into every assignment
// that fetches the canonical source set (generation / same-day /
// partial replacement / bulk re-verification): register the URL
// list with the storehouse, call planAcquisition BEFORE fetching,
// fetch only the nodes it marks fetch (exactly as the node's
// operations column says), reuse the snapshots it names, build
// facts from THIS run's material every time, take restaurant
// details from the storehouse bundle in principle, fall back to
// the storehouse snapshot only when an own browser fetch failed —
// and never change the plan mid-run.
function acquisitionPlanSteps(
park: "land" | "sea",
targetDate: string | null,
): string {
const dateArg = targetDate?? "対象日（YYYY-MM-DD）";
return `取得に入る前に、まず次の2つを行うこと。(0) syncStorehouseUrls アクションを呼ぶこと（この回のURL一覧＝固定14件（先頭はサイトマップURL、続いて固定13件）＋レストラン詳細の巡回リストを保管庫へ送る。保管庫は巡回用の保管庫であり、ok=false が返っても取得は止めずに続けること）。(1) planAcquisition アクション（park="${park}"、targetDate="${dateArg}"）を呼び、この回の取得計画を得ること。計画は公式サイトマップから作る木であり、時計は1つ（計画・スナップショットとも有効期間3時間）。planState="rebuild" かつ needsSitemap=true が返った場合は、計画の作り直しにサイトマップのURL集合が必要という合図である（サーバーはサイトマップを自分では取得しない）：まず getStorehouseSitemap アクションを呼び、保管庫が保持するサイトマップのURL集合（日本語ページのみ）を引くこと。urls が返れば、それをそのまま submitSitemap アクション（urls=その配列、park="${park}"、targetDate="${dateArg}"）へ渡し、返ってきた決定（ノードごとの fetch／reuse／storehouse）で取得を進めること。この読み取りの開始／終了と、サイトマップの出所が保管庫であること・保管庫の取得時刻は、サーバーが過程記録に自動で残す（自分で記録してはならない）。getStorehouseSitemap が null を返した（保管庫にまだ無い）場合だけ、従来どおり自分の環境で https://www.tokyodisneyresort.jp/sitemap.xml をプレーンに取得し（実ブラウザではなく通常のHTTP取得でよい）、<loc> のURLを全て抽出して submitSitemap へ渡すこと。保管庫にも無く、自分の環境でもサイトマップが取得できなかった場合は、その旨をこの回の取得記録（失敗の報告・未確認の記録）に必ず開示し、planAcquisition が返した既存の計画の骨格（ノード決定）のまま進めること（計画の作成時刻は進まないため、次の回でも作り直しが試みられる）。実行中に計画（木）を変えてはならない。返却への従い方：(a) decision="fetch" のノードだけを、その url（展開済み）と operations（操作列）のとおりに実ブラウザで取得すること（操作列がこの手順書の汎用的な取得手順と食い違う場合は、操作列を優先する）。取得したページは、他のページを読む前に、1ページごとに直ちに saveSourceSnapshots で保存すること（複数ページ分をまとめて後から保存してはならない）。保存を受けたサーバーが、そのページの読み取り完了をサーバーの時刻で過程記録に書く——それが読み取りの正式な記録であり、保存の時刻の並びが読み取りの進み方になる。ページの読み取りの開始／終了を、過程記録に自分で書いてはならない。(b) decision="reuse" のノードは取得しないこと。その snapshotId（複数あるノードは snapshotIds）のスナップショットが、この回のそのノードの材料である（本文は getSourceSnapshots で読める）。decision="skip" のノードは、その枝がサイトマップに無いため取得しないこと。(b2) decision="storehouse" のノード（レストラン一覧）は、まず getStorehouseSnapshot アクション（url=そのノードの url）で保管庫のスナップショットを引くこと。保管庫にあれば、サーバーが読んだ時点でその本文を fetchMethod="storehouse"・sourceFetchedAt=保管庫の取得時刻つきのスナップショットとして保存する（返却の snapshotId が、この回のそのノードの材料である）。自分で saveSourceSnapshots に保存し直す必要はなく、保存していないことを理由に未確認として記録してはならない。完全性の錨はその本文に対して照合すること。保管庫に無ければ、そのノードの url を operations のとおり実ブラウザで取得すること。(c) ファクト構築（saveNormalizedFacts）は、毎回この回の材料（再利用スナップショットと今回 fetch して保存したスナップショットの集合）から行うこと。過去のファクト構築を再利用して構築を省略してはならない。(d) レストラン詳細ページは保管庫の束が原則である：getStorehouseRestaurants アクションで束を取り、使う店が束にあれば、その本文を saveSourceSnapshots（kind="restaurant_detail"、fetchMethod="storehouse"、sourceFetchedAt=束のその項目の fetchedAt）で保存し、それをファクトの根拠にすること（取得時刻と出所＝保管庫は、そのスナップショットの記録に残る）。束に無い店だけ、従来どおり実ブラウザで開いて取得すること。(e) fetch と判定されたページの自前のブラウザ取得が失敗した場合は、最後の手段として getStorehouseSnapshot アクション（url=そのページのURL）を引くこと。保管庫にあれば、サーバーが読んだ時点でその本文を fetchMethod="storehouse"・sourceFetchedAt=保管庫の取得時刻つきのスナップショットとして保存する（返却の snapshotId が、そのページのこの回の材料である）。自分で saveSourceSnapshots に保存し直す必要はなく、保存していないことを理由に未確認として記録してはならない。完全性の錨はその本文に対して照合すること。保管庫由来の材料を自前のブラウザ取得（fetchMethod="browser"）と偽って記録してはならない。保管庫にも無ければ、従来どおり「取得できなかった」として見える形で扱うこと。(f) 再利用の判定は鮮度（取得から3時間以内）だけであり、正典かどうかは問わない。ただしファクト登録の正典要件は従来どおりであり、再利用材料が正典でないためにファクトの根拠にできない場合は、そのページに限って取得し直してよい（計画の再利用判定は正典ゲートを緩めるものではない）。(g) 取得の失敗は、この回の取得記録（失敗の報告・未確認の記録）に残すこと。計画はその場で書き換えないこと（失敗の記録が、次の作り直しの材料になる）。`;
}

function buildAssignment(
c: Conditions,
planSetId: number,
waitRefs: {
name: string;
url: string;
provides: string | null;
fetchMethod: "script" | "browser" | "failed" | null;
}[],
previousSummary: string | null,
// Non-null when this run is a day-of reschedule: the user's own
// report of the day-of facts that triggered it (their recent chat
// messages). The assignment then switches the estimation material to
// the CURRENT published wait times and rebuilds only the remainder
// of the visit day.
dayOf: { userReport: string} | null,
// Non-null for a chat-started rebuild whose preceding exchange
// decided specific changes (the user's own recent messages, minus
// the bare start command): those changes are this run's binding
// change conditions, not a generic rebuild. Null for form starts,
// fresh creations, and rebuilds with no decided change.
changeRequest: string | null = null,
areaMatrixLines: string = "",
// Non-null when a finished set for the same park + visit date
// already carries a DECIDED crowd forecast: the forecast is
// decided once per date, so this run must reuse it verbatim
// instead of re-evaluating (step 1c below). Looked up by
// startGeneration; savePlanSet enforces the same rule at the
// storage layer.
heldCrowd: HeldCrowdForecast | null = null,
): string {
const officialTop =
c.park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
const today = new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
});
const methodLabel = (
m: "script" | "browser" | "failed" | null,
): string =>
m === "script"
? "前回は静的取得で取得できた"
: m === "browser"
? "前回はブラウザ表示で取得できた（静的取得では取れない）"
: m === "failed"
? "前回はどちらの方法でも取得できなかった"
: "取得方法は未記録";
const waitRefLines =
waitRefs.length > 0
? waitRefs
.map(
(r) =>
`- ${r.name}: ${r.url}${r.provides? `（取れるもの: ${r.provides}）`: ""}（取得方法の記録: ${methodLabel(r.fetchMethod)}）`,
)
.join("\n")
: "（現在、登録されている参考サイトはありません）";
return [
`東京ディズニーリゾート公式サイトから、対象パーク・対象日の最新情報を取得し、1日の行動プランを3案（プランA/B/C）作成するタスクです。通常の事前計画では、待ち時間は下記の参考サイトの実績集計から「典型的な水準」を推定します。当日のリスケジュール（下記に【当日リスケジュール】の指示がある場合）は例外で、その時点で公開されている現在の待ち時間を材料にします。なお、このアプリはDPA（ディズニー・プレミアアクセス）の販売状況を取得できません。販売状況については、ユーザーが報告した事実だけを前提にし、報告にない販売状況を推測したり断定したりしないこと。`,
``,
``,
conditionsToText(c),
``,
...(previousSummary
? [
`【これは作り直しです】同じパーク・同じ日付の前回のプランが既にあります（下記）。今回は、その構成（施設の顔ぶれと各プランの軸）を基本として引き継ぎながら、待ち時間の推定を全行に入れ直し、推定と矛盾しないよう時刻を組み直した「作り直し版」を作ることが目的です。施設を総入れ替えしないこと（休止になった施設や、時刻計算上どうしても入らない施設は除いてよいが、その場合は notes に理由を書く）。【引き継ぎの厳守】下記の前回プランの各項目に付いている座標・公式URL・エリアは、そのまま今回の保存データに引き継ぐこと。これらの引き継いだ静的属性について、公式ページの再読込や Nominatim の再照会などの再取得は禁止する（前回の取得結果が正であり、取り直す理由がない）。施設辞書にも同じ値が入っているはずで、辞書の値と前回の値が食い違う場合は前回の値を優先する。【パス前提は引き継がない（厳守）】引き継ぐのは構成（施設の顔ぶれ・大まかな順序）と静的属性までで、前回プランのパス前提（ディズニー・プレミアアクセス等の passType）は引き継がない——前回のパス前提自体が誤っていることがあり（対象外施設へのDPA設定など）、引き継ぐと誤りがそのまま残る。前回の一覧にはパス前提を載せていない。どの施設にDPA前提を付けるかは、今回の正規化ファクト（手順1aで登録した完全なビルド）だけで毎回決めること。notes には「前回からの変更点」として、どの施設の開始時刻がどれだけ動いたか、待ち時間の推定をどう入れたかを箇条書きで必ず書くこと。`,
``,
previousSummary,
``,
]
: []),
``,
...(changeRequest
? [
`【今回の作り直しで反映する変更条件（必須・最優先）】直前のチャットでユーザーが決めた変更は次のとおり（ユーザー本人の発言）:「${changeRequest}」`,
`・この変更を必ず反映すること。対象プランが指定されていればそのプランに、指定がなければ該当するプランに反映する。汎用的な作り直しで済ませてはいけない。`,
`・変更対象の施設にどのパス前提を付けるかは、この回の正規化ファクト（手順1aで登録した完全なビルド）だけで決めること。変更で追加する施設がDPA対象外なら、スタンバイの推定待ち時間で組み直す（対象外の施設にDPAは存在しない）。`,
`・notes には、この変更をどう反映したか（どのプランの何がどう変わったか）を必ず書くこと。`,
``,
]
: []),
...(dayOf
? [
`【当日リスケジュール（この指示は下記の通常手順より優先する）】これは当日のリスケジュールです。ユーザーが当日報告した事実は次のとおり：「${dayOf.userReport}」`,
`・現在時刻（日本時間）は ${new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false})} ごろです。プランは「今から退園時刻まで」の残り時間について組み直すこと。すでに過ぎた時間帯の項目は入れない。`,
`・DPAの販売状況はこのアプリには分かりません。ユーザーの報告した事実（例: 予定していた施設のDPAが取れなくなった）だけを前提にし、報告されていないDPAについて「買える／買えない」を推測で決めないこと。報告で取れなくなった施設は、DPAなし（スタンバイ）で組み直すか、別の項目に置き換えること（その判断と理由を notes に書く）。`,
`・【推定材料の上書き】手順1bの「集計の平均・典型的な水準」は、このリスケジュールでは使わない。その時点で公開されている現在の待ち時間を材料にすること：公式のリアルタイム待ち時間表示と、下記の登録済み待ち時間参考サイトの「現在値」を実際に開いて読む。取得は従来どおりサイトごとの段階制（記録された取得方法から開始し、静的取得→ブラウザ表示）とし、取得できなかったサイトは材料に使えなかった旨を notes に記録すること（waitSourceFetchResults の報告も従来どおり全サイト分必須）。estimateSources には現在値を実際に読んだサイトを入れること。`,
`・推定待ち時間の必須化（全アトラクション行に estWaitMin）、スケジュールの時刻計算と保存時の矛盾検証、余裕の確保は従来どおり厳守すること。ただし時刻計算の起点は入園時刻ではなく現在時刻であり、残り時間に収まる構成にすること。なお、この当日リスケジュールでは混雑係数は使わない（現在の待ち時間が材料のため、係数を掛けると二重に数える）。crowdLevel／crowdBasis／crowdWaitFactors は渡さないこと。レストラン行（kind=restaurant）には推定待ち時間（estWaitMin）を付けないこと（nullにする。レストランの待ち時間はモデル化しない＝事前に準備してある前提）。`,
``,
]
: []),
`【全体の進め方（取得は辞書→一括取得→保存データから作成）】毎回すべてを最初から取り直すのが遅さの原因なので、この順序を厳守すること。(i) まず施設辞書と前回プラン（作り直しの場合）で足りる静的属性は再利用し、(ii) 不足分だけを一括取得スクリプトでまとめて取り、(iii) 計画は保存済みデータ（辞書＋今回取得して保存したデータ＋日付層の確認結果）から作る。日付で変わる情報（営業時間・休止・ショー時刻）は辞書の対象外で、対象日ごとに毎回確認する。待ち時間の推定材料も毎回新しく取る。`,
`0. 【施設辞書の確認】最初に getFacilityDictionary アクション（park="${c.park}"）を呼び、このパークの施設辞書を読む。各エントリには静的属性（area、officialUrl、durationMin、lat/lng、hasImage）と鮮度フラグが付いている。レストランのエントリには restaurantFact（その施設の現在のファクト：serviceType＝公式ページのサービスタイプ、reservationType＝予約形態：required（予約必須）／ps（プライオリティ・シーティング対象）／none（予約なし）／unknown（未確認）、mobileOrder＝モバイルオーダー：available（対象）／not_available（対象外）／unknown（未確認）。null は有効なファクトが未登録の状態）も付いている。レストランの分類の根拠はこのファクトだけであり、エントリの reservationType／mobileOrder の値（旧来の辞書の列）は分類には一切使わないこと。coordsUsable=true の座標は無期限で有効なので再照会禁止。staticFresh=true のエリア・公式URL・公式所要時間はそのまま使う。imageFresh=true の施設は写真が辞書にあるので imageUrl を調べ直さない。取得が必要なのは、辞書に無い施設と、期限切れ（staticFresh=false）の属性だけ。種として登録された行は静的属性が空（static_fetched_at が null）であり、初回生成では全件が取得対象である。初回生成では、採用する施設について、手順2dの一括取得と saveFacilities での保存（officialUrl・durationMin・imageUrl を含む）を、起草の前に無条件で必ず行うこと（『必要になったら』ではない）。ただし restaurantFact が null のレストランは、他の静的属性が新鮮でも、ファクトの登録（手順2d）だけは必要になる。`,
`1. 公式サイト（${officialTop} を起点に、アトラクション一覧、レストラン一覧、エンターテイメント（ショー/パレード）のページ、対象日のパークカレンダー/休止情報ページ）を実際に開いて読む。営業時間、休止施設、ショー・パレードの開催時刻、ディズニー・プレミアアクセス/プライオリティパス/スタンバイパスの対象施設とルール、チケット制度も、記憶ではなく公式ページの記載で確認すること。【日付層は毎回必須】このうち営業時間・休止・ショー/パレード時刻は対象日で変わる「日付層」の情報で、辞書では代替できない。毎回この手順で確認すること（辞書で足りるのは静的属性だけ）。ただし確認のための取得は手順1aの取得計画（立案）に従うこと：再利用と判定された行は取り直さず、そのスナップショットで確認したものとする。`,
`1a. 【検証用データの取得（必須・この回の取得データで検証する）】完成したプランは、保存の直前に「この回に取得した公式データ」と突き合わせて検証される（手順2e）。その材料として、この回に必ず次を取得しておくこと。(i) 【正規化ソース層（必須・この順序を厳守）】${CANONICAL_FETCH_STEPS}${acquisitionPlanSteps(c.park, c.visitDate)}正典ソース集合のうち、取得計画で fetch と判定されたノードを取得し、読む前に saveSourceSnapshots アクションで生テキストのまま保存すること（batchId はこの回の取得を識別する任意の文字列。種別は dpa_page＝DPA案内ページ／facility_list＝施設全一覧（アトラクション＋エンターテイメント）／operations＝対象日の営業時間・休止情報／show_schedule＝公演スケジュール／ticket_prices＝チケット価格／announcements＝告知・ニュース一覧／monthly_calendar＝月間カレンダー／restaurant_list＝レストラン一覧。対象日を持つものは targetDate に対象日を入れる）。次に、保存したスナップショットと再利用行の指定スナップショットを読んで正規化ファクトを構築し、saveNormalizedFacts アクションで登録すること。手順は：(a) facility_list スナップショットから母集合（そのパークの全施設名）を読み取る（施設辞書の蓄積分を母集合にしてはいけない）。この構築でファクトを作るのは、母集合に含まれる施設だけである。DPAページに載っていても母集合に無いもの（ショー等）は、この構築では抽出しない（別のページ・別の構築の対象である）。(b) 母集合の全施設について、DPA状態（対象 eligible／対象外 not_eligible／不明 unknown）、単価（対象時のみ）、適用期間（開始日／終了日。行に付いた「対象期間：2026年11月30日（月）～」のような表記も期間として読み取る）を、根拠スナップショットからの逐語抜粋とともにファクトにする。抜粋は保存したスナップショットの生テキストから一字も変えずに切り取ること（サーバーが逐語一致を機械照合し、単価・期間の日付は抜粋の中に表記が含まれていなければ登録を拒否する）。対象外の根拠は、DPAページに載っていないこと自体は抜粋で示せないので、evidenceKind="universe_listing" として施設全一覧側の「その施設名を含む抜粋」でよい。(c) 判定できない施設は黙って省かず、unknown＋理由で必ず埋める。登録結果に missing（ファクトの無い母集合施設）が返ったら、その施設を unknown＋理由で埋めて再登録し、missing が空＝完全なビルドになるまで繰り返すこと。保存時のDPA照合は、この完全なビルドのファクトだけを根拠に行われる（スナップショット本文からの場当たり的な抽出は一切使われない）。DPAの公式ページ自体が取得できない場合はファクトが作れないので、DPA前提の行は作らないこと（スタンバイで組む）。検証できないDPAを前提にしたプランは保存できない。(ii) 対象日の休止施設の一覧（パークカレンダー/休止情報ページで確認したもの）を控える（operations スナップショットとしても保存すること）。(iii) プランに使うショー/パレードの公式公演時刻（対象日の開催時刻）を控える。これらは記憶で代替してはいけない。取得できなかったものがある場合は、その項目は「未確認」として扱う（手順2e・手順4参照）。`,
`1b. 【待ち時間の推定材料】待ち時間の公式データは存在しないため、次の「待ち時間参考サイト」（第三者が公式の表示待ち時間を記録・集計した民間の実績データ）を実際に開いて読み、候補施設の典型的な待ち水準（平均・最大・平日/休日の目安など）を推定の材料にすること。これは公式情報ではない「推定の材料」であり、公式の確認事項と混同してはいけない。【取得はサイトごとに段階制】各サイトには前回の取得方法が記録されている（下記リスト参照）。記録が「ブラウザ表示で取得できた」サイトは最初からブラウザ表示で開くこと。記録が「静的取得で取得できた」または未記録のサイトは、まずスクリプトによる静的取得（一括取得スクリプトに相乗りさせてよい）で試み、集計データが読めなければブラウザ表示に切り替える。どちらの方法でも取れなかったサイトは、そのサイトなしで推定し、notes に「◯◯は取得できなかったため材料に使えなかった」と明記すること（1サイトの失敗で生成全体を止めない）。実際にどの方法で取れたか（または取れなかったか）は、手順4の waitSourceFetchResults で全サイト分を報告すること（次回の取得方法の記録になる）。待ち時間の読みに使うときは、人気の序列だけでなく、定員・回転の速さ・DPA対象かどうかといった供給側の条件も踏まえ、甘い読み（例: 人気エリアの小型ライドを「待ちが短い」と即断する）にならないよう注意すること。参考サイトが開けない、またはその施設のデータが無い場合は、その旨を前提として読みの幅を広げること。候補にするアトラクションについては、必ず具体的な推定待ち時間（分）を1つ決めること（手順4の estWaitMin）。材料が取れた施設はその集計（平均や曜日・時間帯の傾向）から、取れなかった施設は人気・定員・回転の条件から幅を持って見積もる。待ち時間がほぼ無いと判断できる場合も、推定は「0分」として必ず出すこと（省略は禁止）。`,
waitRefLines,
heldCrowd
? `1c. 【混雑予想（この日付は決定済み・再利用が必須）】混雑予想は日付（パーク＋来園日）ごとに1回だけ決めるものである。対象日（${c.visitDate ?? "対象日"}）については、既にセット「${heldCrowd.title}」で混雑予想が決定され、保持されている：段階${heldCrowd.level}／5、根拠「${heldCrowd.basis ?? "（根拠の記録なし）"}」。この回は再評価を一切してはならない。その段階をそのまま crowdLevel=${heldCrowd.level} とし、crowdBasis には保持済みの根拠に「先に決定済みの予想を再利用した」旨が辿れる一文を添えて、手順4で savePlanSet に渡すこと。シナリオ分けと混雑係数も、この保持済み段階を土台に組み立てること（自分の評価で段階を置き換えると、その日のプラン全体の前提が生成ごとに揺れてしまう）。`
: `1c. 【混雑予想の評価（必須）】対象日（${c.visitDate ?? "対象日"}）の予想混雑度を5段階（1＝空いている〜5＝激混み）で評価すること。混雑予想は日付（パーク＋来園日）ごとに1回だけ決めるもので、この回で決めた段階と根拠がその日付の前提として保持され、同じ日付の後の生成では再評価されず再利用される。だからこそ、この回の評価は次の【決定手順の優先順位（厳守）】で決めること。(1) 主軸：外部の混雑予想 — 手順1bの登録済み待ち時間参考サイトをはじめ、混雑予想を公開している情報源が対象日について出している予想（混雑カレンダーの段階・レベル表記など）を実際に開いて読み、5段階に換算したものを主軸とする。(2) 補助：季節統計（曜日・時期＝クリスマス時期、ゴールデンウィーク、夏休み、連休・振替休日等、開催中／開催予定のイベント、過去の同種の日の混雑傾向）と、対象日のチケット価格帯（変動価格制の価格帯は混雑度の目安になる）。補助材料は外部予想の裏付け・微調整にだけ使い、外部予想が取れているのに補助材料だけで段階を決め直してはいけない。過去の混雑データは、手順1bの参考サイトの曜日別・時期別の傾向から読み取ってよい。これはアプリ側の判断であり、利用者に尋ねたり選ばせたりするものではない。評価した段階は crowdLevel、根拠（なぜその段階なのか。主軸とした外部予想と、その段階換算が分かるように）は短い文章で crowdBasis として、手順4で savePlanSet に必ず渡すこと（セットの前提として保存され、画面とPDFに表示される）。調査しても判断材料が取れなかった場合は、無理に段階を付けず crowdLevel／crowdBasis ともに null とし、その旨を notes に書くこと（推測で前提を埋めない）。`,
`【3プランの混雑シナリオと推定待ち時間への混雑係数（必須）】3プランは、手順1cの混雑予想を土台に、混雑シナリオで分ける（プランごとの優先軸では分けない）。プランA＝激混み前提（予想より混む側：シナリオ段階は予想段階＋1、最大5。実効係数は上限寄りに見込む）、プランB＝やや混み前提（予想どおりの中心：シナリオ段階は予想段階そのもの）、プランC＝思ったより空いてる前提（予想より空く側：シナリオ段階は予想段階−1、最小1。実効係数は低めに見積もる）。各プランの各施設の estWaitMin は、手順1bの材料からの基礎推定に、そのプランのシナリオに応じた係数を掛けて四捨五入した値にすること。段階ごとの係数は「上限」であり、最も混雑の影響を受ける人気アトラクション（ソアリン、アナと雪の女王級）にだけ上限そのものを見込む：段階1→上限×0.8、段階2→×0.9、段階3→×1.0、段階4→×2.0、段階5→×5.0（段階5の根拠：2026年1月6日（火）にソアリンで340分待ちの実績があり、基礎推定の5倍に達しうる）。それ以外の施設には、人気・定員・回転の速さ（需要×供給の考え方）に沿って、そのプランのシナリオ上限以下の実効係数を施設ごとに見積もって掛けること（例：段階5でも回転が速く影響を受けにくい施設なら×1.5程度）。DPA等のパス利用時の待ちにも、その施設の実効係数を同じ考え方で適用すること。実際に掛けた実効係数は、プランごとに施設別で crowdWaitFactors（[{slot: "A"|"B"|"C", name: 施設名, factor: 実効係数}]）として savePlanSet に必ず渡すこと（検証の記録にプラン別に残り、前提表示と合わせて後から追えるようにするため——上限だけが残って、実際に掛けた値が辿れない状態は不可）。手順1cで混雑予想が判断できなかった場合（crowdLevel が null の場合）は、シナリオ分けも係数も使わず、基礎推定のまま3プランを作り、crowdWaitFactors は空にすること。`,
`【移動時間の計算（保存時にサーバーが機械計算する・厳守）】各区間の移動時間は、あなたが見積もるものではない。保存時にサーバーが、連続する2項目の座標（引き継ぎ／施設辞書／あなたが items に入れた座標）間の直線距離から、条件の歩く速さ「${WALKING_SPEED_LABELS[c.walkingSpeed]}」で機械計算し、各項目に travel_min として保存する（画面とPDFに「移動 約◯分」と表示される）。計算式: 直線距離÷歩行速度（ゆっくり55／少しゆっくり70／少し急いで85／急いで100 m/分）×迂回乗率（〜100m ×1.1／100〜300m ×1.2／300〜600m ×1.25／600m〜 ×1.3）。エリアの異なる区間は、下記のエリア間マトリクス（少しゆっくり基準の典型分数を歩く速さで換算したもの）が登録されていれば、距離ベースとマトリクスの大きい方を取る（どちらも「最低でもこれだけかかる」下限だから）。その上で常に×1.2の余裕を掛け、1分単位で切り上げ、最小5分とする。保存時の検証では、間隔が「推定待ち時間＋体験時間（公式所要時間）＋travel_min」以上でなければ保存を拒否される。移動時間や余裕を自分で見積もって間隔を詰めてはいけない——travel_min 自体に余裕が含まれているので、開始時刻の間隔はこの式で決まる下限を前提に組むこと。`,
areaMatrixLines,
`・プランで使うエリアペアがマトリクスに無い場合は、保存の前に、ウェブのガイド情報等でそのペアの典型的な徒歩時間を実際に調べて、saveAreaTravelTimes アクション（entries: [{park: "${c.park}", areaA, areaB, minutes（少しゆっくり＝70m/分で歩く前提の典型分数）, sourceTitle, sourceUrl, fetchedAt（今日の日付 ${today}）}]）で登録すること。出典の無い分数や記憶で作った分数は登録してはいけない。調べても分からないペアは登録しない（その区間は距離ベースのみで計算される）。`,
`・移動（move）の項目には、移動先の施設・エリアの座標を lat/lng に入れること（移動時間の計算に使う）。座標が引けない施設が絡む区間は移動時間が「未確認」となり、その区間の検証は従来の下限（推定待ち＋10分）で行われ、検証の記録に未確認と残る。未確認を減らすため、施設項目の座標は手順3のとおり必ず解決を試みること。`,
SCOPE_BOUNDARY_STEP,
`1d. 【無理ゲート（起草前の入口判定・必須）】手順1〜1cで材料（公式施設一覧・対象日の運営／休止情報・公演時刻・正規化ファクト・混雑予想）が揃った時点で、プランの起草（手順2）に入る前に、条件の要求が次の固定された無理パターンに当たるかどうかだけを判定すること。(1) 存在しない：必須と明示された施設・ショーが、対象パークの施設一覧に無い、または対象日に休止・公演なしであることが日付層で確定している（確認できないものは「存在しない」と断定しない。未確認はパターンに当たらない）。(2) 時間の明らかな無理：必須項目を最も緩い前提（一番空いた側の混雑前提＝プランC側のシナリオ、待ちの下限側、DPAは規則の範囲で最大限に使う等、トレードオフを利用者に有利な側へ全部倒す）で粗く合計しても、入園〜退園・営業時間の枠に収まらない。(3) 予算の明らかな無理：最小の支出（対象日のチケット代＋必須と明示された有料項目の費用の下限）でも予算を超える。(4) 矛盾した要求：要求同士が直接両立しない（同時刻に2か所、等）。判定は常に楽観側に倒すこと：トレードオフで救済できる要求（DPAを減らせば予算内に収まる、順序を変えれば両立する、待ち次第で収まる等）は絶対に弾かない。境界に近い場合は通常の生成に進める。パターンはこの固定リストに限る（自分で新しい種類の「無理」を作らない）。いずれかに当たれば、起草に入らず、骨組みも保存せず、reportImpossibleRequest アクション（planSetId=${planSetId}、findings: [{category: "nonexistent"|"time"|"budget"|"contradiction", reason: 「分類の言葉＋具体名（施設名・衝突している要求・金額・時刻）＋客観的事実の指摘」までの1〜2文。アバウトでよい。明確な矛盾は客観的事実そのものを述べてよい（例：同じ時刻に2か所にはいられない）。具体的な改善案・処方箋は、約束の形（「○○を外せば作れます」等の反実仮想）でも提案の形（「どちらか一方を〜するなど」「〜に変更すれば」「〜を別の時間に」等）でも書かない（具体案の成立は検証できず保証がないため）}]）を呼んで終了すること（savePlanSet も reportPlanFailure も呼ばない）。当たらなければ通常どおり起草に進むこと（この判定自体は利用者に見せない）。`,
`2. 読んだ公式情報だけを根拠に、プランA・B・Cを作る。3プランを分ける軸は、上の【3プランの混雑シナリオ】のとおり混雑シナリオだけである（A＝激混み前提、B＝やや混み前提、C＝思ったより空いてる前提）。シナリオは待ち時間の前提（係数）と、それに伴う組み方の余裕の取り方に効かせること（例：激混み前提のAは本命を早めに押さえ、間隔に余裕を持たせる。空いてる前提のCは詰め込みすぎない範囲で候補を広げてよい）。「重視する点」（単一の入力）は3プラン全てに共通して反映すること（プランごとに変えない）。入園〜退園の時間枠の中で、時刻つきのタイムライン（移動・食事・休憩を含む現実的な順序）にする。対象日に休止中の施設は入れない。ショー/パレードは公式の開催時刻に合わせる（公式の公演時刻が未発表・未定で存在しない期間については、手順2fの未確定要素の作法——行に理由と説明を付ける——でのみ入れてよい）。各プランの概算費用は、パークチケット代を含む1日分の総額（円）として出し、内訳も項目別に出すこと：チケット代、ディズニー・プレミアアクセス等の有料パス代、食事代の目安、お土産代の目安など、実際にそのプランでかかる項目だけを挙げ、内訳の合計が総額と一致するようにする。予算が入力されていれば、総額が予算感に収まるよう配慮する。【プランの最低内容（クラス11・厳守）】各プランには、内容を表すタイトル（「A」「B」のようなスロット文字だけの仮タイトルは不可）と、空でない要約、計算された費用合計と金額入りの内訳を必ず入れ、スケジュールにはアトラクション／ショーの実項目を少なくとも1つ含めること（入園・退園などのマーカー行だけの骨組みは不可）。アトラクション行とショー行には推定待ち時間（estWaitMin）を必ず入れること（0分でも入れる）。これらを欠く提出はクラス11（プランの最低内容不足）として保存を拒否され、セット自体が失敗として記録されて完了にはならない。【実質の床（厳守）】クラス11には実質の床もある：(f) 各プランの実項目（アトラクション＋ショー＋食事の行の合計）が6行以上あること（入園・退園・移動・休憩・購入イベントの行は実項目に数えない）。(g) 各プランの費用合計が、公式チケット単価（対象日の1デーパスポート単価。大人・子どもで異なる場合はそれぞれの実単価）×人数の合計（チケット代の床）を下回らないこと — 単価の根拠は手順4の ticketPrices で提出し、サーバーが保存済みのチケット価格スナップショットと機械照合する（内訳のチケット行の自己申告額は床の根拠にならない）。(h) 要約は実質のある文章にすること（1文字だけ・定型文のみ・空白を除き10文字未満は不可）。(i) タイトルに「テスト」「test」「仮置き」「ダミー」「サンプル」等のテスト／仮置きパターンを含めないこと。`,
`2a2. 【融合の原則（要求同士が競合する場合の調整・必須）】条件の要求（「重視する点」の記述を含む）が全ては両立しない場合、固定の「落とす順序」は使わないこと。要求の強さを、その言われ方から読んで調整すること：「絶対」「必ず」等の明示、繰り返しの言及、順序の指定、具体的な詳細（時刻・場所・回数）の指定がある要求は強く、一度だけ軽く触れられた希望は弱い。調整の形は、その利用者自身が自分の価値観に沿って調整するならそうするだろう形に寄せること（人間のプランナーの調整をトレースする）。【犠牲の見える化】融合の結果、取り込めなかった要求（落とした施設・希望・条件）は、黙って落とさず、理由つきで各プランの summary（プランの説明）または notes に列挙すること（何と引き換えに何を守ったかが、後から条件文面と突き合わせて検査できるように）。【両立不能が明確になった場合】起草を進めるうちに、どう調整しても要求が両立しないことが明確になった場合は、骨組みや仮の内容を完成として保存せず、reportImpossibleRequest（planSetId=${planSetId}、findings に分類と具体名つきの理由。理由は客観的事実の指摘までとし、具体的な改善案・処方箋は約束形・提案形のいずれでも書かない）で報告して終了すること（クラス11の実質の床は、生成側が正直に降りなかった場合の機械的な最後の砦として併存する）。`,
`2a3. 【DPA購入の並びの原則（人気順・必須）】DPAの購入時刻は、その回に自分が見積もる人気度で割り当てること。ここで人気度とは、その施設の推定待ち時間の大きさ（需要÷処理能力の表れ）であり、パス利用時の短い待ちではなく、スタンバイで並んだ場合の推定待ち時間で判断する。推定待ち時間が大きい施設のDPA購入ほど早い時刻に置き、最も推定待ち時間が大きい施設の購入は入園直後（入園時刻に置ける最初の購入イベント）に置くこと。購入が複数ある場合は、推定待ち時間の大きい順に、公式の60分ルールで成立する最も早い枠から順に割り当てること（購入イベント行と dpaPurchaseTime の両方に、この並びを反映すること）。これは購入の「並び」を決める原則であり、保存の可否とは無関係である（この原則に沿わない並びは、保存拒否の理由にはならない）。また、この原則を理由に、DPA前提で組んだ項目をスタンバイ前提に変えてはいけない——買うか待つかの組み方は条件と「重視する点」で決めるもので、この原則は購入時刻の並びだけに作用する。`,
...(dayOf
? []
: [
`2a4. 【「最初の10分」行（表示専用・各プラン必須）】各プラン（A/B/C）のタイムラインには、入園行（先頭の入園マーカー行）の直後、購入イベント行より前に、表示専用の行を1つだけ入れること（入園行を置かないプランではタイムラインの先頭に入れる）。行の形：kind は "first10"、name は「入園後の最初の10分」、timeLabel は入園時刻（入園行と同じ時刻）とし、area／passType／dpaPurchaseTime／unitPriceJpy／estWaitMin／lat／lng／imageUrl／referenceUrl／officialUrl／unconfirmedReason／unconfirmedNote は全て null。note には、入園直後にやることを1行に1つずつ「・」で始めて列挙し、その直後に案内文を1行入れること（改行で区切る）。中身は、そのプラン自身の内容から次の決め方で作ること。(1) 抽選の項目：そのプランに含まれるショーのうち、手順1aで取得・保存した公式ショースケジュール（show_schedule スナップショット）の原文に「エントリー受付対象」の表記があるものについて、「・{ショーの公式名}の抽選をする」を1行ずつ（プラン内の登場順）。抽選対象かどうかは、その原文の表記だけで判断すること（推測で対象を作らない。原文に表記の無いショーは入れない）。(2) DPA購入の項目：手順2a3の人気順（推定待ち時間の降順）で入園直後（入園時刻と同時の最初の購入枠）に置かれた購入イベント1件だけについて、「・{施設の公式名}のDPAを買う」を1行。60分ルールで後ろに直列化された2件目以降の購入は入れない。並び順は、抽選の項目を先に、DPA購入の項目を後にすること（抽選とDPAの両方があるショーでは「まず抽選、外れたらDPA」が確定順序のため。同じショーが両方に当たる場合は、そのショーの抽選の行→そのショーのDPA購入の行の順に並ぶ形になる）。(3) 案内文：リストの直後に、次の文を一字も変えずにそのまま1行で入れること：「${FIRST10_GUIDANCE}」。【省略の条件】そのプランに、入園直後のDPA購入も抽選対象ショーも無い場合は、この行自体を入れない（空の行・案内文だけの行は作らない）。【この行の性質】この行は表示専用である：施設ではないので座標・写真・公式URLは付けず、費用・待ち時間・移動時間の計算にも一切関与しない（保存時にサーバーが移動計算を素通しするので、この行の前後で時刻の間隔を空ける必要はない。他の行の時刻は、この行が無い場合と全く同じに組むこと）。ショー行自体の扱い（当選前提の備考など）は従来どおりとし、この行のために変えないこと。`,
]),
`2b. 【スケジュールの時刻計算（最重要・厳守）】各項目の開始時刻は、その項目の「推定待ち時間＋体験時間（公式の所要時間）＋次の場所への移動時間（travel_min。上記の【移動時間の計算】の式でサーバーが決める値で、余裕はその中に含まれる）」が、次の項目の開始時刻までに収まるように決めること。travel_min は上記の式で自分でも概算できるので、その概算を下回る間隔は絶対に組まないこと。常に少し余裕を持たせる（詰め込みすぎない）。特にアトラクションは、開始時刻に列へ並び始めてから、待ち→体験→移動を経て次へ着く、という実時間で計算する。禁止例: 11:20開始のアトラクション（推定待ち40分）の次を12:00にする——待ち40分だけで12:00になり、体験時間も移動時間も存在しない。このような「推定待ち時間と矛盾するスケジュール」は絶対に作らない。保存する前に、全プランの隣り合う全ペアについて「次の開始時刻 − この開始時刻 ≧ 推定待ち時間＋体験時間＋travel_min（上記の式で概算したもの）」を検算し、満たさないペアがあれば時刻を直してから保存すること。ディズニー・プレミアアクセス等のパスを使う項目は、パス利用時の待ち（短い方）で見積もってよいが、その場合は passType にパス名を必ず入れること。`,
`2c. 【プラン別の進捗報告（必須）】プランは必ずA→B→Cの順に1つずつ作ること。各プランの作成を実際に始める前に、進捗報告アクション（updatePlanProgress、planSetId=${planSetId}、slot=そのプランのスロット、status="generating"）を呼ぶこと。これにより画面に「プランA：作成中／プランB：待機／プランC：待機」のように、実態どおりのプラン別進捗が表示される。3プランそろってから最後に savePlanSet でまとめて保存する（保存されたプランは自動的に「完了」になる）。自分から「完了」を報告してはいけない——完了は実際に保存されたプランにだけ付く。`,
`2d. 【不足分の一括取得（必須・このタスク専用スクリプト）】初回生成（辞書の行が種の状態＝static_fetched_at が null のとき）は、採用する全施設の公式詳細ページを一括取得スクリプトで取得し、saveFacilities で保存すること（必須・起草の前に行う）。それ以外の場合も、辞書で足りない静的属性（辞書に無い候補施設の座標・公式URL・エリア・公式所要時間・写真URL、期限切れ属性の取り直し）が必要になったら、同様に一括取得すること。その回専用の一括取得スクリプトを作成し、1回の実行でまとめて取得すること（何が要るかは依頼ごとに違うので、スクリプトは使い捨てでよい）。スクリプトには、公式一覧/詳細ページの静的フェッチと、不足座標の Nominatim 照会をまとめて含めること。Nominatim への照会は礼儀として1件ごとに1秒以上の間隔を空けること。ページを1枚ずつ自分のターンで開いていく方式は、まとめて取れるものについては禁止する（日付層の確認や、静的取得で取れなかったページのブラウザ表示による補完は除く）。取得できたら saveFacilities アクション（park="${c.park}"）で辞書に保存し、以降の計画作成は保存済みデータから行うこと。静的フェッチで取れなかった公式ページだけ、ブラウザ表示で開いて補ってよい。【レストランのファクト登録（必須）】プランに使うレストランについては、その施設自身の公式レストラン詳細ページから、根拠つきのファクトをレストラン事実レイヤーに登録すること（分類を施設辞書の列に書く方式は廃止した。行の表示はファクトから導出され、プランの行データに分類は入れない）。手順は DPA と同じ規律で：(i) まず保管庫の束（getStorehouseRestaurants）にその店があれば、その本文を saveSourceSnapshots（kind="restaurant_detail"、park="${c.park}"、fetchMethod="storehouse"、sourceFetchedAt＝束のその項目の fetchedAt、completeness は下記と同じ）で保存し、それを根拠にすること。束に無い店だけ、詳細ページを実ブラウザで開き、読む前に saveSourceSnapshots（kind="restaurant_detail"、park="${c.park}"、fetchMethod は実際の取得方法、completeness は {expectationSource: "none", expectation: "レストラン詳細ページには件数宣言が無いため完全性の期待値は導けない", result: "not_derivable"}）で全文を保存する。(ii) 保存した本文を読んで、saveRestaurantFacts（park="${c.park}"）で {name（公式の施設名）, serviceType（ページのサービスタイプの表記そのまま。無ければ null）, snapshotId, reservation, mobileOrder} を登録する。reservation は {type: "required"（予約必須）／"ps"（プライオリティ・シーティング対象）／"none"（予約の経路なし）／"unknown"（未確認）, evidenceKind, evidence（保存した本文からの逐語抜粋）, unknownReason（unknown のとき必須）}、mobileOrder は {type: "available"（モバイルオーダー対象）／"not_available"（対象外）／"unknown", 同じ形}。肯定分類（required／ps／available）は、分類を裏づける表記を含む抜粋（evidenceKind="excerpt"）でなければ登録できない。否定分類（none／not_available）は原則として不在の根拠（evidenceKind="absence"、evidence は施設名を含む一節）で登録する——詳細ページ全文に予約・モバイルオーダーの存在マーカーが無いことを、サーバーが機械確認する（モバイルオーダーの対象外がページに明記されている場合だけ、その表記を含む抜粋でもよい）。公式の記述から読み取れない項目は "none"／"not_available" に倒さず、必ず "unknown"＋理由で登録すること。分類をラベルや印象から推測で作ってはいけない（例：「ショーレストランだから予約必須」「カウンター式だからモバイルオーダー対象だろう」は禁止——ショーダイニングエリアだけが予約必須で、本体のレストランは予約なし・モバイルオーダー対象、という二重構造の店が実在する）。公式一覧で別エントリとして載っている施設（本体とショーダイニングエリア等）は混ぜずに別々のファクトとし、それぞれ自身の詳細ページを根拠に登録すること。getFacilityDictionary の restaurantFact に有効なファクト（登録から180日以内）がある施設は再利用し、詳細ページの再取得・再登録はしないこと。`,
`2e. 【検証プロセス（保存直前・必須）】3プランが完成したら、savePlanSet を呼ぶ前に、手順1aでこの回に取得した公式データと完成した行を突き合わせて、次の全てを自分で照合すること。savePlanSet 側でも同じ照合が機械的に行われ、通らないプランは保存を拒否される（拒否されたら指摘を直してもう一度呼ぶこと。失敗報告はしない）。(1) DPA対象可否：passType がディズニー・プレミアアクセスの全行が、手順1aで登録した正規化ファクト（完全なビルド）で「対象（eligible）」と記録された施設でなければならない。サーバーはそのファクトだけを根拠に照合するので、対象外（not_eligible）や不明（unknown）の施設へのDPA設定は絶対に置かない。加えて、ファクトに適用期間（開始日／終了日）が記録された施設については、サーバーは来園日時点で有効な対象かどうかも照合する。適用開始日が来園日より後の施設（将来の対象拡大で追加される施設など）や、適用終了日を過ぎた施設には、その来園日にはDPA前提を付けないこと（スタンバイで組む）。どうしても入れたい施設が対象外なら、DPA前提をやめてスタンバイの推定待ち時間で組み直すか、理由を notes に書いて外す。(2) DPA単価（購入した時に計上）：DPA費用は「購入した時」にだけ計上する。DPAを買う購入ごとに購入イベント行（kind: "purchase"）を1行入れ、その行にファクト単価（1名分）を unitPriceJpy として持たせ、さらに purchaseCount として「そのプランでその施設を実際に利用する人数」を必ず持たせること（アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数。参加者全員が買う前提で総数を入れてはいけない）。費用内訳のDPA金額は、購入イベント行ごとにファクト単価×対象人数（purchaseCount）を1回ずつ合計した額でなければならない——サーバーも購入インスタンス（施設×購入イベント）単位でファクト単価×対象人数から再計算するので、使用行（アトラクション／ショー行）でも計上して二重に数えたり、自分の書き起こしや記憶の単価（古い料金）で計算すると拒否される（クラス2：DPA費用の計上不一致）。対象人数が無い購入イベント行、対象人数が1未満または参加者総数（大人＋子ども）を超える購入イベント行もクラス2で拒否される。使用行には unitPriceJpy を入れないこと（入れてもサーバーは無視するが、形として入れない）。購入イベント行の単価がファクト単価と異なる場合もクラス2で拒否される。合計（estimatedCostJpy）も内訳の合計と一致させる。(3) 休止・営業時間・公演時刻：各行の施設が対象日の休止一覧に無いこと、各行の時刻が営業時間内であること（開始時刻だけでなく、公式所要時間が分かる行は終了時刻＝開始時刻＋所要時間も、退園時刻と閉園時刻の早い方を超えないこと。超える行はクラス4（営業時間外・終了側）で拒否される。所要時間が分からない行は終了側では判定されない。上限ちょうどに終わる行は範囲内）、ショー/パレードの開始時刻が対象日の公式公演時刻と一致すること。(4) DPA購入順序：公式ルール「次のDPAは、前のDPAの購入から60分後、または前のパスの利用開始時刻の早い方から購入できる」で購入列が成立すること。各DPA行には購入時刻を dpaPurchaseTime として必ず入れる（プラン内に購入時刻が明示される）。(5) 照合できなかった項目（ページ取得失敗など）は、黙って通さず verification.unverified に「◯◯：未確認（理由）」の形で入れること。未確認の項目は notes にも「未確認」と明示される。`,
`2f. 【未確定要素の扱い（必須）】その回の材料では公式に確認できなかった値を仮定として置く要素（未確定要素）は、理由を添えればプランに入れてよい（未確定であることだけを理由に一律に除外しなくてよい）。対象はショー時刻に限らず、未確定の要素全般である（例：公式スケジュールが未発表の期間のショー公演時刻、対象日の公演時刻が「未定」のショー行、取得できなかった施設の属性値）。ただし、未確定の要素を、印も理由もなく確定したもののように置くことは絶対に禁止する。入れる場合は、その項目に unconfirmedReason（短い理由。例「公式スケジュール未発表」「公演時刻未定」）と unconfirmedNote（なぜ未確定かの説明。分かる場合は公式の掲載予定時期も含める。例「公式のスケジュールがまだ出ていません。翌月分は前月8日ごろに掲載されます」）を必ず入れること（手順4）。画面ではその行に「未確定（理由）」の印が付き、PDFにも載る。検証の記録の未確認リストへの記載は、行に入れた理由・説明からアプリ側が自動で整合させて載せる（行側が正本）ので、verification.unverified に同じ未確定を重ねて書かないこと。【検証ゲートとの関係】公式公演時刻が存在しない（未発表・未定）場合に、未確定として明示したショー行は、公演時刻不一致（クラス5）では拒否されない。逆に、公式公演時刻が存在するのに別の時刻を置いた行は、未確定の印を付けてもクラス5で拒否される——未確定は不一致の言い訳にならない。公演時刻が存在するショーは、必ずその公式時刻に合わせること。`,
`3. 座標の解決は次の優先順位で行う。(a) 作り直しの引き継ぎ値、(b) 施設辞書（coordsUsable=true のもの）、(c) 手順2dの一括取得スクリプト内での Nominatim 照会。座標検索に使ってよいのは OpenStreetMap の Nominatim（nominatim.openstreetmap.org）だけとする。Overpass API をはじめ、他のジオコーダ・座標取得サービスへ無断で切り替えてはいけない。日本語名で見つからなければ、第10節の固定順序で再試行すること（そのままの形→検索範囲を対象パーク周辺に制限した再照会→機械的な表記ゆれ（記号の正規化・副題を落とした短縮形・英語名））。パーク名やエリア名を施設名に付け足した形は、どの段階でも照会に使ってはならない（再試行もスクリプト内でまとめて行う）。確信を持って引けた場合だけ座標を入れ、Nominatim で引けない項目は座標なし（null）にする。座標を推測で作らないこと。座標が引けなかった施設は、notes にその旨を明記すること（どの施設が座標なしになったか分かるように）。なお座標の最終結果は、保存時にサーバー側でも表記ゆれのバリエーションで Nominatim の再照会が行われて確定し、施設自体がどうしても引けない場合はエリアの代表地点の座標でピンが表示され、その旨が検証の記録に残る。例外として、エリアがパークワイドのショー（花火など）は、施設名で引けた地点がパーク外の橋の上など無関係な場所であることがあるため使われず、座標はサーバーがパークの代表地点（シーはメディテレーニアンハーバー、ランドはワールドバザール）に置き換える（ペイロードや辞書に何が入っていても置き換わる）。notes には照会を試みた事実だけを書き、「座標なしで確定」とは書かないこと。`,
`4. 結果を保存アクションに渡す。planSetId は ${planSetId}。factBuildId には、手順1aで登録した完全なファクトビルドの id を必ず入れること（factBuildId が無い／不完全なビルドでは、DPA前提の行は全て拒否される）。crowdLevel（手順1cの混雑予想の段階。判断できなかった場合は null）、crowdBasis（根拠の短い文章）、crowdWaitFactors（プランごとに施設別の実効係数の一覧：[{slot, name, factor}]）も必ず入れること。ticketPrices（費用の床の根拠：{adultJpy: 対象日の公式1デーパスポート大人単価, childJpy: 子ども単価（子どもがいない場合は null）, snapshotId: 手順1aで保存した ticket_prices スナップショットの id}）も必ず入れること — サーバーは申告単価をそのスナップショットの本文と機械照合し、内訳の自己申告額だけでは床を計算しない。各プランの混雑シナリオ（A＝激混み前提／B＝やや混み前提／C＝思ったより空いてる前提）とシナリオ段階は、slot と crowdLevel からアプリ側が自動で記録するので、渡す必要はない。plans は slot が A/B/C の3件で、各プランに estimatedCostJpy（チケット代を含む総額）と costBreakdown（内訳の配列：{label: 項目名（例「チケット」「DPA」「食事」「お土産」）, amountJpy: 金額, note: 補足、なければ null。DPAの行の note は、購入ごとに「単価×対象人数」が分かる表記で書くこと（例：「ソアリン 2,500円×2名、アナとエルサのフローズンジャーニー 2,000円×4名」のように、購入1件ごとに単価と対象人数を並べる。全員分でない購入があるのに「（4名分）」のような一括表記にしてはいけない）}。内訳の amountJpy の合計は estimatedCostJpy と一致させること）を入れる。【予算超過の開示（クラス13・必須）】各プランについて、費用合計（estimatedCostJpy）が条件の予算を超える場合は、予算超過を開示する文面をそのプランの budgetDisclosure として必ず渡し、同じ開示をそのプランの summary（プランの説明）にも含めること。開示のない予算超過はクラス13（予算対応の不一致）として保存を拒否される（予算超過そのものは、開示があれば通る）。予算内のプランでは budgetDisclosure は不要（null でよい）。各 items は回る順に sortOrder 0,1,2... とし、timeLabel（例 \"9:00\"）、name（公式の施設名。ただし手順2a4の「最初の10分」行だけは name「入園後の最初の10分」）、kind（attraction/show/parade/restaurant/break/move/other/purchase/first10）、area（公式のエリア名）、note（狙い目などの短いメモ。アトラクションについては公式の所要時間を「所要約◯分」の形で必ず含め、推定待ち時間とは分けて書くこと——待ち時間と体験時間を混同させる書き方は禁止）、passType（その項目で使う/狙うパスがあればその名称、なければ null）、dpaPurchaseTime（passType がディズニー・プレミアアクセスの項目には、そのパスを買う時刻を "9:05" の形で必ず入れること。手順2e(4)の購入列が成立する時刻にする。それ以外の項目は null）、unconfirmedReason／unconfirmedNote（手順2fの未確定要素を含む項目には、短い理由と説明を必ず入れる。それ以外の項目は null）【購入イベント行】DPAを使う項目については、その購入のタイミングに購入イベント行を別に1行入れること：kind は "purchase"、name は施設の公式名そのまま、timeLabel と dpaPurchaseTime に購入時刻、passType にパス名、unitPriceJpy にファクト単価（1名分）、purchaseCount に対象人数（そのプランでその施設を実際に利用する人数。アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数。必須：無い・1未満・参加者総数超はクラス2で拒否される）。座標（lat/lng）・estWaitMin・imageUrl は入れない（null）。使用行（実際に入るアトラクション／ショー行）には unitPriceJpy を入れない、estWaitMin（推定待ち時間＝分単位の整数。kind が attraction の項目には必ず入れること。0も有効な値で、省略・null は禁止。DPA等のパスで入る項目はパス利用時の待ちで見積もる。ショー/パレード等で待ちの推定がある項目にも入れてよい。それ以外の項目は null）。ただしレストラン行（kind=restaurant）には推定待ち時間（estWaitMin）を付けないこと（必ず null にする）。レストランの待ち時間はモデル化しない（レストランは事前に準備してある前提で組むため。付けてもサーバー側で保存時に null に落とされる）、lat/lng を含める。さらに、具体的な施設・アトラクション・ショー・レストランに対応する items には officialUrl として、その施設の公式詳細ページのURL（実際に開いたページのURLそのもの）を入れること（画面の各行から公式ページへリンクするために使う。詳細ページを開かなかった施設は null）。加えて imageUrl として、その施設の公式詳細ページに載っている代表写真（メインビジュアル）の画像URLを、実際に読んだページからそのまま入れること（保存時にアプリ側が画像本体を取得して保持する）。移動・休憩・入園など特定の施設でない項目や、公式ページで写真URLを確認できなかった項目は imageUrl を null にする。公式写真が確認できなかった施設については、Wikimedia Commons（commons.wikimedia.org）でその施設本人の写真が見つかれば、そのファイルページに表示される幅500px前後のサムネイル画像のURL（thumb.wikimedia.org のURL。原寸URLは使わない）を referenceUrl に入れてよい（アプリ側は公式写真が取得できない場合の参考画像として使う。見つからなければ null）。画像URLを推測で作らないこと。sources には実際に読んだ公式ページのタイトルとURLを入れる。estimateSources には、待ち時間の推定材料として実際に読んだ参考サイトについて {title: サイト名, url: URL, fetchedAt: 取得日（今日の日付 ${today}）} を入れること（公式の sources とは分けて記録する。読まなかった参考サイトは入れない）。notes には、休止情報や制度上の注意など計画の前提に加えて、待ち時間の推定についても箇条書きで書くこと：どの参考サイトを材料にしたか、取得日（今日は ${today}）、材料が取れなかった施設があればその旨、取得できなかった参考サイトがあればその旨。1項目につき1行、短い文で、行頭に「・」を付けない（画面側で箇条書きとして表示する）。長い文章を1つの段落に詰め込まないこと。parkHours には対象日の営業時間（公式表記）を入れる。【検証データ（必須）】verification として、手順1aでこの回に実際に取得したデータをそのまま入れること：{fetchedAt: 取得日（今日の日付 ${today}）, dpaSource: DPA案内ページの {title, url}（取得できなければ null）, calendarSource: 休止・営業時間を確認したページの {title, url}, entertainmentSource: 公演時刻を確認したページの {title, url}, dpaSnapshotText: 渡さなくてよい（DPAの照合は正規化ファクトだけで行われる。生テキストは手順1aで source_snapshots に保存済み）, closedFacilities: 対象日の休止施設名の配列, showTimes: [{name: ショー/パレード名, times: ["9:40", ...]（対象日の公式公演時刻）}] の配列, unverified: 照合できなかった項目の説明の配列（無ければ空配列）}。取得していないデータを推測で入れないこと（入れれば照合はその偽データで通ってしまう——それが一番悪い）。取得できなかったものは、該当欄を空/null にし、unverified に理由を入れること。【保存時の追加報告（必須）】metrics として {pagesOpened: このタスクで実際に開いた/取得したページの総数（スクリプトで取得したページも数える）, phases: [{name: フェーズ名（例: 辞書確認・一括取得・日付層の確認・待ち時間材料の取得・プラン作成・保存）, seconds: そのフェーズにかかった秒数}]} を入れ、waitSourceFetchResults として、登録されている参考サイト全件について {url, method: "script"（静的取得で取れた）|"browser"（ブラウザ表示で取れた）|"failed"（どちらでも取れなかった）} を入れること（次回の取得方法の記録になる）。【辞書で足りた施設について】辞書に写真がある施設（imageFresh=true）は、items の imageUrl/referenceUrl は null でよい（保存時に辞書の写真が使われる）。辞書・引き継ぎで得た座標・公式URL・エリアは、items にその値のまま入れること。`,
`5. 公式サイトが読めない等で計画が作れない場合は、失敗報告アクション（reportPlanFailure、planSetId=${planSetId}）で理由を伝えること。作れなかった計画をでっち上げないこと。ただし、savePlanSet が「推定待ち時間が不足」「スケジュールが推定待ち時間と矛盾」「移動時間（travel_min）に対して間隔が不足」といった検証エラーで保存を拒否した場合は、計画が作れなかったのではなく保存内容の問題なので、失敗報告はせず、指摘された項目の estWaitMin を補う／時刻を直して、savePlanSet をもう一度呼ぶこと。検証プロセス（手順2e）の拒否——ファクトで対象と記録されていない施設へのDPA設定、ファクトの単価と合わないDPA費用、休止施設の混入、営業時間外の時刻、公式公演時刻と合わないショー、60分ルールを満たさないDPA購入列、DPA購入時刻の未記入——も全て同じ扱いで、指摘された行を組み直す／単価と内訳を再計算する／購入時刻を直して、savePlanSet をもう一度呼ぶこと。検証を通らないプランを「完成」として報告してはいけない。また、起草の途中で要求同士がどう調整しても両立しないことが明確になった場合（手順1dの固定の無理パターンに当たる場合を含む）は、失敗報告ではなく reportImpossibleRequest（planSetId=${planSetId}、findings に分類と具体名つきの理由。理由は客観的事実の指摘までとし、具体的な改善案・処方箋は約束形・提案形のいずれでも書かない）で報告すること。それが無理な要求への正直な出口であり、骨組みや仮の内容を完成として保存することは絶対にしないこと。`,
].join("\n");
}

// Downloads one intro photo from a URL the retrieval agent actually read
// on the official site and stores the bytes as an owned blob under
// `${keyPrefix}/photo.<ext>`, returning the blob key. Any failure (bad
// URL, non-image, too large, network) returns null so the item simply
// renders without a photo — a photo URL is never trusted blindly and
// never rendered remotely.
async function storeItemImage(
ctx: Ctx,
keyPrefix: string,
imageUrl: string,
): Promise<string | null> {
let parsed: URL;
try {
parsed = new URL(imageUrl);
} catch {
return null;
}
if (parsed.protocol!== "https:" && parsed.protocol!== "http:") return null;
try {
const res = await fetch(parsed.toString(), {
signal: AbortSignal.timeout(20000),
// Wikimedia (the reference-photo fallback host) rejects requests
// without a descriptive User-Agent with a 403; the official image
// host accepts one too, so always send it.
headers: {
"User-Agent":
"MuseDisneyPlanner/1.0 (personal pre-trip planning; thumbnail fetch)",
},
});
if (!res.ok) return null;
const contentType = (res.headers.get("content-type")?? "")
.split(";")[0]
?.trim()
.toLowerCase();
const extByType: Record<string, string> = {
"image/jpeg": "jpg",
"image/png": "png",
"image/gif": "gif",
"image/webp": "webp",
};
const ext = contentType? extByType[contentType]: undefined;
if (!ext || !contentType) return null;
const bytes = new Uint8Array(await res.arrayBuffer());
if (bytes.length === 0 || bytes.length > 5_000_000) return null;
const key = `${keyPrefix}/photo.${ext}`;
await ctx.blobs.put(key, bytes, { contentType});
return key;
} catch {
return null;
}
}

// Tries the official photo first, then the reference (Wikimedia Commons)
// fallback, returning the stored blob key and which source produced it.
// In the production environment the official image host did not yield
// photos, so the fallback is what makes thumbnails appear at all there;
// where the official photo does download, it stays the first choice.
async function storeItemImageWithFallback(
ctx: Ctx,
keyPrefix: string,
officialUrl: string | null | undefined,
fallbackUrl: string | null | undefined,
): Promise<{ key: string; source: "official" | "reference"} | null> {
if (officialUrl) {
const key = await storeItemImage(ctx, keyPrefix, officialUrl);
if (key) return { key, source: "official"};
}
if (fallbackUrl) {
const key = await storeItemImage(ctx, keyPrefix, fallbackUrl);
if (key) return { key, source: "reference"};
}
return null;
}

function buildImageAssignment(
park: "land" | "sea",
planSetId: number,
items: { id: number; name: string; kind: string}[],
): string {
const officialTop =
park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
const list = items
.map((it) => `- itemId ${it.id}: ${it.name}（${it.kind}）`)
.join("\n");
return [
`次の施設それぞれについて、紹介写真のURLと、公式詳細ページへのリンク（そのページのURL）を確認するタスクです。対象パークは${parkName(park)}です。写真には2つの入手先があり、両方を調べてください（アプリ側で公式写真を優先して使い、取れなければ参考画像に切り替えます）。なお、施設辞書に新鮮な写真がある施設はこのリストに含まれていません（辞書分はアプリ側で適用済み）。ここに挙がっているのは、辞書でも足りなかった分だけです。`,
``,
list,
``,
`手順:`,
`1. 公式写真と公式リンク: 公式サイト（${officialTop} を起点に、アトラクション/レストラン/エンターテイメントの一覧から各施設の詳細ページへ）を実際に開いて読む。開いた詳細ページのURL自体を officialUrl とする（画面の各行から公式ページへリンクするために使う）。各詳細ページの代表写真は、ページ先頭に表示される最初の画像（「〜のイメージ1」と表示されるもの）で、その画像URLには "main_visual" が含まれる（例: https://media1.tokyodisneyresort.jp/images/adventure/attraction/71_main_visual_name_1.jpg?mod=... ）。ページに画像一覧が付記されている場合は、その先頭の main_visual のURLを imageUrl とする。`,
`2. 参考画像: Wikimedia Commons（commons.wikimedia.org）で各施設を検索し（英語名＋「Tokyo DisneySea」/「Tokyo Disneyland」で見つかりやすい。カテゴリページがある施設も多い）、その施設本人の写った写真のファイルページを開く。fallbackUrl には、ファイルページに表示される幅500px前後のサムネイル画像のURL（https://thumb.wikimedia.org/wikipedia/commons/thumb/... で始まるもの）を使うこと。元のファイル（upload.wikimedia.org の原寸URL）は数MBあり、取得に失敗しやすいので使わない。別の施設や無関係な写真は使わないこと。`,
`3. 結果を保存アクション（saveItemImages、planSetId=${planSetId}）に渡す。images は {itemId, imageUrl, fallbackUrl, officialUrl} の配列で、確認できなかった項目は null にする。写真が両方とも確認できなくても、公式詳細ページを開けた施設は officialUrl だけでも配列に入れること。一部の施設しか確認できなかった場合でも、確認できた分だけで必ず saveItemImages を呼ぶこと（部分的な結果でも保存する）。`,
`4. 公式サイトもWikimedia Commonsも読めない場合は、失敗報告アクション（reportItemImagesFailure、planSetId=${planSetId}）で理由を伝えること。どちらのアクションも呼ばずに終了しないこと。`,
`※ URLは実際に開いたページに表示されていたものだけを使うこと。URLを推測で作らないこと。`,
].join("\n");
}

// ---------- start-section sealing + serialization （記録V, 2026-11-15） ----------
//
// Incident: three different creation requests sent to the chat in
// parallel cross-wired — the 2027-01-23 request was bound to the
// 2027-01-02 conditions and the start reply repeated the wrong date.
// Causes: (1) chat-new condition extraction drew on the WHOLE shared
// conversation plus the shared form as one unbound source, never tied
// to the triggering message; (2) rebuilds / reschedules / partial
// replacements read the live shared form (only park/date overridden
// from the target set) instead of the target set's stored
// conditionsSnapshot; (3) the start section (save → read → inference
// → impossibility gate → bind/start) had no serialization at all.
//
// The countermeasures, applied at EVERY start entrance (all chat
// start branches, the プラン作成 tab button, 当日検索， partial
// replacement, and the DPA「買えなかった」button):
//
// SEAL: before any inference or gate judgement, each entrance builds
// ONE immutable conditions object that belongs to its trigger alone,
// and every later stage (gate, generation start, the start reply's
// repetition of the conditions) uses only that seal — shared
// conditions are never re-read inside a start.
// - chat new creation: the triggering message is passed to inference
//   as an independent input identified by id + text, and extraction
//   is limited to the window from the last generation start up to
//   the trigger (see sendMessage); the extracted values are frozen
//   into the seal.
// - rebuild / day-of reschedule / partial replacement (chat AND the
//   §14 button): conditions are parsed from the TARGET SET's stored
//   conditionsSnapshot (parseSnapshotConditions). Fields that cannot
//   be read from the snapshot are NEVER filled from the form; they
//   are reported honestly in the start reply instead.
// - form button: the saved conditions are read exactly once, AFTER
//   the serialization lock is acquired, and that read is the seal.
// - 当日検索： unchanged structure — the seal is built from the
//   request arguments alone.
// - DPA「買えなかった」: the seal is the target set's snapshot plus
//   the target purchase event's info plus the user's memo, all at
//   their button-press values; the shared form is not re-read.
//
// SERIALIZATION: the whole section — seal creation → start judgement
// → impossibility gate → binding (set creation / progress update,
// including title numbering and the partial replacement's
// already-running check) → generation task spawn → saving the start
// reply — runs under one in-server mutex (a promise chain), so two
// start sections never overlap. A start that had to WAIT for a
// previous start says so in its start reply, together with the
// conditions it actually uses (date / park / party) — a waited start
// is never announced as if it had started immediately.

let startSectionChain: Promise<void> = Promise.resolve();
let startSectionBusy = 0;

// Acquires the start-section mutex. `waited` is true when another
// start section was running (or queued) at entry, i.e. this start
// did not begin immediately. Callers must release exactly once
// (finally) — the section includes saving the start reply, so the
// release belongs after that save.
async function acquireStartSection(): Promise<{
  waited: boolean;
  release: () => void;
}> {
  const waited = startSectionBusy > 0;
  startSectionBusy += 1;
  const previous = startSectionChain;
  let releaseInner: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  startSectionChain = previous.then(() => mine);
  await previous;
  let released = false;
  return {
    waited,
    release: () => {
      if (released) return;
      released = true;
      startSectionBusy -= 1;
      releaseInner();
    },
  };
}

// The waited-start fact, stated at the head of a start reply. Empty
// when the start did not wait. Callers append the conditions summary
// separately (every start reply carries it, waited or not).
function waitedStartPrefix(waited: boolean): string {
  return waited ? "前の依頼の開始処理を待ってから開始しました。" : "";
}

// Parses a plan set's stored conditionsSnapshot back into a
// Conditions object — the ONLY source for a rebuild / reschedule /
// partial replacement's conditions （記録V: the live form is never
// consulted, not even to fill a gap). Fields the snapshot records as
// unset （未定/未入力/指定なし） read as null and are NOT "missing";
// `missing` lists the labels of fields whose snapshot line could not
// be read at all, so the start reply can state that honestly instead
// of silently substituting a form value. Where a field is unreadable,
// a neutral fallback is used (the set row's own park / visit date /
// walking-speed column — all part of the set's stored record, never
// the form — and, for the party, the set's same-day columns when
// present).
function parseSnapshotConditions(set: {
  park: "land" | "sea";
  visitDate: string | null;
  conditionsSnapshot: string | null;
  walkingSpeed: WalkingSpeed | null;
  setType?: string;
  sameDayAdults?: number | null;
  sameDayChildren?: number | null;
}): { conditions: Conditions; missing: string[] } {
  const missing: string[] = [];
  const snap = set.conditionsSnapshot;
  const speedByLabel = new Map<string, WalkingSpeed>(
    (Object.entries(WALKING_SPEED_LABELS) as [WalkingSpeed, string][]).map(
      ([k, v]) => [v, k],
    ),
  );
  const parseSpeed = (text: string | null): WalkingSpeed | null => {
    if (!text) return null;
    const m = /歩く速さ[:：]\s*(ゆっくり|少しゆっくり|少し急いで|急いで)/.exec(
      text,
    );
    return m ? (speedByLabel.get(m[1] ?? "") ?? null) : null;
  };
  if (!snap) {
    return {
      conditions: {
        park: set.park,
        visitDate: set.visitDate,
        entryTime: null,
        exitTime: null,
        budgetJpy: null,
        adults: set.sameDayAdults ?? 2,
        children: set.sameDayChildren ?? 0,
        childrenAges: null,
        stayHotel: null,
        priority: null,
        walkingSpeed: set.walkingSpeed ?? "slightly_slow",
      },
      missing: ["条件スナップショット自体"],
    };
  }
  if (snap.includes("当日検索")) {
    // Same-day snapshot format （当日検索の条件）: 現在地点/指定時刻/
    // 予算の上限/ご要望 lines instead of the standard ones. The
    // start time is the entry time; there is no recorded exit time
    // (closing time governed the run) — that reads as unset-by-design,
    // not missing, because the snapshot format itself has no such line.
    const startM = /指定時刻[:：]\s*(\d{1,2}:\d{2})/.exec(snap);
    const budgetM = /予算の上限[:：]\s*([\d,]+)円/.exec(snap);
    const party = parseSnapshotParty(snap);
    if (!party && set.sameDayAdults == null) missing.push("人数");
    const reqM = /ご要望[:：]\s*(.*)/.exec(snap);
    const reqText = (reqM?.[1] ?? "").trim();
    return {
      conditions: {
        park: set.park,
        visitDate: set.visitDate,
        entryTime: padTimeOfDay(startM ? (startM[1] ?? null) : null),
        exitTime: null,
        budgetJpy: budgetM
          ? Number((budgetM[1] ?? "0").replace(/,/g, ""))
          : null,
        adults: party?.adults ?? set.sameDayAdults ?? 2,
        children: party?.children ?? set.sameDayChildren ?? 0,
        childrenAges: null,
        stayHotel: null,
        priority:
          reqText && reqText !== "（入力なし）" ? reqText : null,
        walkingSpeed:
          parseSpeed(snap) ?? set.walkingSpeed ?? "slightly_slow",
      },
      missing,
    };
  }
  const dp = parseSnapshotDatePark(snap);
  if (!/パーク[:：]/.test(snap)) missing.push("パーク");
  if (!/日付[:：]/.test(snap)) missing.push("日付");
  const timeM = /入園〜退園[:：]\s*(\S+)\s*〜\s*(\S+)/.exec(snap);
  if (!timeM) missing.push("入園〜退園時刻");
  // Snapshot text carries the unpadded "9:00" form; a Conditions
  // object always carries the padded "HH:MM" form (see
  // padTimeOfDay), so every consumer downstream — the 条件 panel,
  // rebuild seals, and above all the 「条件を変えて再検索」 restore
  // into the form's time inputs — sees a displayable value.
  const timeOrNull = (v: string | undefined): string | null =>
    v && v !== "未定" ? padTimeOfDay(v) : null;
  const budgetM = /予算[:：]\s*([\d,]+)円/.exec(snap);
  if (!budgetM && !/予算[:：]\s*未定/.test(snap)) missing.push("予算");
  const party = parseSnapshotParty(snap);
  if (!party) missing.push("人数");
  const agesM = /人数[:：][^\n]*（([^）]+)）/.exec(snap);
  // 宿泊： snapshots written before the field's removal (2026-11-16)
  // carry the line and it is still read back; snapshots written
  // since have no such line BY DESIGN, so its absence is never
  // reported as missing.
  const hotelM = /^宿泊[:：]\s*(.*)$/m.exec(snap);
  const hotelText = (hotelM?.[1] ?? "").trim();
  // 重視する点： the unified field when present; legacy snapshots keep
  // their per-plan + common texts, transcribed with their labels so
  // nothing the user wrote is dropped by the model change.
  const pri = parseSnapshotPriorities(snap);
  let priority: string | null = pri.unified;
  if (priority == null && pri.model === "legacy") {
    const parts: string[] = [];
    if (pri.A) parts.push(`プランAの重視すること: ${pri.A}`);
    if (pri.B) parts.push(`プランBの重視すること: ${pri.B}`);
    if (pri.C) parts.push(`プランCの重視すること: ${pri.C}`);
    if (pri.common) parts.push(`共通して重視すること: ${pri.common}`);
    priority = parts.length > 0 ? parts.join("\n") : null;
    if (parts.length === 0 && !/重視すること[:：]/.test(snap)) {
      missing.push("重視する点");
    }
  }
  const speed = parseSpeed(snap);
  if (!speed && !set.walkingSpeed) missing.push("歩く速さ");
  return {
    conditions: {
      park: dp.park ?? set.park,
      visitDate: dp.visitDate ?? set.visitDate,
      entryTime: timeOrNull(timeM?.[1]),
      exitTime: timeOrNull(timeM?.[2]),
      budgetJpy: budgetM
        ? Number((budgetM[1] ?? "0").replace(/,/g, ""))
        : null,
      adults: party?.adults ?? set.sameDayAdults ?? 2,
      children: party?.children ?? set.sameDayChildren ?? 0,
      childrenAges: agesM ? (agesM[1] ?? null) : null,
      stayHotel:
        hotelText && hotelText !== "未入力" ? hotelText : null,
      priority,
      walkingSpeed: speed ?? set.walkingSpeed ?? "slightly_slow",
    },
    missing,
  };
}

// The honest note appended to a start reply when the target set's
// snapshot had fields that could not be read: those fields were
// treated as unset — never filled from the form. Empty when the
// snapshot read completely.
function snapshotMissingNote(missing: string[]): string {
  return missing.length > 0
    ? `なお、対象プランの保存済み条件から読み取れなかった項目（${missing.join("、")}）があり、その項目は未設定として扱いました（プラン作成タブの現在の値では補っていません）。`
    : "";
}

// ------------------------------------------------------- condition changes
//
// A chat judgement may carry structured condition changes (the
// conditionChanges field): the condition VALUES the user's
// instruction changes, with their new values. The server — never
// the model — applies them to the target set's saved conditions,
// and verifies twice that they landed: once on the sealed
// conditions before anything starts, and once on the created set's
// STORED conditions after the start. A mismatch on either check
// means NO start (the created set is removed again) and an honest
// chat notice; rebuilding silently on the original conditions is
// exactly the failure this machinery exists to prevent.

// Normalizes a raw judgement value: text is trimmed (empty reads as
// "no change"), times are padded to the "HH:MM" form, and a date or
// time that does not parse is dropped rather than applied blindly.
// Returns null when nothing actually changes.
function normalizeConditionChanges(
  raw: ConditionChanges | null,
): ConditionChanges | null {
  if (!raw) return null;
  const cleanText = (s: string | null): string | null => {
    const t = (s ?? "").trim();
    return t ? t : null;
  };
  const cleanDate = (s: string | null): string | null => {
    const t = cleanText(s);
    if (!t) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(t) &&
      !Number.isNaN(new Date(`${t}T00:00:00`).getTime())
      ? t
      : null;
  };
  const cleanTime = (s: string | null): string | null => {
    const t = cleanText(s);
    if (!t) return null;
    const p = padTimeOfDay(t);
    return p != null && /^\d{2}:\d{2}$/.test(p) ? p : null;
  };
  const out: ConditionChanges = {
    park: raw.park ?? null,
    visitDate: cleanDate(raw.visitDate),
    entryTime: cleanTime(raw.entryTime),
    exitTime: cleanTime(raw.exitTime),
    budgetJpy: raw.budgetJpy ?? null,
    adults: raw.adults ?? null,
    children: raw.children ?? null,
    childrenAges: cleanText(raw.childrenAges),
    priority: cleanText(raw.priority),
    walkingSpeed: raw.walkingSpeed ?? null,
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

// The target set's saved conditions with the judged changes applied
// — the conditions a rebuild on changed conditions actually runs
// with. Fields the judgement did not change keep the set's values.
function applyConditionChanges(
  base: Conditions,
  ch: ConditionChanges,
): Conditions {
  return Object.freeze({
    ...base,
    park: ch.park ?? base.park,
    visitDate: ch.visitDate ?? base.visitDate,
    entryTime: ch.entryTime ?? base.entryTime,
    exitTime: ch.exitTime ?? base.exitTime,
    budgetJpy: ch.budgetJpy ?? base.budgetJpy,
    adults: ch.adults ?? base.adults,
    children: ch.children ?? base.children,
    childrenAges: ch.childrenAges ?? base.childrenAges,
    priority: ch.priority ?? base.priority,
    walkingSpeed: ch.walkingSpeed ?? base.walkingSpeed,
  });
}

// The labels of the changed fields whose value in `conditions` does
// NOT equal the judged change — the server-side correspondence
// check between a judgement's changes and the conditions a run
// actually carries. Empty means every change is reflected.
function conditionChangeMismatches(
  conditions: Conditions,
  ch: ConditionChanges,
): string[] {
  const out: string[] = [];
  if (ch.park != null && conditions.park !== ch.park) out.push("パーク");
  if (ch.visitDate != null && conditions.visitDate !== ch.visitDate)
    out.push("日付");
  if (ch.entryTime != null && padTimeOfDay(conditions.entryTime) !== ch.entryTime)
    out.push("入園時刻");
  if (ch.exitTime != null && padTimeOfDay(conditions.exitTime) !== ch.exitTime)
    out.push("退園時刻");
  if (ch.budgetJpy != null && conditions.budgetJpy !== ch.budgetJpy)
    out.push("予算");
  if (ch.adults != null && conditions.adults !== ch.adults)
    out.push("大人の人数");
  if (ch.children != null && conditions.children !== ch.children)
    out.push("子どもの人数");
  if (ch.childrenAges != null) {
    const have = (conditions.childrenAges ?? "").trim();
    // Snapshot round-trip caveat: childrenAges is stored inside the
    // 人数 line's parentheses, so a value containing "）" reads back
    // truncated at that point; a read-back that is a prefix of the
    // judged value counts as reflected (the app's own seals read it
    // the same way).
    if (
      have === "" ||
      (have !== ch.childrenAges && !ch.childrenAges.startsWith(have))
    ) {
      out.push("子どもの年齢・身長");
    }
  }
  if (ch.priority != null && (conditions.priority ?? "").trim() !== ch.priority)
    out.push("重視する点");
  if (ch.walkingSpeed != null && conditions.walkingSpeed !== ch.walkingSpeed)
    out.push("歩く速さ");
  return out;
}

// The judged changes as plain labeled lines (used where the changes
// themselves are the input to another judgement, e.g. the
// wheelchair-participant check).
function conditionChangesToText(ch: ConditionChanges): string {
  const lines: string[] = [];
  if (ch.park != null) lines.push(`パーク: ${parkName(ch.park)}`);
  if (ch.visitDate != null) lines.push(`日付: ${ch.visitDate}`);
  if (ch.entryTime != null) lines.push(`入園時刻: ${ch.entryTime}`);
  if (ch.exitTime != null) lines.push(`退園時刻: ${ch.exitTime}`);
  if (ch.budgetJpy != null)
    lines.push(`予算: ${ch.budgetJpy.toLocaleString("ja-JP")}円`);
  if (ch.adults != null) lines.push(`大人の人数: ${ch.adults}人`);
  if (ch.children != null) lines.push(`子どもの人数: ${ch.children}人`);
  if (ch.childrenAges != null)
    lines.push(`子どもの年齢・身長: ${ch.childrenAges}`);
  if (ch.priority != null) lines.push(`重視する点: ${ch.priority}`);
  if (ch.walkingSpeed != null)
    lines.push(`歩く速さ: ${WALKING_SPEED_LABELS[ch.walkingSpeed]}`);
  return lines.join("\n");
}

// Chat-triggered plan generation: the START JUDGEMENT belongs to the
// chat AI, not to a phrase whitelist (user's explicit decision,
// 2026-11-12). Whether a chat message starts a creation / whole-set
// rebuild / partial replacement / day-of reschedule — and which of
// those it is — is judged by the AI from the conversation context
// and the open tab, under the principles in sendMessage's prompt:
// start when the user is, in context, asking for a plan to be made
// or changed (over-reading intent and starting is accepted — the
// user decided that trade-off explicitly, judging that intent ends
// up honored more often that way); do not start when only an
// answer, a fact-check, or the acknowledgement of a fact report is
// being asked for. A deterministic phrase gate stood here before
// (twice widened: long phrasings, then direct imperatives and the
// AI's own guided phrasing) and kept producing say/do mismatches —
// the AI guiding 「作り直して」 while the gate refused that very
// word — so the whitelist approach was retired by the user's call.
// What stays deterministic is everything AROUND the judgement:
// - the プラン作成 tab button always starts a fresh creation;
// - a start needs a visit date (form, or the target set itself);
// - which set a rebuild targets is resolved from the open tab /
//   latest finished set (the 規準 rule), never from phrasing;
// - partial-replacement targeting is validated against the
//   conversation (slot named, or selected in the open tab);
// - every acceptance / not-started reply is written from the
//   ACTUAL start result, never from the model's draft;
// - save-time verification of the produced rows is unchanged.

async function startGeneration(
ctx: Ctx,
cIn: Conditions,
// Non-null for a day-of reschedule started from chat: the user's own
// report of the day-of facts. Passed into the assignment so the task
// rebuilds the remainder of the day from the CURRENT published wait
// times instead of the reference sites' aggregate averages.
dayOf: { userReport: string} | null = null,
// Whether this run is a 作り直し， decided by the START ROUTE alone:
// the プラン作成 tab button passes false — a form start is a fresh
// creation by contract, even when a finished set for the same park
// and visit date already exists. A chat start passes true when the
// chat AI judged the request a rebuild or a day-of reschedule of
// the reference set (its generationKind — see sendMessage). When
// false, no previous set is looked up at all: rebuiltFromSetId
// stays null and no 作り直し framing reaches the assignment, the
// acceptance reply, or any status surface. (The facility dictionary
// still supplies coordinates / URLs / photos from earlier runs —
// internal data reuse, not a rebuild.)
isRebuild: boolean = false,
// Explicit rebuild target chosen by the start route: the reference
// set (the open plan-set tab's set, else the latest finished set)
// when the chat AI judged a rebuild / reschedule. The rebuild then
// uses the TARGET's park and visit date (the new set is a rebuild
// OF that set) together with the conditions form's other fields,
// and prevSet is the target itself. Null = resolve the target by
// park + visit date as before. A target that is missing or not
// finished is ignored and resolution falls back to park + date.
rebuildTargetSetId: number | null = null,
// Change conditions decided in the preceding chat exchange (the
// user's own messages), for a chat-started rebuild: passed into the
// assignment so the rebuild reflects THOSE changes instead of a
// generic re-run. Null when no specific change was decided.
changeRequest: string | null = null,
): Promise<{
planSetId: number;
rebuiltFromTitle: string | null;
dayOf: boolean;
}> {
const db = ctx.db<typeof schema>();
const rebuildTargetRow =
isRebuild && rebuildTargetSetId != null
? (await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, rebuildTargetSetId)))[0]
: undefined;
const rebuildTarget =
rebuildTargetRow && rebuildTargetRow.status === "done"
? rebuildTargetRow
: undefined;
// The caller's conditions govern — park and visit date included.
// Every rebuild caller passes conditions derived from the TARGET
// set's own stored snapshot, with any condition changes the chat
// judgement returned already applied by the server, so they carry
// the target's park and date unless a judged change deliberately
// moved them; the target row only fills a visit date the caller
// left unset. (This override used to force the target's park/date
// over the caller's, which would have silently undone a judged
// date/park change.)
const c: Conditions =
rebuildTarget && cIn.visitDate == null
? { ...cIn, visitDate: rebuildTarget.visitDate }
: cIn;
const baseTitle = `${c.visitDate?? "日付未定"} ${parkName(c.park)}`;
// Same-title tab disambiguation: when plan sets with this title already
// exist, the new set's title gets a sequence number at the FRONT —
// "(2) ", "(3) ", in creation order — because tab labels truncate at
// the end, so a trailing number would be invisible. The oldest set
// keeps the bare title. Family membership counts both the bare title
// and already-prefixed titles; the number is max + 1 so a deleted
// set's number is never reused for a different set.
const allTitles = await db
.select({ title: schema.planSets.title})
.from(schema.planSets);
let maxNum = 0;
for (const s of allTitles) {
if (s.title === baseTitle) {
maxNum = Math.max(maxNum, 1);
continue;
}
const m = /^\((\d+)\)\s+(.+)$/.exec(s.title);
if (m && m[2] === baseTitle) {
maxNum = Math.max(maxNum, Number(m[1]));
}
}
const title = maxNum >= 1? `(${maxNum + 1}) ${baseTitle}`: baseTitle;

// Rebuild resolution, BEFORE the insert — and ONLY for runs whose
// start route says 作り直し (isRebuild). The original is the explicit
// target set when the start route named one (a rebuild ordered from
// that set's own tab), otherwise the latest finished plan set for
// the same park AND the same visit date. What
// actually happens in a rebuild is: a NEW plan set is created from
// the original's contents and the original stays untouched — and
// that fact is recorded on the new row (rebuiltFromSetId) so the
// acceptance reply, the new tab's marker, and the completion line
// can all say exactly that, instead of the chat claiming
// 「作り直します」 (which reads as an in-place rewrite). A fresh
// creation never looks a previous set up, even for the same park and
// date: an earlier form-started run was recorded as a rebuild of a
// same-date set purely because that set existed, and every surface
// then announced a 作り直し the user never asked for.
const prevSet = isRebuild
? (rebuildTarget ??
(
await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "done"))
.orderBy(desc(schema.planSets.id))
.limit(5)
).find((s) => s.park === c.park && s.visitDate === c.visitDate))
: undefined;

const inserted = await db
.insert(schema.planSets)
.values({
title,
park: c.park,
visitDate: c.visitDate,
status: "generating",
rebuiltFromSetId: prevSet? prevSet.id: null,
// The walking speed in force for THIS run, snapshotted: save-time
// travel computation uses it even if the form changes afterwards.
walkingSpeed: c.walkingSpeed,
conditionsSnapshot: conditionsToText(c),
// The watchdog clock starts at creation; updatePlanProgress and
// savePlanSet keep it current from here on.
progressUpdatedAt: new Date(),
// The elapsed-time clock for the generating view (stuck-generation
// safeguard): this run's start, recorded server-side.
generationStartedAt: new Date(),
})
.returning({ id: schema.planSets.id});
const row = inserted[0];
if (!row) throw new Error("startGeneration: insert returned no rows");
const planSetId = row.id;

await spawnGenerationRun(ctx, planSetId, c, {
prevSet: prevSet? { id: prevSet.id, title: prevSet.title}: null,
dayOf,
changeRequest,
title,
});
return {
planSetId,
rebuiltFromTitle: prevSet? prevSet.title: null,
dayOf: dayOf != null,
};
}

// ------------------------------------------------------- run logs （過程記録）
//
// Per-execution process record for the long-running operations
// (owner's decision, 2026-11-19; see the run_logs schema comment).
// The server opens a run at every spawn and appends the events it
// can observe itself (task spawn, per-plan drafting reports via
// updatePlanProgress, and EVERY save attempt of savePlanSet /
// savePlanReplacement — its start and its outcome: success, or the
// refusal's class and reason). Server-executed actions in general
// are bracketed by the server itself (withServerRunBracket): the
// storehouse reads and sync, planAcquisition / submitSitemap,
// saveSourceSnapshots, saveNormalizedFacts, saveRestaurantFacts,
// saveFacilities, saveAreaTravelTimes and getFacilityDictionary
// each write their own start/end pair into the open run (nothing
// when no run is open), so those pairs can neither be forgotten
// by the task nor recorded twice. The task appends only what the
// server cannot see, through the recordRunEvent action, following
// the 【過程記録】 block appended to every long-run assignment:
// phase boundaries （取得 / ファクト構築 / 調査 / 下書き）, one
// start/end pair per read that leaves no snapshot (a directly
// fetched sitemap, wait-time reference sites, crowd-forecast
// sources), one start/end pair per AI-driven step of its own
// (labelled). An official page's read is recorded by the server
// alone: saveSourceSnapshots stamps a 読み取り完了 record
// (kind + URL, server clock) for each saved page, and the task
// saves each page immediately after reading it, so the stamps'
// order is the reading's progress — task-written read times
// are never the record's basis (measured to disagree with the
// actual reads, and some used pages had no read record at all). The coverage rule
// is total: while the task is alive, some labelled step is always
// in progress — no unlabelled gap may exist between consecutive
// events. A save refusal NEVER closes the run: the recovery work
// after it (re-fetching the missing page, re-saving) is recorded
// into the same run, and the run closes only at the task's true
// end. Every run is closed exactly once — by the successful save
// (succeeded), by a failure report or the dead-task watchdog
// (failed; the reason states the last completed phase, the step
// in progress, the elapsed time, and the reported reason — or
// explicitly 理由不明 when nothing was ever reported), by a user
// cancel (cancelled), or by a retry superseding it (interrupted).
// A record is never left open and silent — and at close time the
// server inspects the trail: any fetch / AI step whose start was
// recorded but whose end never was gets an explicit
// 「終了の記録なし」 marker note, its interval bounded by the
// next recorded event's time, so a hole in the record remains
// visible AS a hole instead of passing unnoticed.
type RunLogKind = "generation" | "same_day" | "partial";
type RunLogPhase =
  | "acquisition"
  | "fact_build"
  | "research"
  | "drafting"
  | "save_verify";
type RunLogEventType =
  | "run_open"
  | "phase_start"
  | "phase_end"
  | "fetch_start"
  | "fetch_end"
  | "ai_call_start"
  | "ai_call_end"
  | "note"
  | "run_close";

const RUN_PHASE_LABELS: Record<RunLogPhase, string> = {
  acquisition: "取得",
  fact_build: "ファクト構築",
  research: "調査",
  drafting: "下書き",
  save_verify: "保存・検証",
};

function formatRunElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

async function appendRunLogEvent(
  ctx: Ctx,
  runId: number,
  ev: {
    eventType: RunLogEventType;
    phase?: RunLogPhase | null;
    label: string;
    detail?: string | null;
  },
): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.runLogEvents).values({
    runId,
    eventType: ev.eventType,
    phase: ev.phase ?? null,
    label: ev.label,
    detail: ev.detail ?? null,
  });
  // Keep the run row's phase summary in step with the trail:
  // phase_start moves the current phase, phase_end completes it.
  if (ev.eventType === "phase_start" && ev.phase) {
    await db
      .update(schema.runLogs)
      .set({ currentPhase: ev.phase })
      .where(
        and(eq(schema.runLogs.id, runId), eq(schema.runLogs.status, "open")),
      );
  } else if (ev.eventType === "phase_end" && ev.phase) {
    await db
      .update(schema.runLogs)
      .set({ lastCompletedPhase: ev.phase, currentPhase: null })
      .where(
        and(eq(schema.runLogs.id, runId), eq(schema.runLogs.status, "open")),
      );
  }
}

// The run a caller is reporting into: for a slot, that slot's open
// partial run wins; otherwise the set's newest open run. Null when
// no run is open (a stray or late report — recording must never
// break the operation it observes, so callers treat null as
// "nothing to record into").
async function findOpenRunId(
  ctx: Ctx,
  planSetId: number,
  slot?: "A" | "B" | "C" | null,
): Promise<number | null> {
  const db = ctx.db<typeof schema>();
  if (slot) {
    const slotRuns = await db
      .select({ id: schema.runLogs.id })
      .from(schema.runLogs)
      .where(
        and(
          eq(schema.runLogs.planSetId, planSetId),
          eq(schema.runLogs.status, "open"),
          eq(schema.runLogs.kind, "partial"),
          eq(schema.runLogs.slot, slot),
        ),
      )
      .orderBy(desc(schema.runLogs.id))
      .limit(1);
    if (slotRuns[0]) return slotRuns[0].id;
  }
  const runs = await db
    .select({ id: schema.runLogs.id })
    .from(schema.runLogs)
    .where(
      and(
        eq(schema.runLogs.planSetId, planSetId),
        eq(schema.runLogs.status, "open"),
      ),
    )
    .orderBy(desc(schema.runLogs.id))
    .limit(1);
  return runs[0]?.id ?? null;
}

// The task-manager target a run log belongs to (the manager's
// completion hook keys on it): a whole-set generation log maps
// to the generation target, a same-day log to the same-day
// target, a partial log to its slot's partial target.
function mgrTargetForRunLog(run: {
  planSetId: number;
  kind: string;
  slot: string | null;
}): MgrTarget | null {
  if (run.kind === "generation") {
    return { type: "generation", planSetId: run.planSetId };
  }
  if (run.kind === "same_day") {
    return { type: "same_day", planSetId: run.planSetId };
  }
  if (
    run.kind === "partial" &&
    (run.slot === "A" || run.slot === "B" || run.slot === "C")
  ) {
    return { type: "partial", planSetId: run.planSetId, slot: run.slot };
  }
  return null;
}

// Closes a run exactly once (an already-closed run is untouched).
// The close reason is composed HERE from the event trail — last
// completed phase, the step still in progress (the newest start
// event with no matching end), the elapsed time, and the given
// reason — so every failure record answers "where, inside which
// call, and why" in one line, with 理由不明 stated outright when
// no reason was reported.
//
// The optional mgr flag is the task manager's completion hook:
// closes that are the processing's NORMAL completion (a save's
// success, a failure / impossibility report — the task finished
// its work and its word is already on its surface) pass
// "finished"; a user cancel passes "cancelled". Watchdog /
// sweep / supersede closes pass nothing — a silently dead task
// must stay the manager's to retry, never be mistaken for
// finished.
async function closeRunLog(
  ctx: Ctx,
  runId: number,
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted",
  reason: string | null,
  mgr?: "finished" | "cancelled" | null,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const runRows = await db
    .select()
    .from(schema.runLogs)
    .where(
      and(eq(schema.runLogs.id, runId), eq(schema.runLogs.status, "open")),
    )
    .limit(1);
  const run = runRows[0];
  if (!run) return;
  const events = await db
    .select()
    .from(schema.runLogEvents)
    .where(eq(schema.runLogEvents.runId, runId))
    .orderBy(asc(schema.runLogEvents.id));
  let lastCompleted: string | null = run.lastCompletedPhase;
  const openStarts: {
    eventType: string;
    label: string;
    phase: string | null;
    at: Date;
    index: number;
  }[] = [];
  for (let index = 0; index < events.length; index++) {
    const e = events[index];
    if (!e) continue;
    if (e.eventType === "phase_end" && e.phase) {
      lastCompleted = e.phase;
    }
    if (
      e.eventType === "phase_start" ||
      e.eventType === "fetch_start" ||
      e.eventType === "ai_call_start"
    ) {
      openStarts.push({
        eventType: e.eventType,
        label: e.label,
        phase: e.phase,
        at: e.at,
        index,
      });
    } else if (
      e.eventType === "phase_end" ||
      e.eventType === "fetch_end" ||
      e.eventType === "ai_call_end"
    ) {
      // Close the newest matching open start. Fetch / AI pairs
      // share one label by contract （開始と終了で同じ label), but
      // a phase's start and end labels legitimately differ
      // （〜の開始 / 〜の終了）, so phases pair by phase key.
      const endKind =
        e.eventType === "phase_end"
          ? "phase_start"
          : e.eventType === "fetch_end"
            ? "fetch_start"
            : "ai_call_start";
      for (let i = openStarts.length - 1; i >= 0; i--) {
        const open = openStarts[i];
        if (!open || open.eventType !== endKind) continue;
        if (endKind === "phase_start" ? open.phase === e.phase : open.label === e.label) {
          openStarts.splice(i, 1);
          break;
        }
      }
    }
  }
  const inProgress = openStarts[openStarts.length - 1] ?? null;
  const closedAt = new Date();
  const elapsed = formatRunElapsed(closedAt.getTime() - run.startedAt.getTime());
  const phaseName = (p: string | null): string =>
    p != null && p in RUN_PHASE_LABELS
      ? RUN_PHASE_LABELS[p as RunLogPhase]
      : "（なし）";
  const inProgressText = inProgress
    ? `${inProgress.label}${inProgress.phase ? `（フェーズ: ${phaseName(inProgress.phase)}）` : ""}`
    : "（なし）";
  const closeReason =
    outcome === "succeeded"
      ? `最後に完了したフェーズ: ${phaseName(lastCompleted)}／経過時間: ${elapsed}／結果: 完了`
      : `最後に完了したフェーズ: ${phaseName(lastCompleted)}／進行中だった段階: ${inProgressText}／経過時間: ${elapsed}／理由: ${reason ?? "理由不明"}`;
  // Hole marking (owner's rule, 2026-11-19): a fetch / AI step
  // whose start was recorded but whose end never was must not
  // remain a silent hole. Before the run_close event, one marker
  // note per unclosed step states plainly that its end was never
  // recorded, and bounds the step's interval by the NEXT recorded
  // event's time (the close time when it was the last event).
  // Phase starts are not marked: a phase's end is a boundary the
  // server also moves itself (per-plan progress reports, save
  // attempts), so an unclosed phase start is not an omission by
  // the recording side.
  for (const open of openStarts) {
    if (open.eventType !== "fetch_start" && open.eventType !== "ai_call_start") {
      continue;
    }
    const next = events[open.index + 1] ?? null;
    const bound = next ? next.at : closedAt;
    await db.insert(schema.runLogEvents).values({
      runId,
      eventType: "note",
      phase:
        open.phase != null && open.phase in RUN_PHASE_LABELS
          ? (open.phase as RunLogPhase)
          : null,
      label: `終了の記録なし: ${open.label}`,
      detail: `開始の記録（${open.at.toISOString()}）はあるが、対応する終了の記録が無かった。この手順の区間は、開始から次の記録の時刻（${bound.toISOString()}）までで区切られる。`,
    });
  }
  await db
    .update(schema.runLogs)
    .set({
      status: "closed",
      outcome,
      closedAt,
      closeReason,
      lastCompletedPhase: lastCompleted,
      currentPhase: null,
    })
    .where(eq(schema.runLogs.id, runId));
  await db.insert(schema.runLogEvents).values({
    runId,
    eventType: "run_close",
    phase: null,
    label:
      outcome === "succeeded"
        ? "実行の終了（完了）"
        : outcome === "failed"
          ? "実行の終了（失敗）"
          : outcome === "cancelled"
            ? "実行の終了（キャンセル）"
            : "実行の終了（中断）",
    detail: closeReason,
  });
  // 裏タスク管理： a task-driven close is the production
  // processing's "finished" mark — close the manager's run for
  // this target to match (see the mgr flag contract above).
  if (mgr) {
    const target = mgrTargetForRunLog(run);
    if (target) await mgrFinishRunForTarget(ctx, target, mgr);
  }
}

// Opens the run record for a spawn. Any still-open run for the
// same set + kind + slot is first closed as interrupted — a retry
// supersedes it, and the old record must not dangle open: its
// ending is recorded as what it is (the old task's own ending was
// never reported, so 理由不明 is stated, not implied).
async function openRunLog(
  ctx: Ctx,
  planSetId: number,
  kind: RunLogKind,
  slot: "A" | "B" | "C" | null,
  openLabel: string,
): Promise<number> {
  const db = ctx.db<typeof schema>();
  const stale = await db
    .select({ id: schema.runLogs.id })
    .from(schema.runLogs)
    .where(
      and(
        eq(schema.runLogs.planSetId, planSetId),
        eq(schema.runLogs.status, "open"),
        eq(schema.runLogs.kind, kind),
        slot
          ? eq(schema.runLogs.slot, slot)
          : isNull(schema.runLogs.slot),
      ),
    );
  for (const s of stale) {
    await closeRunLog(
      ctx,
      s.id,
      "interrupted",
      "新しい実行（リトライ等）が開始されたため、この実行の記録を閉じた。元のタスクの終了理由は報告されなかった（理由不明）。",
    );
  }
  const inserted = await db
    .insert(schema.runLogs)
    .values({ planSetId, kind, slot })
    .returning({ id: schema.runLogs.id });
  const row = inserted[0];
  if (!row) throw new Error("openRunLog: insert returned no rows");
  await appendRunLogEvent(ctx, row.id, {
    eventType: "run_open",
    label: openLabel,
  });
  return row.id;
}

// Convenience for the server's own observation points: append an
// event to the set's open run (slot-aware), doing nothing when no
// run is open.
async function recordServerRunEvent(
  ctx: Ctx,
  planSetId: number,
  ev: {
    eventType: RunLogEventType;
    phase?: RunLogPhase | null;
    label: string;
    detail?: string | null;
  },
  slot?: "A" | "B" | "C" | null,
): Promise<void> {
  const runId = await findOpenRunId(ctx, planSetId, slot);
  if (runId == null) return;
  await appendRunLogEvent(ctx, runId, ev);
}

async function closeOpenRunLog(
  ctx: Ctx,
  planSetId: number,
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted",
  reason: string | null,
  slot?: "A" | "B" | "C" | null,
  mgr?: "finished" | "cancelled" | null,
): Promise<void> {
  const runId = await findOpenRunId(ctx, planSetId, slot);
  if (runId == null) return;
  await closeRunLog(ctx, runId, outcome, reason, mgr);
}

// The currently open run, whichever set it belongs to: the target
// of the server-side auto-recording below. Server actions carry no
// planSetId (they are addressed by park / date / URL), so — exactly
// like the save attempts, which the server brackets itself — a
// server action called while a run is open records into the newest
// open run, and records nothing when no run is open. Runs whose set
// has already reached its end are NOT write targets: a finished
// set's run is only awaiting closure, and writing into it would
// both contaminate that run's record with unrelated work and keep
// resetting the sweep's silence window, so the run would stay open
// far past its own end. A run is live while its set is generating,
// or — for a partial replacement on a completed set — while the
// replaced slot is still generating (the same liveness the getState
// sweep uses when it decides which open runs to leave alone).
async function findAnyOpenRun(
  ctx: Ctx,
): Promise<{ id: number; currentPhase: string | null } | null> {
  const db = ctx.db<typeof schema>();
  const runs = await db
    .select({
      id: schema.runLogs.id,
      currentPhase: schema.runLogs.currentPhase,
      planSetId: schema.runLogs.planSetId,
      kind: schema.runLogs.kind,
      slot: schema.runLogs.slot,
    })
    .from(schema.runLogs)
    .where(eq(schema.runLogs.status, "open"))
    .orderBy(desc(schema.runLogs.id));
  for (const run of runs) {
    const setRows = await db
      .select()
      .from(schema.planSets)
      .where(eq(schema.planSets.id, run.planSetId))
      .limit(1);
    const set = setRows[0];
    if (!set) continue;
    if (set.status === "generating") return run;
    if (
      set.status === "done" &&
      run.kind === "partial" &&
      (run.slot === "A"
        ? set.progressA
        : run.slot === "B"
          ? set.progressB
          : set.progressC) === "generating"
    ) {
      return run;
    }
  }
  return null;
}

// The inside of one page read, as stamped by the reading
// script's own clock (owner's rule, 2026-11-19): renders the
// four segment stamps a saveSourceSnapshots call may carry
// (readTimings) as one process-record detail, with the segment
// durations computed HERE from those stamps — loading wait
// (open → load complete), operations (load complete →
// operations complete), extraction (operations complete, or
// load complete when the page needed no operations → text
// extracted) — so the record itself shows which part of the
// read took the time. Unparseable stamps are stated as such
// instead of being silently dropped.
function readSegmentDetail(
  rt: {
    openStartedAt: string;
    loadCompletedAt: string;
    operationsCompletedAt?: string | null;
    textExtractedAt: string;
  } | null,
): string | null {
  if (rt == null) return null;
  const t = (v: string) => new Date(v).getTime();
  const open = t(rt.openStartedAt);
  const load = t(rt.loadCompletedAt);
  const ops =
    rt.operationsCompletedAt != null ? t(rt.operationsCompletedAt) : null;
  const extract = t(rt.textExtractedAt);
  const stamps = `開き始め ${rt.openStartedAt}／読み込み完了 ${rt.loadCompletedAt}／操作完了 ${rt.operationsCompletedAt ?? "（操作なし）"}／文章取り出し ${rt.textExtractedAt}`;
  if (
    [open, load, extract, ...(ops != null ? [ops] : [])].some((n) =>
      Number.isNaN(n),
    )
  ) {
    return `${stamps}（時刻の形式が不正なものがあり、区間の秒数は算出できなかった）`;
  }
  const sec = (a: number, b: number) =>
    Math.max(0, Math.round((b - a) / 1000));
  const opsPart =
    ops != null
      ? `操作完了 ${rt.operationsCompletedAt}（操作 ${sec(load, ops)}秒）`
      : "操作なし";
  return `開き始め ${rt.openStartedAt}／読み込み完了 ${rt.loadCompletedAt}（読み込み待ち ${sec(open, load)}秒）／${opsPart}／文章取り出し ${rt.textExtractedAt}（取り出し ${sec(ops ?? load, extract)}秒）`;
}

// Server-side auto-recording for server-executed actions (owner's
// rule, 2026-11-19): an action the server itself executes — the
// storehouse reads and sync, the acquisition-plan calls, and the
// save actions a task calls (snapshots, fact builds, restaurant
// facts, facility dictionary, area travel times) — writes its own
// start/end pair into the open run, the same way savePlanSet /
// savePlanReplacement already bracket every save attempt. The task
// no longer records these (its instructions say so), so the pair
// can neither be forgotten by the task nor recorded twice. The
// pair's phase follows the run's current phase when one is set
// (the same action serves several phases — saveRestaurantFacts is
// called in fact_build and in drafting), falling back to the
// action's home phase. An end is recorded on EVERY exit — success
// or throw (the detail then states the error) — and recording
// itself never breaks the operation it observes: a failed append
// is swallowed, and if the run later closes with the pair still
// open, closeRunLog marks the hole explicitly.
async function withServerRunBracket<T>(
  ctx: Ctx,
  spec: {
    kind: "fetch" | "ai_call";
    phase: RunLogPhase;
    label: string;
    startDetail?: string | null;
    endDetail?: (result: T) => string | null;
  },
  fn: () => Promise<T>,
): Promise<T> {
  let run: { id: number; currentPhase: string | null } | null = null;
  try {
    run = await findAnyOpenRun(ctx);
  } catch {
    run = null;
  }
  if (run == null) return fn();
  const phase: RunLogPhase =
    run.currentPhase != null && run.currentPhase in RUN_PHASE_LABELS
      ? (run.currentPhase as RunLogPhase)
      : spec.phase;
  const startType = spec.kind === "fetch" ? "fetch_start" : "ai_call_start";
  const endType = spec.kind === "fetch" ? "fetch_end" : "ai_call_end";
  try {
    await appendRunLogEvent(ctx, run.id, {
      eventType: startType,
      phase,
      label: spec.label,
      detail: spec.startDetail ?? null,
    });
  } catch {
    // Recording must never break the operation it observes.
  }
  try {
    const result = await fn();
    try {
      await appendRunLogEvent(ctx, run.id, {
        eventType: endType,
        phase,
        label: spec.label,
        detail: spec.endDetail ? spec.endDetail(result) : null,
      });
    } catch {
      // Same rule: the operation's result stands.
    }
    return result;
  } catch (e) {
    try {
      await appendRunLogEvent(ctx, run.id, {
        eventType: endType,
        phase,
        label: spec.label,
        detail: `エラーで終了: ${e instanceof Error ? e.message : String(e)}`,
      });
    } catch {
      // Same rule: the original error propagates unchanged.
    }
    throw e;
  }
}

// The 【過程記録】 block appended to every long-run assignment
// (generation / same-day / partial): the points at which the task
// must call recordRunEvent so the trail carries phase boundaries,
// per-fetch/read start/end, and per-AI-step start/end with labels
// — for EVERY step of the assignment, including the research steps
// (wait-time reference reads, crowd-forecast evaluation) and the
// drafting preparation that used to fall between the fact build
// and the first plan draft unrecorded. The governing rule is
// continuity: while the task is alive, exactly one labelled step
// is in progress at all times, so consecutive events never leave
// an unlabelled gap. Save attempts are recorded by the server
// itself inside savePlanSet / savePlanReplacement (start +
// outcome), and a refusal does not close the run — the task is
// told to keep recording its recovery work into the same run.
// Server-executed actions in general are bracketed by the server
// itself (withServerRunBracket), so this block assigns the task
// only what the server cannot see — its own AI work and the
// reads that leave no snapshot — and explicitly forbids
// task-side pairs for server actions (they would double-record)
// and for official page reads (the server's save-time stamp is
// the only record of a read).
function runLogSteps(planSetId: number, slot: "A" | "B" | "C" | null): string {
  const slotArg = slot ? `、slot="${slot}"` : "";
  return [
    `【過程記録（必須）】この実行の過程は、後から「どこで・どの呼び出しの中で止まったか」を特定できるよう、過程記録に残される。次の時点で recordRunEvent アクション（planSetId=${planSetId}${slotArg}）を呼び、時刻つきの記録を残すこと。記録の呼び出し自体は生成の成否に影響しないが、省略すると止まった箇所が特定できなくなる。推測で記録を埋めてはならない（実際に行った手順だけを記録する）。ただし、サーバー側で実行されるアクション（保管庫の読み取りとURL一覧送信、取得計画の判定とサイトマップ提出、材料スナップショットの保存、ファクト構築、レストランファクト登録、施設辞書の確認と保存、エリア間移動時間の登録、プランの保存・検証）の開始／終了は、サーバーが自動で記録する。自分で記録するのは、AI自身の作業の区切り（下書き・評価・自己検証）と、写しを保存しない読み取り（待ち時間参考サイト・混雑予想の情報源など）だけとし、サーバー側のアクションと公式ページの読み取りについて recordRunEvent を呼んではならない（二重記録になるうえ、読み取りについてはタスクの自己申告は実際の時間と一致せず、正式な記録にならない）。なお、開始だけ書いて終了を書かないまま実行が閉じると、サーバーが閉じる時点で「終了の記録なし」と明記した記録を足す（穴は穴として残る）。開始を書いた手順は、必ず終了まで書くこと。`,
    `・【継続の原則（最重要）】作業は必ず「開始イベント→その作業→終了イベント」で挟むこと。開始イベントを出していない作業を進めてはならず、終了イベントを出さずに次の作業へ移ってはならない。タスクが生きている限り、常にいずれかのラベル付き手順が「進行中」である状態を保つこと（連続するイベントの間に、ラベルの無い空白区間を作らない）。下記に列挙した以外の作業（エリア間移動時間の調査、座標の追加照会、不足ページの取り直し、材料の読み直し等）も、無記録で進めてはならず、内容が分かる label の ai_call_start/ai_call_end（写しを保存しないサイトの読み取りは fetch_start/fetch_end）で挟むこと（サーバー側のアクションと公式ページの読み取りは、上記のとおりサーバーの記録に一本化される）。`,
    `・取得フェーズ: 作業の最初に phase_start（phase="acquisition"、label="取得フェーズ開始"）。このフェーズで使うサーバー側のアクション（syncStorehouseUrls、planAcquisition、getStorehouseSitemap、submitSitemap、getStorehouseRestaurants、getStorehouseSnapshot、getFacilityDictionary、saveSourceSnapshots）の開始／終了は、すべてサーバーが自動で記録する（サイトマップの出所が保管庫であることと保管庫の取得時刻も、サーバーの記録の detail に残る）ので、これらについて recordRunEvent を呼んではならない。保管庫にサイトマップが無く、自分の環境で直接取得した場合だけ、その取得を fetch_start/fetch_end（phase="acquisition"、label="サイトマップ取得"）で挟むこと。公式ページの読み取りについては、開始／終了を自分で書いてはならない（タスクが書いた読み取りの開始／終了は実際の読み取り時間と一致しないことが実測で確定しており、正式な記録の根拠にしない）。代わりに、進め方をこうすること：公式ページは、1ページ読んだら、他のページを読む前に、直ちにそのページの写しを saveSourceSnapshots で保存する（複数ページ分を読み終えてから、まとめて保存してはならない）。保存を受けたサーバーが、そのページの「読み取り完了」を、ページの種類・URLとサーバーの時刻で過程記録に自動で書く。それがそのページの読み取りの正式な記録であり、保存の時刻の並びが、そのまま読み取りの進み方になる。読み取りの中の区切り（開き始め／読み込み完了／操作完了／文章取り出し）は、読み取り用スクリプトが自身の時計で記録し、保存時に readTimings として渡すこと——サーバーがその区切りも過程記録に残す（詳細は3段手順の「読み取りの区切りの時刻」）。取得が終わったら phase_end（phase="acquisition"、label="取得フェーズ終了"）。`,
    `・ファクト構築: 開始時に phase_start（phase="fact_build"、label="ファクト構築開始"）。saveNormalizedFacts と saveRestaurantFacts の開始／終了はサーバーが自動で記録するので、自分で記録してはならない（missing を埋める再登録も同じ）。読み取った内容を解釈・構造化するのにかかった時間は、サーバーが打った「読み取り完了」の記録から、saveNormalizedFacts をサーバーが受けた時刻までの区間として、サーバーの記録だけで測られる（自分の開始／終了の自己申告は、その根拠にならない）。終わったら phase_end（phase="fact_build"、label="ファクト構築終了"）。`,
    `・調査フェーズ（ファクト構築の後・下書きの前。混雑予想の調査と待ち時間参照の読み取りは、このフェーズで記録する）: 開始時に phase_start（phase="research"、label="調査フェーズ開始"）。待ち時間参考サイトの読み取り（手順1b）は、サイト1件ごとに fetch_start/fetch_end（phase="research"、label=サイト名）で挟むこと（静的取得からブラウザ表示への切り替えも同じ1ペアの中で行い、サイト1件につき1ペアとする）。公式のリアルタイム待ち時間表示を読む場合も、同じ要領で fetch_start/fetch_end（phase="research"、label="公式リアルタイム待ち時間"）で挟む。混雑予想の調査（手順1c・通常生成のみ）では、予想サイト等の情報源の読み取り1件ごとに fetch_start/fetch_end（phase="research"、label=情報源の名前）で挟み、段階の決定そのものは ai_call_start/ai_call_end（phase="research"、label="混雑予想の評価"）で挟むこと。決定済みの混雑予想を再利用する場合は、評価は行わず、その旨を note（phase="research"、label="混雑予想は決定済みを再利用"）で残す。無理ゲート判定（手順1d等）は ai_call_start/ai_call_end（phase="research"、label="無理ゲート判定"）で挟む。終わったら phase_end（phase="research"、label="調査フェーズ終了"）。当日検索・部分差し替えで混雑予想の新規評価が無い場合は、評価の記録は残さず、実際に行った調査（待ち時間の現在値の読み取り・無理ゲート判定）だけを記録すること。`,
    `・下書き: 開始時に phase_start（phase="drafting"、label="下書き開始"）。下書きの準備（不足分の一括取得スクリプトの作成と実行）は fetch_start/fetch_end（phase="drafting"、label="不足分の一括取得スクリプト"）で挟む。saveFacilities、saveAreaTravelTimes、saveRestaurantFacts の開始／終了はサーバーが自動で記録するので、自分で記録してはならない。プランごとの下書きは、updatePlanProgress の呼び出しと合わせて ai_call_start（phase="drafting"、label="プランAの下書き" のようにプランを特定する）で始め、そのプランの下書きが終わったら ai_call_end（同じ label）。3プラン分（当日検索・部分差し替えは対象プラン分）すべてに残すこと。保存前の自己検証（手順2e等）は ai_call_start/ai_call_end（phase="drafting"、label="保存前の自己検証"）で挟む。保存データの組み立ても下書きフェーズの中で行い、phase_end（phase="drafting"、label="下書き終了"）は savePlanSet / savePlanReplacement を呼ぶ直前に出すこと（phase_end と保存呼び出しの間に作業を挟まない）。`,
    `・保存・検証: savePlanSet / savePlanReplacement の呼び出しは、試行ごとに開始と結果（成功／拒否のクラスと理由）がサーバー側で自動的に記録される（呼び出し前に自分で記録する必要はない）。保存が拒否されても、この実行の記録は閉じられない。拒否後の回復作業（不足ページの再取得、材料の読み直し、組み直し、再保存）も、上の要領で同じ実行の記録に残し続けること（再取得は fetch_start/fetch_end、読み直しや組み直しは ai_call_start/ai_call_end で挟み、再保存はサーバーが記録する）。回復を無記録で進めてはならない。`,
    `・失敗して終わる場合は、従来どおり reportPlanFailure / reportPlanReplacementFailure / reportImpossibleRequest で理由を報告すること。記録はサーバーがその理由で閉じる。理由を報告せずに終了してはならない。`,
  ].join("\n");
}

// Spawns the generation task for an EXISTING generating plan set
// (its row, title and conditions snapshot are already in place) and
// handles a failed spawn exactly like a fresh start: the set is
// marked failed and the failure is announced in the chat. Shared by
// startGeneration (fresh creation / rebuild / day-of reschedule)
// and retryGeneration (the generating view's リトライ button), so a
// retry is a real re-run of the same assignment, built from the
// set's recorded conditions — never a new set, never new conditions.
async function spawnGenerationRun(
ctx: Ctx,
planSetId: number,
c: Conditions,
opts: {
prevSet: { id: number; title: string} | null;
dayOf: { userReport: string} | null;
changeRequest: string | null;
title: string;
// A retry spawn (retryGeneration) gets a FRESH dedupe key: the
// runtime keeps the original run's key while that task is still
// registered, and re-using it makes the spawn fail outright — the
// retry must be able to start even then. This is safe against
// double saves because savePlanSet replaces the set's plans
// (idempotent re-delivery): if a not-actually-dead original also
// saves, the later save wins and the completion line posts once.
retrySpawn?: boolean;
// The task-manager attempt this spawn belongs to, when the
// manager's retry logic is the caller (mgrRespawnProduction).
// Absent on a fresh start: this function begins the attempt
// itself — EVERY production spawn goes through the manager
// （裏タスク管理クラス）, never directly to spawnTask.
mgrAttempt?: { runId: number; attemptId: number };
},
): Promise<boolean> {
const db = ctx.db<typeof schema>();
const { prevSet, dayOf, changeRequest } = opts;
const waitRefs = await loadWaitTimeSources(ctx);
const areaMatrix = await loadAreaMatrix(ctx, c.park);
const areaMatrixLines = areaMatrixLinesFor(areaMatrix);
// Rebuild context: the original set's actual contents go into the
// assignment — the agent re-times the same line-up with wait estimates
// instead of inventing a fresh plan, and records what changed in the
// notes.
let previousSummary: string | null = null;
if (prevSet) {
const prevPlans = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, prevSet.id))
.orderBy(asc(schema.plans.id));
const sections: string[] = [`前回のプラン「${prevSet.title}」の内容:`];
for (const plan of prevPlans) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
sections.push(`プラン${plan.slot}「${plan.title}」:`);
for (const it of itemRows) {
sections.push(
// The rebuild carries over the static attributes (coordinates,
// official URL, area) alongside time / name / kind, and the
// assignment forbids re-fetching what is carried over. Pass
// types are deliberately NOT carried over: a previous plan's
// DPA premise may itself be wrong (a bogus "Center of the
// Earth DPA" premise is exactly how one bad generation used
// to infect the next), so what is inherited is the line-up
// and rough order only — every DPA premise is re-decided
// from this run's normalized facts alone.
`- ${it.timeLabel?? "時刻なし"} ${it.name}（${it.kind}）${it.area? ` エリア: ${it.area}`: ""}${it.lat != null && it.lng != null? ` 座標: ${it.lat}, ${it.lng}`: ""}${it.officialUrl? ` 公式URL: ${it.officialUrl}`: ""}${it.unconfirmedReason? ` 未確定（${it.unconfirmedReason}）`: ""}`,
);
}
}
previousSummary = sections.join("\n");
}
// Crowd forecast reuse （変更2）: if this park + visit date
// already has a decided forecast on a finished set, the
// assignment states it up front and the task reuses it instead
// of re-evaluating. Day-of reschedules carry no forecast.
const heldCrowd = dayOf
? null
: await findHeldCrowdForecast(ctx, c.park, c.visitDate);
const runId = await openRunLog(
ctx,
planSetId,
"generation",
null,
opts.retrySpawn
? "生成タスクの実行を開始（リトライ）"
: "生成タスクの実行を開始",
);
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_start",
phase: "acquisition",
label: "生成タスクの起動（spawnTask）",
});
// 裏タスク管理： the spawn goes through the manager — the
// attempt is begun here (or handed in by the manager's retry),
// and a spawn failure is the manager's to retry / exhaust, not
// this function's to announce: on exhaustion the manager has
// already put the failure on the set's tab (failed + the common
// congestion text), so nothing further is written here.
const att =
opts.mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "generation", planSetId }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildAssignment(c, planSetId, waitRefs, previousSummary, dayOf, changeRequest, areaMatrixLines, heldCrowd) +
"\n\n" +
runLogSteps(planSetId, null),
{
expectsAction: "savePlanSet",
dedupeKey: opts.retrySpawn
? `plan-generation-${planSetId}-retry-${Date.now()}`
: `plan-generation-${planSetId}`,
},
);
if (spawnOutcome === "exhausted") {
ctx.invalidateQueries();
return false;
}
if (spawnOutcome === "spawned") {
// 過程記録： the spawn start event gets its pair — the trail
// must never carry a permanently-open start (the in-progress
// derivation in closeRunLog reads open starts). On "retried" a
// nested spawn (the manager's retry) opened its own run log and
// paired its own spawn event; this frame's run log was closed
// as interrupted by that open, so nothing is appended here.
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_end",
phase: "acquisition",
label: "生成タスクの起動（spawnTask）",
});
}
ctx.invalidateQueries();
return true;
}

// ------------------------------------------------------- 当日検索 (same-day search)
//
// The emergency entry for a visitor who arrived WITHOUT a plan
// (「計画を作らず行き(結構いる)」): from the プラン作成 tab's 当日検索
// form — park, current location, a specified start time, party,
// budget cap, walking speed, free-text requests — ONE plan is built
// for the rest of TODAY, from the specified time at the current
// location through park closing, using the CURRENT posted wait
// times (the day-of reschedule's material override, applied to a
// fresh set instead of an existing one). It is not a rebuild and
// never touches the TAB2 conditions row: the form's values travel
// with the request and are snapshotted onto the new plan set.
// Save-time verification is the ordinary one (savePlanSet): DPA
// eligibility/prices from this run's official snapshot, the
// 60-minute purchase rule, closures, hours, show times, and the
// server-computed travel_min — plus same-day-only checks there (no
// item before the start time; the first item IS the current
// location at the start time, so the first leg's travel is computed
// from where the visitor actually is).

type SameDayInput = {
park: "land" | "sea";
location: string;
startTime: string;
adults: number;
children: number;
childrenAges: string | null;
budgetJpy: number | null;
walkingSpeed: WalkingSpeed;
request: string | null;
};

function buildSameDayAssignment(
sd: SameDayInput,
planSetId: number,
waitRefs: {
name: string;
url: string;
provides: string | null;
fetchMethod: "script" | "browser" | "failed" | null;
}[],
areaMatrixLines: string = "",
): string {
const officialTop =
sd.park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
const today = new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
});
const methodLabel = (
m: "script" | "browser" | "failed" | null,
): string =>
m === "script"
? "前回は静的取得で取得できた"
: m === "browser"
? "前回はブラウザ表示で取得できた（静的取得では取れない）"
: m === "failed"
? "前回はどちらの方法でも取得できなかった"
: "取得方法は未記録";
const waitRefLines =
waitRefs.length > 0
? waitRefs
.map(
(r) =>
`- ${r.name}: ${r.url}${r.provides? `（取れるもの: ${r.provides}）`: ""}（取得方法の記録: ${methodLabel(r.fetchMethod)}）`,
)
.join("\n")
: "（現在、登録されている参考サイトはありません）";
return [
`東京ディズニーリゾート公式サイトから、対象パーク・本日の最新情報を取得し、「当日検索」のプランを1つだけ作成するタスクです。当日検索は、計画を作らずに来園した人が、今いる場所から、この先のスケジュールだけを緊急に作るための入口です。作るのはプランAの1件だけ（プランB・Cは作らない）。待ち時間は「現在の掲示待ち時間」を材料にします。なお、このアプリはDPA（ディズニー・プレミアアクセス）の販売状況を取得できません。販売状況については推測したり断定したりしないこと（DPAは「これから買う」前提としてのみ扱う）。`,
``,
`【当日検索の条件（ユーザーが当日検索フォームに入力した内容）】`,
`パーク: ${parkName(sd.park)}`,
`対象日: 本日（${today}）`,
`現在地点: ${sd.location}`,
`指定時刻: ${sd.startTime}（プランはこの時刻から先だけを作る）`,
`人数: 大人${sd.adults}人 / 子ども${sd.children}人${sd.childrenAges? `（${sd.childrenAges}）`: ""}`,
`予算の上限: ${sd.budgetJpy != null? `${sd.budgetJpy.toLocaleString("ja-JP")}円（これからかかる費用の上限の目安）`: "指定なし"}`,
`歩く速さ: ${WALKING_SPEED_LABELS[sd.walkingSpeed]}（移動時間の計算に使う）`,
`ご要望: ${sd.request?? "（入力なし）"}`,
``,
`【プランの形（厳守）】`,
`・先頭の項目は「現在地点」そのものにすること：timeLabel は指定時刻（${sd.startTime}）ちょうど、name には現在地点の表記（「${sd.location}」）をそのまま使い、area にはその場所の公式エリア名を入れること。座標（lat/lng）には、その場所の実際の位置を入れること——現在地点が施設名ならその施設の座標、エリア名ならそのエリア内の代表的な位置（施設辞書や Nominatim で引けた、そのエリアの施設・地点の座標）を使う。これにより、現在地点から最初の施設への移動時間がサーバーで機械計算される（travel_min）。note には「現在地点（当日検索の起点）」と書くこと。estWaitMin は null でよい（アトラクションではない）。`,
`・指定時刻より前の時刻の項目は絶対に入れないこと（保存時に拒否される）。全項目が指定時刻から、その日の閉園時刻（営業時間の終了）までの範囲に収まること。`,
`・DPAは「これから買う」前提で扱ってよい。各DPA行には購入時刻（dpaPurchaseTime）を必ず入れ、購入時刻は指定時刻以降にし、購入列が公式ルール（次のDPAは、前の購入から60分後、または前のパスの利用開始時刻の早い方から購入可能）で成立させること。`,
`・【DPA購入の並びの原則（人気順）】DPAの購入時刻は、その施設の人気度（現在の掲示待ち時間の大きさ＝需要÷処理能力の表れ）で割り当てること。待ち時間が大きい施設の購入ほど早い時刻に置き、最も待ち時間が大きい施設の購入はプラン開始直後（指定時刻に置ける最初の購入イベント）に置くこと。購入が複数ある場合は、待ち時間の大きい順に、60分ルールで成立する最も早い枠から順に割り当てること。これは購入の並びを決める原則であり、保存の可否とは無関係である（この原則に沿わない並びは保存拒否の理由にはならない）。また、この原則を理由に、DPA前提で組んだ項目をスタンバイ前提に変えてはいけない。`,
`・費用は「これからかかる分」だけを出すこと：すでに入園済みなのでチケット代は内訳に入れない。DPA代・食事代・お土産代など、これから使う分だけで内訳を作り、合計（estimatedCostJpy）と一致させること。予算の上限が指定されていれば、その範囲に収まるよう配慮すること。`,
`・ご要望が入力されていれば、それを最優先で反映すること。`,
``,
`【全体の進め方（通常の生成と同じ取得順序を、1プラン分に適用する）】`,
`0. 【施設辞書の確認】最初に getFacilityDictionary アクション（park="${sd.park}"）を呼び、このパークの施設辞書を読む。coordsUsable=true の座標は無期限で有効なので再照会禁止。staticFresh=true のエリア・公式URL・公式所要時間はそのまま使う。imageFresh=true の施設は写真が辞書にあるので imageUrl を調べ直さない。現在地点の座標も、まず辞書で引くこと。`,
`1. 公式サイト（${officialTop} を起点に、アトラクション一覧、レストラン一覧、エンターテイメント（ショー/パレード）のページ、本日のパークカレンダー/休止情報ページ）を実際に開いて読む。本日の営業時間、休止施設、ショー・パレードの開催時刻、パスの対象施設とルールは、記憶ではなく公式ページの記載で確認すること。`,
`1a. 【検証用データの取得（必須・この回の取得データで検証する）】完成したプランは、保存の直前に「この回に取得した公式データ」と突き合わせて検証される。その材料として、この回に必ず次を取得しておくこと。(i) 【正規化ソース層（必須・この順序を厳守）】${CANONICAL_FETCH_STEPS}${acquisitionPlanSteps(sd.park, jstTodayIso())}正典ソース集合（DPA案内ページ、施設全一覧＝アトラクション＋エンターテイメント、対象日の営業時間・休止情報、公演スケジュール、チケット価格、告知一覧）のうち、取得計画で fetch と判定されたノードを取得し、読む前に saveSourceSnapshots で生テキストのまま保存すること。次に保存したスナップショットと再利用ノードの指定スナップショットを読んで、施設全一覧を母集合として全施設分のDPAファクト（対象／対象外／不明＋理由、単価、適用期間、根拠スナップショットからの逐語抜粋）を構築し、saveNormalizedFacts で登録すること。なお当日検索では対象日が当日のため、取得計画はデイリー行（営業時間・休止情報・公演スケジュール）を鮮度に関係なく必ず fetch と判定する。抜粋は保存した生テキストから一字も変えずに切り取ること（単価と期間の日付は抜粋内に表記が無ければ登録できない。行に付いた「対象期間：2026年11月30日（月）～」のような表記も期間として読み取る）。対象外の根拠は evidenceKind="universe_listing"（施設全一覧側の施設名を含む抜粋）でよい。登録結果の missing が空＝完全なビルドになるまで、欠けた施設を不明＋理由で埋めて再登録すること。保存時のDPA照合はこの完全なビルドのファクトだけが根拠になる。DPAページが取得できない場合はファクトが作れないので、DPA前提の行は作らないこと（スタンバイで組む）。(ii) 本日の休止施設の一覧（operations スナップショットとしても保存すること）。(iii) プランに使うショー/パレードの本日の公式公演時刻。取得できなかったものは「未確認」として扱う。`,
`1b. 【待ち時間の材料＝現在の掲示待ち時間（当日検索の要）】集計の平均・典型的な水準は使わない。その時点で公開されている現在の待ち時間を材料にすること：公式のリアルタイム待ち時間表示と、次の登録済み待ち時間参考サイトの「現在値」を実際に開いて読む。取得はサイトごとの段階制（記録された取得方法から開始し、静的取得→ブラウザ表示）とし、取得できなかったサイトは材料に使えなかった旨を notes に記録すること（waitSourceFetchResults の報告も全サイト分必須）。estimateSources には現在値を実際に読んだサイトを入れること。候補にするアトラクションについては、現在の待ち時間をもとに、必ず具体的な推定待ち時間（分）を1つ決めること（estWaitMin）。待ち時間がほぼ無い場合も「0分」として必ず出すこと（省略は禁止）。なお当日検索では、混雑予想の係数は使わない（現在の掲示値そのものが材料であり、係数を掛けると二重に数えることになる）。savePlanSet の crowdLevel／crowdBasis／crowdWaitFactors は渡さないこと。`,
waitRefLines,
`【移動時間の計算（保存時にサーバーが機械計算する・厳守）】各区間の移動時間は、あなたが見積もるものではない。保存時にサーバーが、連続する2項目の座標間の直線距離から、歩く速さ「${WALKING_SPEED_LABELS[sd.walkingSpeed]}」で機械計算し、各項目に travel_min として保存する（画面とPDFに「移動 約◯分」と表示される）。計算式: 直線距離÷歩行速度（ゆっくり55／少しゆっくり70／少し急いで85／急いで100 m/分）×迂回乗率（〜100m ×1.1／100〜300m ×1.2／300〜600m ×1.25／600m〜 ×1.3）。エリアの異なる区間は、下記のエリア間マトリクス（少しゆっくり基準の典型分数を歩く速さで換算したもの）が登録されていれば、距離ベースとマトリクスの大きい方を取る。その上で常に×1.2の余裕を掛け、1分単位で切り上げ、最小5分とする。保存時の検証では、間隔が「推定待ち時間＋体験時間（公式所要時間）＋travel_min」以上でなければ保存を拒否される。先頭の現在地点の項目にも座標を入れるのは、この計算のためである。`,
areaMatrixLines,
`・プランで使うエリアペアがマトリクスに無い場合は、保存の前に、ウェブのガイド情報等でそのペアの典型的な徒歩時間を実際に調べて、saveAreaTravelTimes アクションで登録すること（出典の無い分数や記憶で作った分数は登録しない。分からないペアは登録せず、距離ベースのみで計算される）。`,
`・移動（move）の項目には、移動先の施設・エリアの座標を lat/lng に入れること。`,
SCOPE_BOUNDARY_STEP,
`1c2. 【無理ゲート（起草前の入口判定・必須）と融合の原則】手順1〜1bで材料（公式施設一覧・本日の運営／休止情報・公演時刻・正規化ファクト・現在の掲示待ち時間）が揃った時点で、タイムラインの起草（手順2）に入る前に、ご要望と条件が次の固定された無理パターンに当たるかどうかだけを判定すること：(1) 存在しない（必須の施設・ショーが対象パークに無い、または本日休止・公演なしであることが確定している。確認できないものは断定しない）、(2) 時間の明らかな無理（必須項目を最も緩い前提＝現在の掲示待ちの下限側・トレードオフを利用者に有利な側へ全部倒して粗く合計しても、指定時刻〜閉園の枠に収まらない）、(3) 予算の明らかな無理（最小の支出＝これからかかる必須項目の費用の下限でも予算の上限を超える。当日は入園済みなのでチケット代は含めない）、(4) 矛盾した要求（同時刻に2か所、等）。判定は常に楽観側に倒し、トレードオフで救済できるものは絶対に弾かず、境界に近ければ通常の生成に進める。パターンはこの固定リストに限る。いずれかに当たれば、起草に入らず、仮の内容も保存せず、reportImpossibleRequest アクション（planSetId=${planSetId}、findings: [{category, reason: 「分類の言葉＋具体名＋客観的事実の指摘」までの1〜2文。明確な矛盾は客観的事実そのものを述べてよい（例：同じ時刻に2か所にはいられない）。具体的な改善案・処方箋は、約束の形（「○○を外せば作れます」等の反実仮想）でも提案の形（「どちらか一方を〜するなど」「〜に変更すれば」等）でも書かない}]）を呼んで終了すること（savePlanSet も reportPlanFailure も呼ばない）。起草で要求が全ては両立しない場合は、固定の落とす順序を使わず、要求の強さを言われ方（「絶対」「必ず」の明示・繰り返し・順序指定・詳細さが強い／一度だけの軽い言及は弱い）から読んで、その利用者の価値観に沿う形に融合し、取り込めなかった要求は黙って落とさず、理由つきで summary か notes に列挙すること。どう調整しても両立しないことが明確になった場合も、仮の内容を保存せず reportImpossibleRequest で報告すること。`,
`2. 読んだ公式情報と現在の待ち時間だけを根拠に、指定時刻から閉園までのタイムライン（移動・食事・休憩を含む現実的な順序）を1つ作る。本日休止中の施設は入れない。ショー/パレードは本日の公式開催時刻に合わせる。残り時間に収まる構成にし、詰め込みすぎないこと。`,
`2b. 【スケジュールの時刻計算（最重要・厳守）】各項目の開始時刻は、その項目の「推定待ち時間＋体験時間（公式の所要時間）＋次の場所への移動時間（travel_min。余裕はその中に含まれる）」が、次の項目の開始時刻までに収まるように決めること。travel_min の概算を下回る間隔は絶対に組まないこと。特に最初の区間は、現在地点の項目（指定時刻）から最初の施設までの travel_min を見込むこと。禁止例: 推定待ち40分のアトラクションの次を40分後に置く（体験時間も移動時間も存在しない）。保存する前に、隣り合う全ペアについて「次の開始時刻 − この開始時刻 ≧ 推定待ち時間＋体験時間＋travel_min」を検算し、満たさないペアがあれば時刻を直してから保存すること。`,
`2c. 【進捗報告（必須）】プランの作成を実際に始める前に、進捗報告アクション（updatePlanProgress、planSetId=${planSetId}、slot="A"、status="generating"）を呼ぶこと。当日検索はプランAの1件だけなので、報告もAだけ行う。保存は savePlanSet で行い、保存された時点で「完了」になる。自分から「完了」を報告してはいけない。`,
`2d. 【不足分の一括取得】辞書で足りない静的属性（候補施設や現在地点の座標・公式URL・エリア・公式所要時間・写真URL）が必要になったら、その回専用の一括取得スクリプトを作成し、1回の実行でまとめて取得すること（公式一覧/詳細ページの静的フェッチと、不足座標の Nominatim 照会を含む。Nominatim への照会は1件ごとに1秒以上の間隔を空ける）。取得できたら saveFacilities アクション（park="${sd.park}"）で辞書に保存すること。レストランについては、分類を辞書の列に書かず、まず保管庫の束（getStorehouseRestaurants）にある店はその本文を fetchMethod="storehouse"・sourceFetchedAt＝束の取得時刻で saveSourceSnapshots に保存して根拠にし、束に無い店だけ、その施設自身の公式レストラン詳細ページを実ブラウザで開いて saveSourceSnapshots（kind="restaurant_detail"、park="${sd.park}"、completeness は {expectationSource: "none", expectation: "レストラン詳細ページには件数宣言が無いため完全性の期待値は導けない", result: "not_derivable"}）で全文保存してから、saveRestaurantFacts（park="${sd.park}"）で根拠つきファクトとして登録すること：reservation は {type: "required"（予約必須）／"ps"（プライオリティ・シーティング対象）／"none"（予約の経路なし）／"unknown"（未確認＋理由）, evidenceKind, evidence（保存した本文からの逐語抜粋）}、mobileOrder は {type: "available"（対象）／"not_available"（対象外）／"unknown"（未確認＋理由）, 同じ形}、serviceType はページのサービスタイプの表記そのまま。肯定分類は裏づけ表記を含む抜粋（evidenceKind="excerpt"）でのみ登録でき、否定分類は原則として不在の根拠（evidenceKind="absence"、evidence は施設名を含む一節。全文に存在マーカーが無いことをサーバーが機械確認する）で登録する。読み取れない項目は "none"／"not_available" に倒さず必ず "unknown"＋理由とし、分類をラベルから推測で作らないこと（ショーダイニングエリアだけが予約必須で本体は予約なし、という二重構造の店がある。公式一覧で別エントリの施設は別々のファクトにすること）。getFacilityDictionary の restaurantFact に有効なファクトがある施設は再利用してよい。`,
`2e. 【検証プロセス（保存直前・必須）】プランが完成したら、savePlanSet を呼ぶ前に、手順1aで取得した公式データと完成した行を突き合わせて照合すること。savePlanSet 側でも同じ照合が機械的に行われ、通らないプランは保存を拒否される（拒否されたら指摘を直してもう一度呼ぶこと。失敗報告はしない）。(1) DPA対象可否：DPA前提の全行が、手順1aで登録した正規化ファクト（完全なビルド）で「対象（eligible）」と記録された施設でなければならない。対象外（not_eligible）や不明（unknown）の施設へのDPA設定は絶対に置かない（スタンバイで組み直すか外す）。加えて、ファクトに適用期間（開始日／終了日）が記録された施設は、本日時点で有効な対象かどうかもサーバーが照合する。適用開始日が今日より後の施設にはDPA前提を付けないこと。(2) DPA単価（購入した時に計上）：DPA費用は「購入した時」にだけ計上する。購入ごとに購入イベント行（kind: "purchase"、unitPriceJpy にファクト単価、purchaseCount に対象人数＝そのプランでその施設を実際に利用する人数。アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数${sd.adults + sd.children}名。参加者全員が買う前提で総数を入れてはいけない）を1行入れ、費用内訳のDPA金額は購入イベント行ごとにファクト単価×対象人数を1回ずつ合計した額にすること。使用行では計上しない（使用行に unitPriceJpy は入れない）。購入イベント行の単価がファクトと異なる場合、対象人数が無い・1未満・参加者総数（大人${sd.adults}＋子ども${sd.children}＝${sd.adults + sd.children}名）を超える場合はクラス2で拒否される。(3) 休止・営業時間・公演時刻：各行の施設が本日の休止一覧に無いこと、各行の時刻が本日の営業時間内かつ指定時刻以降であること（公式所要時間が分かる行は終了時刻＝開始時刻＋所要時間も閉園時刻を超えないこと。超える行はクラス4（営業時間外・終了側）で拒否される。閉園ちょうどに終わる行は範囲内）、ショー/パレードの開始時刻が本日の公式公演時刻と一致すること（公式公演時刻が存在しない場合に限り、未確定として理由と説明を行に明示したショー行は例外とする。公演時刻が存在するのに異なる時刻は、未確定の印があっても拒否される）。(4) DPA購入順序：60分ルールで購入列が成立し、各DPA行に購入時刻が入っていること。(5) 照合できなかった項目は verification.unverified に「◯◯：未確認（理由）」の形で入れること。`,
`3. 座標の解決は (a) 施設辞書（coordsUsable=true のもの）、(b) 手順2dの一括取得スクリプト内での Nominatim 照会 の順で行う。座標検索に使ってよいのは OpenStreetMap の Nominatim（nominatim.openstreetmap.org）だけとする。Overpass API をはじめ、他のジオコーダへ切り替えてはいけない。日本語名で見つからなければ、第10節の固定順序で再試行すること（そのままの形→検索範囲を対象パーク周辺に制限した再照会→機械的な表記ゆれ（記号の正規化・副題を落とした短縮形・英語名））。パーク名やエリア名を施設名に付け足した形は、どの段階でも照会に使ってはならない。確信を持って引けた場合だけ座標を入れ、引けない項目は座標なし（null）にし、その旨を notes に明記すること。座標を推測で作らないこと。エリアがパークワイドのショー（花火など）は、施設名で引けた地点がパーク外の無関係な場所であることがあるため使われず、座標はサーバーがパークの代表地点（シーはメディテレーニアンハーバー、ランドはワールドバザール）に置き換える。`,
`4. 結果を保存アクション（savePlanSet）に渡す。planSetId は ${planSetId}。factBuildId には、手順1aで登録した完全なファクトビルドの id を必ず入れること（無い／不完全なビルドではDPA前提の行は全て拒否される）。plans は slot が "A" の1件だけを入れること（B・Cを入れてはいけない）。title は「当日プラン（${sd.startTime}から）」のように当日検索と分かる名前にし、summary には現在地点・開始時刻・ご要望への対応が分かるように書くこと。【プランの最低内容（クラス11・厳守）】費用合計と金額入りの内訳を必ず入れ、スケジュールにはアトラクション／ショーの実項目を少なくとも1つ含めること（現在地点と退園などのマーカー行だけの骨組みは不可）。アトラクション行とショー行には推定待ち時間（estWaitMin）を必ず入れること（0分でも入れる）。欠けた提出はクラス11として保存を拒否され、セットが失敗として記録される。タイトルがテスト／仮置きパターン（「テスト」「test」「仮置き」等）に一致するもの、要約が1文字・定型文のみ・空白を除き10文字未満のものもクラス11で拒否される（タイトルは当日検索と分かる実タイトルにし、要約には現在地点・開始時刻・ご要望への対応が分かる実質のある文章を書くこと。当日検索には実項目数の床とチケット代の床は適用されない）。estimatedCostJpy はこれからかかる費用の総額、costBreakdown は内訳の配列（{label, amountJpy, note}。チケット代は含めない。合計は estimatedCostJpy と一致させること。DPAの行の note は、購入ごとに「単価×対象人数」が分かる表記で書くこと（例：「ソアリン 2,500円×2名」のように購入1件ごとに単価と対象人数を並べる）。各 items は回る順に sortOrder 0,1,2... とし、先頭は手順どおり現在地点の項目、続けて timeLabel（例 "15:00"）、name（公式の施設名。先頭の現在地点だけは現在地点の表記そのまま）、kind（attraction/show/parade/restaurant/break/move/other/purchase）、area（公式のエリア名）、note（アトラクションについては公式の所要時間を「所要約◯分」の形で必ず含め、推定待ち時間と分けて書くこと）、passType（使う/狙うパスがあればその名称、なければ null）、dpaPurchaseTime（DPAの項目には購入時刻を必ず入れる。それ以外は null）、unconfirmedReason／unconfirmedNote（公式に確認できなかった値を仮定として置く項目には、短い理由と説明を必ず入れる。例：公演時刻が未定のショー。それ以外の項目は null。未確定の要素を、印も理由もなく確定したもののように置くことは禁止。公式公演時刻が存在するのに異なる時刻を置いた行は、未確定の印を付けてもクラス5で拒否される）【購入イベント行】DPAを使う項目については、その購入のタイミングに購入イベント行を別に1行入れること：kind は "purchase"、name は施設の公式名そのまま、timeLabel と dpaPurchaseTime に購入時刻、passType にパス名、unitPriceJpy にファクト単価（1名分）、purchaseCount に対象人数（そのプランでその施設を実際に利用する人数。アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数。必須：無い・1未満・参加者総数超はクラス2で拒否される）。座標（lat/lng）・estWaitMin・imageUrl は入れない（null）。使用行（実際に入るアトラクション／ショー行）には unitPriceJpy を入れない、estWaitMin（アトラクションには必ず入れる。0も有効、省略・null は禁止。パスで入る項目はパス利用時の待ちで見積もる。ただしレストラン行（kind=restaurant）には付けないこと（nullにする）。レストランの待ち時間はモデル化しない（事前に準備してある前提））、lat/lng を含める。具体的な施設に対応する items には officialUrl（実際に開いた公式詳細ページのURLそのもの。開かなかった施設は null）と imageUrl（その施設の公式詳細ページの代表写真の画像URL。確認できなかった項目は null。辞書に写真がある施設は null でよい）を入れること。公式写真が確認できなかった施設は、Wikimedia Commons でその施設本人の写真が見つかれば、幅500px前後のサムネイル画像URL（thumb.wikimedia.org）を referenceUrl に入れてよい。画像URLを推測で作らないこと。sources には実際に読んだ公式ページのタイトルとURLを入れる。estimateSources には、現在の待ち時間の材料として実際に読んだ参考サイトについて {title, url, fetchedAt: 取得日（今日の日付 ${today}）} を入れること。notes には箇条書きで（1項目1行、行頭に「・」を付けない）：当日検索であること（現在地点・指定時刻）、現在の待ち時間を材料にしたことと取得日（今日は ${today}）、材料が取れなかった施設・取得できなかった参考サイトがあればその旨、休止情報や制度上の注意、座標が引けなかった施設があればその旨。parkHours には本日の営業時間（公式表記）を入れる。【検証データ（必須）】verification として、手順1aで実際に取得したデータをそのまま入れること：{fetchedAt: 取得日（今日の日付 ${today}）, dpaSource: DPA案内ページの {title, url}（取得できなければ null）, calendarSource: 休止・営業時間を確認したページの {title, url}, entertainmentSource: 公演時刻を確認したページの {title, url}, dpaSnapshotText: 渡さなくてよい（DPAの照合は正規化ファクトだけで行われる。生テキストは手順1aで source_snapshots に保存済み）, closedFacilities: 本日の休止施設名の配列, showTimes: [{name, times: [...]}] の配列, unverified: 照合できなかった項目の説明の配列（無ければ空配列）}。取得していないデータを推測で入れないこと。【保存時の追加報告（必須）】metrics として {pagesOpened: 実際に開いた/取得したページの総数, phases: [{name, seconds}]} を入れ、waitSourceFetchResults として、登録されている参考サイト全件について {url, method: "script"|"browser"|"failed"} を入れること。`,
`5. 公式サイトが読めない等でプランが作れない場合は、失敗報告アクション（reportPlanFailure、planSetId=${planSetId}）で理由を伝えること。作れなかった計画をでっち上げないこと。ただし、savePlanSet が検証エラーで保存を拒否した場合は、失敗報告はせず、指摘された項目を直して savePlanSet をもう一度呼ぶこと。`,
].join("\n");
}

async function startSameDayGeneration(
ctx: Ctx,
sd: SameDayInput,
): Promise<{ planSetId: number}> {
const db = ctx.db<typeof schema>();
// 当日検索 is always for TODAY in the visitor's timezone (JST):
// the visitor is in the park now. visitDate is stored in the same
// YYYY-MM-DD form the conditions form uses.
const today = new Date().toLocaleDateString("sv-SE", {
timeZone: "Asia/Tokyo",
});
const baseTitle = `当日検索 ${today} ${parkName(sd.park)}`;
// Same "(N) " front-prefix disambiguation as startGeneration.
const allTitles = await db
.select({ title: schema.planSets.title})
.from(schema.planSets);
let maxNum = 0;
for (const s of allTitles) {
if (s.title === baseTitle) {
maxNum = Math.max(maxNum, 1);
continue;
}
const m = /^\((\d+)\)\s+(.+)$/.exec(s.title);
if (m && m[2] === baseTitle) {
maxNum = Math.max(maxNum, Number(m[1]));
}
}
const title = maxNum >= 1? `(${maxNum + 1}) ${baseTitle}`: baseTitle;
const conditionsSnapshot = [
`当日検索（緊急回避用）`,
`パーク: ${parkName(sd.park)}`,
`日付: ${today}（当日）`,
`現在地点: ${sd.location}`,
`指定時刻: ${sd.startTime} から閉園まで`,
`人数: 大人${sd.adults}人 / 子ども${sd.children}人${sd.childrenAges? `（${sd.childrenAges}）`: ""}`,
`予算の上限: ${sd.budgetJpy != null? `${sd.budgetJpy.toLocaleString("ja-JP")}円`: "指定なし"}`,
`歩く速さ: ${WALKING_SPEED_LABELS[sd.walkingSpeed]}`,
`ご要望: ${sd.request?? "（入力なし）"}`,
].join("\n");
const inserted = await db
.insert(schema.planSets)
.values({
title,
park: sd.park,
visitDate: today,
status: "generating",
setType: "same_day",
sameDayLocation: sd.location,
sameDayStartTime: sd.startTime,
sameDayRequest: sd.request,
sameDayAdults: sd.adults,
sameDayChildren: sd.children,
walkingSpeed: sd.walkingSpeed,
conditionsSnapshot,
progressUpdatedAt: new Date(),
generationStartedAt: new Date(),
})
.returning({ id: schema.planSets.id});
const row = inserted[0];
if (!row) throw new Error("startSameDayGeneration: insert returned no rows");
const planSetId = row.id;
await spawnSameDayRun(ctx, planSetId, sd);
return { planSetId};
}

// Spawns the 当日検索 task for an EXISTING generating same-day set,
// through the task manager （裏タスク管理クラス） like every
// production spawn: a failed spawn is the manager's to retry /
// exhaust (on exhaustion the failure is already on the set's
// tab). Shared by startSameDayGeneration and retryGeneration
// (the generating view's リトライ button): a retry re-runs the
// same assignment from the set's snapshotted inputs.
async function spawnSameDayRun(
ctx: Ctx,
planSetId: number,
sd: SameDayInput,
// A retry spawn gets a fresh dedupe key (see spawnGenerationRun).
retrySpawn: boolean = false,
// The task-manager attempt this spawn belongs to, when the
// manager's retry logic is the caller (mgrRespawnProduction).
mgrAttempt?: { runId: number; attemptId: number },
): Promise<boolean> {
const waitRefs = await loadWaitTimeSources(ctx);
const areaMatrixLines = areaMatrixLinesFor(
await loadAreaMatrix(ctx, sd.park),
);
const runId = await openRunLog(
ctx,
planSetId,
"same_day",
null,
retrySpawn
? "当日検索タスクの実行を開始（リトライ）"
: "当日検索タスクの実行を開始",
);
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_start",
phase: "acquisition",
label: "当日検索タスクの起動（spawnTask）",
});
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "same_day", planSetId }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildSameDayAssignment(sd, planSetId, waitRefs, areaMatrixLines) +
"\n\n" +
runLogSteps(planSetId, null),
{
expectsAction: "savePlanSet",
dedupeKey: retrySpawn
? `same-day-search-${planSetId}-retry-${Date.now()}`
: `same-day-search-${planSetId}`,
},
);
if (spawnOutcome === "exhausted") {
ctx.invalidateQueries();
return false;
}
if (spawnOutcome === "spawned") {
// 過程記録： pair the spawn start event (see spawnGenerationRun).
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_end",
phase: "acquisition",
label: "当日検索タスクの起動（spawnTask）",
});
}
ctx.invalidateQueries();
return true;
}

// ------------------------------------------------------- generation escape
//
// The stuck-generation safeguard (owner's design, 2026-11-17): a
// generation task that dies silently posts nothing — failure notices
// are the task's own job — so a 作成中 tab can freeze forever with
// nobody able to tell. The safeguard is NOT automatic detection: the
// generating view shows the elapsed time since the run started (from
// a server-side start timestamp, so a reload never resets it), a
// fixed note, and リトライ / キャンセル buttons the USER presses.
// Both buttons are server-side operations (retryGeneration /
// cancelGeneration below) that never depend on the possibly-dead
// task: retry re-runs the generation from its recorded start inputs,
// cancel removes the run (whole set) or stands the slot back down
// (partial operation) and posts exactly one chat line.
//
// For a partial operation, the retry inputs (target slot + the
// request's content) are recorded on the set at start time in
// plan_sets.pending_ops_json — a JSON object keyed by slot:
// { instruction, dayOfReport, startedAt } (startedAt = epoch ms).

type PendingPartialOp = {
  instruction: string;
  dayOfReport: string | null;
  startedAt: number;
  // Set only when the task manager exhausted this operation's
  // attempts （裏タスク管理クラス）: the slot stands at 失敗 with
  // this failure text (the common congestion text), the operation
  // record kept so the generating view's リトライ re-runs exactly
  // this request. Absent on a live or never-failed operation.
  failureText?: string | null;
};

function parsePendingOps(
  json: string | null,
): Partial<Record<"A" | "B" | "C", PendingPartialOp>> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Partial<Record<"A" | "B" | "C", PendingPartialOp>> = {};
    for (const slot of ["A", "B", "C"] as const) {
      const v = (parsed as Record<string, unknown>)[slot];
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { instruction?: unknown }).instruction === "string" &&
        typeof (v as { startedAt?: unknown }).startedAt === "number"
      ) {
        const op = v as {
          instruction: string;
          dayOfReport?: unknown;
          startedAt: number;
          failureText?: unknown;
        };
        out[slot] = {
          instruction: op.instruction,
          dayOfReport:
            typeof op.dayOfReport === "string" ? op.dayOfReport : null,
          startedAt: op.startedAt,
          failureText:
            typeof op.failureText === "string" ? op.failureText : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function serializePendingOps(
  ops: Partial<Record<"A" | "B" | "C", PendingPartialOp>>,
): string | null {
  return Object.keys(ops).length > 0 ? JSON.stringify(ops) : null;
}

// pending_ops_json with one slot's operation set (op != null) or
// removed (op == null), computed from the set row's current value.
function pendingOpsJsonWith(
  currentJson: string | null,
  slot: "A" | "B" | "C",
  op: PendingPartialOp | null,
): string | null {
  const ops = parsePendingOps(currentJson);
  if (op) {
    ops[slot] = op;
  } else {
    delete ops[slot];
  }
  return serializePendingOps(ops);
}

// Deletes one plan set with everything that hangs off it (schedule
// items, plans, verification requests) — the row-level work shared
// by deletePlanSet (tab deletion) and cancelGeneration (cancelling
// a whole-set generation deletes its set).
async function deletePlanSetRows(
  ctx: Ctx,
  planSetId: number,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const planRows = await db
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.planSetId, planSetId));
  if (planRows.length > 0) {
    const ids = planRows.map((p) => p.id);
    await db
      .delete(schema.planItems)
      .where(inArray(schema.planItems.planId, ids));
    await db.delete(schema.plans).where(inArray(schema.plans.id, ids));
  }
  await db
    .delete(schema.verificationRequests)
    .where(eq(schema.verificationRequests.planSetId, planSetId));
  await db.delete(schema.planSets).where(eq(schema.planSets.id, planSetId));
}

// ------------------------------------------------------- partial replacement
//
// A change decided in chat that targets ONE plan of an existing set
// (「プランBにセンター・オブ・ジ・アースを入れて」) is NOT a whole-set
// rebuild: only that plan is regenerated, inside the SAME set, and
// the other two plans keep their rows exactly as they are — no new
// tab, no new set. The per-plan progress columns carry the state
// (only the target slot goes 作成中）; the set itself stays "done"
// throughout, so the untouched plans remain viewable as-is. The
// replacement plan goes through the same save-time verification as
// a full generation (estimated waits, schedule arithmetic, DPA
// eligibility/prices extracted from this run's official snapshot,
// closures, hours, show times, DPA purchase sequence) via
// savePlanReplacement.

function buildPartialAssignment(
c: Conditions,
setId: number,
setTitle: string,
slot: "A" | "B" | "C",
changeInstruction: string,
currentPlanText: string,
waitRefs: {
name: string;
url: string;
provides: string | null;
fetchMethod: "script" | "browser" | "failed" | null;
}[],
areaMatrixLines: string = "",
// Non-null when this partial replacement is a DAY-OF reschedule
// (e.g. started from a purchase event's 「買えなかったら？」 button):
// the day-of premise (which DPA could not be bought) plus the user's
// own free-text situation report from the confirmation dialog. The
// assignment then overrides the estimation material with the CURRENT
// posted wait times and pins the untouched prefix of the plan,
// mirroring buildAssignment's day-of block for whole-set reschedules.
dayOfReport: string | null = null,
// The set's stored crowd forecast premise, when the set was
// created with one: the replacement keeps the same premise — and
// the target plan's own crowd scenario within it (its re-estimated
// waits apply per-facility effective factors under THAT scenario's
// cap) instead of silently dropping the coefficient.
crowdLevel: number | null = null,
crowdBasis: string | null = null,
): string {
const slotScenario =
crowdLevel != null ? CROWD_SCENARIO_BY_SLOT[slot] : null;
const slotScenarioLevel =
crowdLevel != null && slotScenario
? crowdScenarioLevel(crowdLevel, slotScenario)
: null;
const officialTop =
c.park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
const today = new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
});
const methodLabel = (
m: "script" | "browser" | "failed" | null,
): string =>
m === "script"
? "前回は静的取得で取得できた"
: m === "browser"
? "前回はブラウザ表示で取得できた（静的取得では取れない）"
: m === "failed"
? "前回はどちらの方法でも取得できなかった"
: "取得方法は未記録";
const waitRefLines =
waitRefs.length > 0
? waitRefs
.map(
(r) =>
`- ${r.name}: ${r.url}${r.provides? `（取れるもの: ${r.provides}）`: ""}（取得方法の記録: ${methodLabel(r.fetchMethod)}）`,
)
.join("\n")
: "（現在、登録されている参考サイトはありません）";
return [
`既存のプランセット「${setTitle}」のプラン${slot}だけを、変更条件を反映して作り直す（部分差し替え）タスクです。対象はプラン${slot}のみで、他のプランには一切触れません（保存もプラン${slot}だけが差し替わります）。新しいセットは作りません。なお、このアプリはDPA（ディズニー・プレミアアクセス）の販売状況を取得できません。販売状況については、ユーザーが報告した事実だけを前提にし、報告にない販売状況を推測したり断定したりしないこと。`,
``,
`【変更条件（必須・最優先）】${changeInstruction}`,
`・この変更をプラン${slot}に必ず反映すること。汎用的な作り直しで済ませてはいけない。`,
`・変更対象の施設にどのパス前提を付けるかは、この回に登録する正規化ファクト（完全なビルド）だけで決めること。変更で追加する施設がDPA対象外なら、スタンバイの推定待ち時間で組み直す（対象外の施設にDPAは存在しない）。前回のプラン${slot}に付いていたパス前提も引き継がない。`,
``,
...(dayOfReport
? [
`【当日リスケジュール（この指示は下記の通常手順より優先する）】これは当日のリスケジュールです。前提となる当日の状況は次のとおり：「${dayOfReport}」`,
`・【推定材料の上書き】手順1bの「集計の平均・典型的な水準」は、このリスケジュールでは使わない。その時点で公開されている現在の待ち時間を材料にすること：公式のリアルタイム待ち時間表示と、下記の登録済み待ち時間参考サイトの「現在値」を実際に開いて読む。取得は従来どおりサイトごとの段階制（記録された取得方法から開始し、静的取得→ブラウザ表示）とし、取得できなかったサイトは材料に使えなかった旨を summary か unverified に記録すること（waitSourceFetchResults の報告も従来どおり全サイト分必須）。estimateSources には現在値を実際に読んだサイトを入れること。`,
`・変更条件で「そのまま残す」とされた範囲（対象DPAの購入時刻より前の項目）は、時刻・名称・並び順・推定待ち時間・パス前提・座標・公式URLを変えずにそのまま含めること。組み直すのは変更条件が示す範囲だけである。ただし、ユーザーの状況報告が「全面的にリスケしてよい」という趣旨の場合はこの限りではなく、プラン全体の組み直しも許容される（その場合も、すでに過ぎた時間帯の項目は入れない）。`,
`・ユーザーの状況報告に「代わりに〇〇（別のDPA）を買った」という趣旨が含まれていれば、その代替DPAは購入済みの確定事実として扱い、報告された利用時間帯（書かれていなければ妥当な時間帯）でスケジュールに組み込み、その購入時刻も含めて残りを組み直すこと。利用時間帯が報告されておらず仮定として置いた場合は、その使用行に unconfirmedReason（短い理由。例「代替DPAの利用時間帯は仮定」）と unconfirmedNote（仮定であることの説明）を必ず入れること（行に「未確定（理由）」の印が付く）。検証の記録の未確認リストへは、行に入れた理由・説明からアプリ側が自動で整合させて載せる（行側が正本）ので、verification.unverified への重ね書きは不要だが、仮定を置きながら未確定の印も記録も残さないことは認めない。費用内訳のDPA金額も、買えなかった対象DPAを除き、代替DPAを含む新しい前提で再計算すること（DPA費用は購入した時に計上する：残る購入・代替購入はそれぞれ購入イベント行（kind: "purchase"、unitPriceJpy にファクト単価、purchaseCount に対象人数＝その施設を実際に利用する人数）で1回だけ、単価×対象人数で計上し、使用行では計上しない）。`,
`・DPAの販売状況はこのアプリには分かりません。状況報告に書かれていないDPAについて「買える／買えない」を推測で決めないこと。`,
``,
]
: []),
conditionsToText(c),
``,
`【現在のプラン${slot}の内容（差し替え元）】`,
currentPlanText,
`・構成（施設の顔ぶれと、このプランの混雑シナリオ前提）は基本として引き継ぎ、変更条件の反映と、推定待ち時間に矛盾しない時刻の組み直しを行うこと。座標・公式URL・エリアは引き継ぎ値／施設辞書の値をそのまま使うこと（再取得禁止）。`,
``,
`【全体の進め方（全体生成と同じ手順を、プラン${slot}1つ分に適用する）】`,
`0. 【施設辞書の確認】最初に getFacilityDictionary アクション（park="${c.park}"）を呼び、このパークの施設辞書を読む。coordsUsable=true の座標は再照会禁止。staticFresh=true のエリア・公式URL・公式所要時間はそのまま使う。imageFresh=true の施設は写真が辞書にあるので imageUrl を調べ直さない。`,
`1. 公式サイト（${officialTop} を起点に、アトラクション一覧、レストラン一覧、エンターテイメント（ショー/パレード）のページ、対象日のパークカレンダー/休止情報ページ）を実際に開いて読む。営業時間、休止施設、ショー・パレードの開催時刻、パスの対象施設とルールは、記憶ではなく公式ページの記載で確認すること（日付層は対象日ごとに毎回確認する）。`,
`1a. 【検証用データの取得（必須）】保存の直前に、この回に取得した公式データと完成した行が突き合わせて検証される。その材料として、この回に必ず次を取得しておくこと。(i) 【正規化ソース層（必須・この順序を厳守）】${CANONICAL_FETCH_STEPS}${acquisitionPlanSteps(c.park, c.visitDate)}正典ソース集合（DPA案内ページ、施設全一覧＝アトラクション＋エンターテイメント、対象日の営業時間・休止情報、公演スケジュール、チケット価格、告知一覧）のうち、取得計画で fetch と判定された行を取得し、読む前に saveSourceSnapshots で生テキストのまま保存すること。次に、保存したスナップショットと再利用行の指定スナップショットを読んで、施設全一覧を母集合として全施設分のDPAファクト（対象／対象外／不明＋理由、単価、適用期間、根拠スナップショットからの逐語抜粋）を構築し、saveNormalizedFacts で登録すること。抜粋は保存した生テキストから一字も変えずに切り取ること（単価と期間の日付は抜粋内に表記が無ければ登録できない。行に付いた「対象期間：2026年11月30日（月）～」のような表記も期間として読み取る）。対象外の根拠は evidenceKind="universe_listing"（施設全一覧側の施設名を含む抜粋）でよい。登録結果の missing が空＝完全なビルドになるまで、欠けた施設を不明＋理由で埋めて再登録すること。保存時のDPA照合はこの完全なビルドのファクトだけが根拠になる。DPAページが取得できない場合はファクトが作れないので、DPA前提の行は作らないこと（スタンバイで組む）。(ii) 対象日の休止施設の一覧（operations スナップショットとしても保存すること）。(iii) プランに使うショー/パレードの公式公演時刻。取得できなかったものは「未確認」として扱う。`,
`1b. 【待ち時間の推定材料】次の「待ち時間参考サイト」を実際に開いて読み、候補施設の典型的な待ち水準を推定の材料にすること（公式情報ではない「推定の材料」）。取得はサイトごとに段階制：記録が「ブラウザ表示で取得できた」サイトは最初からブラウザ表示で開く。記録が「静的取得で取得できた」または未記録のサイトは静的取得から試し、読めなければブラウザ表示に切り替える。どちらの方法でも取れなかったサイトは、そのサイトなしで推定し、その旨を summary か unverified に記録すること（1サイトの失敗で全体を止めない）。実際にどの方法で取れたかは、手順3の waitSourceFetchResults で全サイト分を報告すること。読みに使うときは、人気の序列だけでなく、定員・回転の速さ・DPA対象かどうかといった供給側の条件も踏まえること。候補にするアトラクションについては、必ず具体的な推定待ち時間（分）を1つ決めること（手順3の estWaitMin）。待ち時間がほぼ無いと判断できる場合も「0分」として必ず出すこと（省略は禁止）。`,
waitRefLines,
...(crowdLevel != null && dayOfReport == null
? [
`【混雑係数（このセットの前提・維持すること）】このセットの対象日の混雑予想は${crowdLevel}／5${crowdBasis ? `（${crowdBasis}）` : ""}。プラン${slot}は混雑シナリオ「${slotScenario ? CROWD_SCENARIO_LABELS[slotScenario] : ""}」（シナリオ段階${slotScenarioLevel}／5相当）で作られており、作成時の推定待ち時間には、そのシナリオの上限（${crowdFactorLabel(crowdFactorCap(slotScenarioLevel ?? crowdLevel))}）以下の施設ごとの実効係数が適用されている。差し替えでも同じ前提を維持すること：差し替えるプラン${slot}の estWaitMin は、材料からの基礎推定に、その施設の人気・供給量に応じた実効係数（このプランのシナリオ上限以下）を掛けて四捨五入した値にし、実際に掛けた実効係数を施設ごとに savePlanReplacement の crowdWaitFactors（[{name, factor}]）に必ず入れること（検証の記録のプラン${slot}の施設別一覧が差し替え分で更新される）。`,
]
: []),
`【移動時間の計算（保存時にサーバーが機械計算する・厳守）】各区間の移動時間は、あなたが見積もるものではない。保存時にサーバーが、連続する2項目の座標（引き継ぎ／施設辞書／あなたが items に入れた座標）間の直線距離から、歩く速さ「${WALKING_SPEED_LABELS[c.walkingSpeed]}」で機械計算し、各項目に travel_min として保存する（画面とPDFに「移動 約◯分」と表示される）。計算式: 直線距離÷歩行速度（ゆっくり55／少しゆっくり70／少し急いで85／急いで100 m/分）×迂回乗率（〜100m ×1.1／100〜300m ×1.2／300〜600m ×1.25／600m〜 ×1.3）。エリアの異なる区間は、下記のエリア間マトリクス（少しゆっくり基準の典型分数を歩く速さで換算したもの）が登録されていれば、距離ベースとマトリクスの大きい方を取る。その上で常に×1.2の余裕を掛け、1分単位で切り上げ、最小5分とする。保存時の検証では、間隔が「推定待ち時間＋体験時間（公式所要時間）＋travel_min」以上でなければ保存を拒否される。移動時間や余裕を自分で見積もって間隔を詰めてはいけない——travel_min 自体に余裕が含まれているので、開始時刻の間隔はこの式で決まる下限を前提に組むこと。`,
areaMatrixLines,
`・プランで使うエリアペアがマトリクスに無い場合は、保存の前に、ウェブのガイド情報等でそのペアの典型的な徒歩時間を実際に調べて、saveAreaTravelTimes アクション（entries: [{park: "${c.park}", areaA, areaB, minutes（少しゆっくり＝70m/分で歩く前提の典型分数）, sourceTitle, sourceUrl, fetchedAt（今日の日付 ${today}）}]）で登録すること。出典の無い分数や記憶で作った分数は登録してはいけない。調べても分からないペアは登録しない（その区間は距離ベースのみで計算される）。`,
`・移動（move）の項目には、移動先の施設・エリアの座標を lat/lng に入れること（移動時間の計算に使う）。座標が引けない施設が絡む区間は移動時間が「未確認」となり、その区間の検証は従来の下限（推定待ち＋10分）で行われ、検証の記録に未確認と残る。`,
`2. プラン${slot}を作り直す。セット共通の「重視する点」（単一の入力）と、このプランの混雑シナリオ前提に沿い、入園〜退園の時間枠の中で、時刻つきのタイムライン（移動・食事・休憩を含む現実的な順序）にする。対象日に休止中の施設は入れない。ショー/パレードは公式の開催時刻に合わせる（公式の公演時刻が未発表・未定で存在しない期間については、下記の未確定要素の作法——行に理由と説明を付ける——でのみ入れてよい）。概算費用は、パークチケット代を含む1日分の総額（円）とし、内訳（チケット代、有料パス代、食事代の目安、お土産代の目安など）の合計が総額と一致するようにする。`,
`2b. 【スケジュールの時刻計算（最重要・厳守）】各項目の開始時刻は、その項目の「推定待ち時間＋体験時間（公式の所要時間）＋次の場所への移動時間（travel_min。上記の【移動時間の計算】の式でサーバーが決める値で、余裕はその中に含まれる）」が、次の項目の開始時刻までに収まるように決めること。travel_min は上記の式で自分でも概算できるので、その概算を下回る間隔は絶対に組まないこと。常に少し余裕を持たせる。禁止例: 11:20開始のアトラクション（推定待ち40分）の次を12:00にする——待ち40分だけで12:00になり、体験時間も移動時間も存在しない。このような「推定待ち時間と矛盾するスケジュール」は絶対に作らない。保存する前に、隣り合う全ペアについて「次の開始時刻 − この開始時刻 ≧ 推定待ち時間＋体験時間＋travel_min（上記の式で概算したもの）」を検算し、満たさないペアがあれば時刻を直してから保存すること。パスを使う項目は、パス利用時の待ち（短い方）で見積もってよいが、その場合は passType にパス名を必ず入れること。`,
`2c. 【座標の解決】優先順位は (a) 差し替え元の引き継ぎ値、(b) 施設辞書（coordsUsable=true のもの）、(c) 不足分の一括取得スクリプト内での Nominatim 照会。座標検索に使ってよいのは OpenStreetMap の Nominatim（nominatim.openstreetmap.org）だけとし、Overpass API をはじめ他のジオコーダへ切り替えてはいけない。日本語名で見つからなければ、第10節の固定順序で再試行すること（そのままの形→検索範囲を対象パーク周辺に制限した再照会→機械的な表記ゆれ（記号の正規化・副題を落とした短縮形・英語名））。パーク名やエリア名を施設名に付け足した形は、どの段階でも照会に使ってはならない。確信を持って引けた場合だけ座標を入れ、引けない項目は座標なし（null）にする。座標を推測で作らないこと。なお座標の最終結果は、保存時にサーバー側でも表記ゆれのバリエーションで Nominatim の再照会が行われて確定し、施設自体がどうしても引けない場合はエリアの代表地点の座標でピンが表示され、その旨が検証の記録に残る。例外として、エリアがパークワイドのショー（花火など）は、施設名で引けた地点がパーク外の橋の上など無関係な場所であることがあるため使われず、座標はサーバーがパークの代表地点（シーはメディテレーニアンハーバー、ランドはワールドバザール）に置き換える（ペイロードや辞書に何が入っていても置き換わる）。summary には「座標なしで確定」とは書かないこと。辞書で足りない静的属性が必要になったら、その回専用の一括取得スクリプトでまとめて取得し、saveFacilities アクション（park="${c.park}"）で辞書に保存すること。レストランについては、分類を辞書の列に書かず、まず保管庫の束（getStorehouseRestaurants）にある店はその本文を fetchMethod="storehouse"・sourceFetchedAt＝束の取得時刻で saveSourceSnapshots に保存して根拠にし、束に無い店だけ、その施設自身の公式レストラン詳細ページを実ブラウザで開いて saveSourceSnapshots（kind="restaurant_detail"、park="${c.park}"、completeness は {expectationSource: "none", expectation: "レストラン詳細ページには件数宣言が無いため完全性の期待値は導けない", result: "not_derivable"}）で全文保存してから、saveRestaurantFacts（park="${c.park}"）で根拠つきファクトとして登録すること：reservation は {type: "required"（予約必須）／"ps"（プライオリティ・シーティング対象）／"none"（予約の経路なし）／"unknown"（未確認＋理由）, evidenceKind, evidence（保存した本文からの逐語抜粋）}、mobileOrder は {type: "available"（対象）／"not_available"（対象外）／"unknown"（未確認＋理由）, 同じ形}、serviceType はページのサービスタイプの表記そのまま。肯定分類は裏づけ表記を含む抜粋（evidenceKind="excerpt"）でのみ登録でき、否定分類は原則として不在の根拠（evidenceKind="absence"、evidence は施設名を含む一節。全文に存在マーカーが無いことをサーバーが機械確認する）で登録する。読み取れない項目は "none"／"not_available" に倒さず必ず "unknown"＋理由とし、分類をラベルから推測で作らないこと（ショーダイニングエリアだけが予約必須で本体は予約なし、という二重構造の店がある。公式一覧で別エントリの施設は別々のファクトにすること）。getFacilityDictionary の restaurantFact に有効なファクトがある施設は再利用してよい。`,
`2d. 【検証プロセス（保存直前・必須）】プラン${slot}が完成したら、savePlanReplacement を呼ぶ前に、手順1aでこの回に取得した公式データと完成した行を突き合わせて照合すること。savePlanReplacement 側でも同じ照合が機械的に行われ、通らない場合は保存を拒否される（拒否されたら指摘を直してもう一度呼ぶこと。失敗報告はしない）。(1) DPA対象可否：passType がディズニー・プレミアアクセスの全行が、手順1aで登録した正規化ファクト（完全なビルド）で「対象（eligible）」と記録された施設でなければならない。対象外（not_eligible）や不明（unknown）の施設へのDPA設定は絶対に置かない。加えて、ファクトに適用期間（開始日／終了日）が記録された施設は、来園日時点で有効な対象かどうかもサーバーが照合する。適用開始日が来園日より後の施設には、その来園日にはDPA前提を付けないこと（スタンバイで組み直す）。どうしても入れたい施設が対象外なら、DPA前提をやめてスタンバイの推定待ち時間で組み直す。(2) DPA単価（購入した時に計上）：DPA費用は「購入した時」にだけ計上する。購入ごとに購入イベント行（kind: "purchase"、unitPriceJpy にファクト単価、purchaseCount に対象人数＝そのプランでその施設を実際に利用する人数。アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数。参加者全員が買う前提で総数を入れてはいけない）を1行入れ、費用内訳のDPA金額は購入イベント行ごとにファクト単価×対象人数を1回ずつ合計した額にすること。使用行では計上しない（使用行に unitPriceJpy は入れない）。購入イベント行の単価がファクトと異なる場合、対象人数が無い・1未満・参加者総数（大人＋子ども）を超える場合はクラス2で拒否される。(3) 休止・営業時間・公演時刻：各行の施設が対象日の休止一覧に無いこと、各行の時刻が営業時間内であること（開始時刻だけでなく、公式所要時間が分かる行は終了時刻＝開始時刻＋所要時間も、退園時刻と閉園時刻の早い方を超えないこと。超える行はクラス4（営業時間外・終了側）で拒否される。所要時間が分からない行は終了側では判定されない。上限ちょうどに終わる行は範囲内）、ショー/パレードの開始時刻が対象日の公式公演時刻と一致すること。(4) DPA購入順序：公式ルール「次のDPAは、前のDPAの購入から60分後、または前のパスの利用開始時刻の早い方から購入できる」で購入列が成立すること。各DPA行には購入時刻を dpaPurchaseTime として必ず入れる。(5) 照合できなかった項目は、黙って通さず verification.unverified に「◯◯：未確認（理由）」の形で入れること。`,
SCOPE_BOUNDARY_STEP,
`2e. 【無理ゲートと融合の原則（必須）】手順1〜1bで材料（公式施設一覧・対象日の運営／休止情報・公演時刻・正規化ファクト）が揃った時点で、起草に入る前に、変更条件と条件の要求が次の固定された無理パターンに当たらないかだけを判定すること：(1) 存在しない（必須の施設・ショーが対象パークの施設一覧に無い、または対象日に休止・公演なしであることが日付層で確定している。確認できないものは断定しない）、(2) 時間の明らかな無理（必須項目を最も緩い前提＝一番空いた側の混雑前提・待ちの下限側・トレードオフを利用者に有利な側へ全部倒して粗く合計しても、入園〜退園・営業時間の枠に収まらない）、(3) 予算の明らかな無理（最小の支出＝チケット代＋必須と明示された有料項目の費用の下限でも予算を超える）、(4) 矛盾した要求（同時刻に2か所、等）。判定は常に楽観側に倒し、トレードオフで救済できるもの（DPAを減らせば収まる、順序を変えれば両立する等）は絶対に弾かず、境界に近ければ通常の生成に進める。パターンはこの固定リストに限る。いずれかに当たれば、起草に入らず、仮の内容も保存せず、reportImpossibleRequest アクション（planSetId と slot、findings: [{category, reason: 「分類の言葉＋具体名＋客観的事実の指摘」までの1〜2文。明確な矛盾は客観的事実そのものを述べてよい（例：同じ時刻に2か所にはいられない）。具体的な改善案・処方箋は、約束の形（「○○を外せば作れます」等の反実仮想）でも提案の形（「どちらか一方を〜するなど」「〜に変更すれば」等）でも書かない}]）を呼んで終了すること（savePlanReplacement も reportPlanReplacementFailure も呼ばない）。起草で要求が全ては両立しない場合は、固定の落とす順序を使わず、要求の強さを言われ方（「絶対」「必ず」の明示・繰り返し・順序指定・詳細さが強い／一度だけの軽い言及は弱い）から読んで、その利用者の価値観に沿う形に融合すること。取り込めなかった要求は、黙って落とさず、理由つきで summary に列挙すること。どう調整しても両立しないことが明確になった場合も、仮の内容を保存せず reportImpossibleRequest で報告すること。`,
`2e. 【未確定要素の扱い（必須）】その回の材料では公式に確認できなかった値を仮定として置く要素（未確定要素）は、理由を添えればプランに入れてよい。対象はショー時刻に限らず未確定の要素全般であり、代替DPAの利用時間帯を仮定として置く場合もこれに当たる。ただし、未確定の要素を、印も理由もなく確定したもののように置くことは絶対に禁止する。入れる場合は、その項目に unconfirmedReason（短い理由）と unconfirmedNote（なぜ未確定かの説明。分かる場合は公式の掲載予定時期も含める）を必ず入れること。検証の記録の未確認リストへは、行に入れた理由・説明からアプリ側が自動で整合させて載せる（行側が正本）ので、verification.unverified に同じ未確定を重ねて書かないこと。公式公演時刻が存在しない（未発表・未定）場合に未確定として明示したショー行は公演時刻不一致（クラス5）で拒否されないが、公式公演時刻が存在するのに別の時刻を置いた行は、未確定の印を付けてもクラス5で拒否される。`,
...(dayOfReport
? [
`2f. 【「最初の10分」行の引き継ぎ（当日リスケ）】元のプラン${slot}の「最初の10分」行（kind="first10"）がある場合は、その行を固定案内文（FIRST10_GUIDANCE）を含めて内容・位置（入園行の直後）のまま一字も変えずに引き継ぐこと。作り直したり、抽選・DPA購入の項目や案内文を書き換えたりしないこと。元のプランに「最初の10分」行が無い場合は、この行を入れないこと。`,
]
: [
`2f. 【「最初の10分」行（表示専用）】差し替えるプラン${slot}にも、全体生成と同じ「最初の10分」行を、作り直した内容に合わせて入れること。位置は入園行の直後（購入イベント行より前）。形：kind は "first10"、name は「入園後の最初の10分」、timeLabel は入園時刻とし、area／passType／dpaPurchaseTime／unitPriceJpy／estWaitMin／lat／lng／imageUrl／referenceUrl／officialUrl／unconfirmedReason／unconfirmedNote は全て null。note には、1行に1つずつ「・」で始めて、まず抽選の項目（そのプランに含まれるショーのうち、この回に取得した公式ショースケジュールの原文に「エントリー受付対象」の表記があるものについて「・{ショーの公式名}の抽選をする」。対象かどうかは原文の表記だけで判断し、推測で対象を作らない）、次にDPA購入の項目（人気順＝推定待ち時間の降順で入園直後に置かれた最初の購入イベント1件だけについて「・{施設の公式名}のDPAを買う」。60分ルールで後ろに直列化された2件目以降は入れない）を列挙し、最後に案内文「${FIRST10_GUIDANCE}」を一字も変えずに1行で入れること。入園直後のDPA購入も抽選対象ショーも無い場合は、この行は入れない。この行は表示専用で、時刻計算・移動時間・費用には一切関与しない（前後で間隔を空けない）。`,
]),
`3. 結果を保存アクション（savePlanReplacement）に渡す。planSetId は ${setId}、slot は "${slot}"、factBuildId には手順1aで登録した完全なファクトビルドの id を必ず入れること（無い／不完全なビルドではDPA前提の行は全て拒否される）、changeNote には上の【変更条件】の文をそのまま入れること（検証の記録に残る）。ticketPrices（費用の床の根拠：{adultJpy: 対象日の公式1デーパスポート大人単価, childJpy: 子ども単価（子どもがいない場合は null）, snapshotId: 手順1aで保存した ticket_prices スナップショットの id}）も必ず入れること — サーバーは申告単価をそのスナップショットの本文と機械照合する。plan は差し替えるプラン${slot}1件分で、title、summary（何を変更したかが分かるように書くこと）、estimatedCostJpy（チケット代を含む総額）、costBreakdown（内訳の配列：{label, amountJpy, note}。合計は estimatedCostJpy と一致させること。DPAの行の note は、購入ごとに「単価×対象人数」が分かる表記で書くこと（例：「ソアリン 2,500円×2名」のように購入1件ごとに単価と対象人数を並べる）、items を入れる。【予算超過の開示（クラス13・必須）】費用合計（estimatedCostJpy）が、そのセットの条件の予算を超える場合は、予算超過を開示する文面を plan の budgetDisclosure として必ず渡し、同じ開示を summary（プランの説明）にも含めること。開示のない予算超過はクラス13（予算対応の不一致）として保存を拒否される（予算超過そのものは、開示があれば通る）。予算内なら budgetDisclosure は不要（null でよい）。【プランの最低内容（クラス11・厳守）】タイトルは内容を表すものにし（スロット文字だけの仮タイトル不可。さらに「テスト」「test」「仮置き」「ダミー」「サンプル」等のテスト／仮置きパターンも不可）、要約（summary）は実質のある文章にすること（1文字・定型文のみ・空白を除き10文字未満は不可）。スケジュールにはアトラクション／ショーの実項目を少なくとも1つ含め、アトラクション行とショー行には推定待ち時間（estWaitMin）を必ず入れること（0分でも入れる）。【実質の床（厳守）】実項目（アトラクション＋ショー＋食事の行の合計）が6行以上あること、費用合計が公式チケット単価×人数のチケット代の床（根拠は ticketPrices で提出）を下回らないことも必須である。欠けた提出はクラス11として保存を拒否され、元のプランはそのまま残る。各 items は回る順に sortOrder の代わりに配列の順序どおりとし、timeLabel（例 "9:00"）、name（公式の施設名。ただし手順2fの「最初の10分」行だけは name「入園後の最初の10分」）、kind（attraction/show/parade/restaurant/break/move/other/purchase/first10）、area（公式のエリア名）、note（アトラクションについては公式の所要時間を「所要約◯分」の形で必ず含め、推定待ち時間と分けて書くこと）、passType（使う/狙うパスがあればその名称、なければ null）、dpaPurchaseTime（DPAの項目には購入時刻を "9:05" の形で必ず入れる。それ以外は null）、unconfirmedReason／unconfirmedNote（未確定要素を含む項目には、短い理由と説明を必ず入れる。それ以外の項目は null。下記の【未確定要素の扱い】参照）【購入イベント行】DPAを使う項目については、その購入のタイミングに購入イベント行を別に1行入れること：kind は "purchase"、name は施設の公式名そのまま、timeLabel と dpaPurchaseTime に購入時刻、passType にパス名、unitPriceJpy にファクト単価（1名分）、purchaseCount に対象人数（そのプランでその施設を実際に利用する人数。アトラクションは実際に乗る人数、ショーのDPA鑑賞エリアは実際にそのエリアで鑑賞する人数。全員が利用する場合のみ参加者総数。必須：無い・1未満・参加者総数超はクラス2で拒否される）。座標（lat/lng）・estWaitMin・imageUrl は入れない（null）。使用行（実際に入るアトラクション／ショー行）には unitPriceJpy を入れない、estWaitMin（推定待ち時間＝分単位の整数。kind が attraction の項目には必ず入れること。0も有効で、省略・null は禁止。パスで入る項目はパス利用時の待ちで見積もる。ただしレストラン行（kind=restaurant）には付けないこと（nullにする）。レストランの待ち時間はモデル化しない（事前に準備してある前提））、lat/lng を含める。具体的な施設に対応する items には officialUrl（実際に開いた公式詳細ページのURLそのもの。開かなかった施設は null）と imageUrl（その施設の公式詳細ページの代表写真の画像URL。確認できなかった項目は null。辞書に写真がある施設は null でよい）を入れること。公式写真が確認できなかった施設は、Wikimedia Commons でその施設本人の写真が見つかれば、幅500px前後のサムネイル画像URL（thumb.wikimedia.org）を referenceUrl に入れてよい。画像URLを推測で作らないこと。sources には実際に読んだ公式ページのタイトルとURLを入れる。estimateSources には、待ち時間の推定材料として実際に読んだ参考サイトについて {title, url, fetchedAt: 取得日（今日の日付 ${today}）} を入れること。parkHours には対象日の営業時間（公式表記）を入れる。【検証データ（必須）】verification として、手順1aでこの回に実際に取得したデータをそのまま入れること：{fetchedAt: 取得日（今日の日付 ${today}）, dpaSource: DPA案内ページの {title, url}（取得できなければ null）, calendarSource: 休止・営業時間を確認したページの {title, url}, entertainmentSource: 公演時刻を確認したページの {title, url}, dpaSnapshotText: 渡さなくてよい（DPAの照合は正規化ファクトだけで行われる。生テキストは手順1aで source_snapshots に保存済み）, closedFacilities: 対象日の休止施設名の配列, showTimes: [{name, times: [...]}] の配列, unverified: 照合できなかった項目の説明の配列（無ければ空配列）}。取得していないデータを推測で入れないこと。waitSourceFetchResults として、登録されている参考サイト全件について {url, method: "script"|"browser"|"failed"} を入れること。`,
`4. 公式サイトが読めない等でプラン${slot}が作れない場合は、失敗報告アクション（reportPlanReplacementFailure、planSetId=${setId}、slot="${slot}"）で理由を伝えること。作れなかった計画をでっち上げないこと。ただし、savePlanReplacement が検証エラーで保存を拒否した場合は、失敗報告はせず、指摘された項目を直して savePlanReplacement をもう一度呼ぶこと。`,
].join("\n");
}

// Starts a partial replacement of ONE plan inside an existing,
// finished set. Only the target slot's progress moves to 作成中 (the
// set stays "done"; the old plan row remains in place and on screen
// until savePlanReplacement actually swaps it). Returns
// alreadyRunning when that slot is already being replaced, so the
// caller can say so instead of double-starting.
async function startPartialReplacement(
ctx: Ctx,
target: {
id: number;
title: string;
park: "land" | "sea";
visitDate: string | null;
},
slot: "A" | "B" | "C",
changeInstruction: string,
// The SEALED conditions for this start （記録V): parsed from the
// target set's stored conditionsSnapshot by the caller, inside the
// start section. The live form is never read here.
sealedConditions: Conditions,
opts: {
// Day-of reschedule mode (see buildPartialAssignment's dayOfReport).
dayOfReport?: string | null;
// When set, posted to the chat as an assistant line once the task
// has ACTUALLY started — used by starts that have no chat exchange
// of their own (the 「買えなかったら？」 button), where the start
// announcement must come from the real start result, never before.
startAnnouncement?: string;
// The generating view's リトライ button (retryGeneration): the slot
// is already marked 作成中 by the operation being retried — proceed
// anyway and re-record the operation with a fresh start time. The
// caller passes the RECORDED request (instruction + dayOfReport)
// back in, so the re-run is the same operation, not a new decision.
forceRestart?: boolean;
// The task-manager attempt this spawn belongs to, when the
// manager's retry logic is the caller (mgrRespawnProduction).
mgrAttempt?: { runId: number; attemptId: number };
} = {},
): Promise<{ ok: boolean; alreadyRunning: boolean}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, target.id))
.limit(1);
const set = setRows[0];
if (!set || set.status!== "done") return { ok: false, alreadyRunning: false};
const currentProgress =
slot === "A"? set.progressA: slot === "B"? set.progressB: set.progressC;
if (currentProgress === "generating" && !opts.forceRestart) {
return { ok: false, alreadyRunning: true};
}
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plan = planRows.find((p) => p.slot === slot);
if (!plan) return { ok: false, alreadyRunning: false};
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
const currentPlanText = [
`プラン${slot}「${plan.title}」（概算費用: ${plan.estimatedCostJpy != null? `約${plan.estimatedCostJpy.toLocaleString("ja-JP")}円`: "未記録"}）:`,
...itemRows.map(
(it) =>
`- ${it.timeLabel?? "時刻なし"} ${it.name}（${it.kind}）${it.area? ` エリア: ${it.area}`: ""}${it.passType? ` パス: ${it.passType}`: ""}${it.estWaitMin != null? ` 推定待ち約${it.estWaitMin}分`: ""}${it.lat != null && it.lng != null? ` 座標: ${it.lat}, ${it.lng}`: ""}${it.officialUrl? ` 公式URL: ${it.officialUrl}`: ""}${it.unconfirmedReason? ` 未確定（${it.unconfirmedReason}）`: ""}`,
),
].join("\n");
// The replacement runs for the SET's park and visit date (the plan
// being replaced lives there), with the SEALED conditions — parsed
// from this set's stored conditionsSnapshot — for everything else
// (party size, priorities, budget, times). The form's current
// values play no part （記録V).
const c: Conditions = {
...sealedConditions,
park: set.park,
visitDate: set.visitDate,
};
// Mark the slot 作成中 AND record the operation itself (target
// slot's request + start time) on the set: the record is what the
// generating view's elapsed clock counts from and what a
// user-pressed リトライ re-runs if this task dies silently
// (pending_ops_json — see the generation-escape helpers above).
const opStartedAt = new Date();
const pendingOpsJson = pendingOpsJsonWith(set.pendingOpsJson, slot, {
instruction: changeInstruction,
dayOfReport: opts.dayOfReport ?? null,
startedAt: opStartedAt.getTime(),
});
await db
.update(schema.planSets)
.set(
slot === "A"
? { progressA: "generating" as const, progressUpdatedAt: opStartedAt, pendingOpsJson}
: slot === "B"
? { progressB: "generating" as const, progressUpdatedAt: opStartedAt, pendingOpsJson}
: { progressC: "generating" as const, progressUpdatedAt: opStartedAt, pendingOpsJson},
)
.where(eq(schema.planSets.id, set.id));
const waitRefs = await loadWaitTimeSources(ctx);
const areaMatrixLines = areaMatrixLinesFor(
await loadAreaMatrix(ctx, set.park),
);
const runId = await openRunLog(
ctx,
set.id,
"partial",
slot,
`部分差し替えタスクの実行を開始（プラン${slot}）`,
);
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_start",
phase: "acquisition",
label: "部分差し替えタスクの起動（spawnTask）",
});
// 裏タスク管理： the spawn goes through the manager, like every
// production spawn. A spawn failure is the manager's to retry /
// exhaust — on exhaustion the manager has already marked the
// slot failed with the common text (the caller's reply also
// carries the failure, as before).
const att =
opts.mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "partial", planSetId: set.id, slot }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildPartialAssignment(
c,
set.id,
set.title,
slot,
changeInstruction,
currentPlanText,
waitRefs,
areaMatrixLines,
opts.dayOfReport ?? null,
set.crowdLevel,
set.crowdBasis,
) +
"\n\n" +
runLogSteps(set.id, slot),
{
expectsAction: "savePlanReplacement",
dedupeKey: `plan-partial-${set.id}-${slot}-${Date.now()}`,
},
);
if (spawnOutcome === "exhausted") {
ctx.invalidateQueries();
return { ok: false, alreadyRunning: false};
}
if (spawnOutcome === "spawned") {
// 過程記録： pair the spawn start event (see spawnGenerationRun).
await appendRunLogEvent(ctx, runId, {
eventType: "ai_call_end",
phase: "acquisition",
label: "部分差し替えタスクの起動（spawnTask）",
});
}
// The task has actually started: a caller with no chat exchange of
// its own (the 「買えなかったら？」 button) gets its start announced
// in the chat from this real result — 言行一致： the line exists
// only because the start succeeded.
if (opts.startAnnouncement) {
await db.insert(schema.messages).values({
role: "assistant",
text: opts.startAnnouncement,
});
}
ctx.invalidateQueries();
return { ok: true, alreadyRunning: false};
}

// ---------------------------------------------------------------- PDF export
//
// The export payload: exactly what a plan set's tab shows — the three
// plans with cost breakdowns and timelines (coordinates, estimated
// waits, pass types, official links, photo URLs), the plan-set notes,
// park hours, the official sources and the wait-time estimation
// material. The chat log and the TAB2 conditions are NOT part of it.
// Assembled on demand (never stored separately), so an export always
// carries the set's current contents. The client renders this into a
// PDF entirely in-app (no upload, no public link): the user downloads
// the file and hands it over themselves.
const exportDataShape = z.object({
planSetId: z.number(),
title: z.string(),
park: parkEnum,
parkName: z.string(),
visitDate: z.string().nullable(),
parkHours: z.string().nullable(),
// Crowd forecast premise of the set (level 1–5 + basis), printed
// in the PDF header as the premise the waits were built under.
// Null for sets created before the forecast existed.
crowdLevel: z.number().nullable(),
crowdBasis: z.string().nullable(),
notes: z.string().nullable(),
// The 「重視する点」 premise from the set's conditions snapshot
// (unified model for new sets, legacy per-plan + common for older
// ones); the PDF prints it — plus each plan's crowd scenario — as
// the plan's premise.
priorities: snapshotPrioritiesShape,
// Pre-completion verification record, printed in the PDF alongside
// the notes so the handed-over file carries what was checked.
verification: verificationShape.nullable(),
sources: z.array(z.object({ title: z.string(), url: z.string()})),
estimateSources: z.array(
z.object({
title: z.string(),
url: z.string(),
fetchedAt: z.string().nullable(),
}),
),
// Footer for the exported PDF. footerUrl is the note article URL
// once one exists (SHARE_NOTE_URL); null = render the text alone.
footerText: z.string(),
footerUrl: z.string().nullable(),
plans: z.array(
z.object({
slot: slotEnum,
title: z.string(),
summary: z.string().nullable(),
estimatedCostJpy: z.number().nullable(),
costBreakdown: z.array(costLineShape),
// The crowd scenario this plan was built under (see planShape);
// the PDF prints it as part of the plan's premise. Null for older
// sets and same-day sets.
crowdScenario: z.enum(["severe", "expected", "light"]).nullable(),
crowdScenarioLevel: z.number().nullable(),
items: z.array(planItemShape),
// Read-time derived premise note (see RESTAURANT_WAIT_NOTE_TEXT
// / planShape): the note text when this plan contains restaurant
// rows, null otherwise. The PDF prints it in 「このプランの前提」.
restaurantWaitNote: z.string().nullable(),
// Read-time derived under-5 child note (see LAP_CHILD_NOTE_TEXT
// / planShape): the note text when the set's conditions snapshot
// records a child under 5, null otherwise. The PDF prints it in
// the summary box, under the 未確認 warning band.
lapChildNote: z.string().nullable(),
// Read-time derived plan-head summary statistics (see planShape):
// the PDF prints the same summary at the head of each plan.
summaryStats: summaryStatsShape,
}),
),
});

// The normalized-fact fields of a stored verification record (or
// one re-verification history entry), parsed leniently: records
// saved before the normalized-source layer existed carry none of
// them and read as no build / no summary / no facts.
function parseFactFields(p: {
factBuildId?: unknown;
factSummary?: unknown;
dpaFacts?: unknown;
}): {
factBuildId: number | null;
factSummary: z.infer<typeof factSummaryShape> | null;
dpaFacts: z.infer<typeof dpaFactShape>[];
} {
let factSummary: z.infer<typeof factSummaryShape> | null = null;
if (
typeof p.factSummary === "object" &&
p.factSummary !== null
) {
const s = p.factSummary as {
universeCount?: unknown;
eligibleCount?: unknown;
notEligibleCount?: unknown;
unknownCount?: unknown;
complete?: unknown;
unknowns?: unknown;
baselineBuildId?: unknown;
valueChanges?: unknown;
valueDiffKnockdowns?: unknown;
};
if (
typeof s.universeCount === "number" &&
typeof s.eligibleCount === "number" &&
typeof s.notEligibleCount === "number" &&
typeof s.unknownCount === "number"
) {
const parseValueChanges = (
v: unknown,
): z.infer<typeof factValueChangeShape>[] =>
Array.isArray(v)
? v
.filter(
(u): u is z.infer<typeof factValueChangeShape> =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
((u as { field?: unknown }).field === "price" ||
(u as { field?: unknown }).field === "status") &&
typeof (u as { oldValue?: unknown }).oldValue === "string" &&
typeof (u as { newValue?: unknown }).newValue === "string",
)
.map((u) => ({
name: u.name,
field: u.field,
oldValue: u.oldValue,
newValue: u.newValue,
effectiveFrom:
typeof u.effectiveFrom === "string" ? u.effectiveFrom : null,
}))
: [];
const parseValueKnockdowns = (
v: unknown,
): z.infer<typeof factValueKnockdownShape>[] =>
Array.isArray(v)
? v
.filter(
(u): u is z.infer<typeof factValueKnockdownShape> =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
((u as { field?: unknown }).field === "price" ||
(u as { field?: unknown }).field === "status") &&
typeof (u as { baselineValue?: unknown }).baselineValue ===
"string" &&
typeof (u as { submittedValue?: unknown }).submittedValue ===
"string" &&
typeof (u as { reason?: unknown }).reason === "string",
)
.map((u) => ({
name: u.name,
field: u.field,
baselineValue: u.baselineValue,
submittedValue: u.submittedValue,
reason: u.reason,
}))
: [];
factSummary = {
universeCount: s.universeCount,
eligibleCount: s.eligibleCount,
notEligibleCount: s.notEligibleCount,
unknownCount: s.unknownCount,
complete: s.complete === true,
unknowns: Array.isArray(s.unknowns)
? s.unknowns
.filter(
(u): u is { name: string; reason: string } =>
typeof u === "object" &&
u !== null &&
typeof (u as { name?: unknown }).name === "string" &&
typeof (u as { reason?: unknown }).reason === "string",
)
.map((u) => ({ name: u.name, reason: u.reason }))
: [],
// Records saved before the value-diff gate existed carry no
// diff fields; they read as no baseline / no changes.
baselineBuildId:
typeof s.baselineBuildId === "number" ? s.baselineBuildId : null,
valueChanges: parseValueChanges(s.valueChanges),
valueDiffKnockdowns: parseValueKnockdowns(s.valueDiffKnockdowns),
};
}
}
const str = (v: unknown): string | null =>
typeof v === "string" ? v : null;
const dpaFacts: z.infer<typeof dpaFactShape>[] = Array.isArray(p.dpaFacts)
? p.dpaFacts
.filter(
(d): d is Record<string, unknown> =>
typeof d === "object" &&
d !== null &&
typeof (d as { name?: unknown }).name === "string" &&
((d as { status?: unknown }).status === "eligible" ||
(d as { status?: unknown }).status === "not_eligible" ||
(d as { status?: unknown }).status === "unknown"),
)
.map((d) => ({
name: d.name as string,
status: d.status as "eligible" | "not_eligible" | "unknown",
priceJpy: typeof d.priceJpy === "number" ? d.priceJpy : null,
effectiveFrom: str(d.effectiveFrom),
effectiveTo: str(d.effectiveTo),
unknownReason: str(d.unknownReason),
evidence: str(d.evidence),
evidenceKind: str(d.evidenceKind),
snapshotKind: str(d.snapshotKind),
snapshotUrl: str(d.snapshotUrl),
snapshotFetchedAt: str(d.snapshotFetchedAt),
}))
: [];
return {
factBuildId: typeof p.factBuildId === "number" ? p.factBuildId : null,
factSummary,
dpaFacts,
};
}

// Parse a stored verification record (plan_sets.verification_json)
// into the response shape; anything malformed reads as "no record".
function parseVerificationJson(
json: string | null,
): z.infer<typeof verificationShape> | null {
if (!json) return null;
try {
const parsed: unknown = JSON.parse(json);
if (typeof parsed !== "object" || parsed === null) return null;
const p = parsed as {
checkedAt?: unknown;
checks?: unknown;
unverified?: unknown;
dpaExtracted?: unknown;
factBuildId?: unknown;
factSummary?: unknown;
dpaFacts?: unknown;
crowdFactors?: unknown;
};
return {
...parseFactFields(p),
checkedAt: typeof p.checkedAt === "string" ? p.checkedAt : null,
checks: Array.isArray(p.checks)
? p.checks
.filter(
(c): c is {
label: string;
result: string;
sourceTitle?: unknown;
sourceUrl?: unknown;
fetchedAt?: unknown;
} =>
typeof c === "object" &&
c !== null &&
typeof (c as { label?: unknown }).label === "string" &&
typeof (c as { result?: unknown }).result === "string",
)
.map((c) => ({
label: c.label,
result: c.result,
sourceTitle:
typeof c.sourceTitle === "string" ? c.sourceTitle : null,
sourceUrl: typeof c.sourceUrl === "string" ? c.sourceUrl : null,
fetchedAt: typeof c.fetchedAt === "string" ? c.fetchedAt : null,
}))
: [],
unverified: Array.isArray(p.unverified)
? p.unverified.filter(
(u): u is string => typeof u === "string",
)
: [],
// Records saved before snapshot extraction existed have no
// extracted list; they read as an empty list, never as data.
// Records saved before application-period extraction existed
// carry no period fields; those read as nulls (no period read).
dpaExtracted: Array.isArray(p.dpaExtracted)
? p.dpaExtracted
.filter(
(
d,
): d is {
name: string;
priceJpy: number;
effectiveFrom?: unknown;
effectiveTo?: unknown;
periodEvidence?: unknown;
} =>
typeof d === "object" &&
d !== null &&
typeof (d as { name?: unknown }).name === "string" &&
typeof (d as { priceJpy?: unknown }).priceJpy === "number",
)
.map((d) => ({
name: d.name,
priceJpy: d.priceJpy,
effectiveFrom:
typeof d.effectiveFrom === "string" ? d.effectiveFrom : null,
effectiveTo:
typeof d.effectiveTo === "string" ? d.effectiveTo : null,
periodEvidence:
typeof d.periodEvidence === "string" ? d.periodEvidence : null,
}))
: [],
// Records saved before the crowd forecast existed carry no
// per-facility factors; they read as an empty list, never as data.
// Records saved before the scenario split carry no slot on their
// factors; those read as slot null (one flat list for the set).
crowdFactors: Array.isArray(p.crowdFactors)
? p.crowdFactors
.filter(
(f): f is { name: string; factor: number; slot?: unknown } =>
typeof f === "object" &&
f !== null &&
typeof (f as { name?: unknown }).name === "string" &&
typeof (f as { factor?: unknown }).factor === "number",
)
.map((f) => ({
name: f.name,
factor: f.factor,
slot:
f.slot === "A" || f.slot === "B" || f.slot === "C"
? f.slot
: null,
}))
: [],
};
} catch {
return null;
}
}

// Parses a plan set's bulk re-verification history
// (plan_sets.reverifications_json) into the response shape. Entries
// written before a field existed read with empty defaults — history
// is append-only and never rewritten, so parsing stays lenient.
function parseReverificationsJson(
json: string | null,
): z.infer<typeof reverificationShape>[] {
if (!json) return [];
try {
const parsed: unknown = JSON.parse(json);
if (!Array.isArray(parsed)) return [];
const out: z.infer<typeof reverificationShape>[] = [];
for (const e of parsed) {
if (typeof e !== "object" || e === null) continue;
const p = e as {
checkedAt?: unknown;
fetchedAt?: unknown;
problems?: unknown;
unverified?: unknown;
sources?: unknown;
parkHours?: unknown;
dpaExtracted?: unknown;
factBuildId?: unknown;
factSummary?: unknown;
dpaFacts?: unknown;
};
if (typeof p.checkedAt !== "string") continue;
out.push({
...parseFactFields(p),
checkedAt: p.checkedAt,
fetchedAt: typeof p.fetchedAt === "string" ? p.fetchedAt : null,
problems: Array.isArray(p.problems)
? p.problems.filter((u): u is string => typeof u === "string")
: [],
unverified: Array.isArray(p.unverified)
? p.unverified.filter((u): u is string => typeof u === "string")
: [],
sources: Array.isArray(p.sources)
? p.sources
.filter(
(s): s is { title: string; url: string } =>
typeof s === "object" &&
s !== null &&
typeof (s as { title?: unknown }).title === "string" &&
typeof (s as { url?: unknown }).url === "string",
)
.map((s) => ({ title: s.title, url: s.url }))
: [],
parkHours: typeof p.parkHours === "string" ? p.parkHours : null,
dpaExtracted: Array.isArray(p.dpaExtracted)
? p.dpaExtracted
.filter(
(
d,
): d is {
name: string;
priceJpy: number;
effectiveFrom?: unknown;
effectiveTo?: unknown;
periodEvidence?: unknown;
} =>
typeof d === "object" &&
d !== null &&
typeof (d as { name?: unknown }).name === "string" &&
typeof (d as { priceJpy?: unknown }).priceJpy === "number",
)
.map((d) => ({
name: d.name,
priceJpy: d.priceJpy,
effectiveFrom:
typeof d.effectiveFrom === "string" ? d.effectiveFrom : null,
effectiveTo:
typeof d.effectiveTo === "string" ? d.effectiveTo : null,
periodEvidence:
typeof d.periodEvidence === "string" ? d.periodEvidence : null,
}))
: [],
});
}
return out;
} catch {
return [];
}
}

// Response of getMapTiles: one entry per distinct requested tile,
// with the owned blob URL the client composites into the PDF's static
// maps (null when that tile could not be fetched server-side either).
const mapTilesResponse = z.object({
tiles: z.array(
z.object({
z: z.number(),
x: z.number(),
y: z.number(),
url: z.string().nullable(),
}),
),
});

async function loadExportData(
ctx: Ctx,
planSetId: number,
): Promise<z.infer<typeof exportDataShape> | null> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, planSetId))
.limit(1);
const set = setRows[0];
if (!set) return null;
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plans: z.infer<typeof exportDataShape>["plans"] = [];
const durationFor = makeDurationLookup(ctx, set.park);
const restaurantFor = makeRestaurantLookup(ctx, set.park);
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
let costBreakdown: z.infer<typeof costLineShape>[] = [];
if (plan.costBreakdownJson) {
try {
const parsed: unknown = JSON.parse(plan.costBreakdownJson);
if (Array.isArray(parsed)) {
costBreakdown = parsed
.filter(
(l): l is { label: string; amountJpy: unknown; note?: unknown } =>
typeof l === "object" &&
l !== null &&
typeof (l as { label?: unknown }).label === "string",
)
.map((l) => ({
label: l.label,
amountJpy: typeof l.amountJpy === "number"? l.amountJpy: null,
note: typeof l.note === "string"? l.note: null,
}));
}
} catch {
costBreakdown = [];
}
}
const items: z.infer<typeof planItemShape>[] = [];
for (const it of itemRows) {
let imageUrl: string | null = null;
if (it.imageBlobKey) {
try {
imageUrl = await ctx.blobs.getUrl(it.imageBlobKey);
} catch {
imageUrl = null;
}
}
items.push({
id: it.id,
sortOrder: it.sortOrder,
timeLabel: it.timeLabel,
name: it.name,
kind: it.kind,
area: it.area,
note: it.note,
passType: it.passType,
dpaPurchaseTime: it.dpaPurchaseTime,
unitPriceJpy: it.unitPriceJpy,
purchaseCount: it.purchaseCount,
// Restaurant waits are not modeled (owner design, 記録AD):
// a restaurant row's stored estWaitMin — older sets still
// carry values — is never surfaced; the read payload reports
// null, the same read-time derivation as restaurantInfo and
// restaurantWaitNote. Stored rows are NOT rewritten.
estWaitMin: it.kind === "restaurant" ? null : it.estWaitMin,
travelMin: it.travelMin,
durationMin: await durationFor(it.name),
lat: it.lat,
lng: it.lng,
imageUrl,
imageSource: it.imageBlobKey? (it.imageSource?? "official"): null,
officialUrl: it.officialUrl,
unconfirmedReason: it.unconfirmedReason,
unconfirmedNote: it.unconfirmedNote,
restaurantInfo:
it.kind === "restaurant" ? await restaurantFor(it.name) : null,
});
}
plans.push({
slot: plan.slot,
title: plan.title,
summary: plan.summary,
estimatedCostJpy: plan.estimatedCostJpy,
costBreakdown,
crowdScenario: plan.crowdScenario,
crowdScenarioLevel: plan.crowdScenarioLevel,
items,
restaurantWaitNote: restaurantWaitNoteFor(items),
lapChildNote: lapChildNoteFor(set),
summaryStats: summaryStatsForPlan(set, plan.estimatedCostJpy, items),
});
}
let sources: { title: string; url: string}[] = [];
if (set.sourcesJson) {
try {
const parsed: unknown = JSON.parse(set.sourcesJson);
if (Array.isArray(parsed)) {
sources = parsed.filter(
(s): s is { title: string; url: string} =>
typeof s === "object" &&
s!== null &&
typeof (s as { title?: unknown}).title === "string" &&
typeof (s as { url?: unknown}).url === "string",
);
}
} catch {
sources = [];
}
}
let estimateSources: {
title: string;
url: string;
fetchedAt: string | null;
}[] = [];
if (set.estimateSourcesJson) {
try {
const parsed: unknown = JSON.parse(set.estimateSourcesJson);
if (Array.isArray(parsed)) {
estimateSources = parsed
.filter(
(s): s is { title: string; url: string; fetchedAt?: unknown} =>
typeof s === "object" &&
s!== null &&
typeof (s as { title?: unknown}).title === "string" &&
typeof (s as { url?: unknown}).url === "string",
)
.map((s) => ({
title: s.title,
url: s.url,
fetchedAt: typeof s.fetchedAt === "string"? s.fetchedAt: null,
}));
}
} catch {
estimateSources = [];
}
}
return {
planSetId: set.id,
title: set.title,
park: set.park,
parkName: parkName(set.park),
visitDate: set.visitDate,
parkHours: set.parkHours,
crowdLevel: set.crowdLevel,
crowdBasis: set.crowdBasis,
notes: set.notes,
priorities: parseSnapshotPriorities(set.conditionsSnapshot),
verification: parseVerificationJson(set.verificationJson),
sources,
estimateSources,
footerText: "このプランは Muse の我が家のディズニー計画で作成されました",
footerUrl: SHARE_NOTE_URL,
plans,
};
}

// Assignment for a chat fact-check: the user asked a question about
// Disney systems/facilities (or said 「調べて」 about one) and expects
// the answer itself, in chat — NOT a new plan. The task reads the
// official site and posts the answer via saveResearchAnswer.
function buildResearchAssignment(
question: string,
c: Conditions,
researchId: number,
): string {
const officialTop =
c.park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
return [
`東京ディズニーリゾート公式サイトで、次の質問への答えを確認する調査タスクです。これは調査だけが目的で、プランの作成は行いません。`,
``,
`質問: ${question}`,
`参考（現在の条件）: パークは${parkName(c.park)}、日付は${c.visitDate?? "未定"}です。`,
``,
`手順:`,
`1. 公式サイト（${officialTop} など対象パークのページを起点に、ディズニー・プレミアアクセスの案内、対象施設・ショーの詳細ページ、チケット/パスの案内ページなど、質問に関係するページ）を実際に開いて読む。記憶で答えないこと。`,
`2. 読んだ公式情報だけを根拠に、質問への答えを簡潔な日本語でまとめる。聞かれた点（購入方法、タイミング、事前予約の可否など）に直接答えること。公式ページで確認できなかった点は、推測で埋めず「公式サイトでは確認できませんでした」と書くこと。末尾に「出典:」として、実際に読んだ公式ページのタイトルとURLを挙げること。`,
`3. 結果を保存アクション（saveResearchAnswer、researchId=${researchId}）に渡す。answer には回答本文（出典を含む）を入れること。`,
`4. 公式サイトが読めない等で確認できない場合は、失敗報告アクション（reportResearchFailure、researchId=${researchId}）で理由を伝えること。どちらのアクションも呼ばずに終了しないこと。確認できなかった答えをでっち上げないこと。`,
].join("\n");
}

async function startResearch(
ctx: Ctx,
question: string,
c: Conditions,
): Promise<{ researchId: number; ok: boolean}> {
const db = ctx.db<typeof schema>();
const inserted = await db
.insert(schema.researchRequests)
.values({ question})
.returning({ id: schema.researchRequests.id});
const row = inserted[0];
if (!row) throw new Error("startResearch: insert returned no rows");
const researchId = row.id;
const ok = await spawnResearchAttempt(ctx, researchId, question, c);
ctx.invalidateQueries();
return { researchId, ok};
}

// Spawns the research task for an EXISTING pending research
// request, through the task manager （裏タスク管理クラス）: the
// attempt is begun here (or handed in by the manager's retry,
// which re-runs the SAME request — the request row is created
// exactly once, by startResearch). A spawn failure is the
// manager's to retry / exhaust; on exhaustion the manager has
// already marked the request failed and posted the common
// congestion text to the chat.
async function spawnResearchAttempt(
ctx: Ctx,
researchId: number,
question: string,
c: Conditions,
mgrAttempt?: { runId: number; attemptId: number },
): Promise<boolean> {
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "research", researchId }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildResearchAssignment(question, c, researchId),
{
expectsAction: "saveResearchAnswer",
dedupeKey: `chat-research-${researchId}`,
},
);
ctx.invalidateQueries();
return spawnOutcome !== "exhausted";
}

// Assignment for a reference-site list update: the user instructed the
// AI chat to add / remove / re-search wait-time reference sites. The
// task does the actual web work (search, open, evaluate) and writes the
// resulting FULL list back through saveWaitTimeSources. Site names are
// never fixed in code beyond the build-time initial registration — this
// task is how the list stays current.
function buildWaitSourcesAssignment(
instruction: string,
current: z.infer<typeof waitTimeSourceShape>[],
requestId: number,
): string {
const today = new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
});
const currentLines =
current.length > 0
? current
.map(
(r) =>
`- id ${r.id}: ${r.name}（${r.park === "land"? "ランド": r.park === "sea"? "シー": "両パーク"}） ${r.url}${r.provides? ` — ${r.provides}`: ""}（最終確認: ${r.lastCheckedAt? r.lastCheckedAt.slice(0, 10): "未確認"}、取得方法の記録: ${r.fetchMethod?? "未記録"}）`,
)
.join("\n")
: "（登録なし）";
return [
`「待ち時間参考サイト」の登録リストを更新するタスクです。今日は ${today} です。`,
``,
`ユーザーの指示: ${instruction}`,
``,
`現在の登録リスト:`,
currentLines,
``,
`手順:`,
`1. 指示の内容に応じて作業する。`,
`   - 追加: 指示で名前やURLが挙がっているサイトは、そのページを実際に開いて、待ち時間の集計データ（施設ごとの平均・最大・最小、曜日や時間帯の傾向など）が実際に取れることを確認してから追加する。名前だけ挙がっている場合は、そのサイトを検索して該当ページを特定し、同様に確認する。`,
`   - 削除: 指示で挙がったサイトをリストから外す。`,
`   - 再検索: 待ち時間の集計サイトを新たに検索し、候補を評価する（施設ごとの平均・最大・最小や曜日別の傾向が取れるか、更新が続いているか、実際にページが開けるか）。現在の登録のうち、開けなくなっている・更新が止まっているサイトは外し、良い候補があれば差し替え・追加する。再検索のついでに、残すサイトも実際に開いて生きているか確認する。`,
`   - 対象パーク（ランド/シー/両方）を間違えないこと。同じサイトでもパーク別ページがある場合は、パークごとに1件として扱ってよい。`,
`   - 【残るサイトの再確認（追加・削除のとき必須）】追加・削除の作業では最後に、更新後に残る登録サイトを全て実際に開いて生きているか確認すること。確認できたサイトは checkedToday=true で報告する（残りのサイトの最終確認日が今回の日付に更新されるのが、この作業の決まりである）。開いて確認できなかったサイトは checkedToday=false とし、その旨を summary に書くこと。`,
`   - 【取得方法の確認（必須）】各サイトについて、そのサイトのデータがどの方法で取れるかも確認して記録すること。まずスクリプト的な静的取得（HTTPでページを取得して、集計データがそのまま読めるか）を試し、読めれば fetchMethod="script"。静的取得では読めず（JavaScript描画や内部ブラウザが必要で）、ブラウザ表示で開いて初めて読める場合は fetchMethod="browser"。どちらでも読めないサイトは、登録に残す場合でも fetchMethod="failed" とする。この記録は次回以降の取得方法のノウハウになる。`,
`2. 更新後のリスト全体を、保存アクション（saveWaitTimeSources、requestId=${requestId}）に渡す。sources は更新後の全件で、各 {name, url, park（land/sea/both）, provides（何が取れるか）, checkedToday（今回この作業で実際に開いて確認できたら true）, fetchMethod（"script"|"browser"|"failed"。今回確認しなかったサイトは前回の記録を引き継ぐので null でよい）} を入れる。summary には、ユーザーへの完了報告（何を追加/削除/差し替えたか、確認できなかったものがあればその理由）を簡潔な日本語で入れること（この文がそのままチャットに表示される）。`,
`3. サイトが開けない等で作業ができない場合は、失敗報告アクション（reportWaitTimeSourcesFailure、requestId=${requestId}）で理由を伝えること。どちらのアクションも呼ばずに終了しないこと。開いて確認していないサイトを「確認済み」にしないこと。URLを推測で作らないこと。`,
].join("\n");
}

async function startWaitSourcesUpdate(
ctx: Ctx,
instruction: string,
): Promise<{ requestId: number; ok: boolean}> {
const db = ctx.db<typeof schema>();
const inserted = await db
.insert(schema.waitTimeSourceRequests)
.values({ instruction})
.returning({ id: schema.waitTimeSourceRequests.id});
const row = inserted[0];
if (!row) throw new Error("startWaitSourcesUpdate: insert returned no rows");
const requestId = row.id;
const ok = await spawnWaitSourcesAttempt(ctx, requestId, instruction);
ctx.invalidateQueries();
return { requestId, ok};
}

// Spawns the reference-site update task for an EXISTING pending
// request, through the task manager （裏タスク管理クラス・種類15):
// the attempt is begun here (or handed in by the manager's
// retry, which re-runs the SAME request — the request row is
// created exactly once, by startWaitSourcesUpdate). A spawn
// failure is the manager's to retry / exhaust; on exhaustion
// the manager has already marked the request failed and
// recorded the common congestion text as a dialog notice.
async function spawnWaitSourcesAttempt(
ctx: Ctx,
requestId: number,
instruction: string,
mgrAttempt?: { runId: number; attemptId: number},
): Promise<boolean> {
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "wait_sources", requestId}));
const current = await loadWaitTimeSources(ctx);
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildWaitSourcesAssignment(instruction, current, requestId),
{
expectsAction: "saveWaitTimeSources",
dedupeKey: `wait-sources-${requestId}`,
},
);
ctx.invalidateQueries();
return spawnOutcome !== "exhausted";
}

// ---------- bulk re-verification （一括検証） ----------
//
// A finished plan set is re-checked against TODAY's official data
// without touching a single plan row: the deterministic checks are
// the same ones savePlanSet runs before a set may complete (DPA
// eligibility / unit price / application period from a fresh
// normalized-fact build, closures, park hours, show times, the DPA
// purchase sequence, travel_min gap arithmetic, breakdown sums),
// re-run here in check-only form over the STORED plans. Because a
// finished set passed those checks at creation, every problem found
// now is a change in the official data (or in what can be fetched)
// since then — which is exactly what the result message reports.

type StoredPlanForCheck = {
slot: "A" | "B" | "C";
estimatedCostJpy: number | null;
costBreakdown: { label: string; amountJpy: number | null }[];
items: {
name: string;
kind: string;
timeLabel: string | null;
// The row's note, for the class-4 end-side check's fallback
// duration source (「所要約◯分」) when the dictionary has none.
note: string | null;
passType: string | null;
dpaPurchaseTime: string | null;
// Unit price stated on a purchase-event row (kind = "purchase");
// re-verification cross-checks it against the fresh fact price.
unitPriceJpy: number | null;
// Headcount stored on a purchase-event row (owner's ruling,
// 2026-11-17): re-verification recomputes DPA money at the fresh
// fact price × this count. Null on purchase rows saved before
// the field existed — those keep the party-size multiplier here
// too, so a legacy set's amounts are never reported as changed.
purchaseCount: number | null;
estWaitMin: number | null;
travelMin: number | null;
// Row-level unconfirmed (§9.4) as stored on the row: a show row
// marked unconfirmed whose official times still do not exist is
// reported 未確認 in the row's own words, never as a problem.
unconfirmedReason: string | null;
unconfirmedNote: string | null;
}[];
};

type FreshOfficialData = {
parkHours: string | null;
// The fresh normalized-fact build this re-verification judges DPA
// rows by (built by the verification task from fresh snapshots via
// saveSourceSnapshots + saveNormalizedFacts). Null when the task
// could not build one — every DPA judgement then stays 未確認.
factBuildId: number | null;
closedFacilities: string[];
showTimes: { name: string; times: string[] }[];
unverified: string[];
};

async function checkStoredPlans(
ctx: Ctx,
set: typeof schema.planSets.$inferSelect,
plansData: StoredPlanForCheck[],
fresh: FreshOfficialData,
original: z.infer<typeof verificationShape> | null,
): Promise<{
problems: string[];
unverified: string[];
factUnverified: string[];
dpaExtracted: DpaExtractedEntry[];
partySize: number;
gate: DpaFactGate;
}> {
const problems: string[] = [];
const unverified: string[] = [];
const pushProblem = (s: string): void => {
if (!problems.includes(s)) problems.push(s);
};
const pushUnverified = (s: string): void => {
if (!unverified.includes(s)) unverified.push(s);
};
// Fact-origin unverified entries only (see factsUnconfirmed),
// classified by origin exactly as in the save paths. The task's
// own reported entries (fresh.unverified) are not classified by
// their wording and never join this list; neither do travel-leg
// or coordinate entries.
const factUnverified: string[] = [];
const pushFactUnverified = (s: string): void => {
if (!factUnverified.includes(s)) factUnverified.push(s);
};
for (const u of fresh.unverified) pushUnverified(u);

const isDpaPass = (passType: string | null | undefined): boolean =>
passType != null && /プレミアアクセス|DPA/i.test(passType);

// DPA eligibility and unit prices come ONLY from the normalized
// facts of the FRESH fact build — the same rule as at save time.
// A missing or incomplete build judges nothing: every DPA row
// then stays 未確認 rather than passing or failing on no grounds.
const gate = await loadDpaFactGate(ctx, fresh.factBuildId, set.park);
const dpaExtracted = gate.eligibleEntries;
const factsUsable = gate.build != null && gate.summary?.complete === true;

// The party is the one recorded in THIS set's conditions
// snapshot — never the live form (the same rule savePlanSet and
// savePlanReplacement follow; the form may have been edited since
// the set was created, and re-checking a 4-person plan against a
// form that now says 2 people would report money "problems" that
// do not exist). The form is only the legacy fallback for a set
// whose snapshot carries no party line.
const snapshotParty = parseSnapshotParty(set.conditionsSnapshot);
const formParty = snapshotParty ? null : await loadConditions(ctx);
const partySize =
set.setType === "same_day" && set.sameDayAdults != null
? set.sameDayAdults + (set.sameDayChildren ?? 0)
: snapshotParty
? snapshotParty.adults + snapshotParty.children
: (formParty?.adults ?? 0) + (formParty?.children ?? 0);

let hoursWindow: { open: number; close: number } | null = null;
if (fresh.parkHours) {
const hm = /(\d{1,2}):(\d{2})\s*[～~\-–−]\s*(\d{1,2}):(\d{2})/.exec(
fresh.parkHours,
);
if (hm) {
hoursWindow = {
open: Number(hm[1]) * 60 + Number(hm[2]),
close: Number(hm[3]) * 60 + Number(hm[4]),
};
}
}
if (!hoursWindow) {
const hoursUnverifiedEntry =
"営業時間：未確認（今回の取得データから対象日の営業時間を読み取れなかったため）";
pushUnverified(hoursUnverifiedEntry);
pushFactUnverified(hoursUnverifiedEntry);
}
// Class 4, END side (spec §9.2, revision X) — the same judgement
// the save paths make: a row must END by the earlier of the
// conditions snapshot's exit time and the (fresh) closing time;
// either one alone when the other cannot be read.
const snapshotExitMin = parseTimeLabel(
parseSnapshotConditions(set).conditions.exitTime,
);
let endCapMin: number | null = null;
if (hoursWindow && snapshotExitMin != null) {
endCapMin = Math.min(snapshotExitMin, hoursWindow.close);
} else if (hoursWindow) {
endCapMin = hoursWindow.close;
} else if (snapshotExitMin != null) {
endCapMin = snapshotExitMin;
}
for (const u of factGateLevelUnverified(gate)) {
pushUnverified(u);
pushFactUnverified(u);
}
// Park hours themselves changed since creation: report the change
// even when every row still falls inside the new window.
if (
fresh.parkHours &&
set.parkHours &&
fresh.parkHours.replace(/\s+/g, "") !==
set.parkHours.replace(/\s+/g, "")
) {
pushProblem(
`営業時間が変わりました（作成時：${set.parkHours} → 現在：${fresh.parkHours}）`,
);
}

const closedKeys = new Set(
fresh.closedFacilities.map((n) => facilityNameKey(n)),
);
const showTimesByKey = new Map(
fresh.showTimes.map(
(s) =>
[
facilityNameKey(s.name),
s.times
.map((t) => parseTimeLabel(t))
.filter((t): t is number => t != null),
] as const,
),
);
// Prices recorded at creation, for the 単価が変わった comparison.
// Only meaningful against the creation record — a set without one
// has no baseline and gets no price-change claims.
const originalPriceByKey = new Map<string, number>(
(original?.dpaExtracted ?? []).map((d) => [
facilityNameKey(d.name),
d.priceJpy,
]),
);
// Official durations （所要時間） from the facility dictionary, for
// the gap arithmetic — the same source the save-time check uses.
const durationCache = new Map<string, number | null>();
const durationFor = async (name: string): Promise<number | null> => {
const key = facilityNameKey(name);
if (!durationCache.has(key)) {
const row = await findFacility(ctx, set.park, name);
durationCache.set(key, row?.durationMin ?? null);
}
return durationCache.get(key) ?? null;
};

for (const plan of plansData) {
// Schedule arithmetic against the stored estimates and the stored
// server-computed travel_min — the same formula as at save time:
// gap ≧ estimated wait + official duration + travel_min (with the
// legacy wait + 10 floor for legs whose travel_min is 未確認）.
let prev: {
item: StoredPlanForCheck["items"][number];
start: number;
index: number;
} | null = null;
for (const [itemIndex, item] of plan.items.entries()) {
// Purchase-event rows are transparent to the schedule
// arithmetic (their stored travel_min is a zero pass-through):
// they never become the "previous item" a gap is measured from.
// The display-only 「最初の10分」 row (kind "first10") is
// transparent the same way.
if (item.kind === "purchase" || item.kind === "first10") continue;
const start = parseTimeLabel(item.timeLabel);
if (prev && start != null && prev.item.estWaitMin != null) {
// Restaurant waits are not modeled (owner design: a restaurant
// is prepared in advance — see RESTAURANT_WAIT_NOTE_TEXT). A
// restaurant row's stored estWaitMin, where an older plan still
// carries one, contributes 0 to the gap arithmetic here, exactly
// as the save-time gates treat the normalized (null) value.
const prevWait =
prev.item.kind === "restaurant" ? 0 : prev.item.estWaitMin;
const gap = start - prev.start;
let travel: number | null = 0;
for (let k = prev.index + 1; k <= itemIndex; k++) {
const legMin = plan.items[k]?.travelMin ?? null;
if (legMin == null) {
travel = null;
break;
}
travel += legMin;
}
if (travel != null) {
const duration = await durationFor(prev.item.name);
const need = prevWait + (duration ?? 0) + travel;
const flooredNeed =
duration == null
? Math.max(need, prevWait + 10)
: need;
if (gap < flooredNeed) {
pushProblem(
`プラン${plan.slot}「${prev.item.name}」：次の「${item.name}」までの間隔（${gap}分）が、推定待ち${prevWait}分＋体験時間${duration != null ? `${duration}分` : "（公式所要時間が辞書に無いため0分として計算）"}＋移動時間${travel}分を下回っています`,
);
}
} else {
const need = prevWait + 10;
if (gap < need) {
pushProblem(
`プラン${plan.slot}「${prev.item.name}」：推定待ち${prevWait}分に対し、次の「${item.name}」まで${gap}分しかありません（待ち時間＋体験・移動・余裕として最低${need}分必要）`,
);
}
}
}
if (start != null) prev = { item, start, index: itemIndex };
}

let expectedDpaTotal = 0;
let planDpaRows = 0;
const dpaSeq: { name: string; purchase: number; use: number }[] = [];
const priceChangeSeen = new Set<string>();
for (const item of plan.items) {
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility and carries no premise to re-check: no closure /
// hours / show-time / DPA judgement ever runs on it.
if (item.kind === "first10") continue;
const key = facilityNameKey(item.name);
const start = parseTimeLabel(item.timeLabel);
if (closedKeys.has(key)) {
pushProblem(
`プラン${plan.slot}「${item.name}」：対象日の休止施設になりました（今回取得した休止一覧に載っています）`,
);
}
if (
hoursWindow &&
start != null &&
(start < hoursWindow.open || start > hoursWindow.close)
) {
pushProblem(
`プラン${plan.slot}「${item.name}」：開始時刻（${item.timeLabel}）が現在の営業時間（${fmtMinutesOfDay(hoursWindow.open)}〜${fmtMinutesOfDay(hoursWindow.close)}）の範囲外です`,
);
}
// Class 4, END side: start + official duration (dictionary,
// else the row note's 「所要約◯分」) past the set's cap is a
// problem, exactly as at save time. Purchase-event rows are
// outside schedule arithmetic; rows with no known duration
// are not judged on the end side; ending at the cap is inside.
if (item.kind !== "purchase" && endCapMin != null && start != null) {
const endDuration =
(await durationFor(item.name)) ?? noteDurationMin(item.note);
if (endDuration != null && start + endDuration > endCapMin) {
pushProblem(
`プラン${plan.slot}「${item.name}」：終了時刻（${fmtMinutesOfDay(start + endDuration)}＝開始 ${item.timeLabel}＋公式所要時間${endDuration}分）が、このセットの上限（${fmtMinutesOfDay(endCapMin)}＝退園時刻と閉園時刻の早い方）を超えています（営業時間外・クラス4）`,
);
}
}
if (item.kind === "show" || item.kind === "parade") {
const times = showTimesByKey.get(key);
if (times && times.length > 0) {
if (start == null || !times.includes(start)) {
pushProblem(
`プラン${plan.slot}「${item.name}」：公演時刻が変わっています（プランでは${item.timeLabel ?? "時刻なし"}、今回取得した公式の公演時刻は ${times.map(fmtMinutesOfDay).join(" / ")}）`,
);
}
} else if (item.unconfirmedReason) {
// §9.4: the row itself carries this unconfirmed, and official
// times still do not exist — report it in the row's own words
// (the same derived entry the creation record holds), not as
// a problem and not in generic wording.
const entry = rowUnconfirmedRecordEntry(item);
if (entry) {
pushUnverified(entry);
pushFactUnverified(entry);
}
} else {
const showTimeUnverifiedEntry =
`${item.name}の公演時刻：未確認（今回取得した公式の公演時刻データと照合できなかったため）`;
pushUnverified(showTimeUnverifiedEntry);
pushFactUnverified(showTimeUnverifiedEntry);
}
}
if (isDpaPass(item.passType)) {
planDpaRows++;
}
// Purchase-time checks run only for sets that carry a creation
// verification record: those sets passed the save-time gate,
// which required a purchase time on every DPA row — a failure
// now is a real finding. Pre-verification sets never recorded
// purchase times, so the check has no baseline there. They run
// on USAGE rows only: a purchase-event row's own timeLabel IS
// the purchase time, and entering it here would double the
// event in the sequence.
if (isDpaPass(item.passType) && item.kind !== "purchase" && original != null) {
const purchase = parseTimeLabel(item.dpaPurchaseTime);
if (purchase == null) {
pushProblem(
`プラン${plan.slot}「${item.name}」：DPAの購入時刻が記録されていません`,
);
} else if (start != null) {
if (purchase > start) {
pushProblem(
`プラン${plan.slot}「${item.name}」：DPAの購入時刻（${item.dpaPurchaseTime}）が利用開始時刻（${item.timeLabel}）より後になっています`,
);
}
dpaSeq.push({ name: item.name, purchase, use: start });
}
}
}
const seq = [...dpaSeq].sort((a, b) => a.purchase - b.purchase);
for (let i = 1; i < seq.length; i++) {
const prevDpa = seq[i - 1];
const curDpa = seq[i];
if (!prevDpa || !curDpa) continue;
const earliest = Math.min(prevDpa.purchase + 60, prevDpa.use);
if (curDpa.purchase < earliest) {
pushProblem(
`プラン${plan.slot}：DPAの購入順序が公式ルール（次のDPAは、前の購入から60分後、または前のパスの利用開始時刻の早い方から購入可能）を満たしていません（「${prevDpa.name}」の次に買う「${curDpa.name}」は ${fmtMinutesOfDay(earliest)} 以降でなければ買えません。現在の購入時刻は ${fmtMinutesOfDay(curDpa.purchase)}）`,
);
}
}
// DPA eligibility and money are judged per PURCHASE INSTANCE
// (facility × purchase event), not per row: money moves at
// purchase, so one purchase counts once — at the fresh fact
// price — however many rows (purchase-event row and/or usage
// rows) represent it. A unit price stated on a usage row is
// ignored; only a purchase-event row's stated price is
// cross-checked against the fact price (class 2: 計上不一致）.
if (factsUsable) {
const instances = groupDpaPurchaseInstances(
plan.items,
isDpaPass,
parseTimeLabel,
);
for (const inst of instances) {
const key = facilityNameKey(inst.name);
const fact = gate.factsByKey.get(key);
if (!fact) {
const dpaUnverifiedEntry =
`${inst.name}のDPA：未確認（正規化ファクトのビルドの母集合にこの施設が含まれていないため）`;
pushUnverified(dpaUnverifiedEntry);
pushFactUnverified(dpaUnverifiedEntry);
} else if (fact.status === "not_eligible") {
pushProblem(
`プラン${plan.slot}「${inst.name}」：ディズニー・プレミアアクセスの対象から外れています（正規化ファクト（ビルド #${gate.build?.id}）で対象外と記録されています）`,
);
} else if (fact.status === "unknown") {
const dpaUnverifiedEntry =
`${inst.name}のDPA：未確認（正規化ファクトで状態が不明のため：${fact.unknownReason ?? "理由なし"}）`;
pushUnverified(dpaUnverifiedEntry);
pushFactUnverified(dpaUnverifiedEntry);
} else {
const periodReason = isIsoDate(set.visitDate)
? dpaPeriodExclusionReason(fact, set.visitDate)
: null;
if (periodReason) {
pushProblem(
`プラン${plan.slot}「${inst.name}」：DPAの適用期間（${dpaPeriodRangeText(fact)}）では、来園日（${isoDateJa(set.visitDate ?? "")}）は${periodReason}のため、この来園日時点では対象外になりました`,
);
}
const price = fact.priceJpy;
if (price != null) {
const oldPrice = originalPriceByKey.get(key);
if (
oldPrice != null &&
oldPrice !== price &&
!priceChangeSeen.has(key)
) {
priceChangeSeen.add(key);
pushProblem(
`プラン${plan.slot}「${inst.name}」：DPA単価が変わりました（作成時 ${oldPrice.toLocaleString("ja-JP")}円 → 現在 ${price.toLocaleString("ja-JP")}円）`,
);
}
for (const prow of inst.purchaseRows) {
if (
prow.unitPriceJpy != null &&
prow.unitPriceJpy !== price
) {
pushProblem(
`プラン${plan.slot}「${inst.name}」：購入イベント行の単価（${prow.unitPriceJpy.toLocaleString("ja-JP")}円）が、現在の公式単価（${price.toLocaleString("ja-JP")}円）と一致しません（DPA費用の計上不一致・クラス2）`,
);
}
}
if (!periodReason) {
// The multiplier is the purchase row's stored headcount
// (owner's ruling, 2026-11-17); a legacy purchase row
// without one keeps the party size, so its amounts are
// judged exactly as they were saved.
expectedDpaTotal +=
price * (inst.purchaseRows[0]?.purchaseCount ?? partySize);
}
}
}
}
}
// Money checks need the recorded breakdown; sets saved before
// breakdowns existed have none, and there is nothing honest to
// compare — the checks are skipped for those plans, not failed.
const allLines = plan.costBreakdown;
if (allLines.length > 0) {
const dpaLines = allLines.filter((l) =>
/DPA|プレミアアクセス/.test(l.label),
);
const dpaLineTotal = dpaLines.reduce(
(sum, l) => sum + (l.amountJpy ?? 0),
0,
);
if (planDpaRows > 0 && factsUsable) {
if (dpaLines.length === 0) {
pushProblem(
`プラン${plan.slot}：DPAを使う項目があるのに、費用内訳にDPAの項目がありません`,
);
} else if (dpaLines.some((l) => l.amountJpy == null)) {
pushProblem(
`プラン${plan.slot}：費用内訳のDPA項目に金額が入っていません`,
);
} else if (dpaLineTotal !== expectedDpaTotal) {
pushProblem(
`プラン${plan.slot}：DPA費用の内訳（${dpaLineTotal.toLocaleString("ja-JP")}円）が、購入インスタンスごとに今回の公式単価×対象人数（購入行に保存された人数。対象人数が無い旧形式の購入行は参加者総数${partySize}名）で再計算した金額（${expectedDpaTotal.toLocaleString("ja-JP")}円）と一致しません`,
);
}
} else if (planDpaRows === 0 && dpaLineTotal > 0) {
pushProblem(
`プラン${plan.slot}：DPAを使う項目が無いのに、費用内訳にDPA費用（${dpaLineTotal.toLocaleString("ja-JP")}円）が含まれています`,
);
}
if (
plan.estimatedCostJpy != null &&
allLines.every((l) => l.amountJpy != null)
) {
const sum = allLines.reduce((s, l) => s + (l.amountJpy ?? 0), 0);
if (sum !== plan.estimatedCostJpy) {
pushProblem(
`プラン${plan.slot}：費用内訳の合計（${sum.toLocaleString("ja-JP")}円）が、概算費用の総額（${plan.estimatedCostJpy.toLocaleString("ja-JP")}円）と一致しません`,
);
}
}
}
}
return {
problems,
unverified,
factUnverified,
dpaExtracted: [...dpaExtracted.values()],
partySize,
gate,
};
}

// Assignment for a bulk re-verification: re-fetch the official data
// for the set's visit date and hand it to savePlanVerification. The
// task has NO means to change a plan — it only fetches and reports,
// exactly like the generation assignment's verification-data step.
function buildVerificationAssignment(
set: typeof schema.planSets.$inferSelect,
requestId: number,
planSummary: string,
): string {
const officialTop =
set.park === "land"
? "https://www.tokyodisneyresort.jp/tdl/attraction.html"
: "https://www.tokyodisneyresort.jp/tds/attraction.html";
const today = new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
});
return [
`既存プランの「一括検証」のために、公式情報を取り直すタスクです。今日は ${today} です。`,
`対象は、すでに作成済みのプランセット「${set.title}」（${parkName(set.park)}、来園日：${set.visitDate ?? "未定"}）です。このタスクの仕事は、来園日についての最新の公式情報を取得して、保存アクション（savePlanVerification）に渡すことだけです。プランの作成・変更は一切行いません（このタスクにプランを変更する手段はありません）。検証はアプリ側（サーバー）が、あなたが渡した取得データを、保存済みのプランと機械的に照合して行います。`,
``,
`検証対象のプランの行（何の公演時刻・施設を確認すべきかの把握用）:`,
planSummary,
``,
`手順:`,
`1. ${acquisitionPlanSteps(set.park, set.visitDate)}公式サイト（${officialTop} を起点に、対象日のパークカレンダー/休止情報ページ、ディズニー・プレミアアクセスの案内ページ、エンターテイメント（ショー/パレード）のページ、チケットの案内ページ、施設全一覧のページ）を実際に開いて読み、来園日について次を取得すること（取得計画で reuse と判定されたノードについては開かず、指定スナップショットで確認したものとする）。(i) 営業時間（公式表記そのまま）と、対象日の休止施設の一覧。(ii) 【正規化ソース層】${CANONICAL_FETCH_STEPS}fetch と判定されたノードの正典ソース（DPA案内ページ、施設全一覧＝アトラクション＋エンターテイメント、対象日の営業時間・休止情報、公演スケジュール、チケット価格、告知一覧）を取得し、読む前に saveSourceSnapshots で生テキストのまま保存し、保存したスナップショットと reuse ノードの指定スナップショットから、施設全一覧を母集合として全施設分のDPAファクト（対象／対象外／不明＋理由、単価、適用期間、根拠スナップショットからの逐語抜粋）を構築して saveNormalizedFacts で登録すること。抜粋は保存した生テキストから一字も変えずに切り取ること（単価と期間の日付は抜粋内に表記が無ければ登録できない。行に付いた「対象期間：2026年11月30日（月）～」のような表記も期間として読み取る）。対象外の根拠は evidenceKind="universe_listing"（施設全一覧側の施設名を含む抜粋）でよい。登録結果の missing が空＝完全なビルドになるまで、欠けた施設を不明＋理由で埋めて再登録すること。再検証のDPA照合はこの新しい完全なビルドのファクトだけが根拠になる。ファクトが作れなかった場合（DPAページが取得できない等）は、factBuildId を渡さないこと（DPAの照合は未確認として記録される）。(iii) 上のプランに含まれるショー/パレードについて、来園日の公式公演時刻。(iv) チケットの現在の単価（案内ページを開いて確認し、出典として sources に含めること）。`,
`2. 取得できなかった項目は、該当欄を空/null にし、verification.unverified に「◯◯：未確認（理由）」の形で入れること。取得していないデータを推測で入れてはいけない（入れれば照合はその偽データで通ってしまう——それが一番悪い）。`,
`3. 結果を保存アクション（savePlanVerification、requestId=${requestId}、planSetId=${set.id}）に渡すこと。factBuildId には手順1(ii)で登録した新しい完全なファクトビルドの id を入れること（作れなかった場合は渡さない）。parkHours には対象日の営業時間（公式表記）を、sources には実際に読んだ公式ページの {title, url} を入れる。verification として {fetchedAt: 取得日（今日の日付 ${today}）, dpaSource: DPA案内ページの {title, url}（取得できなければ null）, calendarSource: 休止・営業時間を確認したページの {title, url}, entertainmentSource: 公演時刻を確認したページの {title, url}, dpaSnapshotText: 渡さなくてよい（生テキストは source_snapshots に保存済みで、照合はファクトだけで行われる）, closedFacilities: 対象日の休止施設名の配列, showTimes: [{name: ショー/パレード名, times: ["9:40", ...]（来園日の公式公演時刻）}] の配列, unverified: 照合できなかった項目の説明の配列（無ければ空配列）} を入れること。`,
`4. 公式サイトが全く読めない等で、検証の材料が何も取得できない場合は、失敗報告アクション（reportPlanVerificationFailure、requestId=${requestId}）で理由を伝えること。どちらのアクションも呼ばずに終了しないこと。`,
].join("\n");
}

// Starts one bulk re-verification of a finished plan set. Shared by
// the day-before dialog's button (announce: the start is posted to
// the chat, because the user is looking at a plan tab, not the chat)
// and the chat 「検証して」 route (no announcement — the chat reply
// itself is written from this start result). A set that already has
// a live verification request is not started twice.
async function startPlanVerification(
ctx: Ctx,
planSetId: number,
trigger: "dialog" | "chat" | "manual",
announce: boolean,
): Promise<
| { ok: true; requestId: number; alreadyRunning: boolean; title: string }
| { ok: false; error: string }
> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, planSetId))
.limit(1);
const set = setRows[0];
if (!set) return { ok: false, error: "対象のプランが見つかりませんでした。" };
if (set.status !== "done") {
return {
ok: false,
error: "作成済みのプランだけが検証できます。",
};
}
const pending = await db
.select()
.from(schema.verificationRequests)
.where(
and(
eq(schema.verificationRequests.planSetId, set.id),
eq(schema.verificationRequests.status, "pending"),
),
);
const live = pending.find(
(r) => Date.now() - r.createdAt.getTime() <= VERIFICATION_STALE_MS,
);
if (live) {
return { ok: true, requestId: live.id, alreadyRunning: true, title: set.title };
}
const inserted = await db
.insert(schema.verificationRequests)
.values({ planSetId: set.id, trigger })
.returning({ id: schema.verificationRequests.id });
const row = inserted[0];
if (!row) throw new Error("startPlanVerification: insert returned no rows");
const requestId = row.id;

const spawnedOk = await spawnVerificationAttempt(ctx, set, requestId);
if (!spawnedOk) {
ctx.invalidateQueries();
return {
ok: false,
error: "一括検証を開始できませんでした。少し時間をおいて、もう一度お試しください。",
};
}
if (announce) {
await db.insert(schema.messages).values({
role: "assistant",
text: `「${set.title}」の一括検証を開始しました。公式情報を取り直して現在のプランと照合します。結果はこのチャットでお知らせします。（プランの内容は変更しません）`,
});
}
ctx.invalidateQueries();
return { ok: true, requestId, alreadyRunning: false, title: set.title };
}

// Spawns the verification task for an EXISTING pending
// verification request, through the task manager
// （裏タスク管理クラス）: the attempt is begun here (or handed
// in by the manager's retry, which re-runs the SAME request —
// the request row is created exactly once, by
// startPlanVerification). A spawn failure is the manager's to
// retry / exhaust; on exhaustion the manager has already marked
// the request failed and posted the common congestion text to
// the chat.
async function spawnVerificationAttempt(
ctx: Ctx,
set: typeof schema.planSets.$inferSelect,
requestId: number,
mgrAttempt?: { runId: number; attemptId: number },
): Promise<boolean> {
const db = ctx.db<typeof schema>();
// A compact picture of what is being verified, so the task knows
// which shows' times and which facilities to fetch for.
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const summarySections: string[] = [];
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
summarySections.push(
`プラン${plan.slot}「${plan.title}」:\n` +
itemRows
.map(
(it) =>
`- ${it.timeLabel ?? "時刻なし"} ${it.name}（${it.kind}${it.passType ? `、${it.passType}` : ""}）`,
)
.join("\n"),
);
}
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "verification", requestId }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildVerificationAssignment(set, requestId, summarySections.join("\n")),
{
expectsAction: "savePlanVerification",
dedupeKey: `plan-verification-${requestId}`,
},
);
ctx.invalidateQueries();
return spawnOutcome !== "exhausted";
}

// ---------- verification package （他のAIで2重検証） ----------
//
// The owner-facing "check this plan with another AI" package: a
// structured plain-text bundle assembled ONLY from data this app
// already saved (the set's conditions snapshot, the plan and its
// rows, the set's verification record and re-verification history,
// the normalized facts of the set's fact build, restaurant facts,
// the facility dictionary, the estimation / official sources, park
// hours and the set notes). Nothing is fetched and nothing is
// inferred here: a piece of information the saved data cannot
// supply is stated in the package as 取得できなかった, never
// filled in by guesswork. The verification itself runs on the
// OTHER AI's allowance — this app only assembles and hands over
// the package (the client copies it to the clipboard).

// The verification request that opens every package, verbatim
// (owner's fixed wording, 2026-11-16). Only a title line may be
// added before it.
const VERIFICATION_REQUEST_TEXT = `あなたは旅行プランの検証者です。以下に、東京ディズニーリゾートの1日の訪問プランと、その作成に使った条件・前提・参照情報をすべて渡します。このプランが正しいかどうか、独立した第三者として検証してください。
検証の観点（観点ごとに判定してください）：
1. 営業時間との整合：全行の時刻が対象日の営業時間の範囲内か。入園・退園の条件と矛盾しないか。
2. 休止・対象外施設の混入：対象日に休止している施設、ディズニー・プレミアアクセス（DPA）の対象でない施設をDPA前提にしている行が混ざっていないか。
3. 料金計算の正しさ：DPAの単価×対象人数（その購入で実際に利用する人数）の小計、費用内訳の合計、予算との差が、渡した数値から再計算して一致するか。
4. 待ち時間の妥当性：推定待ち時間が、前提の混雑レベルと各施設の人気・処理能力から見て大きく外れていないか。
5. 移動の現実性：行と行の間の移動時間と距離、待ち時間と所要時間の積み上げで、スケジュールが物理的に成立しているか（時刻の重なりや不足がないか）。
判定の形式：
- 観点ごとに「妥当」か「弱い」かを述べ、弱い場合は理由と、該当する行（時刻と施設名）を具体的に示してください。
- 矛盾や計算の誤りがあれば、具体的に指摘してください。問題のない観点は「妥当」と述べてください。
- 待ち時間や混雑は推定値です。推定については、事実の誤り（営業時間・休止・対象可否・単価・計算の誤り）と、推定の相違（あなたの見積もりと異なること）を区別してください。推定の相違はそれだけで誤りとはせず、どの程度外れているかを根拠とともに述べてください。
- 渡した情報だけでは判定できない観点があれば「判定不能（理由）」としてください。推測で補わないでください。`;

const VERIFY_KIND_LABELS: Record<string, string> = {
  attraction: "アトラクション",
  show: "ショー",
  parade: "パレード",
  restaurant: "レストラン（食事）",
  break: "休憩",
  move: "移動",
  other: "その他",
  purchase: "DPA購入イベント",
  first10: "最初の10分（表示専用ブロック）",
};

function yenText(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}

// "約850m" / "約1.6km" style label (same format as the client's
// formatWalkDistance, duplicated because the client module cannot
// be imported here).
function walkDistanceText(m: number): string {
  if (m >= 1000) return `約${(m / 1000).toFixed(1)}km`;
  return `約${Math.round(m / 10) * 10}m`;
}

async function buildVerificationPackageText(
  ctx: Ctx,
  planSetId: number,
  slot: "A" | "B" | "C",
): Promise<string> {
  const db = ctx.db<typeof schema>();
  const setRows = await db
    .select()
    .from(schema.planSets)
    .where(eq(schema.planSets.id, planSetId))
    .limit(1);
  const set = setRows[0];
  if (!set) {
    throw new Error(
      `getVerificationPackage: plan set ${planSetId} not found`,
    );
  }
  if (set.status !== "done") {
    throw new Error("作成が完了したプランだけ検証パッケージを作れます。");
  }
  const data = await loadExportData(ctx, planSetId);
  if (!data) {
    throw new Error(
      `getVerificationPackage: plan set ${planSetId} not found`,
    );
  }
  const plan = data.plans.find((p) => p.slot === slot);
  if (!plan) {
    throw new Error(
      `getVerificationPackage: プラン${slot}がセット「${set.title}」にありません。`,
    );
  }
  const items = plan.items;
  const condParsed = parseSnapshotConditions(set);
  const cond = condParsed.conditions;
  const snapshotParty = parseSnapshotParty(set.conditionsSnapshot);
  const party =
    set.setType === "same_day" && set.sameDayAdults != null
      ? {
          adults: set.sameDayAdults,
          children: set.sameDayChildren ?? 0,
        }
      : (snapshotParty ?? { adults: cond.adults, children: cond.children });
  const partySize = party.adults + party.children;
  const verification = data.verification;
  const reverifications = parseReverificationsJson(set.reverificationsJson);

  // Normalized DPA facts of THIS set's fact build. The gate is the
  // primary source; a set whose build cannot be identified falls
  // back to the facts quoted inside its verification record, and a
  // facility with neither is stated as ファクトなし below.
  const gate = await loadDpaFactGate(ctx, set.factBuildId, set.park);
  type PkgFact = {
    name: string;
    status: "eligible" | "not_eligible" | "unknown";
    priceJpy: number | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    unknownReason: string | null;
  };
  const factByKey = new Map<string, PkgFact>();
  const gateFacts: PkgFact[] =
    gate.displayFacts.length > 0
      ? gate.displayFacts
      : (verification?.dpaFacts ?? []);
  for (const f of gateFacts) {
    factByKey.set(facilityNameKey(f.name), {
      name: f.name,
      status: f.status,
      priceJpy: f.priceJpy,
      effectiveFrom: f.effectiveFrom,
      effectiveTo: f.effectiveTo,
      unknownReason: f.unknownReason,
    });
  }
  const factBuildIdentified = gate.build != null || set.factBuildId != null;

  // Facility dictionary rows for the plan's facilities (static
  // attributes only — area / official URL / official duration).
  const facilityNames: string[] = [];
  for (const it of items) {
    if (it.kind === "first10") continue;
    if (!facilityNames.some((n) => facilityNameKey(n) === facilityNameKey(it.name))) {
      facilityNames.push(it.name);
    }
  }
  const dictByKey = new Map<string, FacilityRow>();
  for (const name of facilityNames) {
    const row = await findFacility(ctx, set.park, name);
    if (row) dictByKey.set(facilityNameKey(name), row);
  }

  // Restaurant facts for the plan's restaurant rows, with the
  // grounds snapshot's URL / fetch instant where obtainable.
  type PkgRestaurant = {
    name: string;
    reservationType: string;
    mobileOrder: string;
    serviceType: string | null;
    snapshotUrl: string | null;
    snapshotFetchedAt: string | null;
    factRecordedAt: string;
  };
  const restaurantByKey = new Map<string, PkgRestaurant | null>();
  for (const it of items) {
    if (it.kind !== "restaurant") continue;
    const key = facilityNameKey(it.name);
    if (restaurantByKey.has(key)) continue;
    const fact = await findCurrentRestaurantFact(ctx, set.park, it.name);
    if (!fact) {
      restaurantByKey.set(key, null);
      continue;
    }
    let snapshotUrl: string | null = null;
    let snapshotFetchedAt: string | null = null;
    const snapRows = await db
      .select()
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.id, fact.snapshotId))
      .limit(1);
    const snap = snapRows[0];
    if (snap) {
      snapshotUrl = snap.url;
      snapshotFetchedAt = snap.fetchedAt.toISOString();
    }
    restaurantByKey.set(key, {
      name: fact.name,
      reservationType: fact.reservationType,
      mobileOrder: fact.mobileOrder,
      serviceType: fact.serviceType,
      snapshotUrl,
      snapshotFetchedAt,
      factRecordedAt: fact.createdAt.toISOString(),
    });
  }

  // Travel legs, recomputed with the server's own deterministic
  // model (the same computeLegs the save path used) purely to
  // derive each leg's walking distance: straight-line distance
  // between the two stops' coordinates × the distance-dependent
  // detour factor. The travel MINUTES quoted per row are the
  // stored travelMin values, not a recomputation.
  const speed: WalkingSpeed =
    set.walkingSpeed ?? cond.walkingSpeed ?? "slightly_slow";
  const matrix = await loadAreaMatrix(ctx, set.park);
  const legs = computeLegs(
    items.map((it) => ({
      name: it.name,
      kind: it.kind,
      lat: it.lat,
      lng: it.lng,
      area: it.area,
      durationMin: it.durationMin ?? noteDurationMin(it.note),
    })),
    speed,
    matrix,
  );
  const legWalkM: (number | null)[] = items.map((it, i) => {
    if (it.kind === "purchase" || it.kind === "first10") return null;
    const leg = legs[i];
    if (!leg || leg.distM == null) return null;
    return leg.distM * detourFactor(leg.distM);
  });
  let totalTravelMin = 0;
  let travelLegCount = 0;
  let travelMissingCount = 0;
  let totalWalkM = 0;
  let walkLegCount = 0;
  items.forEach((it, i) => {
    if (it.kind === "purchase" || it.kind === "first10") return;
    if (i === 0) return;
    if (it.travelMin != null) {
      totalTravelMin += it.travelMin;
      travelLegCount++;
    } else {
      travelMissingCount++;
    }
    const w = legWalkM[i];
    if (w != null) {
      totalWalkM += w;
      walkLegCount++;
    }
  });

  const isDpaPass = (passType: string | null | undefined): boolean =>
    passType != null && /プレミアアクセス|DPA/i.test(passType);
  const dpaInstances = groupDpaPurchaseInstances(
    items,
    isDpaPass,
    parseTimeLabel,
  );

  const lines: string[] = [];
  const push = (...ls: string[]): void => {
    lines.push(...ls);
  };

  push(
    `タイトル：他のAIによる2重検証用パッケージ ― プラン${plan.slot}「${plan.title}」（セット「${set.title}」）`,
    ``,
    VERIFICATION_REQUEST_TEXT,
    ``,
    `――――――――――――――――――――――――`,
    ``,
  );

  // ---- 1. 条件 ----
  push(
    `■ 1. 条件（このプランが作られた条件）`,
    `対象日：${set.visitDate ?? "取得できなかった（セットに対象日が保存されていません）"}`,
    `パーク：${parkName(set.park)}`,
    `人数構成：大人${party.adults}人／子ども${party.children}人（合計${partySize}人）${cond.childrenAges ? `／子どもの年齢：${cond.childrenAges}` : "／子どもの年齢：保存された条件に記載なし"}`,
    `予算：${cond.budgetJpy != null ? yenText(cond.budgetJpy) : "取得できなかった（保存された条件に予算の記載がありません）"}`,
    `入園時刻：${cond.entryTime ?? "取得できなかった（保存された条件に記載がありません）"}`,
    `退園時刻：${cond.exitTime ?? (set.setType === "same_day" ? "閉園まで（当日検索のため退園時刻の指定なし）" : "取得できなかった（保存された条件に記載がありません）")}`,
    `歩く速さ：${WALKING_SPEED_LABELS[speed]}（${WALKING_SPEED_M_PER_MIN[speed]}m/分・直線距離基準）`,
  );
  if (set.setType === "same_day") {
    push(
      `種別：当日検索（来園当日に作られた単独プラン）`,
      `現在地点：${set.sameDayLocation ?? "取得できなかった"}`,
      `開始時刻：${set.sameDayStartTime ?? "取得できなかった"}`,
      `ご要望：${set.sameDayRequest ?? "（入力なし）"}`,
    );
  }
  const pri = data.priorities;
  if (pri.model === "unified") {
    push(`重視する点（全文）：${pri.unified ?? "（未入力）"}`);
  } else {
    push(
      `重視する点（全文・旧形式のスナップショット）：`,
      `プランAの重視すること：${pri.A ?? "（未入力）"}`,
      `プランBの重視すること：${pri.B ?? "（未入力）"}`,
      `プランCの重視すること：${pri.C ?? "（未入力）"}`,
      `共通して重視すること：${pri.common ?? "（未入力）"}`,
    );
  }
  if (condParsed.missing.length > 0) {
    push(
      `条件スナップショットから読み取れなかった項目：${condParsed.missing.join("、")}（その項目は未設定として扱われました）`,
    );
  }
  push(
    `条件スナップショット全文（保存された原文）：`,
    set.conditionsSnapshot ?? "取得できなかった（条件スナップショットが保存されていません）",
    ``,
  );

  // ---- 2. プランの前提 ----
  push(
    `■ 2. プランの前提`,
    `プラン${plan.slot}のタイトル：${plan.title}`,
    `プランの概要（summary 全文）：`,
    plan.summary ?? "取得できなかった（概要が保存されていません）",
    `混雑予想（セットの前提）：${set.crowdLevel != null ? `段階${set.crowdLevel}／5` : "取得できなかった（このセットには混雑予想が保存されていません）"}`,
    `混雑予想の根拠（crowdBasis 全文）：${set.crowdBasis ?? "取得できなかった（根拠が保存されていません）"}`,
  );
  if (plan.crowdScenario != null && plan.crowdScenarioLevel != null) {
    push(
      `このプランの混雑シナリオ：${CROWD_SCENARIO_LABELS[plan.crowdScenario]}（実効レベル ${plan.crowdScenarioLevel}／5 相当で待ち時間を推定）`,
    );
  } else {
    push(
      `このプランの混雑シナリオ：記録なし（${set.setType === "same_day" ? "当日検索のためシナリオ分けなし" : "混雑予想が保存されていないセットのため取得できなかった"}）`,
    );
  }
  const planFactors = (verification?.crowdFactors ?? []).filter(
    (f) => f.slot === plan.slot || f.slot == null,
  );
  if (planFactors.length > 0) {
    push(
      `施設ごとの実効混雑係数（基礎推定に掛けた係数・このプラン分）：`,
      ...planFactors.map((f) => `- ${f.name}：${crowdFactorLabel(f.factor)}`),
    );
  }
  push(
    `待ち時間について：スケジュール内の待ち時間はすべて推定値です（公式の確定値ではありません）。推定の材料は次の参考サイトです。`,
  );
  if (data.estimateSources.length > 0) {
    push(
      ...data.estimateSources.map(
        (s) =>
          `- 推定の出典：${s.title}／${s.url}／取得日：${s.fetchedAt ?? "取得できなかった（取得日の記録なし）"}`,
      ),
    );
  } else {
    push(
      `- 推定の出典：取得できなかった（このセットには推定の出典が保存されていません）`,
    );
  }
  const overBudget =
    cond.budgetJpy != null &&
    plan.estimatedCostJpy != null &&
    plan.estimatedCostJpy > cond.budgetJpy;
  if (overBudget) {
    push(
      `予算超過の開示：このプランの合計（${yenText(plan.estimatedCostJpy as number)}）は予算（${yenText(cond.budgetJpy as number)}）を ${yenText((plan.estimatedCostJpy as number) - (cond.budgetJpy as number))} 超過しています。開示文面は独立した項目としては保存されておらず、プランの概要（summary 全文・本節の冒頭）に含める形で開示されています。概要の全文をそのまま判定材料にしてください。`,
    );
  } else if (cond.budgetJpy != null && plan.estimatedCostJpy != null) {
    push(`予算超過の開示：なし（合計は予算以内です）`);
  } else {
    push(
      `予算超過の開示：判定できなかった（予算または合計が保存されていないため）`,
    );
  }
  if (plan.restaurantWaitNote) {
    push(`レストランの待ち時間に関する注意書き：${plan.restaurantWaitNote}`);
  }
  const unconfirmedItems = items.filter((it) => it.unconfirmedReason);
  if (unconfirmedItems.length > 0) {
    push(
      `未確定の行の一覧（行自体に未確定の印と理由が保存されています）：`,
      ...unconfirmedItems.map(
        (it) =>
          `- ${it.timeLabel ?? "時刻なし"} ${it.name}：未確定（${it.unconfirmedReason}）${it.unconfirmedNote ? ` ― ${it.unconfirmedNote}` : ""}`,
      ),
    );
  } else {
    push(`未確定の行：なし`);
  }
  push(``);

  // ---- 3. スケジュール ----
  push(
    `■ 3. スケジュール（保存された順序＝時刻順。全行）`,
    `移動時間（travelMin）はアプリ側が機械計算した保存値です：2地点の座標間の直線距離 ÷ 歩く速さ × 迂回係数（距離〜100m ×1.1／100〜300m ×1.2／300〜600m ×1.25／600m〜 ×1.3。エリア間マトリクスがある区間はその典型分数との大きい方）× 1.2（余裕）、切り上げ・最小5分。`,
    `歩行距離概算は、座標のある行同士について「直線距離 × 上記の迂回係数」で算出しています。座標が無い行が絡む区間は算出できないため、その行には移動時間のみを示し、距離は「算出できなかった」と明記します。`,
    ``,
  );
  items.forEach((it, i) => {
    const parts: string[] = [
      `${i + 1}. ${it.timeLabel ?? "時刻なし"}`,
      `種別：${VERIFY_KIND_LABELS[it.kind] ?? it.kind}`,
      `施設名：${it.name}`,
    ];
    if (it.area) parts.push(`エリア：${it.area}`);
    if (it.kind === "purchase" || it.kind === "first10") {
      parts.push(`移動時間：0分（${it.kind === "purchase" ? "購入イベント行のため移動なし" : "表示専用ブロックのため移動なし"}）`);
    } else if (i === 0) {
      parts.push(`移動時間：―（先頭の行のため移動区間なし）`);
    } else if (it.travelMin != null) {
      const w = legWalkM[i];
      parts.push(
        w != null
          ? `移動時間：${it.travelMin}分／歩行距離概算：${walkDistanceText(w)}`
          : `移動時間：${it.travelMin}分／歩行距離概算：算出できなかった（座標が無い行を含む区間のため、移動時間のみ）`,
      );
    } else {
      parts.push(
        `移動時間：取得できなかった（座標が引けず機械計算できなかった区間）／歩行距離概算：算出できなかった`,
      );
    }
    // Restaurant waits are not modeled (owner design, 記録AD):
    // a restaurant row's stored estWaitMin is never printed here
    // (the plan premise's restaurant wait note still is, above).
    if (it.kind !== "restaurant" && it.estWaitMin != null) {
      parts.push(`推定待ち時間：${it.estWaitMin}分`);
    } else if (it.kind === "attraction" || it.kind === "show") {
      parts.push(`推定待ち時間：取得できなかった（保存されていません）`);
    }
    if (it.durationMin != null) {
      parts.push(`所要時間：${it.durationMin}分（公式所要時間）`);
    } else {
      const noteDur = noteDurationMin(it.note);
      if (noteDur != null) {
        parts.push(`所要時間：${noteDur}分（プランの備考より）`);
      }
    }
    if (it.passType) parts.push(`パスの種別：${it.passType}`);
    if (it.kind === "purchase") {
      parts.push(
        `購入時刻：${it.dpaPurchaseTime ?? it.timeLabel ?? "取得できなかった"}`,
        `単価：${it.unitPriceJpy != null ? yenText(it.unitPriceJpy) : "取得できなかった（購入行に単価が保存されていません）"}`,
        ...(it.purchaseCount != null
          ? [`対象人数：${it.purchaseCount}人（その施設を実際に利用する人数）`]
          : []),
      );
    } else if (it.dpaPurchaseTime) {
      parts.push(`DPA購入時刻：${it.dpaPurchaseTime}`);
    }
    if (it.unconfirmedReason) {
      parts.push(
        `未確定（${it.unconfirmedReason}）${it.unconfirmedNote ? `：${it.unconfirmedNote}` : ""}`,
      );
    }
    if (it.lat != null && it.lng != null) {
      parts.push(`座標：${it.lat}, ${it.lng}`);
    }
    push(parts.join("／"));
    if (it.note) push(`備考：${it.note}`);
  });
  // 待ち時間合計: the sum of the estimated waits stored on the
  // plan's rows (restaurant rows carry none in the read payload, so
  // they drop out naturally) — the same read-time derivation as the
  // plan-head summary's totalWaitMin.
  const totalWaitMin = items.reduce(
    (sum, it) => sum + (it.estWaitMin ?? 0),
    0,
  );
  push(
    ``,
    `総移動時間：${travelLegCount > 0 ? `約${totalTravelMin}分（移動時間が保存されている${travelLegCount}区間の合計${travelMissingCount > 0 ? `。ほかに移動時間が取得できなかった区間が${travelMissingCount}件あります` : ""}）` : "取得できなかった（移動時間が保存されている区間がありません）"}`,
    `歩行距離概算の合計：${walkLegCount > 0 ? `${walkDistanceText(totalWalkM)}（距離を算出できた${walkLegCount}区間の合計）` : "算出できなかった（座標から距離を算出できた区間がありません）"}`,
    `待ち時間合計：約${totalWaitMin}分（推定待ち時間が保存されている行の合計）`,
    ``,
  );

  // ---- 4. 費用内訳 ----
  push(`■ 4. 費用内訳（再計算できる形）`);
  let dpaRecomputedTotal: number | null = 0;
  if (dpaInstances.length > 0) {
    push(`DPA（購入行ごと：施設名：単価×対象人数＝小計。対象人数は、その購入でその施設を実際に利用する人数。対象人数が保存されていない旧形式の購入行は、参加者総数（大人${party.adults}＋子ども${party.children}＝${partySize}人）で小計を導出しています）：`);
    for (const inst of dpaInstances) {
      const prow = inst.purchaseRows[0];
      const fact = factByKey.get(facilityNameKey(inst.name));
      const unit =
        prow?.unitPriceJpy ?? fact?.priceJpy ?? null;
      const unitNote =
        prow?.unitPriceJpy != null
          ? "購入行に保存された単価"
          : fact?.priceJpy != null
            ? "購入行に単価が無いためファクトの単価"
            : "単価を取得できなかった";
      // The multiplier is the purchase row's stored headcount
      // (owner's ruling, 2026-11-17). A legacy purchase row
      // without one — and an instance represented only by its
      // usage row — falls back to the party size, exactly as the
      // set was saved, and the line says so.
      const storedCount = prow?.purchaseCount ?? null;
      const count = storedCount ?? partySize;
      const countNote =
        storedCount != null
          ? "購入行に保存された対象人数"
          : "対象人数が保存されていないため参加者総数で導出";
      if (unit != null) {
        const subtotal = unit * count;
        if (dpaRecomputedTotal != null) dpaRecomputedTotal += subtotal;
        push(
          `- ${inst.name}：${yenText(unit)}×${count}人＝${yenText(subtotal)}（${unitNote}／${countNote}）`,
        );
      } else {
        dpaRecomputedTotal = null;
        push(
          `- ${inst.name}：単価を取得できなかったため小計を計算できません`,
        );
      }
    }
    push(
      `DPA合計（再計算）：${dpaRecomputedTotal != null ? yenText(dpaRecomputedTotal) : "取得できなかった（単価が取れない購入がありました）"}`,
    );
  } else {
    push(`DPA：このプランにDPA購入はありません（DPA合計 0円）`);
    dpaRecomputedTotal = 0;
  }
  const otherLines = plan.costBreakdown.filter(
    (l) => !/DPA|プレミアアクセス/.test(l.label),
  );
  const dpaLines = plan.costBreakdown.filter((l) =>
    /DPA|プレミアアクセス/.test(l.label),
  );
  push(`その他の費用（保存済みの費用内訳をそのまま列挙。保存されていない単価は作っていません）：`);
  if (plan.costBreakdown.length === 0) {
    push(`- 取得できなかった（このプランには費用内訳が保存されていません）`);
  } else {
    for (const l of otherLines) {
      push(
        `- ${l.label}：${l.amountJpy != null ? yenText(l.amountJpy) : "金額が保存されていません"}${l.note ? `（${l.note}）` : ""}`,
      );
    }
    for (const l of dpaLines) {
      push(
        `- （内訳上のDPA行）${l.label}：${l.amountJpy != null ? yenText(l.amountJpy) : "金額が保存されていません"}${l.note ? `（${l.note}）` : ""} ※上の購入行ごとの再計算と照合してください`,
      );
    }
  }
  const breakdownSum = plan.costBreakdown.every((l) => l.amountJpy != null)
    ? plan.costBreakdown.reduce((s, l) => s + (l.amountJpy ?? 0), 0)
    : null;
  push(
    `内訳の合計（保存済み内訳の単純合計）：${breakdownSum != null ? yenText(breakdownSum) : "計算できなかった（金額の無い内訳行があります）"}`,
    `プランの合計（estimatedCostJpy）：${plan.estimatedCostJpy != null ? yenText(plan.estimatedCostJpy) : "取得できなかった"}`,
    `予算：${cond.budgetJpy != null ? yenText(cond.budgetJpy) : "取得できなかった（予算の保存がありません）"}`,
    `予算との差（予算 − プランの合計）：${cond.budgetJpy != null && plan.estimatedCostJpy != null ? yenText(cond.budgetJpy - plan.estimatedCostJpy) : "計算できなかった"}`,
    ``,
  );

  // ---- 5. 参照した公式情報 ----
  push(
    `■ 5. 参照した公式情報`,
    `ファクトビルド：${factBuildIdentified ? `ビルド #${set.factBuildId ?? gate.build?.id ?? "不明"}（${gate.summary ? `母集合${gate.summary.universeCount}施設／対象${gate.summary.eligibleCount}／対象外${gate.summary.notEligibleCount}／不明${gate.summary.unknownCount}／${gate.summary.complete ? "完全なビルド" : "不完全なビルド"}` : "完全性の要約は検証の記録側の情報のみ"}）` : "取得できなかった（このセットのファクトビルドを特定できませんでした）"}`,
    `プランに含まれる施設ごとのDPAファクト（そのセットのファクトビルドにおける対象可否・単価・適用期間）：`,
  );
  for (const name of facilityNames) {
    const fact = factByKey.get(facilityNameKey(name));
    if (!fact) {
      push(`- ${name}：ファクトなし（この施設のDPAファクトは取得できなかった）`);
      continue;
    }
    const statusText =
      fact.status === "eligible"
        ? "DPA対象"
        : fact.status === "not_eligible"
          ? "DPA対象外"
          : `不明${fact.unknownReason ? `（理由：${fact.unknownReason}）` : ""}`;
    const period =
      fact.effectiveFrom || fact.effectiveTo
        ? `${fact.effectiveFrom ?? "開始日の指定なし"}〜${fact.effectiveTo ?? "終了日の指定なし"}`
        : "適用期間の指定なし";
    push(
      `- ${name}：${statusText}／単価：${fact.priceJpy != null ? yenText(fact.priceJpy) : "記録なし"}／適用期間：${period}`,
    );
  }
  push(
    `対象日の営業時間：${set.parkHours ?? "取得できなかった（営業時間が保存されていません）"}`,
  );
  // Closures: quote, never reconstruct — only what the
  // verification record and the set notes actually say.
  const closureQuotes: string[] = [];
  for (const c of verification?.checks ?? []) {
    if (/休止/.test(c.label) || /休止/.test(c.result)) {
      closureQuotes.push(`検証の記録「${c.label}」：${c.result}`);
    }
  }
  for (const u of verification?.unverified ?? []) {
    if (/休止/.test(u)) closureQuotes.push(`検証の記録（未確認）：${u}`);
  }
  for (const line of (set.notes ?? "").split("\n")) {
    if (/休止/.test(line)) closureQuotes.push(`備考：${line}`);
  }
  push(`休止について（検証の記録と備考に残る内容の引用。保存されていない休止一覧は作っていません）：`);
  if (closureQuotes.length > 0) {
    push(...closureQuotes.map((q) => `- ${q}`));
  } else {
    push(
      `- 取得できなかった（検証の記録・備考に休止に関する記載がありませんでした）`,
    );
  }
  const showItems = items.filter(
    (it) => it.kind === "show" || it.kind === "parade",
  );
  push(`ショー／パレードの公演時刻（行の時刻と、検証の記録の照合結果）：`);
  if (showItems.length === 0) {
    push(`- このプランにショー／パレードの行はありません`);
  } else {
    for (const it of showItems) {
      push(`- ${it.timeLabel ?? "時刻なし"} ${it.name}（行の時刻）`);
    }
    const showChecks = (verification?.checks ?? []).filter(
      (c) =>
        /公演|ショー|エンターテイメント/.test(c.label) ||
        /公演/.test(c.result),
    );
    if (showChecks.length > 0) {
      push(
        ...showChecks.map(
          (c) => `- 検証の記録「${c.label}」：${c.result}`,
        ),
      );
    } else {
      push(
        `- 検証の記録における公演時刻の照合結果：取得できなかった（明記された照合結果が保存されていません）`,
      );
    }
  }
  const restaurantItems = items.filter((it) => it.kind === "restaurant");
  push(`レストラン行の事実（レストラン事実レイヤー。取得できる範囲で）：`);
  if (restaurantItems.length === 0) {
    push(`- このプランにレストランの行はありません`);
  } else {
    const seenRest = new Set<string>();
    for (const it of restaurantItems) {
      const key = facilityNameKey(it.name);
      if (seenRest.has(key)) continue;
      seenRest.add(key);
      const r = restaurantByKey.get(key);
      if (!r) {
        push(
          `- ${it.name}：レストラン事実を取得できなかった（現在の事実が保存されていません）`,
        );
        continue;
      }
      const resText =
        r.reservationType === "required"
          ? "予約必須"
          : r.reservationType === "ps"
            ? "プライオリティ・シーティング対象"
            : r.reservationType === "none"
              ? "予約なし（予約の経路なし）"
              : "未確認（unknown）";
      const mobText =
        r.mobileOrder === "available"
          ? "モバイルオーダー対象"
          : r.mobileOrder === "not_available"
            ? "モバイルオーダー対象外"
            : "未確認（unknown）";
      push(
        `- ${r.name}：予約形態：${resText}／モバイルオーダー：${mobText}${r.serviceType ? `／サービスタイプ：${r.serviceType}` : ""}／根拠スナップショット：${r.snapshotUrl ?? "URLを取得できなかった"}／スナップショット取得日時：${r.snapshotFetchedAt ?? "取得できなかった"}／事実の登録日時：${r.factRecordedAt}`,
      );
    }
  }
  push(`施設辞書の記録（プランに含まれる施設の静的属性）：`);
  for (const name of facilityNames) {
    const d = dictByKey.get(facilityNameKey(name));
    if (!d) {
      push(`- ${name}：施設辞書に記録なし（取得できなかった）`);
      continue;
    }
    push(
      `- ${name}：エリア：${d.area ?? "記録なし"}／公式所要時間：${d.durationMin != null ? `${d.durationMin}分` : "記録なし"}／公式URL：${d.officialUrl ?? "記録なし"}`,
    );
  }
  push(`公式出典の一覧（sources）：`);
  if (data.sources.length > 0) {
    push(...data.sources.map((s) => `- ${s.title}／${s.url}`));
  } else {
    push(`- 取得できなかった（公式出典が保存されていません）`);
  }
  push(`待ち時間推定の出典（取得日つき）：`);
  if (data.estimateSources.length > 0) {
    push(
      ...data.estimateSources.map(
        (s) =>
          `- ${s.title}／${s.url}／取得日：${s.fetchedAt ?? "取得できなかった（取得日の記録なし）"}`,
      ),
    );
  } else {
    push(`- 取得できなかった（推定の出典が保存されていません）`);
  }
  push(
    `セットの備考（notes 全文）：`,
    set.notes ?? "取得できなかった（備考が保存されていません）",
    ``,
  );

  // ---- 6. アプリ側の検証の記録 ----
  push(`■ 6. アプリ側の検証の記録（全文引用と開示）`);
  if (verification) {
    push(
      `検証の記録（作成時の照合）：照合日時：${verification.checkedAt ?? "取得できなかった"}／ファクトビルド：${verification.factBuildId != null ? `#${verification.factBuildId}` : "記録なし"}`,
    );
    if (verification.factSummary) {
      const fs = verification.factSummary;
      push(
        `ファクトビルドの完全性：母集合${fs.universeCount}施設（対象${fs.eligibleCount}／対象外${fs.notEligibleCount}／不明${fs.unknownCount}）／${fs.complete ? "完全" : "不完全"}`,
      );
      for (const u of fs.unknowns) {
        push(`- ファクト不明：${u.name}（理由：${u.reason}）`);
      }
    }
    push(`チェック項目（ラベル・結果・出典・取得日）：`);
    if (verification.checks.length > 0) {
      for (const c of verification.checks) {
        push(
          `- ${c.label}：${c.result}／出典：${c.sourceTitle ?? "記録なし"}${c.sourceUrl ? `（${c.sourceUrl}）` : ""}／取得日：${c.fetchedAt ?? "記録なし"}`,
        );
      }
    } else {
      push(`- 取得できなかった（チェック項目が保存されていません）`);
    }
    if (verification.dpaExtracted.length > 0) {
      push(
        `記録内のDPA抽出一覧：${verification.dpaExtracted.map((d) => `${d.name} ${yenText(d.priceJpy)}${d.effectiveFrom || d.effectiveTo ? `（適用期間：${d.effectiveFrom ?? "―"}〜${d.effectiveTo ?? "―"}）` : ""}`).join("、")}`,
      );
    }
    if (verification.crowdFactors.length > 0) {
      push(
        `記録内の混雑係数（全プラン分）：${verification.crowdFactors.map((f) => `${f.name}（プラン${f.slot ?? "共通"}）${crowdFactorLabel(f.factor)}`).join("、")}`,
      );
    }
    push(`未確認項目（検証の記録の全文）：`);
    if (verification.unverified.length > 0) {
      push(...verification.unverified.map((u) => `- ${u}`));
    } else {
      push(`- なし（未確認項目は記録されていません）`);
    }
  } else {
    push(
      `検証の記録：取得できなかった（このセットには検証の記録が保存されていません）`,
    );
  }
  if (reverifications.length > 0) {
    push(`再検証の履歴（作成後の照合・全文）：`);
    for (const r of reverifications) {
      push(
        `- 照合日時：${r.checkedAt}／取得日：${r.fetchedAt ?? "記録なし"}／営業時間：${r.parkHours ?? "記録なし"}`,
        `問題：${r.problems.length > 0 ? r.problems.join("／") : "なし"}`,
        `未確認：${r.unverified.length > 0 ? r.unverified.join("／") : "なし"}`,
      );
    }
  }
  push(`未確認項目と開示事項（隠さずに列挙）：`);
  const disclosures: string[] = [];
  for (const u of verification?.unverified ?? []) disclosures.push(u);
  for (const it of unconfirmedItems) {
    disclosures.push(
      `行の未確定：${it.timeLabel ?? "時刻なし"} ${it.name}（${it.unconfirmedReason}）${it.unconfirmedNote ? ` ― ${it.unconfirmedNote}` : ""}`,
    );
  }
  if (overBudget) {
    disclosures.push(
      `予算超過：合計 ${yenText(plan.estimatedCostJpy as number)} は予算 ${yenText(cond.budgetJpy as number)} を ${yenText((plan.estimatedCostJpy as number) - (cond.budgetJpy as number))} 超過しています（開示は summary 全文に含まれます）`,
    );
  }
  if (!factBuildIdentified) {
    disclosures.push(
      `ファクトビルドを特定できなかったため、DPAファクトの一部は検証の記録からの引用です`,
    );
  }
  if (gate.build && gate.summary && !gate.summary.complete) {
    disclosures.push(
      `ファクトビルド #${gate.build.id} は不完全です（母集合${gate.summary.universeCount}施設のうち、${incompleteBuildDetail(gate)}）`,
    );
  }
  if (condParsed.missing.length > 0) {
    disclosures.push(
      `条件スナップショットから読み取れなかった項目：${condParsed.missing.join("、")}`,
    );
  }
  if (travelMissingCount > 0) {
    disclosures.push(
      `移動時間が取得できなかった区間が${travelMissingCount}件あります（座標が引けなかったため）`,
    );
  }
  if (disclosures.length > 0) {
    push(...disclosures.map((d) => `- ${d}`));
  } else {
    push(`- 追加の開示事項はありません`);
  }
  push(
    ``,
    `（パッケージ終わり。プランセットID：${set.id}／プラン：${plan.slot}／作成日時：${set.createdAt.toISOString()}）`,
  );
  return lines.join("\n");
}

// ---------- actions ----------

// Registers ONE restaurant fact after full machine validation
// (validateRestaurantFact). Throws an Error listing every problem —
// the caller fixes the grounds and retries; a fact that fails
// validation is never partially stored.
async function registerRestaurantFact(
ctx: Ctx,
park: "land" | "sea",
fact: RestaurantFactInput,
): Promise<number> {
const db = ctx.db<typeof schema>();
const snapRows = await db
.select()
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.id, fact.snapshotId))
.limit(1);
const snap = snapRows[0];
if (!snap) {
throw new Error(
`saveRestaurantFacts: 「${fact.name}」の根拠スナップショット（id=${fact.snapshotId}）が見つかりません。先に saveSourceSnapshots（kind="restaurant_detail"）で、その施設の公式レストラン詳細ページを保存してください。`,
);
}
if (snap.park !== park) {
throw new Error(
`saveRestaurantFacts: 「${fact.name}」の根拠スナップショットのパークが一致しません。`,
);
}
// Browser-grade fetch requirement (owner's rules, 2026-11-18 /
// 2026-11-19): a restaurant fact may only be grounded in a detail
// page fetched with a REAL browser — this copy's own browser
// (fetchMethod "browser") or the storehouse's browser
// (fetchMethod "storehouse": the Cloudflare storehouse fetched
// the page with Browser Run; the snapshot's recorded fetchMethod
// and sourceFetchedAt are the fact's provenance record). A GET /
// text-extraction text can silently miss the page's expandable
// content, so anything else is refused as grounds.
if (snap.fetchMethod !== "browser" && snap.fetchMethod !== "storehouse") {
throw new Error(
`saveRestaurantFacts: 「${fact.name}」の根拠スナップショット（id=${fact.snapshotId}）は実ブラウザ相当で取得されていません（fetchMethod="${snap.fetchMethod}"）。レストラン詳細ページは、実ブラウザで開いて全文を取得し fetchMethod="browser" で保存するか、保管庫の束の本文を fetchMethod="storehouse" で保存してから、その snapshotId で登録してください（GET／テキスト抽出で得た本文は根拠にできません）。`,
);
}
const { errors, reservationMarkers, mobileMarkers } =
validateRestaurantFact(snap, fact);
if (errors.length > 0) {
throw new Error(
`レストランのファクトを登録できませんでした。次の問題を直して、もう一度登録してください（失敗報告はしないこと）:\n- ${errors.join("\n- ")}`,
);
}
const inserted = await db
.insert(schema.restaurantFacts)
.values({
park,
name: fact.name,
nameKey: facilityNameKey(fact.name),
serviceType:
fact.serviceType != null && fact.serviceType.trim() !== ""
? fact.serviceType
: null,
reservationType: fact.reservation.type as
| "required"
| "ps"
| "none"
| "unknown",
reservationEvidenceKind: fact.reservation.evidenceKind,
reservationEvidence: fact.reservation.evidence,
reservationAbsenceMarkersJson: reservationMarkers
? JSON.stringify(reservationMarkers)
: null,
reservationUnknownReason:
fact.reservation.type === "unknown"
? (fact.reservation.unknownReason ?? "").trim()
: null,
mobileOrder: fact.mobileOrder.type as
| "available"
| "not_available"
| "unknown",
mobileEvidenceKind: fact.mobileOrder.evidenceKind,
mobileEvidence: fact.mobileOrder.evidence,
mobileAbsenceMarkersJson: mobileMarkers
? JSON.stringify(mobileMarkers)
: null,
mobileUnknownReason:
fact.mobileOrder.type === "unknown"
? (fact.mobileOrder.unknownReason ?? "").trim()
: null,
snapshotId: snap.id,
})
.returning({ id: schema.restaurantFacts.id });
const row = inserted[0];
if (!row) throw new Error("saveRestaurantFacts: insert returned no rows");
return row.id;
}

const restaurantAxisShape = z.object({
type: z.string().min(1).max(40),
evidenceKind: z.enum(["excerpt", "absence"]),
evidence: z.string().min(1).max(4000),
unknownReason: z.string().max(500).nullable().optional(),
});


// ---------- Task manager （裏タスク管理・検証6, 2026-11-20) ----------
//
// The manager class (owner's design): the server side owns ALL
// control of background tasks and never trusts them. A task gets
// exactly two kinds of instruction from here — "start" (this
// spawn) and "cancel" (the attempt is closed server-side; the
// task is not even told). The evidence that a task started is
// its FIRST call to its attempt's own record action
// (recordTaskAttempt). Deadlines are judged from the recorded
// instants by checkTaskManager (run on a 1-minute schedule and
// callable on demand):
// - no first call within the kind's start timeout → the attempt
//   is closed as cancelled and a new attempt is spawned (retry);
// - started but not finished within the kind's total timeout →
//   same;
// - attempts exhausted → the run closes as "forced"
//   （試行回数を超えたので強制終了）.
// A run's final state is only "succeeded" or "forced" (a
// whole-test cancel is the one other way a run can close, marked
// "cancelled" with the test itself). All state is in the DB
// (task_mgr_* tables) — nothing is counted in memory.
//
// PRODUCTION INTEGRATION (2026-11-20): the manager is now the
// ONLY entry point for the app's production background tasks —
// plan creation (whole-set generation, partial replacement and
// day-of reschedule: kind 11), same-day search (12), chat
// research (13) and bulk re-verification (14). No production
// path calls ctx.agent.spawnTask directly anymore; every start
// (form button, chat judgement route, day-before dialog,
// purchase-event button, retry button) goes through
// mgrBeginAttempt + mgrSpawnForAttempt below.
//
// AUXILIARY PRODUCTION INTEGRATION (2026-11-20, owner's ruling:
// no exceptions — 100% of production background tasks under the
// manager): the three auxiliary processings that still spawned
// directly are under the manager too — the wait-time reference
// site list update (kind 15), the facility image fetch (16) and
// the one-time restaurant fact correction (17). Their completion
// marks are their own report actions (saveWaitTimeSources /
// reportWaitTimeSourcesFailure, saveItemImages /
// reportItemImagesFailure, reportRestaurantFactCorrection),
// which call mgrFinishRunForTarget directly. When one of these
// three exhausts its attempts, the failure surfaces as an
// in-app DIALOG carrying the one common text
// (MGR_CONGESTION_TEXT): the forced outcome records a notice in
// mgr_dialog_notices, getState offers the oldest unshown one,
// and the client shows it as a dialog exactly once. A production run
// carries its target (MgrTarget) in target_json; the manager's
// state stays single — one set of tables, one periodic check —
// however many production processings run at once. For a
// production attempt, the "started" mark is the task's FIRST
// recordTaskAttempt call (the assignment's first instruction),
// and the "finished" mark is the processing's normal completion,
// observed server-side: for plan creation / same-day search, the
// run log closing through a task-driven path (savePlanSet /
// savePlanReplacement success, or a failure / impossibility
// report) — mgrFinishRunForTarget is called from closeRunLog
// with the mgr flag; for research / verification, the answer /
// result being posted (saveResearchAnswer / savePlanVerification
// and their failure reports call mgrFinishRunForTarget directly).
// A retry re-runs the SAME target: a plan set is created exactly
// once, by the server, before the first attempt, and retries
// never create another. When attempts are exhausted, the run
// closes as forced and the failure surfaces with ONE common
// text (MGR_CONGESTION_TEXT): on the plan set's tab for plan
// creation / same-day search (the set / slot is marked failed,
// retryable, never left 作成中）, as a chat post for
// research / bulk verification, and as an in-app dialog for
// the three auxiliary processings (kinds 15..17).
//
// The 10 kinds, lightest to heaviest. `phases` is the exact
// sequence of record-call phases an attempt must complete, in
// order; the last one closes the attempt as succeeded.
type TaskMgrKindDef = {
  kind: number;
  label: string;
  usesBrowser: boolean;
  phases: string[];
};

const TASK_MGR_DPA_URL =
  "https://www.tokyodisneyresort.jp/tdr/guide/app_service/disneypremieraccess.html#tab-6546897=tds&attraction-more-7040603=open";
const TASK_MGR_ATTRACTION_URL =
  "https://www.tokyodisneyresort.jp/tds/attraction.html";
const TASK_MGR_TOP_URL = "https://www.tokyodisneyresort.jp/";

const TASK_MGR_KINDS: TaskMgrKindDef[] = [
  { kind: 1, label: "記録を1回呼んで終了", usesBrowser: false, phases: ["complete"] },
  { kind: 2, label: "記録→3秒待つ→記録", usesBrowser: false, phases: ["start", "end"] },
  { kind: 3, label: "記録を3回、順に呼ぶ", usesBrowser: false, phases: ["step", "step", "step"] },
  { kind: 4, label: "記録→10秒待つ→記録", usesBrowser: false, phases: ["start", "end"] },
  { kind: 5, label: "ブラウザでページを1つ開いて閉じる", usesBrowser: true, phases: ["start", "end"] },
  { kind: 6, label: "ブラウザで公式DPAページを読み、文章を保存する", usesBrowser: true, phases: ["start", "end"] },
  { kind: 7, label: "保管庫からレストラン一覧を読む", usesBrowser: false, phases: ["start", "end"] },
  { kind: 8, label: "保管庫からサイトマップを読む", usesBrowser: false, phases: ["start", "end"] },
  { kind: 9, label: "ブラウザで公式の施設一覧ページを読み、文章を保存する", usesBrowser: true, phases: ["start", "end"] },
  { kind: 10, label: "ブラウザで公式ページを2つ読み、文章を保存する", usesBrowser: true, phases: ["start", "end"] },
];

function taskMgrKindDef(kind: number): TaskMgrKindDef {
  return TASK_MGR_KINDS[kind - 1] ?? TASK_MGR_KINDS[0]!;
}

// The production kinds (11..17). Their parameters' initial
// values are the owner's integration values (2026-11-20), seeded
// by migrations 0046 (kinds 11..14) and 0047 (kinds 15..17) and
// editable afterwards from the 裏タスク管理 tab exactly like the
// test kinds'. A production attempt never completes through
// record-call phases — its completion is the processing's own
// normal completion, observed by the server (see the section
// header) — so `phases` plays no part here; a record call on a
// production attempt only ever marks its start.
type TaskMgrProdKindDef = {
  kind: number;
  label: string;
  startTimeoutSec: number;
  totalTimeoutSec: number;
  maxAttempts: number;
};

const TASK_MGR_PROD_KINDS: TaskMgrProdKindDef[] = [
  { kind: 11, label: "プラン作成（本番）", startTimeoutSec: 180, totalTimeoutSec: 2400, maxAttempts: 3 },
  { kind: 12, label: "当日検索（本番）", startTimeoutSec: 180, totalTimeoutSec: 1800, maxAttempts: 3 },
  { kind: 13, label: "調べ物（本番）", startTimeoutSec: 120, totalTimeoutSec: 600, maxAttempts: 3 },
  { kind: 14, label: "一括検証（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3 },
  { kind: 15, label: "待ち時間サイト一覧の更新（本番）", startTimeoutSec: 120, totalTimeoutSec: 600, maxAttempts: 3 },
  { kind: 16, label: "施設画像の取得（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3 },
  { kind: 17, label: "レストラン事実の訂正（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3 },
];

function taskMgrProdKindDef(kind: number): TaskMgrProdKindDef | null {
  return TASK_MGR_PROD_KINDS.find((d) => d.kind === kind) ?? null;
}

// The one common text for an attempts-exhausted abnormal end,
// verbatim (owner's fixed wording, 2026-11-20) — used for all
// seven production systems; only the place it surfaces differs
// (the plan set's tab for plan creation / same-day search, the
// AI chat for research / bulk verification, an in-app dialog
// for the wait-time site list update, the image fetch and the
// restaurant fact correction).
const MGR_CONGESTION_TEXT =
  "現在museが混雑しています。申し訳ありませんが、しばらく後に再度お試しください。";

// What a production run works on. Stored on the run row as JSON
// (task_mgr_runs.target_json); a retry re-runs exactly this.
type MgrTarget =
  | { type: "generation"; planSetId: number }
  | { type: "same_day"; planSetId: number }
  | { type: "partial"; planSetId: number; slot: "A" | "B" | "C" }
  | { type: "research"; researchId: number }
  | { type: "verification"; requestId: number }
  | { type: "wait_sources"; requestId: number }
  | { type: "item_images"; planSetId: number }
  | { type: "restaurant_correction" };

function mgrKindForTarget(target: MgrTarget): number {
  switch (target.type) {
    case "generation":
    case "partial":
      return 11;
    case "same_day":
      return 12;
    case "research":
      return 13;
    case "verification":
      return 14;
    case "wait_sources":
      return 15;
    case "item_images":
      return 16;
    case "restaurant_correction":
      return 17;
  }
}

function mgrTargetKey(target: MgrTarget): string {
  switch (target.type) {
    case "generation":
      return `generation:${target.planSetId}`;
    case "same_day":
      return `same_day:${target.planSetId}`;
    case "partial":
      return `partial:${target.planSetId}:${target.slot}`;
    case "research":
      return `research:${target.researchId}`;
    case "verification":
      return `verification:${target.requestId}`;
    case "wait_sources":
      return `wait_sources:${target.requestId}`;
    case "item_images":
      return `item_images:${target.planSetId}`;
    case "restaurant_correction":
      return `restaurant_correction`;
  }
}

function parseMgrTarget(json: string | null): MgrTarget | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (
      (o.type === "generation" || o.type === "same_day") &&
      typeof o.planSetId === "number"
    ) {
      return { type: o.type, planSetId: o.planSetId };
    }
    if (
      o.type === "partial" &&
      typeof o.planSetId === "number" &&
      (o.slot === "A" || o.slot === "B" || o.slot === "C")
    ) {
      return { type: "partial", planSetId: o.planSetId, slot: o.slot };
    }
    if (o.type === "research" && typeof o.researchId === "number") {
      return { type: "research", researchId: o.researchId };
    }
    if (o.type === "verification" && typeof o.requestId === "number") {
      return { type: "verification", requestId: o.requestId };
    }
    if (o.type === "wait_sources" && typeof o.requestId === "number") {
      return { type: "wait_sources", requestId: o.requestId };
    }
    if (o.type === "item_images" && typeof o.planSetId === "number") {
      return { type: "item_images", planSetId: o.planSetId };
    }
    if (o.type === "restaurant_correction") {
      return { type: "restaurant_correction" };
    }
    return null;
  } catch {
    return null;
  }
}

// Short human label for a production target, for the 裏タスク管理
// tab's production list.
function mgrTargetLabel(target: MgrTarget): string {
  switch (target.type) {
    case "generation":
      return `プラン作成（プランセット#${target.planSetId}）`;
    case "same_day":
      return `当日検索（プランセット#${target.planSetId}）`;
    case "partial":
      return `部分差し替え（プランセット#${target.planSetId}・プラン${target.slot}）`;
    case "research":
      return `調べ物（依頼#${target.researchId}）`;
    case "verification":
      return `一括検証（依頼#${target.requestId}）`;
    case "wait_sources":
      return `待ち時間サイト一覧の更新（依頼#${target.requestId}）`;
    case "item_images":
      return `施設画像の取得（プランセット#${target.planSetId}）`;
    case "restaurant_correction":
      return `レストラン事実の訂正`;
  }
}

// The instruction prepended to every production assignment: the
// attempt's first record call is the ONLY accepted evidence the
// task started, so it must come before anything else the task
// does. Completion needs no record call — the server observes
// the processing's own completion actions.
function mgrRecordPrefix(attemptId: number): string {
  return [
    `【裏タスク管理クラスからの必須指示（他のすべての手順より優先）】`,
    `このタスクは裏タスク管理クラスを通して開始されました。開始の証拠として、他のどのアクションよりも先に、まず recordTaskAttempt（attemptId=${attemptId}, phase="start"）を1回だけ呼んでください。この呼び出しが制限時間内に無い試行は「始まらなかった」ものとしてサーバー側で閉じられ、同じ処理が再試行されます。`,
    `終了の記録は不要です（処理の通常の完了——プランの保存・失敗報告・回答の保存など——をサーバーが検知します）。過程記録（recordRunEvent）とは別の呼び出しです。`,
  ].join("\n");
}

// Each execution's kind is picked at random from the 10 kinds
// (owner's change, 2026-11-20: the test no longer cycles
// 1→10 in order). The picked kind is stored on the run row, so
// the record shows which kind each execution ran.
function taskMgrRandomKind(): number {
  return Math.floor(Math.random() * TASK_MGR_KINDS.length) + 1;
}

// Fallback parameters, used only if a kind's row is missing from
// task_mgr_params (migration 0045 seeds the 10 test kinds with
// exactly these values: browser kinds start 180s / total 900s,
// the rest start 120s / total 300s, max 3 attempts everywhere;
// migrations 0046 / 0047 seed the production kinds 11..17 with
// the production definitions' values).
function taskMgrDefaultParams(kind: number): {
  startTimeoutSec: number;
  totalTimeoutSec: number;
  maxAttempts: number;
} {
  const prod = taskMgrProdKindDef(kind);
  if (prod) {
    return {
      startTimeoutSec: prod.startTimeoutSec,
      totalTimeoutSec: prod.totalTimeoutSec,
      maxAttempts: prod.maxAttempts,
    };
  }
  return taskMgrKindDef(kind).usesBrowser
    ? { startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3 }
    : { startTimeoutSec: 120, totalTimeoutSec: 300, maxAttempts: 3 };
}

async function taskMgrParamsFor(
  ctx: Ctx,
  kind: number,
): Promise<{ startTimeoutSec: number; totalTimeoutSec: number; maxAttempts: number }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.taskMgrParams)
    .where(eq(schema.taskMgrParams.kind, kind))
    .limit(1);
  const row = rows[0];
  if (!row) return taskMgrDefaultParams(kind);
  return {
    startTimeoutSec: row.startTimeoutSec,
    totalTimeoutSec: row.totalTimeoutSec,
    maxAttempts: row.maxAttempts,
  };
}

// The assignment handed to one attempt's task. Its whole content
// is: call this attempt's own record action in the kind's shape.
// Nothing else is ever asked of the task.
function buildTaskMgrAssignment(attemptId: number, kind: number): string {
  const rec = (phase: string, extra = "") =>
    `recordTaskAttempt（attemptId=${attemptId}, phase="${phase}"${extra}）`;
  switch (kind) {
    case 1:
      return `${rec("complete")}を1回だけ呼んでください。それで終了してよい。他のことはしないでください。`;
    case 2:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) 3秒待つ。(3) ${rec("end")}を呼ぶ。それで終了してよい。`;
    case 3:
      return `次の順で実行してください。(1) ${rec("step")}を呼ぶ。(2) 続けて${rec("step")}を呼ぶ。(3) 続けて${rec("step")}を呼ぶ。それで終了してよい。`;
    case 4:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) 10秒待つ。(3) ${rec("end")}を呼ぶ。それで終了してよい。`;
    case 5:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) ブラウザで ${TASK_MGR_TOP_URL} を開き、読み込みが終わったら閉じる（文章の取り出しはしない）。(3) ${rec("end", `, note="開いたページのタイトル"`)}を呼ぶ。それで終了してよい。`;
    case 6:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) ブラウザで ${TASK_MGR_DPA_URL} を開き、ページの文章を取り出す。(3) ${rec("end", `, text="取り出したページの文章全体"`)}を呼ぶ。それで終了してよい。`;
    case 7:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) getStorehouseRestaurants を呼び、返ってきた items の件数を数える。(3) ${rec("end", `, note="レストラン詳細の件数と available の値"`)}を呼ぶ。それで終了してよい。`;
    case 8:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) getStorehouseSitemap を呼ぶ。(3) ${rec("end", `, note="サイトマップのURL件数（無ければその旨）"`)}を呼ぶ。それで終了してよい。`;
    case 9:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) ブラウザで ${TASK_MGR_ATTRACTION_URL} を開き、ページの文章を取り出す。(3) ${rec("end", `, text="取り出したページの文章全体"`)}を呼ぶ。それで終了してよい。`;
    case 10:
      return `次の順で実行してください。(1) ${rec("start")}を呼ぶ。(2) ブラウザで ${TASK_MGR_DPA_URL} と ${TASK_MGR_ATTRACTION_URL} の2ページを順に開き、それぞれの文章を取り出す。(3) ${rec("end", `, text="2ページ分の文章を続けたもの"`)}を呼ぶ。それで終了してよい。`;
    default:
      return `${rec("complete")}を1回だけ呼んでください。それで終了してよい。`;
  }
}

// Spawns one attempt of a run: the attempt row (with its
// server-stamped spawn instant and both deadlines, from the
// kind's current parameters) is written FIRST, then the task is
// spawned with that attempt's own assignment. A spawn failure
// closes the attempt as cancelled on the spot and hands over to
// the same retry / forced logic as a timeout — a run can never
// be left with a phantom attempt.
async function spawnTaskMgrAttempt(ctx: Ctx, runId: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  const runRows = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(eq(schema.taskMgrRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run || run.status !== "running") return;
  const existing = await db
    .select()
    .from(schema.taskMgrAttempts)
    .where(eq(schema.taskMgrAttempts.runId, runId))
    .orderBy(asc(schema.taskMgrAttempts.attemptNo));
  const attemptNo = existing.length + 1;
  const params = await taskMgrParamsFor(ctx, run.kind);
  const now = new Date();
  const inserted = await db
    .insert(schema.taskMgrAttempts)
    .values({
      runId,
      attemptNo,
      spawnedAt: now,
      startDeadlineAt: new Date(now.getTime() + params.startTimeoutSec * 1000),
      totalDeadlineAt: new Date(now.getTime() + params.totalTimeoutSec * 1000),
    })
    .returning({ id: schema.taskMgrAttempts.id });
  const attempt = inserted[0];
  if (!attempt) return;
  const spawned = await ctx.agent.spawnTask(
    buildTaskMgrAssignment(attempt.id, run.kind),
    {
      expectsAction: "recordTaskAttempt",
      dedupeKey: `taskmgr-attempt-${attempt.id}`,
    },
  );
  if (!spawned.ok) {
    await db
      .update(schema.taskMgrAttempts)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        closeReason: `タスクを開始できませんでした: ${spawned.error}`,
      })
      .where(eq(schema.taskMgrAttempts.id, attempt.id));
    await afterTaskMgrAttemptClosed(ctx, runId);
  }
}

// Decides what follows a cancelled attempt: a retry (a new
// attempt) while the kind's max attempts allow, otherwise the
// run closes as forced （試行回数を超えたので強制終了） and the
// test advances. Returns what happened, for the check's report.
async function afterTaskMgrAttemptClosed(
  ctx: Ctx,
  runId: number,
): Promise<"retried" | "forced" | "none"> {
  const db = ctx.db<typeof schema>();
  const runRows = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(eq(schema.taskMgrRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run || run.status !== "running") return "none";
  if (run.testId == null) return "none";
  const testRows = await db
    .select()
    .from(schema.taskMgrTests)
    .where(eq(schema.taskMgrTests.id, run.testId))
    .limit(1);
  const test = testRows[0];
  if (!test || test.status !== "running") return "none";
  const attempts = await db
    .select()
    .from(schema.taskMgrAttempts)
    .where(eq(schema.taskMgrAttempts.runId, runId));
  const params = await taskMgrParamsFor(ctx, run.kind);
  if (attempts.length < params.maxAttempts) {
    await spawnTaskMgrAttempt(ctx, runId);
    return "retried";
  }
  const now = new Date();
  await db
    .update(schema.taskMgrRuns)
    .set({
      status: "forced",
      finalReason: "試行回数を超えたので強制終了",
      closedAt: now,
    })
    .where(eq(schema.taskMgrRuns.id, runId));
  await advanceTaskMgrTest(ctx, run.testId);
  return "forced";
}

// After a run closes (succeeded or forced): start the next
// execution, or close the test when all of them are done. Runs
// are created one at a time, strictly in sequence.
async function advanceTaskMgrTest(ctx: Ctx, testId: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  const testRows = await db
    .select()
    .from(schema.taskMgrTests)
    .where(eq(schema.taskMgrTests.id, testId))
    .limit(1);
  const test = testRows[0];
  if (!test || test.status !== "running") return;
  const runs = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(eq(schema.taskMgrRuns.testId, testId));
  const closedCount = runs.filter((r) => r.status !== "running").length;
  if (closedCount >= test.total) {
    await db
      .update(schema.taskMgrTests)
      .set({ status: "done", closedAt: new Date() })
      .where(eq(schema.taskMgrTests.id, testId));
    return;
  }
  const nextSeq = runs.length + 1;
  const kind = taskMgrRandomKind();
  const inserted = await db
    .insert(schema.taskMgrRuns)
    .values({ testId, seq: nextSeq, kind })
    .returning({ id: schema.taskMgrRuns.id });
  const run = inserted[0];
  if (!run) return;
  await spawnTaskMgrAttempt(ctx, run.id);
}

// The periodic deadline check: every open attempt — of a
// running test AND of a production run — is judged from its
// recorded instants alone. Run by the 1-minute schedule and
// callable on demand.
async function runTaskMgrCheck(
  ctx: Ctx,
): Promise<{ closedAttempts: number; retriedAttempts: number; forcedRuns: number }> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  let closedAttempts = 0;
  let retriedAttempts = 0;
  let forcedRuns = 0;
  const openAttempts = await db
    .select()
    .from(schema.taskMgrAttempts)
    .where(
      inArray(schema.taskMgrAttempts.status, ["awaiting_start", "running"]),
    );
  for (const attempt of openAttempts) {
    const runRows = await db
      .select()
      .from(schema.taskMgrRuns)
      .where(eq(schema.taskMgrRuns.id, attempt.runId))
      .limit(1);
    const run = runRows[0];
    if (!run || run.status !== "running") continue;
    const target = parseMgrTarget(run.targetJson);
    if (target) {
      // Production run. First reconcile: if the target already
      // reached its end by another path (its completion hook
      // normally closes the run before this; this is the
      // guarantee behind it), close the run to match instead of
      // judging deadlines against a finished target.
      const reconciled = await mgrReconcileProductionTarget(ctx, target);
      if (reconciled) {
        await db
          .update(schema.taskMgrAttempts)
          .set({
            status: reconciled === "succeeded" ? "succeeded" : "cancelled",
            finishedAt: now,
            closeReason:
              reconciled === "succeeded"
                ? "対象の処理は既に完了していたため、この試行を閉じた"
                : "対象の処理は既に終了していたため、この試行を閉じた",
          })
          .where(eq(schema.taskMgrAttempts.id, attempt.id));
        await db
          .update(schema.taskMgrRuns)
          .set({
            status: reconciled,
            closedAt: now,
            finalReason: "対象の処理は既に終了していたため終了",
          })
          .where(eq(schema.taskMgrRuns.id, run.id));
        closedAttempts += 1;
        continue;
      }
      // The reason names the attempt's OWN stamped window, not
      // the parameters in force now (they may have been edited
      // since this attempt was spawned).
      const startWindowSec = Math.round(
        (attempt.startDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
      );
      const totalWindowSec = Math.round(
        (attempt.totalDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
      );
      let reason: string | null = null;
      if (attempt.status === "awaiting_start" && now > attempt.startDeadlineAt) {
        reason = `開始待ちの制限時間（${startWindowSec}秒）内に最初の記録が無かったためキャンセル`;
      } else if (now > attempt.totalDeadlineAt) {
        reason = `全体の制限時間（${totalWindowSec}秒）内に終了しなかったためキャンセル`;
      }
      if (!reason) continue;
      await db
        .update(schema.taskMgrAttempts)
        .set({ status: "cancelled", finishedAt: now, closeReason: reason })
        .where(eq(schema.taskMgrAttempts.id, attempt.id));
      closedAttempts += 1;
      const outcome = await mgrAfterAttemptClosed(ctx, run.id);
      if (outcome === "retried") retriedAttempts += 1;
      if (outcome === "forced") forcedRuns += 1;
      continue;
    }
    if (run.testId == null) continue;
    const testRows = await db
      .select()
      .from(schema.taskMgrTests)
      .where(eq(schema.taskMgrTests.id, run.testId))
      .limit(1);
    const test = testRows[0];
    if (!test || test.status !== "running") continue;
    const startWindowSec = Math.round(
      (attempt.startDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
    );
    const totalWindowSec = Math.round(
      (attempt.totalDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
    );
    let reason: string | null = null;
    if (attempt.status === "awaiting_start" && now > attempt.startDeadlineAt) {
      reason = `開始待ちの制限時間（${startWindowSec}秒）内に最初の記録が無かったためキャンセル`;
    } else if (attempt.status === "running" && now > attempt.totalDeadlineAt) {
      reason = `全体の制限時間（${totalWindowSec}秒）内に終了しなかったためキャンセル`;
    }
    if (!reason) continue;
    await db
      .update(schema.taskMgrAttempts)
      .set({ status: "cancelled", finishedAt: now, closeReason: reason })
      .where(eq(schema.taskMgrAttempts.id, attempt.id));
    closedAttempts += 1;
    const outcome = await afterTaskMgrAttemptClosed(ctx, run.id);
    if (outcome === "retried") retriedAttempts += 1;
    if (outcome === "forced") forcedRuns += 1;
  }
  return { closedAttempts, retriedAttempts, forcedRuns };
}

// ---------- Task manager: production core ----------
//
// The single entry point every production start goes through.
// mgrBeginAttempt opens the run + first attempt (superseding any
// still-open run for the same target — a user-pressed リトライ
// replaces it, so the manager never carries two live runs for
// one target); the caller then hands the built assignment to
// mgrSpawnForAttempt with that attempt. A spawn failure closes
// the attempt on the spot and hands over to the same retry /
// forced logic as a timeout.

async function mgrInsertAttempt(
  ctx: Ctx,
  runId: number,
  kind: number,
  attemptNo: number,
): Promise<number> {
  const db = ctx.db<typeof schema>();
  const params = await taskMgrParamsFor(ctx, kind);
  const now = new Date();
  const inserted = await db
    .insert(schema.taskMgrAttempts)
    .values({
      runId,
      attemptNo,
      spawnedAt: now,
      startDeadlineAt: new Date(now.getTime() + params.startTimeoutSec * 1000),
      totalDeadlineAt: new Date(now.getTime() + params.totalTimeoutSec * 1000),
    })
    .returning({ id: schema.taskMgrAttempts.id });
  const attempt = inserted[0];
  if (!attempt) throw new Error("mgrInsertAttempt: insert returned no rows");
  return attempt.id;
}

async function mgrBeginAttempt(
  ctx: Ctx,
  target: MgrTarget,
): Promise<{ runId: number; attemptId: number }> {
  const db = ctx.db<typeof schema>();
  const kind = mgrKindForTarget(target);
  const key = mgrTargetKey(target);
  const now = new Date();
  const openRuns = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(
      and(
        eq(schema.taskMgrRuns.status, "running"),
        isNotNull(schema.taskMgrRuns.targetJson),
      ),
    );
  for (const r of openRuns) {
    const t = parseMgrTarget(r.targetJson);
    if (!t || mgrTargetKey(t) !== key) continue;
    await db
      .update(schema.taskMgrAttempts)
      .set({
        status: "cancelled",
        finishedAt: now,
        closeReason: "新しい実行が開始されたため、この試行を閉じた",
      })
      .where(
        and(
          eq(schema.taskMgrAttempts.runId, r.id),
          inArray(schema.taskMgrAttempts.status, ["awaiting_start", "running"]),
        ),
      );
    await db
      .update(schema.taskMgrRuns)
      .set({
        status: "cancelled",
        finalReason: "新しい実行が開始されたため終了",
        closedAt: now,
      })
      .where(eq(schema.taskMgrRuns.id, r.id));
  }
  const inserted = await db
    .insert(schema.taskMgrRuns)
    .values({ testId: null, seq: 0, kind, targetJson: JSON.stringify(target) })
    .returning({ id: schema.taskMgrRuns.id });
  const run = inserted[0];
  if (!run) throw new Error("mgrBeginAttempt: run insert returned no rows");
  const attemptId = await mgrInsertAttempt(ctx, run.id, kind, 1);
  return { runId: run.id, attemptId };
}

// Spawns the task for one begun attempt, with the manager's
// record-first instruction prepended to the caller's assignment.
// Returns "spawned" when THIS attempt's task is live, "retried"
// when a later attempt (spawned by the retry logic below) is
// live instead, and "exhausted" when the run has been resolved
// without a live task (attempts exhausted — the forced outcome
// has already been applied — or the target had already ended).
async function mgrSpawnForAttempt(
  ctx: Ctx,
  att: { runId: number; attemptId: number },
  assignmentBody: string,
  opts: { expectsAction: string; dedupeKey: string },
): Promise<"spawned" | "retried" | "exhausted"> {
  const spawned = await ctx.agent.spawnTask(
    mgrRecordPrefix(att.attemptId) + "\n\n" + assignmentBody,
    {
      expectsAction: opts.expectsAction,
      dedupeKey: `${opts.dedupeKey}-mgr-${att.attemptId}`,
    },
  );
  if (spawned.ok) return "spawned";
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.taskMgrAttempts)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      closeReason: `タスクを開始できませんでした: ${spawned.error}`,
    })
    .where(eq(schema.taskMgrAttempts.id, att.attemptId));
  const outcome = await mgrAfterAttemptClosed(ctx, att.runId);
  return outcome === "retried" ? "retried" : "exhausted";
}

// Whether a production target is still in flight (null) or has
// already reached its end by another path ("succeeded" /
// "cancelled" = how the manager run should close to match). A
// plan set in status "failed" is NOT an end: a class-11 floor
// failure leaves the task room to recover and re-save, so the
// manager's deadlines keep governing it.
async function mgrReconcileProductionTarget(
  ctx: Ctx,
  target: MgrTarget,
): Promise<"succeeded" | "cancelled" | null> {
  const db = ctx.db<typeof schema>();
  switch (target.type) {
    case "generation":
    case "same_day": {
      const rows = await db
        .select({ status: schema.planSets.status })
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = rows[0];
      if (!set) return "cancelled";
      if (set.status === "done") return "succeeded";
      return null;
    }
    case "partial": {
      const rows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = rows[0];
      if (!set) return "cancelled";
      const prog =
        target.slot === "A"
          ? set.progressA
          : target.slot === "B"
            ? set.progressB
            : set.progressC;
      if (set.status === "done" && prog !== "generating") return "succeeded";
      return null;
    }
    case "research": {
      const rows = await db
        .select({ status: schema.researchRequests.status })
        .from(schema.researchRequests)
        .where(eq(schema.researchRequests.id, target.researchId))
        .limit(1);
      const r = rows[0];
      if (!r) return "cancelled";
      if (r.status === "done") return "succeeded";
      if (r.status === "failed") return "cancelled";
      return null;
    }
    case "verification": {
      const rows = await db
        .select({ status: schema.verificationRequests.status })
        .from(schema.verificationRequests)
        .where(eq(schema.verificationRequests.id, target.requestId))
        .limit(1);
      const r = rows[0];
      if (!r) return "cancelled";
      if (r.status === "done") return "succeeded";
      if (r.status === "failed") return "cancelled";
      return null;
    }
    case "wait_sources": {
      const rows = await db
        .select({ status: schema.waitTimeSourceRequests.status })
        .from(schema.waitTimeSourceRequests)
        .where(eq(schema.waitTimeSourceRequests.id, target.requestId))
        .limit(1);
      const r = rows[0];
      if (!r) return "cancelled";
      if (r.status === "done") return "succeeded";
      if (r.status === "failed") return "cancelled";
      return null;
    }
    case "item_images": {
      const rows = await db
        .select({ imagesStatus: schema.planSets.imagesStatus })
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = rows[0];
      if (!set) return "cancelled";
      if (set.imagesStatus === "done") return "succeeded";
      if (set.imagesStatus === "failed") return "cancelled";
      return null;
    }
    case "restaurant_correction": {
      // The correction's end is observable ONLY through its
      // report action (which finishes the run directly): there
      // is no durable per-run state to reconcile against — the
      // corrected facts being registered can also mean a
      // previous, already-finished run did the work. Deadlines
      // therefore govern an unreported run.
      return null;
    }
  }
}

// Decides what follows a closed production attempt: reconcile
// first (a finished target is never retried), then a retry on
// the SAME target while the kind's max attempts allow, otherwise
// the forced outcome + the run closes as forced.
async function mgrAfterAttemptClosed(
  ctx: Ctx,
  runId: number,
): Promise<"retried" | "forced" | "none"> {
  const db = ctx.db<typeof schema>();
  const runRows = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(eq(schema.taskMgrRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run || run.status !== "running") return "none";
  const target = parseMgrTarget(run.targetJson);
  if (!target) return "none";
  const reconciled = await mgrReconcileProductionTarget(ctx, target);
  if (reconciled) {
    await db
      .update(schema.taskMgrRuns)
      .set({
        status: reconciled,
        closedAt: new Date(),
        finalReason: "対象の処理は既に終了していたため終了",
      })
      .where(eq(schema.taskMgrRuns.id, runId));
    return "none";
  }
  const attempts = await db
    .select()
    .from(schema.taskMgrAttempts)
    .where(eq(schema.taskMgrAttempts.runId, runId));
  const params = await taskMgrParamsFor(ctx, run.kind);
  if (attempts.length < params.maxAttempts) {
    await mgrRespawnProduction(ctx, run, target);
    return "retried";
  }
  await mgrApplyForcedOutcome(ctx, target);
  await db
    .update(schema.taskMgrRuns)
    .set({
      status: "forced",
      finalReason: "試行回数を超えたので強制終了",
      closedAt: new Date(),
    })
    .where(eq(schema.taskMgrRuns.id, runId));
  return "forced";
}

// Spawns the next attempt of a production run: a fresh attempt
// row first (deadlines from the kind's CURRENT parameters), then
// the SAME processing re-started for the SAME target through the
// processing's own start path — for plan creation / same-day
// search, the exact re-run the generating view's リトライ button
// performs (same set, recorded start inputs, no new set).
async function mgrRespawnProduction(
  ctx: Ctx,
  run: typeof schema.taskMgrRuns.$inferSelect,
  target: MgrTarget,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.taskMgrAttempts)
    .where(eq(schema.taskMgrAttempts.runId, run.id));
  const attemptId = await mgrInsertAttempt(
    ctx,
    run.id,
    run.kind,
    existing.length + 1,
  );
  const att = { runId: run.id, attemptId };
  switch (target.type) {
    case "generation":
    case "same_day": {
      const setRows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = setRows[0];
      if (!set) return;
      await retryWholeSetGeneration(ctx, set, att);
      return;
    }
    case "partial": {
      const setRows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = setRows[0];
      if (!set) return;
      const op = parsePendingOps(set.pendingOpsJson)[target.slot];
      if (!op) return;
      const sealed = parseSnapshotConditions(set).conditions;
      await startPartialReplacement(
        ctx,
        {
          id: set.id,
          title: set.title,
          park: set.park,
          visitDate: set.visitDate,
        },
        target.slot,
        op.instruction,
        sealed,
        { dayOfReport: op.dayOfReport, forceRestart: true, mgrAttempt: att },
      );
      return;
    }
    case "research": {
      const rows = await db
        .select()
        .from(schema.researchRequests)
        .where(eq(schema.researchRequests.id, target.researchId))
        .limit(1);
      const r = rows[0];
      if (!r) return;
      const conditions = await loadConditions(ctx);
      await spawnResearchAttempt(ctx, r.id, r.question, conditions, att);
      return;
    }
    case "verification": {
      const rows = await db
        .select()
        .from(schema.verificationRequests)
        .where(eq(schema.verificationRequests.id, target.requestId))
        .limit(1);
      const r = rows[0];
      if (!r) return;
      const setRows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, r.planSetId))
        .limit(1);
      const set = setRows[0];
      if (!set) return;
      await spawnVerificationAttempt(ctx, set, r.id, att);
      return;
    }
    case "wait_sources": {
      const rows = await db
        .select()
        .from(schema.waitTimeSourceRequests)
        .where(eq(schema.waitTimeSourceRequests.id, target.requestId))
        .limit(1);
      const r = rows[0];
      if (!r) return;
      await spawnWaitSourcesAttempt(ctx, r.id, r.instruction, att);
      return;
    }
    case "item_images": {
      const setRows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = setRows[0];
      if (!set) return;
      // Recompute what is still missing (the dictionary and
      // other sets' photos may cover more than at the first
      // attempt); nothing left means the fetch is done.
      const missing = await collectMissingItemImages(ctx, set);
      if (missing.length === 0) {
        await db
          .update(schema.planSets)
          .set({ imagesStatus: "done", imagesFetchStartedAt: null })
          .where(eq(schema.planSets.id, set.id));
        await mgrFinishRunForTarget(ctx, target, "finished");
        return;
      }
      await spawnItemImagesAttempt(ctx, set, missing, att);
      return;
    }
    case "restaurant_correction": {
      // If the corrected facts landed meanwhile (e.g. a manual
      // fix), there is nothing left to spawn for.
      const alreadyCorrect = await restaurantCorrectionRegistered(ctx);
      if (alreadyCorrect.length === 2) {
        await mgrFinishRunForTarget(ctx, target, "finished");
        return;
      }
      await spawnRestaurantCorrectionAttempt(ctx, att);
      return;
    }
  }
}

// Records one dialog notice carrying the common congestion
// text. getState offers the oldest unshown notice and the
// client displays it as a dialog once (markMgrDialogShown is
// the read record) — the surfacing the owner chose for the
// three auxiliary processings (kinds 15..17).
async function insertMgrDialogNotice(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.mgrDialogNotices)
    .values({ text: MGR_CONGESTION_TEXT });
}

// The attempts-exhausted abnormal end, per system (the text is
// the one common MGR_CONGESTION_TEXT everywhere):
// - plan creation / same-day search: the failure lands on the
//   plan set's own tab — the set (or, for a partial replacement,
//   the target slot) is marked failed with the common text as
//   its error / failure record, never left 作成中, and the
//   generating view's リトライ can re-run it;
// - research / bulk verification: the common text is posted to
//   the AI chat and the request is marked failed;
// - wait-time site list update / image fetch / restaurant fact
//   correction: the target is marked failed where it has state
//   (the update request, the set's image status) and the common
//   text is recorded as a dialog notice for the client.
async function mgrApplyForcedOutcome(
  ctx: Ctx,
  target: MgrTarget,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  switch (target.type) {
    case "generation":
    case "same_day": {
      const rows = await db
        .select({
          progressA: schema.planSets.progressA,
          progressB: schema.planSets.progressB,
          progressC: schema.planSets.progressC,
        })
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const current = rows[0];
      if (!current) return;
      const updated = await db
        .update(schema.planSets)
        .set({
          status: "failed",
          error: MGR_CONGESTION_TEXT,
          completedAt: now,
          progressA: current.progressA === "done" ? "done" : "failed",
          progressB: current.progressB === "done" ? "done" : "failed",
          progressC: current.progressC === "done" ? "done" : "failed",
        })
        .where(
          and(
            eq(schema.planSets.id, target.planSetId),
            inArray(schema.planSets.status, ["generating", "failed"]),
          ),
        )
        .returning({ id: schema.planSets.id });
      if (updated.length > 0) {
        await closeOpenRunLog(
          ctx,
          target.planSetId,
          "failed",
          "試行回数を超えたので強制終了（裏タスク管理クラス）",
        );
      }
      break;
    }
    case "partial": {
      const rows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, target.planSetId))
        .limit(1);
      const set = rows[0];
      if (!set) return;
      const op = parsePendingOps(set.pendingOpsJson)[target.slot];
      const failedOpsJson = pendingOpsJsonWith(set.pendingOpsJson, target.slot, {
        instruction: op?.instruction ?? "",
        dayOfReport: op?.dayOfReport ?? null,
        startedAt: op?.startedAt ?? now.getTime(),
        failureText: MGR_CONGESTION_TEXT,
      });
      const col =
        target.slot === "A"
          ? schema.planSets.progressA
          : target.slot === "B"
            ? schema.planSets.progressB
            : schema.planSets.progressC;
      const updated = await db
        .update(schema.planSets)
        .set(
          target.slot === "A"
            ? { progressA: "failed" as const, progressUpdatedAt: now, pendingOpsJson: failedOpsJson }
            : target.slot === "B"
              ? { progressB: "failed" as const, progressUpdatedAt: now, pendingOpsJson: failedOpsJson }
              : { progressC: "failed" as const, progressUpdatedAt: now, pendingOpsJson: failedOpsJson },
        )
        .where(and(eq(schema.planSets.id, set.id), eq(col, "generating")))
        .returning({ id: schema.planSets.id });
      if (updated.length > 0) {
        await closeOpenRunLog(
          ctx,
          target.planSetId,
          "failed",
          "試行回数を超えたので強制終了（裏タスク管理クラス）",
          target.slot,
        );
      }
      break;
    }
    case "research": {
      const updated = await db
        .update(schema.researchRequests)
        .set({ status: "failed", completedAt: now })
        .where(
          and(
            eq(schema.researchRequests.id, target.researchId),
            eq(schema.researchRequests.status, "pending"),
          ),
        )
        .returning({ id: schema.researchRequests.id });
      if (updated.length > 0) {
        await db.insert(schema.messages).values({
          role: "assistant",
          text: MGR_CONGESTION_TEXT,
        });
      }
      break;
    }
    case "verification": {
      const updated = await db
        .update(schema.verificationRequests)
        .set({ status: "failed", completedAt: now })
        .where(
          and(
            eq(schema.verificationRequests.id, target.requestId),
            eq(schema.verificationRequests.status, "pending"),
          ),
        )
        .returning({ id: schema.verificationRequests.id });
      if (updated.length > 0) {
        await db.insert(schema.messages).values({
          role: "assistant",
          text: MGR_CONGESTION_TEXT,
        });
      }
      break;
    }
    case "wait_sources": {
      const updated = await db
        .update(schema.waitTimeSourceRequests)
        .set({ status: "failed", completedAt: now })
        .where(
          and(
            eq(schema.waitTimeSourceRequests.id, target.requestId),
            eq(schema.waitTimeSourceRequests.status, "pending"),
          ),
        )
        .returning({ id: schema.waitTimeSourceRequests.id });
      if (updated.length > 0) {
        await insertMgrDialogNotice(ctx);
      }
      break;
    }
    case "item_images": {
      const updated = await db
        .update(schema.planSets)
        .set({ imagesStatus: "failed", imagesFetchStartedAt: null })
        .where(
          and(
            eq(schema.planSets.id, target.planSetId),
            eq(schema.planSets.imagesStatus, "fetching"),
          ),
        )
        .returning({ id: schema.planSets.id });
      if (updated.length > 0) {
        await insertMgrDialogNotice(ctx);
      }
      break;
    }
    case "restaurant_correction": {
      // The correction carries no per-run state to mark; the
      // dialog notice is its whole abnormal-end surfacing.
      await insertMgrDialogNotice(ctx);
      break;
    }
  }
  ctx.invalidateQueries();
}

// The "finished" mark for a production run: the processing's
// normal completion was observed server-side (see the section
// header for what counts, per system). Closes the open attempt
// and the run as succeeded — or as cancelled when the user
// cancelled the processing. A run that is not open is untouched.
async function mgrFinishRunForTarget(
  ctx: Ctx,
  target: MgrTarget,
  how: "finished" | "cancelled",
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const key = mgrTargetKey(target);
  const now = new Date();
  const openRuns = await db
    .select()
    .from(schema.taskMgrRuns)
    .where(
      and(
        eq(schema.taskMgrRuns.status, "running"),
        isNotNull(schema.taskMgrRuns.targetJson),
      ),
    );
  for (const run of openRuns) {
    const t = parseMgrTarget(run.targetJson);
    if (!t || mgrTargetKey(t) !== key) continue;
    if (how === "finished") {
      await db
        .update(schema.taskMgrAttempts)
        .set({
          status: "succeeded",
          finishedAt: now,
          closeReason: "処理の通常の完了をサーバー側で確認した",
        })
        .where(
          and(
            eq(schema.taskMgrAttempts.runId, run.id),
            inArray(schema.taskMgrAttempts.status, ["awaiting_start", "running"]),
          ),
        );
      await db
        .update(schema.taskMgrRuns)
        .set({ status: "succeeded", closedAt: now })
        .where(eq(schema.taskMgrRuns.id, run.id));
    } else {
      await db
        .update(schema.taskMgrAttempts)
        .set({
          status: "cancelled",
          finishedAt: now,
          closeReason: "利用者の操作によりキャンセルされた",
        })
        .where(
          and(
            eq(schema.taskMgrAttempts.runId, run.id),
            inArray(schema.taskMgrAttempts.status, ["awaiting_start", "running"]),
          ),
        );
      await db
        .update(schema.taskMgrRuns)
        .set({
          status: "cancelled",
          finalReason: "利用者がキャンセルした",
          closedAt: now,
        })
        .where(eq(schema.taskMgrRuns.id, run.id));
    }
  }
}

const taskMgrRunItemShape = z.object({
  id: z.number(),
  seq: z.number(),
  kind: z.number(),
  kindLabel: z.string(),
  status: z.enum(["running", "succeeded", "forced", "cancelled"]),
  finalReason: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  attempts: z.array(
    z.object({
      id: z.number(),
      attemptNo: z.number(),
      status: z.enum(["awaiting_start", "running", "succeeded", "cancelled"]),
      spawnedAt: z.string(),
      startDeadlineAt: z.string(),
      totalDeadlineAt: z.string(),
      firstCallAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      closeReason: z.string().nullable(),
      calls: z.array(
        z.object({
          id: z.number(),
          phase: z.string(),
          calledAt: z.string(),
          note: z.string().nullable(),
          textLength: z.number().nullable(),
          hasText: z.boolean(),
        }),
      ),
    }),
  ),
});

const taskMgrStateResponse = z.object({
  params: z.array(
    z.object({
      kind: z.number(),
      label: z.string(),
      usesBrowser: z.boolean(),
      startTimeoutSec: z.number(),
      totalTimeoutSec: z.number(),
      maxAttempts: z.number(),
    }),
  ),
  test: z
    .object({
      id: z.number(),
      status: z.enum(["running", "done", "cancelled"]),
      total: z.number(),
      startedAt: z.string(),
      closedAt: z.string().nullable(),
      closeReason: z.string().nullable(),
      completedCount: z.number(),
      successCount: z.number(),
      forcedCount: z.number(),
      currentSeq: z.number().nullable(),
    })
    .nullable(),
  runs: z.array(taskMgrRunItemShape),
  // The production processings the manager is running / has run
  // (newest 20): the same record shape as the test runs, plus
  // the target each run works on. One manager, one state — the
  // tab shows both the test and the production runs it governs.
  prodRuns: z.array(
    taskMgrRunItemShape.extend({ targetLabel: z.string() }),
  ),
});

// Re-runs a whole-set generation （新規作成 / 作り直し / 当日検索）
// on the SAME set from its recorded start inputs: partially
// saved plans are discarded, the run's result fields and
// progress are reset, the set stands at 作成中 again, and the
// elapsed-time clock restarts at the retry moment; the
// conditions snapshot itself is never changed. Shared by
// retryGeneration (the generating view's リトライ button — for a
// generating set, and for a set the task manager marked failed
// when its attempts ran out) and by the task manager's own
// retry (mgrRespawnProduction, which hands its attempt in). A
// same-day set whose snapshotted start inputs are missing
// cannot be re-run as-is — refused BEFORE discarding anything.
async function retryWholeSetGeneration(
  ctx: Ctx,
  set: typeof schema.planSets.$inferSelect,
  mgrAttempt?: { runId: number; attemptId: number },
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  let sameDayStart: { location: string; startTime: string } | null = null;
  if (set.setType === "same_day") {
    if (!set.sameDayLocation || !set.sameDayStartTime) {
      return {
        ok: false,
        error:
          "当日検索の開始時の記録が無いため、リトライできませんでした。キャンセルして、プラン作成タブの「当日検索」から改めてお試しください。",
      };
    }
    sameDayStart = {
      location: set.sameDayLocation,
      startTime: set.sameDayStartTime,
    };
  }
  const planRows = await db
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.planSetId, set.id));
  if (planRows.length > 0) {
    const ids = planRows.map((p) => p.id);
    await db
      .delete(schema.planItems)
      .where(inArray(schema.planItems.planId, ids));
    await db.delete(schema.plans).where(inArray(schema.plans.id, ids));
  }
  const now = new Date();
  await db
    .update(schema.planSets)
    .set({
      status: "generating",
      error: null,
      progressA: "waiting",
      progressB: "waiting",
      progressC: "waiting",
      progressUpdatedAt: now,
      generationStartedAt: now,
      completedAt: null,
      notes: null,
      parkHours: null,
      sourcesJson: null,
      estimateSourcesJson: null,
      verificationJson: null,
      generationMetricsJson: null,
      crowdLevel: null,
      crowdBasis: null,
      factBuildId: null,
      dpaSnapshotText: null,
      lastVerifiedAt: null,
      reverificationsJson: null,
      imagesStatus: "idle",
      imagesFetchStartedAt: null,
    })
    .where(eq(schema.planSets.id, set.id));
  let spawnedOk: boolean;
  if (set.setType === "same_day") {
    const snapshotConditions = parseSnapshotConditions(set).conditions;
    const agesM = /人数[:：][^\n]*（([^）]+)）/.exec(
      set.conditionsSnapshot ?? "",
    );
    const sd: SameDayInput = {
      park: set.park,
      location: sameDayStart?.location ?? "",
      startTime: sameDayStart?.startTime ?? "",
      adults: set.sameDayAdults ?? 2,
      children: set.sameDayChildren ?? 0,
      childrenAges: agesM ? (agesM[1] ?? null) : null,
      budgetJpy: snapshotConditions.budgetJpy,
      walkingSpeed: set.walkingSpeed ?? "slightly_slow",
      request: set.sameDayRequest,
    };
    spawnedOk = await spawnSameDayRun(ctx, set.id, sd, true, mgrAttempt);
  } else {
    const conditions = parseSnapshotConditions(set).conditions;
    let prevSet: { id: number; title: string } | null = null;
    if (set.rebuiltFromSetId != null) {
      const origRows = await db
        .select()
        .from(schema.planSets)
        .where(eq(schema.planSets.id, set.rebuiltFromSetId))
        .limit(1);
      const orig = origRows[0];
      if (orig && orig.status === "done") {
        prevSet = { id: orig.id, title: orig.title };
      }
    }
    spawnedOk = await spawnGenerationRun(ctx, set.id, conditions, {
      prevSet,
      dayOf: null,
      changeRequest: null,
      title: set.title,
      retrySpawn: true,
      mgrAttempt,
    });
  }
  ctx.invalidateQueries();
  return spawnedOk
    ? { ok: true, error: null }
    : {
        ok: false,
        error:
          "再実行を開始できませんでした。状態はチャットにもお知らせしました。",
      };
}

// Whether the task manager currently has an open (running) run
// for a production target. Used where a legacy stale-window
// guard must defer to the manager's own deadlines.
async function mgrHasOpenRun(ctx: Ctx, target: MgrTarget): Promise<boolean> {
const db = ctx.db<typeof schema>();
const key = mgrTargetKey(target);
const openRuns = await db
.select({ targetJson: schema.taskMgrRuns.targetJson })
.from(schema.taskMgrRuns)
.where(
and(
eq(schema.taskMgrRuns.status, "running"),
isNotNull(schema.taskMgrRuns.targetJson),
),
);
for (const r of openRuns) {
const t = parseMgrTarget(r.targetJson);
if (t && mgrTargetKey(t) === key) return true;
}
return false;
}

// Computes which of a finished set's schedule items still need
// the image-fetch task (no photo and/or no official detail-page
// link), applying everything that needs no task first: a fresh
// dictionary photo / recorded official URL, and a photo another
// finished set of the same park already owns. Shared by
// requestItemImages (the button) and the task manager's retry
// (which recomputes the remainder for the SAME set).
async function collectMissingItemImages(
ctx: Ctx,
set: typeof schema.planSets.$inferSelect,
): Promise<{ id: number; name: string; kind: string }[]> {
const db = ctx.db<typeof schema>();
const planRows = await db
.select({ id: schema.plans.id })
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
const missing: { id: number; name: string; kind: string }[] = [];
const seenNames = new Set<string>();
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
for (const it of itemRows) {
// An item needs the fetch task when it still lacks a photo OR its
// official detail-page link (the same task confirms both).
if (it.imageBlobKey && it.officialUrl) continue;
if (
it.kind !== "attraction" &&
it.kind !== "show" &&
it.kind !== "parade" &&
it.kind !== "restaurant"
) {
continue;
}
// Facility dictionary first: a fresh dictionary photo and/or the
// recorded official URL are applied directly, with no fetch task
// at all. Only what the dictionary cannot cover goes to the task.
const dict = await findFacility(ctx, set.park, it.name);
if (dict) {
if (
!it.imageBlobKey &&
dict.imageBlobKey &&
dict.imageSource &&
facilityFreshness(dict, Date.now()).imageFresh
) {
await db
.update(schema.planItems)
.set({
imageBlobKey: dict.imageBlobKey,
imageSource: dict.imageSource,
})
.where(eq(schema.planItems.id, it.id));
it.imageBlobKey = dict.imageBlobKey;
}
if (!it.officialUrl && dict.officialUrl) {
await db
.update(schema.planItems)
.set({ officialUrl: dict.officialUrl })
.where(eq(schema.planItems.id, it.id));
it.officialUrl = dict.officialUrl;
}
if (it.imageBlobKey && it.officialUrl) continue;
}
// Same carry-over as at save time: another finished plan set of
// this park may already own this facility's photo (the typical
// case is a rebuild whose original set has the photos while the
// dictionary does not). Apply it directly, with no fetch task.
if (!it.imageBlobKey) {
const owned = await findOwnedFacilityPhoto(
ctx,
set.park,
it.name,
set.id,
);
if (owned) {
await db
.update(schema.planItems)
.set({ imageBlobKey: owned.key, imageSource: owned.source })
.where(eq(schema.planItems.id, it.id));
it.imageBlobKey = owned.key;
await upsertFacilityFromFetch(ctx, set.park, {
name: it.name,
image: { blobKey: owned.key, source: owned.source },
});
}
}
if (it.imageBlobKey && it.officialUrl) continue;
// The same facility can appear in several plans; fetch it once and
// share the blob with every row of that name in this set.
if (seenNames.has(it.name)) continue;
seenNames.add(it.name);
missing.push({ id: it.id, name: it.name, kind: it.kind });
}
}
return missing;
}

// Spawns the image-fetch task for a set's missing items, through
// the task manager （裏タスク管理クラス・種類16): the set is
// marked 取得中 first, then the attempt is begun here (or handed
// in by the manager's retry, which re-runs the SAME set with its
// remainder recomputed). A spawn failure is the manager's to
// retry / exhaust; on exhaustion the manager has already marked
// the fetch failed and recorded the common congestion text as a
// dialog notice.
async function spawnItemImagesAttempt(
ctx: Ctx,
set: typeof schema.planSets.$inferSelect,
missing: { id: number; name: string; kind: string }[],
mgrAttempt?: { runId: number; attemptId: number },
): Promise<boolean> {
const db = ctx.db<typeof schema>();
await db
.update(schema.planSets)
.set({ imagesStatus: "fetching", imagesFetchStartedAt: new Date() })
.where(eq(schema.planSets.id, set.id));
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "item_images", planSetId: set.id }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildImageAssignment(set.park, set.id, missing),
{
expectsAction: "saveItemImages",
// The manager appends its own attempt suffix to this key, so a
// retry never dedupes against the dead earlier task.
dedupeKey: `plan-images-${set.id}`,
},
);
ctx.invalidateQueries();
return spawnOutcome !== "exhausted";
}

// Which of the two corrected restaurant classifications are
// already registered with the corrected values (the one-time
// correction's idempotence check, shared by
// applyRestaurantFactCorrection and the task manager's retry).
async function restaurantCorrectionRegistered(
ctx: Ctx,
): Promise<string[]> {
const alreadyCorrect: string[] = [];
const main = await findCurrentRestaurantFact(
ctx,
"sea",
"ケープコッド・クックオフ",
);
if (
main &&
main.reservationType === "none" &&
main.mobileOrder === "available"
) {
alreadyCorrect.push("ケープコッド・クックオフ");
}
const showArea = await findCurrentRestaurantFact(
ctx,
"sea",
"ケープコッド・クックオフ（ショーダイニングエリア）",
);
if (
showArea &&
showArea.reservationType === "required" &&
showArea.mobileOrder === "not_available"
) {
alreadyCorrect.push("ケープコッド・クックオフ（ショーダイニングエリア）");
}
return alreadyCorrect;
}

// The one-time restaurant fact correction's assignment (the
// task text itself is unchanged from the direct-spawn era).
function buildRestaurantCorrectionAssignment(): string {
return `【レストラン分類の訂正タスク（一回限り）】
施設辞書の旧来の列に、ケープコッド・クックオフ本体が「予約必須」と誤って記録されています（「ショーレストラン」というラベルからの推測が原因）。レストランの分類は、施設自身の公式レストラン詳細ページの記述から、根拠つきのファクトとして登録し直すのがこのタスクです。推測で分類を作ることは絶対にしないでください。ページの実文が下記の想定と違う場合は、想定を押し通さず、実文が裏づける分類で登録し、その旨を報告してください。

手順:
1. 公式ページ https://www.tokyodisneyresort.jp/tds/restaurant/detail/446/ （ケープコッド・クックオフ本体）をブラウザで開き、全文を読む。読む前に、saveSourceSnapshots アクションで生テキストのまま保存すること（batchId は "restaurant-correction-2026-11-16"、kind は "restaurant_detail"、park は "sea"、url は開いたページのURLそのまま、title はページのタイトル、fetchMethod は "browser"、completeness は {expectationSource: "none", expectation: "レストラン詳細ページには件数宣言が無いため、完全性の期待値は導けない", result: "not_derivable"}）。返ってきた snapshotIds の、このページの id を控える。
2. saveRestaurantFacts アクション（park="sea"）で、本体のファクトを登録する:
   - name: "ケープコッド・クックオフ"
   - serviceType: ページの「サービスタイプ」の表記そのまま（「カウンターサービス」の想定。ページの表記が違えばそちらを使う）
   - snapshotId: 手順1の id
   - reservation: {type: "none", evidenceKind: "absence", evidence: ページ内で施設名を含む一節（ページ冒頭の施設名の行など、保存したスナップショット本文から一字も変えずに切り取る）} —— 不在の根拠はサーバーが全文で機械確認します。もし登録が「存在マーカーがある」と拒否されたら、そのマーカーが示す分類がページの実態です。想定を押し通さず、実文が裏づける分類（required/ps/unknown＋理由）で登録し直し、報告に明記してください。
   - mobileOrder: {type: "available", evidenceKind: "excerpt", evidence: 「ディズニー・モバイルオーダー対象」と書かれた一節（保存した本文から逐語で切り取る）}
3. 公式ページ https://www.tokyodisneyresort.jp/tds/restaurant/detail/447/ （ケープコッド・クックオフ（ショーダイニングエリア））も同じ手順で開いて保存し（batchId は同じ）、ファクトを登録する:
   - name: "ケープコッド・クックオフ（ショーダイニングエリア）"
   - serviceType: ページにサービスタイプの表記があればそのまま、無ければ null
   - reservation: {type: "required", evidenceKind: "excerpt", evidence: 予約が必要だと書かれた一節（「ショーレストランのご利用には予約が必要です」の想定。ページの実文から逐語で切り取る）}
   - mobileOrder: ページにモバイルオーダーの記載が一切無ければ {type: "not_available", evidenceKind: "absence", evidence: 施設名を含む一節}。記載があれば実文が裏づける分類で登録する。
4. getFacilityDictionary（park="sea"）で施設辞書を確認し、ケープコッド・クックオフ（ショーダイニングエリア）のエントリが無ければ、saveFacilities（park="sea"）で {name, area: ページのエリア表記, officialUrl: 手順3のURL} だけを保存して別エントリとして追加する（分類のフィールド reservationType/mobileOrder は渡さないこと。分類はファクトの専管）。
5. 最後に必ず reportRestaurantFactCorrection アクションを1回呼ぶ。成功したら status="done"、text には登録した内容（施設ごとに予約形態とモバイルオーダーの値、根拠にしたページ）を短く書く。途中でどうしても登録できない場合は status="failed"、text に理由を書く。黙って終わらないこと。

注意: プラン・プランの行・メッセージ等の業務データは一切変更しないこと。このタスクが書くのは、スナップショット2件、ファクト2件、（必要なら）施設辞書のショーダイニングエリアのエントリ1件だけです。`;
}

// Spawns the one-time restaurant fact correction task, through
// the task manager （裏タスク管理クラス・種類17): the attempt is
// begun here (or handed in by the manager's retry — the
// correction is a singleton target, so a retry re-runs the same
// correction). A spawn failure is the manager's to retry /
// exhaust; on exhaustion the manager has already recorded the
// common congestion text as a dialog notice.
async function spawnRestaurantCorrectionAttempt(
ctx: Ctx,
mgrAttempt?: { runId: number; attemptId: number },
): Promise<boolean> {
const att =
mgrAttempt ??
(await mgrBeginAttempt(ctx, { type: "restaurant_correction" }));
const spawnOutcome = await mgrSpawnForAttempt(
ctx,
att,
buildRestaurantCorrectionAssignment(),
{
expectsAction: "reportRestaurantFactCorrection",
dedupeKey: "restaurant-fact-correction-2026-11-16",
},
);
ctx.invalidateQueries();
return spawnOutcome !== "exhausted";
}

export const Actions = {
getState: defineAction({
description:
"Returns the full app state: TAB2 conditions, TAB1 chat messages, and all plan sets (TAB3+) with their plans and timelines.",
request: z.object({}),
response: stateResponse,
async handler(ctx): Promise<z.infer<typeof stateResponse>> {
const db = ctx.db<typeof schema>();
const conditions = await loadConditions(ctx);

// 裏タスク管理： targets with a live manager run are governed
// by the manager's own deadlines (its 1-minute check), NOT by
// the stale-window guards below — the manager's total timeout
// for plan creation (2400s) is longer than the generation
// stale window, and a guard firing first would fail a target
// the manager is still legitimately retrying. The guards keep
// covering everything the manager does not run (legacy rows
// from before the manager took over a processing).
const mgrManagedKeys = new Set<string>();
{
const openMgrRuns = await db
.select({ targetJson: schema.taskMgrRuns.targetJson })
.from(schema.taskMgrRuns)
.where(
and(
eq(schema.taskMgrRuns.status, "running"),
isNotNull(schema.taskMgrRuns.targetJson),
),
);
for (const r of openMgrRuns) {
const t = parseMgrTarget(r.targetJson);
if (t) mgrManagedKeys.add(mgrTargetKey(t));
}
}

// Chat research lifecycle: pending rows younger than the stale window
// keep the client polling with a "確認中" indicator. A pending row past
// the window means its task died without reporting; fail it (once —
// the status guard makes the message insert happen a single time) and
// tell the user in chat instead of leaving them waiting forever.
const pendingResearch = await db
.select()
.from(schema.researchRequests)
.where(eq(schema.researchRequests.status, "pending"));
let researchPending = false;
for (const r of pendingResearch) {
if (mgrManagedKeys.has(`research:${r.id}`)) {
researchPending = true;
continue;
}
if (Date.now() - r.createdAt.getTime() > RESEARCH_STALE_MS) {
const updated = await db
.update(schema.researchRequests)
.set({ status: "failed", completedAt: new Date()})
.where(
and(
eq(schema.researchRequests.id, r.id),
eq(schema.researchRequests.status, "pending"),
),
)
.returning({ id: schema.researchRequests.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
text: "公式サイトの確認が完了しませんでした。お手数ですが、もう一度「調べて」と送ってください。",
});
}
} else {
researchPending = true;
}
}

// Wait-time reference sites: seed the build-time initial registration
// the first time the list is read, and run the same dead-task guard as
// research — a pending update past the stale window is failed once and
// reported in chat instead of leaving the indicator on forever.
// Updates the task manager is running are exempt (see the manager
// note above): their deadlines and retries govern, and exhaustion
// surfaces as a dialog notice instead of this chat line.
const pendingWaitReqs = await db
.select()
.from(schema.waitTimeSourceRequests)
.where(eq(schema.waitTimeSourceRequests.status, "pending"));
let waitTimeSourcesPending = false;
for (const r of pendingWaitReqs) {
if (mgrManagedKeys.has(`wait_sources:${r.id}`)) {
waitTimeSourcesPending = true;
continue;
}
if (Date.now() - r.createdAt.getTime() > RESEARCH_STALE_MS) {
const updated = await db
.update(schema.waitTimeSourceRequests)
.set({ status: "failed", completedAt: new Date()})
.where(
and(
eq(schema.waitTimeSourceRequests.id, r.id),
eq(schema.waitTimeSourceRequests.status, "pending"),
),
)
.returning({ id: schema.waitTimeSourceRequests.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
text: "待ち時間参考サイトの更新が完了しませんでした。お手数ですが、もう一度指示してください。",
});
}
} else {
waitTimeSourcesPending = true;
}
}
const waitTimeSources = await loadWaitTimeSources(ctx);

// Bulk re-verification lifecycle: same dead-task guard as the other
// channels. A pending request past the stale window is failed once
// (the status guard makes the chat line happen a single time) and
// reported in the chat; a live one keeps the client polling with a
// 「検証中」 indicator and marks its set as verifying.
const pendingVerifications = await db
.select()
.from(schema.verificationRequests)
.where(eq(schema.verificationRequests.status, "pending"));
let verificationPending = false;
const verifyingSetIds = new Set<number>();
for (const r of pendingVerifications) {
if (mgrManagedKeys.has(`verification:${r.id}`)) {
verificationPending = true;
verifyingSetIds.add(r.planSetId);
continue;
}
if (Date.now() - r.createdAt.getTime() > VERIFICATION_STALE_MS) {
const updated = await db
.update(schema.verificationRequests)
.set({ status: "failed", completedAt: new Date()})
.where(
and(
eq(schema.verificationRequests.id, r.id),
eq(schema.verificationRequests.status, "pending"),
),
)
.returning({ id: schema.verificationRequests.id});
if (updated.length > 0) {
const targetRows = await db
.select({ title: schema.planSets.title })
.from(schema.planSets)
.where(eq(schema.planSets.id, r.planSetId))
.limit(1);
await db.insert(schema.messages).values({
role: "assistant",
text: `「${targetRows[0]?.title ?? "プラン"}」の一括検証が完了しませんでした。お手数ですが、チャットで「検証して」と送って、もう一度お試しください。`,
});
}
} else {
verificationPending = true;
verifyingSetIds.add(r.planSetId);
}
}

// Plan generation lifecycle: a set whose LAST PROGRESS RECORD is
// older than the stale window means its task died without reporting
// (a task that keeps reporting progress is alive, however long the
// generation takes — slowness alone never fails a set). Fail it
// (once — the status guard makes the message insert happen a single
// time) and tell the user in chat, so a finished-or-dead generation
// never leaves them unable to tell whether it is done.
const generatingSets = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "generating"));
for (const s of generatingSets) {
if (
mgrManagedKeys.has(`generation:${s.id}`) ||
mgrManagedKeys.has(`same_day:${s.id}`)
) {
continue;
}
const lastProgressAt = s.progressUpdatedAt?? s.createdAt;
if (Date.now() - lastProgressAt.getTime() > GENERATION_STALE_MS) {
const updated = await db
.update(schema.planSets)
.set({
status: "failed",
error:
"作成が完了しませんでした。プラン作成タブからもう一度お試しください。",
completedAt: new Date(),
progressA: "failed",
progressB: "failed",
progressC: "failed",
})
.where(
and(
eq(schema.planSets.id, s.id),
eq(schema.planSets.status, "generating"),
),
)
.returning({ id: schema.planSets.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
// A dead rebuild is reported as a failed REBUILD — the original
// plan is untouched, and the message must not read as if some
// plan somewhere had changed.
text:
s.setType === "same_day"
? `「${s.title}」の当日検索は完了しませんでした。（対象条件: ${setConditionsSummary(s)}）お手数ですが、プラン作成タブの「当日検索」からもう一度お試しください。`
: s.rebuiltFromSetId != null
? `「${s.title}」の作り直しは完了しませんでした。（対象条件: ${setConditionsSummary(s)}）元のプランはそのまま残っています。お手数ですが、もう一度お試しください。`
: `「${s.title}」のプラン作成が完了しませんでした。（対象条件: ${setConditionsSummary(s)}）お手数ですが、プラン作成タブからもう一度作成してください。`,
});
// 過程記録： the task died without reporting — close its run
// here, with the reason stated as unknown (never left open).
await closeOpenRunLog(
ctx,
s.id,
"failed",
"タスクからの終了報告がなく、理由不明（進捗報告の途絶によりサーバーが記録を閉じた）",
);
}
}
}

// Partial-replacement lifecycle: a FINISHED set with a slot still
// marked 作成中 past the stale window means its replacement task
// died without reporting. Stand that slot back down (once — the
// progress guard makes the message insert happen a single time):
// the original plan row was never touched, so the slot is simply
// 完了 again with its original plan, and the user hears about it
// in chat instead of waiting forever.
const doneSetsForPartial = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "done"));
for (const s of doneSetsForPartial) {
const lastProgressAt = s.progressUpdatedAt?? s.createdAt;
if (Date.now() - lastProgressAt.getTime() <= GENERATION_STALE_MS) {
continue;
}
const slotStates = [
["A", s.progressA],
["B", s.progressB],
["C", s.progressC],
] as const;
let guardOpsJson = s.pendingOpsJson;
for (const [slot, prog] of slotStates) {
if (prog!== "generating") continue;
if (mgrManagedKeys.has(`partial:${s.id}:${slot}`)) continue;
const col =
slot === "A"
? schema.planSets.progressA
: slot === "B"
? schema.planSets.progressB
: schema.planSets.progressC;
guardOpsJson = pendingOpsJsonWith(guardOpsJson, slot, null);
const updated = await db
.update(schema.planSets)
.set(
slot === "A"
? { progressA: "done" as const, pendingOpsJson: guardOpsJson}
: slot === "B"
? { progressB: "done" as const, pendingOpsJson: guardOpsJson}
: { progressC: "done" as const, pendingOpsJson: guardOpsJson},
)
.where(and(eq(schema.planSets.id, s.id), eq(col, "generating")))
.returning({ id: schema.planSets.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
text: `プラン${slot}の差し替えは完了しませんでした。「${s.title}」の元のプラン${slot}はそのまま残っています。お手数ですが、もう一度指示してください。`,
});
// 過程記録： the replacement task died without reporting —
// close its run here, reason stated as unknown.
await closeOpenRunLog(
ctx,
s.id,
"failed",
"タスクからの終了報告がなく、理由不明（進捗報告の途絶によりサーバーが記録を閉じた）",
slot,
);
}
}
}

// Run-log sweep （過程記録）: a run record must never dangle open.
// The primary closes happen at the save / failure-report /
// watchdog points above; this sweep is the guarantee behind them
// — any still-open run whose set has reached a terminal state (or
// been deleted) and whose trail has been silent past the stale
// window is closed here, with the reason stated (理由不明 when
// nothing was ever reported). Runs on still-generating sets, and
// partial runs whose slot is still 作成中， are left to their own
// paths above.
{
const openRuns = await db
.select()
.from(schema.runLogs)
.where(eq(schema.runLogs.status, "open"));
for (const r of openRuns) {
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, r.planSetId))
.limit(1);
const set = setRows[0];
if (set && set.status === "generating") continue;
if (
set &&
set.status === "done" &&
r.kind === "partial" &&
(r.slot === "A"
? set.progressA
: r.slot === "B"
? set.progressB
: set.progressC) === "generating"
) {
continue;
}
const lastEvents = await db
.select({ at: schema.runLogEvents.at })
.from(schema.runLogEvents)
.where(eq(schema.runLogEvents.runId, r.id))
.orderBy(desc(schema.runLogEvents.id))
.limit(1);
const lastActivityAt = lastEvents[0]?.at ?? r.startedAt;
if (Date.now() - lastActivityAt.getTime() <= GENERATION_STALE_MS) {
continue;
}
if (!set) {
await closeRunLog(
ctx,
r.id,
"cancelled",
"対象のプランセットが削除されたため、記録を閉じた",
);
} else if (set.status === "failed") {
await closeRunLog(
ctx,
r.id,
"failed",
set.error
? `セットの失敗理由として記録されたもの: ${set.error}`
: "タスクからの終了報告がなく、理由不明（サーバーが記録を閉じた）",
);
} else if (r.kind === "partial") {
await closeRunLog(
ctx,
r.id,
"failed",
"タスクからの終了報告がなく、理由不明（サーバーが記録を閉じた）",
);
} else {
await closeRunLog(ctx, r.id, "succeeded", null);
}
}
}

// The chat log shown in TAB1 is the LATEST 200 messages, in
// chronological order. This used to read ASC + limit(200) — the
// OLDEST 200 — so the moment the log grew past 200 rows, every new
// user message and every AI reply was saved in the DB yet never
// reached the UI: the chat looked frozen and users reported
// 「返事が返ってこない」 while the server was in fact answering
// (production log passed 200 messages on 2026-11-15; messages
// 201+ — including the complaint itself and its replies — were
// invisible). Fetch newest-first, then reverse for display.
const messageRows = (
await db
.select()
.from(schema.messages)
.orderBy(desc(schema.messages.id))
.limit(200)
).reverse();

const setRows = await db
.select()
.from(schema.planSets)
.orderBy(asc(schema.planSets.id));

const planSets: z.infer<typeof planSetShape>[] = [];
for (const set of setRows) {
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plans: z.infer<typeof planShape>[] = [];
const durationFor = makeDurationLookup(ctx, set.park);
const restaurantFor = makeRestaurantLookup(ctx, set.park);
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
let costBreakdown: z.infer<typeof costLineShape>[] = [];
if (plan.costBreakdownJson) {
try {
const parsed: unknown = JSON.parse(plan.costBreakdownJson);
if (Array.isArray(parsed)) {
costBreakdown = parsed.filter(
(l): l is z.infer<typeof costLineShape> =>
typeof l === "object" &&
l !== null &&
typeof (l as { label?: unknown }).label === "string" &&
(typeof (l as { amountJpy?: unknown }).amountJpy === "number" ||
(l as { amountJpy?: unknown }).amountJpy === null) &&
(typeof (l as { note?: unknown }).note === "string" ||
(l as { note?: unknown }).note === null ||
(l as { note?: unknown }).note === undefined),
).map((l) => ({
label: l.label,
amountJpy: l.amountJpy,
note: l.note ?? null,
}));
}
} catch {
costBreakdown = [];
}
}
const items: z.infer<typeof planItemShape>[] = [];
for (const it of itemRows) {
let imageUrl: string | null = null;
if (it.imageBlobKey) {
try {
imageUrl = await ctx.blobs.getUrl(it.imageBlobKey);
} catch {
imageUrl = null;
}
}
items.push({
id: it.id,
sortOrder: it.sortOrder,
timeLabel: it.timeLabel,
name: it.name,
kind: it.kind,
area: it.area,
note: it.note,
passType: it.passType,
dpaPurchaseTime: it.dpaPurchaseTime,
unitPriceJpy: it.unitPriceJpy,
purchaseCount: it.purchaseCount,
// Restaurant waits are not modeled (owner design, 記録AD):
// a restaurant row's stored estWaitMin — older sets still
// carry values — is never surfaced; the read payload reports
// null, the same read-time derivation as restaurantInfo and
// restaurantWaitNote. Stored rows are NOT rewritten.
estWaitMin: it.kind === "restaurant" ? null : it.estWaitMin,
travelMin: it.travelMin,
durationMin: await durationFor(it.name),
lat: it.lat,
lng: it.lng,
imageUrl,
imageSource: it.imageBlobKey? (it.imageSource?? "official"): null,
officialUrl: it.officialUrl,
unconfirmedReason: it.unconfirmedReason,
unconfirmedNote: it.unconfirmedNote,
restaurantInfo:
it.kind === "restaurant" ? await restaurantFor(it.name) : null,
});
}
plans.push({
id: plan.id,
slot: plan.slot,
title: plan.title,
summary: plan.summary,
estimatedCostJpy: plan.estimatedCostJpy,
costBreakdown,
crowdScenario: plan.crowdScenario,
crowdScenarioLevel: plan.crowdScenarioLevel,
items,
restaurantWaitNote: restaurantWaitNoteFor(items),
lapChildNote: lapChildNoteFor(set),
summaryStats: summaryStatsForPlan(set, plan.estimatedCostJpy, items),
});
}
let sources: { title: string; url: string}[] = [];
if (set.sourcesJson) {
try {
const parsed: unknown = JSON.parse(set.sourcesJson);
if (Array.isArray(parsed)) {
sources = parsed.filter(
(s): s is { title: string; url: string} =>
typeof s === "object" &&
s!== null &&
typeof (s as { title?: unknown}).title === "string" &&
typeof (s as { url?: unknown}).url === "string",
);
}
} catch {
sources = [];
}
}
let estimateSources: {
title: string;
url: string;
fetchedAt: string | null;
}[] = [];
if (set.estimateSourcesJson) {
try {
const parsed: unknown = JSON.parse(set.estimateSourcesJson);
if (Array.isArray(parsed)) {
estimateSources = parsed
.filter(
(
s,
): s is { title: string; url: string; fetchedAt?: unknown} =>
typeof s === "object" &&
s!== null &&
typeof (s as { title?: unknown}).title === "string" &&
typeof (s as { url?: unknown}).url === "string",
)
.map((s) => ({
title: s.title,
url: s.url,
fetchedAt:
typeof s.fetchedAt === "string"? s.fetchedAt: null,
}));
}
} catch {
estimateSources = [];
}
}
let generationMetrics: z.infer<
typeof planSetShape
>["generationMetrics"] = null;
if (set.generationMetricsJson) {
try {
const parsed: unknown = JSON.parse(set.generationMetricsJson);
if (typeof parsed === "object" && parsed!== null) {
const p = parsed as {
pagesOpened?: unknown;
phases?: unknown;
};
generationMetrics = {
pagesOpened:
typeof p.pagesOpened === "number"? p.pagesOpened: null,
phases: Array.isArray(p.phases)
? p.phases.filter(
(
ph,
): ph is { name: string; seconds: number} =>
typeof ph === "object" &&
ph!== null &&
typeof (ph as { name?: unknown}).name === "string" &&
typeof (ph as { seconds?: unknown}).seconds ===
"number",
)
: [],
};
}
} catch {
generationMetrics = null;
}
}
const verificationRecord = parseVerificationJson(set.verificationJson);
// The set's own search conditions, parsed back from its stored
// snapshot for the plan tab's 「条件」 panel (see planSetShape).
const snapshotConditions = parseSnapshotConditions(set);
// Last verified: the stored timestamp is authoritative — every
// write path (creation save, partial replacement, bulk
// re-verification) stamps it with the actual instant that
// verification passed. The creation record's checkedAt is only a
// fallback for legacy rows whose column is still null (it is a
// fetch DATE, so it can only stand in as that day, never as the
// verification instant — T96).
const fromRecordDate = checkedAtToDate(verificationRecord?.checkedAt);
const effectiveVerifiedAt = set.lastVerifiedAt ?? fromRecordDate;
planSets.push({
id: set.id,
title: set.title,
park: set.park,
visitDate: set.visitDate,
status: set.status,
verification: verificationRecord,
lastVerifiedAt: effectiveVerifiedAt
? effectiveVerifiedAt.toISOString()
: null,
reverifications: parseReverificationsJson(set.reverificationsJson),
verificationRunning: verifyingSetIds.has(set.id),
generationMetrics,
// Effective per-plan progress: a slot with a saved plan row IS done
// (it was actually saved — the display must never claim otherwise),
// a failed set's unsaved slots are failed, and the rest is the
// recorded per-plan state (waiting / generating). One exception: in
// a FINISHED set, a slot recorded as 作成中 is a partial replacement
// in flight — its saved row is still the OLD plan until the swap
// actually lands, so the slot honestly shows 作成中 while the other
// slots stay 完了.
planProgress: {
A:
set.status === "done" && set.progressA === "generating"
? "generating"
: plans.some((p) => p.slot === "A")
? "done"
: set.status === "failed"
? "failed"
: set.progressA,
B:
set.status === "done" && set.progressB === "generating"
? "generating"
: plans.some((p) => p.slot === "B")
? "done"
: set.status === "failed"
? "failed"
: set.progressB,
C:
set.status === "done" && set.progressC === "generating"
? "generating"
: plans.some((p) => p.slot === "C")
? "done"
: set.status === "failed"
? "failed"
: set.progressC,
},
generationStartedAt:
set.status === "generating"
? (set.generationStartedAt ?? set.createdAt).toISOString()
: null,
partialOpStarts: (() => {
const ops = parsePendingOps(set.pendingOpsJson);
const fallback = (set.progressUpdatedAt ?? set.createdAt).toISOString();
const startFor = (slot: "A" | "B" | "C", prog: string) => {
if (set.status !== "done" || prog !== "generating") return null;
const op = ops[slot];
return op ? new Date(op.startedAt).toISOString() : fallback;
};
return {
A: startFor("A", set.progressA),
B: startFor("B", set.progressB),
C: startFor("C", set.progressC),
};
})(),
partialOpFailures: (() => {
const ops = parsePendingOps(set.pendingOpsJson);
const failureFor = (slot: "A" | "B" | "C", prog: string) => {
if (set.status !== "done" || prog !== "failed") return null;
return ops[slot]?.failureText ?? null;
};
return {
A: failureFor("A", set.progressA),
B: failureFor("B", set.progressB),
C: failureFor("C", set.progressC),
};
})(),
error: set.error,
rebuiltFromSetId: set.rebuiltFromSetId,
setType: set.setType,
sameDay:
set.setType === "same_day" && set.sameDayLocation && set.sameDayStartTime
? {
location: set.sameDayLocation,
// The stored start time uses the schedule rows' unpadded
// "9:00" form; the client feeds this value into the 当日検索
// time input (via the 再検索 prefill), which only accepts
// the padded form — pad it on the way out (see padTimeOfDay).
startTime: padTimeOfDay(set.sameDayStartTime) ?? set.sameDayStartTime,
request: set.sameDayRequest,
}
: null,
walkingSpeed: set.walkingSpeed,
crowdLevel: set.crowdLevel,
crowdBasis: set.crowdBasis,
priorities: parseSnapshotPriorities(set.conditionsSnapshot),
conditions: set.conditionsSnapshot ? snapshotConditions.conditions : null,
conditionsMissing: snapshotConditions.missing,
// A fetch stuck past the stale window is surfaced as failed so the
// user gets the retry button back instead of an endless "取得中" —
// unless the task manager is running this fetch, in which case its
// own deadlines govern and the fetch keeps showing 取得中.
imagesStatus:
isStaleImageFetch(set) && !mgrManagedKeys.has(`item_images:${set.id}`)
? "failed"
: set.imagesStatus,
notes: set.notes,
parkHours: set.parkHours,
sources,
estimateSources,
createdAt: set.createdAt.toISOString(),
plans,
});
}

// Day-before （前日） dialog target: a finished standard plan set
// whose visit date is TOMORROW in park time (Asia/Tokyo) and whose
// dialog has never been shown. At most one is offered at a time —
// the nearest visit date wins (all candidates share tomorrow's
// date by construction, so the earliest created set breaks ties).
const todayJst = jstTodayIso();
const eveCandidate = setRows
.filter(
(s) =>
s.status === "done" &&
s.setType === "standard" &&
s.visitDate != null &&
s.eveDialogShownAt == null &&
isoDayBefore(s.visitDate) === todayJst,
)
.sort(
(a, b) =>
(a.visitDate ?? "").localeCompare(b.visitDate ?? "") || a.id - b.id,
)[0];
const eveVerification =
eveCandidate && eveCandidate.visitDate
? {
planSetId: eveCandidate.id,
title: eveCandidate.title,
visitDate: eveCandidate.visitDate,
}
: null;

// Task-manager dialog notice: the oldest one not yet shown.
// The client captures it into a dialog the moment it appears
// and marks it shown at the same moment, so it displays once.
const noticeRows = await db
.select()
.from(schema.mgrDialogNotices)
.where(isNull(schema.mgrDialogNotices.shownAt))
.orderBy(asc(schema.mgrDialogNotices.id))
.limit(1);
const noticeRow = noticeRows[0];
const mgrDialogNotice = noticeRow
? { id: noticeRow.id, text: noticeRow.text }
: null;

return {
conditions,
messages: messageRows.map((m) => ({
id: m.id,
role: m.role,
text: m.text,
createdAt: m.createdAt.toISOString(),
})),
planSets,
researchPending,
waitTimeSources,
waitTimeSourcesPending,
verificationPending,
eveVerification,
mgrDialogNotice,
};
},
}),

markMgrDialogShown: defineAction({
description:
"Marks one task-manager dialog notice as shown (the read record for the congestion dialog the client displays when an auxiliary production processing — wait-time site list update, image fetch, or restaurant fact correction — exhausted its attempts). Called by the client the moment it captures the notice into its dialog state, so the notice is offered exactly once.",
request: z.object({ noticeId: z.number() }),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
await db
.update(schema.mgrDialogNotices)
.set({ shownAt: new Date() })
.where(
and(
eq(schema.mgrDialogNotices.id, args.noticeId),
isNull(schema.mgrDialogNotices.shownAt),
),
);
return { ok: true as const };
},
}),

checkAnnouncement: defineAction({
description:
"Announcement check (spec §22.1), called by the client when the space is opened. Fetches the distributor's announce.json from the fixed ANNOUNCE_URL (read-only). A fetch failure, an unparseable response, or a non-numeric Ver is ignored completely: the action ends normally with no display data and never returns an error. The fetched Body is passed through an allowlist HTML sanitizer (formatting tags and https links only; scripts, event handlers and all other markup are stripped) BEFORE it is stored or returned, so feed markup can never execute in a viewer's browser. When the fetched Ver is newer than the saved announcement (or none is saved yet), the fetched announcement is saved — the save itself is the read record — and, only then and only when its Title is non-empty, the display data (title and body) is returned. An equal or older Ver changes nothing and returns no display data. The optional overrideJson (a fetched announcement JSON text) and overrideUrl (an alternate fetch URL) inputs exist for verification only; the normal client never passes them.",
request: z.object({
overrideJson: z.string().optional(),
overrideUrl: z.string().optional(),
}),
response: z.object({
show: z.boolean(),
title: z.string().nullable(),
body: z.string().nullable(),
}),
async handler(
ctx,
args,
): Promise<{ show: boolean; title: string | null; body: string | null }> {
const none: { show: boolean; title: string | null; body: string | null } = {
show: false,
title: null,
body: null,
};
// Obtain the announcement JSON: the verification override when
// given, otherwise the fixed URL (or its verification stand-in).
let parsed: unknown = null;
if (args.overrideJson != null) {
try {
parsed = JSON.parse(args.overrideJson);
} catch {
return none;
}
} else {
try {
const res = await fetch(args.overrideUrl ?? ANNOUNCE_URL, {
signal: AbortSignal.timeout(10000),
});
if (!res.ok) return none;
parsed = await res.json().catch(() => null);
} catch {
return none;
}
}
if (typeof parsed !== "object" || parsed === null) return none;
const record = parsed as Record<string, unknown>;
const ver = record.Ver;
if (typeof ver !== "number" || !Number.isFinite(ver)) return none;
const title = typeof record.Title === "string" ? record.Title : "";
// The body is sanitized BEFORE it is stored or returned (see
// sanitizeAnnouncementHtml): the stored row and the display data
// only ever carry the allowlisted form.
const body = sanitizeAnnouncementHtml(
typeof record.Body === "string" ? record.Body : "",
);
const db = ctx.db<typeof schema>();
const storedRows = await db
.select()
.from(schema.announcement)
.limit(1);
const stored = storedRows[0];
// Same or older than what is already saved (and therefore already
// read): do nothing.
if (stored && !(ver > stored.ver)) return none;
// Newer (or the first fetch ever): save it. The save happens
// whether or not the announcement is displayed — it is the read
// record that keeps the same announcement from showing twice.
const fetchedAt = new Date();
if (stored) {
await db
.update(schema.announcement)
.set({ ver, title, body, fetchedAt })
.where(eq(schema.announcement.id, stored.id));
} else {
await db
.insert(schema.announcement)
.values({ id: 1, ver, title, body, fetchedAt });
}
// Display only a freshly saved announcement with a non-empty
// title; an empty title is saved silently.
if (title === "") return none;
return { show: true, title, body };
},
}),

saveConditions: defineAction({
description:
"Saves the TAB2 conditions form (park, date, times, budget, party size, walking speed, and the single unified 「重視する点」 applied to all three plans).",
request: conditionsShape,
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const values = {
id: 1,
park: args.park,
visitDate: args.visitDate,
// Stored in canonical padded "HH:MM" form (see padTimeOfDay):
// callers include the plan tab's 「条件を変えて再検索」, which
// hands back snapshot-parsed conditions in the text convention's
// unpadded form.
entryTime: padTimeOfDay(args.entryTime),
exitTime: padTimeOfDay(args.exitTime),
budgetJpy: args.budgetJpy,
adults: args.adults,
children: args.children,
childrenAges: args.childrenAges,
stayHotel: args.stayHotel,
priority: args.priority,
walkingSpeed: args.walkingSpeed,
updatedAt: new Date(),
};
await db
.insert(schema.conditions)
.values(values)
.onConflictDoUpdate({ target: schema.conditions.id, set: values});
ctx.invalidateQueries();
return { ok: true};
},
}),

sendMessage: defineAction({
description:
"Sends a user message to the TAB1 AI chat; returns the assistant reply, plus whether it kicked off plan generation. Whether to start — and whether it is a fresh creation, a whole-set rebuild, a partial replacement of one plan, or a day-of reschedule — is judged by the chat AI from the conversation context and the open tab (the user's explicit decision: no phrase gate; over-reading intent and starting is accepted, while a clear question, fact-check request, or bare fact report does not start). A chat-started NEW creation runs ONLY on the conditions presented for THIS trigger （記録V sealing): the chat AI receives the triggering message as an independent input (id + text) and extracts chatConditions ONLY from the bounded window from the last generation start up to the trigger — never from older history, never from its own past replies, and never from the saved TAB2 form conditions (neither as base nor to fill gaps) — a missing required field (date, park, adult count, budget, entry/exit times) means no start and a reply asking back for exactly what is missing; children are never a required field — no mention of children fixes the count at 0 and starts without asking back, and a stated adult count (e.g. 「大人2人」) completes the party even without child ages/heights. Chat-presented budgets are always totals including park tickets. Rebuilds / reschedules / partial replacements run against the target set's saved conditions, parsed from its stored conditionsSnapshot (never the live form; snapshot fields that cannot be read are stated honestly in the start reply, not filled from the form). The whole handler runs inside the serialized start section shared by every start entrance, and a start that had to wait for a previous start says so in its reply, with the conditions actually used. Acceptance replies are written from the actual start result, naming the target set, the scope, the change, and the conditions actually used (date, park, party). The judgement also returns structured condition changes (conditionChanges — the condition values the instruction changes, with their new values, on any judgement kind): for a rebuild the server applies them to the target set's saved conditions and the new set is created with the changed conditions; a partial replacement carrying condition changes is rerouted to a whole-set rebuild on the changed conditions instead of a slot replacement. The server verifies the changes twice — on the sealed conditions before the start and on the created set's stored conditions after it — and a mismatch means no generation proceeds (the created set is removed) and the reply says the change could not be reflected, never a silent rebuild on the original conditions. Start replies (new creation, rebuild, reschedule) carry the full conditions actually used — date, park, party, budget, entry/exit times, walking speed, priority — built mechanically from the created set's stored snapshot, not from the model's wording. Also returns whether it kicked off an official-site fact-check, a wait-time reference-site list update (add/remove/re-search, on an explicit instruction), or a bulk re-verification （一括検証） of the reference plan set (a 「検証して」 instruction — re-checks the stored plans against freshly fetched official data and changes nothing). The client also reports the tab open at send time (`openTab`): when it is a plan-set tab, that set is the reference for plan mentions （「プランB」 means that set's plan B) and for edit/rebuild targets; from any other tab the reference falls back to the most recently created plan set. If the presented conditions say (in context, not by phrase matching) that a wheelchair user is among the participants, no start of any kind happens （記録AR): the reply is the fixed out-of-scope notice (core line 「車椅子の方が参加者に含まれる場合、本アプリでは対応できません」, plus the official DAS / 合流利用サービス / barrier-free guide named as information only — no §12.9 classification, no fixed guidance line) and generationStarted is null; a research request about wheelchair accessibility itself, with no wheelchair user stated as a participant, is not blocked and proceeds as research.",
request: z.object({
text: z.string().min(1).max(4000),
// The tab the user had open when the message was sent. `planSet`
// carries the set's id and the A/B/C slot selected in that tab.
openTab: z
.object({
kind: z.enum(["chat", "conditions", "waitsources", "help", "planSet"]),
planSetId: z.number().nullable().optional(),
slot: z.enum(["A", "B", "C"]).nullable().optional(),
})
.nullable()
.optional(),
}),
response: z.object({
reply: z.string(),
generationStarted: z.number().nullable(),
researchStarted: z.number().nullable(),
waitSourcesStarted: z.number().nullable(),
verificationStarted: z.number().nullable(),
}),
async handler(ctx, args) {
// 記録V: the WHOLE chat start section is serialized — trigger
// capture, window computation, inference (start judgement +
// condition extraction), impossibility gate, binding/start, and
// the saving of the start reply never overlap with another start
// section (chat, form button, same-day, partial, DPA button).
const startSection = await acquireStartSection();
try {
const db = ctx.db<typeof schema>();
// The trigger message, captured by id + text BEFORE any inference:
// the seal for a chat start belongs to this message alone.
const triggerInsert = await db
.insert(schema.messages)
.values({ role: "user", text: args.text})
.returning({ id: schema.messages.id});
const triggerMessageId = triggerInsert[0]?.id ?? null;
const triggerText = args.text;

const conditions = await loadConditions(ctx);
const recent = await db
.select()
.from(schema.messages)
.orderBy(desc(schema.messages.id))
.limit(12);
const history = recent
.reverse()
.map((m) => `${m.role === "user"? "ユーザー": "AI"}: ${m.text}`)
.join("\n");

const latestSets = await db
.select()
.from(schema.planSets)
.orderBy(desc(schema.planSets.id))
.limit(3);
const progressLabel = (p: "waiting" | "generating" | "done" | "failed"): string =>
p === "done"? "完了": p === "generating"? "作成中": p === "failed"? "失敗": "待機";
const setsText =
latestSets.length > 0
? latestSets
.map((s) => {
const verification = parseVerificationJson(s.verificationJson);
const reverifications = parseReverificationsJson(s.reverificationsJson);
const lastReverification = reverifications[reverifications.length - 1];
const reverificationText =
s.status === "done" && lastReverification
? `、一括検証: ${lastReverification.checkedAt.slice(0, 10)}に再検証済み（${lastReverification.problems.length > 0? `差分・問題${lastReverification.problems.length}件: ${lastReverification.problems.join("／")}`: "差分なし"}${lastReverification.unverified.length > 0? `、未確認${lastReverification.unverified.length}件`: ""}）`
: "";
const verificationText =
s.status === "done"
? verification
? `、検証: 済み（${verification.checkedAt?? "日付不明"}取得の公式データで照合${verification.unverified.length > 0? `、未確認${verification.unverified.length}件あり: ${verification.unverified.join("／")}`: ""}）${reverificationText}`
: `、検証: 記録なし（検証プロセス導入前のプラン。DPA対象可否や単価は照合されていない）${reverificationText}`
: "";
const partialNote =
s.status === "done"
? (["A", "B", "C"] as const)
.filter(
(sl) =>
(sl === "A"
? s.progressA
: sl === "B"
? s.progressB
: s.progressC) === "generating",
)
.map((sl) => `プラン${sl}を差し替え中`)
.join("、")
: "";
return `- ${s.title}${s.setType === "same_day"? "（当日検索：現在地点から指定時刻以降のプラン1件）": s.rebuiltFromSetId != null? "（既存プランの作り直し版）": ""}（状態: ${s.status === "done"? "作成済み": s.status === "generating"? "作成中": "失敗"}${s.status === "failed" && s.error? `、理由: ${s.error}`: ""}${s.status === "generating"? `、プラン別進捗: A=${progressLabel(s.progressA)}／B=${progressLabel(s.progressB)}／C=${progressLabel(s.progressC)}`: ""}${partialNote? `、${partialNote}`: ""}${verificationText}${s.crowdLevel != null? `、混雑予想: ${s.crowdLevel}／5${s.crowdBasis? `（${s.crowdBasis}）`: ""}（推定待ち時間には施設ごとの実効係数を適用済み。実効係数は検証の記録にあり）`: ""}）`;
})
.join("\n")
: "まだプランは作られていません。";

// Reference-set resolution （規準プラン）: when the message was sent
// from a plan-set tab, THAT set is the reference — 「プランB」 means
// that set's plan B, and questions, edits and rebuilds target it.
// From any other tab (or when the reported set no longer exists) the
// reference falls back to the most recently finished plan set. The
// open set is looked up by id rather than taken from the recent-sets
// list above, because the user may be looking at an older set.
type PlanSetRow = (typeof latestSets)[number];
const openTab = args.openTab ?? null;
const openSet: PlanSetRow | null =
openTab?.kind === "planSet" && openTab.planSetId != null
? ((await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, openTab.planSetId)))[0] ?? null)
: null;
const latestDoneSet = (await db.select().from(schema.planSets).where(eq(schema.planSets.status, "done")).orderBy(desc(schema.planSets.id)).limit(1))[0] ?? null;
const referenceSet: PlanSetRow | null = openSet ?? latestDoneSet;
const referenceBasis = openSet
? "ユーザーがこのメッセージを送ったときに開いていたタブのプラン"
: "最後に作ったプラン（プランのタブは開かれていなかったため）";
const openTabText =
openTab == null
? "（タブ情報なし）"
: openTab.kind === "planSet"
? `プランセットのタブを開いている（セット: 「${openSet?.title ?? "不明（削除済み）"}」${openTab.slot ? `、そのタブで選択中のプラン: プラン${openTab.slot}` : ""}）`
: openTab.kind === "conditions"
? "プラン作成タブを開いている"
: openTab.kind === "waitsources"
? "待ち時間参考サイトタブを開いている"
: openTab.kind === "help"
? "「もっとこうして！」タブ（アプリの作り替え案内）を開いている"
: "AIチャットタブを開いている";

// The actual saved plan contents (plan_items) of a set. Questions
// about what a plan contains — whether it has lunch, what time
// something happens — must be answered from THIS data, never inferred
// from the conditions form: a condition the user did not state says
// nothing about what the generated plan includes.
const buildContentsText = async (
set: PlanSetRow,
header: string,
): Promise<string> => {
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
if (planRows.length === 0) {
return `${header}\n（このプランには、まだ保存されたプランがありません）`;
}
const sections: string[] = [header];
// If the newest set overall is an unfinished rebuild OF this set, the
// contents below are still the ORIGINAL's — label them as such, so a
// question about the plan is never answered as if the rebuild had
// already changed these contents when it has not.
const newestSet = latestSets[0];
if (
newestSet &&
newestSet.id !== set.id &&
newestSet.rebuiltFromSetId === set.id &&
newestSet.status !== "done"
) {
sections.push(
`（注意：これは作り直し元のプランの内容です。作り直し版はまだ「${newestSet.status === "generating" ? "作成中" : "失敗"}」で、この内容は作り直されていません）`,
);
}
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
sections.push(`プラン${plan.slot}「${plan.title}」:`);
// The plan's saved cost figures belong to its actual contents:
// a question about the total cost or its breakdown （プランAの
// 合計費用はいくらですか？) must be answerable from THIS data —
// without it the chat AI could only say it could not confirm
// (T08). Amounts are the stored ones, never recomputed here.
if (plan.estimatedCostJpy != null) {
let breakdownText = "";
if (plan.costBreakdownJson) {
try {
const parsed: unknown = JSON.parse(plan.costBreakdownJson);
if (Array.isArray(parsed)) {
const lines = parsed
.filter(
(l): l is { label: string; amountJpy: number | null; note?: string | null } =>
typeof l === "object" &&
l !== null &&
typeof (l as { label?: unknown }).label === "string" &&
(typeof (l as { amountJpy?: unknown }).amountJpy === "number" ||
(l as { amountJpy?: unknown }).amountJpy === null),
)
.map(
(l) =>
`${l.label} ${l.amountJpy != null ? `${l.amountJpy.toLocaleString("ja-JP")}円` : "金額なし"}${l.note ? `（${l.note}）` : ""}`,
);
if (lines.length > 0) breakdownText = `（内訳: ${lines.join("、")}）`;
}
} catch {
breakdownText = "";
}
}
sections.push(
`- 費用合計: ${plan.estimatedCostJpy.toLocaleString("ja-JP")}円${breakdownText}`,
);
}
for (const it of itemRows) {
sections.push(
`- ${it.timeLabel ?? "時刻なし"} ${it.name}（${it.kind}${it.area ? `、${it.area}` : ""}）${it.estWaitMin != null ? ` 推定待ち約${it.estWaitMin}分` : ""}${it.travelMin != null ? ` 前の項目からの移動約${it.travelMin}分（サーバー計算）` : ""}${it.unconfirmedReason ? ` 未確定（${it.unconfirmedReason}）` : ""}${it.note ? ` ${it.note}` : ""}`,
);
}
}
return sections.join("\n");
};

let planContentsText = "（確認できる作成済みプランはありません）";
if (referenceSet) {
const statusNote =
referenceSet.status === "done"
? ""
: referenceSet.status === "generating"
? "、状態: 作成中（保存済みのプランのみ）"
: "、状態: 失敗（保存済みのプランのみ）";
const blocks: string[] = [
await buildContentsText(
referenceSet,
`【規準プラン】「${referenceSet.title}」（根拠: ${referenceBasis}${statusNote}）の実際の内容:`,
),
];
// When the open tab's set is not the latest finished set, the
// latest set's contents are included too, clearly labeled as NOT
// the reference: an explicit designation in the message (a date,
// a tab title) outranks the open tab, and the AI can only honor
// it for a set whose contents are actually in front of it.
if (latestDoneSet && referenceSet.id !== latestDoneSet.id) {
blocks.push(
await buildContentsText(
latestDoneSet,
`【参考：最新の作成済みプラン】「${latestDoneSet.title}」の実際の内容（規準ではありません。文面に日付やタブ名などの明示の指定がある場合だけ、こちらを対象にすること）:`,
),
);
}
planContentsText = blocks.join("\n\n");
}

// Currently registered wait-time reference sites, so instructions like
// 「○○を削除して」 can be matched against the real list.
const waitSourcesNow = await loadWaitTimeSources(ctx);
const waitSourcesText =
waitSourcesNow.length > 0
? waitSourcesNow
.map(
(s) =>
`- ${s.name}（${s.url}、取得方法の記録: ${s.fetchMethod?? "未記録"}）`,
)
.join("\n")
: "（登録なし）";

// 記録V — the condition-extraction window for a chat NEW creation:
// the messages from the LAST GENERATION START up to the trigger,
// and nothing older. The boundary is the newest plan set's creation
// instant (a generation start creates its set inside the start
// section, so every message after that instant belongs to the
// current exchange); when no set exists yet, the window is bounded
// to the last few messages ending at the trigger — never the whole
// conversation history. Because this handler runs inside the start
// section, a parallel request's start (and its set) is already
// complete and visible here, so another request's conditions can
// never leak into this window.
const windowRowsDesc = await db
.select()
.from(schema.messages)
.orderBy(desc(schema.messages.id))
.limit(30);
const windowRowsAsc = windowRowsDesc.reverse();
const lastStartAt =
latestSets.length > 0
? Math.max(...latestSets.map((s) => s.createdAt.getTime()))
: null;
let windowMessages =
lastStartAt != null
? windowRowsAsc.filter(
(m) =>
m.createdAt.getTime() > lastStartAt || m.id === triggerMessageId,
)
: windowRowsAsc.slice(-6);
if (
triggerMessageId != null &&
!windowMessages.some((m) => m.id === triggerMessageId)
) {
const trig = windowRowsAsc.find((m) => m.id === triggerMessageId);
if (trig) windowMessages = [...windowMessages, trig];
}
windowMessages = windowMessages.filter(
(m) => triggerMessageId == null || m.id <= triggerMessageId,
);
const windowText =
windowMessages.length > 0
? windowMessages
.map(
(m) =>
`${m.role === "user"? "ユーザー": "AI"}（メッセージID ${m.id}）: ${m.text}`,
)
.join("\n")
: `ユーザー（メッセージID ${triggerMessageId ?? "?"}）: ${triggerText}`;
const windowUserTexts = windowMessages
.filter((m) => m.role === "user")
.map((m) => m.text);

const result = await ctx.inference.complete(
[
`あなたは「我が家のディズニー計画」のTAB1にいる計画アシスタントです。このアプリは旅行前の計画づくりに加えて、当日のリスケジュールにも対応します。ただし、DPA（ディズニー・プレミアアクセス）の販売状況はこのアプリでは取得できません。販売状況については、アプリが知っているかのような言い方を絶対にしないでください（下の【当日の対応ルール】参照）。`,
``,
`【保存済みの条件（プラン作成タブのフォーム値）】これは参考情報です。チャットから新規作成を開始する場合の条件抽出（chatConditions）には絶対に使わないでください（下の【チャット条件の受け渡しルール】参照）。`,
conditionsToText(conditions),
``,
``,
setsText,
``,
``,
planContentsText,
``,
`ユーザーがこのメッセージを送ったときに開いていたタブ: ${openTabText}`,
``,
`現在登録されている待ち時間参考サイト:`,
waitSourcesText,
``,
``,
history,
``,
`【トリガーメッセージ（この回の返信・開始判定の対象。独立入力）】`,
`メッセージID: ${triggerMessageId ?? "不明"}`,
`本文: ${triggerText}`,
``,
`【条件抽出の対象範囲（新規作成の chatConditions は、ここのユーザーメッセージからのみ抽出すること）】`,
`（範囲は「最後の生成開始以降〜トリガーメッセージまで」に限られます。これより前の会話履歴と、冒頭の【保存済みの条件】は抽出源ではありません。）`,
windowText,
``,
`ユーザーの最新メッセージ（上のトリガーメッセージ）に返信してください。返信は簡潔な日本語で。意図の判定は次のルールに厳密に従ってください。`,
``,
`【適用範囲の境界（厳守・開始判断の前段）】`,
`・このアプリはディズニー旅行計画のためのアプリであり、万能アプリではありません。元のリクエストがディズニー旅行計画と無関係な場合、または計画リクエストとして意味をなさない（計画の対象・条件として解釈できない）場合は、プラン制作自体を行わず、その旨を簡潔に正直に伝えて終了してください。wantsPlanGeneration は false とし、researchQuestion や waitTimeSourcesInstruction、verificationRequest にも入れないでください。無理にプラン化したり、骨組みだけのプランを「完了」として出したり、開始していないのに「開始しました」と言ったりしてはいけません。返信は、制作を行わないことだけを簡潔に伝えるものとし、下の無理ゲート由来の分類つき拒否の形式は使わないでください（本項は不可能の判定ではありません）。`,
`・境界に近い場合（計画依頼として解釈できる余地がある場合）は制作を止めず、不足分を聞き返す通常の流れで扱ってください。止めるのは、無関係・意味不明が明らかな場合だけです。`,
`・この境界は、計画依頼としての体裁が成立した条件について不可能を判定する「無理ゲート」とは別段の、その前段の境界です。`,
``,
`【プラン作成の開始判断（原則）】`,
`・開始するかどうかは、文型や特定の言い回しの有無ではなく、会話の文脈と開いているタブの情報から判断してください。ユーザーがプランの作成・変更を求めていると文脈から判断できる場合は、wantsPlanGeneration を true にして開始してよい。言い回しが簡潔・口語的でも（例：「作り直して」「やっぱりBにセンター入れて」「Bだけ直して」）、文脈が意図を示していれば開始の意図として扱うこと。意図を深読みして開始してしまう側の誤りは許容されます（ユーザーの決定です）。`,
`・要求が無理に見える場合（対象パークに無い施設の必須指定、全アトラクション制覇のような時間的に収まらない指定、同時刻に2か所を指定するような矛盾した指定、予算が明らかに足りない指定など）でも、作成・作り直し・差し替えを求められている文脈なら、wantsPlanGeneration は true のままにしてください。無理かどうかの判定は、開始判断とは別の段であるアプリ側の「無理ゲート」が材料と照らして行い、無理と判定された場合の拒否の文面もアプリ側が固定形式（謝罪＋原因の分類＋案内文）で返します。あなた自身が「できません」と断る返信を書いて開始を見送ったり、条件を緩める代案を提示して開始を保留したりしてはいけません（開始したかどうかは実際の開始結果で決まります）。`,
`・逆に、質問への回答だけが求められている場合、制度や施設の事実確認（調査）が求められている場合、当日の事実の報告を受け止めるだけの場合（文脈上、組み直しの依頼と読めない場合）は開始しないこと。迷った場合は、直前のやり取り全体（自分が何を案内し、ユーザーがそれにどう応じたか）から判断すること。自分が「『作り直して』とお伝えください」のように進め方を案内した直後にユーザーがそれに沿って返したら、それは開始の意図です。`,
`・費用を下げる方向だけの曖昧な変更指示（例：「もっと安くして」「安くして」「もっと安いプランにして」）で、新しい予算額や目標金額（「予算を5万円にして」「あと1万円安く」等）が文面にも文脈にも示されていない場合は、開始しないでください。予算は条件の値であり、新しい値が決まらなければ変更のしようがありません。同じ予算のまま作り直しても「安く」はならないので、開始せず、返信で目標の金額（新しい予算の総額）を聞き返してください（例：「いくらくらいまでに抑えたいですか？新しい予算の金額を教えてください」）。この場合は wantsPlanGeneration は false、conditionChanges は null です。逆に、新しい金額が示されている場合は通常どおり条件変更として開始してください（conditionChanges.budgetJpy に新しい総額を入れる）。この聞き返しは費用の変更だけに適用されます：施設の追加・削除のような内容の変更は、従来どおり文脈から深読みして開始してよい。`,
`・開始する場合は generationKind に種別を入れてください：新しいプランの作成は "new"、規準プランの作り直し（セット全体）は "rebuild"、当日の事実をもとに残りの時間を組み直す場合は "reschedule"。開始しない場合は null。特定のプランだけへの変更は generationKind を "rebuild" とし、対象と内容を planChange に入れてください（部分差し替えとして実行されます）。`,
`・"rebuild" でも実際には元のプランは上書きされず、元のプランをもとにした新しいプランが別のタブに作られます（部分差し替えの場合は、同じセット内でそのプランだけが差し替わります）。返信でも実際の動作どおりに伝えてください（「作り直します」とだけ言うと上書きされるように聞こえるので禁止）。同じパーク・同じ日付のプランが既にあるだけでは作り直しにはなりません——文脈が単なる新規作成なら "new" として扱い、「作り直し」とは言わないでください。プラン作成タブのボタンから開始された作成も、常に新規作成です。作成を求められていて日付が未定なら true にせず、日付を聞いてください。`,
``,
`【チャット条件の受け渡しルール（新規作成・厳守）】`,
`・チャットから新規作成（generationKind が "new"）を開始する場合に使う条件は、上の【条件抽出の対象範囲】に示したユーザーメッセージ（最後の生成開始以降〜トリガーメッセージ）で提示された条件だけです。抽出源はその範囲に限定してください：範囲より前の会話履歴（このプロンプトの会話履歴欄に古い条件が載っていても）、冒頭の【保存済みの条件】（プラン作成タブのフォーム値）、AI自身の過去の返信（開始応答に復唱された条件を含む）は、抽出源として絶対に使ってはいけません（流用・補完・暗黙の上書きは禁止）。範囲内のユーザーメッセージに条件が提示されていたら、それを chatConditions に正確に抽出してください：日付は YYYY-MM-DD、時刻は H:MM、予算は数値（円）に正規化し、人数は大人／子どもの人数、子どもの年齢・身長は提示された表記のまま childrenAges に入れる。範囲内に異なる値が複数ある場合は、トリガーメッセージの値を最優先し、トリガーに無い項目だけを範囲内の他のユーザーメッセージで補ってください。提示されていない項目は null のままにし、タブの保存条件で埋めないこと。ただし子どもは例外です：子どもの記載が範囲内に無ければ、子どもは0人として確定し、children に 0 を入れてください（null のままにしない）。子どもの年齢・身長（childrenAges）が書かれていなくても不足として扱わないでください（childrenAges は null でよい）。「大人2人」のように大人の人数が明記されていれば、人数は揃ったものとして扱ってください（子どもの年齢・身長が無くても人数の不足にしない）。予算は常に総額（チケット代込み）として扱ってください：提示された金額をそのまま budgetJpy に入れ、チケット代を差し引いたり「チケット代を除く目安」として解釈したりしないでください。`,
`・必須項目（日付・パーク・大人の人数・予算・入園時刻・退園時刻）が抽出範囲の提示条件に足りない場合でも、タブの条件や範囲外の履歴で埋めてはいけません。その場合も wantsPlanGeneration は true、generationKind は "new" とし、chatConditions には提示された分だけを入れてください（不足分はアプリ側が聞き返し、開始しません）。返信では、不足している項目を挙げて聞き返してください。聞き返してよいのは、日付・パーク・大人の人数・予算・入園／退園時刻が読み取れない場合に限ります。子どもは必須項目ではありません：子どもの記載が無ければ子ども0人で確定し、子どもの有無や子どもの年齢・身長を聞き返してはいけません。`,
`・作り直し（"rebuild"）・当日のリスケジュール（"reschedule"）・部分差し替えでは chatConditions は null でよい（対象セットの保存条件が使われます）。ただし、利用者の指示が条件の値を変える内容を含む場合は、chatConditions が null でも、下の【条件の変更点の受け渡しルール】に従って conditionChanges に変更点を必ず入れてください。`,
``,
`【条件の変更点の受け渡しルール（厳守）】`,
`・利用者の指示が、条件（日付・パーク・大人の人数・子どもの人数・子どもの年齢や身長・予算・入園時刻・退園時刻・重視する点・歩く速さ）のどれかの値を変える内容なら、判定の種類（新規作成・作り直し・当日のリスケジュール・部分差し替え）にかかわらず、変更される項目と新しい値を conditionChanges に構造化して必ず入れてください。変える項目だけに新しい値を入れ、変えない項目は null のままにしてください。条件の変更が無い場合は conditionChanges は null です。`,
`・条件の値を変える指示は、作り直しや修正の依頼であっても、必ず条件の変更点として返してください。値を落として「作り直し」という判定だけにすることは禁止です（例：「退園を19:30にして」は、作り直しの依頼であると同時に、退園時刻を19:30に変える条件変更です。generationKind は "rebuild"、conditionChanges.exitTime は "19:30" と、両方を返してください）。`,
`・条件の変更は planChange には入れないでください。planChange はプランの内容そのものへの変更（施設の追加・削除・入れ替え）専用です。条件の値の変更だけの指示では planChange は null にしてください。条件変更を含む指示は、アプリ側で「変更後の条件での作り直し」として実行されます（特定のプランへの内容変更と一緒に指示された場合も、条件変更が優先され、セット全体の作り直しになります）。`,
`・予算の変更は、新しい金額（総額）が示されている場合だけ conditionChanges.budgetJpy に入れてください。「もっと安くして」のように方向だけで金額の示されていない指示は、条件変更として扱ってはいけません（開始せず金額を聞き返す。上の【プラン作成の開始判断（原則）】参照）。`,
`・変更の相談段階（まだ開始指示がなく、生成が開始されていない同じやり取りの中）で決まった条件変更は、ユーザーが後から「作り直して」とだけ言ったときも、その変更を conditionChanges に入れて引き継いでください。ただし、その変更をきっかけに既に生成が開始されている場合は反映済みであり、再び conditionChanges に入れてはいけません。`,
`・conditionChanges の抽出源は、上の【条件抽出の対象範囲】（最後の生成開始以降〜トリガーメッセージまで）にあるユーザーメッセージだけです。範囲より前の会話履歴に条件の変更があっても、それは既に開始済みの生成で反映されているので、履歴から拾って別の作り直しへ再適用してはいけません（例：前の指示で退園19:30への変更が開始済みのあとに「作り直して」とだけ言われた場合は、対象セットの保存条件のまま作り直すもので、conditionChanges は null です）。`,
`・値の書式：日付は YYYY-MM-DD、時刻は H:MM、予算は数値（円・総額）、歩く速さは ゆっくり="slow"／少しゆっくり="slightly_slow"／少し急いで="slightly_fast"／急いで="fast"、子どもの年齢・身長は提示された表記のまま childrenAges に入れてください。`,
``,
`【当日の対応ルール（厳守）】`,
`・「当日は対応できません」「ご自身で調整をお願いします」のような、当日対応を断る言い方は絶対にしないでください。このアプリは当日のリスケジュールに対応します。`,
`・ユーザーが当日の事実（例：「トイ・ストーリー・マニア！のDPAが買えなかった」「もう◯◯に乗った」「◯◯はやめた」）を報告したら、まず報告を受け止め、その事実が現在のプランにどう影響するか（その項目をどう扱う必要があるか）を短く伝えてください。事実の報告だけのメッセージ（組み直しを求める言葉が文面にも文脈にも無いもの）では、絶対に開始しないでください（仕様書第12.1節の原則：当日の事実の報告だけのメッセージでは作成を始めない）。開始せず、リスケジュールを提案してください（例：「その場合は◯◯をスタンバイで組み直すか、別の項目に替えられます。リスケジュールしますか？」）。開始するのは、メッセージ自体が組み直しを求めている場合（「リスケジュールして」「組み直して」等の依頼が文面にある場合）と、あなたがリスケジュールを提案した直後にユーザーがそれを受け入れた場合だけです。「買えなかった」「取れなかった」「乗った」「やめた」等の事実の言明だけを、組み直しの依頼と読み替えてはいけません。`,
`・リスケジュールを開始する場合は、報告された事実をもとに残りの時間を組み直すことを伝えてください。`,
`・DPAの販売状況（販売中か、売り切れたか、残りがあるか）はこのアプリには分かりません。ユーザーの報告だけが情報源です。ユーザーの報告にない販売状況を断定する言い方（「◯◯のDPAは売り切れています」「まだ買えます」など）、アプリが販売状況を知っているかのような言い方は絶対にしないでください。`,
``,
`【質問への調査ルール（厳守）】`,
`・ディズニーの制度・施設・料金など事実確認が必要な質問に、保存済みプランの内容や条件だけでは答えられない場合は、「プラン作成時に確認します」と答えて先送りしてはいけません。その場合は researchQuestion に、会話の文脈を含めて自己完結した質問文（対象のショー/施設名、知りたい点）を入れ、返信では「公式サイトで確認して、このチャットで回答します」と伝えてください。プラン作成には一切触れないでください。`,
`・ユーザーが直前の質問について「調べて」「確認して」と言った場合も、researchQuestion にその質問を入れてください（下のデータで直接答えられる内容なら、調査に出さず直接答えてください）。`,
`・制度の詳細を記憶で断定してはいけません。`,
``,
`【車椅子に関する回答ルール（厳守）】`,
`・車椅子での施設の利用可否に触れる質問・相談では、公式の根拠なしに「乗れます」「利用できます」「一緒に楽しめます」のように、利用できる前提で答えてはいけません。保存済みプランの行に書かれたメモも、公式の根拠ではありません。答える場合は、公式には確認できていない旨を明示してください（公式確認が必要なら researchQuestion で調査に出してください）。`,
`・車椅子の方が参加者に含まれる条件で、プランの作成・作り直し・差し替え・当日のリスケジュールを求められた場合は、あなた自身が「対応できません」と断る返信を書いたり、開始を見送ったりしてはいけません。通常どおり wantsPlanGeneration を true にしてください。対応できない旨の明示と、公式の仕組み（ディスアビリティアクセスサービス／合流利用サービス／公式サイトのバリアフリー案内）の案内は、アプリ側が固定文で返します。`,
`・車椅子対応の有無そのものを調べる調査依頼（参加者に車椅子利用者がいるとは限らない、一般的な確認）は、通常どおり researchQuestion として扱ってください。`,
``,
`【作成状況の質問への回答ルール（厳守）】`,
`・プランの渡し方（共有）について聞かれたら、作成済みのプランは、プランのタブの「PDF」ボタンで作成すると中身がその場に表示され、保存ボタン（スマホでは「保存・共有する」、PCのChromeなどでは「ダウンロード」と表示される）からファイルに保存して、LINEやメールなどで自分で送る方式であることを伝えること。共有リンクの発行や公開ページの作成はできない。PDFの作成はこのチャットからは開始しない（プランのタブのボタン専用）。`,
`・「当日検索」について聞かれたら、計画を作らずに来園した人向けの緊急回避用の入口で、プラン作成タブの下部にある「当日検索」フォーム（パーク・現在地点・指定時刻・人数・予算・歩く速さ・ご要望）から開始すること、現在の掲示待ち時間をもとに指定時刻から閉園までのプランを1つ作ることを伝えること。当日検索の開始はそのフォーム専用で、このチャットからは開始しない（wantsPlanGeneration を true にしない）。`,
`・「作り直しは終わったのか？」「プランはできた？」など作成状況を聞かれたら、上のプラン一覧の状態から明確に答えること。状態が「作成済み」なら「終わりました。『（そのプランのタイトル）』のタブに表示されています」とはっきり伝える。「作成中」なら「まだ作成中です」と伝え、一覧にプラン別進捗があればそれも伝える（例：プランAは作成中、プランB・Cは待機中）。所要時間に触れる場合は「作成には10〜20分ほどかかります」と実態どおりに伝えること（「数分で終わる」のような過小な言い方は禁止）。終わったらこのチャットで「終わりました」と知らせることも伝える。「失敗」なら失敗したことと、プラン作成タブから再作成できることを伝える。`,
`・状態は上のデータに書かれているのだから、「ここでは確認できませんでした」のような曖昧な言い方は絶対にしない。対象のプランが複数ある場合は、規準プラン（開いているタブのプラン、無ければ最新のもの）の状態を答えること。文面に別のプランへの明示の指定があれば、そちらの状態を答えること。`,
`・作り直しについての質問には、必ず「（既存プランの作り直し版）」と付いた最新のセットの状態で答えること。元のプランが「作成済み」でも、作り直し版が「失敗」なら作り直しは終わっていない——「作り直しは完了しませんでした。元のプランはそのまま残っています」と、作り直し版の失敗理由（一覧に記載あり）とあわせて伝えること。作り直し版が「作成中」なら、元のプランの状態をもって「終わりました」と答えてはいけない。作り直し版のセットが一覧に無い場合は、作り直しは開始されていないと正直に伝えること。`,
`・「料金は合っているか」「そのDPAは本当にあるのか」などプランの正しさ・検証について聞かれたら、上のプラン一覧の「検証」の記載から答えること。検証済みのプランは、作成時に取得した公式データでDPA対象可否・単価・休止・営業時間・公演時刻・DPA購入順序を照合したものであること、移動時間は施設の座標・歩く速さ（条件）・エリア間マトリクスからサーバーが機械計算したものであること（座標が引けなかった区間は未確認として記録される）、未確認の項目があればその内容を正直に伝えること。「検証: 記録なし」のプランについては、検証プロセス導入前に作られたもので照合されていないと正直に伝え、気になる場合は作り直しを提案すること。検証されていないプランを「確認済み」と言ってはいけない。作成時の検証は作成時点の公式情報との照合であり、その後の変更は含まれない——最新の情報で照合し直したい場合は「検証して」と送れば一括検証が開始できることも伝えてよい。`,
``,
`【仕様変更が疑われる場合の案内ルール（厳守）】`,
`・返信の中で、現在のディズニーの仕様（DPA対象・単価、営業時間、公演時刻、休止情報など）が確認できないために先へ進めない旨、または検証の記載にあるDPA・ファクト等の未確認に触れる場合は、返信の最後に、次の趣旨をこのアプリの文体で添えること：「このアプリの前提が現在のディズニーの仕様と合わなくなっている可能性があります。直す場合は、Museのメインのチャットで『現在のディズニーの仕様に合わせて、このアプリを直してください』と伝えてください。」この画面のAI（計画づくり専用）にはアプリ自体を変更する手段がないことも、必要なら短く添えてよい。`,
`・逆に、通常の回答、確認できている事実の説明、仕様の確認と無関係な話題では、この案内を付けないこと（毎回付けると案内として機能しなくなる）。座標が引けなかった区間の未確認だけでは付けないこと。`,
``,
`【プランの一括検証ルール（厳守）】`,
`・ユーザーが既存プランの検証を求めた場合（「検証して」「再検証して」「最新の公式情報でプランがまだ正しいか確認して」など）は、verificationRequest を true にしてください。対象は規準プラン（開いているタブのプランセット、無ければ直近の作成済みセット）です。`,
`・一括検証は、来園日の公式情報（休止・営業時間・DPA対象と単価と適用期間・公演時刻）を公式サイトから取り直し、保存済みのプランに作成時と同じ照合をかけ直す作業です。プランの内容は一切変更しません。作り直しではないので wantsPlanGeneration は true にせず、制度の調査でもないので researchQuestion も入れないでください。`,
`・返信では「一括検証を開始しました。結果はこのチャットでお知らせします。プランの内容は変更しません」と伝えてください（実際の開始結果で上書きされる場合があります）。`,
`・「検証して、ダメだったら作り直して」のように検証と作り直しが一緒に求められた場合は、まず検証だけを開始してください（verificationRequest を true、wantsPlanGeneration は false）。作り直すかどうかは検証結果を見てからユーザーが判断します。`,
``,
`【待ち時間参考サイトの管理ルール（厳守）】`,
`・ユーザーが「待ち時間参考サイト」タブの登録リストについて、追加・削除・再検索（候補の探し直しや差し替え）を指示した場合は、waitTimeSourcesInstruction に、その指示の内容を自己完結した文で入れてください（対象サイト名や、追加したいサイトの手がかりがあればそれも含める）。返信では「参考サイトの更新を開始しました。終わったらこのチャットで報告します」と伝えてください。`,
`・参考サイトについての単なる質問（「どんなサイトが登録されてる？」など）は管理の指示ではないので、waitTimeSourcesInstruction は null のまま、上の登録リストから答えてください。`,
`・参考サイトの管理はプラン作成でも制度の調査でもありません。wantsPlanGeneration は true にせず、researchQuestion も入れないでください。`,
``,
`【プランの部分差し替えルール（厳守）】`,
`・ユーザーが規準プランの特定のプラン（A/B/C）への変更（施設の追加・削除・入れ替えなど）を指示・相談し、その変更がまだ現在のプランに反映されていない場合、planChange に {slot: 対象プランのスロット, instruction: 変更内容を自己完結した文（対象プランと、追加/削除/変更する内容を具体的に。例:「プランBにセンター・オブ・ジ・アースを追加する」）} を入れてください。これは、開始が決まったときにセット全体ではなくそのプランだけを同じセット内で差し替えるために使います。`,
`・変更の相談段階（まだ開始指示がない）でも、対象プランと変更内容が決まっていれば planChange に入れてください（開始するかどうかは wantsPlanGeneration で別に判定します）。ユーザーが後から「作り直して」とだけ言った場合も、直前のやり取りで決まった未反映の変更があれば、それを planChange に入れて引き継いでください。`,
`・変更が特定のプランを対象としない場合（セット全体の作り直し、軸そのものの変更など）は planChange を null にしてください。当日の事実報告（DPAが取れなかった等）だけでは planChange に入れないでください。`,
`・ただし、指示の内容が条件の値の変更（日付・パーク・人数・予算・入園／退園時刻・重視する点・歩く速さなど）を含む場合は、それは部分差し替えではありません。その変更は planChange ではなく conditionChanges に入れてください（上の【条件の変更点の受け渡しルール】参照）。プランの内容への変更と条件変更が同時に指示された場合も、内容の変更は planChange に、条件の変更は conditionChanges に、それぞれ入れてください（アプリ側では条件変更が優先され、変更後の条件での作り直しとして実行されます）。`,
`・変更の相談への返信では、その変更が現在のプランに入っているかどうかを上の「実際の内容」で確認して答え、入っていない場合は「反映するにはそのプランの差し替えが必要です。ご希望の場合は『作り直して』とお伝えください」のように、言えば開始する言葉を正確に案内してください。`,
``,
`【参照プランの規準ルール（厳守）】`,
`・プランへの言及（「プランA/B/C」「このプラン」など）と、プランについての質問・編集・作り直しの対象は、上の【規準プラン】を指すものとして扱うこと。規準プランは、ユーザーがメッセージ送信時にプランセットのタブを開いていた場合はそのセット、そうでない場合は最後に作ったプランです。「プランBにセンター・オブ・ジ・アースを入れて」のような指示は、規準プランのプランBへの指示です。`,
`・ユーザーがプランセットのタブでプラン（A/B/C）を選択中だと示されている場合、「このプラン」「いま見ているプラン」はそのプランを指します。`,
`・ただし、文面に日付やタブのタイトルなど、別のプランへの明示の指定があれば、そちらを優先すること。そのプランの内容が上のデータに含まれていない場合は、推測で答えず、そのプランの内容はここでは確認できない旨を正直に伝えること。`,
`・プランセットが複数あり、対象が曖昧になりうる場合は、返答の中でどのプランを規準にしたかを分かるように書くこと（例：「開いているタブのプラン『2026-11-29 東京ディズニーシー』のプランBについてです」）。対象が自明なときは書かなくてよい。`,
``,
`【プランの内容に関する質問への回答ルール（厳守）】`,
`・「プランAに昼食はあるか」「何時に◯◯があるか」など、保存済みプランの内容・有無・時刻に関する質問には、必ず上の「実際の内容」に書かれたデータを確認してから答えること。`,
`・条件フォームの内容から推測で答えることを禁止する。「条件に希望が入っていないので、入っていない可能性があります」のような回答は絶対にしない。条件に書かれていなくても、プランには食事や施設が入っていることがある。`,
`・上のデータで確認できない場合は、推測で埋めず「プランを確認できませんでした」と正直に伝えること。`,
`・条件が足りなければ何が足りないかを具体的に聞き、条件の変更はプラン作成タブでもできることを案内できます。`,
].join("\n"),
{
schema: z.object({
reply: z.string(),
// True when the user asks for a bulk re-verification （一括検証）
// of the reference plan set: re-fetch the official data for its
// visit date and re-check the stored plans against it. Changes
// nothing — a verification request is neither a plan creation nor
// a fact-check research.
verificationRequest: z.boolean(),
wantsPlanGeneration: z.boolean(),
// What kind of start the chat AI judged (context judgement, not
// phrasing): "new" fresh creation, "rebuild" whole-set rework of
// the reference set, "reschedule" day-of rework of the rest of the
// day. Null when not starting.
generationKind: z.enum(["new", "rebuild", "reschedule"]).nullable(),
// The conditions the user PRESENTED IN THIS CONVERSATION, extracted
// verbatim by the chat AI (see the チャット条件の受け渡しルール in
// the prompt). For a chat-started NEW creation these — and only
// these — become the new set's conditions snapshot; the saved form
// conditions are never used to fill or override them. Fields the
// conversation did not present stay null; the server asks back for
// missing required fields instead of starting — except children,
// which default to 0 when unmentioned (記録AQ). Null for
// rebuild / reschedule / partial replacement (the target set's own
// saved conditions govern those) and when not starting.
chatConditions: z
.object({
park: parkEnum.nullable(),
visitDate: z.string().max(20).nullable(),
entryTime: z.string().max(10).nullable(),
exitTime: z.string().max(10).nullable(),
budgetJpy: z.number().int().min(0).nullable(),
adults: z.number().int().min(0).max(20).nullable(),
children: z.number().int().min(0).max(20).nullable(),
childrenAges: z.string().max(300).nullable(),
// No stayHotel: the 宿泊 field was removed from the conditions
// entirely (2026-11-16) — a stay is no longer a condition.
// The single unified 「重視する点」 as presented in the
// conversation (one field for all three plans).
priority: z.string().max(2000).nullable(),
walkingSpeed: walkingSpeedEnum.nullable(),
})
.nullable(),
// The structured condition CHANGES this instruction makes (see
// 【条件の変更点の受け渡しルール】 in the prompt): only the fields
// whose values change, with their new values — returned on EVERY
// judgement kind whenever the instruction changes a condition
// value. The server applies them to the target set's saved
// conditions for a rebuild, reroutes a partial replacement that
// carries them to a whole-set rebuild on the changed conditions,
// and verifies the created set's stored conditions against them
// before the start is announced. Null when the instruction
// changes no condition value.
conditionChanges: conditionChangesShape.nullable(),
researchQuestion: z.string().nullable(),
waitTimeSourcesInstruction: z.string().nullable(),
// A decided, not-yet-reflected change targeting ONE plan of the
// reference set (see the 部分差し替え rules in the prompt). When
// generation starts with this set, only that plan is replaced
// inside the same set — no new set is created.
planChange: z
.object({
slot: slotEnum,
instruction: z.string().min(1).max(1000),
})
.nullable(),
}),
},
);

let replyText = result.reply;
let generationStarted: number | null = null;
let researchStarted: number | null = null;
let waitSourcesStarted: number | null = null;
let verificationStarted: number | null = null;
// The start judgement is the chat AI's (see the principle comment
// above startGeneration): result.wantsPlanGeneration says WHETHER
// to start, and result.generationKind says WHAT KIND — "new"
// (fresh creation), "rebuild" (whole-set rework of the reference
// set), or "reschedule" (day-of: rework the rest of the visit day
// from the user's own report). What the server still decides
// deterministically is the TARGET and the bookkeeping: a rebuild /
// reschedule targets the REFERENCE set (the set whose tab is open,
// else the latest finished set — the app's standing 規準 rule),
// for its park and visit date — a rebuild said while looking at a
// plan means that plan, even if the conditions form currently
// names another park/date.
const isReschedule = result.generationKind === "reschedule";
const pc = result.planChange;
// Condition changes judged by the chat AI, normalized by the
// server (unparseable values dropped; an all-empty judgement reads
// as "no condition change"). Whenever the user's instruction
// changes a condition VALUE, these are the new values — on any
// judgement kind.
const condChanges = normalizeConditionChanges(result.conditionChanges);
// A partial replacement carrying condition changes is NOT run as a
// partial replacement (owner's rule, 2026-11-20): changed
// conditions redefine the whole set, so the run becomes a
// whole-set rebuild on the changed conditions, even when the model
// also returned a planChange.
const explicitRebuild =
result.generationKind === "rebuild" ||
isReschedule ||
(pc != null && condChanges != null);
const rebuildTargetSet =
explicitRebuild && referenceSet && referenceSet.status === "done"
? referenceSet
: null;
// Partial replacement routing: a decided change targeting ONE plan
// of the reference set replaces only that plan, in the same set.
// Target validation on top of the model's planChange (this checks
// WHERE the change lands, not WHETHER to start): the reference set
// must be finished, and the slot must be anchored in the
// conversation — named in a recent user message, or the slot
// selected in the open plan-set tab. A day-of reschedule is never
// partial (it rebuilds the rest of the day as a set, as before).
// A judgement carrying condition changes never routes here (see
// explicitRebuild above).
const recentUserTexts = recent
.filter((m) => m.role === "user")
.slice(0, 4)
.map((m) => m.text);
const partialChange =
pc != null &&
condChanges == null &&
!isReschedule &&
referenceSet != null &&
referenceSet.status === "done" &&
(openTab?.slot === pc.slot ||
recentUserTexts.some((t) => new RegExp(`プラン\\s*${pc.slot}`).test(t)))
? pc
: null;
if (result.waitTimeSourcesInstruction) {
// A reference-site management instruction: update the list only.
// This branch runs first so it can never fall through into research
// or plan generation.
const started = await startWaitSourcesUpdate(
ctx,
result.waitTimeSourcesInstruction,
);
if (started.ok) {
waitSourcesStarted = started.requestId;
} else {
replyText =
"参考サイトの更新を開始できませんでした。少し時間をおいて、もう一度お試しください。";
}
} else if (result.researchQuestion) {
// A fact-check request: research only. This branch runs first so a
// research request can never fall through into plan generation.
const started = await startResearch(ctx, result.researchQuestion, conditions);
if (started.ok) {
researchStarted = started.researchId;
} else {
replyText =
"公式サイトの確認を開始できませんでした。少し時間をおいて、もう一度お試しください。";
}
} else if (result.verificationRequest) {
// A bulk re-verification request: re-check the reference set's
// stored plans against freshly fetched official data. Changes
// nothing, creates nothing. This branch runs before plan
// generation so a 「検証して」 can never start a creation, and
// the acceptance reply is written from the ACTUAL start result —
// the same say/do rule as generation starts.
const target =
referenceSet && referenceSet.status === "done" ? referenceSet : null;
if (!target) {
replyText =
"検証できる作成済みのプランがまだありません。プランを作成したあとで、もう一度「検証して」とお伝えください。";
} else {
const started = await startPlanVerification(
ctx,
target.id,
"chat",
false,
);
if (started.ok && started.alreadyRunning) {
verificationStarted = target.id;
replyText = `「${target.title}」の一括検証は、今まさに実行中です。結果はこのチャットでお知らせします。`;
} else if (started.ok) {
verificationStarted = target.id;
replyText = `承知しました。「${target.title}」の一括検証を開始しました。公式情報を取り直して現在のプランと照合し、結果はこのチャットでお知らせします。プランの内容は変更しません。`;
} else {
replyText = `「${target.title}」の一括検証を開始できませんでした。少し時間をおいて、もう一度お試しください。`;
}
}
} else if (result.wantsPlanGeneration) {
// The chat AI judged this a start (context judgement, per the
// user's decision — no phrase gate). What happens next depends on
// the kind: a partial replacement and a rebuild / reschedule run
// against the TARGET set (its park/date and saved conditions); a
// NEW creation runs on the conditions presented in THIS
// conversation alone (result.chatConditions) — the saved form
// conditions are never used for a chat-started creation, neither
// as the base nor to fill gaps.
//
// 車椅子：対応範囲外の明示 (owner's decision, 記録AR): BEFORE any
// kind of start is judged further, the presented conditions are
// read contextually — the trigger message, the extraction
// window's exchange (the presented conditions for a new
// creation), the extracted 「重視する点」, a decided partial
// change, and (for a rebuild / replacement) the target set's
// stored conditions. When a wheelchair user is among the
// participants, NOTHING starts — no material fetch, no task, no
// plan set — and the reply is the fixed out-of-scope text (the
// verbatim core line + the official mechanisms named as
// information). This is separate from the §12.9 impossibility
// gate: no cause classification, no fixed guidance line.
//
// The parts are LABELED for the judge: the window can hold an
// EARLIER, already-answered request next to this one (the window
// boundary is the last generation START, and a refused request
// starts nothing), so the judge is told to judge the party of
// the request being started NOW — earlier messages count only
// when they present conditions for THIS request.
const wheelchairTexts: string[] = [
`【今回の要求（トリガーメッセージ）】\n${args.text}`,
`【同じやり取り内の先行メッセージ（最後の生成開始以降）】\n${windowText}`,
];
if (result.chatConditions?.priority) {
wheelchairTexts.push(
`【今回の要求から抽出された「重視する点」】\n${result.chatConditions.priority}`,
);
}
if (partialChange) {
wheelchairTexts.push(
`【決定済みの部分変更】\n${partialChange.instruction}`,
);
}
if (condChanges) {
wheelchairTexts.push(
`【今回の指示による条件の変更点】\n${conditionChangesToText(condChanges)}`,
);
}
if ((explicitRebuild || partialChange) && referenceSet) {
wheelchairTexts.push(
`【対象セットの保存条件（作り直し・差し替えの条件）】\n${conditionsToText(parseSnapshotConditions(referenceSet).conditions)}`,
);
}
const wheelchairBlocked = await judgeWheelchairParticipant(
ctx,
wheelchairTexts.join("\n\n"),
);
if (wheelchairBlocked) {
replyText = WHEELCHAIR_OUT_OF_SCOPE_TEXT;
} else if (partialChange && referenceSet) {
// Partial replacement: only the targeted plan of the reference
// set is regenerated, in place. No new set, and the other plans
// keep their data exactly. generationStarted carries the
// EXISTING set's id so the client shows that set's tab.
// 無理ゲート (entry layer, §6.2.1): the decided change is judged
// against the fixed impossibility patterns BEFORE anything
// starts; a hit returns the §12.9 rejection and no replacement
// is spawned (the original plan stays exactly as it is).
// 記録V seal: the partial replacement's conditions come from the
// TARGET SET's stored conditionsSnapshot — parsed here, inside
// the start section, before the gate — never from the live form.
const partialSeal = parseSnapshotConditions(referenceSet);
const gateFindings = await judgeImpossibility(ctx, {
park: referenceSet.park,
visitDate: referenceSet.visitDate,
entryTime: partialSeal.conditions.entryTime,
exitTime: partialSeal.conditions.exitTime,
budgetJpy: partialSeal.conditions.budgetJpy,
adults: partialSeal.conditions.adults,
children: partialSeal.conditions.children,
requirements: `${partialChange.instruction}\n${args.text}`,
});
const startedPartial = gateFindings
? null
: await startPartialReplacement(
ctx,
referenceSet,
partialChange.slot,
partialChange.instruction,
partialSeal.conditions,
);
if (gateFindings) {
replyText = formatImpossibilityRejection(gateFindings);
} else if (startedPartial?.ok) {
generationStarted = referenceSet.id;
replyText = `${waitedStartPrefix(startSection.waited)}承知しました。「${referenceSet.title}」のプラン${partialChange.slot}だけを、変更内容（${partialChange.instruction}）を反映して差し替えます。（対象条件: ${setConditionsSummary(referenceSet)}）他のプランはそのまま残ります。出来上がったら、このチャットでお知らせします。${snapshotMissingNote(partialSeal.missing)}`;
} else if (startedPartial?.alreadyRunning) {
generationStarted = referenceSet.id;
replyText = `プラン${partialChange.slot}は今まさに差し替え中です。終わったら、このチャットでお知らせします。`;
} else {
replyText = `プラン${partialChange.slot}の差し替えを開始できませんでした。元のプラン${partialChange.slot}はそのまま残っています。少し時間をおいて、もう一度お試しください。`;
}
} else if (explicitRebuild) {
if (!rebuildTargetSet) {
// Judged a rebuild / reschedule, but there is no finished set to
// target. Say so honestly instead of starting something else.
replyText =
"作り直しの対象になる作成済みのプランが見つからなかったため、開始できていません。作り直したいプランのタブを開いた状態で、もう一度お伝えください。新規作成の場合は、日付・パーク・人数・予算・入園／退園時刻をこのチャットでお伝えください。";
} else {
// A day-of reschedule carries the user's own
// report of the day-of facts into the generation assignment: their
// most recent messages are the report (the fact and the instruction
// may arrive in separate messages). The facts themselves are never
// invented here — only what the user actually said is passed on.
// 記録V: the day-of report and the decided changes are taken from
// the extraction window's USER messages (last generation start →
// trigger) — the same bounded range as condition extraction, never
// the unbounded history.
const dayOf = isReschedule
? {
userReport: windowUserTexts.slice(-3).join("／"),
}
: null;
// Change conditions decided in the preceding exchange, carried
// into a whole-set rebuild so it reflects THOSE changes instead
// of a generic re-run: the window's user messages, minus any
// bare start command （「作り直して」 alone carries no change).
const changeMessages = windowUserTexts
.filter(
(t) =>
!(
t.trim().length <= 14 &&
/(作り直|作りなお|リスケ|再作成|再検索)/.test(t)
),
)
.slice(-3);
const changeRequest =
explicitRebuild && dayOf == null && changeMessages.length > 0
? changeMessages.join("／")
: null;
// A chat start is recorded as a 作り直し only when the chat AI
// judged it a rebuild / reschedule of the reference set. A plain
// creation request stays a fresh creation even if a finished set
// for the same park and date already exists.
// 無理ゲート (entry layer, §6.2.1): the rebuild / reschedule
// requirements (the user's message, the decided changes, the
// day-of report) are judged against the fixed impossibility
// patterns BEFORE a new set is created; a hit returns the
// §12.9 rejection and nothing starts — the original set stays
// untouched and no new tab appears.
// 記録V seal: a rebuild / reschedule runs on the TARGET SET's
// stored conditionsSnapshot, parsed here inside the start section
// before the gate — the live form's current values (which used to
// supply everything except park/date) play no part at all.
const rebuildSeal = parseSnapshotConditions(rebuildTargetSet);
// Condition changes judged by the chat AI are applied to the
// target set's saved conditions HERE, deterministically, by the
// server: the gate below judges the CHANGED conditions, and the
// new set is created with them — never with the original
// conditions plus a note. (2026-11-20 incident: a rebuild judged
// from 「退園を19:30にして」 carried no change anywhere and
// silently rebuilt on the original 19:00 exit time.)
const appliedConditions = condChanges
? applyConditionChanges(rebuildSeal.conditions, condChanges)
: rebuildSeal.conditions;
// Server-side verification, BEFORE anything starts: the sealed
// conditions about to be used must actually carry every judged
// change. A mismatch means the change would be lost — the start
// is refused below and the reply says so; the original conditions
// are never silently used instead.
const sealMismatch = condChanges
? conditionChangeMismatches(appliedConditions, condChanges)
: [];
const gateFindings =
sealMismatch.length > 0
? null
: await judgeImpossibility(ctx, {
park: appliedConditions.park,
visitDate: appliedConditions.visitDate ?? rebuildTargetSet.visitDate,
entryTime: appliedConditions.entryTime,
exitTime: appliedConditions.exitTime,
budgetJpy: appliedConditions.budgetJpy,
adults: appliedConditions.adults,
children: appliedConditions.children,
requirements: [
args.text,
changeRequest ?? "",
dayOf?.userReport ?? "",
]
.filter((s) => s.trim().length > 0)
.join("\n"),
});
if (sealMismatch.length > 0) {
replyText = `条件の変更（${sealMismatch.join("、")}）を新しいプランに反映できませんでした。そのため、元の条件のまま作り直すことはせず、生成は開始していません。元のプランはそのまま残っています。お手数ですが、変更内容をもう一度お伝えください。`;
} else if (gateFindings) {
replyText = formatImpossibilityRejection(gateFindings);
} else {
const started = await startGeneration(
ctx,
appliedConditions,
dayOf,
explicitRebuild,
rebuildTargetSet?.id ?? null,
changeRequest,
);
// Server-side verification, AFTER the set exists: the created
// set's STORED conditions (read back and parsed from its own
// snapshot) must carry every judged change. If they do not, the
// run is stopped — the created set is removed again, exactly as
// a cancel removes a whole-set generation, so no generation
// proceeds on the wrong conditions — and the reply says the
// change could not be reflected. The original set stays
// untouched throughout.
const newSetRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, started.planSetId))
.limit(1);
const newSet = newSetRows[0];
const storedMismatch =
condChanges && newSet
? conditionChangeMismatches(
parseSnapshotConditions(newSet).conditions,
condChanges,
)
: [];
if (condChanges && (!newSet || storedMismatch.length > 0)) {
const mismatchLabels =
storedMismatch.length > 0 ? storedMismatch : ["条件"];
await closeOpenRunLog(
ctx,
started.planSetId,
"failed",
`条件の変更（${mismatchLabels.join("、")}）が作成したセットの保存条件と一致しなかったため、開始を取り消した`,
null,
"cancelled",
);
await deletePlanSetRows(ctx, started.planSetId);
replyText = `条件の変更（${mismatchLabels.join("、")}）を新しいプランに反映できませんでした。そのため、元の条件のまま作り直すことはせず、生成は開始していません。元のプランはそのまま残っています。お手数ですが、変更内容をもう一度お伝えください。`;
} else {
generationStarted = started.planSetId;
// The conditions ACTUALLY used, built mechanically from the
// created set's stored snapshot — never the model's paraphrase.
const actualConditions = newSet
? conditionsToText(parseSnapshotConditions(newSet).conditions)
: conditionsToText(appliedConditions);
// The acceptance reply is written from the ACTUAL start result, not
// the model's draft (same rule as the not-started branch below). A
// rebuild does not overwrite the original: a new set is created from
// it and the original stays. Saying 「作り直します」 alone claims an
// in-place rewrite that never happens — the user called that
// mismatch out explicitly — so a rebuild is announced in the words
// of what the app really does.
replyText = started.dayOf
? `${waitedStartPrefix(startSection.waited)}承知しました。報告いただいた当日の状況をもとに、残りの時間のリスケジュールを作成します。元のプランはそのまま残り、できたプランは新しいタブに表示されます。出来上がったら、このチャットで「終わりました」とお知らせします。\n【実際に使う条件】\n${actualConditions}${snapshotMissingNote(rebuildSeal.missing)}`
: `${waitedStartPrefix(startSection.waited)}承知しました。既存のプラン「${started.rebuiltFromTitle ?? rebuildTargetSet.title}」をもとに、新しいプランを作成します。元のプランはそのまま残り、できたプランは新しいタブに「作り直し版」として表示されます。出来上がったら、このチャットで「終わりました」とお知らせします。\n【実際に使う条件】\n${actualConditions}${snapshotMissingNote(rebuildSeal.missing)}`;
}
}
}
} else {
// Fresh creation from chat: the conditions are the ones presented
// in THIS conversation (result.chatConditions), extracted by the
// chat AI — and nothing else. The saved form conditions are never
// consulted here: not as the base, not to fill a gap. A required
// field the conversation did not present (date, park, adult
// count, budget, entry/exit times) means NO start: the reply
// asks back for exactly what is missing. Children are not in
// that list: unmentioned children are fixed at 0 and never
// asked back. (The incident this fixes: a chat
// request carrying full conditions for 2026-12-20 was answered
// 「作成を開始しました」 while generation silently ran on the
// form's stale 2026-11-29 conditions.)
const cc = result.chatConditions;
const ccPark = cc?.park ?? null;
const ccVisitDate = cc?.visitDate ?? null;
// Padded at extraction (see padTimeOfDay): the chat AI returns
// the user's own phrasing ("9:00"), and the seal built from these
// values feeds snapshot text that later round-trips back into the
// form — the padded form is the only one that survives that trip.
const ccEntryTime = padTimeOfDay(cc?.entryTime ?? null);
const ccExitTime = padTimeOfDay(cc?.exitTime ?? null);
const ccBudget = cc?.budgetJpy ?? null;
const ccAdults = cc?.adults ?? null;
const ccChildren = cc?.children ?? null;
const ccDateValid =
ccVisitDate != null &&
/^\d{4}-\d{2}-\d{2}$/.test(ccVisitDate) &&
!Number.isNaN(new Date(`${ccVisitDate}T00:00:00`).getTime());
const ccTimeValid = (t: string | null): boolean =>
t != null && /^\d{1,2}:\d{2}$/.test(t);
const cleanTextCc = (s: string | null | undefined): string | null => {
const t = (s ?? "").trim();
return t ? t : null;
};
const ccMissing: string[] = [];
if (!ccDateValid) ccMissing.push("日付");
if (ccPark == null) ccMissing.push("パーク（ランド／シー）");
// Party rule (記録AQ): only the ADULT count is a required
// field. Children are never missing — no mention in the
// conversation fixes them at 0 (ccChildren defaults to 0 at the
// seal below), and missing child ages/heights never block a
// start either.
if (ccAdults == null || ccAdults < 1) {
ccMissing.push("大人の人数");
}
if (ccBudget == null || ccBudget <= 0) ccMissing.push("予算");
if (!ccTimeValid(ccEntryTime)) ccMissing.push("入園時刻");
if (!ccTimeValid(ccExitTime)) ccMissing.push("退園時刻");
// 無理ゲート (entry layer, §6.2.1): judged BEFORE the
// missing-fields ask-back, on the requirements as presented
// (the extracted 「重視する点」 plus the user's own message,
// which carries the full wording even when an extracted field
// came back missing). An impossible request is refused
// outright — there is no point asking the user to complete
// conditions for a plan that cannot be made — while a pass
// falls through to the ask-back / start below.
const gateFindings =
ccPark != null
? await judgeImpossibility(ctx, {
park: ccPark,
visitDate: ccVisitDate,
entryTime: ccEntryTime,
exitTime: ccExitTime,
budgetJpy: ccBudget,
adults: ccAdults ?? 0,
children: ccChildren ?? 0,
requirements: [cleanTextCc(cc?.priority) ?? "", args.text]
.filter((s) => s.trim().length > 0)
.join("\n"),
})
: null;
if (gateFindings) {
replyText = formatImpossibilityRejection(gateFindings);
} else if (
ccPark == null ||
ccVisitDate == null ||
!ccDateValid ||
ccEntryTime == null ||
!ccTimeValid(ccEntryTime) ||
ccExitTime == null ||
!ccTimeValid(ccExitTime) ||
ccBudget == null ||
ccBudget <= 0 ||
ccAdults == null ||
ccAdults < 1
) {
// Not started — and the reply must say so honestly, naming what
// is missing (an unverified "作成を開始しました" was once
// saved while generation ran on entirely different conditions).
replyText = `プランの作成は開始できていません。チャットから作成する場合は、このチャットで提示された条件だけを使います（プラン作成タブに保存されている条件は使いません）。次の項目が不足しています：${ccMissing.join("、")}。このチャットでお伝えください。プラン作成タブの条件で作る場合は、タブの「この条件で3プランを作成」ボタンをお使いください。`;
} else {
const cleanText = (s: string | null | undefined): string | null => {
const t = (s?? "").trim();
return t ? t : null;
};
// 記録V seal: the extracted conditions are frozen into ONE
// immutable object belonging to this trigger alone; the gate
// above, the start below, and the reply's repetition all read
// only this seal — shared conditions are never re-read.
const chatConditions: Conditions = Object.freeze({
park: ccPark,
visitDate: ccVisitDate,
entryTime: ccEntryTime,
exitTime: ccExitTime,
budgetJpy: ccBudget,
adults: ccAdults,
// No mention of children in the conversation = 0 children,
// fixed (記録AQ) — never a reason to ask back.
children: ccChildren ?? 0,
childrenAges: cleanText(cc?.childrenAges),
// The 宿泊 field no longer exists (removed 2026-11-16); the seal
// carries the Conditions shape's null for it.
stayHotel: null,
priority: cleanText(cc?.priority),
// Not presented in the conversation = the system default, never
// the form's value.
walkingSpeed: cc?.walkingSpeed ?? "slightly_slow",
});
const started = await startGeneration(ctx, chatConditions);
generationStarted = started.planSetId;
// The acceptance reply carries the conditions ACTUALLY used,
// built mechanically from the created set's stored snapshot (the
// chat-presented ones, now sealed on the set) — date, park,
// party, budget, entry/exit times, walking speed and the
// 「重視する点」, never the model's paraphrase.
const newSetRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, started.planSetId))
.limit(1);
const newSet = newSetRows[0];
const actualConditions = newSet
? conditionsToText(parseSnapshotConditions(newSet).conditions)
: conditionsToText(chatConditions);
replyText = `${waitedStartPrefix(startSection.waited)}承知しました。提示いただいた条件で、プランの作成を開始しました。出来上がったら新しいタブに表示され、このチャットで「終わりました」とお知らせします。\n【実際に使う条件】\n${actualConditions}`;
}
}
}

await db
.insert(schema.messages)
.values({ role: "assistant", text: replyText});
ctx.invalidateQueries();
return { reply: replyText, generationStarted, researchStarted, waitSourcesStarted, verificationStarted};
} finally {
startSection.release();
}
},
}),

requestPlanGeneration: defineAction({
description:
"Starts generating the three plans (A/B/C) from the saved TAB2 conditions; official-site data is fetched at this moment by a background task. If the form's free-text conditions say (in context) that a wheelchair user is among the participants, nothing starts: the fixed out-of-scope notice （記録AR — core line 「車椅子の方が参加者に含まれる場合、本アプリでは対応できません」, plus the official DAS / 合流利用サービス / barrier-free guide named as information only, no §12.9 classification and no guidance line) is posted to the chat and returned as the error.",
request: z.object({}),
response: z.object({
ok: z.boolean(),
planSetId: z.number().nullable(),
error: z.string().nullable(),
}),
async handler(ctx) {
// 記録V: serialized start section. The seal is the saved conditions
// read exactly ONCE, AFTER the lock is acquired; the gate, the
// start, and any announcement use only that seal.
const startSection = await acquireStartSection();
try {
const sealedConditions: Conditions = Object.freeze(
await loadConditions(ctx),
);
if (!sealedConditions.visitDate) {
return {
ok: false,
planSetId: null,
error: "先にプラン作成タブで日付を入力してください。",
};
}
// 車椅子：対応範囲外の明示 (owner's decision, 記録AR): the form's
// free-text conditions are read contextually BEFORE anything
// else; when a wheelchair user is among the participants, the
// fixed out-of-scope text is posted to the chat and returned as
// the error, and nothing starts — no set, no task. (Separate
// from the §12.9 gate below: no classification, no guidance
// line.)
const wheelchairBlocked = await judgeWheelchairParticipant(
ctx,
[
sealedConditions.priority ?? "",
sealedConditions.childrenAges ?? "",
].join("\n"),
);
if (wheelchairBlocked) {
const db = ctx.db<typeof schema>();
await db.insert(schema.messages).values({
role: "assistant",
text: WHEELCHAIR_OUT_OF_SCOPE_TEXT,
});
ctx.invalidateQueries();
return { ok: false, planSetId: null, error: WHEELCHAIR_OUT_OF_SCOPE_TEXT };
}
// 無理ゲート (entry layer, §6.2.1): the form's 「重視する点」 is
// judged against the fixed impossibility patterns BEFORE a plan
// set is created; a hit posts the §12.9 rejection to the chat and
// nothing starts — no set, no task.
const gateFindings = await judgeImpossibility(ctx, {
park: sealedConditions.park,
visitDate: sealedConditions.visitDate,
entryTime: sealedConditions.entryTime,
exitTime: sealedConditions.exitTime,
budgetJpy: sealedConditions.budgetJpy,
adults: sealedConditions.adults,
children: sealedConditions.children,
requirements: sealedConditions.priority ?? "",
});
if (gateFindings) {
const rejection = formatImpossibilityRejection(gateFindings);
const db = ctx.db<typeof schema>();
await db.insert(schema.messages).values({
role: "assistant",
text: rejection,
});
ctx.invalidateQueries();
return { ok: false, planSetId: null, error: rejection };
}
// The プラン作成 tab button is a fresh creation BY CONTRACT: it
// never records a 作り直し， even when a finished set for the same
// park and visit date already exists (isRebuild defaults to false).
const started = await startGeneration(ctx, sealedConditions);
if (startSection.waited) {
// A waited start is never silent about the wait （記録V): the
// form button has no chat reply of its own, so the fact — and
// the conditions actually used — are posted to the chat, like
// every other entrance's start announcement.
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, started.planSetId))
.limit(1);
const newSet = setRows[0];
await db.insert(schema.messages).values({
role: "assistant",
text: newSet
? `${waitedStartPrefix(true)}「${newSet.title}」のプラン作成を開始しました。（実際に使う条件: ${setConditionsSummary(newSet)}）`
: `${waitedStartPrefix(true)}プランの作成を開始しました。（実際に使う条件: ${setConditionsSummary({ conditionsSnapshot: conditionsToText(sealedConditions), park: sealedConditions.park, visitDate: sealedConditions.visitDate })}）`,
});
ctx.invalidateQueries();
}
return { ok: true, planSetId: started.planSetId, error: null};
} finally {
startSection.release();
}
},
}),

requestSameDaySearch: defineAction({
description:
"Starts a 当日検索 (same-day search) from the プラン作成 tab's emergency form: for a visitor who arrived without a plan, builds ONE plan for the rest of today — from the visitor's current location (area or facility name) at the specified start time through park closing — using the CURRENT posted wait times. The form's values (park, location, start time, party, budget cap, walking speed, free-text requests) are taken from this request alone and snapshotted onto the new plan set; the TAB2 conditions are not read for the run's park/date/party and are never overwritten. The new set is marked setType \"same_day\" and holds exactly one plan (slot A). Completion and failure are announced in the chat by the save/failure paths, as with ordinary generation. If the request text says (in context) that a wheelchair user is among the participants, nothing starts and the fixed out-of-scope notice （記録AR) is posted to the chat and returned as the error, as at the other entrances.",
request: z.object({
park: parkEnum,
currentLocation: z.string().min(1).max(120),
startTime: z.string().min(4).max(5),
adults: z.number().int().min(0).max(20),
children: z.number().int().min(0).max(20),
childrenAges: z.string().max(100).nullable().optional(),
budgetJpy: z.number().int().min(0).nullable().optional(),
walkingSpeed: walkingSpeedEnum,
request: z.string().max(2000),
}),
response: z.object({
ok: z.boolean(),
planSetId: z.number().nullable(),
error: z.string().nullable(),
}),
async handler(ctx, args) {
// 記録V: serialized start section. The seal is built from THIS
// request's arguments alone (the existing structure, kept): the
// TAB2 conditions are never read for a same-day start.
const startSection = await acquireStartSection();
try {
const location = args.currentLocation.trim();
if (!location) {
return {
ok: false,
planSetId: null,
error: "現在地点（エリア名または施設名）を入力してください。",
};
}
const tm = /^(\d{1,2}):(\d{2})$/.exec(args.startTime.trim());
if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) {
return {
ok: false,
planSetId: null,
error: "指定時刻を正しく入力してください。",
};
}
if (args.adults + args.children < 1) {
return {
ok: false,
planSetId: null,
error: "人数（大人＋子ども）を1人以上にしてください。",
};
}
// Normalized to the "9:05" form the schedule rows use.
const startTime = `${Number(tm[1])}:${tm[2]}`;
const requestText = args.request.trim();
const sealedSameDay: SameDayInput = Object.freeze({
park: args.park,
location,
startTime,
adults: args.adults,
children: args.children,
childrenAges: args.childrenAges?.trim()? args.childrenAges.trim(): null,
budgetJpy: args.budgetJpy?? null,
walkingSpeed: args.walkingSpeed,
request: requestText? requestText: null,
});
// 車椅子：対応範囲外の明示 (owner's decision, 記録AR): the
// same-day request text is read contextually BEFORE anything
// starts; when a wheelchair user is among the participants, the
// fixed out-of-scope text is posted to the chat and returned as
// the error, and no plan set is created. (Separate from the
// §12.9 gate below: no classification, no guidance line.)
const wheelchairBlocked = await judgeWheelchairParticipant(
ctx,
[requestText, sealedSameDay.childrenAges ?? ""].join("\n"),
);
if (wheelchairBlocked) {
const db = ctx.db<typeof schema>();
await db.insert(schema.messages).values({
role: "assistant",
text: WHEELCHAIR_OUT_OF_SCOPE_TEXT,
});
ctx.invalidateQueries();
return { ok: false, planSetId: null, error: WHEELCHAIR_OUT_OF_SCOPE_TEXT };
}
// 無理ゲート (entry layer, §6.2.1): the same-day request is judged
// against the fixed impossibility patterns BEFORE a plan set is
// created — with today's facts as the frame (from the specified
// start time to closing; the closing time is not an input, so the
// time pattern is judged conservatively). A hit posts the §12.9
// rejection to the chat and nothing starts.
const gateFindings = await judgeImpossibility(ctx, {
park: sealedSameDay.park,
visitDate: new Date().toLocaleDateString("sv-SE", {
timeZone: "Asia/Tokyo",
}),
entryTime: sealedSameDay.startTime,
exitTime: null,
budgetJpy: sealedSameDay.budgetJpy,
adults: sealedSameDay.adults,
children: sealedSameDay.children,
requirements: requestText,
});
if (gateFindings) {
const rejection = formatImpossibilityRejection(gateFindings);
const db = ctx.db<typeof schema>();
await db.insert(schema.messages).values({
role: "assistant",
text: rejection,
});
ctx.invalidateQueries();
return { ok: false, planSetId: null, error: rejection };
}
const started = await startSameDayGeneration(ctx, sealedSameDay);
if (startSection.waited) {
// A waited start states the wait and the conditions actually
// used （記録V), posted to the chat like other entrances'
// announcements (the same-day form has no chat reply of its own).
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, started.planSetId))
.limit(1);
const newSet = setRows[0];
await db.insert(schema.messages).values({
role: "assistant",
text: newSet
? `${waitedStartPrefix(true)}「${newSet.title}」の当日検索を開始しました。（実際に使う条件: ${setConditionsSummary(newSet)}・${sealedSameDay.startTime}から）`
: `${waitedStartPrefix(true)}当日検索を開始しました。`,
});
ctx.invalidateQueries();
}
return { ok: true, planSetId: started.planSetId, error: null};
} finally {
startSection.release();
}
},
}),

requestDpaReschedule: defineAction({
description:
"Starts the day-of reschedule behind a DPA purchase event's 「買えなかったら？」 button: the user has confirmed in the dialog that one specific DPA in the displayed plan could not be bought (optionally adding a free-text situation report, e.g. a substitute DPA bought instead, or permission to rework the whole plan). Only that one plan is rebuilt — as a partial replacement in the same set, in day-of mode: items before the purchase time stay as they are (unless the report allows a full rework), the target DPA premise is removed, any substitute purchase in the report is incorporated, and the remainder is re-timed from the CURRENT posted wait times. The other plans and other sets are never touched. The start is announced in the chat only after the task has actually started.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
itemId: z.number(),
// The dialog's free-text situation report; empty when the user
// added nothing (the premise alone then drives the reschedule).
userNote: z.string().max(1000),
}),
response: z.object({
ok: z.boolean(),
alreadyRunning: z.boolean(),
error: z.string().nullable(),
}),
async handler(ctx, args) {
// 記録V: serialized start section. The seal is built inside the
// section, at the button-press values: the target set's stored
// conditionsSnapshot + the target purchase event's info + the
// user's memo (args.userNote). The shared form conditions are NOT
// re-read before this start (the previous behaviour).
const startSection = await acquireStartSection();
try {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set || set.status!== "done") {
return {
ok: false,
alreadyRunning: false,
error: "対象のプランが見つかりませんでした。",
};
}
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plan = planRows.find((p) => p.slot === args.slot);
if (!plan) {
return {
ok: false,
alreadyRunning: false,
error: "対象のプランが見つかりませんでした。",
};
}
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.id, args.itemId))
.limit(1);
const item = itemRows[0];
if (
!item ||
item.planId!== plan.id ||
item.passType == null ||
!/プレミアアクセス|DPA/i.test(item.passType) ||
!item.dpaPurchaseTime
) {
return {
ok: false,
alreadyRunning: false,
error: "対象のDPA購入イベントが見つかりませんでした。",
};
}
const purchaseTime = item.dpaPurchaseTime;
const userNote = args.userNote.trim();
const premise =
`プラン${args.slot}の「${item.name}」（DPA購入予定 ${purchaseTime}、利用開始 ${item.timeLabel ?? "時刻未定"}）のディズニー・プレミアアクセスが買えなかった。` +
(userNote
? `ユーザーの状況報告：「${userNote}」`
: "ユーザーからの追加の状況報告はない。");
const changeInstruction =
`当日リスケジュール（DPA購入不可）：${premise}` +
`原則として、購入時刻 ${purchaseTime} より前の項目は時刻・内容をそのまま残し、${purchaseTime} 以降の残りのスケジュールだけを組み直すこと（状況報告が「全面的にリスケしてよい」という趣旨の場合のみ、プラン全体の組み直しも可）。` +
`対象の「${item.name}」はDPA前提を外すこと（スタンバイの推定待ち時間で組み直すか、残り時間に収まらなければ別の項目に替える／外す。外す場合は summary に理由を書く）。` +
`状況報告に「代わりに別のDPAを買った」という趣旨があれば、その代替DPAを購入済みの確定事実として、利用時間帯を含めてスケジュールに組み込むこと。` +
`残りのDPAの購入列は、そのまま残した購入も含めて60分ルールで成立させること。費用内訳（総額・DPA金額）も新しい前提で再計算すること（DPA費用は購入した時に、購入イベント行で1回だけ計上する）。`;
// 記録V seal: conditions from the TARGET SET's stored snapshot
// (parsed once, here), the purchase event read above, and the
// user's memo as pressed — frozen together for this start.
const dpaSeal = parseSnapshotConditions(set);
// 車椅子：対応範囲外の明示 (owner's decision, 記録AR): a day-of
// reschedule is a generation start like any other — when the
// target set's stored conditions (or the user's report) say a
// wheelchair user is among the participants, nothing starts and
// the fixed out-of-scope text is returned as the error.
const wheelchairBlocked = await judgeWheelchairParticipant(
ctx,
[conditionsToText(dpaSeal.conditions), userNote].join("\n"),
);
if (wheelchairBlocked) {
return {
ok: false,
alreadyRunning: false,
error: WHEELCHAIR_OUT_OF_SCOPE_TEXT,
};
}
const started = await startPartialReplacement(
ctx,
{
id: set.id,
title: set.title,
park: set.park,
visitDate: set.visitDate,
},
args.slot,
changeInstruction,
dpaSeal.conditions,
{
dayOfReport: premise,
startAnnouncement: `${waitedStartPrefix(startSection.waited)}「${set.title}」のプラン${args.slot}について、「${item.name}」のDPAが買えなかった場合のリスケジュールを開始しました。（対象条件: ${setConditionsSummary(set)}）他のプランはそのままです。出来上がったら、このチャットでお知らせします。${snapshotMissingNote(dpaSeal.missing)}`,
},
);
if (started.alreadyRunning) {
return {
ok: false,
alreadyRunning: true,
error: `プラン${args.slot}は今まさに差し替え中です。終わったら、このチャットでお知らせします。`,
};
}
if (!started.ok) {
return {
ok: false,
alreadyRunning: false,
error: "リスケジュールを開始できませんでした。元のプランはそのまま残っています。少し時間をおいて、もう一度お試しください。",
};
}
return { ok: true, alreadyRunning: false, error: null};
} finally {
startSection.release();
}
},
}),

requestLotteryReschedule: defineAction({
description:
"Starts the day-of reschedule behind a 「最初の10分」 lottery item's 「抽選に外れたら？」 button: the user has confirmed in the dialog that the entry lottery for one specific show in the displayed plan was lost (optionally adding a free-text situation report, e.g. a DPA bought instead, or permission to rework the whole plan). Only that one plan is rebuilt — as a partial replacement in the same set, in day-of mode, through exactly the same route as the DPA 「買えなかったら？」 flow: items before the show's performance time stay as they are (unless the report allows a full rework), the show's win-assumed premise is removed, any substitute purchase in the report is incorporated, and the remainder is re-timed from the CURRENT posted wait times. The other plans and other sets are never touched. The start is announced in the chat only after the task has actually started.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
itemId: z.number(),
// The dialog's free-text situation report; empty when the user
// added nothing (the premise alone then drives the reschedule).
userNote: z.string().max(1000),
}),
response: z.object({
ok: z.boolean(),
alreadyRunning: z.boolean(),
error: z.string().nullable(),
}),
async handler(ctx, args) {
// Same serialized start section as the DPA reschedule: the seal
// is built inside the section, at the button-press values (the
// target set's stored conditionsSnapshot + the target show's
// info + the user's memo). The shared form conditions are NOT
// re-read before this start.
const startSection = await acquireStartSection();
try {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set || set.status!== "done") {
return {
ok: false,
alreadyRunning: false,
error: "対象のプランが見つかりませんでした。",
};
}
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plan = planRows.find((p) => p.slot === args.slot);
if (!plan) {
return {
ok: false,
alreadyRunning: false,
error: "対象のプランが見つかりませんでした。",
};
}
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.id, args.itemId))
.limit(1);
const item = itemRows[0];
if (!item || item.planId!== plan.id || item.kind!== "show") {
return {
ok: false,
alreadyRunning: false,
error: "対象のショーが見つかりませんでした。",
};
}
const userNote = args.userNote.trim();
const premise =
`プラン${args.slot}の「${item.name}」（公演 ${item.timeLabel ?? "時刻未定"}）のエントリー抽選に外れた。` +
(userNote
? `ユーザーの状況報告：「${userNote}」`
: "ユーザーからの追加の状況報告はない。");
const changeInstruction =
`当日リスケジュール（抽選落選）：${premise}` +
`原則として、対象ショーの公演時刻（${item.timeLabel ?? "時刻未定"}）より前の項目は時刻・内容をそのまま残し、それ以降の残りのスケジュールだけを組み直すこと（状況報告が「全面的にリスケしてよい」という趣旨の場合のみ、プラン全体の組み直しも可）。` +
`対象の「${item.name}」は当選前提を外すこと（そのショーの行は外すか、空いた時間に別の項目に替える。外す場合は summary に理由を書く）。ただし状況報告に「代わりにそのショーのディズニー・プレミアアクセスを買った」等の趣旨があれば、その購入を購入済みの確定事実として扱い、DPA前提でそのショーを組み込むこと（DPA費用は購入した時に、購入イベント行で1回だけ計上する）。` +
`残りのDPAの購入列は、そのまま残した購入も含めて60分ルールで成立させること。費用内訳（総額・DPA金額）も新しい前提で再計算すること。`;
// Seal: conditions from the TARGET SET's stored snapshot, the
// show read above, and the user's memo as pressed — frozen
// together for this start (same rule as the DPA reschedule).
const lotterySeal = parseSnapshotConditions(set);
// 車椅子：対応範囲外の明示 (owner's decision, 記録AR): same rule
// as the DPA reschedule — when the target set's stored conditions
// (or the user's report) say a wheelchair user is among the
// participants, nothing starts and the fixed out-of-scope text
// is returned as the error.
const wheelchairBlocked = await judgeWheelchairParticipant(
ctx,
[conditionsToText(lotterySeal.conditions), userNote].join("\n"),
);
if (wheelchairBlocked) {
return {
ok: false,
alreadyRunning: false,
error: WHEELCHAIR_OUT_OF_SCOPE_TEXT,
};
}
const started = await startPartialReplacement(
ctx,
{
id: set.id,
title: set.title,
park: set.park,
visitDate: set.visitDate,
},
args.slot,
changeInstruction,
lotterySeal.conditions,
{
dayOfReport: premise,
startAnnouncement: `${waitedStartPrefix(startSection.waited)}「${set.title}」のプラン${args.slot}について、「${item.name}」の抽選に外れた場合のリスケジュールを開始しました。（対象条件: ${setConditionsSummary(set)}）他のプランはそのままです。出来上がったら、このチャットでお知らせします。${snapshotMissingNote(lotterySeal.missing)}`,
},
);
if (started.alreadyRunning) {
return {
ok: false,
alreadyRunning: true,
error: `プラン${args.slot}は今まさに差し替え中です。終わったら、このチャットでお知らせします。`,
};
}
if (!started.ok) {
return {
ok: false,
alreadyRunning: false,
error: "リスケジュールを開始できませんでした。元のプランはそのまま残っています。少し時間をおいて、もう一度お試しください。",
};
}
return { ok: true, alreadyRunning: false, error: null};
} finally {
startSection.release();
}
},
}),

updatePlanProgress: defineAction({
description:
"Internal: called by the generation task when it actually starts drafting each plan (A/B/C), to record that plan's progress as 作成中. It can only report work starting — 完了 is recorded exclusively by savePlanSet when the plan is actually saved, and 失敗 by the failure paths.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
status: z.literal("generating"),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
// Every progress report refreshes the set's last-progress timestamp
// (the watchdog's clock), even when the slot itself does not move:
// the report itself is proof the task is alive.
await db
.update(schema.planSets)
.set({ progressUpdatedAt: new Date()})
.where(
and(
eq(schema.planSets.id, args.planSetId),
eq(schema.planSets.status, "generating"),
),
);
// Only a still-generating set accepts progress reports, and a slot
// only moves 待機 -> 作成中： a late or duplicate report must not
// regress a plan that is already 作成中/完了.
await db
.update(schema.planSets)
.set(
args.slot === "A"
? { progressA: "generating" as const}
: args.slot === "B"
? { progressB: "generating" as const}
: { progressC: "generating" as const},
)
.where(
and(
eq(schema.planSets.id, args.planSetId),
eq(schema.planSets.status, "generating"),
eq(
args.slot === "A"
? schema.planSets.progressA
: args.slot === "B"
? schema.planSets.progressB
: schema.planSets.progressC,
"waiting",
),
),
);
// 過程記録： a drafting report is the server's own observation
// that the drafting phase has reached this plan — record the
// phase boundary on the run's trail.
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "phase_start",
phase: "drafting",
label: `プラン${args.slot}の下書き開始（進捗報告）`,
},
args.slot,
);
ctx.invalidateQueries();
return { ok: true};
},
}),

recordRunEvent: defineAction({
description:
"Internal: called by a long-running task (generation / same-day search / partial replacement) to append one timestamped event to its execution's process record （過程記録）: a phase boundary (phase_start / phase_end for 取得・ファクト構築・調査・下書き）, one fetch_start / fetch_end pair per read that leaves no snapshot (a sitemap it fetched directly, wait-time reference sites, crowd-forecast sources — never an official page: an official page's read is recorded by the server, on the server's clock, when its snapshot is saved), or one ai_call_start / ai_call_end pair per AI-driven step of its own, each with the step's label. Server-executed actions are NOT recorded through this action — the server brackets those itself into the open run (the storehouse reads and sync, planAcquisition / submitSitemap, saveSourceSnapshots, saveNormalizedFacts, saveRestaurantFacts, saveFacilities, saveAreaTravelTimes, getFacilityDictionary, and the plan saves), and a task-side pair for the same call would double-record it. The coverage is total — while the task is alive, some labelled step is always in progress, so no unlabelled gap exists between consecutive events. The record is how a run that stops midway can afterwards be pinpointed — where, and inside which call, it stopped. Recording never affects the run itself: when no run is open for the set (a stray or late report), it simply returns recorded=false.",
request: z.object({
planSetId: z.number(),
slot: slotEnum.nullable().optional(),
eventType: z.enum([
"phase_start",
"phase_end",
"fetch_start",
"fetch_end",
"ai_call_start",
"ai_call_end",
"note",
]),
phase: z
.enum(["acquisition", "fact_build", "research", "drafting", "save_verify"])
.nullable()
.optional(),
label: z.string().min(1).max(500),
detail: z.string().max(2000).nullable().optional(),
}),
response: z.object({ ok: z.literal(true), recorded: z.boolean()}),
async handler(
ctx,
args,
): Promise<{ ok: true; recorded: boolean}> {
const runId = await findOpenRunId(ctx, args.planSetId, args.slot ?? null);
if (runId == null) return { ok: true, recorded: false};
await appendRunLogEvent(ctx, runId, {
eventType: args.eventType,
phase: args.phase ?? null,
label: args.label,
detail: args.detail ?? null,
});
return { ok: true, recorded: true};
},
}),

getRunLog: defineAction({
description:
"Reads back the process records （過程記録） of every execution tied to one plan set — generation, same-day search, and partial replacements, oldest first — each with its full timestamped event trail (phase boundaries, per-fetch/read start/end, per-AI-call start/end with labels, every save attempt with its outcome — success, or the refusal's class and reason, including the recovery work after a refusal — and, where a step's end was never recorded, the explicit 「終了の記録なし」 marker the server added when the run closed) and, for a closed run, its outcome and close reason (the last completed phase, the step in progress, the elapsed time, and the reason — or an explicit 理由不明）. This is the read-back for diagnosing a run that stopped midway.",
request: z.object({ planSetId: z.number()}),
response: z.object({
runs: z.array(
z.object({
id: z.number(),
kind: z.enum(["generation", "same_day", "partial"]),
slot: slotEnum.nullable(),
status: z.enum(["open", "closed"]),
outcome: z
.enum(["succeeded", "failed", "cancelled", "interrupted"])
.nullable(),
startedAt: z.string(),
closedAt: z.string().nullable(),
closeReason: z.string().nullable(),
lastCompletedPhase: z.string().nullable(),
currentPhase: z.string().nullable(),
events: z.array(
z.object({
at: z.string(),
eventType: z.string(),
phase: z.string().nullable(),
label: z.string(),
detail: z.string().nullable(),
}),
),
}),
),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const runRows = await db
.select()
.from(schema.runLogs)
.where(eq(schema.runLogs.planSetId, args.planSetId))
.orderBy(asc(schema.runLogs.id));
const runs = [];
for (const r of runRows) {
const eventRows = await db
.select()
.from(schema.runLogEvents)
.where(eq(schema.runLogEvents.runId, r.id))
.orderBy(asc(schema.runLogEvents.id));
runs.push({
id: r.id,
kind: r.kind,
slot: r.slot,
status: r.status,
outcome: r.outcome,
startedAt: r.startedAt.toISOString(),
closedAt: r.closedAt? r.closedAt.toISOString(): null,
closeReason: r.closeReason,
lastCompletedPhase: r.lastCompletedPhase,
currentPhase: r.currentPhase,
events: eventRows.map((e) => ({
at: e.at.toISOString(),
eventType: e.eventType,
phase: e.phase,
label: e.label,
detail: e.detail,
})),
});
}
return { runs};
},
}),

saveSourceSnapshots: defineAction({
description:
"Internal: called by a generation / re-verification task to store the canonical official sources it just fetched — RAW, verbatim — as source_snapshots (kinds: dpa_page, facility_list, operations, show_schedule, ticket_prices, announcements, monthly_calendar, restaurant_list, restaurant_detail). A snapshot whose text came from the Cloudflare storehouse carries fetchMethod \"storehouse\" and sourceFetchedAt (the storehouse's own fetch time, ISO): the server stores that instant as the snapshot's fetchedAt and records the provenance in the completeness note; storehouse material NEVER becomes canonical (canonicality still requires exactly \"browser\"), and it must never be relabelled as an own browser fetch. Snapshots are stored BEFORE anything reads facts from them; normalized facts (saveNormalizedFacts) may only cite text stored here, and their evidence excerpts are machine-checked against these stored texts. CANONICAL CONTRACT (spec §6.2.2): every snapshot MUST carry fetchMethod (how it was fetched — browser / text / script …); a save without it is refused by validation. Every snapshot SHOULD also carry a completeness declaration (completeness: expectationSource = page_declaration / sibling_source / history / none, expectation = the expected content derived from the source itself, result = passed / failed / not_derivable). Canonicality is decided by the SERVER, never by the task: canonical = 1 only when the fetch method records a REAL-BROWSER fetch (fetchMethod exactly \"browser\" — the page was opened in a live browser with all tabs switched and expansions opened; a GET / text-extraction / script fetch NEVER becomes canonical, however complete the text looks, because tabbed/expandable official pages cannot be fully obtained that way), a declaration was given, its result is passed, AND the server's own machine check found no mismatch AND at least one machine-verifiable ANCHOR in the text itself checked out — a declared section whose enumerated count the server recounts and matches: either a 「全N件」 section vs its priced items, or an unpriced enumeration declaration (「…一覧 N件」) vs its enumerated rows. A text carrying no machine-readable declaration at all never becomes canonical on a free-text declaration alone. Anything else is stored with canonical = 0 — the save itself is not refused; what is guaranteed is that a partial text is never silently canonical. The completenessNote records which anchors verified (or that there were none). Only canonical snapshots can ground normalized facts. Returns the new snapshot ids in payload order, plus `canonical` — a boolean array in the same order saying which snapshots became canonical. Saving a batch in multiple calls under the same batchId (at most 12 snapshots per call) is a legitimate procedure, and getSourceSnapshots reads back the whole batch (up to 200 snapshots). READ-COMPLETION STAMPS: while a run is open, the server also stamps one 読み取り完了 record per saved snapshot into that run's process record (the page's kind and URL, on the server's clock) — the formal record of when that page's read completed. Save each page immediately after reading it, before reading the next page (never read several pages and batch-save them later): the stamps' order is the reading's progress, and a task-written start/end pair for a page read is not a record of the read. READ SEGMENTS: when the reading script passes readTimings with a snapshot (its own clock's stamps: open started / load completed / operations completed / text extracted), the server also records the read's segments into the run's process record — with the per-segment seconds it computes from the stamps — and stores the stamps with the snapshot's completeness note, so whether the time went to loading, to operations, or to extraction is readable from the record directly.",
request: z.object({
batchId: z.string().min(1).max(120),
snapshots: z
.array(
z.object({
kind: z.enum([
"dpa_page",
"facility_list",
"operations",
"show_schedule",
"ticket_prices",
"announcements",
"monthly_calendar",
"restaurant_list",
"restaurant_detail",
]),
park: parkEnum,
targetDate: z.string().max(20).nullable().optional(),
url: z.string().max(2000),
title: z.string().max(300).nullable().optional(),
rawText: z.string().min(1).max(1000000),
// How this text was fetched. REQUIRED, and canonicality requires
// exactly "browser" (a real-browser fetch with tabs switched and
// expansions opened): any other value (text / script / get / …)
// is stored but never becomes canonical. Report the method
// honestly — labelling a GET fetch "browser" is fabrication.
fetchMethod: z.string().min(1).max(60),
// The instant the text was actually fetched from the official
// site, when that differs from the save instant — set ONLY for
// storehouse material (fetchMethod "storehouse"), to the
// storehouse's own fetch time. The server stores it as the
// snapshot's fetchedAt and records it in the completeness note,
// so the material's fetch time and provenance (storehouse) stay
// on the record. Never set it for an own fetch, and never use it
// to make old material look fresh: it is the storehouse's
// recorded fetch time, verbatim.
sourceFetchedAt: z.string().max(40).nullable().optional(),
// The task's completeness declaration: the expectation derived
// from the source itself (its own declared counts / structure,
// consistency with sibling sources, continuity with past
// snapshots of the same source) and the check's result. Honest
// failed / not_derivable declarations are stored as such and
// simply never become canonical.
completeness: z
.object({
expectationSource: z.enum([
"page_declaration",
"sibling_source",
"history",
"none",
]),
expectation: z.string().max(1000),
result: z.enum(["passed", "failed", "not_derivable"]),
})
.nullable()
.optional(),
// The reading script's own segment stamps for this page's
// read (a program clock — the script that drove the real
// browser — never the AI's self-report): when the page
// started opening, when loading finished, when the required
// operations (tab state check, "もっと見る" expansions, the
// ticket page's scroll to the calendar part) finished (null
// when the page needed no operations), and when the text
// was extracted. The server records these segments into the
// open run's process record at save time (with the segment
// durations it computes from them) and stores the stamps
// with the snapshot's completeness note.
readTimings: z
.object({
openStartedAt: z.string().min(1).max(40),
loadCompletedAt: z.string().min(1).max(40),
operationsCompletedAt: z.string().min(1).max(40).nullable().optional(),
textExtractedAt: z.string().min(1).max(40),
})
.nullable()
.optional(),
}),
)
.min(1)
.max(12),
}),
response: z.object({
ok: z.literal(true),
snapshotIds: z.array(z.number()),
canonical: z.array(z.boolean()),
}),
async handler(
ctx,
args,
): Promise<{ ok: true; snapshotIds: number[]; canonical: boolean[] }> {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "acquisition",
label: "材料スナップショットの保存",
startDetail: args.snapshots.length + "件: " + args.snapshots.map((s) => s.kind).join(", "),
endDetail: (r) => r.snapshotIds.length + "件を保存（正典 " + r.canonical.filter((c) => c).length + "件）",
}, async () => {

const db = ctx.db<typeof schema>();
const snapshotIds: number[] = [];
const canonicalFlags: boolean[] = [];
const savedInfos: {
kind: string;
url: string;
title: string | null;
segments: string | null;
}[] = [];
// Acquisition plan layer v3: a saved restaurant_detail snapshot
// registers its URL as a leaf of the plan tree (the storehouse
// circulation list is built from these leaves). Storehouse
// material (fetchMethod "storehouse") keeps its source as the
// leaf's provenance.
for (const s of args.snapshots) {
// Server-side machine check: the snapshot's own declared
// section counts against the items it actually enumerates.
// Canonicality additionally requires at least one VERIFIED
// ANCHOR — a declaration in the text itself whose enumerated
// count the server could recount and match (revision X). A
// free-text declaration alone never canonicalizes: what the
// server cannot verify from the text counts as zero.
const machine = checkDeclaredSectionCounts(s.rawText);
const declared = s.completeness ?? null;
// Browser-fetch requirement (owner's rule, 2026-11-18): a canonical
// source must have been fetched with a REAL browser — tabs switched,
// expansions opened — and say so with fetchMethod exactly "browser".
// A GET / text-extraction / script fetch of an official page (the
// DPA page above all) structurally cannot contain the tabbed and
// expandable content, so a text fetched that way NEVER becomes
// canonical, however complete it looks and whatever it declares.
// This is what makes "get by with GET only" impossible rather than
// merely discouraged: facts can only be grounded in canonical
// snapshots (saveNormalizedFacts refuses the rest).
const browserFetched = s.fetchMethod.trim().toLowerCase() === "browser";
const isCanonical =
browserFetched &&
declared != null &&
declared.result === "passed" &&
machine.mismatches.length === 0 &&
machine.anchors.length >= 1;
const completenessNote = JSON.stringify({
declaration: declared
? {
expectationSource: declared.expectationSource,
expectation: declared.expectation,
result: declared.result,
}
: null,
fetchMethod: s.fetchMethod,
readTimings: s.readTimings ?? null,
sourceFetchedAt: s.sourceFetchedAt ?? null,
browserFetched,
machineCheck: {
sectionsChecked: machine.checked,
mismatches: machine.mismatches,
anchors: machine.anchors,
anchorMissing: machine.anchors.length === 0,
...(!browserFetched
? {
serverNote:
"取得方法が実ブラウザ（fetchMethod=\"browser\"）ではないため、このスナップショットは正典にしません。正典ソースは実ブラウザで全タブ切替・展開まで行って取得し、fetchMethod=\"browser\" で保存してください（GET／テキスト抽出で得た本文は、完全に見えても正典にはなりません）。",
}
: machine.mismatches.length > 0
? {
serverNote:
"サーバー側の機械照合で不一致を検出したため、このスナップショットは正典にしません（宣言件数と列挙された項目数が一致しません）。",
}
: machine.anchors.length === 0
? {
serverNote:
"本文の中に、サーバーが機械検証できる錨（件数宣言と列挙件数の一致）が1つも無いため、このスナップショットは正典にしません（自由文の期待値申告だけでは正典化できません）。",
}
: {}),
},
canonical: isCanonical,
});
const sourceFetchedDate = s.sourceFetchedAt
? new Date(s.sourceFetchedAt)
: null;
const inserted = await db
.insert(schema.sourceSnapshots)
.values({
kind: s.kind,
park: s.park,
targetDate: s.targetDate ?? null,
url: s.url,
title: s.title ?? null,
rawText: s.rawText,
batchId: args.batchId,
fetchMethod: s.fetchMethod,
canonical: isCanonical ? 1 : 0,
completenessNote,
...(sourceFetchedDate && !Number.isNaN(sourceFetchedDate.getTime())
? { fetchedAt: sourceFetchedDate }
: {}),
})
.returning({ id: schema.sourceSnapshots.id });
const row = inserted[0];
if (!row) throw new Error("saveSourceSnapshots: insert returned no rows");
snapshotIds.push(row.id);
canonicalFlags.push(isCanonical);
savedInfos.push({
kind: s.kind,
url: s.url,
title: s.title ?? null,
segments: readSegmentDetail(s.readTimings ?? null),
});
if (s.kind === "restaurant_detail") {
await upsertRestaurantLeaves(ctx, [
{
url: s.url,
park: s.park,
source:
s.fetchMethod.trim().toLowerCase() === "storehouse"
? ("storehouse" as const)
: ("snapshot" as const),
},
]);
}
}
// 読み取り完了の正式記録 (owner's rule, 2026-11-19): the server
// stamps one completion record per saved page into the open
// run — the page's kind and URL, on the SERVER's clock. A
// task-written start/end pair for a page read is never the
// record's basis (measured to disagree with the actual read
// times: a read recorded as 160 seconds whose save landed
// after the recorded end, and pages used with no read record
// at all), so this stamp is the formal record of when each
// page's read completed, and the stamps' order is the
// reading's progress (tasks save each page immediately after
// reading it). No open run: nothing is stamped. Recording
// never breaks the save it observes.
try {
const openRun = await findAnyOpenRun(ctx);
if (openRun != null) {
const stampPhase: RunLogPhase =
openRun.currentPhase != null &&
openRun.currentPhase in RUN_PHASE_LABELS
? (openRun.currentPhase as RunLogPhase)
: "acquisition";
for (const info of savedInfos) {
await appendRunLogEvent(ctx, openRun.id, {
eventType: "note",
phase: stampPhase,
label: `読み取り完了: ${info.kind}`,
detail: info.title ? `${info.url}／${info.title}` : info.url,
});
if (info.segments != null) {
await appendRunLogEvent(ctx, openRun.id, {
eventType: "note",
phase: stampPhase,
label: `読み取りの区切り: ${info.kind}`,
detail: info.segments,
});
}
}
}
} catch {
// The save's result stands regardless of the recording.
}
ctx.invalidateQueries();
return { ok: true, snapshotIds, canonical: canonicalFlags };
});
},
}),

getSourceSnapshots: defineAction({
description:
"Internal: reads stored source_snapshots (by ids or by fetch batch id), including their raw texts — the material a fact build reads from and cites. Returns at most 200 snapshots.",
request: z.object({
ids: z.array(z.number()).max(200).optional(),
batchId: z.string().max(120).optional(),
}),
response: z.object({
snapshots: z.array(
z.object({
id: z.number(),
kind: z.string(),
park: parkEnum,
targetDate: z.string().nullable(),
url: z.string(),
title: z.string().nullable(),
rawText: z.string(),
batchId: z.string(),
fetchedAt: z.string(),
// Canonical provenance (spec §6.2.2): how the snapshot was
// fetched, whether the server made it canonical at save time,
// and the JSON completeness-check record (the task's
// declaration + the server machine check). Legacy rows report
// fetchMethod "legacy_unknown", canonical false, note null.
fetchMethod: z.string(),
canonical: z.boolean(),
completenessNote: z.string().nullable(),
}),
),
totalCount: z.number(),
truncated: z.boolean(),
}),
async handler(
ctx,
args,
): Promise<{
snapshots: {
id: number;
kind: string;
park: "land" | "sea";
targetDate: string | null;
url: string;
title: string | null;
rawText: string;
batchId: string;
fetchedAt: string;
fetchMethod: string;
canonical: boolean;
completenessNote: string | null;
}[];
totalCount: number;
truncated: boolean;
}> {
const db = ctx.db<typeof schema>();
let rows: SnapshotRow[] = [];
let totalCount = 0;
if (args.ids && args.ids.length > 0) {
rows = await db
.select()
.from(schema.sourceSnapshots)
.where(inArray(schema.sourceSnapshots.id, args.ids));
totalCount = rows.length;
} else if (args.batchId) {
const countRows = await db
.select({ id: schema.sourceSnapshots.id })
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.batchId, args.batchId));
totalCount = countRows.length;
rows = await db
.select()
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.batchId, args.batchId))
.orderBy(asc(schema.sourceSnapshots.id))
.limit(200);
}
const sliced = rows.slice(0, 200);
return {
totalCount,
truncated: totalCount > sliced.length,
snapshots: sliced.map((r) => ({
id: r.id,
kind: r.kind,
park: r.park,
targetDate: r.targetDate,
url: r.url,
title: r.title,
rawText: r.rawText,
batchId: r.batchId,
fetchedAt: r.fetchedAt.toISOString(),
fetchMethod: r.fetchMethod,
canonical: r.canonical === 1,
completenessNote: r.completenessNote,
})),
};
},
}),

getAcquisitionPlan: defineAction({
description:
"Reads the acquisition plan layer v3: the plan tree built from the official sitemap (each node = page + operations + anchor, with its per-park branch presence in the sitemap the plan was built from), the plan's creation instant, and the sitemap basis of the skeleton comparison (the stored branch-restricted URL set, its size, and the sitemap's total URL count), plus the known restaurant detail leaves under the restaurant-list nodes. Calling it performs the same clock-only rebuild decision as planAcquisition (after the 3-hour expiry the plan is due for a rebuild and needsSitemap=true is reported; the rebuild itself happens when a fetching task submits the sitemap URL set through submitSitemap — the server never fetches the sitemap). Read-only with respect to every other table.",
request: z.object({}),
response: z.object({
planState: z.enum(["fresh", "rebuild"]),
planCreatedAt: z.string().nullable(),
sitemapUrl: z.string(),
sitemapUrls: z.array(z.string()),
sitemapUrlCount: z.number(),
sitemapTotalCount: z.number().nullable(),
skeletonSameAsPrevious: z.boolean().nullable(),
needsSitemap: z.boolean(),
nodes: z.array(
z.object({
nodeKey: z.string(),
scope: z.enum(["common", "park"]),
kinds: z.array(z.string()),
urlTemplate: z.string(),
urlMatch: z.string(),
stateFragmentLand: z.string().nullable(),
stateFragmentSea: z.string().nullable(),
operations: z.string(),
anchor: z.string(),
note: z.string().nullable(),
branchParks: z.object({ land: z.boolean(), sea: z.boolean() }),
}),
),
restaurantLeaves: z.array(
z.object({
url: z.string(),
park: parkEnum,
source: z.string(),
lastSeenAt: z.string(),
}),
),
commonRules: z.string(),
}),
async handler(ctx) {
const db = ctx.db<typeof schema>();
const plan = await ensureAcquisitionPlan(ctx, new Date());
const leaves = await db
.select()
.from(schema.acquisitionRestaurantLeaves)
.orderBy(
asc(schema.acquisitionRestaurantLeaves.park),
asc(schema.acquisitionRestaurantLeaves.url),
);
return {
planState: plan.planState,
planCreatedAt: plan.planCreatedAt
? plan.planCreatedAt.toISOString()
: null,
sitemapUrl: SITEMAP_URL,
sitemapUrls: plan.sitemapUrls.map(
(p) => `https://www.tokyodisneyresort.jp${p}`,
),
sitemapUrlCount: plan.sitemapUrls.length,
sitemapTotalCount: plan.sitemapTotalCount,
skeletonSameAsPrevious: plan.skeletonSame,
needsSitemap: plan.needsSitemap,
nodes: plan.nodes.map((n) => ({
nodeKey: n.nodeKey,
scope: n.scope,
kinds: n.kinds,
urlTemplate: n.urlTemplate,
urlMatch: n.urlMatch,
stateFragmentLand: n.stateFragmentLand,
stateFragmentSea: n.stateFragmentSea,
operations: n.operations,
anchor: n.anchor,
note: n.note,
branchParks: n.branchParks,
})),
restaurantLeaves: leaves.map((l) => ({
url: l.url,
park: l.park,
source: l.source,
lastSeenAt: l.lastSeenAt.toISOString(),
})),
commonRules:
"共通規則：時計は1つ — 計画とスナップショットの有効期間は3時間。再計画の判定はサーバーが時計だけで行い、サーバー自身はサイトマップを取得しない。計画が期限切れのときは、取得タスクがサイトマップのURL集合を submitSitemap で渡し（原則として保管庫の写し＝getStorehouseSitemap。保管庫に無い場合だけタスク自身が直接取得する）、サーバーが枝の集合を比較して計画全体を作り直す（部分改訂はしない）。サイトマップが保管庫にも無くタスク側でも取れなかった場合は既存の計画の骨格のまま進め、作成時刻は進めない（次の回で作り直しが再試行される）。作り直しの際の取得はそのまま実行の材料になる。スクロールは全ノード不要。展開の終了条件は宣言件数と列挙の一致のみ。対象パークでない側は開かない。材料の再利用は「そのURLのスナップショットがあり、取得時刻が評価時刻から3時間以内」だけで判定し、正典かどうかには依存しない。対象日が評価時刻の当日なら、デイリーは鮮度に関係なく必ず取得する。レストラン一覧は保管庫のスナップショットから読むのが原則（保管庫に無ければ自前で取得）。レストラン詳細は一覧の下の葉で、取得は保管庫の束を原則とする。実行中に計画は変えない。",
};
},
}),

planAcquisition: defineAction({
description:
"The acquisition plan layer v3's deterministic decision function （立案）: for one park + target date, first settles the plan itself (fresh / rebuild — when the plan's 3 hours have expired the decision is made by the clock alone and the server fetches nothing itself: it returns planState=\"rebuild\" with needsSitemap=true, and the fetching task carries the sitemap URL set in through submitSitemap, which rebuilds the plan whole and returns this same decision shape; until a set is submitted, the decisions ride on the existing plan skeleton and the creation instant is not advanced), then decides per tree node whether the run FETCHES the page (returning the materialized URL and the node's operations) or REUSES a stored snapshot (returning its id and fetch time), or SKIPS the node (its branch is absent from the sitemap). Reuse is judged ONLY by snapshot existence and freshness: a snapshot of the node's URL fetched within 3 hours of atTime (default: server now; atTime exists so tests can evaluate at a chosen instant). Canonicality, fetch method and completeness declarations do NOT enter the decision. The daily node additionally requires its snapshots to be about targetDate, and when targetDate is the day of atTime the daily node is always fetched regardless of freshness. Restaurant detail leaves are not fetched by the run at all in principle: each is decided \"storehouse\" (read from the storehouse bundle). The restaurant_list node is storehouse-first too: with no fresh local snapshot its decision is \"storehouse\" (read the storehouse's snapshot of the list URL; fetch it with the own browser only when the storehouse holds none). There is no fact-build reuse: fact building always happens from the run's own material.",
request: z.object({
park: parkEnum,
targetDate: z.string().min(10).max(10),
atTime: z.string().max(40).optional(),
}),
response: planDecisionResponse,
async handler(ctx, args) {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "acquisition",
label: "取得計画の判定",
endDetail: (r) => "planState=" + r.planState + (r.needsSitemap ? "／needsSitemap=true" : ""),
}, async () => {

if (!isIsoDate(args.targetDate)) {
throw new Error(
"planAcquisition: targetDate は YYYY-MM-DD で指定してください。",
);
}
const at = args.atTime ? new Date(args.atTime) : new Date();
if (Number.isNaN(at.getTime())) {
throw new Error(
"planAcquisition: atTime が時刻として読めません。ISO形式で指定してください。",
);
}
const plan = await ensureAcquisitionPlan(ctx, at);
const decided = await computeAcquisitionDecisions(
ctx,
plan,
args.park,
args.targetDate,
at,
);
return {
park: args.park,
targetDate: args.targetDate,
atTime: at.toISOString(),
planState: plan.planState,
planCreatedAt: plan.planCreatedAt
? plan.planCreatedAt.toISOString()
: null,
skeletonSameAsPrevious: plan.skeletonSame,
needsSitemap: plan.needsSitemap,
nodes: decided.nodes,
restaurantLeaves: decided.restaurantLeaves,
};
});
},
}),

submitSitemap: defineAction({
description:
"Carries the sitemap URL set from the fetching task into the acquisition plan layer v3 (the server never fetches the sitemap itself — owner's decision, 2026-11-19). Call it when planAcquisition returned planState=\"rebuild\" with needsSitemap=true: in principle pass the urls returned by getStorehouseSitemap (the storehouse's Browser Run fetch of the sitemap, Japanese pages only); only when the storehouse holds none, fetch https://www.tokyodisneyresort.jp/sitemap.xml plainly in the task's own environment, extract every <loc> URL, and pass those here. The server validates that every URL is on the official domain (any other URL rejects the whole submission), reduces the set to the branches the plan uses, compares it with the stored set (skeletonSameAsPrevious; null when no earlier set exists), persists the plan row, the whole node set, the sitemap URL set and the creation instant atomically, and returns exactly the same decision shape as planAcquisition (per-node fetch / reuse / storehouse), computed on the rebuilt tree.",
request: z.object({
urls: z.array(z.string().min(1).max(2048)).min(1).max(20000),
park: parkEnum,
targetDate: z.string().min(10).max(10),
atTime: z.string().max(40).optional(),
}),
response: planDecisionResponse,
async handler(ctx, args) {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "acquisition",
label: "サイトマップ提出と計画の作り直し",
endDetail: (r) => "planState=" + r.planState + "／骨格の同一性=" + (r.skeletonSameAsPrevious == null ? "比較の基礎なし" : r.skeletonSameAsPrevious ? "同じ" : "変化あり"),
}, async () => {

if (!isIsoDate(args.targetDate)) {
throw new Error(
"submitSitemap: targetDate は YYYY-MM-DD で指定してください。",
);
}
const at = args.atTime ? new Date(args.atTime) : new Date();
if (Number.isNaN(at.getTime())) {
throw new Error(
"submitSitemap: atTime が時刻として読めません。ISO形式で指定してください。",
);
}
const plan = await submitAcquisitionPlanSitemap(ctx, args.urls, at);
const decided = await computeAcquisitionDecisions(
ctx,
plan,
args.park,
args.targetDate,
at,
);
return {
park: args.park,
targetDate: args.targetDate,
atTime: at.toISOString(),
planState: plan.planState,
planCreatedAt: plan.planCreatedAt
? plan.planCreatedAt.toISOString()
: null,
skeletonSameAsPrevious: plan.skeletonSame,
needsSitemap: plan.needsSitemap,
nodes: decided.nodes,
restaurantLeaves: decided.restaurantLeaves,
};
});
},
}),

syncStorehouseUrls: defineAction({
description:
"Storehouse wiring, called at the start of every fetching turn: builds this run's circulation list — the sitemap URL FIRST, then the fixed 13 URLs (the DPA page's two per-park state URLs, the announcements page, and per park the attraction / show / monthly-calendar / ticket / restaurant-list pages), plus every known restaurant detail URL (learned from the storehouse's own registered list, this copy's stored restaurant_detail snapshots, and the leaf registry) — and POSTs it to the storehouse's /urls entrance (the storehouse sanity-gates the list itself: official domain only, 20–500 URLs). Also refreshes the restaurant leaf registry from what it learns. Never throws: a storehouse outage returns ok=false and the fetching turn proceeds without it.",
request: z.object({}),
response: z.object({
ok: z.boolean(),
posted: z.boolean(),
count: z.number(),
fixedCount: z.number(),
detailCount: z.number(),
storehouseListRead: z.boolean(),
reason: z.string().nullable(),
}),
async handler(
ctx,
): Promise<{
ok: boolean;
posted: boolean;
count: number;
fixedCount: number;
detailCount: number;
storehouseListRead: boolean;
reason: string | null;
}> {
return await withServerRunBracket(ctx, {
kind: "fetch",
phase: "acquisition",
label: "保管庫へのURL一覧送信",
endDetail: (r) => r.ok ? "送信 " + r.count + "件（固定 " + r.fixedCount + "件＋レストラン詳細 " + r.detailCount + "件）" : (r.reason ?? "送信できなかった"),
}, async () => {

const db = ctx.db<typeof schema>();
const fixed = storehouseFixedUrls();
const detailParks = new Map<string, "land" | "sea">();
const leafRows = await db.select().from(schema.acquisitionRestaurantLeaves);
for (const l of leafRows) detailParks.set(l.url, l.park);
const snapRows = await db
.select({
url: schema.sourceSnapshots.url,
park: schema.sourceSnapshots.park,
})
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.kind, "restaurant_detail"));
for (const s of snapRows) {
if (!detailParks.has(s.url)) detailParks.set(s.url, s.park);
}
let storehouseListRead = false;
const fromStorehouse: { url: string; park: "land" | "sea"; source: "storehouse" }[] =
[];
try {
const res = await fetch(`${STOREHOUSE_BASE_URL}/status`, {
signal: AbortSignal.timeout(20000),
});
if (res.ok) {
const data: unknown = await res.json();
const items =
data != null && typeof data === "object"
? (data as { items?: unknown }).items
: undefined;
if (Array.isArray(items)) {
storehouseListRead = true;
for (const item of items) {
const url =
item != null && typeof item === "object"
? (item as { url?: unknown }).url
: undefined;
if (typeof url !== "string") continue;
const park = parkOfDetailUrl(url);
if (!park) continue;
if (!detailParks.has(url)) detailParks.set(url, park);
fromStorehouse.push({ url, park, source: "storehouse" });
}
}
}
} catch {
storehouseListRead = false;
}
await upsertRestaurantLeaves(ctx, fromStorehouse);
const urls = [...fixed, ...detailParks.keys()];
const base = {
posted: false,
count: urls.length,
fixedCount: fixed.length,
detailCount: detailParks.size,
storehouseListRead,
};
if (urls.length < 20 || urls.length > 500) {
return {
...base,
ok: false,
reason: `URL一覧が ${urls.length} 件で、保管庫の健全性ゲート（20〜500件）を満たさないため送信しませんでした。`,
};
}
try {
const res = await fetch(`${STOREHOUSE_BASE_URL}/urls`, {
method: "POST",
signal: AbortSignal.timeout(20000),
headers: { "content-type": "application/json" },
body: JSON.stringify({ urls }),
});
if (!res.ok) {
return {
...base,
ok: false,
reason: `保管庫がURL一覧を受け付けませんでした（HTTP ${res.status}）。`,
};
}
} catch {
return {
...base,
ok: false,
reason: "保管庫へURL一覧を送信できませんでした（接続失敗）。",
};
}
return { ...base, ok: true, posted: true, reason: null };
});
},
}),

getStorehouseRestaurants: defineAction({
description:
"Storehouse wiring: reads the restaurant detail bundle (GET /bundle/restaurants) — every restaurant detail text the storehouse has fetched so far, each with the storehouse's own fetch time. This bundle is the PRINCIPAL source for restaurant detail pages: a run saves the items it uses as restaurant_detail snapshots with fetchMethod \"storehouse\" and sourceFetchedAt = the item's fetchedAt, so the fetch time and the provenance (storehouse) stay on the record the facts are grounded in. Details absent from the bundle are fetched by the run's own browser as before. Returns available=false (never throws) when the storehouse has no bundle yet or cannot be reached. Also registers the bundle's URLs as restaurant leaves.",
request: z.object({}),
response: z.object({
available: z.boolean(),
updatedAt: z.string().nullable(),
items: z.array(
z.object({
url: z.string(),
park: parkEnum,
fetchedAt: z.string(),
text: z.string(),
}),
),
}),
async handler(
ctx,
): Promise<{
available: boolean;
updatedAt: string | null;
items: {
url: string;
park: "land" | "sea";
fetchedAt: string;
text: string;
}[] }> {
return await withServerRunBracket(ctx, {
kind: "fetch",
phase: "acquisition",
label: "保管庫: レストラン詳細の束",
endDetail: (r) => r.available ? r.items.length + "件（束の更新時刻: " + (r.updatedAt ?? "不明") + "）" : "保管庫に束が無い、または接続できなかった",
}, async () => {

try {
const res = await fetch(`${STOREHOUSE_BASE_URL}/bundle/restaurants`, {
signal: AbortSignal.timeout(30000),
});
if (!res.ok) return { available: false, updatedAt: null, items: [] };
const data: unknown = await res.json();
if (data == null || typeof data !== "object") {
return { available: false, updatedAt: null, items: [] };
}
const updatedAtRaw = (data as { updatedAt?: unknown }).updatedAt;
const itemsRaw = (data as { items?: unknown }).items;
const items: {
url: string;
park: "land" | "sea";
fetchedAt: string;
text: string;
}[] = [];
if (itemsRaw != null && typeof itemsRaw === "object") {
for (const [url, v] of Object.entries(
itemsRaw as Record<string, unknown>,
)) {
const park = parkOfDetailUrl(url);
if (!park) continue;
if (v == null || typeof v !== "object") continue;
const fetchedAt = (v as { fetchedAt?: unknown }).fetchedAt;
const text = (v as { text?: unknown }).text;
if (typeof fetchedAt !== "string" || typeof text !== "string") {
continue;
}
items.push({ url, park, fetchedAt, text });
}
}
await upsertRestaurantLeaves(
ctx,
items.map((i) => ({ url: i.url, park: i.park, source: "storehouse" as const })),
);
return {
available: true,
updatedAt: typeof updatedAtRaw === "string" ? updatedAtRaw : null,
items,
};
} catch {
return { available: false, updatedAt: null, items: [] };
}
});
},
}),

getStorehouseSnapshot: defineAction({
description:
"Storehouse wiring: reads one page's snapshot from the storehouse (GET /snapshot?url=) — the principal read for the restaurant_list node (decision \"storehouse\") and the LAST RESORT for any other page whose own browser fetch failed. Returns the stored text with the storehouse's own fetch time. SERVER-SIDE SAVE (owner's fix, 2026-11-20): when a text is found, the SERVER itself saves it at read time as a snapshot of the run — fetchMethod \"storehouse\", fetchedAt = the storehouse's own fetch time (recorded as sourceFetchedAt in the completeness note) — and returns its id as snapshotId; that snapshot IS the run's material for the page. The run does NOT save the text again via saveSourceSnapshots and must never record the page as unconfirmed for not having saved it; it checks the node's anchor against the returned text and never records storehouse material as its own browser fetch (storehouse material never becomes canonical — canonicality still requires exactly \"browser\"). snapshotId is null only when no snapshot could be saved (the URL's kind/park could not be determined, or the URL is a dated daily page — daily pages have no storehouse substitute and are never saved from the storehouse). found=false when the storehouse holds no snapshot for the URL (or cannot be reached — see error); the run then treats the page as not fetched, visibly, as before.",
request: z.object({
url: z.string().min(1).max(2000),
}),
response: z.object({
found: z.boolean(),
url: z.string(),
fetchedAt: z.string().nullable(),
text: z.string().nullable(),
error: z.string().nullable(),
snapshotId: z.number().nullable(),
}),
async handler(
ctx,
args,
): Promise<{
found: boolean;
url: string;
fetchedAt: string | null;
text: string | null;
error: string | null;
snapshotId: number | null;
}> {
return await withServerRunBracket(ctx, {
kind: "fetch",
phase: "acquisition",
label: "保管庫: スナップショット",
startDetail: args.url,
endDetail: (r) => r.found ? "保管庫の取得時刻: " + (r.fetchedAt ?? "不明") + (r.snapshotId != null ? "／この回のスナップショットとして保存済み（id=" + r.snapshotId + "）" : "／スナップショットとして保存されなかった（URLから種別・パークを特定できない、または日次ページのため）") : (r.error ?? "保管庫にスナップショットが無い"),
}, async () => {

try {
const res = await fetch(
`${STOREHOUSE_BASE_URL}/snapshot?url=${encodeURIComponent(args.url)}`,
{ signal: AbortSignal.timeout(20000) },
);
if (res.status === 404) {
return {
found: false,
url: args.url,
fetchedAt: null,
text: null,
error: null,
snapshotId: null,
};
}
if (!res.ok) {
return {
found: false,
url: args.url,
fetchedAt: null,
text: null,
error: `保管庫がエラーを返しました（HTTP ${res.status}）。`,
snapshotId: null,
};
}
const data: unknown = await res.json();
if (data == null || typeof data !== "object") {
return {
found: false,
url: args.url,
fetchedAt: null,
text: null,
error: "保管庫の応答が読めませんでした。",
snapshotId: null,
};
}
const fetchedAt = (data as { fetchedAt?: unknown }).fetchedAt;
const text = (data as { text?: unknown }).text;
if (typeof text !== "string") {
return {
found: false,
url: args.url,
fetchedAt: null,
text: null,
error: "保管庫のスナップショットに本文がありませんでした。",
snapshotId: null,
};
}
const storehouseFetchedAt =
typeof fetchedAt === "string" ? fetchedAt : null;
// The server saves what it read, at read time, as this
// run's snapshot (fetchMethod "storehouse", the
// storehouse's own fetch time) — the task's material no
// longer depends on the task remembering to save it.
const snapshotId = await saveStorehouseReadSnapshot(ctx, {
url: args.url,
text,
fetchedAt: storehouseFetchedAt,
});
return {
found: true,
url: args.url,
fetchedAt: storehouseFetchedAt,
text,
error: null,
snapshotId,
};
} catch {
return {
found: false,
url: args.url,
fetchedAt: null,
text: null,
error: "保管庫へ接続できませんでした。",
snapshotId: null,
};
}
});
},
}),

getStorehouseSitemap: defineAction({
description:
"Storehouse wiring: reads the sitemap URL set from the storehouse (GET /sitemap) — the storehouse fetches https://www.tokyodisneyresort.jp/sitemap.xml with Browser Run on its circulation and serves back the URL set restricted to Japanese pages, with the storehouse's own fetch time. This is the PRINCIPAL sitemap source for the acquisition plan layer v3: when planAcquisition returns planState=\"rebuild\" with needsSitemap=true, the fetching task calls this first and passes the returned urls to submitSitemap (this read's start/end, the storehouse provenance and its fetchedAt are recorded into the open run's process record by the server itself). Only when this returns null does the task fall back to fetching the sitemap directly in its own environment. Returns null (never throws) when the storehouse has not fetched the sitemap yet (404) or cannot be reached.",
request: z.object({}),
response: z
.object({
fetchedAt: z.string(),
count: z.number(),
urls: z.array(z.string()),
})
.nullable(),
async handler(
ctx,
): Promise<{
fetchedAt: string;
count: number;
urls: string[];
} | null> {
return await withServerRunBracket(ctx, {
kind: "fetch",
phase: "acquisition",
label: "保管庫: サイトマップ",
endDetail: (r) => r != null ? "保管庫の取得時刻: " + r.fetchedAt + "／" + r.count + "件" : "保管庫にサイトマップがまだ無い、または接続できなかった",
}, async () => {

void ctx;
try {
const res = await fetch(`${STOREHOUSE_BASE_URL}/sitemap`, {
signal: AbortSignal.timeout(20000),
});
if (!res.ok) return null;
const data: unknown = await res.json();
if (data == null || typeof data !== "object") return null;
const fetchedAt = (data as { fetchedAt?: unknown }).fetchedAt;
const count = (data as { count?: unknown }).count;
const urlsRaw = (data as { urls?: unknown }).urls;
if (typeof fetchedAt !== "string" || !Array.isArray(urlsRaw)) {
return null;
}
const urls = urlsRaw.filter(
(u): u is string => typeof u === "string",
);
return {
fetchedAt,
count: typeof count === "number" ? count : urls.length,
urls,
};
} catch {
return null;
}
});
},
}),
saveNormalizedFacts: defineAction({
description:
"Internal: registers one fact build — the AI read of stored source_snapshots, normalized to one DPA fact per facility — after machine validation: (a) every fact's evidence excerpt must be a VERBATIM substring of its referenced snapshot's stored raw text; (b) an eligible fact's price must appear in its excerpt; (c) any application-period date must appear in its excerpt; (d) unknown facts require a reason; not_eligible facts may instead be grounded in the mother-set (facility_list) snapshot via evidenceKind 'universe_listing' with an excerpt naming the facility. Completeness is checked against the mother set (universeNames, read from the build's facility_list snapshot — NEVER the facility dictionary): mother-set facilities with no fact are returned in `missing` and the build is stored as incomplete; an incomplete build can never pass a DPA row at the save gate. Filling the gaps (unknown + reason where a status cannot be read) and re-registering produces a new, complete build. CANONICAL GROUNDING (spec §6.2.2): only canonical snapshots (server-decided at saveSourceSnapshots time — fetch method recorded, completeness declared and passed, server machine check clean, and at least one machine-verifiable anchor in the text itself) may ground a fact build: a non-canonical mother-set snapshot refuses the registration outright, and a fact whose evidence snapshot is not canonical is refused through the per-fact error list. Re-fetch the source under the 3-step procedure and save it again so it becomes canonical, then register the facts. VALUE-FIDELITY DIFF GATE （値の忠実さ）: after the validations above pass, the server diffs every fact that exists non-unknown on BOTH sides against the park's latest complete, non-invalidated build (the baseline; a park's first build has no baseline and is not diffed). A differing unit price (both sides eligible) or a flipped eligibility status is accepted ONLY when the new fact's effectiveFrom is strictly newer than the baseline fact's (a non-null new effectiveFrom against a null or earlier baseline one) — the change is then recorded on the build (valueChanges) and returned in `valueDiff`. Without that justification the server knocks the fact down to unknown itself (price cleared, the submitted evidence kept, unknownReason naming the baseline value/status), records the knockdown, and the build is stored INCOMPLETE even when nothing is missing — so a silently rewritten value can never become canonical. The result is returned in `valueDiff` (baselineBuildId / valueChanges / knockedDown) and disclosed by getFactBuild.",
request: z.object({
park: parkEnum,
visitDate: z.string().max(20).nullable().optional(),
universeSnapshotId: z.number(),
universeNames: z.array(z.string().max(200)).min(1).max(400),
snapshotIds: z.array(z.number()).max(20).default([]),
facts: z
.array(
z.object({
name: z.string().min(1).max(200),
status: z.enum(["eligible", "not_eligible", "unknown"]),
priceJpy: z.number().int().min(1).max(100000).nullable().optional(),
effectiveFrom: z.string().max(20).nullable().optional(),
effectiveTo: z.string().max(20).nullable().optional(),
unknownReason: z.string().max(500).nullable().optional(),
evidenceKind: z.enum(["excerpt", "universe_listing"]).default("excerpt"),
snapshotId: z.number(),
evidence: z.string().min(1).max(4000),
}),
)
.min(1)
.max(400),
}),
response: z.object({
ok: z.literal(true),
factBuildId: z.number(),
complete: z.boolean(),
missing: z.array(z.string()),
summary: factSummaryShape,
// The value-fidelity diff gate's outcome: the baseline build
// this registration was diffed against (null = the park's first
// build, no diff check), the changes accepted as legitimate
// (newer effectiveFrom), and the facts knocked down to unknown.
valueDiff: z.object({
baselineBuildId: z.number().nullable(),
valueChanges: z.array(factValueChangeShape),
knockedDown: z.array(factValueKnockdownShape),
}),
}),
async handler(
ctx,
args,
): Promise<{
ok: true;
factBuildId: number;
complete: boolean;
missing: string[];
summary: z.infer<typeof factSummaryShape>;
valueDiff: {
baselineBuildId: number | null;
valueChanges: z.infer<typeof factValueChangeShape>[];
knockedDown: z.infer<typeof factValueKnockdownShape>[];
};
}> {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "fact_build",
label: "ファクト構築",
startDetail: args.park + "／母集合スナップショット id=" + args.universeSnapshotId,
endDetail: (r) => r.complete ? "完全な構築として登録（構築 id=" + r.factBuildId + "）" : "未完成の構築として登録（不足: " + r.missing.join("、") + "）",
}, async () => {

const db = ctx.db<typeof schema>();
// 構造化の区間 (owner's rule, 2026-11-19): the time spent
// interpreting and structuring the fetched material is
// measured ONLY on the server's clock — from the server's
// last 読み取り完了 stamp in this run to this call's bracket
// start (the instant the server received the structured
// facts, server-stamped by withServerRunBracket just above).
// The task's own start/end writings are never the basis.
// Stated as one note, so the interval is readable from the
// trail without trusting any task-side record.
try {
const openRun = await findAnyOpenRun(ctx);
if (openRun != null) {
const recent = await db
.select()
.from(schema.runLogEvents)
.where(eq(schema.runLogEvents.runId, openRun.id))
.orderBy(desc(schema.runLogEvents.id))
.limit(80);
const lastCompletion = recent.find((e) =>
e.label.startsWith("読み取り完了:"),
);
const bracketStart = recent.find(
(e) => e.eventType === "ai_call_start" && e.label === "ファクト構築",
);
if (lastCompletion && bracketStart) {
const secs = Math.max(
0,
Math.round(
(bracketStart.at.getTime() - lastCompletion.at.getTime()) / 1000,
),
);
await appendRunLogEvent(ctx, openRun.id, {
eventType: "note",
phase: "fact_build",
label: "ファクト構築の区間（サーバーの時刻）",
detail: `最後の読み取り完了（${lastCompletion.at.toISOString()}）から、構造化した事実の保存をサーバーが受けた時刻（${bracketStart.at.toISOString()}）まで ${secs}秒。この区間はサーバーが打った記録だけで算出している。`,
});
}
}
} catch {
// Recording never breaks the registration it observes.
}
const referencedIds = [
...new Set([
args.universeSnapshotId,
...args.snapshotIds,
...args.facts.map((f) => f.snapshotId),
]),
];
const snapRows = await db
.select()
.from(schema.sourceSnapshots)
.where(inArray(schema.sourceSnapshots.id, referencedIds));
const snapById = new Map(snapRows.map((r) => [r.id, r]));
const universeSnap = snapById.get(args.universeSnapshotId);
if (!universeSnap) {
throw new Error(
`saveNormalizedFacts: 母集合スナップショット（id=${args.universeSnapshotId}）が見つかりません。先に saveSourceSnapshots で保存してください。`,
);
}
if (universeSnap.kind !== "facility_list") {
throw new Error(
"saveNormalizedFacts: 母集合スナップショットは施設全一覧（facility_list）でなければなりません。",
);
}
if (universeSnap.park !== args.park) {
throw new Error(
"saveNormalizedFacts: 母集合スナップショットのパークが、ビルドのパークと一致しません。",
);
}
if (universeSnap.canonical !== 1) {
throw new Error(
`saveNormalizedFacts: 母集合スナップショット（id=${args.universeSnapshotId}）が正典ではありません（保存時の完全性照合を通過したスナップショットだけがファクトの土台になります）。3段手順（同一性チェック→ブラウザ取得→完全性照合の申告）で施設全一覧を取り直し、saveSourceSnapshots で正典として保存してから登録してください。`,
);
}
// The mother set: facility names read from the facility_list
// snapshot. The accumulated facility dictionary is NEVER the
// mother set (it carries pseudo entries and misses facilities).
const universeKeys = new Map<string, string>();
for (const n of args.universeNames) {
const k = facilityNameKey(n);
if (k && !universeKeys.has(k)) universeKeys.set(k, n);
}
if (universeKeys.size === 0) {
throw new Error(
"saveNormalizedFacts: 母集合（universeNames）が空です。施設全一覧スナップショットから読み取った施設名を全て入れてください。",
);
}
// ---- machine validation of every fact ----
const errors: string[] = [];
const factKeys = new Map<string, string>();
for (const f of args.facts) {
const k = facilityNameKey(f.name);
if (factKeys.has(k)) {
errors.push(
`「${f.name}」のファクトが重複しています（1施設につきファクトはちょうど1行にしてください）`,
);
}
factKeys.set(k, f.name);
}
// Registration validation (5) (spec §6.2.1): a fact's facility
// must belong to the mother set — a fact for a facility outside
// the universe read from the facility_list snapshot cannot be
// registered at all.
for (const f of args.facts) {
if (!universeKeys.has(facilityNameKey(f.name))) {
errors.push(
`「${f.name}」：母集合（施設全一覧）に含まれていない施設のファクトは登録できません。ファクトは、母集合スナップショットから読み取った施設についてだけ登録してください`,
);
}
}
for (const f of args.facts) {
const snap = snapById.get(f.snapshotId);
if (!snap) {
errors.push(
`「${f.name}」：根拠スナップショット（id=${f.snapshotId}）が見つかりません`,
);
continue;
}
if (snap.park !== args.park) {
errors.push(
`「${f.name}」：根拠スナップショットのパークがビルドのパークと一致しません`,
);
}
if (snap.canonical !== 1) {
errors.push(
`「${f.name}」：根拠スナップショット（id=${f.snapshotId}）が正典ではありません（保存時の完全性照合を通過したスナップショットだけがファクトの根拠になります）。そのソースを3段手順で取り直し、正典として保存してから登録してください`,
);
}
if (!snap.rawText.includes(f.evidence)) {
errors.push(
`「${f.name}」：根拠抜粋が、参照スナップショット（id=${f.snapshotId}）の生テキストに逐語で含まれていません。保存したスナップショットのテキストから、一字も変えずに抜粋してください`,
);
} else if (f.evidenceKind === "universe_listing") {
if (snap.kind !== "facility_list") {
errors.push(
`「${f.name}」：根拠種別 universe_listing の根拠は、施設全一覧（facility_list）のスナップショットでなければなりません`,
);
} else if (
!facilityNameKey(f.evidence).includes(facilityNameKey(f.name))
) {
errors.push(
`「${f.name}」：universe_listing の根拠抜粋には、その施設名が含まれていなければなりません`,
);
}
}
if (f.status === "eligible") {
if (f.priceJpy == null) {
errors.push(
`「${f.name}」：対象（eligible）のファクトには単価（priceJpy）が必須です`,
);
} else if (!evidenceContainsPrice(f.evidence, f.priceJpy)) {
errors.push(
`「${f.name}」：根拠抜粋の中に単価（${f.priceJpy.toLocaleString("ja-JP")}円）の表記が含まれていません。単価を含む範囲を抜粋してください`,
);
}
} else if (f.priceJpy != null) {
errors.push(
`「${f.name}」：単価は対象（eligible）のファクトにだけ付けられます`,
);
}
if (
f.effectiveFrom &&
!isIsoDate(f.effectiveFrom)
) {
errors.push(
`「${f.name}」：適用開始日（effectiveFrom）は YYYY-MM-DD 形式で入れてください`,
);
} else if (
f.effectiveFrom &&
!evidenceContainsDate(f.evidence, f.effectiveFrom)
) {
errors.push(
`「${f.name}」：根拠抜粋の中に適用開始日（${isoDateJa(f.effectiveFrom)}）の日付表記が含まれていません。期間を含む範囲を抜粋してください`,
);
}
if (f.effectiveTo && !isIsoDate(f.effectiveTo)) {
errors.push(
`「${f.name}」：適用終了日（effectiveTo）は YYYY-MM-DD 形式で入れてください`,
);
} else if (
f.effectiveTo &&
!evidenceContainsDate(f.evidence, f.effectiveTo)
) {
errors.push(
`「${f.name}」：根拠抜粋の中に適用終了日（${isoDateJa(f.effectiveTo)}）の日付表記が含まれていません。期間を含む範囲を抜粋してください`,
);
}
if (
f.effectiveFrom &&
f.effectiveTo &&
isIsoDate(f.effectiveFrom) &&
isIsoDate(f.effectiveTo) &&
f.effectiveFrom > f.effectiveTo
) {
errors.push(
`「${f.name}」：適用期間の開始日が終了日より後になっています`,
);
}
if (f.status === "unknown" && !(f.unknownReason ?? "").trim()) {
errors.push(
`「${f.name}」：不明（unknown）のファクトには理由（unknownReason）が必須です`,
);
}
}
if (errors.length > 0) {
throw new Error(
`ファクトを登録できませんでした。次の問題を直して、もう一度 saveNormalizedFacts を呼んでください（失敗報告はしないこと）:\n- ${errors.slice(0, 12).join("\n- ")}`,
);
}
// ---- value-fidelity diff gate （値の忠実さ） ----
// The validations above only prove the submitted facts agree
// with the STORED snapshot texts; nothing so far proves a value
// agrees with the value the previous canonical build recorded.
// A price or eligibility status that changes between builds is
// either a real制度変更 — which always carries a new application
// start date — or a corrupted read. So: diff every fact that
// exists non-unknown on both sides against the baseline (the
// park's latest complete, non-invalidated build registered
// before this one). A difference passes only with a strictly
// newer effectiveFrom, and is then recorded; otherwise the
// server knocks the fact down to unknown itself.
type SubmittedFact = (typeof args.facts)[number];
const effectiveFacts: SubmittedFact[] = args.facts.map((f) => ({
...f,
}));
let baselineBuildId: number | null = null;
const valueChanges: z.infer<typeof factValueChangeShape>[] = [];
const valueDiffKnockdowns: z.infer<typeof factValueKnockdownShape>[] =
[];
const baselineRows = await db
.select()
.from(schema.factBuilds)
.where(
and(
eq(schema.factBuilds.park, args.park),
eq(schema.factBuilds.complete, 1),
isNull(schema.factBuilds.invalidatedAt),
),
)
.orderBy(desc(schema.factBuilds.id))
.limit(1);
const baselineBuild = baselineRows[0];
if (baselineBuild) {
baselineBuildId = baselineBuild.id;
const baselineFactRows = await db
.select()
.from(schema.normalizedFacts)
.where(eq(schema.normalizedFacts.buildId, baselineBuild.id));
const baselineByKey = new Map(
baselineFactRows.map((f) => [f.nameKey, f]),
);
const priceLabel = (p: number): string =>
`${p.toLocaleString("ja-JP")}円`;
const statusLabel = (s: string): string =>
s === "eligible" ? "対象" : "対象外";
for (const f of effectiveFacts) {
const base = baselineByKey.get(facilityNameKey(f.name));
if (!base) continue;
// Only facilities present, and non-unknown, on BOTH sides
// are compared. New facilities, baseline-unknown facilities
// and submitted-unknown facilities keep the existing path.
if (base.status === "unknown" || f.status === "unknown") {
continue;
}
let field: "price" | "status" | null = null;
if (base.status === "eligible" && f.status === "eligible") {
if (
base.priceJpy != null &&
f.priceJpy != null &&
base.priceJpy !== f.priceJpy
) {
field = "price";
}
} else if (base.status !== f.status) {
field = "status";
}
if (!field) continue;
const newFrom = f.effectiveFrom ?? null;
const justified =
newFrom != null &&
(base.effectiveFrom == null || newFrom > base.effectiveFrom);
if (field === "price") {
const oldPrice = base.priceJpy;
const newPrice = f.priceJpy;
if (oldPrice == null || newPrice == null) continue;
if (justified) {
valueChanges.push({
name: f.name,
field,
oldValue: priceLabel(oldPrice),
newValue: priceLabel(newPrice),
effectiveFrom: newFrom,
});
} else {
const reason = `前回の正典ビルドの値（${priceLabel(oldPrice)}）と異なるため未確認`;
valueDiffKnockdowns.push({
name: f.name,
field,
baselineValue: priceLabel(oldPrice),
submittedValue: priceLabel(newPrice),
reason,
});
f.status = "unknown";
f.priceJpy = null;
f.unknownReason = reason;
}
} else {
if (justified) {
valueChanges.push({
name: f.name,
field,
oldValue: statusLabel(base.status),
newValue: statusLabel(f.status),
effectiveFrom: newFrom,
});
} else {
const reason = `前回の正典ビルドの状態（${statusLabel(base.status)}）と異なるため未確認`;
valueDiffKnockdowns.push({
name: f.name,
field,
baselineValue: statusLabel(base.status),
submittedValue: statusLabel(f.status),
reason,
});
f.status = "unknown";
f.priceJpy = null;
f.unknownReason = reason;
}
}
}
}
// ---- completeness against the mother set ----
// Judged on the POST-KNOCKDOWN facts: counts, unknowns and the
// complete flag all reflect what the server actually stored. A
// build with any diff knockdown is never complete, even when no
// mother-set facility is missing a fact.
const missing: string[] = [];
for (const [k, name] of universeKeys) {
if (!factKeys.has(k)) missing.push(name);
}
const complete =
missing.length === 0 && valueDiffKnockdowns.length === 0;
const unknowns = effectiveFacts
.filter((f) => f.status === "unknown")
.map((f) => ({
name: f.name,
reason: (f.unknownReason ?? "").trim(),
}));
const summary: z.infer<typeof factSummaryShape> = {
universeCount: universeKeys.size,
eligibleCount: effectiveFacts.filter((f) => f.status === "eligible")
.length,
notEligibleCount: effectiveFacts.filter(
(f) => f.status === "not_eligible",
).length,
unknownCount: unknowns.length,
complete,
unknowns,
baselineBuildId,
valueChanges,
valueDiffKnockdowns,
};
const usedSnapshotIds = [
...new Set([
args.universeSnapshotId,
...args.snapshotIds,
...args.facts.map((f) => f.snapshotId),
]),
];
const insertedBuild = await db
.insert(schema.factBuilds)
.values({
park: args.park,
visitDate: args.visitDate ?? null,
snapshotIdsJson: JSON.stringify(usedSnapshotIds),
universeSnapshotId: args.universeSnapshotId,
universeCount: summary.universeCount,
eligibleCount: summary.eligibleCount,
notEligibleCount: summary.notEligibleCount,
unknownCount: summary.unknownCount,
unknownJson: JSON.stringify(unknowns),
missingJson: JSON.stringify(missing),
complete: complete ? 1 : 0,
baselineBuildId,
valueChangesJson: JSON.stringify(valueChanges),
valueDiffKnockdownsJson: JSON.stringify(valueDiffKnockdowns),
})
.returning({ id: schema.factBuilds.id });
const buildRow = insertedBuild[0];
if (!buildRow) {
throw new Error("saveNormalizedFacts: build insert returned no rows");
}
for (const f of effectiveFacts) {
await db.insert(schema.normalizedFacts).values({
buildId: buildRow.id,
park: args.park,
name: f.name,
nameKey: facilityNameKey(f.name),
status: f.status,
priceJpy: f.status === "eligible" ? (f.priceJpy ?? null) : null,
effectiveFrom: f.effectiveFrom ?? null,
effectiveTo: f.effectiveTo ?? null,
unknownReason:
f.status === "unknown" ? (f.unknownReason ?? null) : null,
evidenceKind: f.evidenceKind,
snapshotId: f.snapshotId,
evidence: f.evidence,
});
}
ctx.invalidateQueries();
return {
ok: true,
factBuildId: buildRow.id,
complete,
missing,
summary,
valueDiff: {
baselineBuildId,
valueChanges,
knockedDown: valueDiffKnockdowns,
},
};
});
},
}),

getFactBuild: defineAction({
description:
"Internal: reads one fact build back — its completeness summary, the mother-set facilities that got no fact, and every fact with its grounds — so a task (or a check) can see exactly what the DPA gate will judge by. The summary also discloses the registration-time value-diff gate's outcome (summary.baselineBuildId — the previous canonical build this one was diffed against; summary.valueChanges — price/status changes accepted because they carried a newer effectiveFrom; summary.valueDiffKnockdowns — facts knocked down to unknown because their value differed from the baseline without justification, with the reason), so a verification record citing this build can be traced back through the diff.",
request: z.object({ factBuildId: z.number() }),
response: z.object({
found: z.boolean(),
park: parkEnum.nullable(),
visitDate: z.string().nullable(),
summary: factSummaryShape.nullable(),
missing: z.array(z.string()),
facts: z.array(dpaFactShape),
// The invalidation record (spec: an invalidated build's standing
// and the record of its invalidation stay readable here).
invalidatedAt: z.string().nullable(),
invalidatedReason: z.string().nullable(),
}),
async handler(
ctx,
args,
): Promise<{
found: boolean;
park: "land" | "sea" | null;
visitDate: string | null;
summary: z.infer<typeof factSummaryShape> | null;
missing: string[];
facts: z.infer<typeof dpaFactShape>[];
invalidatedAt: string | null;
invalidatedReason: string | null;
}> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.factBuilds)
.where(eq(schema.factBuilds.id, args.factBuildId))
.limit(1);
const build = rows[0];
if (!build) {
return {
found: false,
park: null,
visitDate: null,
summary: null,
missing: [],
facts: [],
invalidatedAt: null,
invalidatedReason: null,
};
}
const gate = await loadDpaFactGate(ctx, build.id, build.park);
return {
found: true,
park: build.park,
visitDate: build.visitDate,
summary: gate.summary,
missing: gate.missingNames,
facts: gate.displayFacts,
invalidatedAt: build.invalidatedAt
? build.invalidatedAt.toISOString()
: null,
invalidatedReason: build.invalidatedReason ?? null,
};
},
}),

invalidateFactBuild: defineAction({
description:
"Internal one-time correction tool (owner's instruction, 2026-11-16): revokes one fact build's standing as complete / canonical WITHOUT deleting anything — the build's complete flag is forced to 0 and the invalidation instant and reason are recorded on the build (invalidatedAt / invalidatedReason); its facts and snapshots stay stored and readable via getFactBuild. Consequences: the value-diff gate's baseline selection skips invalidated builds (the previous complete, non-invalidated build becomes the baseline again), and any gate load of this build reports it as incomplete. Used when a build is found to rest on corrupted grounds (e.g. build #48, whose DPA prices came from a reconstructed snapshot text with flattened 2,000円 prices). Running this against production data is the coordinator's role; the action itself only ever touches the one named build row. Idempotent: invalidating an already-invalidated build reports alreadyInvalidated and changes nothing.",
request: z.object({
factBuildId: z.number(),
reason: z.string().min(1).max(1000),
}),
response: z.object({
ok: z.literal(true),
factBuildId: z.number(),
alreadyInvalidated: z.boolean(),
invalidatedAt: z.string().nullable(),
invalidatedReason: z.string().nullable(),
}),
async handler(
ctx,
args,
): Promise<{
ok: true;
factBuildId: number;
alreadyInvalidated: boolean;
invalidatedAt: string | null;
invalidatedReason: string | null;
}> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.factBuilds)
.where(eq(schema.factBuilds.id, args.factBuildId))
.limit(1);
const build = rows[0];
if (!build) {
throw new Error(
`invalidateFactBuild: ファクトビルド（id=${args.factBuildId}）が見つかりません。`,
);
}
if (build.invalidatedAt) {
return {
ok: true as const,
factBuildId: build.id,
alreadyInvalidated: true,
invalidatedAt: build.invalidatedAt.toISOString(),
invalidatedReason: build.invalidatedReason,
};
}
const now = new Date();
await db
.update(schema.factBuilds)
.set({
complete: 0,
invalidatedAt: now,
invalidatedReason: args.reason,
})
.where(eq(schema.factBuilds.id, build.id));
ctx.invalidateQueries();
return {
ok: true as const,
factBuildId: build.id,
alreadyInvalidated: false,
invalidatedAt: now.toISOString(),
invalidatedReason: args.reason,
};
},
}),

saveRestaurantFacts: defineAction({
description:
"Internal: registers restaurant facts （レストラン事実レイヤー) — one facility's service type, reservation form (required = 予約必須 / ps = プライオリティ・シーティング対象 / none = 予約の経路なし / unknown = 未確認＋理由） and mobile order (available = 対象 / not_available = 対象外 / unknown = 未確認＋理由）, each grounded in that facility's OWN official restaurant detail page snapshot (kind \"restaurant_detail\", saved first via saveSourceSnapshots). The grounding snapshot MUST have been fetched browser-grade: fetchMethod \"browser\" (this copy's own real browser) or \"storehouse\" (the Cloudflare storehouse's Browser Run fetch — restaurant details are storehouse-first, and the snapshot's recorded fetchMethod + sourceFetchedAt are the fact's provenance); registration against a GET / text-extraction snapshot is refused. Registration machine-checks, at the same level as saveNormalizedFacts: (a) the snapshot is a restaurant_detail snapshot of the same park; (b) every evidence excerpt is a VERBATIM substring of the snapshot's stored raw text; (c) a positive value's excerpt contains a phrase supporting it （予約必須系／プライオリティ・シーティング／モバイルオーダー対象） — a classification inferred from a label (e.g. \"show restaurant, therefore required\") can never pass, because the supporting phrase must be IN the excerpt; (d) a negative value (none / not_available) is grounded either by an excerpt stating non-availability (mobile order only) or by ABSENCE: evidenceKind \"absence\" with an excerpt naming the facility, whereupon the SERVER re-verifies against the full snapshot text that none of the axis's presence markers occur in it, and records the checked marker list on the fact; (e) an unknown value requires a reason and an excerpt naming the facility — unknown is never silently folded into none / not_available; (f) a stated serviceType must appear verbatim in the snapshot text. Facts are valid for 180 days; the plan screen and the PDF derive a restaurant row's display from the newest valid fact. A facility whose official list carries a separate sub-entry (e.g. a show-dining area listed apart from the main restaurant) is registered as its OWN fact under its own official name, grounded in its own page — never merged into the main facility's fact.",
request: z.object({
park: parkEnum,
facts: z
.array(
z.object({
name: z.string().min(1).max(200),
serviceType: z.string().max(200).nullable().optional(),
snapshotId: z.number(),
reservation: restaurantAxisShape,
mobileOrder: restaurantAxisShape,
}),
)
.min(1)
.max(40),
}),
response: z.object({
ok: z.literal(true),
saved: z.number(),
factIds: z.array(z.number()),
}),
async handler(
ctx,
args,
): Promise<{ ok: true; saved: number; factIds: number[] }> {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "fact_build",
label: "レストランファクト登録",
endDetail: (r) => r.saved + "件を登録",
}, async () => {

const factIds: number[] = [];
for (const f of args.facts) {
const reservationType = f.reservation.type;
if (
reservationType !== "required" &&
reservationType !== "ps" &&
reservationType !== "none" &&
reservationType !== "unknown"
) {
throw new Error(
`saveRestaurantFacts: 「${f.name}」の予約形態（reservation.type）は required / ps / none / unknown のいずれかで入れてください（受け取った値: ${reservationType}）`,
);
}
const mobileType = f.mobileOrder.type;
if (
mobileType !== "available" &&
mobileType !== "not_available" &&
mobileType !== "unknown"
) {
throw new Error(
`saveRestaurantFacts: 「${f.name}」のモバイルオーダー（mobileOrder.type）は available / not_available / unknown のいずれかで入れてください（受け取った値: ${mobileType}）`,
);
}
factIds.push(
await registerRestaurantFact(ctx, args.park, {
name: f.name,
serviceType: f.serviceType ?? null,
snapshotId: f.snapshotId,
reservation: {
type: reservationType,
evidenceKind: f.reservation.evidenceKind,
evidence: f.reservation.evidence,
unknownReason: f.reservation.unknownReason ?? null,
},
mobileOrder: {
type: mobileType,
evidenceKind: f.mobileOrder.evidenceKind,
evidence: f.mobileOrder.evidence,
unknownReason: f.mobileOrder.unknownReason ?? null,
},
}),
);
}
ctx.invalidateQueries();
return { ok: true, saved: factIds.length, factIds };
});
},
}),

getRestaurantFacts: defineAction({
description:
"Internal: returns the current restaurant facts for one park — the newest valid (within 180 days) grounded fact per facility, with its values, service type, evidence kinds and the grounding snapshot's URL / fetch instant. The generation task reads this (or the restaurantFact summary on getFacilityDictionary entries) to REUSE a still-valid fact instead of re-reading the official detail page; a facility absent here has no usable fact and its detail page must be fetched and registered via saveRestaurantFacts before its classification is used.",
request: z.object({ park: parkEnum }),
response: z.object({
facts: z.array(
z.object({
name: z.string(),
serviceType: z.string().nullable(),
reservationType: z.enum(["required", "ps", "none", "unknown"]),
mobileOrder: z.enum(["available", "not_available", "unknown"]),
snapshotUrl: z.string(),
registeredAt: z.string(),
}),
),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.restaurantFacts)
.where(eq(schema.restaurantFacts.park, args.park))
.orderBy(desc(schema.restaurantFacts.id));
const now = Date.now();
const seen = new Set<string>();
const facts: {
name: string;
serviceType: string | null;
reservationType: "required" | "ps" | "none" | "unknown";
mobileOrder: "available" | "not_available" | "unknown";
snapshotUrl: string;
registeredAt: string;
}[] = [];
for (const r of rows) {
if (seen.has(r.nameKey)) continue;
seen.add(r.nameKey);
if (now - r.createdAt.getTime() > RESTAURANT_FACT_TTL_MS) continue;
const snapRows = await db
.select({ url: schema.sourceSnapshots.url })
.from(schema.sourceSnapshots)
.where(eq(schema.sourceSnapshots.id, r.snapshotId))
.limit(1);
facts.push({
name: r.name,
serviceType: r.serviceType,
reservationType: r.reservationType,
mobileOrder: r.mobileOrder,
snapshotUrl: snapRows[0]?.url ?? "",
registeredAt: r.createdAt.toISOString(),
});
}
return { facts };
},
}),

reportRestaurantFactCorrection: defineAction({
description:
"Internal: called by the restaurant-fact correction task when it finishes (or fails): posts the outcome as one assistant line in the TAB1 chat — what was registered, from which official pages, or honestly why it could not be. This is the correction channel's only report path; the task must call it exactly once, after the facts are actually registered (or after determining they cannot be).",
request: z.object({
status: z.enum(["done", "failed"]),
text: z.string().min(1).max(2000),
}),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
await db.insert(schema.messages).values({
role: "assistant",
text:
args.status === "done"
? `レストラン分類の訂正が終わりました。${args.text}`
: `レストラン分類の訂正は完了できませんでした。${args.text}`,
});
// 裏タスク管理： the report is posted — the correction's normal
// completion (whether it reports done or failed), and the
// manager run's "finished" mark; the manager does not retry a
// reported end.
await mgrFinishRunForTarget(
ctx,
{ type: "restaurant_correction" },
"finished",
);
ctx.invalidateQueries();
return { ok: true as const };
},
}),

applyRestaurantFactCorrection: defineAction({
description:
"Internal one-time correction (owner's instruction, 2026-11-16): rebuilds the ケープコッド・クックオフ classification on the restaurant fact layer. The facility dictionary's legacy column wrongly recorded the main restaurant as 予約必須 — inferred from its \"show restaurant\" label — while its own official detail page states no reservation requirement (counter service, Disney Mobile Order available); only the separately-listed ケープコッド・クックオフ（ショーダイニングエリア） requires a reservation. When the corrected facts are not yet registered, this action spawns a background task that reads both official detail pages, stores each verbatim as a restaurant_detail snapshot, and registers the grounded facts through saveRestaurantFacts' machine validation (main: reservation none by server-verified marker absence over the full page text + mobile available by excerpt; show-dining area: reservation required by excerpt + mobile not_available by absence), adds the show-dining area to the facility dictionary as its own entry when missing, and reports back via reportRestaurantFactCorrection. Idempotent: when both facilities already carry current facts with the corrected values, no task is spawned. No plan, plan item, message or other business row is ever written by this action itself. The task starts through the task manager （裏タスク管理クラス, kind 17) like every production background task — retries re-run the same correction, and if the attempts are exhausted the failure surfaces as an in-app dialog carrying the common congestion text.",
request: z.object({}),
response: z.object({
ok: z.literal(true),
spawned: z.boolean(),
alreadyCorrect: z.array(z.string()),
}),
async handler(
ctx,
): Promise<{ ok: true; spawned: boolean; alreadyCorrect: string[] }> {
const alreadyCorrect = await restaurantCorrectionRegistered(ctx);
if (alreadyCorrect.length === 2) {
return { ok: true as const, spawned: false, alreadyCorrect };
}
const spawned = await spawnRestaurantCorrectionAttempt(ctx);
ctx.invalidateQueries();
return { ok: true as const, spawned, alreadyCorrect };
},
}),

savePlanSet: defineAction({
description:
"Internal: called by the generation task to save the finished plans (three for a standard set; exactly one, slot A, for a 当日検索 set), their timelines, OSM coordinates, and the official sources used. FIRST, a class-11 minimum-content floor runs: each plan needs a real title (not the slot letter), a non-empty summary, a computed cost total with an itemized breakdown, at least one real attraction/show item (not just entry/exit marker rows), and an estimated wait on every attraction AND show row. The floor is SUBSTANTIVE as well as formal (2026-11-15): a standard set's plan needs at least 6 content rows (attraction + show + restaurant combined; entry/exit/move/break/purchase rows do not count), a summary of real substance (not one character, not boilerplate, at least 10 non-whitespace characters), a title free of test/placeholder patterns (e.g. 「Aテスト」), and a cost total at or above the party's ticket cost at the OFFICIAL unit prices — the payload must carry that basis as `ticketPrices` (adult/child unit price + the id of the ticket_prices source snapshot it was read from), and the gate machine-checks the claimed prices against the stored snapshot text, never against the payload's own breakdown. Same-day sets keep the formal floor only (no row floor; their cost excludes tickets). The set's park/date must also agree with the conditions snapshot stored on it, and DPA money is recomputed against the party recorded in that snapshot (never the live form). A floor failure is not a fix-and-resave refusal: nothing is stored, the set is marked failed with the class-11 reasons in its verification record, and the failure is announced in the chat. Before anything is stored, the payload is verified: every attraction needs an estimated wait and no schedule may contradict its estimates, and the finished rows are cross-checked against the official data fetched on that run: DPA eligibility, unit prices and application periods are judged ONLY by the normalized facts of the fact build named by `factBuildId` (the run fetched the canonical sources into source_snapshots and read them into normalized_facts via saveNormalizedFacts; registration machine-checks every fact's evidence excerpt against the stored snapshot text, and completeness against the facility_list mother set) — including any application period a fact states for a facility (e.g. a lineup expansion taking effect on a future date), with eligibility judged against the lineup in force on the visit date. A missing or incomplete build refuses every DPA row. DPA cost is counted at PURCHASE: once per purchase instance (facility × purchase event) at the fact unit price × the purchase row's purchaseCount — the headcount that actually uses that facility in that plan (owner's ruling, 2026-11-17; the whole party only when everyone uses it) — never on usage rows (a unit price on a usage row is ignored); a purchase-event row (kind \"purchase\") whose stated unit price differs from the fact price, or whose purchaseCount is missing, below 1, or above the party size, is refused as a class-2 DPA費用の計上不一致. Closures on the visit date, park hours, show performance times, and the DPA purchase sequence under the 60-minute rule are checked as before. Park hours are checked on BOTH ends (class 4): a row whose official duration is known (facility dictionary durationMin, else the note's 「所要約◯分」) and whose start + duration passes the set's cap — the earlier of the conditions snapshot's exit time and the run's closing time — is refused; ending exactly at the cap is inside, and rows with no known duration are judged on the start side only. BUDGET CORRESPONDENCE (class 13): each plan's cost total is machine-compared with the budget in the set's conditions snapshot; a total over budget is refused ONLY when the submission carries no budgetDisclosure for that plan (an overrun WITH the disclosure text — also written into the plan's summary — passes; same-day sets without a budget condition are out of scope). COORDINATES (spec §10): item coordinates outside the park's bounding box are treated as no coordinates and recorded 未確認 with the reason, never stored as fact. Travel time between consecutive items is computed by the server itself (straight-line distance between the facilities' coordinates at the set's walking speed, detour factor, area-matrix max, ×1.2 margin) and stored per item as travelMin; a gap smaller than wait + official duration + travelMin is refused the same way, and a leg whose coordinates cannot be resolved is recorded 未確認 and checked against the legacy wait + 10 floor. A failing payload is refused with the problems listed; the task fixes and re-saves instead of reporting failure. When a saved set's verification record leaves spec-related facts unconfirmed (an incomplete fact build, DPA / hours / show-time facts unverified), the completion line posted to the chat also carries the repair guidance (the app's premises may no longer match Disney's current system; ask your own Muse in the main chat to fix the app) — the owner's rule that the guidance rides in the detection message itself, not only in the help tab. The payload also carries the run's crowd forecast for the visit date (crowdLevel 1–5 + crowdBasis — never a user-chosen form field). A date's forecast is decided ONCE: when a finished set for the same park + visit date already carries one, the stored premise is the HELD forecast (the run's re-evaluation is discarded, and the stored basis records the reuse and the deciding set), because the forecast is evaluated — per the assignment's stated priority — primarily from external published forecasts converted to the 5-level scale, with seasonal statistics and the date's ticket price band only auxiliary. The payload also carries the per-facility effective crowd factors actually applied to the base wait estimates (crowdWaitFactors, each at or below the level's cap in CROWD_WAIT_FACTOR_CAPS, whose values are caps for the most crowd-sensitive headline attractions); the level and basis are stored on the set as its premise, and the verification record gains a 混雑予想と待ち時間の係数 entry plus the factor list so the multiplication stays traceable.",
request: z.object({
planSetId: z.number(),
// The normalized-fact build this run constructed from the
// canonical sources it fetched (saveSourceSnapshots ->
// saveNormalizedFacts). The DPA gate judges ONLY this build's
// facts. Null/absent refuses every DPA row.
factBuildId: z.number().nullable().optional(),
// Crowd forecast （混雑予想） for the visit date, evaluated by the
// generation task (step 1c of the assignment): the 1–5 level and
// its short basis, stored on the set as its premise. The waits in
// `plans` are already coefficient-applied values (base estimate ×
// per-facility effective factor, each at or below the level's cap
// in CROWD_WAIT_FACTOR_CAPS). Null when the run could not evaluate
// (e.g. a 当日検索 set, whose waits come from current postings and
// carry no coefficient).
crowdLevel: z.number().int().min(1).max(5).nullable().optional(),
crowdBasis: z.string().max(500).nullable().optional(),
// The ticket-price basis for the class-11 cost floor (g): the
// official 1-day passport unit prices for the visit date as
// fetched on this run, tied to the stored ticket_prices snapshot
// they were read from (machine-checked at the gate). Required for
// standard sets; ignored for same-day sets (their cost excludes
// tickets).
ticketPrices: ticketPricesShape.nullable().optional(),
// The per-plan, per-facility EFFECTIVE crowd factors actually
// applied to the base estimates (each plan is built under its
// own crowd scenario, so the same facility can carry a different
// factor per plan), so the verification record can show what was
// multiplied where — never just the cap.
crowdWaitFactors: z
.array(
z.object({
slot: slotEnum,
name: z.string().max(200),
factor: z.number().min(0).max(10),
}),
)
.max(240)
.default([]),
parkHours: z.string().nullable().optional(),
notes: z.string().nullable().optional(),
sources: z
.array(z.object({ title: z.string(), url: z.string()}))
.max(20)
.default([]),
// Wait-time reference sites actually consulted as estimation material
// (kept apart from the official sources above).
estimateSources: z
.array(
z.object({
title: z.string(),
url: z.string(),
fetchedAt: z.string().nullable().optional(),
}),
)
.max(20)
.default([]),
// Per-site fetch outcome for EVERY registered reference site the
// task attempted: which method actually worked this time. Recorded
// back onto wait_time_sources as the site's fetch method, so the
// next generation starts from the method that works.
waitSourceFetchResults: z
.array(
z.object({
url: z.string().max(2000),
method: z.enum(["script", "browser", "failed"]),
}),
)
.max(30)
.default([]),
// Generation measurements: pages opened and seconds per phase, so
// generation time is recorded fact. Optional — older tasks may not
// report it.
metrics: z
.object({
pagesOpened: z.number().int().min(0).nullable().optional(),
phases: z
.array(
z.object({
name: z.string().max(100),
seconds: z.number().min(0),
}),
)
.max(12)
.default([]),
})
.nullable()
.optional(),
// The verification data this run actually fetched from the official
// site, against which the finished plans are cross-checked BEFORE
// the set may complete: the facilities closed on the visit date and
// the official performance times of the shows/parades used. DPA is
// judged separately, ONLY by the normalized facts of the build
// named by the payload's factBuildId (see saveNormalizedFacts);
// `verification.dpaSnapshotText` is still accepted and stored on
// the set as the run's raw material, but it judges nothing.
// Anything the task could not fetch
// goes in `unverified` and is recorded as 未確認 — never silently
// passed. Required: a save without verification data is refused,
// because completing an unverified plan is exactly the failure this
// step exists to prevent.
verification: z.object({
fetchedAt: z.string().max(40).nullable().optional(),
dpaSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
calendarSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
entertainmentSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
// Raw text of the official DPA page(s) as fetched on this run,
// stored verbatim on the plan set. Null/empty when the page could
// not be fetched — every DPA row is then refused, because there
// is nothing honest to check it against.
dpaSnapshotText: z.string().max(500000).nullable().optional(),
closedFacilities: z.array(z.string().max(200)).max(120).default([]),
showTimes: z
.array(
z.object({
name: z.string().max(200),
times: z.array(z.string().max(10)).max(12),
}),
)
.max(80)
.default([]),
unverified: z.array(z.string().max(300)).max(30).default([]),
}),
plans: z
.array(
z.object({
slot: slotEnum,
title: z.string().min(1),
summary: z.string().nullable().optional(),
estimatedCostJpy: z.number().nullable().optional(),
// Budget-overrun disclosure (class 13, spec §9.2): when this
// plan's cost total exceeds the budget recorded in the set's
// conditions snapshot, the submission MUST carry the overrun
// disclosure text here (and the same disclosure in the plan's
// summary). An over-budget plan WITHOUT it is refused as a
// class-13 予算対応の不一致 — the overrun itself is never a
// refusal reason when disclosed. Null/within budget: not needed.
budgetDisclosure: z.string().max(1000).nullable().optional(),
costBreakdown: z
.array(
z.object({
label: z.string().min(1),
amountJpy: z.number().nullable().optional(),
note: z.string().nullable().optional(),
}),
)
.max(12)
.optional(),
items: z
.array(
z.object({
timeLabel: z.string().nullable().optional(),
name: z.string().min(1),
kind: kindEnum.default("other"),
area: z.string().nullable().optional(),
note: z.string().nullable().optional(),
passType: z.string().nullable().optional(),
// For DPA rows: the time of day ("9:05") the pass is to be
// bought. Required for DPA rows — the purchase sequence is
// verified against the official 60-minute rule below.
dpaPurchaseTime: z.string().max(10).nullable().optional(),
// Unit price (1名分） on a purchase-event row (kind =
// "purchase"): the fact unit price the pass is bought at. The
// gate counts DPA cost once per purchase instance from the
// FACT price and rejects a purchase row whose stated price
// differs (class 2). A price on a usage row is ignored.
unitPriceJpy: z.number().int().min(0).max(100000).nullable().optional(),
// Headcount (対象人数） on a purchase-event row: the number
// of people who actually use that facility in this plan
// (owner's ruling, 2026-11-17). REQUIRED on every purchase
// row: the gate counts DPA cost as fact unit price × this
// count and refuses a missing count, a count below 1, or a
// count above the party size as class 2 — it never silently
// counts the whole party. The schema accepts 0 so the gate
// itself delivers the class-2 refusal.
purchaseCount: z.number().int().min(0).max(10000).nullable().optional(),
// Estimated wait in minutes. Required (0 allowed) for attraction
// items; validated below together with the schedule arithmetic.
estWaitMin: z.number().int().min(0).max(600).nullable().optional(),
// Row-level unconfirmed element (§9.4): the short reason and the
// explanation for a value this row places as an assumption because
// it could not be confirmed from official sources on this run
// (e.g. a show time whose official schedule is not yet published).
// Both null for confirmed rows. An unconfirmed value must never be
// placed without this marking; the verification record's 未確認
// entry for the row is derived from these fields, not restated.
unconfirmedReason: z.string().max(80).nullable().optional(),
unconfirmedNote: z.string().max(600).nullable().optional(),
lat: z.number().nullable().optional(),
lng: z.number().nullable().optional(),
imageUrl: z.string().max(2000).nullable().optional(),
referenceUrl: z.string().max(2000).nullable().optional(),
officialUrl: z.string().max(2000).nullable().optional(),
}),
)
.max(40),
}),
)
.min(1)
.max(3),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) {
throw new Error(`savePlanSet: plan set ${args.planSetId} not found`);
}
// 過程記録： EVERY save attempt is bracketed by the server itself
// — this call's phase_start IS the attempt's start, and every exit
// below records the attempt's outcome on the trail: the success
// phase_end, or a note carrying the refusal's class and reason
// (plan-count contract, class-11 floor, verification gate). A
// refusal NEVER closes the run: the task's recovery work after it
// (re-fetching the missing page, re-saving) belongs to the same
// run, which closes only at the task's true end — the successful
// save below, a failure report, or the watchdog / sweep.
await recordServerRunEvent(ctx, args.planSetId, {
eventType: "phase_start",
phase: "save_verify",
label: "保存・検証の開始（savePlanSet）",
});
// Plan-count contract, decided by the set's creation route: a
// standard set is exactly the three plans A/B/C; a 当日検索 set is
// exactly ONE plan (slot A) — the emergency entry deliberately
// produces a single usable plan, not three variants.
const isSameDaySet = set.setType === "same_day";
const planCountError = isSameDaySet
? args.plans.length !== 1 || args.plans[0]?.slot !== "A"
? "savePlanSet: 当日検索のプランセットには、プランAを1件だけ保存してください（プランB・Cは作らないこと）。"
: null
: args.plans.length !== 3
? "savePlanSet: 通常のプランセットにはプランA・B・Cの3件が必要です。"
: null;
if (planCountError) {
// 過程記録： this attempt's outcome goes on the trail before the
// refusal propagates; the run stays open for the task's fix.
await recordServerRunEvent(ctx, args.planSetId, {
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（プラン件数の契約）",
detail: planCountError,
});
throw new Error(planCountError);
}

// Restaurant waits are not modeled (owner design, 記録AD): a
// restaurant is assumed prepared in advance, so a restaurant row
// never carries an estimated wait. Normalize server-side — the
// payload is not trusted — BEFORE every gate below (the class-11
// floor, the gap arithmetic, the cross-checks) and before
// storage: a restaurant row's estWaitMin is dropped to null, the
// same replace-don't-reject treatment as the park-range
// coordinate pass below. Every gate therefore sees null, and
// nothing but null is ever stored for a restaurant row.
for (const plan of args.plans) {
for (const item of plan.items) {
if (item.kind === "restaurant") item.estWaitMin = null;
}
}

// Park-range check on payload coordinates (spec §10): a pair
// outside the park's bounding box is treated as NO coordinates
// from here on — it never reaches the dictionary, the travel
// computation, or a stored row as fact — and the facility is
// recorded 未確認 with the reason in the verification record
// below (never silently dropped).
const outOfRangeCoordNames: string[] = [];
for (const plan of args.plans) {
for (const item of plan.items) {
if (
item.lat != null &&
item.lng != null &&
!coordsInParkRange(set.park, item.lat, item.lng)
) {
item.lat = null;
item.lng = null;
if (!outOfRangeCoordNames.includes(item.name)) {
outOfRangeCoordNames.push(item.name);
}
}
}
}

// ---------- class 11: minimum plan content （プランの最低内容） ----------
// The floor runs BEFORE every other check, and a floor failure is
// NOT a fix-and-resave refusal: a payload this thin is not a plan
// at all (the incident this class exists for: plan A/B were the
// single line 「21:00 退園」 with placeholder titles, no summary
// and no cost, yet the set completed and was announced as done).
// Nothing is stored, the set is marked FAILED with the reasons
// recorded in its verification record as class 11, and the failure
// is announced in the chat — no completion line is ever posted for
// a set that did not clear the floor.
// Substantive floors (2026-11-15): the ticket-cost floor's basis
// is resolved and machine-checked FIRST (against the stored
// ticket_prices snapshot — never the payload's own breakdown);
// standard sets additionally carry the content-row floor.
// Same-day sets keep the legacy formal floor only.
const ticketFloor = await resolveTicketFloor(ctx, set, args.ticketPrices);
const floorViolations = [
...snapshotCorrespondenceViolations(set),
...ticketFloor.violations,
...planFloorViolations(
args.plans,
isSameDaySet
? {}
: {
contentRowFloor: CONTENT_ROW_FLOOR,
ticketFloorJpy: ticketFloor.floorJpy,
ticketFloorBasis: ticketFloor.basis,
},
),
];
if (floorViolations.length > 0) {
const reason = `プランの最低内容を満たしていません（クラス11：プランの最低内容不足）。${floorViolations.join("／")}`;
const floorRecord: z.infer<typeof verificationShape> = {
checkedAt: new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
}),
checks: [
{
label: "プランの最低内容（クラス11）",
result: floorViolations.join("／"),
sourceTitle: null,
sourceUrl: null,
fetchedAt: null,
},
],
unverified: [],
dpaExtracted: [],
factBuildId: null,
factSummary: null,
dpaFacts: [],
crowdFactors: [],
};
const wasGenerating = set.status === "generating";
await db
.update(schema.planSets)
.set({
status: "failed",
error: reason,
completedAt: new Date(),
progressA: "failed",
progressB: "failed",
progressC: "failed",
verificationJson: JSON.stringify(floorRecord),
})
.where(eq(schema.planSets.id, set.id));
// 過程記録： the class-11 refusal is recorded as this attempt's
// outcome, and the run is NOT closed here (owner's rule,
// 2026-11-19: a run closes only at the task's true end). The set
// is marked failed as before, but the task may still recover —
// re-fetch what was missing and re-save — and that recovery
// belongs to this same run; if the task instead reports failure
// or dies, reportPlanFailure / the getState sweep closes the run
// as failed with this reason on the trail.
await recordServerRunEvent(ctx, set.id, {
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（クラス11：プランの最低内容不足）",
detail: reason,
});
if (wasGenerating) {
await db.insert(schema.messages).values({
role: "assistant",
text: `「${set.title}」のプラン作成はできませんでした。（対象条件: ${setConditionsSummary(set)}／理由: ${reason}）プランは何も保存されていません。\n${SPEC_REPAIR_GUIDANCE}`,
});
}
ctx.invalidateQueries();
throw new Error(
`保存できませんでした。${reason} セットは失敗として記録されました。最低内容を満たすプランを作れない場合は、reportPlanFailure で理由を報告してください。`,
);
}

// ---------- crowd forecast reuse （混雑予想は日付ごとに1回だけ） ----------
// When a finished set for the same park + visit date already
// carries a decided forecast, THIS set's premise is that held
// forecast — the run's own re-evaluation never overwrites it
// (the assignment already tells the task to reuse it; this is
// the storage-layer guarantee). The stored basis carries the
// reuse trace (see reusedCrowdBasis). Same-day sets carry no
// forecast and are untouched, and a run that submitted no
// forecast at all (a day-of reschedule, whose waits come from
// current postings and carry no coefficient) keeps none — the
// reuse governs runs that participate in the forecast system.
const heldCrowd =
isSameDaySet || args.crowdLevel == null
? null
: await findHeldCrowdForecast(ctx, set.park, set.visitDate, set.id);
const effectiveCrowdLevel = heldCrowd
? heldCrowd.level
: (args.crowdLevel ?? null);
const effectiveCrowdBasis = heldCrowd
? reusedCrowdBasis(heldCrowd)
: (args.crowdBasis ?? null);

// ---------- travel-time preparation （移動時間） ----------
// Resolve every item's effective coordinates / area / official
// duration (payload first, facility dictionary as backfill — the
// same values the save path below will store) and compute each
// leg's travel minutes deterministically. The set's snapshotted
// walking speed governs; sets created before the snapshot existed
// fall back to the current form value.
const travelConditions = await loadConditions(ctx);
const travelSpeed: WalkingSpeed =
set.walkingSpeed ?? travelConditions.walkingSpeed;
const areaMatrix = await loadAreaMatrix(ctx, set.park);
const travelDictCache = new Map<string, FacilityRow | undefined>();
const travelDictFor = async (
name: string,
): Promise<FacilityRow | undefined> => {
const key = facilityNameKey(name);
if (!travelDictCache.has(key)) {
travelDictCache.set(key, await findFacility(ctx, set.park, name));
}
return travelDictCache.get(key);
};
// Save-time coordinate resolution （座標の安全網）: facilities the
// payload and the dictionary both leave coordinate-less are
// re-resolved deterministically (Nominatim re-query -> dictionary;
// area representative point -> coordFallback). Runs BEFORE the
// dictionary caches below fill, so tier-1 heals are visible to
// every later lookup in this save.
const {
fallback: coordFallback,
parkWide: coordParkWide,
notices: coordAreaNotices,
} = await buildCoordFallback(
ctx,
set.park,
// Display-only 「最初の10分」 rows (kind "first10") are not
// facilities: they never enter coordinate resolution.
args.plans.map((p) => p.items.filter((it) => it.kind !== "first10")),
);
type PlanTravel = {
resolved: ResolvedItem[];
legs: (LegResult | null)[];
};
const travelByPlan = new Map<(typeof args.plans)[number], PlanTravel>();
for (const plan of args.plans) {
const resolved: ResolvedItem[] = [];
for (const item of plan.items) {
const dict = await travelDictFor(item.name);
const hasPair = item.lat != null && item.lng != null;
// A dictionary pair outside the park's box (a legacy row saved
// before the range check existed) is not used either (spec §10).
const dictPair =
dict?.lat != null &&
dict?.lng != null &&
coordsInParkRange(set.park, dict.lat, dict.lng)
? { lat: dict.lat, lng: dict.lng }
: null;
// A park-wide show's pin is the park's representative point,
// overriding payload and dictionary coordinates alike (see the
// park-wide section above); purchase rows are not places.
const pwPoint =
item.kind === "purchase" || item.kind === "first10"
? undefined
: coordParkWide.get(facilityNameKey(item.name));
resolved.push({
name: item.name,
kind: item.kind,
lat: pwPoint
? pwPoint.lat
: hasPair
? (item.lat as number)
: dictPair?.lat??
coordFallback.get(facilityNameKey(item.name))?.lat??
null,
lng: pwPoint
? pwPoint.lng
: hasPair
? (item.lng as number)
: dictPair?.lng??
coordFallback.get(facilityNameKey(item.name))?.lng??
null,
area: item.area?? dict?.area?? null,
durationMin: dict?.durationMin?? null,
});
}
travelByPlan.set(plan, {
resolved,
legs: computeLegs(resolved, travelSpeed, areaMatrix),
});
}
let travelLegsTotal = 0;
let travelLegsVerified = 0;
let travelMatrixUsed = 0;
const travelMatrixSources: AreaMatrixEntry[] = [];
const travelUnverifiedLegs: string[] = [];
for (const plan of args.plans) {
const entry = travelByPlan.get(plan);
if (!entry) continue;
entry.legs.forEach((leg, i) => {
if (i === 0 || !leg) return;
// A purchase-event row's zero pass-through leg is not a travel
// leg and never counts toward the totals. The display-only
// 「最初の10分」 row's pass-through leg is the same.
if (
entry.resolved[i]?.kind === "purchase" ||
entry.resolved[i]?.kind === "first10"
) return;
travelLegsTotal++;
if (leg.travelMin != null) {
travelLegsVerified++;
if (leg.matrixUsed) {
travelMatrixUsed++;
if (
leg.matrixEntry &&
!travelMatrixSources.includes(leg.matrixEntry)
) {
travelMatrixSources.push(leg.matrixEntry);
}
}
} else {
const from = entry.resolved[i - 1];
const to = entry.resolved[i];
if (from && to) {
const label = `${from.name}→${to.name}`;
if (!travelUnverifiedLegs.includes(label)) {
travelUnverifiedLegs.push(label);
}
}
}
});
}

// Deterministic wait/schedule validation (the user's hard rule: every
// attraction states an estimated wait, and no schedule may contradict
// its own estimates). A plan whose numbers cannot all be true at once
// destroys trust in one shot, so a violating payload is refused here
// with the problems listed — the generation task is instructed to fix
// the estimates/times and call savePlanSet again rather than report a
// failure. The gap rule: for a leg whose travel time the server could
// compute (both facilities' coordinates resolved), the gap must cover
// wait + official ride duration (facility dictionary) + travel_min
// (margin included); for an unverified leg （未確認） the legacy floor
// of wait + 10 minutes applies — the smallest allowance that still
// covers a short ride, a short walk, and some slack. The assignment
// instructs the agent to budget from the same formula, so a plan
// drafted to the formula passes deterministically.
const violations: string[] = [];
const parseTime = (label: string | null | undefined): number | null => {
if (!label) return null;
const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
if (!m) return null;
return Number(m[1]) * 60 + Number(m[2]);
};
// 当日検索-only checks: the plan covers ONLY the time from the
// specified start time onward, and its first item IS the visitor's
// current location at that time — the anchor the first leg's
// travel_min is computed from. An item scheduled before the start
// time, or a first item that is not the stated location, means the
// plan does not start where the visitor actually is.
if (isSameDaySet && set.sameDayStartTime) {
const startMin = parseTime(set.sameDayStartTime);
const sdPlan = args.plans[0];
if (startMin != null && sdPlan) {
const first = sdPlan.items[0];
if (!first) {
violations.push(
"当日検索: 項目が1つもありません。先頭に現在地点の項目を置き、指定時刻から先のスケジュールを作ってください。",
);
} else {
if (parseTime(first.timeLabel) !== startMin) {
violations.push(
`当日検索: 先頭の項目（現在地点）の時刻（${first.timeLabel ?? "なし"}）が、指定時刻（${set.sameDayStartTime}）と一致しません。先頭の現在地点の項目は指定時刻ちょうどにしてください。`,
);
}
const locKey = facilityNameKey(set.sameDayLocation ?? "");
const firstNameKey = facilityNameKey(first.name);
const nameMatch =
locKey !== "" &&
firstNameKey !== "" &&
(firstNameKey.includes(locKey) || locKey.includes(firstNameKey));
const areaMatch =
first.area != null && locKey !== "" &&
facilityNameKey(first.area) === locKey;
if (!nameMatch && !areaMatch) {
violations.push(
`当日検索: 先頭の項目が現在地点「${set.sameDayLocation ?? ""}」を表していません。先頭の項目の name に現在地点の表記をそのまま使うか、area を現在地点のエリア名にして、現在地点から最初の移動が計算できる形で再保存してください。`,
);
}
}
for (const item of sdPlan.items) {
const t = parseTime(item.timeLabel);
if (t != null && t < startMin) {
violations.push(
`当日検索「${item.name}」: 開始時刻（${item.timeLabel}）が指定時刻（${set.sameDayStartTime}）より前です。当日検索は指定時刻から先の項目だけにしてください。`,
);
}
}
}
}
for (const plan of args.plans) {
type TimedItem = (typeof plan.items)[number];
const planTravel = travelByPlan.get(plan);
let prev: { item: TimedItem; start: number; index: number} | null = null;
for (const [itemIndex, item] of plan.items.entries()) {
// A purchase-event row is not a schedule stop: it takes no
// place in the wait/travel arithmetic and never becomes the
// "previous item" a gap is measured from. The display-only
// 「最初の10分」 row (kind "first10") is not a stop either.
if (item.kind === "purchase" || item.kind === "first10") continue;
if (item.kind === "attraction" && item.estWaitMin == null) {
violations.push(
`プラン${plan.slot}「${item.name}」: アトラクションに推定待ち時間（estWaitMin）がありません。0分でも必ず入れてください。`,
);
}
const start = parseTime(item.timeLabel);
if (prev && start != null && prev.item.estWaitMin != null) {
// Restaurant waits are not modeled (owner design: prepared in
// advance). Restaurant rows were normalized to a null wait
// above, so this is belt-and-braces: a restaurant row's wait
// would contribute 0 to the gap arithmetic, never its value.
const prevWait =
prev.item.kind === "restaurant" ? 0 : prev.item.estWaitMin;
const gap = start - prev.start;
const travel = planTravel
? gapTravelMin(planTravel.legs, prev.index, itemIndex)
: null;
if (travel != null) {
// Verified leg(s): the gap must cover the estimated wait +
// the official ride duration + the server-computed
// travel_min (which already carries the ×1.2 margin). When
// the official duration is not in the dictionary, the legacy
// +10 floor still applies as the combined allowance, so an
// unknown duration never weakens the check.
const duration =
planTravel?.resolved[prev.index]?.durationMin ?? null;
const need = prevWait + (duration ?? 0) + travel;
const flooredNeed =
duration == null
? Math.max(need, prevWait + 10)
: need;
if (gap < flooredNeed) {
violations.push(
`プラン${plan.slot}「${prev.item.name}」: 推定待ち${prevWait}分＋体験時間${duration != null? `${duration}分`: "（公式所要時間が辞書に無いため0分として計算）"}＋移動時間${travel}分（サーバーが座標・歩く速さ・エリア間マトリクスから計算した travel_min）に対し、次の「${item.name}」まで${gap}分しかありません（最低${flooredNeed}分必要）。次の項目の時刻を後ろへずらしてください。`,
);
}
} else {
const need = prevWait + 10;
if (gap < need) {
violations.push(
`プラン${plan.slot}「${prev.item.name}」: 推定待ち${prevWait}分に対し、次の「${item.name}」まで${gap}分しかありません（待ち時間＋体験・移動・余裕として最低${need}分必要）。次の項目の時刻を後ろへずらしてください。`,
);
}
}
}
if (start != null) prev = { item, start, index: itemIndex};
}
}

// ---------- pre-completion verification （検証プロセス） ----------
// The finished rows are cross-checked against the official data
// fetched on THIS run (carried in args.verification), never against
// the model's memory — generation-time rule reading alone let a
// non-existent DPA (Center of the Earth) and stale unit prices
// （ソアリン 2,000円 etc.) through, because nothing ever compared
// the finished rows with the fetched facts. Failures join the same
// violations list as the schedule arithmetic above: the save is
// refused and the task fixes and re-saves. What cannot be checked
// is not silently passed either: it is collected into the
// verification record's 未確認 list and appended to the plan notes.
const v = args.verification;
const fmtMin = (min: number): string =>
`${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
const isDpaPass = (passType: string | null | undefined): boolean =>
passType != null && /プレミアアクセス|DPA/i.test(passType);
// DPA eligibility, unit prices and application periods come ONLY
// from the normalized facts of the fact build this run constructed
// (args.factBuildId) — never from text extraction over a snapshot
// and never from a list the task wrote. A missing or incomplete
// build refuses every DPA row (judgeDpaFact), at the same strength
// as the old no-snapshot rule. The run's raw DPA page text is still
// accepted and stored on the set as material, but it judges
// nothing.
const factGate = await loadDpaFactGate(ctx, args.factBuildId, set.park);
const dpaExtracted = factGate.eligibleEntries;
const dpaSnapshotText = v.dpaSnapshotText?? "";
const closedKeys = new Set(
v.closedFacilities.map((n) => facilityNameKey(n)),
);
const showTimesByKey = new Map(
v.showTimes.map(
(s) =>
[
facilityNameKey(s.name),
s.times
.map((t) => parseTime(t))
.filter((t): t is number => t != null),
] as const,
),
);
// The party the DPA money is checked against is the one recorded
// in THIS set's conditions snapshot — the conditions the run was
// actually started under — never the live form: a chat-started run
// for 大人2人＋子ども2人 whose form still says 大人2人 would
// otherwise have its (correct) costs recomputed against the wrong
// party and refused, or a wrong-party plan waved through. A
// 当日検索 run carries its own party size on the set (its form is
// independent of the TAB2 conditions). The form is only the legacy
// fallback for a set whose snapshot carries no party line.
const snapshotParty = parseSnapshotParty(set.conditionsSnapshot);
const formParty = snapshotParty ? null : await loadConditions(ctx);
const partySize =
isSameDaySet && set.sameDayAdults != null
? set.sameDayAdults + (set.sameDayChildren ?? 0)
: snapshotParty
? snapshotParty.adults + snapshotParty.children
: (formParty?.adults ?? 0) + (formParty?.children ?? 0);
let hoursWindow: { open: number; close: number} | null = null;
if (args.parkHours) {
const hm = /(\d{1,2}):(\d{2})\s*[～~\-–−]\s*(\d{1,2}):(\d{2})/.exec(
args.parkHours,
);
if (hm) {
hoursWindow = {
open: Number(hm[1]) * 60 + Number(hm[2]),
close: Number(hm[3]) * 60 + Number(hm[4]),
};
}
}
// Class 4, END side (spec §9.2, revision X): the cap a row must
// END by is the earlier of the conditions snapshot's exit time
// and this run's closing time; when the exit time cannot be read
// from the snapshot, the closing time alone is the cap (and vice
// versa). Rows whose official duration is known (dictionary
// durationMin, else the note's 「所要約◯分」) and that end past
// the cap are refused below; ending exactly AT the cap is inside.
// The snapshot's budget feeds the class-13 check further down.
const snapshotConditions = parseSnapshotConditions(set).conditions;
const snapshotExitMin = parseTime(snapshotConditions.exitTime);
let endCapMin: number | null = null;
if (hoursWindow && snapshotExitMin != null) {
endCapMin = Math.min(snapshotExitMin, hoursWindow.close);
} else if (hoursWindow) {
endCapMin = hoursWindow.close;
} else if (snapshotExitMin != null) {
endCapMin = snapshotExitMin;
}
const snapshotBudgetJpy = snapshotConditions.budgetJpy;
const autoUnverified: string[] = [];
const pushUnverified = (s: string): void => {
if (!autoUnverified.includes(s)) autoUnverified.push(s);
};
// Fact-origin unverified entries only (see factsUnconfirmed):
// collected alongside autoUnverified at the fact-derived push
// sites below. Travel-leg and coordinate entries are a different
// classification and never join this list.
const factUnverified: string[] = [];
const pushFactUnverified = (s: string): void => {
if (!factUnverified.includes(s)) factUnverified.push(s);
};
if (!hoursWindow) {
const hoursUnverifiedEntry =
"営業時間：未確認（対象日の営業時間を、この回の取得データから読み取れなかったため）";
pushUnverified(hoursUnverifiedEntry);
pushFactUnverified(hoursUnverifiedEntry);
}
for (const u of factGateLevelUnverified(factGate)) {
pushUnverified(u);
pushFactUnverified(u);
}
for (const legLabel of travelUnverifiedLegs.slice(0, 5)) {
pushUnverified(
`移動時間（${legLabel}）：未確認（どちらかの施設の座標が、プランの項目からも施設辞書からも引けなかったため。その区間は従来の下限＝推定待ち＋10分で検証しました）`,
);
}
if (travelUnverifiedLegs.length > 5) {
pushUnverified(
`移動時間：ほか${travelUnverifiedLegs.length - 5}区間も座標が引けず未確認（従来の下限で検証）`,
);
}
for (const n of coordAreaNotices) pushUnverified(n);
for (const n of outOfRangeCoordNames) {
pushUnverified(
`座標（${n}）：パーク範囲外のため未確認（提出された座標が${parkName(set.park)}の範囲外だったため、座標なしとして扱いました）`,
);
}
// Facilities that ended up WITH coordinates (payload / dictionary /
// the save-time resolution): task-supplied 未確認 entries claiming
// such a facility is coordinate-less are stale and dropped below.
const healedNames: string[] = [];
for (const plan of args.plans) {
const entry = travelByPlan.get(plan);
if (!entry) continue;
for (const r of entry.resolved) {
if (
r.lat != null &&
r.lng != null &&
!healedNames.includes(r.name)
) {
healedNames.push(r.name);
}
}
}
let dpaRowCount = 0;
let showCheckedCount = 0;
for (const plan of args.plans) {
let expectedDpaTotal = 0;
let planDpaRows = 0;
const dpaSeq: { name: string; purchase: number; use: number}[] = [];
for (const [itemIndex, item] of plan.items.entries()) {
const key = facilityNameKey(item.name);
const start = parseTime(item.timeLabel);
// Facility-level checks (closures / hours / show times) run on
// real stops only: a purchase-event row names the same facility
// as its usage row, which carries these checks — running them
// here too would only duplicate the same violation. The
// display-only 「最初の10分」 row (kind "first10") is not a
// facility at all, so it is outside these checks too.
if (item.kind !== "purchase" && item.kind !== "first10") {
if (closedKeys.has(key)) {
violations.push(
`プラン${plan.slot}「${item.name}」: この回に取得した対象日の休止一覧に載っている施設です。プランから外してください。`,
);
}
if (
hoursWindow &&
start != null &&
(start < hoursWindow.open || start > hoursWindow.close)
) {
violations.push(
`プラン${plan.slot}「${item.name}」: 開始時刻（${item.timeLabel}）が対象日の営業時間（${fmtMin(hoursWindow.open)}〜${fmtMin(hoursWindow.close)}）の範囲外です。`,
);
}
// Class 4, END side: start + official duration must not pass
// the set's cap (the earlier of the snapshot's exit time and
// the closing time). The duration comes from the facility
// dictionary, falling back to the note's 「所要約◯分」; a row
// with no known duration is not judged on the end side, and
// ending exactly at the cap is inside.
if (endCapMin != null && start != null) {
const endDuration =
travelByPlan.get(plan)?.resolved[itemIndex]?.durationMin ??
noteDurationMin(item.note);
if (endDuration != null && start + endDuration > endCapMin) {
violations.push(
`プラン${plan.slot}「${item.name}」: 終了時刻（${fmtMin(start + endDuration)}＝開始 ${item.timeLabel}＋公式所要時間${endDuration}分）が、このセットの上限（${fmtMin(endCapMin)}＝退園時刻と閉園時刻の早い方）を超えています（営業時間外・クラス4）。開始時刻を前へずらすか、プランから外してください。`,
);
}
}
if (item.kind === "show" || item.kind === "parade") {
const times = showTimesByKey.get(key);
if (times && times.length > 0) {
showCheckedCount++;
if (start == null || !times.includes(start)) {
violations.push(
`プラン${plan.slot}「${item.name}」: 開始時刻（${item.timeLabel?? "なし"}）が、この回に取得した公式の公演時刻（${times.map(fmtMin).join(" / ")}）と一致しません。公式の公演時刻に合わせて直してください。`,
);
}
} else if (!item.unconfirmedReason) {
const showTimeUnverifiedEntry =
`${item.name}の公演時刻：未確認（この回に取得した公式の公演時刻データと照合できなかったため）`;
pushUnverified(showTimeUnverifiedEntry);
pushFactUnverified(showTimeUnverifiedEntry);
}
}
// §9.4: when official performance times DO exist, the branch
// above rejects a mismatching show row even when the row is
// marked unconfirmed — unconfirmed is never an excuse for a
// mismatch (class 5). When NO official time exists (not yet
// published / still 未定）, a row explicitly marked unconfirmed
// is not a class-5 mismatch either: it passes as 未確認， with
// the record entry derived from the row itself (assembled below
// from rowUnconfirmedRecordEntry) instead of the generic line.
}
if (isDpaPass(item.passType)) {
dpaRowCount++;
planDpaRows++;
}
// Purchase-time / sequence checks run on USAGE rows only: a
// purchase-event row's own timeLabel IS the purchase time, and
// entering it here would double the event in the sequence.
if (isDpaPass(item.passType) && item.kind !== "purchase") {
const purchase = parseTime(item.dpaPurchaseTime);
if (purchase == null) {
violations.push(
`プラン${plan.slot}「${item.name}」: DPAの購入時刻（dpaPurchaseTime）が明示されていません。各DPAに購入時刻を入れ、購入列が60分ルールで成立するようにして再保存してください。`,
);
} else if (start != null) {
if (purchase > start) {
violations.push(
`プラン${plan.slot}「${item.name}」: DPAの購入時刻（${item.dpaPurchaseTime}）が利用開始時刻（${item.timeLabel}）より後になっています。`,
);
}
dpaSeq.push({ name: item.name, purchase, use: start});
}
}
}
// DPA eligibility and money are judged per PURCHASE INSTANCE
// (facility × purchase event), not per row. The fact gate:
// eligible + the visit date inside the fact's application
// period passes; not_eligible and out-of-period are class-1
// rejections; unknown rejects the instance and stays on the
// record as 未確認 with its reason; a missing or incomplete
// build rejects every DPA instance. Money: the FACT unit price
// × the purchase row's purchaseCount (the people who actually
// use the facility — owner's ruling, 2026-11-17), counted ONCE
// per instance — a purchase-event
// row and its usage row together still count once, and a unit
// price on a usage row is never counted. A purchase-event
// row's stated unit price that differs from the fact price is
// a class-2 rejection (DPA費用の計上不一致）.
const instances = groupDpaPurchaseInstances(
plan.items,
isDpaPass,
parseTime,
);
for (const inst of instances) {
const verdict = judgeDpaFact(
factGate,
`プラン${plan.slot}「${inst.name}」`,
inst.name,
set.visitDate,
);
if (!verdict.ok) {
violations.push(verdict.violation);
if (verdict.unverified) {
pushUnverified(verdict.unverified);
pushFactUnverified(verdict.unverified);
}
continue;
}
const instCount = dpaInstanceCount(
inst,
partySize,
`プラン${plan.slot}「${inst.name}」`,
);
expectedDpaTotal += verdict.priceJpy * instCount.count;
for (const vtext of instCount.violations) violations.push(vtext);
for (const prow of inst.purchaseRows) {
if (
prow.unitPriceJpy != null &&
prow.unitPriceJpy !== verdict.priceJpy
) {
violations.push(
`プラン${plan.slot}「${inst.name}」: 購入イベント行の単価（${prow.unitPriceJpy.toLocaleString("ja-JP")}円）が、この回の正規化ファクトの単価（${verdict.priceJpy.toLocaleString("ja-JP")}円）と異なります（DPA費用の計上不一致・クラス2）。購入イベント行にはファクト単価をそのまま入れ、使用行には単価を計上しない形で再保存してください。`,
);
}
}
}
// DPA purchase sequence: the next DPA may be bought 60 minutes
// after the previous purchase, or at the previous pass's usage
// start time, whichever is earlier (official rule).
const seq = [...dpaSeq].sort((a, b) => a.purchase - b.purchase);
for (let i = 1; i < seq.length; i++) {
const prevDpa = seq[i - 1];
const curDpa = seq[i];
if (!prevDpa || !curDpa) continue;
const earliest = Math.min(prevDpa.purchase + 60, prevDpa.use);
if (curDpa.purchase < earliest) {
violations.push(
`プラン${plan.slot}: DPAの購入順序が公式ルール（次のDPAは、前の購入から60分後、または前のパスの利用開始時刻の早い方から購入可能）を満たしていません。「${prevDpa.name}」（購入 ${fmtMin(prevDpa.purchase)}／利用開始 ${fmtMin(prevDpa.use)}）の次に買う「${curDpa.name}」は ${fmtMin(earliest)} 以降でなければ買えません（現在の購入時刻 ${fmtMin(curDpa.purchase)}）。購入時刻を直して再保存してください。`,
);
}
}
// DPA money: the breakdown's DPA line(s) must equal the fact
// unit price × each purchase row's purchaseCount counted ONCE
// per purchase instance,
// recomputed here from the fetched facts — a stale price from
// memory, or counting a purchase on both its purchase-event row
// and its usage row, cannot survive this.
const dpaLines = (plan.costBreakdown?? []).filter((l) =>
/DPA|プレミアアクセス/.test(l.label),
);
const dpaLineTotal = dpaLines.reduce(
(sum, l) => sum + (l.amountJpy?? 0),
0,
);
if (planDpaRows > 0) {
if (dpaLines.length === 0) {
violations.push(
`プラン${plan.slot}: DPAを使う項目があるのに、費用内訳にDPAの項目がありません。購入イベントごとに公式単価×対象人数（その購入で実際に利用する人数）で計算したDPA費用を内訳に入れて再保存してください。`,
);
} else if (dpaLines.some((l) => l.amountJpy == null)) {
violations.push(
`プラン${plan.slot}: 費用内訳のDPA項目に金額が入っていません。購入イベントごとに公式単価×対象人数の金額を入れて再保存してください。`,
);
} else if (dpaLineTotal!== expectedDpaTotal) {
violations.push(
`プラン${plan.slot}: DPA費用の内訳（${dpaLineTotal.toLocaleString("ja-JP")}円）が、購入インスタンスごとに正規化ファクトの公式単価×対象人数（購入行の purchaseCount）で再計算した金額（${expectedDpaTotal.toLocaleString("ja-JP")}円）と一致しません（DPA費用の計上不一致・クラス2）。DPAは購入した時に、購入イベント1件につき1回だけ、その施設を実際に利用する人数分だけ計上してください（使用行では計上しません）。ファクトの単価と対象人数で計算し直し、内訳と合計を直して再保存してください。`,
);
}
} else if (dpaLineTotal > 0) {
violations.push(
`プラン${plan.slot}: DPAを使う項目が無いのに、費用内訳にDPA費用（${dpaLineTotal.toLocaleString("ja-JP")}円）が含まれています。`,
);
}
// The breakdown as a whole must add up to the stated total.
const allLines = plan.costBreakdown?? [];
if (
allLines.length > 0 &&
plan.estimatedCostJpy != null &&
allLines.every((l) => l.amountJpy != null)
) {
const sum = allLines.reduce((s, l) => s + (l.amountJpy?? 0), 0);
if (sum!== plan.estimatedCostJpy) {
violations.push(
`プラン${plan.slot}: 費用内訳の合計（${sum.toLocaleString("ja-JP")}円）が、概算費用の総額（${plan.estimatedCostJpy.toLocaleString("ja-JP")}円）と一致しません。内訳か総額を直して再保存してください。`,
);
}
}
// Class 13 — budget correspondence (spec §9.2, revision X): the
// plan's total is machine-compared with the budget recorded in
// THIS set's conditions snapshot. The budget is a soft condition
// — an overrun passes when it is disclosed — so the ONLY refusal
// is over-budget WITHOUT the structured disclosure
// (budgetDisclosure). Sets whose snapshot carries no budget
// (including budget-less same-day sets) are out of scope.
if (
snapshotBudgetJpy != null &&
plan.estimatedCostJpy != null &&
plan.estimatedCostJpy > snapshotBudgetJpy &&
!(plan.budgetDisclosure ?? "").trim()
) {
violations.push(
`プラン${plan.slot}: 費用合計（${plan.estimatedCostJpy.toLocaleString("ja-JP")}円）が、条件の予算（${snapshotBudgetJpy.toLocaleString("ja-JP")}円）を超えているのに、予算超過の開示が提出に含まれていません（予算対応の不一致・クラス13）。予算超過を開示する文面を budgetDisclosure として渡し、同じ開示をプランの説明（summary）にも含めて再保存してください。予算内に収まる場合は、合計が予算以下になるよう組み直してください。`,
);
}
// Class 12 — the ticket line of the breakdown must be costed for
// THIS set's snapshot party (spec §9.2).
violations.push(
...ticketLinePartyViolations(
plan.slot,
plan.costBreakdown,
isSameDaySet && set.sameDayAdults != null
? { adults: set.sameDayAdults, children: set.sameDayChildren ?? 0 }
: (snapshotParty ??
(formParty
? { adults: formParty.adults, children: formParty.children }
: null)),
args.ticketPrices,
),
);
}
if (violations.length > 0) {
// 過程記録： record this attempt's outcome (the gate's classes
// and reasons ride in the violation texts themselves) before the
// refusal propagates; the run stays open for the recovery.
await recordServerRunEvent(ctx, args.planSetId, {
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（検証ゲート）",
detail: violations.slice(0, 10).join("\n- "),
});
throw new Error(
`保存できませんでした。次の問題を直して、もう一度 savePlanSet を呼んでください（失敗報告はしないこと）:\n- ${violations.slice(0, 10).join("\n- ")}`,
);
}

// Verification passed. Assemble the record that stays with the
// set: what was checked, against which official page, and when
// that page was fetched on this run — plus everything that could
// not be verified, which is also appended to the plan notes so it
// is visible wherever the notes are shown (tab and PDF alike).
const fetchedAt =
v.fetchedAt ??
new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo"});
const srcOf = (
s: { title: string; url: string} | null | undefined,
): {
sourceTitle: string | null;
sourceUrl: string | null;
fetchedAt: string;
} => ({
sourceTitle: s? s.title: null,
sourceUrl: s? s.url: null,
fetchedAt,
});
// Row-level unconfirmed elements (§9.4): the record's entries for
// them are DERIVED here from the rows themselves — the row is the
// single source of truth, so the record's wording can never drift
// from the row's reason / explanation. A task-supplied unverified
// entry that restates one of these show-time unconfirmeds is
// dropped: the same unconfirmed must not appear twice in
// different words.
const rowDerivedUnverified: string[] = [];
const rowDerivedShowNames = new Set<string>();
for (const plan of args.plans) {
for (const item of plan.items) {
const entry = rowUnconfirmedRecordEntry(item);
if (entry && !rowDerivedUnverified.includes(entry)) {
rowDerivedUnverified.push(entry);
pushFactUnverified(entry);
}
if (
item.unconfirmedReason &&
(item.kind === "show" || item.kind === "parade")
) {
rowDerivedShowNames.add(item.name);
}
}
}
const unverifiedAll: string[] = [];
for (const u of [
...v.unverified.filter(
(u) =>
!isStaleCoordClaim(u, healedNames) &&
!(
rowDerivedShowNames.size > 0 &&
u.includes("公演時刻") &&
[...rowDerivedShowNames].some((n) => u.includes(n))
),
),
...autoUnverified,
...rowDerivedUnverified,
]) {
if (!unverifiedAll.includes(u)) unverifiedAll.push(u);
}
const travelResultText =
travelLegsTotal === 0
? "移動を伴う区間はありませんでした"
: `全${travelLegsTotal}区間のうち${travelLegsVerified}区間を、座標間の直線距離・歩く速さ「${WALKING_SPEED_LABELS[travelSpeed]}」・距離に応じた迂回乗率・エリア間マトリクスからサーバーが機械計算した移動時間（余裕×1.2込み）で照合し、間隔 ≧ 推定待ち＋公式所要時間＋移動時間 を確認${travelMatrixUsed > 0? `（エリア間マトリクスが距離ベースより大きい値を取った区間: ${travelMatrixUsed}区間）`: ""}${travelLegsTotal - travelLegsVerified > 0? `。残り${travelLegsTotal - travelLegsVerified}区間は座標が引けず未確認（従来の下限で検証し、未確認として記録）`: ""}`;
const periodRecordText = dpaPeriodRecordText(
dpaExtracted,
set.visitDate,
factGate.build != null,
);
const factSummaryText = factGate.summary
? `ファクトビルド #${factGate.build?.id}（母集合${factGate.summary.universeCount}施設：対象${factGate.summary.eligibleCount}／対象外${factGate.summary.notEligibleCount}／不明${factGate.summary.unknownCount}、完全性${factGate.summary.complete ? "あり" : "なし"}）`
: "ファクトビルドなし";
const verificationRecord: z.infer<typeof verificationShape> = {
checkedAt: fetchedAt,
checks: [
{
label: "DPA対象可否",
result: `${
dpaRowCount > 0
? `DPA前提の全${dpaRowCount}行が、正規化ファクトで対象と記録された施設であることを確認（${factSummaryText}）`
: `DPAを使う行はありませんでした（${factSummaryText}）`
}${periodRecordText ? `。${periodRecordText}` : ""}`,
...srcOf(v.dpaSource),
},
{
label: "DPA単価",
result:
dpaRowCount > 0
? `費用内訳のDPA金額が、購入インスタンスごとに正規化ファクトの公式単価×対象人数（購入行の purchaseCount＝その施設を実際に利用する人数）を1回ずつ計上した再計算と一致することを確認（DPA費用は購入した時に計上し、使用行では計上しない）`
: "DPAを使う行はありませんでした",
...srcOf(v.dpaSource),
},
{
label: "休止情報",
result: `全行の施設が、対象日の休止一覧（${v.closedFacilities.length}件）に含まれていないことを確認`,
...srcOf(v.calendarSource),
},
{
label: "営業時間",
result: hoursWindow
? `全行の時刻が営業時間（${args.parkHours}）の範囲内であることを確認`
: "未確認（営業時間を読み取れなかったため）",
...srcOf(v.calendarSource),
},
{
label: "ショー・パレード公演時刻",
result:
showCheckedCount > 0
? `公演時刻を公式データと照合（${showCheckedCount}件）`
: "照合できた公演時刻はありませんでした",
...srcOf(v.entertainmentSource),
},
{
label: "DPA購入順序",
result:
dpaRowCount > 0
? "各DPAの購入時刻を明示し、購入列が公式ルール（購入から60分後、または利用開始時刻の早い方）で成立することを確認"
: "DPAを使う行はありませんでした",
...srcOf(v.dpaSource),
},
{
label: "移動時間",
result: travelResultText,
sourceTitle: travelMatrixSources[0]?.sourceTitle ?? null,
sourceUrl: travelMatrixSources[0]?.sourceUrl ?? null,
fetchedAt: travelMatrixSources[0]?.fetchedAt ?? fetchedAt,
},
...(effectiveCrowdLevel != null
? [
{
label: "混雑予想と待ち時間の係数",
result: `対象日の混雑予想は${effectiveCrowdLevel}／5${effectiveCrowdBasis ? `（${effectiveCrowdBasis}）` : ""}。3プランは混雑シナリオで分けてあり、プランA＝激混み前提（${crowdScenarioLevel(effectiveCrowdLevel, "severe")}／5相当・上限${crowdFactorLabel(crowdFactorCap(crowdScenarioLevel(effectiveCrowdLevel, "severe")))}）、プランB＝やや混み前提（${crowdScenarioLevel(effectiveCrowdLevel, "expected")}／5相当・上限${crowdFactorLabel(crowdFactorCap(crowdScenarioLevel(effectiveCrowdLevel, "expected")))}）、プランC＝思ったより空いてる前提（${crowdScenarioLevel(effectiveCrowdLevel, "light")}／5相当・上限${crowdFactorLabel(crowdFactorCap(crowdScenarioLevel(effectiveCrowdLevel, "light")))}）。保存された推定待ち時間は、材料からの基礎推定に、そのプランのシナリオの係数を掛けた値です。係数は最も混雑の影響を受ける人気施設に対する上限とし、各施設には人気・供給量に応じた実効係数（シナリオ上限以下）を適用しました${args.crowdWaitFactors.length > 0 ? "。プラン別・施設ごとの実効係数はこの記録の「施設ごとの実効係数」のとおりです" : "。ただし、実効係数の内訳はこの回は報告されませんでした"}`,
sourceTitle: null,
sourceUrl: null,
fetchedAt,
},
]
: []),
],
unverified: unverifiedAll,
// The eligible facts (with prices) this verification ran on, in
// the legacy list shape the price displays read. The full record
// of WHAT the DPA checks compared against — every fact with its
// status, period, and grounds — is in dpaFacts below, with the
// build's completeness summary in factSummary.
dpaExtracted: [...dpaExtracted.values()].map((e) => ({
name: e.name,
priceJpy: e.priceJpy,
effectiveFrom: e.effectiveFrom,
effectiveTo: e.effectiveTo,
periodEvidence: e.periodEvidence,
})),
factBuildId: factGate.build ? factGate.build.id : null,
factSummary: factGate.summary,
dpaFacts: factGate.displayFacts,
crowdFactors: args.crowdWaitFactors,
};
let finalNotes: string | null = args.notes?? null;
if (unverifiedAll.length > 0) {
const lines = unverifiedAll.map((u) =>
u.startsWith("未確認")? u: `未確認：${u}`,
);
const base = finalNotes?? "";
const missing = lines.filter((l) => !base.includes(l));
if (missing.length > 0) {
finalNotes = [base, ...missing].filter(Boolean).join("\n");
}
}

// Facility dictionary, consulted at save time as a safety net under
// the task's own dictionary use: items still missing coordinates /
// official URL / area are filled from the dictionary (coordinates
// never expire; the other statics are filled regardless of TTL here
// because a slightly stale link still beats none — freshness governs
// whether the TASK re-fetches, not whether a stored value may be
// shown). What the task itself fetched (present in the payload
// BEFORE this backfill) is recorded into the dictionary afterwards,
// so the next generation reuses it; backfilled values are excluded
// from that recording so a reuse never poses as a fresh fetch.
const dictCache = new Map<string, FacilityRow | undefined>();
const dictFor = async (name: string): Promise<FacilityRow | undefined> => {
const key = facilityNameKey(name);
if (!dictCache.has(key)) {
dictCache.set(key, await findFacility(ctx, set.park, name));
}
return dictCache.get(key);
};
const fetchedByName = new Map<
string,
{ name: string; lat?: number; lng?: number; officialUrl?: string; area?: string}
>();
for (const plan of args.plans) {
for (const item of plan.items) {
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility: nothing about it is recorded into the dictionary.
if (item.kind === "first10") continue;
const key = facilityNameKey(item.name);
const rec =
fetchedByName.get(key)?? { name: item.name};
if (item.lat != null && item.lng != null) {
rec.lat = item.lat;
rec.lng = item.lng;
}
if (item.officialUrl) rec.officialUrl = item.officialUrl;
if (item.area) rec.area = item.area;
fetchedByName.set(key, rec);
}
}

// Replace any prior plans for this set (idempotent re-delivery).
const oldPlans = await db
.select({ id: schema.plans.id})
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
if (oldPlans.length > 0) {
const oldIds = oldPlans.map((p) => p.id);
await db
.delete(schema.planItems)
.where(inArray(schema.planItems.planId, oldIds));
await db.delete(schema.plans).where(inArray(schema.plans.id, oldIds));
}

type SavedItem = {
rowId: number;
name: string;
imageUrl: string | null | undefined;
referenceUrl: string | null | undefined;
};
const savedItems: SavedItem[] = [];
for (const plan of args.plans) {
// The plan's crowd scenario is derived here, deterministically,
// from its slot and the run's forecast — never reported by the
// task — and stamped on the plan row as its premise.
const planScenario = planScenarioFor(
plan.slot,
effectiveCrowdLevel,
set.setType === "same_day",
);
const insertedPlan = await db
.insert(schema.plans)
.values({
planSetId: set.id,
slot: plan.slot,
title: plan.title,
summary: plan.summary?? null,
estimatedCostJpy: plan.estimatedCostJpy?? null,
crowdScenario: planScenario.scenario,
crowdScenarioLevel: planScenario.level,
costBreakdownJson:
plan.costBreakdown && plan.costBreakdown.length > 0
? JSON.stringify(
plan.costBreakdown.map((l) => ({
label: l.label,
amountJpy: l.amountJpy?? null,
note: l.note?? null,
})),
)
: null,
})
.returning({ id: schema.plans.id});
const planRow = insertedPlan[0];
if (!planRow) continue;
// This plan has now actually been saved — only at this moment may
// its per-plan progress become 完了. It is never set on the
// generation task's say-so (updatePlanProgress can only report
// 作成中）, so the displayed state cannot run ahead of reality.
// Saving a plan is also a progress record: refresh the watchdog
// clock together with it.
await db
.update(schema.planSets)
.set(
plan.slot === "A"
? { progressA: "done" as const, progressUpdatedAt: new Date()}
: plan.slot === "B"
? { progressB: "done" as const, progressUpdatedAt: new Date()}
: { progressC: "done" as const, progressUpdatedAt: new Date()},
)
.where(eq(schema.planSets.id, set.id));
for (const [index, item] of plan.items.entries()) {
// Dictionary backfill for anything the payload still lacks: the
// carried-over / dictionary values the task was told to reuse, and
// a safety net when it forgot. The last resort is the save-time
// coordinate resolution's area representative point (tier 2), so a
// facility OSM has no feature for still gets its pin and number.
const dict = await dictFor(item.name);
const hasPair = item.lat != null && item.lng != null;
const fbCoords = coordFallback.get(facilityNameKey(item.name));
// A dictionary pair outside the park's box (legacy row) is not
// stored on the item either (spec §10 park-range check).
const dictInRange =
dict != null &&
dict.lat != null &&
dict.lng != null &&
coordsInParkRange(set.park, dict.lat, dict.lng);
// A purchase-event row is not a place: it never carries
// coordinates (no map pin, no route number), whatever the
// payload or the dictionary holds for its facility. A park-wide
// show's pin is the park's representative point, overriding
// payload and dictionary coordinates alike.
const pwCoords =
item.kind === "purchase" || item.kind === "first10"
? undefined
: coordParkWide.get(facilityNameKey(item.name));
const effLat =
item.kind === "purchase" || item.kind === "first10"
? null
: pwCoords
? pwCoords.lat
: hasPair
? (item.lat as number)
: dictInRange
? (dict.lat as number)
: fbCoords
? fbCoords.lat
: null;
const effLng =
item.kind === "purchase" || item.kind === "first10"
? null
: pwCoords
? pwCoords.lng
: hasPair
? (item.lng as number)
: dictInRange
? (dict.lng as number)
: fbCoords
? fbCoords.lng
: null;
const insertedItem = await db
.insert(schema.planItems)
.values({
planId: planRow.id,
sortOrder: index,
timeLabel: item.timeLabel?? null,
name: item.name,
kind: item.kind,
area: item.area?? dict?.area?? null,
note: item.note?? null,
passType: item.passType?? null,
dpaPurchaseTime: item.dpaPurchaseTime?? null,
unitPriceJpy: item.unitPriceJpy?? null,
// Headcount the purchase is bought for (purchase rows only;
// the gate validated it before this insert runs).
purchaseCount:
item.kind === "purchase" ? (item.purchaseCount ?? null) : null,
estWaitMin: item.estWaitMin?? null,
// The leg INTO this item, computed deterministically above
// (null = unverified leg / first item).
travelMin:
travelByPlan.get(plan)?.legs[index]?.travelMin ?? null,
lat: effLat,
lng: effLng,
officialUrl: item.officialUrl?? dict?.officialUrl?? null,
// Row-level unconfirmed (§9.4), carried by the row itself.
unconfirmedReason: item.unconfirmedReason?.trim()? item.unconfirmedReason: null,
unconfirmedNote: item.unconfirmedNote?.trim()? item.unconfirmedNote: null,
})
.returning({ id: schema.planItems.id});
const itemRow = insertedItem[0];
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility and never enters the photo pass.
if (itemRow && item.kind !== "first10") {
savedItems.push({
rowId: itemRow.id,
name: item.name,
imageUrl: item.imageUrl,
referenceUrl: item.referenceUrl,
});
}
}
}

// Record what this generation actually fetched into the dictionary
// (static attributes only — photos are recorded in the photo pass
// below, once their bytes are actually stored).
for (const rec of fetchedByName.values()) {
await upsertFacilityFromFetch(ctx, set.park, rec);
}

// Intro photos, one download per FACILITY (not per row): the same
// facility appearing in plans A/B/C shares a single download and a
// single blob. A facility whose dictionary photo is still fresh
// reuses the dictionary blob with no download at all. Downloads
// happen after every row is inserted, grouped by facility.
const photoGroups = new Map<string, SavedItem[]>();
for (const si of savedItems) {
const key = facilityNameKey(si.name);
const group = photoGroups.get(key)?? [];
group.push(si);
photoGroups.set(key, group);
}
let anyPhotoHandled = false;
for (const group of photoGroups.values()) {
const first = group[0];
if (!first) continue;
const dict = await dictFor(first.name);
let stored: { key: string; source: "official" | "reference"} | null =
null;
if (
dict &&
dict.imageBlobKey &&
dict.imageSource &&
facilityFreshness(dict, Date.now()).imageFresh
) {
stored = { key: dict.imageBlobKey, source: dict.imageSource};
} else {
// Carry-over from an earlier plan set of the same park (e.g. the
// set this one was rebuilt from): the app already owns this
// facility's photo there, even when the dictionary never recorded
// it. Reuse it — and record it in the dictionary so the gap heals
// for every later generation.
const owned = await findOwnedFacilityPhoto(
ctx,
set.park,
first.name,
set.id,
);
if (owned) {
stored = owned;
await upsertFacilityFromFetch(ctx, set.park, {
name: first.name,
image: { blobKey: owned.key, source: owned.source},
});
}
}
if (!stored) {
const withUrl = group.find((g) => g.imageUrl || g.referenceUrl);
if (withUrl) {
stored = await storeItemImageWithFallback(
ctx,
`plan-items/${first.rowId}`,
withUrl.imageUrl,
withUrl.referenceUrl,
);
if (stored) {
await upsertFacilityFromFetch(ctx, set.park, {
name: first.name,
image: { blobKey: stored.key, source: stored.source},
});
}
}
}
if (stored) {
anyPhotoHandled = true;
for (const si of group) {
await db
.update(schema.planItems)
.set({ imageBlobKey: stored.key, imageSource: stored.source})
.where(eq(schema.planItems.id, si.rowId));
}
} else if (group.some((g) => g.imageUrl || g.referenceUrl)) {
// URLs were supplied and attempted (even if the download failed):
// the photo step for this set is considered handled, matching the
// previous behaviour — the on-demand fetch stays available via
// requestItemImages for anything still missing.
anyPhotoHandled = true;
}
}

// Per-site fetch outcomes become the sites' recorded acquisition
// methods, matched by URL against the registered list.
for (const r of args.waitSourceFetchResults) {
await db
.update(schema.waitTimeSources)
.set({ fetchMethod: r.method})
.where(eq(schema.waitTimeSources.url, r.url));
}

await db
.update(schema.planSets)
.set({
status: "done",
error: null,
// A 当日検索 set has only plan A by design: slots B/C are marked
// done together with it so no surface waits for plans that will
// never exist.
...(isSameDaySet
? { progressB: "done" as const, progressC: "done" as const}
: {}),
// If the generation already supplied intro photos, the image fetch
// for this set is complete; otherwise it stays fetchable on demand.
imagesStatus: anyPhotoHandled? "done": set.imagesStatus,
sourcesJson: JSON.stringify(args.sources),
estimateSourcesJson: JSON.stringify(args.estimateSources),
generationMetricsJson: args.metrics
? JSON.stringify({
pagesOpened: args.metrics.pagesOpened?? null,
phases: args.metrics.phases?? [],
})
: null,
progressUpdatedAt: new Date(),
notes: finalNotes,
verificationJson: JSON.stringify(verificationRecord),
// A fresh set's last-verified instant IS the moment this
// save-time verification passed — the actual clock time of
// this save, NOT a date derived from the record's checkedAt
// (which is a fetch DATE only; turning it into noon of that
// day made lastVerifiedAt a fixed value that matched no real
// verification instant — T96). Bulk re-verifications advance
// it from here.
lastVerifiedAt: new Date(),
// This run's DPA page material, stored verbatim as the run's raw
// record. It judges nothing — the DPA gate ran on the normalized
// facts of the build named here.
dpaSnapshotText: dpaSnapshotText.trim()? dpaSnapshotText: null,
factBuildId: args.factBuildId ?? null,
// The crowd forecast premise of this set (level + basis).
// Stored on the set itself — not in the notes — so the premise
// display and the PDF read it as data. When the date already
// had a decided forecast, this is the HELD one (reused, with
// the trace in the basis), not this run's re-evaluation. Null
// when no forecast exists for the date.
crowdLevel: effectiveCrowdLevel,
crowdBasis: effectiveCrowdBasis,
parkHours: args.parkHours?? null,
completedAt: new Date(),
})
.where(eq(schema.planSets.id, set.id));
// Completion is always announced in the TAB1 chat with one line, so
// the user can tell the work is done without hunting for the new tab
// (the chat AI's own "作成を開始しました" promise is otherwise
// unverifiable from the chat). Only on the transition INTO done: an
// idempotent re-delivery (status already "done") must not post the
// line twice. The line names the conditions the set was actually
// created under (from its stored snapshot), so a completion can
// never silently belong to different conditions than the user asked
// for.
if (set.status!== "done") {
// When this run could not confirm facts the app's premises rest
// on (an incomplete fact build, DPA / hours / show-time facts
// left 未確認）, the completion line itself carries the repair
// guidance — the detection moment is where the owner looks, not
// the help tab. A clean run's line stays exactly as before.
const completionText =
set.setType === "same_day"
? `当日検索が終わりました。「${set.title}」の新しいタブに、${set.sameDayStartTime ?? ""}から閉園までのプランが表示されています。（対象条件: ${setConditionsSummary(set)}）`
: set.rebuiltFromSetId != null
? `作り直しが終わりました。「${set.title}」の新しいタブに作り直し版のプランA・B・Cが表示されています。元のプランはそのまま残っています。（対象条件: ${setConditionsSummary(set)}）`
: `プランの作成が終わりました。「${set.title}」の新しいタブに、プランA・B・Cが表示されています。（対象条件: ${setConditionsSummary(set)}）`;
await db.insert(schema.messages).values({
role: "assistant",
// A rebuild's completion is announced as a rebuild: the new tab
// holds the 作り直し版 and the original plan is still there —
// the same wording as the acceptance reply, so what was promised
// and what happened stay identical end to end.
text: factsUnconfirmed(factGate, factUnverified)
? `${completionText}\nなお、この回では現在の仕様に関わる項目に確認できなかったものがあります。${SPEC_REPAIR_GUIDANCE}`
: completionText,
});
}
// 過程記録： the save succeeded — end the save/verify phase and
// close the run as succeeded.
await recordServerRunEvent(ctx, args.planSetId, {
eventType: "phase_end",
phase: "save_verify",
label: "保存・検証の終了（savePlanSet）",
});
await closeOpenRunLog(ctx, args.planSetId, "succeeded", null, null, "finished");
ctx.invalidateQueries();
return { ok: true};
},
}),

savePlanReplacement: defineAction({
description:
"Internal: called by the partial-replacement task to swap ONE plan (slot A/B/C) inside an existing finished plan set, after a chat-decided change targeted that plan (e.g. add Center of the Earth to plan B). The other two plans' rows are never touched. A class-11 minimum-content floor runs first (same floor as savePlanSet, including the 2026-11-15 substantive floors: at least 6 content rows for a standard set's plan, a summary of real substance, no test/placeholder title patterns, and a cost total at or above the party's ticket cost at the official unit prices carried as `ticketPrices` and machine-checked against the stored ticket_prices snapshot; plus park/date correspondence with the set's stored conditions snapshot, DPA money recomputed against the snapshot's party): a floor failure stores nothing, keeps the original plan untouched, records the class-11 refusal in the set's verification record, marks the slot failed, and announces it in the chat. Before anything is stored, the replacement plan is verified exactly like a full generation: every attraction needs an estimated wait and the schedule must not contradict its estimates, and the rows are cross-checked against the official data fetched on THIS run — DPA eligibility, unit prices and application periods judged ONLY by the normalized facts of the fact build named by `factBuildId`, with DPA cost counted at purchase (once per purchase instance at the fact unit price × the purchase row's purchaseCount — the headcount that actually uses the facility, owner's ruling 2026-11-17 — never on usage rows; a purchase row's stated price differing from the fact price, or a purchaseCount missing / below 1 / above the party size, is a class-2 refusal), plus closures, park hours, show times, and the DPA purchase sequence. Park hours are checked on BOTH ends (class 4): a row with a known official duration (dictionary durationMin, else the note's 「所要約◯分」) ending past the earlier of the snapshot's exit time and the closing time is refused. BUDGET CORRESPONDENCE (class 13): a replacement total over the snapshot budget without a `budgetDisclosure` is refused; a disclosed overrun passes. COORDINATES (spec §10): item coordinates outside the park's bounding box are treated as no coordinates and recorded 未確認 with the reason. Travel time between consecutive items is computed by the server itself (coordinates + the set's walking speed + detour factor + area-matrix max, ×1.2 margin) and stored per item as travelMin; a gap smaller than wait + official duration + travelMin is refused the same way, and an unresolvable leg is recorded 未確認 and checked against the legacy wait + 10 floor. A failing payload is refused with the problems listed; the task fixes and re-saves. On success the set's verification record gains an entry stating this was a partial replacement (slot, date, change content), the slot's progress becomes 完了， and the completion is announced in the chat.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
// The normalized-fact build this run constructed (see
// savePlanSet). The DPA gate judges ONLY this build's facts.
factBuildId: z.number().nullable().optional(),
// The ticket-price basis for the class-11 cost floor (g), same
// contract as savePlanSet: official unit prices for the visit
// date, machine-checked against the stored ticket_prices
// snapshot named here. Required for standard sets.
ticketPrices: ticketPricesShape.nullable().optional(),
changeNote: z.string().min(1).max(1000),
// Per-facility EFFECTIVE crowd factors this replacement applied
// to the replaced plan's waits, under the set's stored crowd
// premise (each at or below the level's cap). Merged into the
// verification record's crowdFactors, replacing the entries for
// the replaced plan's facilities.
crowdWaitFactors: z
.array(
z.object({
name: z.string().max(200),
factor: z.number().min(0).max(10),
}),
)
.max(80)
.default([]),
parkHours: z.string().nullable().optional(),
sources: z
.array(z.object({ title: z.string(), url: z.string()}))
.max(20)
.default([]),
estimateSources: z
.array(
z.object({
title: z.string(),
url: z.string(),
fetchedAt: z.string().nullable().optional(),
}),
)
.max(20)
.default([]),
waitSourceFetchResults: z
.array(
z.object({
url: z.string().max(2000),
method: z.enum(["script", "browser", "failed"]),
}),
)
.max(30)
.default([]),
verification: z.object({
fetchedAt: z.string().max(40).nullable().optional(),
dpaSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
calendarSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
entertainmentSource: z
.object({ title: z.string().max(300), url: z.string().max(2000)})
.nullable()
.optional(),
dpaSnapshotText: z.string().max(500000).nullable().optional(),
closedFacilities: z.array(z.string().max(200)).max(120).default([]),
showTimes: z
.array(
z.object({
name: z.string().max(200),
times: z.array(z.string().max(10)).max(12),
}),
)
.max(80)
.default([]),
unverified: z.array(z.string().max(300)).max(30).default([]),
}),
plan: z.object({
title: z.string().min(1),
summary: z.string().nullable().optional(),
estimatedCostJpy: z.number().nullable().optional(),
// Budget-overrun disclosure (class 13, spec §9.2): same
// contract as savePlanSet — required when the replacement
// plan's total exceeds the budget in the set's conditions
// snapshot; an undisclosed overrun is refused as class 13.
budgetDisclosure: z.string().max(1000).nullable().optional(),
costBreakdown: z
.array(
z.object({
label: z.string().min(1),
amountJpy: z.number().nullable().optional(),
note: z.string().nullable().optional(),
}),
)
.max(12)
.optional(),
items: z
.array(
z.object({
timeLabel: z.string().nullable().optional(),
name: z.string().min(1),
kind: kindEnum.default("other"),
area: z.string().nullable().optional(),
note: z.string().nullable().optional(),
passType: z.string().nullable().optional(),
dpaPurchaseTime: z.string().max(10).nullable().optional(),
// Unit price on a purchase-event row (kind = "purchase");
// same purchase-instance counting as savePlanSet.
unitPriceJpy: z.number().int().min(0).max(100000).nullable().optional(),
// Headcount (対象人数） on a purchase-event row, same rule
// as savePlanSet (owner's ruling, 2026-11-17): required on
// every purchase row; the gate counts fact unit price × this
// count and refuses a missing / below-1 / over-party count as
// class 2.
purchaseCount: z.number().int().min(0).max(10000).nullable().optional(),
estWaitMin: z.number().int().min(0).max(600).nullable().optional(),
// Row-level unconfirmed element (§9.4), same contract as
// savePlanSet: short reason + explanation for a value placed as
// an assumption (e.g. the assumed usage time band of a
// substitute DPA under §14). Both null for confirmed rows.
unconfirmedReason: z.string().max(80).nullable().optional(),
unconfirmedNote: z.string().max(600).nullable().optional(),
lat: z.number().nullable().optional(),
lng: z.number().nullable().optional(),
imageUrl: z.string().max(2000).nullable().optional(),
referenceUrl: z.string().max(2000).nullable().optional(),
officialUrl: z.string().max(2000).nullable().optional(),
}),
)
.max(40),
}),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) {
throw new Error(`savePlanReplacement: plan set ${args.planSetId} not found`);
}
// 過程記録： EVERY save attempt is bracketed by the server itself,
// like savePlanSet — this phase_start IS the attempt's start, and
// every exit records the attempt's outcome (success phase_end, or
// a note with the refusal's class and reason). A refusal never
// closes the run; it closes only at the task's true end.
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "phase_start",
phase: "save_verify",
label: "保存・検証の開始（savePlanReplacement）",
},
args.slot,
);
if (set.status!== "done") {
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（対象セットが完了状態ではない）",
detail: `savePlanReplacement: plan set ${args.planSetId} is not a finished set`,
},
args.slot,
);
throw new Error(
`savePlanReplacement: plan set ${args.planSetId} is not a finished set`,
);
}
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const planRow = planRows.find((p) => p.slot === args.slot);
if (!planRow) {
// 過程記録： record this attempt's outcome before the refusal
// propagates (the run stays open; see savePlanSet).
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（対象プランが存在しない）",
detail: `savePlanReplacement: plan ${args.slot} not found in set ${args.planSetId}`,
},
args.slot,
);
throw new Error(
`savePlanReplacement: plan ${args.slot} not found in set ${args.planSetId}`,
);
}
// The swap is accepted only while this slot's replacement is
// actually in flight （作成中, or 失敗 after a class-11 floor refusal
// within the same operation, which the task may fix and re-save).
// A slot standing at 完了 means the operation is over — completed,
// failed-and-reported, stood down by the dead-task guard, or
// CANCELLED by the user from the generating view: a late save from
// a task that was presumed dead must not land after the user
// already escaped the stuck state.
const slotProgressNow =
args.slot === "A"
? set.progressA
: args.slot === "B"
? set.progressB
: set.progressC;
if (slotProgressNow === "done") {
// 過程記録： record this attempt's outcome before the refusal
// propagates (the run stays open; see savePlanSet).
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（差し替えが進行中ではない）",
detail: `savePlanReplacement: プラン${args.slot}の差し替えは進行中ではありません（取り消されたか、既に終了しています）。この保存は受け付けられません。`,
},
args.slot,
);
throw new Error(
`savePlanReplacement: プラン${args.slot}の差し替えは進行中ではありません（取り消されたか、既に終了しています）。この保存は受け付けられません。`,
);
}
const plan = args.plan;
const slot = args.slot;

// Restaurant waits are not modeled (owner design, 記録AD):
// normalize server-side before every gate and before storage,
// exactly as in savePlanSet — a restaurant row's estWaitMin is
// dropped to null (replace, don't reject).
for (const item of plan.items) {
if (item.kind === "restaurant") item.estWaitMin = null;
}

// Park-range check on payload coordinates (spec §10), same as
// savePlanSet: an out-of-box pair is treated as NO coordinates
// from here on and recorded 未確認 with the reason.
const outOfRangeCoordNames: string[] = [];
for (const item of plan.items) {
if (
item.lat != null &&
item.lng != null &&
!coordsInParkRange(set.park, item.lat, item.lng)
) {
item.lat = null;
item.lng = null;
if (!outOfRangeCoordNames.includes(item.name)) {
outOfRangeCoordNames.push(item.name);
}
}
}

// ---------- class 11: minimum plan content （プランの最低内容） ----------
// Same floor as savePlanSet, scoped to the one replaced plan. A
// floor failure stores nothing: the existing plan stays exactly as
// it was, the refusal is recorded in the set's verification record
// as class 11, the slot's progress becomes 失敗， and the failure
// is announced in the chat (never a completion line).
// Substantive floors (2026-11-15), same as savePlanSet: the
// ticket-cost floor's basis is machine-checked against the
// stored ticket_prices snapshot, and a standard set's plan
// carries the content-row floor. Same-day sets keep the formal
// floor only.
const replacementTicketFloor = await resolveTicketFloor(
ctx,
set,
args.ticketPrices,
);
const replacementFloorViolations = [
...snapshotCorrespondenceViolations(set),
...replacementTicketFloor.violations,
...planFloorViolations(
[{ ...plan, slot }],
set.setType === "same_day"
? {}
: {
contentRowFloor: CONTENT_ROW_FLOOR,
ticketFloorJpy: replacementTicketFloor.floorJpy,
ticketFloorBasis: replacementTicketFloor.basis,
},
),
];
if (replacementFloorViolations.length > 0) {
const reason = `プランの最低内容を満たしていません（クラス11：プランの最低内容不足）。${replacementFloorViolations.join("／")}`;
const existingRecord = parseVerificationJson(set.verificationJson);
const floorEntry = {
label: `プラン${slot}の差し替え拒否（クラス11）`,
result: replacementFloorViolations.join("／"),
sourceTitle: null,
sourceUrl: null,
fetchedAt: new Date().toLocaleDateString("ja-JP", {
timeZone: "Asia/Tokyo",
}),
};
const record: z.infer<typeof verificationShape> = existingRecord
? { ...existingRecord, checks: [...existingRecord.checks, floorEntry]}
: {
checkedAt: floorEntry.fetchedAt,
checks: [floorEntry],
unverified: [],
dpaExtracted: [],
factBuildId: null,
factSummary: null,
dpaFacts: [],
crowdFactors: [],
};
await db
.update(schema.planSets)
.set(
slot === "A"
? {
progressA: "failed" as const,
verificationJson: JSON.stringify(record),
pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null),
}
: slot === "B"
? {
progressB: "failed" as const,
verificationJson: JSON.stringify(record),
pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null),
}
: {
progressC: "failed" as const,
verificationJson: JSON.stringify(record),
pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null),
},
)
.where(eq(schema.planSets.id, set.id));
await db.insert(schema.messages).values({
role: "assistant",
text: `「${set.title}」のプラン${slot}の差し替えは保存されませんでした。（対象条件: ${setConditionsSummary(set)}／理由: ${reason}）元のプラン${slot}はそのまま残っています。\n${SPEC_REPAIR_GUIDANCE}`,
});
// 過程記録： a class-11 refusal within a partial replacement is
// NOT terminal (the task may fix and re-save in this operation),
// so the run stays open; the refusal itself goes on the trail.
await recordServerRunEvent(
ctx,
set.id,
{
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（クラス11：プランの最低内容不足）",
detail: reason,
},
slot,
);
ctx.invalidateQueries();
throw new Error(
`保存できませんでした。${reason} 元のプラン${slot}は変更されていません。最低内容を満たすプランを作れない場合は、reportPlanReplacementFailure で理由を報告してください。`,
);
}

// ---------- travel-time preparation （移動時間） ----------
// Same deterministic computation as savePlanSet, scoped to the one
// replaced plan: effective coordinates / area / duration from the
// payload + facility dictionary, legs computed with the SET's
// snapshotted walking speed (falling back to the current form
// value for sets created before the snapshot existed).
const travelConditions = await loadConditions(ctx);
const travelSpeed: WalkingSpeed =
set.walkingSpeed ?? travelConditions.walkingSpeed;
const areaMatrix = await loadAreaMatrix(ctx, set.park);
const travelDictCache = new Map<string, FacilityRow | undefined>();
const travelDictFor = async (
name: string,
): Promise<FacilityRow | undefined> => {
const key = facilityNameKey(name);
if (!travelDictCache.has(key)) {
travelDictCache.set(key, await findFacility(ctx, set.park, name));
}
return travelDictCache.get(key);
};
// Save-time coordinate resolution （座標の安全網）: same as
// savePlanSet, scoped to the replaced plan. This is the path that
// saved a newly added facility （センター・オブ・ジ・アース）
// coordinate-less — no pin, no route number — when the task's own
// Nominatim attempt missed. Tier-1 heals land in the dictionary
// before the caches below fill; tier-2 area points come back in
// coordFallback.
const {
fallback: coordFallback,
parkWide: coordParkWide,
notices: coordAreaNotices,
// Display-only 「最初の10分」 rows (kind "first10") never enter
// coordinate resolution (they are not facilities).
} = await buildCoordFallback(
ctx,
set.park,
[plan.items.filter((it) => it.kind !== "first10")],
);
const resolvedItems: ResolvedItem[] = [];
for (const item of plan.items) {
const dict = await travelDictFor(item.name);
const hasPair = item.lat != null && item.lng != null;
// A dictionary pair outside the park's box (legacy row) is not
// used (spec §10).
const dictPair =
dict?.lat != null &&
dict?.lng != null &&
coordsInParkRange(set.park, dict.lat, dict.lng)
? { lat: dict.lat, lng: dict.lng }
: null;
// A park-wide show's pin is the park's representative point,
// overriding payload and dictionary coordinates alike (see the
// park-wide section above); purchase rows are not places.
const pwPoint =
item.kind === "purchase" || item.kind === "first10"
? undefined
: coordParkWide.get(facilityNameKey(item.name));
resolvedItems.push({
name: item.name,
kind: item.kind,
lat: pwPoint
? pwPoint.lat
: hasPair
? (item.lat as number)
: dictPair?.lat??
coordFallback.get(facilityNameKey(item.name))?.lat??
null,
lng: pwPoint
? pwPoint.lng
: hasPair
? (item.lng as number)
: dictPair?.lng??
coordFallback.get(facilityNameKey(item.name))?.lng??
null,
area: item.area?? dict?.area?? null,
durationMin: dict?.durationMin?? null,
});
}
const planLegs = computeLegs(resolvedItems, travelSpeed, areaMatrix);
let travelLegsTotal = 0;
let travelLegsVerified = 0;
let travelMatrixUsed = 0;
const travelMatrixSources: AreaMatrixEntry[] = [];
const travelUnverifiedLegs: string[] = [];
planLegs.forEach((leg, i) => {
if (i === 0 || !leg) return;
// A purchase-event row's zero pass-through leg is not a travel
// leg and never counts toward the totals. The display-only
// 「最初の10分」 row's pass-through leg is the same.
if (
resolvedItems[i]?.kind === "purchase" ||
resolvedItems[i]?.kind === "first10"
) return;
travelLegsTotal++;
if (leg.travelMin != null) {
travelLegsVerified++;
if (leg.matrixUsed) {
travelMatrixUsed++;
if (
leg.matrixEntry &&
!travelMatrixSources.includes(leg.matrixEntry)
) {
travelMatrixSources.push(leg.matrixEntry);
}
}
} else {
const from = resolvedItems[i - 1];
const to = resolvedItems[i];
if (from && to) {
const label = `${from.name}→${to.name}`;
if (!travelUnverifiedLegs.includes(label)) {
travelUnverifiedLegs.push(label);
}
}
}
});

// --- deterministic wait/schedule validation (same rules as savePlanSet)
const violations: string[] = [];
const parseTime = (label: string | null | undefined): number | null => {
if (!label) return null;
const m = /^(\d{1,2}):(\d{2})/.exec(label.trim());
if (!m) return null;
return Number(m[1]) * 60 + Number(m[2]);
};
type TimedItem = (typeof plan.items)[number];
let prev: { item: TimedItem; start: number; index: number} | null = null;
for (const [itemIndex, item] of plan.items.entries()) {
// Purchase-event rows are transparent to the schedule
// arithmetic, exactly as in savePlanSet. The display-only
// 「最初の10分」 row (kind "first10") is transparent the same way.
if (item.kind === "purchase" || item.kind === "first10") continue;
if (item.kind === "attraction" && item.estWaitMin == null) {
violations.push(
`プラン${slot}「${item.name}」: アトラクションに推定待ち時間（estWaitMin）がありません。0分でも必ず入れてください。`,
);
}
const start = parseTime(item.timeLabel);
if (prev && start != null && prev.item.estWaitMin != null) {
// Restaurant waits are not modeled (owner design: prepared in
// advance). Restaurant rows were normalized to a null wait
// above, so this is belt-and-braces: a restaurant row's wait
// would contribute 0 to the gap arithmetic, never its value.
const prevWait =
prev.item.kind === "restaurant" ? 0 : prev.item.estWaitMin;
const gap = start - prev.start;
const travel = gapTravelMin(planLegs, prev.index, itemIndex);
if (travel != null) {
const duration = resolvedItems[prev.index]?.durationMin ?? null;
const need = prevWait + (duration ?? 0) + travel;
const flooredNeed =
duration == null
? Math.max(need, prevWait + 10)
: need;
if (gap < flooredNeed) {
violations.push(
`プラン${slot}「${prev.item.name}」: 推定待ち${prevWait}分＋体験時間${duration != null? `${duration}分`: "（公式所要時間が辞書に無いため0分として計算）"}＋移動時間${travel}分（サーバーが座標・歩く速さ・エリア間マトリクスから計算した travel_min）に対し、次の「${item.name}」まで${gap}分しかありません（最低${flooredNeed}分必要）。次の項目の時刻を後ろへずらしてください。`,
);
}
} else {
const need = prevWait + 10;
if (gap < need) {
violations.push(
`プラン${slot}「${prev.item.name}」: 推定待ち${prevWait}分に対し、次の「${item.name}」まで${gap}分しかありません（待ち時間＋体験・移動・余裕として最低${need}分必要）。次の項目の時刻を後ろへずらしてください。`,
);
}
}
}
if (start != null) prev = { item, start, index: itemIndex};
}

// --- pre-completion verification against THIS run's fetched official
// data (same cross-check as savePlanSet, scoped to the one plan).
const v = args.verification;
const fmtMin = (min: number): string =>
`${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
const isDpaPass = (passType: string | null | undefined): boolean =>
passType != null && /プレミアアクセス|DPA/i.test(passType);
// DPA eligibility, unit prices and application periods come ONLY
// from the normalized facts of the fact build this run constructed
// (args.factBuildId) — never from text extraction over a snapshot
// and never from a list the task wrote. A missing or incomplete
// build refuses every DPA row (judgeDpaFact), at the same strength
// as the old no-snapshot rule. The run's raw DPA page text is still
// accepted and stored on the set as material, but it judges
// nothing.
const factGate = await loadDpaFactGate(ctx, args.factBuildId, set.park);
const dpaExtracted = factGate.eligibleEntries;
const closedKeys = new Set(
v.closedFacilities.map((n) => facilityNameKey(n)),
);
const showTimesByKey = new Map(
v.showTimes.map(
(s) =>
[
facilityNameKey(s.name),
s.times
.map((t) => parseTime(t))
.filter((t): t is number => t != null),
] as const,
),
);
// DPA money is recomputed against the party in THIS set's
// conditions snapshot (the conditions the set was created under),
// never the live form — same rule as savePlanSet. The form is only
// the legacy fallback for a snapshot with no party line.
const snapshotParty = parseSnapshotParty(set.conditionsSnapshot);
const formParty = snapshotParty ? null : await loadConditions(ctx);
const partySize = snapshotParty
? snapshotParty.adults + snapshotParty.children
: (formParty?.adults ?? 0) + (formParty?.children ?? 0);
let hoursWindow: { open: number; close: number} | null = null;
const hoursText = args.parkHours?? set.parkHours;
if (hoursText) {
const hm = /(\d{1,2}):(\d{2})\s*[～~\-–−]\s*(\d{1,2}):(\d{2})/.exec(
hoursText,
);
if (hm) {
hoursWindow = {
open: Number(hm[1]) * 60 + Number(hm[2]),
close: Number(hm[3]) * 60 + Number(hm[4]),
};
}
}
// Class 4, END side (spec §9.2, revision X), same rule as
// savePlanSet: the cap is the earlier of the conditions
// snapshot's exit time and the closing time; either one alone
// when the other cannot be read. The snapshot's budget feeds
// the class-13 check below.
const snapshotConditions = parseSnapshotConditions(set).conditions;
const snapshotExitMin = parseTime(snapshotConditions.exitTime);
let endCapMin: number | null = null;
if (hoursWindow && snapshotExitMin != null) {
endCapMin = Math.min(snapshotExitMin, hoursWindow.close);
} else if (hoursWindow) {
endCapMin = hoursWindow.close;
} else if (snapshotExitMin != null) {
endCapMin = snapshotExitMin;
}
const snapshotBudgetJpy = snapshotConditions.budgetJpy;
const autoUnverified: string[] = [];
const pushUnverified = (s: string): void => {
if (!autoUnverified.includes(s)) autoUnverified.push(s);
};
// Fact-origin unverified entries only (see factsUnconfirmed):
// collected alongside autoUnverified at the fact-derived push
// sites below. Travel-leg and coordinate entries are a different
// classification and never join this list.
const factUnverified: string[] = [];
const pushFactUnverified = (s: string): void => {
if (!factUnverified.includes(s)) factUnverified.push(s);
};
if (!hoursWindow) {
const hoursUnverifiedEntry =
"営業時間：未確認（対象日の営業時間を、この回の取得データから読み取れなかったため）";
pushUnverified(hoursUnverifiedEntry);
pushFactUnverified(hoursUnverifiedEntry);
}
for (const u of factGateLevelUnverified(factGate)) {
pushUnverified(u);
pushFactUnverified(u);
}
for (const legLabel of travelUnverifiedLegs.slice(0, 5)) {
pushUnverified(
`移動時間（${legLabel}）：未確認（どちらかの施設の座標が、プランの項目からも施設辞書からも引けなかったため。その区間は従来の下限＝推定待ち＋10分で検証しました）`,
);
}
if (travelUnverifiedLegs.length > 5) {
pushUnverified(
`移動時間：ほか${travelUnverifiedLegs.length - 5}区間も座標が引けず未確認（従来の下限で検証）`,
);
}
for (const n of coordAreaNotices) pushUnverified(n);
for (const n of outOfRangeCoordNames) {
pushUnverified(
`座標（${n}）：パーク範囲外のため未確認（提出された座標が${parkName(set.park)}の範囲外だったため、座標なしとして扱いました）`,
);
}
// Facilities that ended up WITH coordinates: task-supplied 未確認
// entries claiming such a facility is coordinate-less are stale.
const healedNames: string[] = [];
for (const r of resolvedItems) {
if (
r.lat != null &&
r.lng != null &&
!healedNames.includes(r.name)
) {
healedNames.push(r.name);
}
}
let dpaRowCount = 0;
let showCheckedCount = 0;
let expectedDpaTotal = 0;
let planDpaRows = 0;
const dpaSeq: { name: string; purchase: number; use: number}[] = [];
for (const [itemIndex, item] of plan.items.entries()) {
const key = facilityNameKey(item.name);
const start = parseTime(item.timeLabel);
// Facility-level checks run on real stops only, exactly as in
// savePlanSet (the usage row carries them for its facility).
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility and is outside these checks too.
if (item.kind !== "purchase" && item.kind !== "first10") {
if (closedKeys.has(key)) {
violations.push(
`プラン${slot}「${item.name}」: この回に取得した対象日の休止一覧に載っている施設です。プランから外してください。`,
);
}
if (
hoursWindow &&
start != null &&
(start < hoursWindow.open || start > hoursWindow.close)
) {
violations.push(
`プラン${slot}「${item.name}」: 開始時刻（${item.timeLabel}）が対象日の営業時間（${fmtMin(hoursWindow.open)}〜${fmtMin(hoursWindow.close)}）の範囲外です。`,
);
}
// Class 4, END side, same rule as savePlanSet: start +
// official duration (dictionary, else the note's 「所要約◯分」)
// must not pass the set's cap; ending exactly at it is inside.
if (endCapMin != null && start != null) {
const endDuration =
resolvedItems[itemIndex]?.durationMin ?? noteDurationMin(item.note);
if (endDuration != null && start + endDuration > endCapMin) {
violations.push(
`プラン${slot}「${item.name}」: 終了時刻（${fmtMin(start + endDuration)}＝開始 ${item.timeLabel}＋公式所要時間${endDuration}分）が、このセットの上限（${fmtMin(endCapMin)}＝退園時刻と閉園時刻の早い方）を超えています（営業時間外・クラス4）。開始時刻を前へずらすか、プランから外してください。`,
);
}
}
if (item.kind === "show" || item.kind === "parade") {
const times = showTimesByKey.get(key);
if (times && times.length > 0) {
showCheckedCount++;
if (start == null || !times.includes(start)) {
violations.push(
`プラン${slot}「${item.name}」: 開始時刻（${item.timeLabel?? "なし"}）が、この回に取得した公式の公演時刻（${times.map(fmtMin).join(" / ")}）と一致しません。公式の公演時刻に合わせて直してください。`,
);
}
} else if (!item.unconfirmedReason) {
const showTimeUnverifiedEntry =
`${item.name}の公演時刻：未確認（この回に取得した公式の公演時刻データと照合できなかったため）`;
pushUnverified(showTimeUnverifiedEntry);
pushFactUnverified(showTimeUnverifiedEntry);
}
}
// §9.4, same rule as savePlanSet: an existing official time
// rejects a mismatching row even when marked unconfirmed
// (class 5); with no official time to mismatch, a row marked
// unconfirmed passes as 未確認 with the record entry derived
// from the row itself (assembled below).
}
if (isDpaPass(item.passType)) {
dpaRowCount++;
planDpaRows++;
}
// Purchase-time / sequence checks run on USAGE rows only, as
// in savePlanSet.
if (isDpaPass(item.passType) && item.kind !== "purchase") {
const purchase = parseTime(item.dpaPurchaseTime);
if (purchase == null) {
violations.push(
`プラン${slot}「${item.name}」: DPAの購入時刻（dpaPurchaseTime）が明示されていません。各DPAに購入時刻を入れ、購入列が60分ルールで成立するようにして再保存してください。`,
);
} else if (start != null) {
if (purchase > start) {
violations.push(
`プラン${slot}「${item.name}」: DPAの購入時刻（${item.dpaPurchaseTime}）が利用開始時刻（${item.timeLabel}）より後になっています。`,
);
}
dpaSeq.push({ name: item.name, purchase, use: start});
}
}
}
// DPA eligibility and money per PURCHASE INSTANCE, exactly as
// in savePlanSet: judged ONLY by this run's normalized-fact
// build; the fact price × the purchase row's purchaseCount
// (the people who actually use the facility) counted once per
// instance; a purchase-event row's stated price differing from
// the fact price is a class-2 rejection.
const instances = groupDpaPurchaseInstances(
plan.items,
isDpaPass,
parseTime,
);
for (const inst of instances) {
const verdict = judgeDpaFact(
factGate,
`プラン${slot}「${inst.name}」`,
inst.name,
set.visitDate,
);
if (!verdict.ok) {
violations.push(verdict.violation);
if (verdict.unverified) {
pushUnverified(verdict.unverified);
pushFactUnverified(verdict.unverified);
}
continue;
}
const instCount = dpaInstanceCount(
inst,
partySize,
`プラン${slot}「${inst.name}」`,
);
expectedDpaTotal += verdict.priceJpy * instCount.count;
for (const vtext of instCount.violations) violations.push(vtext);
for (const prow of inst.purchaseRows) {
if (
prow.unitPriceJpy != null &&
prow.unitPriceJpy !== verdict.priceJpy
) {
violations.push(
`プラン${slot}「${inst.name}」: 購入イベント行の単価（${prow.unitPriceJpy.toLocaleString("ja-JP")}円）が、この回の正規化ファクトの単価（${verdict.priceJpy.toLocaleString("ja-JP")}円）と異なります（DPA費用の計上不一致・クラス2）。購入イベント行にはファクト単価をそのまま入れ、使用行には単価を計上しない形で再保存してください。`,
);
}
}
}
const seq = [...dpaSeq].sort((a, b) => a.purchase - b.purchase);
for (let i = 1; i < seq.length; i++) {
const prevDpa = seq[i - 1];
const curDpa = seq[i];
if (!prevDpa || !curDpa) continue;
const earliest = Math.min(prevDpa.purchase + 60, prevDpa.use);
if (curDpa.purchase < earliest) {
violations.push(
`プラン${slot}: DPAの購入順序が公式ルール（次のDPAは、前の購入から60分後、または前のパスの利用開始時刻の早い方から購入可能）を満たしていません。「${prevDpa.name}」（購入 ${fmtMin(prevDpa.purchase)}／利用開始 ${fmtMin(prevDpa.use)}）の次に買う「${curDpa.name}」は ${fmtMin(earliest)} 以降でなければ買えません（現在の購入時刻 ${fmtMin(curDpa.purchase)}）。購入時刻を直して再保存してください。`,
);
}
}
const dpaLines = (plan.costBreakdown?? []).filter((l) =>
/DPA|プレミアアクセス/.test(l.label),
);
const dpaLineTotal = dpaLines.reduce(
(sum, l) => sum + (l.amountJpy?? 0),
0,
);
if (planDpaRows > 0) {
if (dpaLines.length === 0) {
violations.push(
`プラン${slot}: DPAを使う項目があるのに、費用内訳にDPAの項目がありません。購入イベントごとに公式単価×対象人数（その購入で実際に利用する人数）で計算したDPA費用を内訳に入れて再保存してください。`,
);
} else if (dpaLines.some((l) => l.amountJpy == null)) {
violations.push(
`プラン${slot}: 費用内訳のDPA項目に金額が入っていません。購入イベントごとに公式単価×対象人数の金額を入れて再保存してください。`,
);
} else if (dpaLineTotal!== expectedDpaTotal) {
violations.push(
`プラン${slot}: DPA費用の内訳（${dpaLineTotal.toLocaleString("ja-JP")}円）が、購入インスタンスごとに正規化ファクトの公式単価×対象人数（購入行の purchaseCount）で再計算した金額（${expectedDpaTotal.toLocaleString("ja-JP")}円）と一致しません（DPA費用の計上不一致・クラス2）。DPAは購入した時に、購入イベント1件につき1回だけ、その施設を実際に利用する人数分だけ計上してください（使用行では計上しません）。ファクトの単価と対象人数で計算し直し、内訳と合計を直して再保存してください。`,
);
}
} else if (dpaLineTotal > 0) {
violations.push(
`プラン${slot}: DPAを使う項目が無いのに、費用内訳にDPA費用（${dpaLineTotal.toLocaleString("ja-JP")}円）が含まれています。`,
);
}
const allLines = plan.costBreakdown?? [];
if (
allLines.length > 0 &&
plan.estimatedCostJpy != null &&
allLines.every((l) => l.amountJpy != null)
) {
const sum = allLines.reduce((s, l) => s + (l.amountJpy?? 0), 0);
if (sum!== plan.estimatedCostJpy) {
violations.push(
`プラン${slot}: 費用内訳の合計（${sum.toLocaleString("ja-JP")}円）が、概算費用の総額（${plan.estimatedCostJpy.toLocaleString("ja-JP")}円）と一致しません。内訳か総額を直して再保存してください。`,
);
}
}
// Class 13 — budget correspondence (spec §9.2, revision X), same
// rule as savePlanSet: an over-budget total is refused ONLY when
// the submission carries no budgetDisclosure; a disclosed
// overrun passes, and a snapshot without a budget is out of
// scope.
if (
snapshotBudgetJpy != null &&
plan.estimatedCostJpy != null &&
plan.estimatedCostJpy > snapshotBudgetJpy &&
!(plan.budgetDisclosure ?? "").trim()
) {
violations.push(
`プラン${slot}: 費用合計（${plan.estimatedCostJpy.toLocaleString("ja-JP")}円）が、条件の予算（${snapshotBudgetJpy.toLocaleString("ja-JP")}円）を超えているのに、予算超過の開示が提出に含まれていません（予算対応の不一致・クラス13）。予算超過を開示する文面を budgetDisclosure として渡し、同じ開示をプランの説明（summary）にも含めて再保存してください。予算内に収まる場合は、合計が予算以下になるよう組み直してください。`,
);
}
// Class 12 — the ticket line of the breakdown must be costed for
// THIS set's snapshot party (spec §9.2), same rule as savePlanSet.
violations.push(
...ticketLinePartyViolations(
slot,
plan.costBreakdown,
snapshotParty ??
(formParty
? { adults: formParty.adults, children: formParty.children }
: null),
args.ticketPrices,
),
);
if (violations.length > 0) {
// 過程記録： record this attempt's outcome (the gate's classes
// and reasons ride in the violation texts themselves) before the
// refusal propagates; the run stays open for the recovery.
await recordServerRunEvent(
ctx,
args.planSetId,
{
eventType: "note",
phase: "save_verify",
label: "保存試行の結果：拒否（検証ゲート）",
detail: violations.slice(0, 10).join("\n- "),
},
slot,
);
throw new Error(
`保存できませんでした。次の問題を直して、もう一度 savePlanReplacement を呼んでください（失敗報告はしないこと）:\n- ${violations.slice(0, 10).join("\n- ")}`,
);
}

// Verification passed. Swap ONLY this plan's rows: the plan row is
// updated in place and its items are replaced; the other plans of
// the set are not read for writing and cannot change.
const fetchedAt =
v.fetchedAt ??
new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo"});
const dictCache = new Map<string, FacilityRow | undefined>();
const dictFor = async (name: string): Promise<FacilityRow | undefined> => {
const key = facilityNameKey(name);
if (!dictCache.has(key)) {
dictCache.set(key, await findFacility(ctx, set.park, name));
}
return dictCache.get(key);
};
const fetchedByName = new Map<
string,
{ name: string; lat?: number; lng?: number; officialUrl?: string; area?: string}
>();
for (const item of plan.items) {
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility: nothing about it is recorded into the dictionary.
if (item.kind === "first10") continue;
const key = facilityNameKey(item.name);
const rec = fetchedByName.get(key)?? { name: item.name};
if (item.lat != null && item.lng != null) {
rec.lat = item.lat;
rec.lng = item.lng;
}
if (item.officialUrl) rec.officialUrl = item.officialUrl;
if (item.area) rec.area = item.area;
fetchedByName.set(key, rec);
}
const replacementScenario = planScenarioFor(
slot,
set.crowdLevel?? null,
set.setType === "same_day",
);
await db
.update(schema.plans)
.set({
title: plan.title,
summary: plan.summary?? null,
estimatedCostJpy: plan.estimatedCostJpy?? null,
crowdScenario: replacementScenario.scenario,
crowdScenarioLevel: replacementScenario.level,
costBreakdownJson:
plan.costBreakdown && plan.costBreakdown.length > 0
? JSON.stringify(
plan.costBreakdown.map((l) => ({
label: l.label,
amountJpy: l.amountJpy?? null,
note: l.note?? null,
})),
)
: null,
})
.where(eq(schema.plans.id, planRow.id));
await db
.delete(schema.planItems)
.where(eq(schema.planItems.planId, planRow.id));
type SavedItem = {
rowId: number;
name: string;
imageUrl: string | null | undefined;
referenceUrl: string | null | undefined;
};
const savedItems: SavedItem[] = [];
for (const [index, item] of plan.items.entries()) {
const dict = await dictFor(item.name);
const hasPair = item.lat != null && item.lng != null;
const fbCoords = coordFallback.get(facilityNameKey(item.name));
// A dictionary pair outside the park's box (legacy row) is not
// stored on the item either (spec §10 park-range check).
const dictInRange =
dict != null &&
dict.lat != null &&
dict.lng != null &&
coordsInParkRange(set.park, dict.lat, dict.lng);
// Purchase-event rows never carry coordinates (see savePlanSet).
// A park-wide show's pin is the park's representative point,
// overriding payload and dictionary coordinates alike.
const pwCoords =
item.kind === "purchase" || item.kind === "first10"
? undefined
: coordParkWide.get(facilityNameKey(item.name));
const effLat =
item.kind === "purchase" || item.kind === "first10"
? null
: pwCoords
? pwCoords.lat
: hasPair
? (item.lat as number)
: dictInRange
? (dict.lat as number)
: fbCoords
? fbCoords.lat
: null;
const effLng =
item.kind === "purchase" || item.kind === "first10"
? null
: pwCoords
? pwCoords.lng
: hasPair
? (item.lng as number)
: dictInRange
? (dict.lng as number)
: fbCoords
? fbCoords.lng
: null;
const insertedItem = await db
.insert(schema.planItems)
.values({
planId: planRow.id,
sortOrder: index,
timeLabel: item.timeLabel?? null,
name: item.name,
kind: item.kind,
area: item.area?? dict?.area?? null,
note: item.note?? null,
passType: item.passType?? null,
dpaPurchaseTime: item.dpaPurchaseTime?? null,
unitPriceJpy: item.unitPriceJpy?? null,
// Headcount the purchase is bought for (purchase rows only;
// the gate validated it before this insert runs).
purchaseCount:
item.kind === "purchase" ? (item.purchaseCount ?? null) : null,
estWaitMin: item.estWaitMin?? null,
// The leg INTO this item, computed deterministically above
// (null = unverified leg / first item).
travelMin: planLegs[index]?.travelMin ?? null,
lat: effLat,
lng: effLng,
officialUrl: item.officialUrl?? dict?.officialUrl?? null,
// Row-level unconfirmed (§9.4), carried by the row itself.
unconfirmedReason: item.unconfirmedReason?.trim()? item.unconfirmedReason: null,
unconfirmedNote: item.unconfirmedNote?.trim()? item.unconfirmedNote: null,
})
.returning({ id: schema.planItems.id});
const itemRow = insertedItem[0];
// The display-only 「最初の10分」 row (kind "first10") is not a
// facility and never enters the photo pass.
if (itemRow && item.kind !== "first10") {
savedItems.push({
rowId: itemRow.id,
name: item.name,
imageUrl: item.imageUrl,
referenceUrl: item.referenceUrl,
});
}
}
for (const rec of fetchedByName.values()) {
await upsertFacilityFromFetch(ctx, set.park, rec);
}
// Intro photos for the swapped plan's items, one download per
// facility, with the same reuse order as savePlanSet (fresh
// dictionary photo -> a photo the app already owns for the facility
// in another set -> download).
const photoGroups = new Map<string, SavedItem[]>();
for (const si of savedItems) {
const key = facilityNameKey(si.name);
const group = photoGroups.get(key)?? [];
group.push(si);
photoGroups.set(key, group);
}
for (const group of photoGroups.values()) {
const first = group[0];
if (!first) continue;
const dict = await dictFor(first.name);
let stored: { key: string; source: "official" | "reference"} | null =
null;
if (
dict &&
dict.imageBlobKey &&
dict.imageSource &&
facilityFreshness(dict, Date.now()).imageFresh
) {
stored = { key: dict.imageBlobKey, source: dict.imageSource};
} else {
const owned = await findOwnedFacilityPhoto(
ctx,
set.park,
first.name,
set.id,
);
if (owned) {
stored = owned;
await upsertFacilityFromFetch(ctx, set.park, {
name: first.name,
image: { blobKey: owned.key, source: owned.source},
});
}
}
if (!stored) {
const withUrl = group.find((g) => g.imageUrl || g.referenceUrl);
if (withUrl) {
stored = await storeItemImageWithFallback(
ctx,
`plan-items/${first.rowId}`,
withUrl.imageUrl,
withUrl.referenceUrl,
);
if (stored) {
await upsertFacilityFromFetch(ctx, set.park, {
name: first.name,
image: { blobKey: stored.key, source: stored.source},
});
}
}
}
if (stored) {
for (const si of group) {
await db
.update(schema.planItems)
.set({ imageBlobKey: stored.key, imageSource: stored.source})
.where(eq(schema.planItems.id, si.rowId));
}
}
}
for (const r of args.waitSourceFetchResults) {
await db
.update(schema.waitTimeSources)
.set({ fetchMethod: r.method})
.where(eq(schema.waitTimeSources.url, r.url));
}

// The set's verification record gains the partial-replacement
// entries (what was replaced, when, with what change, and what this
// run's cross-check confirmed) — the original full-generation
// checks stay, and the eligible-fact list is merged with this run's
// build (this run's facts win for the same facility).
// Row-level unconfirmed entries are derived from the replaced
// plan's rows (§9.4 — the row is the single source), exactly as
// in savePlanSet, and task-supplied duplicates of a derived
// show-time entry are dropped.
const rowDerivedUnverified: string[] = [];
const rowDerivedShowNames = new Set<string>();
for (const item of args.plan.items) {
const entry = rowUnconfirmedRecordEntry(item);
if (entry && !rowDerivedUnverified.includes(entry)) {
rowDerivedUnverified.push(entry);
pushFactUnverified(entry);
}
if (
item.unconfirmedReason &&
(item.kind === "show" || item.kind === "parade")
) {
rowDerivedShowNames.add(item.name);
}
}
const unverifiedAll: string[] = [];
for (const u of [
...v.unverified.filter(
(u) =>
!isStaleCoordClaim(u, healedNames) &&
!(
rowDerivedShowNames.size > 0 &&
u.includes("公演時刻") &&
[...rowDerivedShowNames].some((n) => u.includes(n))
),
),
...autoUnverified,
...rowDerivedUnverified,
]) {
if (!unverifiedAll.includes(u)) unverifiedAll.push(u);
}
const srcOf = (
s: { title: string; url: string} | null | undefined,
): {
sourceTitle: string | null;
sourceUrl: string | null;
fetchedAt: string;
} => ({
sourceTitle: s? s.title: null,
sourceUrl: s? s.url: null,
fetchedAt,
});
const existing = parseVerificationJson(set.verificationJson);
const mergedExtracted = new Map<string, DpaExtractedEntry>();
for (const e of existing?.dpaExtracted?? []) {
mergedExtracted.set(facilityNameKey(e.name), e);
}
for (const e of dpaExtracted.values()) {
mergedExtracted.set(facilityNameKey(e.name), e);
}
const mergedUnverified: string[] = [];
for (const u of [
...(existing?.unverified?? []).filter(
(u) => !isStaleCoordClaim(u, healedNames),
),
...unverifiedAll,
]) {
if (!mergedUnverified.includes(u)) mergedUnverified.push(u);
}
const periodRecordText = dpaPeriodRecordText(
dpaExtracted,
set.visitDate,
factGate.build != null,
);
// This run's display facts merge over the record's existing ones
// (this run's fact wins for the same facility), so the record
// keeps the freshest grounds for every facility it names.
const mergedFacts = new Map<string, z.infer<typeof dpaFactShape>>();
for (const f of existing?.dpaFacts?? []) {
mergedFacts.set(facilityNameKey(f.name), f);
}
for (const f of factGate.displayFacts) {
mergedFacts.set(facilityNameKey(f.name), f);
}
// Crowd factors merge per plan: factors are recorded per
// (slot, facility) since the scenario split, so the replaced
// plan's entries take THIS run's reported effective factors
// (stamped with the replaced slot) and the other plans' entries
// keep theirs. Legacy flat entries (slot null, shared by the
// set) keep the old behaviour: an entry for a facility in the
// replaced plan is dropped in favour of the new report.
const mergedCrowdFactors = new Map<
string,
{ name: string; factor: number; slot: "A" | "B" | "C" | null }
>();
const crowdFactorKey = (
slotKey: string,
name: string,
): string => `${slotKey}:${facilityNameKey(name)}`;
for (const f of existing?.crowdFactors?? []) {
mergedCrowdFactors.set(crowdFactorKey(f.slot?? "", f.name), f);
}
const replacedFacilityKeys = new Set(
plan.items.map((it) => facilityNameKey(it.name)),
);
for (const [key, f] of [...mergedCrowdFactors.entries()]) {
if (f.slot === slot) mergedCrowdFactors.delete(key);
else if (
f.slot == null &&
replacedFacilityKeys.has(facilityNameKey(f.name))
) {
mergedCrowdFactors.delete(key);
}
}
for (const f of args.crowdWaitFactors) {
mergedCrowdFactors.set(crowdFactorKey(slot, f.name), {
name: f.name,
factor: f.factor,
slot,
});
}
const verificationRecord: z.infer<typeof verificationShape> = {
checkedAt: fetchedAt,
checks: [
...(existing?.checks?? []),
{
label: `部分差し替え（プラン${slot}）`,
result: `プラン${slot}だけを差し替え（他のプランは変更なし）。変更内容: ${args.changeNote}`,
sourceTitle: null,
sourceUrl: null,
fetchedAt,
},
{
label: `部分差し替え（プラン${slot}）のDPA照合`,
result: `${
dpaRowCount > 0
? `差し替えたプラン${slot}のDPA前提の全${dpaRowCount}行が、この回の正規化ファクト（ビルド #${factGate.build?.id}）で対象と記録された施設であることと、費用内訳のDPA金額が購入インスタンスごとにファクトの単価×対象人数（購入行の purchaseCount＝その施設を実際に利用する人数）を1回ずつ計上した再計算と一致することを確認（DPA費用は購入した時に計上し、使用行では計上しない）`
: `差し替えたプラン${slot}にDPA前提の行はありませんでした（この回のファクトビルド #${factGate.build?.id}の対象は${dpaExtracted.size}施設）`
}${periodRecordText ? `。${periodRecordText}` : ""}`,
...srcOf(v.dpaSource),
},
{
label: `部分差し替え（プラン${slot}）の休止・営業時間・公演時刻`,
result: `差し替えたプラン${slot}の全行が対象日の休止一覧（${v.closedFacilities.length}件）に含まれず、時刻が営業時間内であることを確認${showCheckedCount > 0? `。公演時刻を公式データと照合（${showCheckedCount}件）`: ""}`,
...srcOf(v.calendarSource),
},
{
label: `部分差し替え（プラン${slot}）の移動時間`,
result:
travelLegsTotal === 0
? `差し替えたプラン${slot}に移動を伴う区間はありませんでした`
: `差し替えたプラン${slot}の全${travelLegsTotal}区間のうち${travelLegsVerified}区間を、座標間の直線距離・歩く速さ「${WALKING_SPEED_LABELS[travelSpeed]}」・迂回乗率・エリア間マトリクスからサーバーが機械計算した移動時間（余裕×1.2込み）で照合し、間隔 ≧ 推定待ち＋公式所要時間＋移動時間 を確認${travelMatrixUsed > 0? `（エリア間マトリクスが距離ベースより大きい値を取った区間: ${travelMatrixUsed}区間）`: ""}${travelLegsTotal - travelLegsVerified > 0? `。残り${travelLegsTotal - travelLegsVerified}区間は座標が引けず未確認（従来の下限で検証し、未確認として記録）`: ""}`,
sourceTitle: travelMatrixSources[0]?.sourceTitle ?? null,
sourceUrl: travelMatrixSources[0]?.sourceUrl ?? null,
fetchedAt: travelMatrixSources[0]?.fetchedAt ?? fetchedAt,
},
...(set.crowdLevel != null && args.crowdWaitFactors.length > 0
? [
{
label: `部分差し替え（プラン${slot}）の混雑係数`,
result: `このセットの混雑予想${set.crowdLevel}／5の前提を維持し、差し替えたプラン${slot}（混雑シナリオ「${CROWD_SCENARIO_LABELS[CROWD_SCENARIO_BY_SLOT[slot]]}」・${crowdScenarioLevel(set.crowdLevel, CROWD_SCENARIO_BY_SLOT[slot])}／5相当）の推定待ち時間に施設ごとの実効係数（シナリオ上限${crowdFactorLabel(crowdFactorCap(crowdScenarioLevel(set.crowdLevel, CROWD_SCENARIO_BY_SLOT[slot])))}以下）を適用した。実際に掛けた実効係数はこの記録のプラン${slot}の施設別一覧のとおり`,
sourceTitle: null,
sourceUrl: null,
fetchedAt,
},
]
: []),
],
unverified: mergedUnverified,
dpaExtracted: [...mergedExtracted.values()],
factBuildId: factGate.build ? factGate.build.id : (existing?.factBuildId ?? null),
factSummary: factGate.summary ?? existing?.factSummary ?? null,
dpaFacts: [...mergedFacts.values()],
crowdFactors: [...mergedCrowdFactors.values()],
};
const wasGenerating =
(slot === "A"
? set.progressA
: slot === "B"
? set.progressB
: set.progressC) === "generating";
// The operation is over: its retry record goes away with the swap.
const completedOpsJson = pendingOpsJsonWith(set.pendingOpsJson, slot, null);
await db
.update(schema.planSets)
.set(
slot === "A"
? {
progressA: "done" as const,
progressUpdatedAt: new Date(),
verificationJson: JSON.stringify(verificationRecord),
factBuildId: args.factBuildId ?? set.factBuildId,
pendingOpsJson: completedOpsJson,
}
: slot === "B"
? {
progressB: "done" as const,
progressUpdatedAt: new Date(),
verificationJson: JSON.stringify(verificationRecord),
factBuildId: args.factBuildId ?? set.factBuildId,
pendingOpsJson: completedOpsJson,
}
: {
progressC: "done" as const,
progressUpdatedAt: new Date(),
verificationJson: JSON.stringify(verificationRecord),
factBuildId: args.factBuildId ?? set.factBuildId,
pendingOpsJson: completedOpsJson,
},
)
.where(eq(schema.planSets.id, set.id));
// Announced once, on the 作成中 -> 完了 transition of this slot:
// the replacement is done, and the other plans never changed.
// When THIS run left spec-related facts unconfirmed, the line
// also carries the repair guidance (same rule as savePlanSet);
// entries carried over from the set's earlier record do not
// retrigger it — only this run's own unverified list counts.
if (wasGenerating) {
await db.insert(schema.messages).values({
role: "assistant",
text: factsUnconfirmed(factGate, factUnverified)
? `プラン${slot}の差し替えが終わりました。「${set.title}」のプラン${slot}に変更が反映されています。他のプランはそのままです。\nなお、この回では現在の仕様に関わる項目に確認できなかったものがあります。${SPEC_REPAIR_GUIDANCE}`
: `プラン${slot}の差し替えが終わりました。「${set.title}」のプラン${slot}に変更が反映されています。他のプランはそのままです。`,
});
}
// 過程記録： the replacement landed — end the save/verify phase
// and close this slot's run as succeeded.
await recordServerRunEvent(
ctx,
set.id,
{
eventType: "phase_end",
phase: "save_verify",
label: "保存・検証の終了（savePlanReplacement）",
},
slot,
);
await closeOpenRunLog(ctx, set.id, "succeeded", null, slot, "finished");
ctx.invalidateQueries();
return { ok: true};
},
}),

reportPlanReplacementFailure: defineAction({
description:
"Internal: called by the partial-replacement task when the replacement plan cannot be produced at all. Only the target slot's progress is stood down (back to 完了 for the intact original plan); the set and the other plans are untouched, and the failure is announced in the chat.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
error: z.string().min(1).max(2000),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) return { ok: true};
const progress =
args.slot === "A"
? set.progressA
: args.slot === "B"
? set.progressB
: set.progressC;
// Transition-guarded like the other failure paths: only a slot
// actually marked 作成中 by a partial replacement reports here,
// once. The original plan row was never touched, so the slot
// returns to 完了 (its plan is intact and displayed as such).
if (set.status === "done" && progress === "generating") {
await db
.update(schema.planSets)
.set(
args.slot === "A"
? { progressA: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, args.slot, null)}
: args.slot === "B"
? { progressB: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, args.slot, null)}
: { progressC: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, args.slot, null)},
)
.where(eq(schema.planSets.id, set.id));
await db.insert(schema.messages).values({
role: "assistant",
text: `プラン${args.slot}の差し替えはできませんでした。（理由: ${args.error}）元のプラン${args.slot}はそのまま残っています。\n現在の公式情報を確認できなかったため、${SPEC_REPAIR_GUIDANCE}`,
});
}
// 過程記録： close this slot's run with the reported reason.
await closeOpenRunLog(ctx, args.planSetId, "failed", args.error, args.slot, "finished");
ctx.invalidateQueries();
return { ok: true};
},
}),

getFacilityDictionary: defineAction({
description:
"Internal: returns the facility dictionary （施設辞書） for one park — the static facility attributes fetched at runtime so far (area, official URL, official duration, coordinates, photo presence) with per-group freshness flags, plus each restaurant's CURRENT FACT (restaurantFact: the grounded classification from the restaurant fact layer — serviceType / reservationType / mobileOrder / registeredAt — or null when no valid fact is registered). Coordinates are usable whenever present (no expiry); static attributes and photos are fresh only within their TTL. The generation task reads this first and re-fetches only what is missing or stale — a restaurant whose restaurantFact is null needs its official detail page fetched and a fact registered via saveRestaurantFacts even when its other static attributes are fresh. The bare reservationType / mobileOrder fields are the dictionary's LEGACY classification columns, retained for history only: they are NOT the classification source anymore and must never be used for a plan decision or a display.",
request: z.object({ park: parkEnum}),
response: z.object({
entries: z.array(
z.object({
name: z.string(),
area: z.string().nullable(),
officialUrl: z.string().nullable(),
durationMin: z.number().nullable(),
reservationType: z
.enum(["required", "ps", "none", "unknown"])
.nullable(),
mobileOrder: z.enum(["available", "unavailable", "unknown"]).nullable(),
restaurantFact: z
.object({
serviceType: z.string().nullable(),
reservationType: z.enum(["required", "ps", "none", "unknown"]),
mobileOrder: z.enum(["available", "not_available", "unknown"]),
registeredAt: z.string(),
})
.nullable(),
lat: z.number().nullable(),
lng: z.number().nullable(),
hasImage: z.boolean(),
imageSource: z.enum(["official", "reference"]).nullable(),
coordsUsable: z.boolean(),
staticFresh: z.boolean(),
imageFresh: z.boolean(),
}),
),
}),
async handler(ctx, args) {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "acquisition",
label: "施設辞書の確認",
startDetail: args.park,
endDetail: (r) => r.entries.length + "件",
}, async () => {

const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.facilities)
.where(eq(schema.facilities.park, args.park))
.orderBy(asc(schema.facilities.id));
const now = Date.now();
const entries: {
name: string;
area: string | null;
officialUrl: string | null;
durationMin: number | null;
reservationType: "required" | "ps" | "none" | "unknown" | null;
mobileOrder: "available" | "unavailable" | "unknown" | null;
restaurantFact: {
serviceType: string | null;
reservationType: "required" | "ps" | "none" | "unknown";
mobileOrder: "available" | "not_available" | "unknown";
registeredAt: string;
} | null;
lat: number | null;
lng: number | null;
hasImage: boolean;
imageSource: "official" | "reference" | null;
coordsUsable: boolean;
staticFresh: boolean;
imageFresh: boolean;
}[] = [];
for (const r of rows) {
const fresh = facilityFreshness(r, now);
const fact = await findCurrentRestaurantFact(ctx, args.park, r.name);
entries.push({
name: r.name,
area: r.area,
officialUrl: r.officialUrl,
durationMin: r.durationMin,
reservationType: r.reservationType,
mobileOrder: r.mobileOrder,
restaurantFact: fact
? {
serviceType: fact.serviceType,
reservationType: fact.reservationType,
mobileOrder: fact.mobileOrder,
registeredAt: fact.createdAt.toISOString(),
}
: null,
lat: r.lat,
lng: r.lng,
hasImage: r.imageBlobKey != null,
imageSource: r.imageBlobKey? r.imageSource: null,
coordsUsable: fresh.coordsUsable,
staticFresh: fresh.staticFresh,
imageFresh: fresh.imageFresh,
});
}
return { entries };
});
},
}),

saveFacilities: defineAction({
description:
"Internal: called by fetch tasks (the per-generation bulk-fetch script's driver, the image-fetch task) to store freshly fetched static facility attributes into the facility dictionary: coordinates, official URL, area, official duration, intro photo (downloaded here from the supplied official/reference URLs and stored as an owned blob). A restaurant's classification does NOT belong here anymore: it is registered as a grounded fact via saveRestaurantFacts from the facility's own official detail page snapshot. The reservationType / mobileOrder parameters below are the dictionary's LEGACY classification columns, retained only so old callers do not break — new fetches must NOT pass them (a classification must never be guessed, and a label-inferred value recorded in these columns is exactly what the fact layer replaced). Only fields actually fetched are passed; omitted fields keep their stored values and their group's freshness timestamp does not advance. PARK-RANGE CHECK (spec §10): coordinates outside the park's bounding box (land: lat 35.618–35.652 / lng 139.862–139.902; sea: lat 35.608–35.645 / lng 139.862–139.902) are never stored as fact — the facility is saved WITHOUT coordinates and its name is returned in `droppedCoordinates` so the drop is reported, never silent.",
request: z.object({
park: parkEnum,
facilities: z
.array(
z.object({
name: z.string().min(1).max(200),
area: z.string().max(200).nullable().optional(),
officialUrl: z.string().max(2000).nullable().optional(),
durationMin: z.number().int().min(0).max(600).nullable().optional(),
reservationType: z
.enum(["required", "ps", "none", "unknown"])
.nullable()
.optional(),
mobileOrder: z
.enum(["available", "unavailable", "unknown"])
.nullable()
.optional(),
lat: z.number().nullable().optional(),
lng: z.number().nullable().optional(),
imageUrl: z.string().max(2000).nullable().optional(),
referenceUrl: z.string().max(2000).nullable().optional(),
}),
)
.max(80),
}),
response: z.object({
ok: z.literal(true),
saved: z.number(),
// Names of facilities whose supplied coordinates fell outside
// the park's bounding box and were therefore saved WITHOUT
// coordinates (spec §10 park-range check).
droppedCoordinates: z.array(z.string()),
}),
async handler(
ctx,
args,
): Promise<{ ok: true; saved: number; droppedCoordinates: string[] }> {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "drafting",
label: "施設辞書への保存",
endDetail: (r) => r.saved + "件を保存" + (r.droppedCoordinates.length > 0 ? "（座標を落とした施設: " + r.droppedCoordinates.join("、") + "）" : ""),
}, async () => {

let saved = 0;
const droppedCoordinates: string[] = [];
// Photo downloads are deduped per facility within this call and
// keyed to a stable dictionary blob path (not a plan-item id), so a
// re-fetch overwrites the same blob instead of piling up copies.
const photoByName = new Map<
string,
{ blobKey: string; source: "official" | "reference"} | null
>();
for (const f of args.facilities) {
const nameKey = facilityNameKey(f.name);
let image = photoByName.get(nameKey);
if (image === undefined) {
image = null;
if (f.imageUrl || f.referenceUrl) {
const stored = await storeItemImageWithFallback(
ctx,
`facilities/${args.park}/${encodeURIComponent(nameKey)}`,
f.imageUrl,
f.referenceUrl,
);
if (stored) {
image = { blobKey: stored.key, source: stored.source};
}
}
photoByName.set(nameKey, image);
}
const upserted = await upsertFacilityFromFetch(ctx, args.park, {
name: f.name,
area: f.area,
officialUrl: f.officialUrl,
durationMin: f.durationMin,
reservationType: f.reservationType,
mobileOrder: f.mobileOrder,
lat: f.lat,
lng: f.lng,
image: image?? undefined,
});
if (upserted.droppedCoords) droppedCoordinates.push(f.name);
saved++;
}
ctx.invalidateQueries();
return { ok: true, saved, droppedCoordinates };
});
},
}),

getAreaTravelTimes: defineAction({
description:
"Internal: returns the area-to-area travel matrix （エリア間マトリクス） registered for one park — typical walking minutes between area pairs, stated at the 少しゆっくり (70 m/min) baseline, each with the guide source it was read from and its fetch date. Pairs not listed are not errors: travel computation uses the distance-based value alone for them until a task registers the pair from a real source via saveAreaTravelTimes.",
request: z.object({ park: parkEnum}),
response: z.object({
entries: z.array(
z.object({
areaA: z.string(),
areaB: z.string(),
minutes: z.number(),
sourceTitle: z.string().nullable(),
sourceUrl: z.string().nullable(),
fetchedAt: z.string().nullable(),
}),
),
}),
async handler(ctx, args) {
const matrix = await loadAreaMatrix(ctx, args.park);
return {
entries: [...matrix.values()].map((e) => ({
areaA: e.areaA,
areaB: e.areaB,
minutes: e.minutes,
sourceTitle: e.sourceTitle,
sourceUrl: e.sourceUrl,
fetchedAt: e.fetchedAt,
})),
};
},
}),

saveAreaTravelTimes: defineAction({
description:
"Internal: registers typical walking minutes between park areas into the area-to-area travel matrix, from guide pages the calling task actually read (each entry carries its source title, URL and fetch date — values without a real source must not be registered). Minutes are stated at the 少しゆっくり (70 m/min) baseline. Registering an existing pair replaces its value and provenance. Used by generation tasks for pairs their plans need that the matrix lacks, and by the one-time initial survey.",
request: z.object({
entries: z
.array(
z.object({
park: parkEnum,
areaA: z.string().min(1).max(100),
areaB: z.string().min(1).max(100),
minutes: z.number().int().min(1).max(180),
sourceTitle: z.string().max(300).nullable().optional(),
sourceUrl: z.string().max(2000).nullable().optional(),
fetchedAt: z.string().max(40).nullable().optional(),
}),
)
.max(80),
}),
response: z.object({ ok: z.literal(true), saved: z.number()}),
async handler(ctx, args): Promise<{ ok: true; saved: number}> {
return await withServerRunBracket(ctx, {
kind: "ai_call",
phase: "drafting",
label: "エリア間移動時間の登録",
endDetail: (r) => r.saved + "件を登録",
}, async () => {

const db = ctx.db<typeof schema>();
let saved = 0;
for (const e of args.entries) {
const ka = facilityNameKey(e.areaA);
const kb = facilityNameKey(e.areaB);
if (!ka || !kb || ka === kb) continue;
const [areaA, areaB, areaAKey, areaBKey] =
ka < kb
? [e.areaA, e.areaB, ka, kb]
: [e.areaB, e.areaA, kb, ka];
const values = {
park: e.park,
areaA,
areaB,
areaAKey,
areaBKey,
minutes: e.minutes,
sourceTitle: e.sourceTitle?? null,
sourceUrl: e.sourceUrl?? null,
fetchedAt: e.fetchedAt?? null,
updatedAt: new Date(),
};
const existing = await db
.select({ id: schema.areaTravelTimes.id})
.from(schema.areaTravelTimes)
.where(
and(
eq(schema.areaTravelTimes.park, e.park),
eq(schema.areaTravelTimes.areaAKey, areaAKey),
eq(schema.areaTravelTimes.areaBKey, areaBKey),
),
)
.limit(1);
if (existing[0]) {
await db
.update(schema.areaTravelTimes)
.set(values)
.where(eq(schema.areaTravelTimes.id, existing[0].id));
} else {
await db
.insert(schema.areaTravelTimes)
.values({ ...values, createdAt: new Date()});
}
saved++;
}
ctx.invalidateQueries();
return { ok: true, saved};
});
},
}),

repairItemPhotosFromOwned: defineAction({
description:
"Internal one-time repair: fills schedule-item intro photos that are missing even though this app already owns the same facility's photo — in the facility dictionary or on an item of another finished plan set of the same park (the rebuild carry-over gap). Copies blob references only; never fetches the web, never overwrites an existing photo.",
request: z.object({}),
response: z.object({
ok: z.literal(true),
repairedItems: z.number(),
repairedSets: z.number(),
}),
async handler(ctx): Promise<{
ok: true;
repairedItems: number;
repairedSets: number;
}> {
const db = ctx.db<typeof schema>();
let repairedItems = 0;
let repairedSets = 0;
const sets = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "done"));
for (const set of sets) {
const planRows = await db
.select({ id: schema.plans.id})
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
let setRepaired = 0;
let stillMissing = false;
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id));
for (const it of itemRows) {
if (it.imageBlobKey) continue;
if (
it.kind!== "attraction" &&
it.kind!== "show" &&
it.kind!== "parade" &&
it.kind!== "restaurant"
) {
continue;
}
let owned: { key: string; source: "official" | "reference"} | null =
null;
const dict = await findFacility(ctx, set.park, it.name);
if (
dict &&
dict.imageBlobKey &&
dict.imageSource &&
facilityFreshness(dict, Date.now()).imageFresh
) {
owned = { key: dict.imageBlobKey, source: dict.imageSource};
} else {
owned = await findOwnedFacilityPhoto(
ctx,
set.park,
it.name,
set.id,
);
}
if (!owned) {
stillMissing = true;
continue;
}
await db
.update(schema.planItems)
.set({ imageBlobKey: owned.key, imageSource: owned.source})
.where(eq(schema.planItems.id, it.id));
await upsertFacilityFromFetch(ctx, set.park, {
name: it.name,
image: { blobKey: owned.key, source: owned.source},
});
setRepaired++;
}
}
if (setRepaired > 0) {
repairedItems += setRepaired;
repairedSets++;
// Every facility item now carries a photo and this set was still
// marked as never-fetched: the fetch state is complete, so the
// on-demand fetch button does not linger over a full set.
if (!stillMissing && set.imagesStatus === "idle") {
await db
.update(schema.planSets)
.set({ imagesStatus: "done", imagesFetchStartedAt: null})
.where(eq(schema.planSets.id, set.id));
}
}
}
if (repairedItems > 0) ctx.invalidateQueries();
return { ok: true, repairedItems, repairedSets};
},
}),

repairItemCoordinates: defineAction({
description:
"Internal one-time repair: fills schedule-item coordinates that are missing even though they are resolvable, using the same deterministic save-time resolution as the save paths — the server re-queries Nominatim (the only geocoder this app uses) with mechanical name variants and records hits into the facility dictionary; a facility genuinely absent from OSM （センター・オブ・ジ・アース） falls back to its area's representative point, disclosed in the plan set's notes. Never overwrites existing coordinates; recomputes affected plans' travel minutes with the same deterministic formula as the save path. PARK-RANGE CHECK (spec §10): a resolution result or dictionary pair outside the park's bounding box is never written onto an item.",
request: z.object({}),
response: z.object({
ok: z.literal(true),
repairedItems: z.number(),
areaFallbackItems: z.number(),
unresolvedNames: z.array(z.string()),
}),
async handler(ctx): Promise<{
ok: true;
repairedItems: number;
areaFallbackItems: number;
unresolvedNames: string[];
}> {
const db = ctx.db<typeof schema>();
let repairedItems = 0;
let areaFallbackItems = 0;
const unresolvedNames: string[] = [];
const conditions = await loadConditions(ctx);
const sets = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "done"));
for (const set of sets) {
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
type ItemRow = typeof schema.planItems.$inferSelect;
const itemsByPlan = new Map<number, ItemRow[]>();
for (const p of planRows) {
const rows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, p.id))
.orderBy(asc(schema.planItems.sortOrder));
itemsByPlan.set(p.id, rows);
}
const allItems = [...itemsByPlan.values()].flat();
// The same resolution the save paths run, over the whole set:
// payload (= stored item) coordinates first, dictionary backfill,
// then the Nominatim re-query / area representative fallback.
const { fallback, notices } = await buildCoordFallback(
ctx,
set.park,
// Display-only 「最初の10分」 rows (kind "first10") are not
// facilities and never enter coordinate resolution.
[allItems.filter((it) => it.kind !== "first10")],
);
let setTouched = false;
const notesToAdd: string[] = [...notices];
for (const items of itemsByPlan.values()) {
let planTouched = false;
for (const it of items) {
// Purchase-event rows are not places: they never carry
// coordinates, so they are never "missing" them either. The
// display-only 「最初の10分」 row (kind "first10") is the same.
if (it.kind === "purchase" || it.kind === "first10") continue;
if (it.lat != null && it.lng != null) continue;
// Tier-1 heals (and any pre-existing dictionary coordinates)
// are visible through the dictionary now. A dictionary pair
// outside the park's bounding box is never written onto an
// item (spec §10 park-range check).
const dict = await findFacility(ctx, set.park, it.name);
if (
dict &&
dict.lat != null &&
dict.lng != null &&
coordsInParkRange(set.park, dict.lat, dict.lng)
) {
await db
.update(schema.planItems)
.set({ lat: dict.lat, lng: dict.lng})
.where(eq(schema.planItems.id, it.id));
it.lat = dict.lat;
it.lng = dict.lng;
repairedItems++;
planTouched = true;
continue;
}
const fb = fallback.get(facilityNameKey(it.name));
if (fb?.via === "area" || fb?.via === "venue") {
await db
.update(schema.planItems)
.set({ lat: fb.lat, lng: fb.lng})
.where(eq(schema.planItems.id, it.id));
it.lat = fb.lat;
it.lng = fb.lng;
areaFallbackItems++;
planTouched = true;
continue;
}
if (!unresolvedNames.includes(it.name)) {
unresolvedNames.push(it.name);
}
}
if (planTouched) {
setTouched = true;
// Recompute this plan's travel minutes from the repaired
// coordinates, with the same deterministic formula and the
// set's snapshotted walking speed as the save path.
const areaMatrix = await loadAreaMatrix(ctx, set.park);
const resolvedItems: ResolvedItem[] = [];
for (const it of items) {
const d = await findFacility(ctx, set.park, it.name);
resolvedItems.push({
name: it.name,
kind: it.kind,
lat: it.lat,
lng: it.lng,
area: it.area?? d?.area?? null,
durationMin: d?.durationMin?? null,
});
}
const legs = computeLegs(
resolvedItems,
set.walkingSpeed?? conditions.walkingSpeed,
areaMatrix,
);
for (const [i, it] of items.entries()) {
const tm = legs[i]?.travelMin?? null;
if (tm!== it.travelMin) {
await db
.update(schema.planItems)
.set({ travelMin: tm})
.where(eq(schema.planItems.id, it.id));
}
}
}
}
if (setTouched && notesToAdd.length > 0) {
const base = set.notes?? "";
const missingLines = notesToAdd
.map((l) => `未確認：${l}`)
.filter((l) => !base.includes(l));
if (missingLines.length > 0) {
await db
.update(schema.planSets)
.set({
notes: [base, ...missingLines].filter(Boolean).join("\n"),
})
.where(eq(schema.planSets.id, set.id));
}
}
}
if (repairedItems + areaFallbackItems > 0) ctx.invalidateQueries();
return {
ok: true,
repairedItems,
areaFallbackItems,
unresolvedNames,
};
},
}),

repairParkWideShowCoordinates: defineAction({
description:
"Internal one-time repair: corrects the map coordinates of park-wide shows （パークワイド — e.g. the fireworks スカイ・フル・オブ・カラーズ, whose only name-matched OpenStreetMap node sits on a bridge outside the park) on finished plan sets and in the facility dictionary, moving their pins to the park's representative point (for Sea, the Mediterranean Harbor point — the convention the park-wide show ニューデイ、ニュードリームス already follows), and recomputes affected plans' travel minutes with the same deterministic formula as the save path. A park-wide show is viewable across the whole park, so a single name-matched node is never its location; the save paths now apply the same representative-point rule deterministically, so the correction cannot regress on a later generation.",
request: z.object({}),
response: z.object({
ok: z.literal(true),
correctedItems: z.number(),
correctedSets: z.number(),
dictionaryFixed: z.number(),
names: z.array(z.string()),
}),
async handler(ctx): Promise<{
ok: true;
correctedItems: number;
correctedSets: number;
dictionaryFixed: number;
names: string[];
}> {
const db = ctx.db<typeof schema>();
let correctedItems = 0;
let correctedSets = 0;
let dictionaryFixed = 0;
const names: string[] = [];
const noteName = (n: string) => {
if (!names.includes(n)) names.push(n);
};
const conditions = await loadConditions(ctx);
// Dictionary first: a park-wide row takes the representative
// point, so the poisoned node can no longer feed any surface.
for (const park of ["land", "sea"] as const) {
const rep = await parkRepresentativePoint(ctx, park);
if (!rep) continue;
const rows = await db
.select()
.from(schema.facilities)
.where(eq(schema.facilities.park, park));
for (const r of rows) {
if (r.area !== PARKWIDE_AREA_NAME) continue;
if (r.lat === rep.lat && r.lng === rep.lng) continue;
await db
.update(schema.facilities)
.set({
lat: rep.lat,
lng: rep.lng,
coordsFetchedAt: new Date(),
updatedAt: new Date(),
})
.where(eq(schema.facilities.id, r.id));
dictionaryFixed++;
noteName(r.name);
}
}
// Then every finished set's park-wide items.
const sets = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.status, "done"));
for (const set of sets) {
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
type ItemRow = typeof schema.planItems.$inferSelect;
const itemsByPlan = new Map<number, ItemRow[]>();
for (const p of planRows) {
const rows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, p.id))
.orderBy(asc(schema.planItems.sortOrder));
itemsByPlan.set(p.id, rows);
}
const allItems = [...itemsByPlan.values()].flat();
const { parkWide, parkWideNotices } = await buildCoordFallback(
ctx,
set.park,
[allItems],
);
if (parkWide.size === 0) continue;
let setTouched = false;
for (const items of itemsByPlan.values()) {
let planTouched = false;
for (const it of items) {
if (it.kind === "purchase") continue;
const pw = parkWide.get(facilityNameKey(it.name));
if (!pw) continue;
if (it.lat === pw.lat && it.lng === pw.lng) continue;
await db
.update(schema.planItems)
.set({ lat: pw.lat, lng: pw.lng})
.where(eq(schema.planItems.id, it.id));
it.lat = pw.lat;
it.lng = pw.lng;
correctedItems++;
planTouched = true;
noteName(it.name);
}
if (planTouched) {
setTouched = true;
// Recompute this plan's travel minutes from the corrected
// coordinates, with the same deterministic formula and the
// set's snapshotted walking speed as the save path.
const areaMatrix = await loadAreaMatrix(ctx, set.park);
const resolvedItems: ResolvedItem[] = [];
for (const it of items) {
const d = await findFacility(ctx, set.park, it.name);
resolvedItems.push({
name: it.name,
kind: it.kind,
lat: it.lat,
lng: it.lng,
area: it.area?? d?.area?? null,
durationMin: d?.durationMin?? null,
});
}
const legs = computeLegs(
resolvedItems,
set.walkingSpeed?? conditions.walkingSpeed,
areaMatrix,
);
for (const [i, it] of items.entries()) {
const tm = legs[i]?.travelMin?? null;
if (tm!== it.travelMin) {
await db
.update(schema.planItems)
.set({ travelMin: tm})
.where(eq(schema.planItems.id, it.id));
}
}
}
}
if (setTouched) {
correctedSets++;
const base = set.notes?? "";
const missingLines = parkWideNotices
.map((l) => `未確認：${l}`)
.filter((l) => !base.includes(l));
if (missingLines.length > 0) {
await db
.update(schema.planSets)
.set({
notes: [base, ...missingLines].filter(Boolean).join("\n"),
})
.where(eq(schema.planSets.id, set.id));
}
}
}
if (correctedItems + dictionaryFixed > 0) ctx.invalidateQueries();
return { ok: true, correctedItems, correctedSets, dictionaryFixed, names};
},
}),

requestItemImages: defineAction({
description:
"Starts fetching intro photos for one finished plan set's schedule items from the official site (for plan sets generated before photos were included, or to retry).",
request: z.object({ planSetId: z.number()}),
response: z.object({
ok: z.boolean(),
error: z.string().nullable(),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) return { ok: false, error: "プランが見つかりませんでした。"};
if (set.status!== "done") {
return { ok: false, error: "プランの作成が終わってからお試しください。"};
}
// A live fetch is left alone, but a fetch stuck past the stale window
// (its task died without reporting) falls through and is restarted.
// A fetch the task manager is running is governed by the manager's
// own deadlines, not by this stale window: while its run is open,
// the fetch is left alone however long it has been running.
if (set.imagesStatus === "fetching" && !isStaleImageFetch(set)) {
return { ok: true, error: null};
}
if (
set.imagesStatus === "fetching" &&
(await mgrHasOpenRun(ctx, { type: "item_images", planSetId: set.id }))
) {
return { ok: true, error: null};
}

const missing = await collectMissingItemImages(ctx, set);
if (missing.length === 0) {
await db
.update(schema.planSets)
.set({ imagesStatus: "done", imagesFetchStartedAt: null})
.where(eq(schema.planSets.id, set.id));
ctx.invalidateQueries();
return { ok: true, error: null};
}

const started = await spawnItemImagesAttempt(ctx, set, missing);
if (!started) {
ctx.invalidateQueries();
return {
ok: false,
error: "画像の取得を開始できませんでした。しばらく後に再度お試しください。",
};
}
ctx.invalidateQueries();
return { ok: true, error: null};
},
}),

saveItemImages: defineAction({
description:
"Internal: called by the image-fetch task to save intro-photo URLs and official detail-page links for plan items (official photo URL and/or a Wikimedia Commons reference fallback per item); the photo bytes are downloaded and stored as owned blobs, official first.",
request: z.object({
planSetId: z.number(),
images: z
.array(
z.object({
itemId: z.number(),
imageUrl: z.string().max(2000).nullable().optional(),
fallbackUrl: z.string().max(2000).nullable().optional(),
officialUrl: z.string().max(2000).nullable().optional(),
}),
)
.max(60),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) {
throw new Error(`saveItemImages: plan set ${args.planSetId} not found`);
}
const planRows = await db
.select({ id: schema.plans.id})
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id));
const planIds = planRows.map((p) => p.id);
const allItems =
planIds.length > 0
? await db
.select()
.from(schema.planItems)
.where(inArray(schema.planItems.planId, planIds))
: [];

const photoByName = new Map<
string,
{ key: string; source: "official" | "reference"} | null
>();
for (const img of args.images) {
const item = allItems.find((it) => it.id === img.itemId);
if (!item) continue;
// Record the official detail-page link independently of the photo:
// a facility whose photo could not be downloaded still gets its
// link, shared with every same-named row in this set.
if (img.officialUrl) {
for (const row of allItems) {
if (row.name!== item.name || row.officialUrl) continue;
await db
.update(schema.planItems)
.set({ officialUrl: img.officialUrl})
.where(eq(schema.planItems.id, row.id));
row.officialUrl = img.officialUrl;
}
// The confirmed official URL is a static attribute: it also goes
// into the facility dictionary for the next generation.
await upsertFacilityFromFetch(ctx, set.park, {
name: item.name,
officialUrl: img.officialUrl,
});
}
// One download per facility name within this save, however many
// rows or entries mention it.
const nameKey = facilityNameKey(item.name);
let stored = photoByName.get(nameKey);
if (stored === undefined) {
stored = await storeItemImageWithFallback(
ctx,
`plan-items/${item.id}`,
img.imageUrl,
img.fallbackUrl,
);
photoByName.set(nameKey, stored);
if (stored) {
// The fetched photo becomes the dictionary's photo for this
// facility, shared by every future plan set.
await upsertFacilityFromFetch(ctx, set.park, {
name: item.name,
image: { blobKey: stored.key, source: stored.source},
});
}
}
if (!stored) continue;
// Share the photo with every same-named row in this set (the same
// facility can appear in several of the three plans).
for (const row of allItems) {
if (row.name!== item.name || row.imageBlobKey) continue;
await db
.update(schema.planItems)
.set({ imageBlobKey: stored.key, imageSource: stored.source})
.where(eq(schema.planItems.id, row.id));
row.imageBlobKey = stored.key;
row.imageSource = stored.source;
}
}

await db
.update(schema.planSets)
.set({ imagesStatus: "done", imagesFetchStartedAt: null})
.where(eq(schema.planSets.id, set.id));
// 裏タスク管理： the photos/links are saved and the fetch is
// marked done — the fetch's normal completion, and the manager
// run's "finished" mark.
await mgrFinishRunForTarget(
ctx,
{ type: "item_images", planSetId: set.id },
"finished",
);
ctx.invalidateQueries();
return { ok: true};
},
}),

reportItemImagesFailure: defineAction({
description:
"Internal: called by the image-fetch task when the official site could not be read and no intro photos could be obtained.",
request: z.object({ planSetId: z.number(), error: z.string().min(1)}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
await db
.update(schema.planSets)
.set({ imagesStatus: "failed", imagesFetchStartedAt: null})
.where(eq(schema.planSets.id, args.planSetId));
// 裏タスク管理： a reported failure is still the task's normal
// completion (the fetch is marked failed by its own report) —
// the manager run's "finished" mark; the manager does not
// retry a reported end.
await mgrFinishRunForTarget(
ctx,
{ type: "item_images", planSetId: args.planSetId },
"finished",
);
ctx.invalidateQueries();
return { ok: true};
},
}),

reportPlanFailure: defineAction({
description:
"Internal: called by the generation task when official information could not be obtained and no honest plan can be made. The failure line posted to the chat also carries the repair guidance (the app's premises may no longer match Disney's current system; ask your own Muse in the main chat to fix the app), per the owner's rule that the guidance rides in the detection message itself.",
request: z.object({ planSetId: z.number(), error: z.string().min(1)}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
// Per-plan failure marking preserves any plan that was already saved
// （完了）: only plans that never got saved become 失敗. (With today's
// all-at-once save no plan is saved before a failure, but the state
// model must stay truthful for partial operations too.)
const currentRows = await db
.select({
progressA: schema.planSets.progressA,
progressB: schema.planSets.progressB,
progressC: schema.planSets.progressC,
})
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const current = currentRows[0];
// Only a still-generating set transitions to failed; a duplicate or
// late report after completion must not flip a finished set or post
// a second chat line.
const updated = await db
.update(schema.planSets)
.set({
status: "failed",
error: args.error,
completedAt: new Date(),
progressA: current?.progressA === "done"? "done": "failed",
progressB: current?.progressB === "done"? "done": "failed",
progressC: current?.progressC === "done"? "done": "failed",
})
.where(
and(
eq(schema.planSets.id, args.planSetId),
eq(schema.planSets.status, "generating"),
),
)
.returning({
id: schema.planSets.id,
title: schema.planSets.title,
rebuiltFromSetId: schema.planSets.rebuiltFromSetId,
setType: schema.planSets.setType,
park: schema.planSets.park,
visitDate: schema.planSets.visitDate,
conditionsSnapshot: schema.planSets.conditionsSnapshot,
sameDayAdults: schema.planSets.sameDayAdults,
sameDayChildren: schema.planSets.sameDayChildren,
});
const failedSet = updated[0];
if (failedSet) {
// A failed generation is also "work finished": say so in the chat,
// with the reason and the conditions the run was actually started
// under (from its stored snapshot), instead of leaving the user to
// discover the failed tab on their own. A failed rebuild
// additionally states that the original plan is untouched, and a
// failed 当日検索 is named as one.
await db.insert(schema.messages).values({
role: "assistant",
// This action fires exactly when the current official
// information could not be obtained and no honest plan can be
// made — a detection moment for a possible system change — so
// the failure line itself carries the repair guidance (the
// owner's rule: not only in the help tab).
text: `${
failedSet.setType === "same_day"
? `「${failedSet.title}」の当日検索はできませんでした。（対象条件: ${setConditionsSummary(failedSet)}／理由: ${args.error}）プラン作成タブの「当日検索」からもう一度お試しください。`
: failedSet.rebuiltFromSetId != null
? `「${failedSet.title}」の作り直しはできませんでした。（対象条件: ${setConditionsSummary(failedSet)}／理由: ${args.error}）元のプランはそのまま残っています。`
: `「${failedSet.title}」のプラン作成はできませんでした。（対象条件: ${setConditionsSummary(failedSet)}／理由: ${args.error}）`
}\n現在の公式情報を確認できなかったため、${SPEC_REPAIR_GUIDANCE}`,
});
}
// 過程記録： close the run with the reported reason.
await closeOpenRunLog(ctx, args.planSetId, "failed", args.error, null, "finished");
ctx.invalidateQueries();
return { ok: true};
},
}),

reportImpossibleRequest: defineAction({
description:
"Internal: called by a generation / partial-replacement task when, with the fetched materials in hand (official facility list, the target date's operations/closures, the normalized facts), the request clearly hits one of the FIXED impossibility patterns (spec §6.2.1: nonexistent / time / budget / contradiction), or when drafting makes it clear the requirements cannot all hold (§6.5). No plan is saved: a whole-set run is failed like reportPlanFailure, a partial replacement stands its slot down like reportPlanReplacementFailure, and the chat receives the fixed §12.9 rejection (apology + cause classification with concrete names + the fixed guidance line; counterfactual promises are dropped sentence-wise and suggestion-form prescriptions clause-wise server-side, so the reason stops at stating objective fact). This is the honest exit for an impossible request — never save a skeleton plan instead.",
request: z.object({
planSetId: z.number(),
// Set only for a partial replacement: the slot being replaced.
// Null for whole-set generation and same-day search.
slot: slotEnum.nullable().optional(),
findings: z.array(impossibilityFindingSchema).min(1).max(4),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const rejection = formatImpossibilityRejection(args.findings);
const slot = args.slot ?? null;
if (slot != null) {
// Partial replacement: mirror reportPlanReplacementFailure's
// transition guard — only a slot actually marked 作成中 by a
// partial replacement reports here, once. The original plan row
// was never touched, so the slot returns to 完了.
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (set) {
const progress =
slot === "A"
? set.progressA
: slot === "B"
? set.progressB
: set.progressC;
if (set.status === "done" && progress === "generating") {
await db
.update(schema.planSets)
.set(
slot === "A"
? { progressA: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null)}
: slot === "B"
? { progressB: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null)}
: { progressC: "done" as const, progressUpdatedAt: new Date(), pendingOpsJson: pendingOpsJsonWith(set.pendingOpsJson, slot, null)},
)
.where(eq(schema.planSets.id, set.id));
await db.insert(schema.messages).values({
role: "assistant",
text: `${rejection}\n元のプラン${slot}はそのまま残っています。`,
});
}
}
// 過程記録： close this slot's run — the impossibility gate is
// the reported reason.
await closeOpenRunLog(
ctx,
args.planSetId,
"failed",
"無理ゲート（§12.9）により作成不可と判定された",
slot,
"finished",
);
ctx.invalidateQueries();
return { ok: true};
}
// Whole-set generation / same-day search: mirror
// reportPlanFailure's transition guard — only a still-generating
// set transitions to failed, and the rejection is posted once.
// The set's error records the classified findings so the failure
// stays traceable next to the chat line (§6.2.1 判定の記録）.
const currentRows = await db
.select({
progressA: schema.planSets.progressA,
progressB: schema.planSets.progressB,
progressC: schema.planSets.progressC,
})
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const current = currentRows[0];
const errorText = `無理ゲート：${args.findings
.map(
(f) =>
`${IMPOSSIBILITY_CATEGORY_LABELS[f.category]}：${sanitizeImpossibilityReason(f.reason)}`,
)
.join("／")}`;
const updated = await db
.update(schema.planSets)
.set({
status: "failed",
error: errorText,
completedAt: new Date(),
progressA: current?.progressA === "done"? "done": "failed",
progressB: current?.progressB === "done"? "done": "failed",
progressC: current?.progressC === "done"? "done": "failed",
})
.where(
and(
eq(schema.planSets.id, args.planSetId),
eq(schema.planSets.status, "generating"),
),
)
.returning({ id: schema.planSets.id});
if (updated[0]) {
await db.insert(schema.messages).values({
role: "assistant",
text: rejection,
});
}
// 過程記録： close the run — the impossibility gate is the
// reported reason.
await closeOpenRunLog(ctx, args.planSetId, "failed", errorText, null, "finished");
ctx.invalidateQueries();
return { ok: true};
},
}),

getPlanPdfData: defineAction({
description:
"Returns everything the in-app PDF export needs for one finished plan set — the three plans with cost breakdowns and timelines (coordinates, estimated waits, pass types, official links, photo URLs), notes, park hours, official sources and wait-time estimation material, plus the PDF footer (text and note-article URL). Excludes the chat log and the conditions form by design. The client renders the PDF from this payload in-app, then stores the rendered file through savePlanPdf and downloads it from the server URL that returns; no public link is created.",
request: z.object({ planSetId: z.number()}),
response: exportDataShape,
async handler(
ctx,
args,
): Promise<z.infer<typeof exportDataShape>> {
const db = ctx.db<typeof schema>();
const rows = await db
.select({ status: schema.planSets.status})
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = rows[0];
if (!set) {
throw new Error(`getPlanPdfData: plan set ${args.planSetId} not found`);
}
if (set.status !== "done") {
throw new Error("作成が完了したプランだけPDFにできます。");
}
const data = await loadExportData(ctx, args.planSetId);
if (!data) {
throw new Error(`getPlanPdfData: plan set ${args.planSetId} not found`);
}
return data;
},
}),

getVerificationPackage: defineAction({
description:
"Read-only: assembles the 「他のAIで2重検証」 package for ONE plan of a finished plan set — a structured plain-text bundle for pasting into another AI: the fixed verification request, the set's conditions snapshot, the plan's premise (summary, crowd forecast/scenario, estimate sources, disclosures, restaurant wait note, unconfirmed rows), the full schedule with stored travel minutes and coordinate-derived walking distances, a recalculable cost breakdown (DPA per purchase instance: unit price × the purchase row's headcount — the people who actually use the facility; legacy purchase rows without a stored headcount are derived at the party size and the line says so), the official information the plan rests on (per-facility DPA facts of the set's fact build, park hours, closure/show-time quotes from the record and notes, restaurant facts, facility dictionary, official + estimate sources), and the set's verification record quoted in full with every unverified item and disclosure. Built ONLY from saved data; anything the saved data cannot supply is stated in the package as 取得できなかった, never guessed. Nothing is fetched, nothing is written, and no verification is run in-app.",
request: z.object({
planSetId: z.number(),
slot: slotEnum,
}),
response: z.object({ text: z.string()}),
async handler(
ctx,
args,
): Promise<{ text: string}> {
const text = await buildVerificationPackageText(
ctx,
args.planSetId,
args.slot,
);
return { text};
},
}),

savePlanPdf: defineAction({
description:
"Stores a client-rendered plan PDF in the app's own blob storage and returns the URL it is served from. RETAINED FOR COMPATIBILITY, currently unused by the client: the URL this returns is relative (./blobs/…), and as a download the phone handed it out of the app — where the app session does not follow — so the owner repeatedly received a black page or an authentication page instead of the PDF, while the same bytes saved via the share sheet displayed perfectly. The client now keeps the generated file on-device (in-app page display + share sheet / same-tap object-URL download) and uploads nothing. The file name is sanitized to a plain basename and the payload must actually be a PDF. Integrity: when the caller sends the generated file's byte length and SHA-256, the decoded bytes are verified against both — plus the %%EOF trailer — before anything is stored, so a transfer-corrupted upload is refused with an error instead of silently storing a PDF no viewer can open.",
request: z.object({
planSetId: z.number(),
fileName: z.string().min(1).max(200),
dataBase64: z.string().min(1).max(24_000_000),
byteLength: z.number().int().min(1).max(20_000_000).optional(),
sha256: z
.string()
.regex(/^[0-9a-f]{64}$/)
.optional(),
}),
response: z.object({
url: z.string(),
fileName: z.string(),
byteLength: z.number(),
}),
async handler(
ctx,
args,
): Promise<{ url: string; fileName: string; byteLength: number }> {
const db = ctx.db<typeof schema>();
const rows = await db
.select({ status: schema.planSets.status })
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = rows[0];
if (!set) {
throw new Error(`savePlanPdf: plan set ${args.planSetId} not found`);
}
if (set.status !== "done") {
throw new Error("作成が完了したプランだけPDFにできます。");
}
const baseName = args.fileName.split(/[\\/]/).pop() ?? "";
const fileName = baseName
.replace(/[\u0000-\u001f\u007f]/g, "")
.trim();
if (!fileName || fileName === "." || fileName === "..") {
throw new Error("savePlanPdf: invalid file name");
}
const safeName = fileName.toLowerCase().endsWith(".pdf")
? fileName
: `${fileName}.pdf`;
const binary = atob(args.dataBase64.replace(/\s/g, ""));
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
bytes[i] = binary.charCodeAt(i);
}
if (
bytes.length < 5 ||
bytes[0] !== 0x25 ||
bytes[1] !== 0x50 ||
bytes[2] !== 0x44 ||
bytes[3] !== 0x46 ||
bytes[4] !== 0x2d
) {
throw new Error("savePlanPdf: payload is not a PDF");
}
// Integrity gate (see the action description): the transfer is a
// ~9MB base64 JSON payload for a typical plan PDF, and until this
// check existed a truncated or corrupted upload still passed the
// 5-byte header test above and was stored as a "successful" PDF
// that no viewer could open. The trailer check catches tail
// truncation; length and hash catch everything else.
const tail = new TextDecoder("latin1").decode(
bytes.subarray(Math.max(0, bytes.length - 64)),
);
if (!tail.includes("%%EOF")) {
throw new Error(
"savePlanPdf: payload is truncated (no %%EOF trailer) — refusing to store a broken PDF",
);
}
if (args.byteLength != null && bytes.length !== args.byteLength) {
throw new Error(
`savePlanPdf: byte length mismatch (expected ${args.byteLength}, got ${bytes.length}) — refusing to store a broken PDF`,
);
}
if (args.sha256 != null) {
let digestHex: string | null = null;
try {
const digest = await crypto.subtle.digest("SHA-256", bytes);
digestHex = Array.from(new Uint8Array(digest))
.map((b) => b.toString(16).padStart(2, "0"))
.join("");
} catch {
digestHex = null;
}
if (digestHex != null && digestHex !== args.sha256) {
throw new Error(
"savePlanPdf: SHA-256 mismatch — refusing to store a broken PDF",
);
}
}
const key = `plan-pdfs/${args.planSetId}/${safeName}`;
await ctx.blobs.put(key, bytes, { contentType: "application/pdf" });
const url = await ctx.blobs.getUrl(key);
return { url, fileName: safeName, byteLength: bytes.length };
},
}),

getMapTiles: defineAction({
description:
"Fetches OpenStreetMap raster tiles for the PDF export's static maps on the server and returns owned blob URLs for them. The in-app browser cannot reliably reach the tile host directly (the shell/WebView blocks or drops some cross-origin fetches), while the action runtime's fetch is the same channel that already downloads the facility photos — so tile bytes travel server -> blob -> same-origin URL, exactly like the photos. Tiles are cached as blobs under osm-tiles/<z>/<x>/<y>.png (a facility area's tiles do not move), so repeat exports reuse them. A tile that cannot be fetched comes back with a null URL; the client then tries a direct fetch and, failing that, omits that tile.",
request: z.object({
tiles: z
.array(
z.object({
z: z.number().int().min(0).max(19),
x: z.number().int().min(0),
y: z.number().int().min(0),
}),
)
.min(1)
.max(400),
}),
response: mapTilesResponse,
async handler(
ctx,
args,
): Promise<z.infer<typeof mapTilesResponse>> {
const seen = new Set<string>();
const unique: { z: number; x: number; y: number }[] = [];
for (const t of args.tiles) {
if (t.x >= 2 ** t.z || t.y >= 2 ** t.z) continue;
const key = `${t.z}/${t.x}/${t.y}`;
if (seen.has(key)) continue;
seen.add(key);
unique.push(t);
}
const tiles = await Promise.all(
unique.map(async (t) => {
const blobKey = `osm-tiles/${t.z}/${t.x}/${t.y}.png`;
try {
const existing = await ctx.blobs.head(blobKey);
if (!existing) {
const res = await fetch(
`https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`,
{
signal: AbortSignal.timeout(15000),
// OSM's tile usage policy asks for a descriptive
// User-Agent identifying the application.
headers: {
"User-Agent":
"MuseDisneyPlanner/1.0 (personal pre-trip planning; PDF static map)",
},
},
);
if (!res.ok) return { ...t, url: null };
const contentType = (res.headers.get("content-type") ?? "")
.split(";")[0]
?.trim()
.toLowerCase();
if (contentType !== "image/png") return { ...t, url: null };
const bytes = new Uint8Array(await res.arrayBuffer());
if (bytes.length === 0 || bytes.length > 1_000_000) {
return { ...t, url: null };
}
await ctx.blobs.put(blobKey, bytes, {
contentType: "image/png",
});
}
return { ...t, url: await ctx.blobs.getUrl(blobKey) };
} catch {
return { ...t, url: null };
}
}),
);
return { tiles };
},
}),


saveResearchAnswer: defineAction({
description:
"Internal: called by the chat research task to post its official-site findings as an assistant chat message. Research only — never creates plans.",
request: z.object({
researchId: z.number(),
answer: z.string().min(1).max(4000),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
// Only the still-pending request accepts its answer; a duplicate or
// late delivery after a failure must not post a second message.
const updated = await db
.update(schema.researchRequests)
.set({ status: "done", completedAt: new Date()})
.where(
and(
eq(schema.researchRequests.id, args.researchId),
eq(schema.researchRequests.status, "pending"),
),
)
.returning({ id: schema.researchRequests.id});
if (updated.length > 0) {
await db
.insert(schema.messages)
.values({ role: "assistant", text: args.answer});
// 裏タスク管理： the answer is posted — the research's normal
// completion, and the manager run's "finished" mark.
await mgrFinishRunForTarget(
ctx,
{ type: "research", researchId: args.researchId },
"finished",
);
}
ctx.invalidateQueries();
return { ok: true};
},
}),

reportResearchFailure: defineAction({
description:
"Internal: called by the chat research task when the official site could not be read and the question cannot be answered honestly.",
request: z.object({ researchId: z.number(), error: z.string().min(1)}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const updated = await db
.update(schema.researchRequests)
.set({ status: "failed", completedAt: new Date()})
.where(
and(
eq(schema.researchRequests.id, args.researchId),
eq(schema.researchRequests.status, "pending"),
),
)
.returning({ id: schema.researchRequests.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
// The in-app AI reporting that the current system cannot be
// confirmed is a detection moment too: alongside the retry
// advice, the line names the repair route (the owner's Muse
// in the main chat) in case the official site itself changed.
text: `公式サイトで確認できませんでした。時間をおいて、もう一度「調べて」と送ってください。（理由: ${args.error}）\nなお、公式サイトの変更などで確認できない場合は、${SPEC_REPAIR_GUIDANCE}`,
});
// 裏タスク管理： a reported failure is still the task's normal
// completion (its word is on the chat) — the manager run's
// "finished" mark; the manager does not retry a reported end.
await mgrFinishRunForTarget(
ctx,
{ type: "research", researchId: args.researchId },
"finished",
);
}
ctx.invalidateQueries();
return { ok: true};
},
}),

saveWaitTimeSources: defineAction({
description:
"Internal: called by the reference-site update task to replace the whole 待ち時間参考サイト list with the surveyed result and post its summary to the chat.",
request: z.object({
requestId: z.number(),
summary: z.string().min(1).max(4000),
sources: z
.array(
z.object({
name: z.string().min(1).max(200),
url: z.string().url().max(2000),
park: z.enum(["land", "sea", "both"]),
provides: z.string().max(500).nullable().optional(),
checkedToday: z.boolean().default(false),
// The acquisition method confirmed for this site during this
// update; null/omitted keeps the previously recorded method.
fetchMethod: z
.enum(["script", "browser", "failed"])
.nullable()
.optional(),
}),
)
.max(30),
}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
// Only the still-pending request may replace the list; a duplicate or
// late delivery after a failure must not clobber newer state.
const updated = await db
.update(schema.waitTimeSourceRequests)
.set({ status: "done", completedAt: new Date()})
.where(
and(
eq(schema.waitTimeSourceRequests.id, args.requestId),
eq(schema.waitTimeSourceRequests.status, "pending"),
),
)
.returning({ id: schema.waitTimeSourceRequests.id});
if (updated.length === 0) return { ok: true};

const previous = await db.select().from(schema.waitTimeSources);
const prevByUrl = new Map(previous.map((r) => [r.url, r]));
await db.delete(schema.waitTimeSources);
const now = new Date();
for (const s of args.sources) {
await db.insert(schema.waitTimeSources).values({
name: s.name,
url: s.url,
park: s.park,
provides: s.provides?? null,
// Sites actually opened during this update get today's date; ones
// carried over unchecked keep their previous confirmation date.
lastCheckedAt: s.checkedToday
? now
: (prevByUrl.get(s.url)?.lastCheckedAt?? null),
// Same carry-over rule for the acquisition method: a method
// confirmed in this update wins; otherwise the previous record
// for the same URL is kept.
fetchMethod:
s.fetchMethod?? prevByUrl.get(s.url)?.fetchMethod?? null,
});
}
await db
.insert(schema.messages)
.values({ role: "assistant", text: args.summary});
// 裏タスク管理： the updated list is saved — the update's
// normal completion, and the manager run's "finished" mark.
await mgrFinishRunForTarget(
ctx,
{ type: "wait_sources", requestId: args.requestId },
"finished",
);
ctx.invalidateQueries();
return { ok: true};
},
}),

reportWaitTimeSourcesFailure: defineAction({
description:
"Internal: called by the reference-site update task when the update could not be carried out (e.g. no candidate site could be opened).",
request: z.object({ requestId: z.number(), error: z.string().min(1)}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
const updated = await db
.update(schema.waitTimeSourceRequests)
.set({ status: "failed", completedAt: new Date()})
.where(
and(
eq(schema.waitTimeSourceRequests.id, args.requestId),
eq(schema.waitTimeSourceRequests.status, "pending"),
),
)
.returning({ id: schema.waitTimeSourceRequests.id});
if (updated.length > 0) {
await db.insert(schema.messages).values({
role: "assistant",
text: `待ち時間参考サイトの更新ができませんでした。時間をおいて、もう一度指示してください。（理由: ${args.error}）`,
});
// 裏タスク管理： a reported failure is still the task's normal
// completion (its word is on the chat) — the manager run's
// "finished" mark; the manager does not retry a reported end.
await mgrFinishRunForTarget(
ctx,
{ type: "wait_sources", requestId: args.requestId },
"finished",
);
}
ctx.invalidateQueries();
return { ok: true};
},
}),

retryGeneration: defineAction({
description:
"Re-runs an in-flight generation from the start — the generating view's リトライ button (stuck-generation safeguard). A whole-set generation （新規作成 / 作り直し / 当日検索） is re-run on the SAME set from its stored conditions snapshot: partially saved plans are discarded, per-plan progress is reset, and the elapsed-time clock restarts at the retry moment; the conditions snapshot itself is never changed. A partial operation on a finished set （部分差し替え / 当日リスケ） is re-run for its unfinished target slot only, exactly from the request recorded at its start (target slot + request content); the other plans and the slot's pre-replacement original are untouched. Everything runs server-side — the possibly-dead original task is never involved. Returns ok=false with an honest error when there is nothing in flight to retry, or when a partial operation's recorded request is missing (it then cannot be re-run as-is; cancel remains available).",
request: z.object({ planSetId: z.number()}),
response: z.object({
ok: z.boolean(),
error: z.string().nullable(),
}),
async handler(
ctx,
args,
): Promise<{ ok: boolean; error: string | null}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) {
return { ok: false, error: "対象のプランが見つかりませんでした。"};
}
// A retry IS a generation start: it runs inside the same
// serialized start section as every other start entrance （記録V).
const startSection = await acquireStartSection();
try {
if (set.status === "generating" || set.status === "failed") {
// Whole-set retry: re-run on the SAME set from its recorded
// start inputs (retryWholeSetGeneration). A failed set is
// retryable the same way — that is the state the task
// manager leaves a set in when its attempts ran out
// （裏タスク管理クラス）: failed on its tab, never stuck at
// 作成中， and re-runnable from here.
return await retryWholeSetGeneration(ctx, set);
}
if (set.status === "done") {
// Partial-operation retry: re-run the ONE unfinished slot
// from the request recorded at its start. The other plans
// and the slot's original plan are never touched. A slot the
// task manager marked failed (attempts exhausted, its
// request still recorded) is retryable the same way.
const pendingOps = parsePendingOps(set.pendingOpsJson);
const generatingSlots = (["A", "B", "C"] as const).filter(
(s) => {
const prog =
s === "A"
? set.progressA
: s === "B"
? set.progressB
: set.progressC;
return prog === "generating" || (prog === "failed" && pendingOps[s] != null);
},
);
if (generatingSlots.length === 0) {
return { ok: false, error: "作成中の操作がありません。"};
}
if (generatingSlots.length > 1) {
return {
ok: false,
error: "複数の差し替えが進行中のため、リトライできません。キャンセルしてから、1つずつ指示してください。",
};
}
const slot = generatingSlots[0];
if (!slot) {
return { ok: false, error: "作成中の操作がありません。"};
}
const op = parsePendingOps(set.pendingOpsJson)[slot];
if (!op) {
return {
ok: false,
error: "再実行に必要な要求の記録が無いため、リトライできません。キャンセルしてから、改めて指示してください。",
};
}
const sealed = parseSnapshotConditions(set).conditions;
const started = await startPartialReplacement(
ctx,
{
id: set.id,
title: set.title,
park: set.park,
visitDate: set.visitDate,
},
slot,
op.instruction,
sealed,
{ dayOfReport: op.dayOfReport, forceRestart: true},
);
if (!started.ok) {
await db.insert(schema.messages).values({
role: "assistant",
text: `「${set.title}」のプラン${slot}の差し替えのリトライを開始できませんでした。元のプラン${slot}はそのまま残っています。`,
});
ctx.invalidateQueries();
return {
ok: false,
error: "リトライを開始できませんでした。元のプランはそのまま残っています。",
};
}
ctx.invalidateQueries();
return { ok: true, error: null};
}
return { ok: false, error: "このプランは作成中ではありません。"};
} finally {
startSection.release();
}
},
}),

cancelGeneration: defineAction({
description:
"Cancels an in-flight generation — the generating view's キャンセル button (stuck-generation safeguard). A whole-set generation （新規作成 / 作り直し / 当日検索） is cancelled by deleting its plan set. A partial operation on a finished set （部分差し替え / 当日リスケ） is cancelled by standing the target slot's progress back down to 完了 — its pre-replacement original plan, which was never touched, is simply the plan again — and the set itself is kept. Either way exactly one chat line announces the cancellation, and the generating display (elapsed time, note, buttons) disappears with the state change. Everything runs server-side — the possibly-dead task is never involved, and a late save from it is refused (whole set: gone; partial: the slot no longer stands at 作成中）. Returns ok=false when nothing is in flight.",
request: z.object({ planSetId: z.number()}),
response: z.object({
ok: z.boolean(),
error: z.string().nullable(),
}),
async handler(
ctx,
args,
): Promise<{ ok: boolean; error: string | null}> {
const db = ctx.db<typeof schema>();
const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) {
return { ok: false, error: "対象のプランが見つかりませんでした。"};
}
if (set.status === "generating") {
// 過程記録： close the run as cancelled BEFORE the set rows go
// (the record itself is kept, tied to the now-deleted set id).
await closeOpenRunLog(ctx, set.id, "cancelled", "利用者がキャンセルした", null, "cancelled");
await deletePlanSetRows(ctx, set.id);
await db.insert(schema.messages).values({
role: "assistant",
text:
set.setType === "same_day"
? `「${set.title}」の当日検索を取り消しました。`
: set.rebuiltFromSetId != null
? `「${set.title}」の作り直しを取り消しました。元のプランはそのまま残っています。`
: `「${set.title}」のプラン作成を取り消しました。`,
});
ctx.invalidateQueries();
return { ok: true, error: null};
}
if (set.status === "done") {
// Slots in flight — or standing at 失敗 with their request
// still recorded (the task manager's attempts-exhausted end):
// cancelling stands either back down to the intact original.
const ops = parsePendingOps(set.pendingOpsJson);
const generatingSlots = (["A", "B", "C"] as const).filter(
(s) => {
const prog =
s === "A"
? set.progressA
: s === "B"
? set.progressB
: set.progressC;
return prog === "generating" || (prog === "failed" && ops[s] != null);
},
);
if (generatingSlots.length === 0) {
return { ok: false, error: "作成中の操作がありません。"};
}
let nextOpsJson = set.pendingOpsJson;
for (const s of generatingSlots) {
nextOpsJson = pendingOpsJsonWith(nextOpsJson, s, null);
}
const patch: Partial<{
progressA: "done";
progressB: "done";
progressC: "done";
}> = {};
for (const s of generatingSlots) {
if (s === "A") patch.progressA = "done";
if (s === "B") patch.progressB = "done";
if (s === "C") patch.progressC = "done";
}
await db
.update(schema.planSets)
.set({
...patch,
progressUpdatedAt: new Date(),
pendingOpsJson: nextOpsJson,
})
.where(eq(schema.planSets.id, set.id));
const only = generatingSlots.length === 1 ? generatingSlots[0] : undefined;
// 過程記録： close each cancelled slot's run.
for (const s of generatingSlots) {
await closeOpenRunLog(ctx, set.id, "cancelled", "利用者がキャンセルした", s, "cancelled");
}
await db.insert(schema.messages).values({
role: "assistant",
text:
only && ops[only]?.dayOfReport
? `「${set.title}」のプラン${only}の当日リスケジュールを取り消しました。元のプラン${only}はそのまま残っています。`
: only
? `「${set.title}」のプラン${only}の差し替えを取り消しました。元のプラン${only}はそのまま残っています。`
: `「${set.title}」のプラン${generatingSlots.join("・")}の差し替えを取り消しました。元のプランはそのまま残っています。`,
});
ctx.invalidateQueries();
return { ok: true, error: null};
}
return { ok: false, error: "このプランは作成中ではありません。"};
},
}),

deletePlanSet: defineAction({
description:
"Deletes one plan set tab (TAB3+). TAB1 and TAB2 are fixed and are not affected.",
request: z.object({ planSetId: z.number()}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
await deletePlanSetRows(ctx, args.planSetId);
ctx.invalidateQueries();
return { ok: true};
},
}),

resetUserData: defineAction({
description:
"Deletes ALL user data and returns the app to its initial state (spec §24): the AI chat log (messages), the プラン作成 conditions row, every plan set with its plans and schedule items, the facility dictionary (restored to the §24 seed: the 75 verified coordinate entries of data/facility-coordinates.json, all other static attributes empty), the area travel-time matrix, the normalized-source layer (source snapshots, normalized facts, fact builds, restaurant facts), research requests, and the pending-request trackers tied to deleted data (verification requests, wait-time-source update requests). What stays: the four fixed tabs (they are app structure, not data), the wait-time reference sites registered by the build-time survey (wait_time_sources rows), the saved announcement (announcement — distribution-channel state that doubles as the read record, spec §22.1), and the app constants (e.g. SHARE_NOTE_URL, ANNOUNCE_URL). Photo blobs belonging to deleted rows are left unreferenced in blob storage; nothing reads them once their rows are gone.",
request: z.object({}),
response: z.object({ ok: z.literal(true) }),
async handler(ctx): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
// FK-safe order: children before parents (plan items -> plans ->
// plan sets; normalized facts -> fact builds -> source
// snapshots). Every delete is unconditional — this is the one
// action whose whole purpose is a complete wipe.
await db.delete(schema.runLogEvents);
await db.delete(schema.runLogs);
await db.delete(schema.planItems);
await db.delete(schema.verificationRequests);
await db.delete(schema.plans);
await db.delete(schema.planSets);
await db.delete(schema.restaurantFacts);
await db.delete(schema.normalizedFacts);
await db.delete(schema.factBuilds);
await db.delete(schema.sourceSnapshots);
await db.delete(schema.facilities);
// §24 initial state: the dictionary is not empty after a reset —
// it holds exactly the distributed coordinate seed (75 entries),
// with every other static attribute unset.
const seedStamp = new Date(FACILITY_SEED_STAMP_MS);
await db.insert(schema.facilities).values(
FACILITY_SEED.map((f) => ({
park: f.park,
nameKey: f.nameKey,
name: f.name,
area: f.area,
lat: f.lat,
lng: f.lng,
coordsFetchedAt: seedStamp,
createdAt: seedStamp,
updatedAt: seedStamp,
})),
);
await db.delete(schema.areaTravelTimes);
await db.delete(schema.researchRequests);
await db.delete(schema.waitTimeSourceRequests);
await db.delete(schema.mgrDialogNotices);
await db.delete(schema.messages);
await db.delete(schema.conditions);
ctx.invalidateQueries();
return { ok: true };
},
}),

requestPlanVerification: defineAction({
description:
"Starts a bulk re-verification （一括検証） of one finished plan set — used by the day-before dialog's 「一括検証を実行する」 button. A background task re-fetches the official data for the set's visit date and savePlanVerification re-runs the save-time checks against the stored plans; plan content is never changed. The start is announced in the TAB1 chat from the actual start result.",
request: z.object({ planSetId: z.number() }),
response: z.object({
ok: z.boolean(),
started: z.boolean(),
alreadyRunning: z.boolean(),
error: z.string().nullable(),
}),
async handler(ctx, args) {
const started = await startPlanVerification(
ctx,
args.planSetId,
"dialog",
true,
);
if (!started.ok) {
return {
ok: false,
started: false,
alreadyRunning: false,
error: started.error,
};
}
return {
ok: true,
started: !started.alreadyRunning,
alreadyRunning: started.alreadyRunning,
error: null,
};
},
}),

markEveDialogShown: defineAction({
description:
"Records that the day-before （前日） dialog for a plan set has been shown, so it is never shown again for that set. Called by the client when the dialog is displayed.",
request: z.object({ planSetId: z.number() }),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
await db
.update(schema.planSets)
.set({ eveDialogShownAt: new Date() })
.where(
and(
eq(schema.planSets.id, args.planSetId),
// Only the first showing is recorded; later calls are no-ops.
isNull(schema.planSets.eveDialogShownAt),
),
);
ctx.invalidateQueries();
return { ok: true };
},
}),

savePlanVerification: defineAction({
description:
"Internal: called by the bulk re-verification task with the official data it re-fetched for the set's visit date. Re-runs the save-time deterministic checks (DPA eligibility/prices/application period judged ONLY by the fresh normalized-fact build named by factBuildId — built by the task from fresh source_snapshots via saveNormalizedFacts — with DPA cost recomputed per purchase instance, counted at purchase and never on usage rows, plus closures, park hours, show times, DPA purchase sequence, travel_min gap arithmetic, breakdown sums) against the STORED plans WITHOUT saving anything, compares against the creation-time verification record, posts the result to the TAB1 chat, appends the run to the set's re-verification history (with the facts and their grounds), and advances lastVerifiedAt. When the run finds mismatches against the current official data or leaves spec-related facts (DPA / facts / hours / show times) unconfirmed, the chat result and the history display also carry the repair guidance (the app's premises may no longer match Disney's current system; ask your own Muse in the main chat to fix the app) — the owner's rule that the guidance rides in the detection message itself. Plan rows, amounts, schedules and coordinates are never modified.",
request: z.object({
requestId: z.number(),
planSetId: z.number(),
// The fresh fact build this re-verification judges DPA rows by.
// Null when the task could not build one; every DPA judgement
// then stays 未確認 instead of running on no grounds.
factBuildId: z.number().nullable().optional(),
parkHours: z.string().nullable().optional(),
sources: z
.array(z.object({ title: z.string(), url: z.string() }))
.max(20)
.default([]),
verification: z.object({
fetchedAt: z.string().max(40).nullable().optional(),
dpaSource: z
.object({ title: z.string().max(300), url: z.string().max(2000) })
.nullable()
.optional(),
calendarSource: z
.object({ title: z.string().max(300), url: z.string().max(2000) })
.nullable()
.optional(),
entertainmentSource: z
.object({ title: z.string().max(300), url: z.string().max(2000) })
.nullable()
.optional(),
dpaSnapshotText: z.string().max(500000).nullable().optional(),
closedFacilities: z.array(z.string().max(200)).max(120).default([]),
showTimes: z
.array(
z.object({
name: z.string().max(200),
times: z.array(z.string().max(10)).max(12),
}),
)
.max(80)
.default([]),
unverified: z.array(z.string().max(300)).max(30).default([]),
}),
}),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
// Only the still-pending request accepts its result; a duplicate
// or late delivery must not post a second message or append a
// second history entry.
const updated = await db
.update(schema.verificationRequests)
.set({ status: "done", completedAt: new Date() })
.where(
and(
eq(schema.verificationRequests.id, args.requestId),
eq(schema.verificationRequests.status, "pending"),
),
)
.returning({ id: schema.verificationRequests.id });
if (updated.length === 0) return { ok: true };

const setRows = await db
.select()
.from(schema.planSets)
.where(eq(schema.planSets.id, args.planSetId))
.limit(1);
const set = setRows[0];
if (!set) return { ok: true };

// The STORED plans, exactly as saved at creation — the checks run
// over these rows and nothing here writes back to them.
const planRows = await db
.select()
.from(schema.plans)
.where(eq(schema.plans.planSetId, set.id))
.orderBy(asc(schema.plans.id));
const plansData: StoredPlanForCheck[] = [];
for (const plan of planRows) {
const itemRows = await db
.select()
.from(schema.planItems)
.where(eq(schema.planItems.planId, plan.id))
.orderBy(asc(schema.planItems.sortOrder));
let costBreakdown: { label: string; amountJpy: number | null }[] = [];
if (plan.costBreakdownJson) {
try {
const parsed: unknown = JSON.parse(plan.costBreakdownJson);
if (Array.isArray(parsed)) {
costBreakdown = parsed
.filter(
(l): l is { label: string; amountJpy?: unknown } =>
typeof l === "object" &&
l !== null &&
typeof (l as { label?: unknown }).label === "string",
)
.map((l) => ({
label: l.label,
amountJpy:
typeof l.amountJpy === "number" ? l.amountJpy : null,
}));
}
} catch {
costBreakdown = [];
}
}
plansData.push({
slot: plan.slot,
estimatedCostJpy: plan.estimatedCostJpy,
costBreakdown,
items: itemRows.map((it) => ({
name: it.name,
kind: it.kind,
timeLabel: it.timeLabel,
note: it.note,
passType: it.passType,
dpaPurchaseTime: it.dpaPurchaseTime,
unitPriceJpy: it.unitPriceJpy,
purchaseCount: it.purchaseCount,
estWaitMin: it.estWaitMin,
travelMin: it.travelMin,
unconfirmedReason: it.unconfirmedReason,
unconfirmedNote: it.unconfirmedNote,
})),
});
}

const v = args.verification;
const original = parseVerificationJson(set.verificationJson);
const { problems, unverified, factUnverified, dpaExtracted, gate } =
await checkStoredPlans(
ctx,
set,
plansData,
{
parkHours: args.parkHours ?? null,
factBuildId: args.factBuildId ?? null,
closedFacilities: v.closedFacilities,
showTimes: v.showTimes,
unverified: v.unverified,
},
original,
);

const now = new Date();
const fetchedAt =
v.fetchedAt ??
now.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
// Append this run to the re-verification history and advance the
// last-verified timestamp. The creation-time verification record
// (verificationJson) and every plan row stay exactly as they were.
const history = parseReverificationsJson(set.reverificationsJson);
history.push({
checkedAt: now.toISOString(),
fetchedAt,
problems,
unverified,
sources: args.sources,
parkHours: args.parkHours ?? null,
dpaExtracted: dpaExtracted.map((e) => ({
name: e.name,
priceJpy: e.priceJpy,
effectiveFrom: e.effectiveFrom,
effectiveTo: e.effectiveTo,
periodEvidence: e.periodEvidence,
})),
factBuildId: gate.build ? gate.build.id : null,
factSummary: gate.summary,
dpaFacts: gate.displayFacts,
});
await db
.update(schema.planSets)
.set({
lastVerifiedAt: now,
reverificationsJson: JSON.stringify(history),
})
.where(eq(schema.planSets.id, set.id));

// The result is reported in the TAB1 chat: what changed, per plan
// and per row with the reason — or that the plans are still valid
// under the current official data. Unverifiable items are named
// as 未確認， never passed over in silence.
const lines: string[] = [
`「${set.title}」の一括検証が終わりました（${fetchedAt}に取得した公式情報で照合）。`,
];
if (!original) {
lines.push(
"このプランには作成時の検証記録がないため、現在の公式情報との照合結果です。",
);
}
if (problems.length === 0) {
lines.push(
plansData.length > 1
? `検証しました。現在の公式情報でも、プラン${plansData.map((p) => p.slot).join("・")}はすべて有効です。`
: "検証しました。現在の公式情報でもプランは有効です。",
);
} else {
lines.push(
"現在の公式情報と照合したところ、次の変更・問題が見つかりました：",
);
for (const p of problems.slice(0, 30)) lines.push(`・${p}`);
if (problems.length > 30) {
lines.push(`・ほか${problems.length - 30}件`);
}
lines.push("プランの内容は変更していません。作り直しが必要なら指示してください。");
}
if (unverified.length > 0) {
lines.push("未確認の項目があります：");
for (const u of unverified.slice(0, 15)) {
lines.push(`・${u.startsWith("未確認") ? u : `未確認：${u}`}`);
}
if (unverified.length > 15) {
lines.push(`・ほか${unverified.length - 15}件`);
}
}
// A mismatch against the current official data, or spec-related
// facts that stayed unconfirmed, is a detection moment: the
// result itself carries the repair guidance (the owner's rule —
// not only the help tab). A clean re-verification gets no such
// line, and coordinate-only unverified legs do not trigger it.
if (problems.length > 0 || factsUnconfirmed(gate, factUnverified)) {
lines.push(`なお、${SPEC_REPAIR_GUIDANCE}`);
}
await db.insert(schema.messages).values({
role: "assistant",
text: lines.join("\n"),
});
// 裏タスク管理： the result is posted — the verification's
// normal completion, and the manager run's "finished" mark.
await mgrFinishRunForTarget(
ctx,
{ type: "verification", requestId: args.requestId },
"finished",
);
ctx.invalidateQueries();
return { ok: true };
},
}),

reportPlanVerificationFailure: defineAction({
description:
"Internal: called by the bulk re-verification task when no verification material could be fetched at all (e.g. the official site could not be read). The plan set and its last-verified date are left untouched.",
request: z.object({ requestId: z.number(), error: z.string().min(1) }),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
const requestRows = await db
.select()
.from(schema.verificationRequests)
.where(eq(schema.verificationRequests.id, args.requestId))
.limit(1);
const request = requestRows[0];
const updated = await db
.update(schema.verificationRequests)
.set({ status: "failed", completedAt: new Date() })
.where(
and(
eq(schema.verificationRequests.id, args.requestId),
eq(schema.verificationRequests.status, "pending"),
),
)
.returning({ id: schema.verificationRequests.id });
if (updated.length > 0) {
const targetRows = request
? await db
.select({ title: schema.planSets.title })
.from(schema.planSets)
.where(eq(schema.planSets.id, request.planSetId))
.limit(1)
: [];
await db.insert(schema.messages).values({
role: "assistant",
// No verification material could be fetched at all, so the
// current system could not be checked against the app's
// premises — the failure line carries the repair guidance too.
text: `「${targetRows[0]?.title ?? "プラン"}」の一括検証ができませんでした。時間をおいて、チャットで「検証して」と送って、もう一度お試しください。（理由: ${args.error}）\n現在の公式情報を確認できなかったため、${SPEC_REPAIR_GUIDANCE}`,
});
// 裏タスク管理： a reported failure is still the task's normal
// completion (its word is on the chat) — the manager run's
// "finished" mark; the manager does not retry a reported end.
await mgrFinishRunForTarget(
ctx,
{ type: "verification", requestId: args.requestId },
"finished",
);
}
ctx.invalidateQueries();
return { ok: true };
},
}),

recordTaskAttempt: defineAction({
description:
"Internal: one attempt's own dedicated record action for the task manager （裏タスク管理・検証6). Called by the attempt's background task in the kind's phase sequence (see the assignment). The server stamps the receipt instant; the FIRST call is the evidence the task started. When the call completes the kind's phase sequence, the attempt and its run close as succeeded and the test advances. A call for an already-closed attempt is refused — late calls are never accepted.",
request: z.object({
attemptId: z.number(),
phase: z.string().min(1).max(40),
note: z.string().max(2000).optional(),
text: z.string().max(200000).optional(),
}),
response: z.object({ ok: z.literal(true) }),
async handler(ctx, args): Promise<{ ok: true }> {
const db = ctx.db<typeof schema>();
const attemptRows = await db
.select()
.from(schema.taskMgrAttempts)
.where(eq(schema.taskMgrAttempts.id, args.attemptId))
.limit(1);
const attempt = attemptRows[0];
if (!attempt) {
throw new Error(
`recordTaskAttempt: 試行（id=${args.attemptId}）が見つかりません。`,
);
}
if (attempt.status === "succeeded" || attempt.status === "cancelled") {
throw new Error(
`recordTaskAttempt: 試行（id=${args.attemptId}）は既に閉じています（status=${attempt.status}）。遅れてきた呼び出しは受け付けません。`,
);
}
const runRows = await db
.select()
.from(schema.taskMgrRuns)
.where(eq(schema.taskMgrRuns.id, attempt.runId))
.limit(1);
const run = runRows[0];
if (!run) {
throw new Error(
`recordTaskAttempt: 実行（id=${attempt.runId}）が見つかりません。`,
);
}
const receivedAt = new Date();
const isFirst = attempt.firstCallAt == null;
const text = args.text ?? null;
await db.insert(schema.taskMgrCalls).values({
attemptId: attempt.id,
phase: args.phase,
calledAt: receivedAt,
note: args.note ?? null,
textLength: text != null ? text.length : null,
savedText: text != null ? text.slice(0, 20000) : null,
});
// Production run: a record call only ever marks the start
// (the first call is the evidence the task started). The
// attempt's completion is the processing's own normal
// completion, observed server-side — never a phase sequence.
if (run.targetJson != null) {
if (isFirst) {
await db
.update(schema.taskMgrAttempts)
.set({ status: "running", firstCallAt: receivedAt })
.where(eq(schema.taskMgrAttempts.id, attempt.id));
}
ctx.invalidateQueries();
return { ok: true };
}
// Progress = how many of the kind's expected phases the calls
// so far match, in order. This call advances it only when its
// phase is the expected next one.
const def = taskMgrKindDef(run.kind);
const callRows = await db
.select()
.from(schema.taskMgrCalls)
.where(eq(schema.taskMgrCalls.attemptId, attempt.id))
.orderBy(asc(schema.taskMgrCalls.id));
let progress = 0;
for (const c of callRows) {
if (def.phases[progress] === c.phase) progress += 1;
}
const complete = progress >= def.phases.length;
if (complete) {
await db
.update(schema.taskMgrAttempts)
.set({
status: "succeeded",
firstCallAt: isFirst ? receivedAt : attempt.firstCallAt,
finishedAt: receivedAt,
})
.where(eq(schema.taskMgrAttempts.id, attempt.id));
await db
.update(schema.taskMgrRuns)
.set({ status: "succeeded", closedAt: receivedAt })
.where(eq(schema.taskMgrRuns.id, run.id));
if (run.testId != null) await advanceTaskMgrTest(ctx, run.testId);
} else if (isFirst) {
await db
.update(schema.taskMgrAttempts)
.set({ status: "running", firstCallAt: receivedAt })
.where(eq(schema.taskMgrAttempts.id, attempt.id));
}
ctx.invalidateQueries();
return { ok: true };
},
}),

checkTaskManager: defineAction({
description:
"Task manager （裏タスク管理）: the periodic server-side deadline check. Judges every open attempt — the manager test's and the production processings' (plan creation, same-day search, research, bulk verification, wait-time site list update, image fetch, restaurant fact correction) — from its recorded instants alone: no first record call within the kind's start timeout, or no finish within its total timeout, closes the attempt as cancelled and retries on the same target; attempts exhausted closes the run as forced （試行回数を超えたので強制終了） and surfaces the failure (plan tab for plan creation / same-day search, chat for research / verification, dialog for the site list update / image fetch / restaurant correction). Runs on a 1-minute schedule; also callable on demand.",
request: z.object({}),
response: z.object({
ok: z.literal(true),
checkedAt: z.string(),
closedAttempts: z.number(),
retriedAttempts: z.number(),
forcedRuns: z.number(),
}),
async handler(
ctx,
): Promise<{
ok: true;
checkedAt: string;
closedAttempts: number;
retriedAttempts: number;
forcedRuns: number;
}> {
const result = await runTaskMgrCheck(ctx);
ctx.invalidateQueries();
return {
ok: true,
checkedAt: new Date().toISOString(),
closedAttempts: result.closedAttempts,
retriedAttempts: result.retriedAttempts,
forcedRuns: result.forcedRuns,
};
},
}),
} satisfies ActionsModule;
