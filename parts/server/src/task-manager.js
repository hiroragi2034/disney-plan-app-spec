// ============================================================================
// タスク管理クラス (task manager) — 単独で読める書き出し
// ----------------------------------------------------------------------------
// 出どころ: Muse スペース「我が家のディズニー計画」のサーバー側実装
// (server/src/actions.ts の Task manager 節) の最終形を、仕様書の
// パーツ集のために 1 ファイルに書き出したもの。検証6 で作ったテスト用
// 管理クラスに、本番の7系統 (プラン作成・当日検索・調べ物・一括検証・
// 待ち時間サイト一覧の更新・施設画像の取得・レストラン事実の訂正) を
// すべて組み込んだ状態を含む。本番のタスクは例外なくこの管理クラス
// の下にある (直接起動として残るのは、この管理クラス内部の起動と、
// 診断用のデバッグ実行だけ。下の「組み込み口」を参照)。
//
// 読み方: このファイルは、そのままでは単独で動かない。ホスト側が
// 下の「ホストが用意するもの」を提供し、「組み込み口」に従って
// 処理の開始・完了をこのクラスに接続することで動く。DB アクセスは
// ホストの DB 層への薄い呼び出しとして書いてある (実装では drizzle)。
//
// 設計 (持ち主の決まり):
// - 管理する側の状態は1つだけ。状態はすべて DB に置く (メモリに数えない)。
// 同時に複数の処理が走っても、見る状態はこの1組のテーブルだけ。
// - サーバーはタスクを信用しない。タスクへの指示は「開始」(spawn) と
// 「キャンセル」(サーバー側で試行を閉じる。タスクには伝えない) だけ。
// - 「始まった」の印 = その試行でタスクが最初に記録アクション
// (recordTaskAttempt) を呼んだ時点。
// - 「終わった」の印 = その処理の通常の完了をサーバー側で確認した時点
// (本番: プラン作成・当日検索は生成の記録が閉じて通知が出ること、
// 調べ物は回答が投稿されること、一括検証は結果が投稿されること、
// 待ち時間サイト一覧の更新・施設画像の取得・レストラン事実の訂正は
// それぞれの報告アクションが呼ばれること)。
// - 期限の判定は、1分ごとの定期チェック (checkTaskManager) が記録された
// 時刻だけから行う:
// - 開始待ちの制限時間内に最初の記録が無い → 試行を閉じて再試行。
// - 全体の制限時間内に終わらない → 試行を閉じて再試行。
// - 試行回数を使い切る → 実行を「強制終了」として閉じ、異常終了の
// 出し方 (系統ごとに決まった場所・共通文面) を適用する。
// - リトライは同じ対象に対して行う。プランのセットはサーバーが最初に
// 1つだけ作り、リトライで増やさない。補助3系統 (種類15〜17) でも、
// 依頼の行は最初に1つだけ作り、リトライはその同じ行に対して行う。
//
// 異常終了のダイアログ表示 (種類15〜17):
// - 補助3系統が試行を使い切ると、共通文面を mgr_dialog_notices に
// 1件記録する。状態取得 (getState) が未表示のうち最も古いものを
// 返し、クライアントはそれを受け取った瞬間にダイアログとして
// 取り込み、同時に表示済みの記録 (markMgrDialogShown) を付ける。
// したがって各通知はちょうど1回だけ表示される。前日ダイアログと
// お知らせダイアログが立っている間は譲り、それらが消えてから出る。
//
// ホストが用意するもの:
// - db: 次のテーブルへの select / insert / update (実装は drizzle の
// ctx.db)。テーブル定義は末尾の「DB テーブル契約」を参照。
// - spawnTask(assignment, { expectsAction, dedupeKey}) -> { ok} |
// { ok: false, error}: タスクを1つ起動する (実装は ctx.agent.spawnTask)。
// - 処理ごとの開始処理と完了フック (「組み込み口」を参照)。
//
// 組み込み口 (本番7系統):
// - 開始: どの入り口 (フォームのボタン、AIチャットの判定、ダイアログ、
// 購入イベントのボタン、リトライボタン、画像取得ボタン) からでも、
// 処理の開始は beginAttempt(target) -> spawnForAttempt(...) を通す。
// 直接 spawnTask してはいけない。
// - 完了: 処理の通常の完了 (および利用者のキャンセル) の場所で
// finishRunForTarget(target, "finished" | "cancelled") を呼ぶ。
// - 記録: 起動されたタスクは、他のどのアクションよりも先に
// recordTaskAttempt(attemptId, "start") を1回呼ぶ (spawnForAttempt が
// 課題文の先頭にその指示を付ける)。
// ============================================================================

"use strict";

// ----------------------------------------------------------------------------
// 種類の定義
// ----------------------------------------------------------------------------

