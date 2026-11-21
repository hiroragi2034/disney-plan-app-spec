// Drizzle schema for the Disney plan app.
//
// - conditions: single-row (id = 1) conditions form state from TAB2.
// - messages: TAB1 AI chat log.
// - plan_sets: one row per plan-generation run (TAB3+); holds the three
//   plans (A/B/C) with their timelines as JSON, plus the official-site
//   sources the generation actually used. Disney facility data lives ONLY
//   here, fetched at generation time into this user's DB — nothing is
//   bundled in code or seeds.

import {
integer,
real,
sqliteTable,
text,
uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const conditions = sqliteTable("conditions", {
  id: integer("id").primaryKey(),
  park: text("park", { enum: ["land", "sea"] }).notNull().default("land"),
  visitDate: text("visit_date"),
  entryTime: text("entry_time"),
  exitTime: text("exit_time"),
  budgetJpy: integer("budget_jpy"),
  adults: integer("adults").notNull().default(2),
  children: integer("children").notNull().default(0),
  childrenAges: text("children_ages"),
  stayHotel: text("stay_hotel"),
  // The ONE 「重視する点」 free-text field, applied to all three
  // plans alike (owner's design change, 2026-11-14): the per-plan
  // priority fields (priority_a/b/c) and the common priority were
  // abolished — plans are no longer differentiated by priority axes
  // but by crowd scenario (see plans.crowdScenario). Migration 0026
  // folded the four saved texts into this column with their labels
  // preserved, so nothing the user had written was lost.
  priority: text("priority"),
  // Walking speed （歩く速さ） for the deterministic travel-time
  // computation: slow=ゆっくり (55m/min), slightly_slow=少しゆっくり
  // (70m/min, the area-matrix baseline), slightly_fast=少し急いで
  // (85m/min), fast=急いで (100m/min) — straight-line-distance basis.
  walkingSpeed: text("walking_speed", {
    enum: ["slow", "slightly_slow", "slightly_fast", "fast"],
  })
    .notNull()
    .default("slightly_slow"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Announcement （告知）: the distributor's one-way notice channel
// (spec §22.1). At most ONE row (id = 1): the latest announcement
// fetched from the fixed ANNOUNCE_URL. The saved row doubles as the
// read record — a fetched Ver is saved (overwriting) only when it is
// strictly newer than the stored one, so an announcement is never
// shown twice. No row exists until the first successful fetch.
// resetUserData deliberately does NOT delete this table: it is
// distribution-channel state, not user data (spec §4).
export const announcement = sqliteTable("announcement", {
  id: integer("id").primaryKey(),
  // The announcement's version number (the JSON's `Ver`).
  ver: real("ver").notNull(),
  // The announcement's title (the JSON's `Title`); empty = saved
  // silently, never displayed.
  title: text("title").notNull().default(""),
  // The announcement's body (the JSON's `Body`): HTML, but stored
  // only AFTER the server's allowlist sanitizer has run on it
  // (sanitizeAnnouncementHtml in actions.ts — formatting tags and
  // https links survive; scripts, event handlers and all other
  // markup are stripped before storage), and rendered as HTML in
  // the dialog from that sanitized form.
  body: text("body").notNull().default(""),
  // When this announcement was fetched and saved.
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Prompt versions (spec §22.3): the applied AI prompt bundle and
// the immediately previous one, fetched from the distributor's
// repository and applied automatically as an app update. At most
// TWO rows: one state "applied", one state "previous" (the
// rollback target). The bundle bundled with the app is the initial
// state — no row exists until the first update has been applied.
// resetUserData deliberately does NOT delete this table: like the
// announcement, it is distribution-channel state, not user data
// (spec §4).
export const promptVersions = sqliteTable("prompt_versions", {
  // The bundle's version (the prompts.json `ver`), primary key.
  ver: integer("ver").primaryKey(),
  // The whole prompts.json body, exactly as fetched (its SHA-256
  // and size were verified against the manifest before saving).
  bodyJson: text("body_json").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  // The distribution record that issued this version, when the
  // manifest named one.
  recordRef: text("record_ref"),
  state: text("state", { enum: ["applied", "previous"] }).notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Prompt update state (spec §22.3): exactly ONE row (id = 1) with
// the last update check's outcome. Written by every check —
// applied, no update, or failed (with a machine-readable error
// class) — so a failed check is a visible record, never a silent
// one. Not user data; resetUserData does not delete it.
export const promptUpdateState = sqliteTable("prompt_update_state", {
  id: integer("id").primaryKey(),
  lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
  // "applied" | "no_update" | "failed".
  lastResult: text("last_result"),
  lastErrorClass: text("last_error_class"),
  lastSeenVer: integer("last_seen_ver"),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Wait-time reference sites （待ち時間参考サイト）: third-party aggregate
// sites that log the parks' posted wait times and publish typical levels
// (averages / maxima / day-of-week patterns). Registered by Muse's own
// survey — at build time and whenever the user instructs the AI chat to
// add / remove / re-search — never edited by hand in the UI; the tab is
// a display surface only. Plan generation consults these as ESTIMATION
// material, kept strictly separate from official-site sources.
export const waitTimeSources = sqliteTable("wait_time_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Display name of the site / page.
  name: text("name").notNull(),
  url: text("url").notNull(),
  // Which park the page covers; "both" when one page covers both parks.
  park: text("park", { enum: ["land", "sea", "both"] })
    .notNull()
    .default("both"),
  // What can be read from it, e.g. "アトラクション別の平均・最大・最小
  // 待ち時間と日別の推移".
  provides: text("provides"),
  // How this site was successfully fetched last time — the per-site
  // acquisition know-how: "script" (plain static fetch was enough),
  // "browser" (needed browser rendering, e.g. the page drives an
  // internal Chrome/JS), or "failed" (neither worked on the last
  // attempt). Null = not yet recorded. The next fetch starts from the
  // recorded method instead of re-discovering it.
  fetchMethod: text("fetch_method", {
    enum: ["script", "browser", "failed"],
  }),
  // When Muse last confirmed the page is reachable and current.
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per chat instruction to change the reference-site list
// (add / remove / re-search). A background task does the web work and
// reports back through saveWaitTimeSources; this row tracks the pending
// state so the UI can show "AIが対応しています…" and a dead task can be
// failed after the stale window instead of wedging the indicator.
export const waitTimeSourceRequests = sqliteTable("wait_time_source_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  instruction: text("instruction").notNull(),
  status: text("status", { enum: ["pending", "done", "failed"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

// One row per chat-triggered fact-check: when the user asks a question
// about Disney systems/facilities that the chat AI cannot answer from
// saved data (or says 「調べて」 about one), a background task reads the
// official site and posts the answer back into the chat. This is NOT
// plan generation — no plan set is created for a research request.
export const researchRequests = sqliteTable("research_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  status: text("status", { enum: ["pending", "done", "failed"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const planSets = sqliteTable("plan_sets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  park: text("park", { enum: ["land", "sea"] }).notNull(),
  visitDate: text("visit_date"),
  status: text("status", {
    enum: ["generating", "done", "failed"],
  })
    .notNull()
    .default("generating"),
  error: text("error"),
  // The prompt version pinned to this set (spec §22.3): the first
  // run's start writes the then-applied version here, and every
  // run of this set uses that version while its bundle is held.
  // Null until the first run starts.
  promptsVer: integer("prompts_ver"),
  // How this set was created: "standard" = the usual pre-trip 3-plan
  // generation (プラン作成 tab button or chat), "same_day" = 当日検索 —
  // the emergency same-day entry for a visitor who arrived without a
  // plan. A same-day set holds exactly ONE plan (slot A), built from
  // the visitor's current location at a specified time through park
  // closing, from the CURRENT posted wait times. Recorded at start so
  // every surface (tab badge, progress display, completion/failure
  // chat lines, save-time verification) can treat the set as what it
  // is instead of expecting three plans.
  setType: text("set_type", { enum: ["standard", "same_day"] })
    .notNull()
    .default("standard"),
  // 当日検索 inputs, snapshotted at start (null for standard sets):
  // where the visitor is now (an area name or a facility name — the
  // origin the first travel leg is computed from), the time the plan
  // starts at (no item may be scheduled before it), the visitor's
  // free-text requests, and the party size the run's cost / DPA
  // verification uses (the 当日検索 form carries its own party fields,
  // independent of the TAB2 conditions form).
  sameDayLocation: text("same_day_location"),
  sameDayStartTime: text("same_day_start_time"),
  sameDayRequest: text("same_day_request"),
  sameDayAdults: integer("same_day_adults"),
  sameDayChildren: integer("same_day_children"),
  // When this set is a 作り直し (rebuild) of an earlier finished set for
  // the same park and visit date, the id of that original set; null
  // otherwise. Recorded at generation start so every surface — the tab
  // badge, the completion/failure chat lines, the chat AI's status
  // answers — can state the rebuild relationship as data instead of
  // the AI claiming 「作り直します」 while a separate new set is
  // silently created beside the untouched original. Whether a run IS
  // a rebuild is decided by its start route alone: only an explicit
  // rebuild / reschedule instruction in chat records one; a start from
  // the プラン作成 tab button is always a fresh creation and leaves
  // this null even when a same-park/same-date finished set exists.
  // The walking speed （歩く速さ） in force when this set's generation
  // started, snapshotted from the conditions form. savePlanSet /
  // savePlanReplacement compute this set's travel times with THIS
  // speed even if the form changes later. Null for sets created
  // before the travel-time system existed.
  walkingSpeed: text("walking_speed", {
    enum: ["slow", "slightly_slow", "slightly_fast", "fast"],
  }),
  rebuiltFromSetId: integer("rebuilt_from_set_id"),
  // Lifecycle of the per-item intro-image fetch for this set's schedule
  // rows: idle (never fetched / fetchable) -> fetching -> done | failed.
  imagesStatus: text("images_status", {
    enum: ["idle", "fetching", "done", "failed"],
  })
    .notNull()
    .default("idle"),
  // Per-plan generation progress (プラン別進捗), one column per slot.
  // waiting （待機） -> generating （作成中， set by the generation task via
  // updatePlanProgress when it actually starts drafting that plan) ->
  // done （完了， set ONLY by savePlanSet at the moment that plan is
  // actually saved) / failed （失敗）. Kept per plan — not per set — so a
  // partial operation (e.g. rebuilding plan A only) can mark just its
  // target plan 作成中 while the others stay 完了.
  progressA: text("progress_a", {
    enum: ["waiting", "generating", "done", "failed"],
  })
    .notNull()
    .default("waiting"),
  progressB: text("progress_b", {
    enum: ["waiting", "generating", "done", "failed"],
  })
    .notNull()
    .default("waiting"),
  progressC: text("progress_c", {
    enum: ["waiting", "generating", "done", "failed"],
  })
    .notNull()
    .default("waiting"),
  // When the current/last intro-photo fetch was started. Lets the app
  // detect a fetch whose background task died without reporting back
  // (status stuck at "fetching") and offer a retry instead of wedging.
  imagesFetchStartedAt: integer("images_fetch_started_at", {
    mode: "timestamp_ms",
  }),
  // LEGACY share-page lifecycle columns, retained but no longer read
  // or written: the public-link share feature was replaced on
  // 2026-11-12 by an in-app PDF download (the client renders the PDF
  // from getPlanPdfData; nothing is uploaded and no public link is
  // created). The columns stay so existing rows keep their history.
  shareStatus: text("share_status", {
    enum: ["idle", "creating", "done", "failed"],
  })
    .notNull()
    .default("idle"),
  // Public URL of the published share page; null until the first
  // successful share. Kept across re-shares (same URL, new contents).
  shareUrl: text("share_url"),
  shareError: text("share_error"),
  // When the current/last share-page creation was requested. The
  // dead-task guard fails a "creating" share older than the stale
  // window from this timestamp.
  shareRequestedAt: integer("share_requested_at", {
    mode: "timestamp_ms",
  }),
  // When a share page was last successfully created/updated.
  shareUpdatedAt: integer("share_updated_at", { mode: "timestamp_ms" }),
  // Whether the published share page carries the schedule rows'
  // intro photos (1) or was published without them (0): the photos
  // live in this app's blob storage, which a static page outside the
  // app may not be able to carry over. Null until a share succeeds.
  sharePhotosIncluded: integer("share_photos_included"),
  // When generation last recorded progress (a per-plan progress report
  // via updatePlanProgress, or a plan actually saved). The dead-task
  // watchdog judges a generating set by the time since THIS — not
  // since the set was created — so a long but actively-progressing
  // generation is never failed for merely being slow.
  progressUpdatedAt: integer("progress_updated_at", {
    mode: "timestamp_ms",
  }),
  // When the CURRENT whole-set generation run started (set at insert
  // by startGeneration / startSameDayGeneration, and reset by a
  // user-pressed リトライ to the retry moment). The generating view's
  // elapsed-time display counts from this server-side timestamp, so
  // a page reload never resets the clock. Null for sets created
  // before this column existed — readers fall back to createdAt,
  // which IS the start for those rows.
  generationStartedAt: integer("generation_started_at", {
    mode: "timestamp_ms",
  }),
  // In-flight partial operations on a FINISHED set (部分差し替え /
  // 当日リスケ), as a JSON object keyed by slot: {instruction,
  // dayOfReport, startedAt} per slot — everything a user-pressed
  // リトライ needs to re-run that slot's operation exactly as it was
  // started (target slot + the request's content), plus the
  // operation's start time for the elapsed display. Written by
  // startPartialReplacement at the moment the slot goes 作成中 and
  // removed when the operation completes, fails, is stood down, or
  // is cancelled. Null when no partial operation is in flight.
  pendingOpsJson: text("pending_ops_json"),
  // JSON {pagesOpened, phases: [{name, seconds}]} reported by the
  // generation task at save time: how many pages it opened and how
  // long each phase took, so generation slowness is measured fact
  // rather than impression. Null for sets saved before this existed
  // and for failed generations that never reached the save.
  generationMetricsJson: text("generation_metrics_json"),
  // JSON verification record written by savePlanSet after the
  // deterministic pre-completion cross-check (DPA eligibility and
  // unit prices against the official data fetched on that run,
  // closures, park hours, show times, DPA purchase sequence): what
  // was checked, against which official page, when it was fetched,
  // and which items could NOT be verified （未確認）. Null for sets
  // saved before the verification step existed.
  verificationJson: text("verification_json"),
  // When this set's plans were last verified against official data:
  // the creation-time verification's checkedAt for a fresh set
  // (savePlanSet / savePlanReplacement record it from the record they
  // write), advanced by every bulk re-verification
  // (savePlanVerification) to that run's completion time. The
  // verification record's checkedAt stays the authority; getState
  // surfaces the later of the two. Null for sets saved before the
  // verification step existed.
  lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
  // JSON array of bulk re-verification （一括検証） history entries,
  // appended by savePlanVerification: {checkedAt (ISO instant of the
  // run), fetchedAt, problems, unverified, sources, parkHours,
  // dpaExtracted}. The creation-time record in verificationJson is
  // NEVER rewritten by a re-verification — it stays as the comparison
  // baseline; the history lives here instead.
  reverificationsJson: text("reverifications_json"),
  // When the day-before （前日） dialog for this set was shown to the
  // user. The dialog appears at most once per set, when the space is
  // opened on the day before the visit date (Asia/Tokyo); this
  // timestamp is the server-side record that it was shown, so it is
  // never shown again for the same set.
  eveDialogShownAt: integer("eve_dialog_shown_at", {
    mode: "timestamp_ms",
  }),
  // Crowd forecast （混雑予想） for the visit date, evaluated by the
  // generation task at creation time (day of week, season, events,
  // past congestion data): a 1–5 level (1 = 空いている … 5 = 激混み）
  // plus a short basis sentence. The estimated waits saved with this
  // set already carry a crowd coefficient: the level's value in
  // CROWD_WAIT_FACTOR_CAPS (actions.ts) is the CAP for the most
  // crowd-sensitive headline attractions, and each facility's
  // effective factor (at or below the cap) is kept in the set's
  // verification record. Null for sets created before the forecast existed
  // — never backfilled by guesswork. The conditions form NEVER asks
  // the user for this: the judgement is the app's, not the user's.
  crowdLevel: integer("crowd_level"),
  crowdBasis: text("crowd_basis"),
  // The RAW TEXT of the official Premier Access page(s) as fetched on
  // this generation run, stored verbatim. LEGACY: savePlanSet used to
  // extract the DPA eligibility list and unit prices from this text
  // deterministically; since the normalized-source layer landed, DPA
  // judgement runs ONLY on normalized_facts (see factBuildId below)
  // and this column is kept purely as the run's raw material record.
  // Null for sets saved before this existed.
  dpaSnapshotText: text("dpa_snapshot_text"),
  // The normalized-fact build (fact_builds.id) this set's DPA gate
  // judged against: the generation run fetched the canonical sources
  // into source_snapshots, read them into normalized_facts under one
  // build, and passed the build id in the save payload. DPA rows are
  // judged ONLY by that build's facts. Null for sets saved before
  // the normalized-source layer existed.
  factBuildId: integer("fact_build_id"),
  conditionsSnapshot: text("conditions_snapshot"),
  sourcesJson: text("sources_json"),
  // JSON array of {title, url} for the wait-time reference sites the
  // generation actually consulted as ESTIMATION material. Kept separate
  // from sourcesJson (official pages) so the two provenances never mix.
  estimateSourcesJson: text("estimate_sources_json"),
  notes: text("notes"),
  parkHours: text("park_hours"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

// One row per bulk re-verification （一括検証） of a finished plan set:
// the day-before dialog, or a chat 「検証して」 instruction, starts one;
// a background task re-fetches the official data for the set's visit
// date and reports back through savePlanVerification, which re-runs
// the save-time verification checks against the STORED plans without
// changing any plan content. This row tracks the pending state so the
// UI can show 「検証中」 and a dead task can be failed after the stale
// window instead of wedging the indicator.
export const verificationRequests = sqliteTable("verification_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planSetId: integer("plan_set_id")
    .notNull()
    .references(() => planSets.id),
  status: text("status", { enum: ["pending", "done", "failed"] })
    .notNull()
    .default("pending"),
  // How this verification was started: "dialog" (the day-before
  // dialog's button), "chat" (a 「検証して」 instruction in TAB1), or
  // "manual" (any other in-app entry point).
  trigger: text("trigger", { enum: ["dialog", "chat", "manual"] })
    .notNull()
    .default("dialog"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planSetId: integer("plan_set_id")
    .notNull()
    .references(() => planSets.id),
  slot: text("slot", { enum: ["A", "B", "C"] }).notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  estimatedCostJpy: integer("estimated_cost_jpy"),
  // JSON array of {label, amountJpy, note} cost lines (チケット / DPA /
  // 食事 / お土産 …) whose amounts sum to estimatedCostJpy. Null for plan
  // sets generated before the breakdown existed.
  costBreakdownJson: text("cost_breakdown_json"),
  // The crowd scenario this plan was built under (owner's design,
  // 2026-11-14): the three plans of a standard set are differentiated
  // by scenario, not by priority axes — A = "severe" （激混み前提：
  // busier than forecast), B = "expected" （やや混み前提： the
  // forecast itself), C = "light" （思ったより空いてる前提： quieter
  // than forecast). crowdScenarioLevel is the effective forecast
  // level the plan's wait estimates were built under (A = forecast+1
  // capped at 5, B = forecast, C = forecast−1 floored at 1); the
  // per-facility effective factors applied under that scenario's cap
  // are recorded per plan in the set's verification record. Derived
  // deterministically by the server at save time from the slot and
  // the set's crowdLevel. Null for plans saved before scenarios
  // existed, for same-day sets (no coefficient is applied there),
  // and when the run could not evaluate a forecast.
  crowdScenario: text("crowd_scenario", {
    enum: ["severe", "expected", "light"],
  }),
  crowdScenarioLevel: integer("crowd_scenario_level"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const planItems = sqliteTable("plan_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id")
    .notNull()
    .references(() => plans.id),
  sortOrder: integer("sort_order").notNull().default(0),
  timeLabel: text("time_label"),
  name: text("name").notNull(),
  kind: text("kind", {
    enum: [
      "attraction",
      "show",
      "parade",
      "restaurant",
      "break",
      "move",
      "other",
      // A DPA purchase event: the moment a Premier Access pass is
      // bought (money moves at purchase, so DPA cost is counted on
      // THIS row, once per purchase instance — never on the usage
      // row). Carries the fact unit price in unitPriceJpy.
      "purchase",
      // Display-only 「最初の10分」 block (owner's feature,
      // 2026-11-16): one row per plan, placed immediately after the
      // entry row. Its name is the heading 「入園後の最初の10分」
      // and its note carries the bullet list of first tasks (the
      // plan's first DPA purchase; the lottery entry for each
      // エントリー受付対象 show in the plan) plus the fixed
      // guidance sentence. It is NOT a place or a stop: no
      // coordinates (never pinned), the travel computation passes
      // through it exactly like a purchase row, it carries no cost
      // / wait / pass, and no save-time gate check judges it.
      "first10",
    ],
  })
    .notNull()
    .default("other"),
  area: text("area"),
  note: text("note"),
  passType: text("pass_type"),
  // For ディズニー・プレミアアクセス rows: the time of day the pass
  // is to be bought, stated explicitly in the plan and cross-checked
  // at save time against the official purchase-interval rule (the
  // next DPA may be bought 60 minutes after the previous purchase or
  // at the previous pass's usage start time, whichever is earlier).
  // Null for non-DPA rows and for sets saved before this existed.
  dpaPurchaseTime: text("dpa_purchase_time"),
  // The unit price (1名分） stated on a DPA purchase-event row
  // (kind = "purchase"): the normalized-fact unit price the pass is
  // bought at. The save-time gate cross-checks it against the fact
  // price (a mismatch is a class-2 DPA費用の計上不一致 rejection)
  // and counts DPA cost ONCE per purchase instance from the FACT
  // price — a unit price on a usage row (passType = DPA on an
  // attraction/show row) is never counted and never a rejection
  // reason. Null for non-purchase rows and older plan sets.
  unitPriceJpy: integer("unit_price_jpy"),
  // The headcount a DPA purchase-event row (kind = "purchase") is
  // actually bought FOR (owner's ruling, 2026-11-17): DPA cost is
  // counted per purchase as unit price × THIS count — the number of
  // people who actually use that facility in that plan (riders for
  // an attraction, viewers in the DPA viewing area for a show) —
  // never automatically the whole party. The save-time gates
  // (savePlanSet / savePlanReplacement) require it on every new
  // purchase row and refuse a missing count, a count below 1, or a
  // count above the party size as class 2 (DPA費用の計上不一致）.
  // Null on non-purchase rows, and on purchase rows of plan sets
  // saved before this column existed: read-time derivations fall
  // back to the party size for those legacy rows only, so existing
  // sets keep their displayed amounts (stored rows are never
  // rewritten).
  purchaseCount: integer("purchase_count"),
  // Row-level unconfirmed element (§9.4): when a row places a value
  // that could not be confirmed from official sources on that run —
  // a show time for a period whose official schedule is not yet
  // published, a performance time still listed as 未定, an assumed
  // usage time band for a substitute DPA (§14), a facility attribute
  // that could not be fetched — the row itself carries it:
  // unconfirmedReason is the short reason shown in the row's
  // 「未確定（理由）」 mark, unconfirmedNote the explanation shown
  // when the mark is tapped (including the official publication
  // timing when known). A non-null reason IS the unconfirmed flag;
  // there is no separate boolean to drift. The row is the SINGLE
  // SOURCE: the verification record's 未確認 entries for a row-level
  // unconfirmed are DERIVED from these two fields at save time, so
  // the record can never disagree with the row. Null for confirmed
  // rows and for plan sets saved before this existed.
  unconfirmedReason: text("unconfirmed_reason"),
  unconfirmedNote: text("unconfirmed_note"),
  // Estimated wait in minutes for this stop, estimated by the generation
  // task from the registered wait-time reference sites' aggregates.
  // Mandatory for attraction rows (0 is a real value and is shown too);
  // null for other kinds that carry no queue estimate, and for plan sets
  // generated before this column existed.
  estWaitMin: integer("est_wait_min"),
  // Travel time in minutes from the PREVIOUS item in the plan to this
  // one, computed deterministically at save time by the server (never
  // by the generation task): straight-line distance between the two
  // facilities' coordinates (facility dictionary) at the set's
  // walking speed, scaled by a distance-dependent detour factor,
  // max'ed with the area-to-area matrix value when a pair exists,
  // then always ×1.2 margin, rounded up, minimum 5. Null when the leg
  // could not be computed (either facility's coordinates unknown —
  // the leg is then 未確認 and verified with the legacy floor), for
  // the first item of a plan, and for plan sets saved before this
  // column existed.
  travelMin: integer("travel_min"),
  lat: real("lat"),
  lng: real("lng"),
  // Owned copy (ctx.blobs) of the facility's intro photo. Null when no
  // photo could be obtained for the item; the row then renders without
  // one. imageSource says where the photo came from: "official" (the
  // facility's official detail-page main visual) or "reference" (a
  // fallback photo from Wikimedia Commons, used when the official photo
  // could not be obtained in the runtime environment).
  imageBlobKey: text("image_blob_key"),
  imageSource: text("image_source", { enum: ["official", "reference"] }),
  // URL of the facility's official detail page, recorded by the
  // generation / image-fetch agent from the page it actually opened.
  // Null when no detail page could be confirmed; the row then renders
  // without an official-page link (URLs are never guessed).
  officialUrl: text("official_url"),
});

// Facility dictionary （施設辞書）: a runtime cache of STATIC facility
// attributes, filled ONLY from data actually fetched at runtime
// (generation / image-fetch tasks) — never bundled, never seeded.
// Keyed by park + normalized facility name. Only static attributes
// live here; anything date-dependent (park hours, closures, show
// times) is NEVER cached and is re-confirmed per target date, and
// wait-time estimation material is re-fetched on every generation.
//
// Freshness is tracked per attribute GROUP, because the groups age
// differently:
// - Coordinates (coordsFetchedAt): effectively never expire — once
//   resolved, a facility's position does not move.
// - Static attributes (staticFetchedAt: area / official URL / official
//   duration): long-lived; re-fetched only after STATIC_ATTR_TTL.
// - Photo (imageFetchedAt + imageBlobKey/imageSource): long-lived;
//   re-fetched only after IMAGE_TTL.
// A null fetched-at means that group was never fetched for the row.
export const facilities = sqliteTable(
  "facilities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    park: text("park", { enum: ["land", "sea"] }).notNull(),
    // Normalized facility name (see facilityNameKey in actions.ts):
    // NFKC, whitespace removed, lower-cased. The lookup key together
    // with park.
    nameKey: text("name_key").notNull(),
    // The facility's name as fetched (official spelling when known).
    name: text("name").notNull(),
    area: text("area"),
    officialUrl: text("official_url"),
    // Official duration （所要時間） in minutes, when the official page
    // states one.
    durationMin: integer("duration_min"),
    // Restaurant classification （レストラン分類）, restaurants only.
    // LEGACY — no longer read by any display: the classification
    // moved to the grounded restaurant fact layer (restaurant_facts
    // above), after a label-inferred value recorded here proved
    // wrong (a counter-service restaurant marked 予約必須 because a
    // separate show-dining area of the same name requires one).
    // The columns stay so the recorded history is not rewritten;
    // displays derive ONLY from restaurant_facts. reservationType:
    // "required" = 予約必須 (show restaurants — no entry without an
    // advance reservation), "ps" = プライオリティ・シーティング対象
    // (advance seating bookable, walk-in also possible), "none" =
    // no reservation route exists, "unknown" = the official page
    // was read but the point could not be determined from its
    // wording. mobileOrder: "available" = モバイルオーダー対象,
    // "unavailable" = 対象外, "unknown" = could not be determined.
    // Null = never classified (no fetch has recorded it yet); the
    // display derivation treats null exactly like "unknown"
    // （未確認） — a classification is NEVER guessed, and an
    // unreadable point never falls back to "none"/"unavailable".
    // Plan rows carry no classification of their own: the plan
    // screen and the PDF derive the row's display from THIS
    // dictionary entry at read time, so rows saved before the
    // classification existed gain the display without any rewrite.
    reservationType: text("reservation_type", {
      enum: ["required", "ps", "none", "unknown"],
    }),
    mobileOrder: text("mobile_order", {
      enum: ["available", "unavailable", "unknown"],
    }),
    lat: real("lat"),
    lng: real("lng"),
    // Owned copy (ctx.blobs) of the facility's intro photo, shared by
    // every plan item of this facility instead of re-downloaded per
    // plan set.
    imageBlobKey: text("image_blob_key"),
    imageSource: text("image_source", { enum: ["official", "reference"] }),
    coordsFetchedAt: integer("coords_fetched_at", {
      mode: "timestamp_ms",
    }),
    staticFetchedAt: integer("static_fetched_at", {
      mode: "timestamp_ms",
    }),
    imageFetchedAt: integer("image_fetched_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("facilities_park_name_key").on(t.park, t.nameKey)],
);

// ---------- normalized source layer （正規化ソース層） ----------
//
// Canonical official sources are stored RAW on every fetch
// (source_snapshots), then read into a common structure — one fact
// row per facility (normalized_facts) — grouped per construction run
// (fact_builds). The DPA gate in savePlanSet / savePlanReplacement /
// savePlanVerification judges ONLY against these facts; the old
// segment-based text extraction over a snapshot is no longer a
// judgement source anywhere.

// One raw fetch of one canonical source page, stored verbatim.
export const sourceSnapshots = sqliteTable("source_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Which canonical source this is: the Premier Access page, the
  // full facility list (attractions + entertainment — the mother set
  // for fact completeness), the target date's operations page
  // (hours / closures), the show schedule, ticket prices, or the
  // announcements / news list.
  kind: text("kind", {
    enum: [
      "dpa_page",
      "facility_list",
      "operations",
      "show_schedule",
      "ticket_prices",
      "announcements",
      // The target month's calendar page (park hours for the month)
      // and the park's restaurant list page — nodes of the
      // acquisition plan tree (v3). Neither carries count
      // declarations the server can recount in the DPA/list sense,
      // so snapshots of these kinds are material, never the grounds
      // of a normalized fact build by themselves.
      "monthly_calendar",
      "restaurant_list",
      // One restaurant's official detail page, stored verbatim as
      // the grounds for that restaurant's facts (restaurant_facts).
      // Not a canonical-source kind: detail pages carry no count
      // declarations, so they never become canonical — restaurant
      // fact registration instead machine-checks excerpts and
      // marker absence against the stored text itself.
      "restaurant_detail",
    ],
  }).notNull(),
  park: text("park", { enum: ["land", "sea"] }).notNull(),
  // The date the page is ABOUT (date-layer sources only: operations,
  // show_schedule); null for undated sources.
  targetDate: text("target_date"),
  url: text("url").notNull(),
  title: text("title"),
  // The page's text exactly as fetched — never excerpted, summarized
  // or transcribed. Fact evidence excerpts are verified as verbatim
  // substrings of this text at registration time.
  rawText: text("raw_text").notNull(),
  // Identifies one fetch run: every snapshot one task fetched in a
  // single pass shares a batch id.
  batchId: text("batch_id").notNull(),
  // How this text was fetched (browser / text / script / …), recorded
  // by the fetching task at save time — saveSourceSnapshots REQUIRES
  // it. Rows saved before the canonical-provenance layer existed
  // carry "legacy_unknown" (migration 0028): their method was never
  // recorded, which is exactly the gap this column closes.
  fetchMethod: text("fetch_method").notNull().default("legacy_unknown"),
  // Canonical flag (0/1), decided by the SERVER at save time — never
  // by the task. 1 only when the save carried a fetch method AND a
  // completeness declaration whose result was "passed" AND the
  // server's own machine check (declared section counts vs the
  // items actually enumerated) found no mismatch AND at least one
  // machine-verifiable anchor exists in the text itself (a priced
  // 「全N件」 section whose priced items recount to the declaration,
  // or an unpriced 「…一覧 N件」 enumeration whose rows recount to
  // it — revision X: a text with no machine-readable declaration
  // has zero mismatches by construction, so a free-text declaration
  // alone must never canonicalize it). A partial text therefore can
  // never silently become canonical.
  // Legacy rows are 0: they never passed a completeness check.
  // Existing fact builds and saved plans do NOT consult this flag
  // (they judged against the snapshots as stored); only NEW fact
  // registration (saveNormalizedFacts) requires canonical grounds.
  canonical: integer("canonical").notNull().default(0),
  // JSON record of the completeness check at save time: the task's
  // declaration (expectation source / expectation / result) plus the
  // server machine check's outcome (sections checked, mismatches).
  // Null for legacy rows (never checked).
  completenessNote: text("completeness_note"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One fact-construction run: the AI read of one set of snapshots,
// normalized into per-facility facts (normalized_facts rows point
// here). Completeness is judged against the mother set — the
// facility names of the build's facility_list snapshot — and the
// summary is stored with the build: a build with ANY mother-set
// facility missing a fact is incomplete, and an incomplete build
// can never pass a DPA row at the gate.
export const factBuilds = sqliteTable("fact_builds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  park: text("park", { enum: ["land", "sea"] }).notNull(),
  // The visit date the build was constructed for (the run's target
  // date); period judgement itself happens per plan set at the gate.
  visitDate: text("visit_date"),
  // JSON array of the source_snapshots ids this build read from.
  snapshotIdsJson: text("snapshot_ids_json").notNull(),
  // The facility_list snapshot whose facility names form the mother
  // set for the completeness check.
  universeSnapshotId: integer("universe_snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  universeCount: integer("universe_count").notNull(),
  eligibleCount: integer("eligible_count").notNull().default(0),
  notEligibleCount: integer("not_eligible_count").notNull().default(0),
  unknownCount: integer("unknown_count").notNull().default(0),
  // JSON array of {name, reason} for every unknown fact in the build.
  unknownJson: text("unknown_json"),
  // JSON array of mother-set facility names that got NO fact row;
  // empty exactly when the build is complete.
  missingJson: text("missing_json"),
  complete: integer("complete").notNull().default(0),
  // ---- value-fidelity diff gate (値の忠実さ, 2026-11-16) ----
  // At registration, saveNormalizedFacts diffs every fact that also
  // exists (non-unknown on both sides) in the park's latest complete,
  // non-invalidated build — the BASELINE — and records the outcome
  // here. A price change or an eligibility flip is accepted only
  // when the new fact carries a strictly newer effectiveFrom; an
  // accepted change is recorded in valueChangesJson (never silent),
  // an unproven one is knocked down to unknown server-side and
  // recorded in valueDiffKnockdownsJson, and any knockdown makes
  // the build incomplete even when nothing is missing.
  // The baseline build this build was diffed against; null when the
  // park had no earlier complete build (first build: no diff check).
  baselineBuildId: integer("baseline_build_id"),
  // JSON array of {name, field: "price"|"status", oldValue,
  // newValue, effectiveFrom} — changes accepted as legitimate
  // because the new fact's effectiveFrom is newer than the
  // baseline's. Values are display strings (e.g. "1,500円", "対象").
  valueChangesJson: text("value_changes_json"),
  // JSON array of {name, field: "price"|"status", baselineValue,
  // submittedValue, reason} — facts the diff gate knocked down to
  // unknown because their value differed from the baseline without
  // a newer effectiveFrom to justify the change.
  valueDiffKnockdownsJson: text("value_diff_knockdowns_json"),
  // Invalidation (invalidateFactBuild): when set, this build is no
  // longer treated as complete / canonical — complete is forced to
  // 0 and baseline selection skips it. The build's facts and
  // snapshots are never deleted; only its standing is revoked.
  invalidatedAt: integer("invalidated_at", { mode: "timestamp_ms" }),
  invalidatedReason: text("invalidated_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One facility's normalized DPA fact within one build: its DPA
// status, the unit price when eligible, the application period when
// the source states one, and the grounds — a verbatim excerpt of the
// referenced snapshot's raw text (machine-checked at registration),
// or, for not_eligible, optionally an excerpt of the mother-set
// (facility_list) snapshot naming the facility, since absence from
// the DPA page cannot itself be excerpted; evidenceKind keeps the
// two grounds apart.
export const normalizedFacts = sqliteTable("normalized_facts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  buildId: integer("build_id")
    .notNull()
    .references(() => factBuilds.id),
  park: text("park", { enum: ["land", "sea"] }).notNull(),
  name: text("name").notNull(),
  // Normalized lookup key (facilityNameKey normalization).
  nameKey: text("name_key").notNull(),
  status: text("status", {
    enum: ["eligible", "not_eligible", "unknown"],
  }).notNull(),
  // Unit price in JPY; set only for eligible facts.
  priceJpy: integer("price_jpy"),
  // Application period as ISO dates; null = unbounded on that side.
  effectiveFrom: text("effective_from"),
  effectiveTo: text("effective_to"),
  // Why the status could not be determined; required for unknown.
  unknownReason: text("unknown_reason"),
  // How the fact is grounded: "excerpt" = a verbatim excerpt of the
  // evidence snapshot (normally the DPA page) states the fact;
  // "universe_listing" = the facility appears in the mother-set
  // snapshot but not on the DPA page (the not_eligible ground).
  evidenceKind: text("evidence_kind", {
    enum: ["excerpt", "universe_listing"],
  })
    .notNull()
    .default("excerpt"),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  // Verbatim substring of that snapshot's raw text (machine-checked
  // at registration; for eligible facts it must contain the price
  // and any period dates the fact carries).
  evidence: text("evidence").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------- restaurant fact layer （レストラン事実レイヤー) ----------
//
// One restaurant's normalized facts, read from that restaurant's OWN
// official detail page — the same snapshot → grounded-fact discipline
// as the DPA layer (normalized_facts), replacing the facility
// dictionary's classification columns (facilities.reservationType /
// mobileOrder, kept as unread legacy). One row per registration; the
// newest row for a park + name_key is the current fact, and a fact is
// valid for 180 days from registration (the dictionary TTL discipline).
//
// Each axis (reservation / mobile order) carries its own grounds:
// - evidenceKind "excerpt": `evidence` is a verbatim substring of the
//   referenced snapshot's raw text and must contain a phrase that
//   supports the classified value (machine-checked at registration).
// - evidenceKind "absence" (negative values only — reservation
//   "none" / mobile order "not_available"): the grounds are the
//   FULL detail-page snapshot plus the server's own machine check
//   that none of the axis's presence markers occur anywhere in that
//   text; the markers actually checked are recorded in
//   `absenceMarkersJson`, and `evidence` is a verbatim excerpt of
//   the snapshot naming the facility (the identity anchor).
// - "unknown" axes carry a mandatory reason and are never silently
//   folded into a negative value.
// A classification is NEVER inferred from a label (e.g. "show
// restaurant, therefore required"): it is read only from the
// facility's own official page text, or not registered at all.
export const restaurantFacts = sqliteTable("restaurant_facts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  park: text("park", { enum: ["land", "sea"] }).notNull(),
  // The restaurant's name as on its official page, and the
  // normalized lookup key (facilityNameKey normalization).
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  // Service type as stated on the official page (e.g.
  // カウンターサービス / テーブルサービス); machine-checked at
  // registration to appear verbatim in the snapshot text. Null when
  // the page states none that could be confirmed.
  serviceType: text("service_type"),
  reservationType: text("reservation_type", {
    enum: ["required", "ps", "none", "unknown"],
  }).notNull(),
  reservationEvidenceKind: text("reservation_evidence_kind", {
    enum: ["excerpt", "absence"],
  }).notNull(),
  // Verbatim substring of the snapshot's raw text (see above).
  reservationEvidence: text("reservation_evidence").notNull(),
  // JSON array of the presence markers the server verified ABSENT
  // from the full snapshot text; set only for absence grounds.
  reservationAbsenceMarkersJson: text("reservation_absence_markers_json"),
  // Why the reservation form could not be determined; required when
  // reservationType is "unknown".
  reservationUnknownReason: text("reservation_unknown_reason"),
  mobileOrder: text("mobile_order", {
    enum: ["available", "not_available", "unknown"],
  }).notNull(),
  mobileEvidenceKind: text("mobile_evidence_kind", {
    enum: ["excerpt", "absence"],
  }).notNull(),
  mobileEvidence: text("mobile_evidence").notNull(),
  mobileAbsenceMarkersJson: text("mobile_absence_markers_json"),
  mobileUnknownReason: text("mobile_unknown_reason"),
  // The restaurant_detail snapshot of THIS facility's official
  // detail page that grounds both axes.
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------- acquisition plan layer v3 （取得計画層） ----------
//
// The acquisition of the canonical sources is split into a PLAN
// layer and an EXECUTION layer (owner's design, 2026-11-19,
// finalised as "acquisition plan v3"). The plan is a TREE built
// from the official sitemap
// (https://www.tokyodisneyresort.jp/sitemap.xml, a plain HTTP GET
// — no browser): each node is one page of the tree plus its
// operations and its anchor. What is stored is only what the
// rebuild decision needs: the sitemap URL set restricted to the
// branches the plan uses (acquisition_plans.sitemap_urls_json),
// the tree itself (acquisition_plan_nodes), and the plan's
// creation instant. There is ONE clock: plan and snapshots are
// valid for 3 hours. The rebuild decision is made from the clock
// and the sitemap GET alone (never a browser fetch); after expiry,
// the first turn rebuilds the whole tree from the sitemap (never a
// partial revision), and that rebuild's fetches double as the
// run's execution material. If the sitemap's URL set shows no
// added / removed / moved branch among the ones the plan uses,
// the skeleton counts as identical. There are no per-row states,
// no revision flags and no fact-build reuse in v3: fact building
// always happens from the current run's material.
//
// acquisition_plans: the single plan record (one row).
export const acquisitionPlans = sqliteTable("acquisition_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The sitemap the plan was built from.
  sitemapUrl: text("sitemap_url").notNull(),
  // JSON array of sitemap URL paths (Japanese tree only) under the
  // branches the plan uses — the basis of the skeleton comparison
  // at the next rebuild.
  sitemapUrlsJson: text("sitemap_urls_json").notNull(),
  // Total number of URLs in the sitemap at build time (context for
  // the subset above).
  sitemapTotalCount: integer("sitemap_total_count").notNull(),
  // When this plan (tree) was built. The 3-hour clock runs from
  // here for the plan; snapshot freshness runs from each
  // snapshot's own fetched_at.
  planCreatedAt: integer("plan_created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // When the sitemap was actually fetched for this build (server
  // wall clock; planCreatedAt may be an evaluation instant a test
  // supplied via planAcquisition's atTime).
  sitemapFetchedAt: integer("sitemap_fetched_at", {
    mode: "timestamp_ms",
  }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One node of the plan tree: a page, how to fetch it (operations),
// and what must hold in its text (anchor). scope "common" = one
// page shared by both parks (its snapshots are still stored per
// park); scope "park" = one page per park, its URL template
// carrying {P} (tds/tdl) and, for the daily node, {D} (target date
// YYYYMMDD). Common rules for every node: no scrolling anywhere;
// an expansion ends only when the enumerated count equals the
// declared count (the anchor — never a button's presence or
// wording); the non-target park's side is never opened; identity
// is judged by the fetched page's own anchor, never by a separate
// check page.
export const acquisitionPlanNodes = sqliteTable("acquisition_plan_nodes", {
  nodeKey: text("node_key").primaryKey(),
  scope: text("scope", { enum: ["common", "park"] }).notNull(),
  // JSON array of the source_snapshots kinds this node produces
  // (the daily node produces both "operations" and
  // "show_schedule").
  kindsJson: text("kinds_json").notNull(),
  // URL path template with {P} / {D} placeholders, relative to
  // https://www.tokyodisneyresort.jp/.
  urlTemplate: text("url_template").notNull(),
  // Fragment matched against a stored snapshot's URL to decide
  // which node that snapshot belongs to. (One anchor-based
  // exception for the facility_list nodes lives in
  // snapshotMatchesPlanNode in actions.ts: the attraction page
  // enumerates both lists, so a snapshot whose verified anchors
  // cover the show list also belongs to the show node.)
  urlMatch: text("url_match").notNull(),
  // URL fragments carrying the page state for a direct open (the
  // DPA node's per-park tab + expansion state). Null elsewhere.
  stateFragmentLand: text("state_fragment_land"),
  stateFragmentSea: text("state_fragment_sea"),
  // The operations column: the exact procedure for fetching this
  // node (main / fallback), in the plan's fixed vocabulary.
  operations: text("operations").notNull(),
  // The anchor column: what must hold in the fetched text for the
  // node to count as verified.
  anchor: text("anchor").notNull(),
  note: text("note"),
  // JSON object {land: boolean, sea: boolean}: whether this
  // node's branch existed in the sitemap the plan was built from,
  // per park. A node whose branch is gone is skipped by
  // planAcquisition for that park (premise breakage, surfaced —
  // never silently fetched at a dead URL).
  branchParksJson: text("branch_parks_json").notNull(),
});

// The restaurant detail pages hanging under each park's
// restaurant-list node (the tree's leaves). Their acquisition is
// storehouse-first (the Cloudflare storehouse's bundle), so the
// plan only needs the registry of known leaf URLs: learned from
// the storehouse (its registered list / bundle) and from this
// copy's own restaurant_detail snapshots.
export const acquisitionRestaurantLeaves = sqliteTable(
  "acquisition_restaurant_leaves",
  {
    url: text("url").primaryKey(),
    park: text("park", { enum: ["land", "sea"] }).notNull(),
    // Where this copy learned the URL: "storehouse" (the
    // storehouse's list or bundle) or "snapshot" (its own stored
    // restaurant_detail snapshot).
    source: text("source", { enum: ["storehouse", "snapshot"] })
      .notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
);

// Area-to-area travel matrix （エリア間マトリクス）: typical walking
// minutes between two areas of one park, accumulated at runtime from
// web guide sources — the same "the user's own DB accumulates what
// was actually fetched" pattern as the facility dictionary. Nothing
// is bundled: rows appear only when a generation/research task (or
// the build-time initial survey) actually read a source page and
// recorded it here with its title, URL and fetch date.
//
// `minutes` is stated at the AREA_MATRIX baseline speed — 少しゆっくり
// (70 m/min) — and converted to the set's walking speed at use time
// (minutes × 70 / speed). The pair is stored canonically (areaAKey <
// areaBKey by normalized key) so direction never matters. A missing
// pair is not an error: the travel computation then uses the
// distance-based value alone.
export const areaTravelTimes = sqliteTable(
  "area_travel_times",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    park: text("park", { enum: ["land", "sea"] }).notNull(),
    // Official area names as displayed (e.g. メディテレーニアンハーバー).
    areaA: text("area_a").notNull(),
    areaB: text("area_b").notNull(),
    // Normalized keys (facilityNameKey normalization), canonical order.
    areaAKey: text("area_a_key").notNull(),
    areaBKey: text("area_b_key").notNull(),
    // Typical walking minutes between the two areas at 70 m/min.
    minutes: integer("minutes").notNull(),
    // Provenance of this value: the guide page it was read from and
    // the date it was fetched. Null only for rows written before
    // provenance was recorded (none should exist).
    sourceTitle: text("source_title"),
    sourceUrl: text("source_url"),
    fetchedAt: text("fetched_at"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("area_travel_times_park_pair").on(
      t.park,
      t.areaAKey,
      t.areaBKey,
    ),
  ],
);

// ------------------------------------------------------------ run logs
//
// Per-execution process record （過程記録） for the long-running
// operations — whole-set generation, same-day search, and partial
// replacement (owner's decision, 2026-11-19). One run_logs row per
// execution (a retry is a NEW execution with its own row), tied to
// the plan set it worked on; run_log_events holds the timestamped
// trail: phase boundaries （取得 / ファクト構築 / 下書き / 保存・検証）,
// one start/end pair per fetched page, and one start/end pair per
// AI-driven step, each with the step's label. The record exists so
// that when a run stops midway, "where, and inside which call, it
// stopped" can always be identified afterwards.
//
// A run is ALWAYS closed exactly once: outcome succeeded (saved),
// failed (a reported reason, or — when the task died without
// reporting — an explicit 理由不明）, cancelled (user), or
// interrupted (superseded by a retry's new run). Closing derives
// the last completed phase and the in-progress step from the event
// trail and records the elapsed time, so a closed record never
// leaves the reader guessing. Rows survive plan-set deletion (the
// forensic value is precisely for runs whose set is gone); the
// full reset wipes them with everything else.
export const runLogs = sqliteTable("run_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planSetId: integer("plan_set_id").notNull(),
  kind: text("kind", { enum: ["generation", "same_day", "partial"] })
    .notNull(),
  // Target slot for a partial replacement; null for whole-set runs.
  slot: text("slot", { enum: ["A", "B", "C"] }),
  status: text("status", { enum: ["open", "closed"] })
    .notNull()
    .default("open"),
  outcome: text("outcome", {
    enum: ["succeeded", "failed", "cancelled", "interrupted"],
  }),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  // Why the run closed. For a failure this states the last
  // completed phase, the step in progress, the elapsed time and
  // the reason — or explicitly 理由不明 when no reason was ever
  // reported. Null while the run is open.
  closeReason: text("close_reason"),
  // Phase keys (acquisition / fact_build / research / drafting /
  // save_verify), maintained from the event trail as events are
  // appended.
  lastCompletedPhase: text("last_completed_phase"),
  currentPhase: text("current_phase"),
});

export const runLogEvents = sqliteTable("run_log_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  at: integer("at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  eventType: text("event_type", {
    enum: [
      "run_open",
      "phase_start",
      "phase_end",
      "fetch_start",
      "fetch_end",
      "ai_call_start",
      "ai_call_end",
      "note",
      "run_close",
    ],
  }).notNull(),
  phase: text("phase", {
    enum: ["acquisition", "fact_build", "research", "drafting", "save_verify"],
  }),
  // What this event is about, in the reporter's own words (a page
  // name / URL for a fetch, a step name for an AI call).
  label: text("label").notNull(),
  detail: text("detail"),
});

// ------------------------------------------------- Task manager （裏タスク管理・検証6）
//
// The background-task manager (owner's design, 2026-11-20): the
// server side owns ALL control of background tasks and never
// trusts them. The only instructions ever given to a task are
// "start" (a spawn whose assignment is to call this attempt's own
// record action) and "cancel" (the attempt is closed server-side;
// a late record call for a closed attempt is refused). A task is
// unstable by premise: it may never start, or start and then stop
// without a word. The server can only cancel and retry.
//
// ALL state lives in these tables — spawn instant, attempt
// number, deadlines, status — never in memory, so closing the app
// or Muse itself loses nothing. A periodic server-side check
// (checkTaskManager, run on a schedule) judges deadlines purely
// from the recorded instants:
// - no first record call within startTimeoutSec of the spawn →
//   the attempt is closed as cancelled and a new attempt starts;
// - started but not finished within totalTimeoutSec of the spawn
//   → same;
// - attempts exhausted → the run closes as "forced"
//   （試行回数を超えたので強制終了）. A run's final state is ONLY
//   "succeeded" or "forced" — it never stays "running" forever.
// Parameters are per kind (task_mgr_params), editable at runtime.
//
// Since the production integration (2026-11-20), this layer IS
// the single entry point for the app's production background
// tasks: plan creation (kinds 11: whole-set generation, partial
// replacement, day-of reschedule), same-day search (12), chat
// research (13), bulk re-verification (14), the wait-time
// reference site list update (15), the facility image fetch
// (16) and the one-time restaurant fact correction (17) all
// start ONLY through the manager — no production path spawns a
// task directly. A production run carries its target in
// target_json (which plan set / slot / research request /
// verification request it works on); retries re-run the SAME
// target, and a plan set is created exactly once, by the
// server, before the first attempt. Kinds 1..10 remain the
// manager's own test kinds, driven by task_mgr_tests.
export const taskMgrParams = sqliteTable("task_mgr_params", {
  // Task kind 1..10 (manager test) or 11..17 (production; see
  // TASK_MGR_KINDS / TASK_MGR_PROD_KINDS in actions.ts).
  kind: integer("kind").primaryKey(),
  startTimeoutSec: integer("start_timeout_sec").notNull(),
  totalTimeoutSec: integer("total_timeout_sec").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
});

// One test run of the manager: 100 executions, kinds cycling
// 1→10, strictly one at a time. Status: running / done (all 100
// closed) / cancelled (the whole-test cancel button).
export const taskMgrTests = sqliteTable("task_mgr_tests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", { enum: ["running", "done", "cancelled"] })
    .notNull()
    .default("running"),
  total: integer("total").notNull().default(100),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  closeReason: text("close_reason"),
});

// One execution: within a test (one of the 100) or, since the
// production integration, one production processing run. A test
// run's final state is only "succeeded" or "forced";
// "cancelled" appears when the whole test was cancelled
// mid-execution, when a production run's target was cancelled by
// the user, or when a newer start superseded the run.
export const taskMgrRuns = sqliteTable("task_mgr_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The owning test; null for production runs.
  testId: integer("test_id"),
  // 1..100 within the test; 0 for production runs.
  seq: integer("seq").notNull().default(0),
  kind: integer("kind").notNull(),
  status: text("status", {
    enum: ["running", "succeeded", "forced", "cancelled"],
  })
    .notNull()
    .default("running"),
  finalReason: text("final_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  // Production runs only: the spawn target as JSON — what this
  // run works on ({type:"generation"|"same_day", planSetId} /
  // {type:"partial", planSetId, slot} / {type:"research",
  // researchId} / {type:"verification", requestId} /
  // {type:"wait_sources", requestId} / {type:"item_images",
  // planSetId} / {type:"restaurant_correction"}). A retry
  // re-runs exactly this target; the completion hooks and the
  // periodic check find the run through it. Null on test runs.
  targetJson: text("target_json"),
});

// One attempt of one execution. spawnedAt / deadlines are stamped
// by the SERVER at spawn time from the kind's parameters; the
// first record call (firstCallAt) is the only accepted evidence
// that the task started. A closed attempt refuses late calls.
export const taskMgrAttempts = sqliteTable("task_mgr_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  status: text("status", {
    enum: ["awaiting_start", "running", "succeeded", "cancelled"],
  })
    .notNull()
    .default("awaiting_start"),
  spawnedAt: integer("spawned_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  startDeadlineAt: integer("start_deadline_at", {
    mode: "timestamp_ms",
  }).notNull(),
  totalDeadlineAt: integer("total_deadline_at", {
    mode: "timestamp_ms",
  }).notNull(),
  firstCallAt: integer("first_call_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  closeReason: text("close_reason"),
});

// One record call from a task to its attempt's record action.
// calledAt is the SERVER's receipt stamp. savedText holds the
// page text for the kinds that save one (6 / 9 / 10), truncated
// server-side; textLength is the full length the task reported
// by passing the text.
export const taskMgrCalls = sqliteTable("task_mgr_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attemptId: integer("attempt_id").notNull(),
  phase: text("phase").notNull(),
  calledAt: integer("called_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  note: text("note"),
  textLength: integer("text_length"),
  savedText: text("saved_text"),
});

// A dialog notice raised by the task manager: when one of the
// three auxiliary production processings (wait-time reference
// site list update / facility image fetch / one-time restaurant
// fact correction — kinds 15..17) exhausts its attempts, the
// failure is surfaced to the user as an in-app dialog carrying
// the one common congestion text, not on a plan tab or in the
// chat. getState offers the oldest unshown notice; the client
// captures it into a dialog and marks it shown
// (markMgrDialogShown), so each notice is displayed once.
export const mgrDialogNotices = sqliteTable("mgr_dialog_notices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  shownAt: integer("shown_at", { mode: "timestamp_ms" }),
});
