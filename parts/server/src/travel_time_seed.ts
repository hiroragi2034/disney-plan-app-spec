// The area-to-area travel matrix's initial state (spec §8/§24):
// the initial values registered by migration 0020, distributed
// as data/area-travel-times.json (record CY, 2026-11-21), the same
// rows migration 0050 carries as the seed migration. resetUserData
// restores exactly these rows so the matrix returns to the §24
// initial state instead of ending up empty (the pre-CY defect:
// migration 0020 seeded the values at build time, but a reset
// deleted them and nothing brought them back). Rows a copy
// accumulates at runtime beyond this seed are reverted by a
// reset, the same treatment as the facility dictionary (record
// CU) and the wait-time reference list (record CV). Every row
// carries its guide source (title / URL / fetch date) verbatim
// from migration 0020; no value comes from AI memory.

export const TRAVEL_TIME_SEED: {
  park: "land" | "sea";
  areaA: string;
  areaB: string;
  areaAKey: string;
  areaBKey: string;
  minutes: number;
  sourceTitle: string;
  sourceUrl: string;
  fetchedAt: string;
  createdAtMs: number;
  updatedAtMs: number;
}[] = [
  { park: "sea", areaA: "ポートディスカバリー", areaB: "メディテレーニアンハーバー", areaAKey: "ポートディスカバリー", areaBKey: "メディテレーニアンハーバー", minutes: 5, sourceTitle: "マゼランズからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMH0523", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "マーメイドラグーン", areaB: "メディテレーニアンハーバー", areaAKey: "マーメイドラグーン", areaBKey: "メディテレーニアンハーバー", minutes: 6, sourceTitle: "マゼランズからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMH0523", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アラビアンコースト", areaB: "メディテレーニアンハーバー", areaAKey: "アラビアンコースト", areaBKey: "メディテレーニアンハーバー", minutes: 8, sourceTitle: "マゼランズからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMH0523", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "メディテレーニアンハーバー", areaB: "ロストリバーデルタ", areaAKey: "メディテレーニアンハーバー", areaBKey: "ロストリバーデルタ", minutes: 8, sourceTitle: "マゼランズからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMH0523", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アメリカンウォーターフロント", areaB: "マーメイドラグーン", areaAKey: "アメリカンウォーターフロント", areaBKey: "マーメイドラグーン", minutes: 12, sourceTitle: "ビッグシティ・ヴィークルからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BAW0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アメリカンウォーターフロント", areaB: "ロストリバーデルタ", areaAKey: "アメリカンウォーターフロント", areaBKey: "ロストリバーデルタ", minutes: 12, sourceTitle: "ビッグシティ・ヴィークルからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BAW0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "マーメイドラグーン", areaB: "ミステリアスアイランド", areaAKey: "マーメイドラグーン", areaBKey: "ミステリアスアイランド", minutes: 6, sourceTitle: "センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMI0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "ポートディスカバリー", areaB: "ミステリアスアイランド", areaAKey: "ポートディスカバリー", areaBKey: "ミステリアスアイランド", minutes: 6, sourceTitle: "センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMI0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アラビアンコースト", areaB: "ミステリアスアイランド", areaAKey: "アラビアンコースト", areaBKey: "ミステリアスアイランド", minutes: 7, sourceTitle: "センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMI0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "ミステリアスアイランド", areaB: "ロストリバーデルタ", areaAKey: "ミステリアスアイランド", areaBKey: "ロストリバーデルタ", minutes: 7, sourceTitle: "センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BMI0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "ポートディスカバリー", areaB: "ロストリバーデルタ", areaAKey: "ポートディスカバリー", areaBKey: "ロストリバーデルタ", minutes: 5, sourceTitle: "アクアトピアからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BPD0102", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アラビアンコースト", areaB: "ポートディスカバリー", areaAKey: "アラビアンコースト", areaBKey: "ポートディスカバリー", minutes: 8, sourceTitle: "アクアトピアからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BPD0102", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "ポートディスカバリー", areaB: "マーメイドラグーン", areaAKey: "ポートディスカバリー", areaBKey: "マーメイドラグーン", minutes: 9, sourceTitle: "アクアトピアからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BPD0102", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アラビアンコースト", areaB: "ロストリバーデルタ", areaAKey: "アラビアンコースト", areaBKey: "ロストリバーデルタ", minutes: 3, sourceTitle: "インディ・ジョーンズ・アドベンチャーからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BLD0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "マーメイドラグーン", areaB: "ロストリバーデルタ", areaAKey: "マーメイドラグーン", areaBKey: "ロストリバーデルタ", minutes: 5, sourceTitle: "インディ・ジョーンズ・アドベンチャーからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BLD0101", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アラビアンコースト", areaB: "マーメイドラグーン", areaAKey: "アラビアンコースト", areaBKey: "マーメイドラグーン", minutes: 6, sourceTitle: "シンドバッド・ストーリーブック・ヴォヤッジからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=BAC0102", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "sea", areaA: "アメリカンウォーターフロント", areaB: "ファンタジースプリングス", areaAKey: "アメリカンウォーターフロント", areaBKey: "ファンタジースプリングス", minutes: 21, sourceTitle: "東京ディズニーシーを「端から端まで」歩いたら……　かかった“驚きの時間”に「家から駅までとあまり変わらない……？」（1/2） | ディズニー ねとらぼ", sourceUrl: "https://nlab.itmedia.co.jp/cont/articles/3588963/amp/", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "land", areaA: "トゥモローランド", areaB: "ワールドバザール", areaAKey: "トゥモローランド", areaBKey: "ワールドバザール", minutes: 3, sourceTitle: "オムニバスからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=AWB0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "land", areaA: "アドベンチャーランド", areaB: "ワールドバザール", areaAKey: "アドベンチャーランド", areaBKey: "ワールドバザール", minutes: 2, sourceTitle: "オムニバスからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=AWB0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "land", areaA: "ウエスタンランド", areaB: "ワールドバザール", areaAKey: "ウエスタンランド", areaBKey: "ワールドバザール", minutes: 5, sourceTitle: "オムニバスからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=AWB0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "land", areaA: "ファンタジーランド", areaB: "ワールドバザール", areaAKey: "ファンタジーランド", areaBKey: "ワールドバザール", minutes: 4, sourceTitle: "オムニバスからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=AWB0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
  { park: "land", areaA: "クリッターカントリー", areaB: "ワールドバザール", areaAKey: "クリッターカントリー", areaBKey: "ワールドバザール", minutes: 6, sourceTitle: "オムニバスからの移動時間、距離、歩数（ディズニー歩数）", sourceUrl: "https://disney.hosuu.jp/syosai_information.php?code=AWB0103", fetchedAt: "2026-11-13", createdAtMs: 1794495600000, updatedAtMs: 1794495600000 },
];