// テスト用の10種類 (検証6)。phases は試行が順に完了すべき記録呼び出しの
// 列で、最後の1つが試行を成功として閉じる。テストの各回の種類は、
// この10種類から無作為に1つ選ぶ (順番には回さない)。
const TEST_KINDS = [
{ kind: 1, label: "記録を1回呼んで終了", usesBrowser: false, phases: ["complete"]},
{ kind: 2, label: "記録→3秒待つ→記録", usesBrowser: false, phases: ["start", "end"]},
{ kind: 3, label: "記録を3回、順に呼ぶ", usesBrowser: false, phases: ["step", "step", "step"]},
{ kind: 4, label: "記録→10秒待つ→記録", usesBrowser: false, phases: ["start", "end"]},
{ kind: 5, label: "ブラウザでページを1つ開いて閉じる", usesBrowser: true, phases: ["start", "end"]},
{ kind: 6, label: "ブラウザで公式DPAページを読み、文章を保存する", usesBrowser: true, phases: ["start", "end"]},
{ kind: 7, label: "保管庫からレストラン一覧を読む", usesBrowser: false, phases: ["start", "end"]},
{ kind: 8, label: "保管庫からサイトマップを読む", usesBrowser: false, phases: ["start", "end"]},
{ kind: 9, label: "ブラウザで公式の施設一覧ページを読み、文章を保存する", usesBrowser: true, phases: ["start", "end"]},
{ kind: 10, label: "ブラウザで公式ページを2つ読み、文章を保存する", usesBrowser: true, phases: ["start", "end"]},
];

