// The wait-time reference list's initial state (spec §11/§24):
// the candidate set registered in the production app, distributed
// as data/wait-time-sources.json (record CV, 2026-11-21), the same
// rows migration 0049 inserts when this app is built. resetUserData
// restores exactly these rows so the list returns to the §24
// initial state instead of keeping whatever the in-use management
// (add / remove / re-search via the AI chat) left behind. No
// build-time survey is performed any more: the owner's decision
// (record CV) is that a copy starts with the production app's
// registered candidates already in place. Site names and URLs
// live only in the data file and its mechanical copies (this
// seed and migration 0049), never in the spec body. Each row's
// lastCheckedAtMs / createdAtMs are the production row's own
// timestamps, preserved verbatim — bundling claims no fresh
// confirmation.

export const WAIT_TIME_SEED: {
  name: string;
  url: string;
  park: "land" | "sea" | "both";
  provides?: string;
  fetchMethod?: "script" | "browser" | "failed";
  lastCheckedAtMs: number;
  createdAtMs: number;
}[] = [
  { name: "urtrip（ランド）", url: "https://urtrip.jp/tdl-attraction-waitingtime-data/", park: "land", provides: "アトラクション別の過去データ分析：平均・最大・最小の待ち時間と、日ごとの平均待ち時間の推移", fetchMethod: "browser", lastCheckedAtMs: 1794456015035, createdAtMs: 1794456015036 },
  { name: "urtrip（シー）", url: "https://urtrip.jp/tds-attraction-waitingtime-data/", park: "sea", provides: "アトラクション別の過去データ分析：平均・最大・最小の待ち時間と、日ごとの平均待ち時間の推移", fetchMethod: "browser", lastCheckedAtMs: 1794456015035, createdAtMs: 1794456015074 },
  { name: "テマパ！", url: "https://www.temapa.jp/park/tdr/facility/258/", park: "both", provides: "施設ごとの現在の待ち時間と、平均・最大の待ち時間（リンク先は施設別ページの一例）", fetchMethod: "browser", lastCheckedAtMs: 1794456015035, createdAtMs: 1794456015095 },
  { name: "disneyreal（ファンタジースプリングス）", url: "https://disneyreal.asumirai.info/guide/fantasysprings.html", park: "sea", provides: "ファンタジースプリングスの待ち時間統計：平均・中央値・最小・最大", fetchMethod: "browser", lastCheckedAtMs: 1794456015035, createdAtMs: 1794456015115 },
  { name: "queue-times.com（シー）", url: "https://queue-times.com/parks/275/stats", park: "sea", provides: "掲示待ち時間のリアルタイム値と、パークごと・日ごとの履歴統計（全ライドの平均待ち時間／平均最大待ち時間）。全期間平均は現在の水準より低めに出るため、プラン作成時の推定には直近の期間の数字を使うこと。ランド版（parks/274）も同じサイトにある", fetchMethod: "browser", lastCheckedAtMs: 1794495600000, createdAtMs: 1794495600000 },
  { name: "RopeDrop Planner", url: "https://ropedropplanner.com/ja/tdr/wait-times", park: "both", provides: "ランド・シー両パークの現在の待ち時間と30日平均。過去統計と天気予報などを組み合わせた予測寄りのサイト（公式ではない独立系）", fetchMethod: "browser", lastCheckedAtMs: 1794495600000, createdAtMs: 1794495600000 },
];