// 本番の7種類 (11..17)。初期値は組み込み時の指定値で、あとから管理タブで
// 変更できる (task_mgr_params に保存される)。本番の試行は記録呼び出しの
// phases では完了しない。完了は処理自身の通常の完了をサーバーが確認する。
// 記録呼び出しは「始まった」の印だけに使う。
const PROD_KINDS = [
{ kind: 11, label: "プラン作成（本番）", startTimeoutSec: 180, totalTimeoutSec: 2400, maxAttempts: 3},
{ kind: 12, label: "当日検索（本番）", startTimeoutSec: 180, totalTimeoutSec: 1800, maxAttempts: 3},
{ kind: 13, label: "調べ物（本番）", startTimeoutSec: 120, totalTimeoutSec: 600, maxAttempts: 3},
{ kind: 14, label: "一括検証（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3},
{ kind: 15, label: "待ち時間サイト一覧の更新（本番）", startTimeoutSec: 120, totalTimeoutSec: 600, maxAttempts: 3},
{ kind: 16, label: "施設画像の取得（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3},
{ kind: 17, label: "レストラン事実の訂正（本番）", startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3},
];

// 試行を使い切った異常終了の共通文面 (逐語固定)。7系統共通で、
// 出す場所だけが系統ごとに違う。
const CONGESTION_TEXT =
"現在museが混雑しています。申し訳ありませんが、しばらく後に再度お試しください。";

// 本番の実行が対象とするもの。実行行の target_json に JSON で保存され、
// リトライはこの対象をそのまま再実行する。
// { type: "generation", planSetId} プラン作成 (全体)
// { type: "same_day", planSetId} 当日検索
// { type: "partial", planSetId, slot} 部分差し替え / 当日リスケ
// { type: "research", researchId} 調べ物
// { type: "verification", requestId} 一括検証
// { type: "wait_sources", requestId} 待ち時間サイト一覧の更新
// { type: "item_images", planSetId} 施設画像の取得
// { type: "restaurant_correction"} レストラン事実の訂正 (対象は1件だけ)
function kindForTarget(target) {
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

function targetKey(target) {
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

function parseTarget(json) {
if (!json) return null;
try {
const o = JSON.parse(json);
if (typeof o!== "object" || o === null) return null;
if ((o.type === "generation" || o.type === "same_day") && typeof o.planSetId === "number") {
return { type: o.type, planSetId: o.planSetId};
}
if (o.type === "partial" && typeof o.planSetId === "number" &&
(o.slot === "A" || o.slot === "B" || o.slot === "C")) {
return { type: "partial", planSetId: o.planSetId, slot: o.slot};
}
if (o.type === "research" && typeof o.researchId === "number") {
return { type: "research", researchId: o.researchId};
}
if (o.type === "verification" && typeof o.requestId === "number") {
return { type: "verification", requestId: o.requestId};
}
if (o.type === "wait_sources" && typeof o.requestId === "number") {
return { type: "wait_sources", requestId: o.requestId};
}
if (o.type === "item_images" && typeof o.planSetId === "number") {
return { type: "item_images", planSetId: o.planSetId};
}
if (o.type === "restaurant_correction") {
return { type: "restaurant_correction"};
}
return null;
} catch {
return null;
}
}

// 本番の課題文の先頭に付ける必須指示。「始まった」の証拠は最初の記録
// 呼び出しだけなので、何よりも先に呼ばせる。終了の記録は不要 (完了は
// サーバーが処理自身の完了アクションで検知する)。
function recordPrefix(attemptId) {
return [
``,
`このタスクはタスク管理クラスを通して開始されました。開始の証拠として、他のどのアクションよりも先に、まず recordTaskAttempt（attemptId=${attemptId}, phase="start"）を1回だけ呼んでください。この呼び出しが制限時間内に無い試行は「始まらなかった」ものとしてサーバー側で閉じられ、同じ処理が再試行されます。`,
`終了の記録は不要です（処理の通常の完了——プランの保存・失敗報告・回答の保存など——をサーバーが検知します）。過程記録（recordRunEvent）とは別の呼び出しです。`,
].join("\n");
}

// ----------------------------------------------------------------------------
// パラメータ (種類ごと: 開始待ち / 全体 / 試行回数)
// ----------------------------------------------------------------------------

// task_mgr_params に行が無い場合の予備値。テスト種類は migration で
// 種類定義と同じ値が入り、本番種類は PROD_KINDS の値が入る。
function defaultParams(kind) {
const prod = PROD_KINDS.find((d) => d.kind === kind);
if (prod) {
return {
startTimeoutSec: prod.startTimeoutSec,
totalTimeoutSec: prod.totalTimeoutSec,
maxAttempts: prod.maxAttempts,
};
}
const def = TEST_KINDS[kind - 1]?? TEST_KINDS[0];
return def.usesBrowser
? { startTimeoutSec: 180, totalTimeoutSec: 900, maxAttempts: 3}
: { startTimeoutSec: 120, totalTimeoutSec: 300, maxAttempts: 3};
}

async function paramsFor(db, kind) {
const row = await db.getParams(kind); // task_mgr_params を kind で1行
if (!row) return defaultParams(kind);
return {
startTimeoutSec: row.startTimeoutSec,
totalTimeoutSec: row.totalTimeoutSec,
maxAttempts: row.maxAttempts,
};
}

// ----------------------------------------------------------------------------
// 記録アクション (タスクからの呼び出しを受ける側)
// ----------------------------------------------------------------------------
//
// recordTaskAttempt(attemptId, phase, note?, text?):
// - 試行が無い、または閉じている (成功/キャンセル済み) 場合はエラーで
// 受け付けない。遅れてきた呼び出しは決して通さない。
// - 呼び出しを task_mgr_calls にサーバーの受付時刻で記録する
// (文章はサーバー側で先頭 20000 文字に切り詰めて保存する)。
// - その試行の最初の呼び出しなら first_call_at を打ち、試行を
// awaiting_start → running にする。これが「始まった」の印。
// - 本番種類: 記録は開始の印だけ。完了は finishRunForTarget 側で閉じる。
// - テスト種類: phases の列と順に照合し (期待される次の phase と一致
// した呼び出しだけが進捗を進める)、列を完了したら試行と実行を成功
// として閉じ、テストを次へ進める。
async function onRecordCall(db, host, attemptId, phase, note, text) {
const attempt = await db.getAttempt(attemptId);
if (!attempt) throw new Error("試行が見つかりません");
if (attempt.status === "succeeded" || attempt.status === "cancelled") {
throw new Error("試行は既に閉じています"); // 遅れてきた呼び出しは受けない
}
const run = await db.getRun(attempt.runId);
if (!run) throw new Error("実行が見つかりません");
const now = new Date();
const isFirst = attempt.firstCallAt == null;
await db.insertCall({
attemptId,
phase,
calledAt: now,
note: note?? null,
textLength: text!= null? text.length: null,
savedText: text!= null? text.slice(0, 20000): null,
});
if (parseTarget(run.targetJson)) {
// 本番: 開始の印だけ
if (isFirst) {
await db.updateAttempt(attemptId, { firstCallAt: now, status: "running"});
}
return { ok: true};
}
// テスト種類: phases の完了判定
const def = TEST_KINDS[run.kind - 1]?? TEST_KINDS[0];
const calls = await db.listCalls(attemptId);
let progress = 0;
for (const c of calls) {
if (def.phases[progress] === c.phase) progress += 1;
}
if (progress >= def.phases.length) {
await db.updateAttempt(attemptId, {
status: "succeeded",
firstCallAt: isFirst? now: attempt.firstCallAt,
finishedAt: now,
});
await db.updateRun(run.id, { status: "succeeded", closedAt: now});
await host.advanceTest(run.testId);
} else if (isFirst) {
await db.updateAttempt(attemptId, { firstCallAt: now, status: "running"});
}
return { ok: true};
}

// ----------------------------------------------------------------------------
// テスト側の起動と、試行が閉じた後の決定 (検証6 の動き)
// ----------------------------------------------------------------------------

// 1試行分の起動: 試行行 (開始時刻と2つの期限は、その時点のパラメータ
// からサーバーが打つ) を先に書き、それからその試行専用の課題でタスクを
// 起動する。起動に失敗したら試行をその場でキャンセルとして閉じ、
// タイムアウトと同じ再試行/強制終了の判断に渡す。幽霊の試行は残らない。
async function spawnTestAttempt(db, host, runId) {
const run = await db.getRun(runId);
if (!run || run.status!== "running") return;
const existing = await db.listAttempts(runId);
const attemptNo = existing.length + 1;
const params = await paramsFor(db, run.kind);
const now = new Date();
const attemptId = await db.insertAttempt({
runId,
attemptNo,
spawnedAt: now,
startDeadlineAt: new Date(now.getTime() + params.startTimeoutSec * 1000),
totalDeadlineAt: new Date(now.getTime() + params.totalTimeoutSec * 1000),
});
const spawned = await host.spawnTask(host.buildTestAssignment(attemptId, run.kind), {
expectsAction: "recordTaskAttempt",
dedupeKey: `taskmgr-attempt-${attemptId}`,
});
if (!spawned.ok) {
await db.updateAttempt(attemptId, {
status: "cancelled",
finishedAt: new Date(),
closeReason: `タスクを開始できませんでした: ${spawned.error}`,
});
await afterTestAttemptClosed(db, host, runId);
}
}

// キャンセルされた試行の後: 試行回数が残っていれば再試行、無ければ
// 実行を強制終了として閉じてテストを次へ進める。
async function afterTestAttemptClosed(db, host, runId) {
const run = await db.getRun(runId);
if (!run || run.status!== "running") return "none";
if (run.testId == null) return "none";
const test = await db.getTest(run.testId);
if (!test || test.status!== "running") return "none";
const attempts = await db.listAttempts(runId);
const params = await paramsFor(db, run.kind);
if (attempts.length < params.maxAttempts) {
await spawnTestAttempt(db, host, runId);
return "retried";
}
await db.updateRun(runId, {
status: "forced",
finalReason: "試行回数を超えたので強制終了",
closedAt: new Date(),
});
await host.advanceTest(run.testId);
return "forced";
}

// ----------------------------------------------------------------------------
// 定期チェック (1分ごと、および随時呼び出し可能)
// ----------------------------------------------------------------------------
//
// 開いている全試行 — テストの実行も本番の実行も — を、記録された時刻
// だけから判定する。本番の実行は、まず対象の状態と突き合わせる
// (reconcileProductionTarget): 対象が既に終わっていれば、期限で
// 判定せずに実行をその状態に合わせて閉じる。
// 閉じる理由の秒数は、その試行自身に打たれた窓 (期限 − 開始時刻) を
// 使う。判定時点のパラメータではない (開始後に変更されている場合がある)。
async function runCheck(db, host) {
const now = new Date();
let closedAttempts = 0;
let retriedAttempts = 0;
let forcedRuns = 0;
const openAttempts = await db.listOpenAttempts(); // awaiting_start | running
for (const attempt of openAttempts) {
const run = await db.getRun(attempt.runId);
if (!run || run.status!== "running") continue;
const target = parseTarget(run.targetJson);
if (target) {
// 本番の実行
const reconciled = await reconcileProductionTarget(db, host, target);
if (reconciled) {
await db.updateAttempt(attempt.id, {
status: reconciled === "succeeded"? "succeeded": "cancelled",
finishedAt: now,
closeReason:
reconciled === "succeeded"
? "対象の処理は既に完了していたため、この試行を閉じた"
: "対象の処理は既に終了していたため、この試行を閉じた",
});
await db.updateRun(run.id, {
status: reconciled,
closedAt: now,
finalReason: "対象の処理は既に終了していたため終了",
});
closedAttempts += 1;
continue;
}
const startWindowSec = Math.round(
(attempt.startDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
);
const totalWindowSec = Math.round(
(attempt.totalDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
);
let reason = null;
if (attempt.status === "awaiting_start" && now > attempt.startDeadlineAt) {
reason = `開始待ちの制限時間（${startWindowSec}秒）内に最初の記録が無かったためキャンセル`;
} else if (now > attempt.totalDeadlineAt) {
reason = `全体の制限時間（${totalWindowSec}秒）内に終了しなかったためキャンセル`;
}
if (!reason) continue;
await db.updateAttempt(attempt.id, {
status: "cancelled",
finishedAt: now,
closeReason: reason,
});
closedAttempts += 1;
const outcome = await afterProductionAttemptClosed(db, host, run.id);
if (outcome === "retried") retriedAttempts += 1;
if (outcome === "forced") forcedRuns += 1;
continue;
}
// テストの実行
if (run.testId == null) continue;
const test = await db.getTest(run.testId);
if (!test || test.status!== "running") continue;
const startWindowSec = Math.round(
(attempt.startDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
);
const totalWindowSec = Math.round(
(attempt.totalDeadlineAt.getTime() - attempt.spawnedAt.getTime()) / 1000,
);
let reason = null;
if (attempt.status === "awaiting_start" && now > attempt.startDeadlineAt) {
reason = `開始待ちの制限時間（${startWindowSec}秒）内に最初の記録が無かったためキャンセル`;
} else if (attempt.status === "running" && now > attempt.totalDeadlineAt) {
reason = `全体の制限時間（${totalWindowSec}秒）内に終了しなかったためキャンセル`;
}
if (!reason) continue;
await db.updateAttempt(attempt.id, {
status: "cancelled",
finishedAt: now,
closeReason: reason,
});
closedAttempts += 1;
const outcome = await afterTestAttemptClosed(db, host, run.id);
if (outcome === "retried") retriedAttempts += 1;
if (outcome === "forced") forcedRuns += 1;
}
return { closedAttempts, retriedAttempts, forcedRuns};
}

// ----------------------------------------------------------------------------
// 本番側のコア
// ----------------------------------------------------------------------------

// 試行行を1つ作る (期限はその時点のパラメータから打つ)。
async function insertAttempt(db, runId, kind, attemptNo) {
const params = await paramsFor(db, kind);
const now = new Date();
return await db.insertAttempt({
runId,
attemptNo,
spawnedAt: now,
startDeadlineAt: new Date(now.getTime() + params.startTimeoutSec * 1000),
totalDeadlineAt: new Date(now.getTime() + params.totalTimeoutSec * 1000),
});
}

// 本番の開始はすべてここを通る。実行 + 最初の試行を開く。同じ対象の
// 実行がまだ開いていれば置き換える (利用者が押したリトライがそれに
// あたり、管理クラスが1つの対象に2つの生きた実行を持たないようにする)。
// 呼び出し側は、返った試行に対して spawnForAttempt でタスクを起動する。
async function beginAttempt(db, target) {
const kind = kindForTarget(target);
const key = targetKey(target);
const now = new Date();
const openRuns = await db.listOpenProductionRuns();
for (const r of openRuns) {
const t = parseTarget(r.targetJson);
if (!t || targetKey(t)!== key) continue;
await db.cancelOpenAttemptsOfRun(r.id, {
finishedAt: now,
closeReason: "新しい実行が開始されたため、この試行を閉じた",
});
await db.updateRun(r.id, {
status: "cancelled",
finalReason: "新しい実行が開始されたため終了",
closedAt: now,
});
}
const runId = await db.insertRun({
testId: null,
seq: 0,
kind,
targetJson: JSON.stringify(target),
});
const attemptId = await insertAttempt(db, runId, kind, 1);
return { runId, attemptId};
}

// 開いた試行のタスクを起動する。課題文の先頭に記録の必須指示を付ける。
// 戻り値: "spawned" = この試行のタスクが生きている / "retried" = 再試行
// 側の試行が代わりに生きている / "exhausted" = 生きたタスク無しに実行が
// 解決した (試行を使い切り強制終了の出し方を適用済み、または対象が
// 既に終わっていた)。
async function spawnForAttempt(db, host, att, assignmentBody, opts) {
const spawned = await host.spawnTask(
recordPrefix(att.attemptId) + "\n\n" + assignmentBody,
{
expectsAction: opts.expectsAction,
dedupeKey: `${opts.dedupeKey}-mgr-${att.attemptId}`,
},
);
if (spawned.ok) return "spawned";
await db.updateAttempt(att.attemptId, {
status: "cancelled",
finishedAt: new Date(),
closeReason: `タスクを開始できませんでした: ${spawned.error}`,
});
const outcome = await afterProductionAttemptClosed(db, host, att.runId);
return outcome === "retried"? "retried": "exhausted";
}

// 対象がまだ進行中か (null)、別の経路で既に終わっているか
// ("succeeded" / "cancelled" = 実行を合わせて閉じるべき状態) を返す。
// プランセットの status "failed" は終わりではない (保存時の最低内容
// 不足などは、タスクが回復して保存し直す余地があるため、管理クラスの
// 期限がそのまま支配する)。
// レストラン事実の訂正は、突き合わせる先の状態を持たない (訂正済みの
// 事実が登録されていても、それが前の実行の成果かもしれない)。その
// 終わりは報告アクションからしか分からないので、常に null を返し、
// 期限が支配する。
async function reconcileProductionTarget(db, host, target) {
switch (target.type) {
case "generation":
case "same_day": {
const set = await host.getPlanSet(target.planSetId);
if (!set) return "cancelled";
if (set.status === "done") return "succeeded";
return null;
}
case "partial": {
const set = await host.getPlanSet(target.planSetId);
if (!set) return "cancelled";
const prog = set.progress[target.slot];
if (set.status === "done" && prog!== "generating") return "succeeded";
return null;
}
case "research": {
const r = await host.getResearchRequest(target.researchId);
if (!r) return "cancelled";
if (r.status === "done") return "succeeded";
if (r.status === "failed") return "cancelled";
return null;
}
case "verification": {
const r = await host.getVerificationRequest(target.requestId);
if (!r) return "cancelled";
if (r.status === "done") return "succeeded";
if (r.status === "failed") return "cancelled";
return null;
}
case "wait_sources": {
const r = await host.getWaitSourcesRequest(target.requestId);
if (!r) return "cancelled";
if (r.status === "done") return "succeeded";
if (r.status === "failed") return "cancelled";
return null;
}
case "item_images": {
const set = await host.getPlanSet(target.planSetId);
if (!set) return "cancelled";
if (set.imagesStatus === "done") return "succeeded";
if (set.imagesStatus === "failed") return "cancelled";
return null;
}
case "restaurant_correction": {
return null; // 上のコメントの通り、期限が支配する
}
}
}

// 閉じた本番の試行の後: まず突き合わせ (終わった対象は再試行しない)、
// 次に同じ対象への再試行 (試行回数の範囲内)、最後に強制終了の出し方。
async function afterProductionAttemptClosed(db, host, runId) {
const run = await db.getRun(runId);
if (!run || run.status!== "running") return "none";
const target = parseTarget(run.targetJson);
if (!target) return "none";
const reconciled = await reconcileProductionTarget(db, host, target);
if (reconciled) {
await db.updateRun(runId, {
status: reconciled,
closedAt: new Date(),
finalReason: "対象の処理は既に終了していたため終了",
});
return "none";
}
const attempts = await db.listAttempts(runId);
const params = await paramsFor(db, run.kind);
if (attempts.length < params.maxAttempts) {
await respawnProduction(db, host, run, target);
return "retried";
}
await applyForcedOutcome(db, host, target);
await db.updateRun(runId, {
status: "forced",
finalReason: "試行回数を超えたので強制終了",
closedAt: new Date(),
});
return "forced";
}

// 次の試行の起動: 新しい試行行を先に作り (期限はその時点のパラメータ)、
// 同じ対象の同じ処理を、その処理自身の開始経路でもう一度始める。
// プラン作成・当日検索では、作成中の画面のリトライボタンとまったく
// 同じ再実行 (同じセット、記録された開始入力、セットは増やさない)。
// 施設画像の取得では、不足分を数え直してから始める (辞書や他の
// セットの写真でまかなえる分が増えていることがある)。数え直して
// 不足が無ければ、取得は終わったものとして実行を成功で閉じる。
// レストラン事実の訂正では、訂正済みの事実が既に登録されていれば
// (手作業で直っていた場合など) 起動せず、実行を成功で閉じる。
async function respawnProduction(db, host, run, target) {
const existing = await db.listAttempts(run.id);
const attemptId = await insertAttempt(db, run.id, run.kind, existing.length + 1);
const att = { runId: run.id, attemptId};
switch (target.type) {
case "generation":
case "same_day":
await host.rerunWholeSet(target, att); // リトライボタンと同じ再実行
return;
case "partial":
await host.restartPartial(target, att); // セットに記録された差し替え依頼を再開
return;
case "research":
await host.restartResearch(target, att); // 同じ依頼 (質問) を再開
return;
case "verification":
await host.restartVerification(target, att); // 同じ依頼を再開
return;
case "wait_sources":
await host.restartWaitSources(target, att); // 同じ依頼 (指示文) を再開
return;
case "item_images": {
const missing = await host.collectMissingItemImages(target);
if (missing.length === 0) {
await host.markImagesDone(target.planSetId);
await finishRunForTarget(db, target, "finished");
return;
}
await host.restartItemImages(target, missing, att);
return;
}
case "restaurant_correction": {
const alreadyCorrect = await host.restaurantCorrectionRegistered();
if (alreadyCorrect) {
await finishRunForTarget(db, target, "finished");
return;
}
await host.restartRestaurantCorrection(att);
return;
}
}
}

// 異常終了のダイアログ通知を1件記録する (種類15〜17用)。文面は
// 共通文面そのもの。表示の側は下の「ダイアログ表示」を参照。
async function insertDialogNotice(db) {
await db.insertDialogNotice({ text: CONGESTION_TEXT});
}

// 試行を使い切った異常終了の出し方。文面は7系統共通 (CONGESTION_TEXT)、
// 場所と出し方が系統ごとに違う:
// - プラン作成・当日検索: そのセットのプランのタブに失敗として出す。
// セット (部分差し替えでは対象スロット) を失敗にし、文面をエラー /
// 失敗の記録として残す。作成中のままにしない。リトライできる状態にする。
// - 調べ物・一括検証: AIチャットに投稿し、依頼を失敗にする。
// - 待ち時間サイト一覧の更新・施設画像の取得・レストラン事実の訂正:
// 対象に状態があれば失敗にする (更新の依頼、セットの画像状態)。
// レストラン事実の訂正は対象に状態を持たない。そして3系統とも、
// 共通文面をダイアログ通知として記録する (下の「ダイアログ表示」)。
// 対象の更新が実際に効いた場合だけ通知を記録する (訂正は常時)。
async function applyForcedOutcome(db, host, target) {
const now = new Date();
switch (target.type) {
case "generation":
case "same_day": {
const applied = await host.failPlanSet(target.planSetId, {
error: CONGESTION_TEXT,
completedAt: now,
// 保存済みのスロットは done のまま、他は failed にする
});
if (applied) {
await host.closeRunLog(target.planSetId, "failed",
"試行回数を超えたので強制終了（タスク管理クラス）");
}
break;
}
case "partial": {
const applied = await host.failPartialSlot(target.planSetId, target.slot, {
failureText: CONGESTION_TEXT, // 依頼の記録は残す (リトライ・取消ができる)
now,
});
if (applied) {
await host.closeRunLog(target.planSetId, "failed",
"試行回数を超えたので強制終了（タスク管理クラス）", target.slot);
}
break;
}
case "research": {
const applied = await host.failResearchRequest(target.researchId, now);
if (applied) await host.postChatMessage(CONGESTION_TEXT);
break;
}
case "verification": {
const applied = await host.failVerificationRequest(target.requestId, now);
if (applied) await host.postChatMessage(CONGESTION_TEXT);
break;
}
case "wait_sources": {
const applied = await host.failWaitSourcesRequest(target.requestId, now);
if (applied) await insertDialogNotice(db);
break;
}
case "item_images": {
const applied = await host.failItemImages(target.planSetId);
if (applied) await insertDialogNotice(db);
break;
}
case "restaurant_correction": {
// 対象に失敗として印を付ける状態が無い。ダイアログ通知が
// この系統の異常終了の出し方のすべて。
await insertDialogNotice(db);
break;
}
}
host.invalidateQueries();
}

// 「終わった」の印: 処理の通常の完了をサーバー側で確認した場所から
// 呼ばれる。開いている試行と実行を成功として閉じる (利用者の
// キャンセルなら cancelled)。開いていない実行には触れない。
async function finishRunForTarget(db, target, how) {
const key = targetKey(target);
const now = new Date();
const openRuns = await db.listOpenProductionRuns();
for (const run of openRuns) {
const t = parseTarget(run.targetJson);
if (!t || targetKey(t)!== key) continue;
if (how === "finished") {
await db.closeOpenAttemptsOfRun(run.id, {
status: "succeeded",
finishedAt: now,
closeReason: "処理の通常の完了をサーバー側で確認した",
});
await db.updateRun(run.id, { status: "succeeded", closedAt: now});
} else {
await db.closeOpenAttemptsOfRun(run.id, {
status: "cancelled",
finishedAt: now,
closeReason: "利用者の操作によりキャンセルされた",
});
await db.updateRun(run.id, {
status: "cancelled",
finalReason: "利用者がキャンセルした",
closedAt: now,
});
}
}
}

// ----------------------------------------------------------------------------
// ダイアログ表示 (mgrDialogNotice の仕組み、種類15〜17の異常終了)
// ----------------------------------------------------------------------------
//
// 通知の置き場は mgr_dialog_notices テーブル。状態取得 (getState) が、
// 未表示 (shown_at が空) のうち最も古い1件を mgrDialogNotice として
// 返す。クライアントは、通知が現れた瞬間にそれを自分のダイアログ
// 状態へ取り込み、同時に markDialogShown で表示済みの記録を付ける。
// 取り込みと記録が同時なので、通知はちょうど1回だけ表示され、
// 読み直しの途中で再取得が来ても消えない。ダイアログ自体は
// 「閉じる」ボタンだけの単純なもので、文面はサーバーから来た
// 共通文面をそのまま出す。前日ダイアログとお知らせダイアログが
// 立っている間は出さず、それらが消えてから表示する。

// 状態取得が返す、最も古い未表示の通知 (無ければ null)。
async function oldestUnshownDialogNotice(db) {
const row = await db.getOldestUnshownDialogNotice();
return row? { id: row.id, text: row.text}: null;
}

// 表示済みの記録: まだ未表示の行にだけ shown_at を打つ (二重には付けない)。
async function markDialogShown(db, noticeId) {
await db.markDialogNoticeShown(noticeId, new Date());
}

// ----------------------------------------------------------------------------
// 組み込み口 (ホスト側の接続点)
// ----------------------------------------------------------------------------
//
// 開始 (すべて beginAttempt + spawnForAttempt 経由。直接 spawnTask しない):
// - プラン作成タブの「この条件で3プランを作成」ボタン
// - プラン作成タブの「当日検索」フォーム
// - AIチャットの判定からの開始 (新規作成・作り直し・部分差し替え・
// 当日リスケ・調べ物・一括検証・待ち時間サイト一覧の更新)
// - 前日ダイアログの「一括検証を実行する」ボタン
// - DPA / 抽選の購入イベントからの当日リスケ開始
// - 作成中・失敗の画面のリトライボタン (同じセットを再実行する形で
// beginAttempt から。キャンセルボタンは finishRunForTarget の
// "cancelled" を呼ぶ)
// - プランのタブの施設画像の取得ボタン (セットを取得中にしてから開始)
// - レストラン事実の訂正の起動 (訂正済みの事実が両方とも登録済みなら
// 起動しない冪等な入り口。訂正は1回限りの処理)
//
// 完了フック (finishRunForTarget(target, "finished")):
// - プラン作成・当日検索・部分差し替え: 生成の記録がタスク側の経路で
// 閉じる場所 — プラン保存の成功、差し替え保存の成功、失敗報告、
// 実行不可の報告。利用者のキャンセルと、条件不一致による開始取り消しは
// "cancelled"。
// ※ サーバー側の見張り (応答なし検知) や定期チェックが記録を閉じる
// 場合はフックを呼ばない。静かに死んだタスクは再試行できる状態に
// 残すのが決まりで、完了扱いにしてはいけない。
// - 調べ物: 回答の保存 / 失敗報告の場所。
// - 一括検証: 結果の保存 / 失敗報告の場所。
// - 待ち時間サイト一覧の更新: 一覧の保存 (saveWaitTimeSources) /
// 失敗報告 (reportWaitTimeSourcesFailure) の場所。
// - 施設画像の取得: 画像の保存 (saveItemImages) / 失敗報告
// (reportItemImagesFailure) の場所。
// - レストラン事実の訂正: 報告 (reportRestaurantFactCorrection) の場所。
// 成功の報告でも失敗の報告でも、報告された終わりは通常の完了として
// 閉じる (管理クラスは報告された終わりを再試行しない)。
//
// 再試行時の再開 (respawnProduction の host.restart*):
// 対象の種類ごとに、その処理の通常の開始処理を、新しい試行 (att) を
// 渡して呼び直す。
// - generation / same_day: セットは作り直さない。記録された開始入力で
// そのセットの全体生成を再実行する (リトライボタンと同じ処理)。
// - partial: セットに記録された差し替え依頼 (指示文・当日報告) を、
// そのスロットに対してもう一度開始する。
// - research: 同じ依頼 (質問) をもう一度開始する。
// - verification: 同じ依頼をもう一度開始する。
// - wait_sources: 同じ依頼 (指示文) をもう一度開始する。依頼の行は
// 最初の開始時に1つだけ作られ、再試行で増やさない。
// - item_images: 不足分を数え直し、残りだけをもう一度開始する。
// 不足が無ければ取得完了として実行を閉じる。
// - restaurant_correction: 訂正済みの事実が既に登録されていれば
// 起動せず実行を閉じる。そうでなければ同じ訂正をもう一度開始する。
//
// 定期チェック: 1分ごとのスケジュールが checkTaskManager アクションを
// 呼び、runCheck を実行する。管理する側の状態は、この1組のテーブルと
// このチェックだけ (処理が同時に複数走っても単一)。
//
// 直接起動として残っているもの (この管理クラスの外):
// - この管理クラス内部の起動そのもの (テストの試行の起動と、
// spawnForAttempt からの起動)。
// - 検証用のデバッグ実行 (DPAデバッグ・検証2・検証3・検証5 は
// それぞれの実行アクションから直接起動する。検証4 はタスクを
// 起動せず、指示文を AI チャットへ渡す形)。これらは診断であって
// 本番の処理ではないので、管理クラスの対象には入れない。
// 本番の処理で直接起動のまま残っているものは無い (7系統すべて管理下)。
//
// ----------------------------------------------------------------------------
// DB テーブル契約 (SQLite / 時刻はミリ秒の timestamp)
// ----------------------------------------------------------------------------
//
// task_mgr_params: 種類ごとのパラメータ (管理タブで変更できる)
// kind INTEGER PRIMARY KEY
// start_timeout_sec INTEGER NOT NULL -- 開始待ちの制限時間 (秒)
// total_timeout_sec INTEGER NOT NULL -- 全体の制限時間 (秒)
// max_attempts INTEGER NOT NULL -- 試行回数
//
// task_mgr_tests: テスト全体 (検証6)
// id INTEGER PK AUTOINCREMENT
// status TEXT NOT NULL DEFAULT 'running' -- running | done | cancelled
// total INTEGER NOT NULL DEFAULT 100
// started_at INTEGER NOT NULL
// closed_at INTEGER NULL
// close_reason TEXT NULL
//
// task_mgr_runs: 実行 (テストの1回分、または本番の処理1件)
// id INTEGER PK AUTOINCREMENT
// test_id INTEGER NULL -- 本番の実行は NULL
// seq INTEGER NOT NULL DEFAULT 0 -- テスト内は 1..100、本番は 0
// kind INTEGER NOT NULL -- 1..10 テスト / 11..17 本番
// status TEXT NOT NULL DEFAULT 'running'
// -- running | succeeded | forced | cancelled
// final_reason TEXT NULL
// created_at INTEGER NOT NULL
// closed_at INTEGER NULL
// target_json TEXT NULL -- 本番のみ: 対象 (上の MgrTarget)
// -- テストの実行は NULL
//
// task_mgr_attempts: 試行
// id INTEGER PK AUTOINCREMENT
// run_id INTEGER NOT NULL
// attempt_no INTEGER NOT NULL
// status TEXT NOT NULL DEFAULT 'awaiting_start'
// -- awaiting_start | running | succeeded | cancelled
// spawned_at INTEGER NOT NULL -- サーバーが打つ開始時刻
// start_deadline_at INTEGER NOT NULL -- spawned_at + 開始待ち
// total_deadline_at INTEGER NOT NULL -- spawned_at + 全体
// first_call_at INTEGER NULL -- 最初の記録呼び出し = 開始の印
// finished_at INTEGER NULL
// close_reason TEXT NULL
//
// task_mgr_calls: 記録呼び出し1件ごと
// id INTEGER PK AUTOINCREMENT
// attempt_id INTEGER NOT NULL
// phase TEXT NOT NULL
// called_at INTEGER NOT NULL -- サーバーの受付時刻
// note TEXT NULL
// text_length INTEGER NULL
// saved_text TEXT NULL -- 文章を保存する種類のみ (サーバー側で切り詰め)
//
// mgr_dialog_notices: 異常終了のダイアログ通知 (種類15〜17)
// id INTEGER PK AUTOINCREMENT
// text TEXT NOT NULL -- 共通文面 (CONGESTION_TEXT)
// created_at INTEGER NOT NULL
// shown_at INTEGER NULL -- 表示済みの記録。空 = 未表示
//
// 状態の遷移:
// - run: running → succeeded (通常の完了 / テストは phases 完了)
// → forced (試行を使い切った)
// → cancelled (テスト全体の取消 / 利用者の取消 /
// 新しい開始による置き換え / 対象が別経路で終了)
// - attempt: awaiting_start → running (最初の記録)
// → succeeded (完了)
// → cancelled (期限切れ / 起動失敗 / 取消 / 置き換え)
// ============================================================================
