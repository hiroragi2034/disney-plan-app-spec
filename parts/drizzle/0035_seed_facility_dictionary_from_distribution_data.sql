INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ヴェネツィアン・ゴンドラ', 'ヴェネツィアン・ゴンドラ', 'メディテレーニアンハーバー', 35.626147, 139.8879186, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ヴェネツィアン・ゴンドラ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'スパークリング・ジュビリー・セレブレーション', 'スパークリング・ジュビリー・セレブレーション', 'メディテレーニアンハーバー', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'スパークリング・ジュビリー・セレブレーション');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ソアリン:ファンタスティック・フライト', 'ソアリン：ファンタスティック・フライト', 'メディテレーニアンハーバー', 35.627691, 139.885425, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ソアリン:ファンタスティック・フライト');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ディズニー・クリスマス・グリーティング', 'ディズニー・クリスマス・グリーティング', 'メディテレーニアンハーバー', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ディズニー・クリスマス・グリーティング');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'カフェ・ポルトフィーノ', 'カフェ・ポルトフィーノ', 'メディテレーニアンハーバー', 35.6270253, 139.8870537, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'カフェ・ポルトフィーノ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'タートル・トーク', 'タートル・トーク', 'アメリカンウォーターフロント', 35.623324, 139.887468, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'タートル・トーク');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'トイ・ストーリー・マニア!', 'トイ・ストーリー・マニア！', 'アメリカンウォーターフロント', 35.624583, 139.88912, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'トイ・ストーリー・マニア!');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'タワー・オブ・テラー', 'タワー・オブ・テラー', 'アメリカンウォーターフロント', 35.624096, 139.888268, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'タワー・オブ・テラー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ニューヨーク・デリ', 'ニューヨーク・デリ', 'アメリカンウォーターフロント', 35.6253888, 139.8878656, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ニューヨーク・デリ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ビリーヴ!~シー・オブ・ドリームス~', 'ビリーヴ！～シー・オブ・ドリームス～', 'メディテレーニアンハーバー', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ビリーヴ!~シー・オブ・ドリームス~');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'スターブライト・クリスマス', 'スターブライト・クリスマス', 'パークワイド', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'スターブライト・クリスマス');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'エンポーリオ', 'エンポーリオ', 'メディテレーニアンハーバー', 35.626882, 139.887937, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'エンポーリオ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'アナとエルサのフローズンジャーニー', 'アナとエルサのフローズンジャーニー', 'ファンタジースプリングス', 35.629945, 139.877251, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'アナとエルサのフローズンジャーニー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ラプンツェルのランタンフェスティバル', 'ラプンツェルのランタンフェスティバル', 'ファンタジースプリングス', 35.628984, 139.879654, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ラプンツェルのランタンフェスティバル');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'フェアリー・ティンカーベルのビジーバギー', 'フェアリー・ティンカーベルのビジーバギー', 'ファンタジースプリングス', 35.628281, 139.877928, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'フェアリー・ティンカーベルのビジーバギー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'アレンデール・ロイヤルバンケット', 'アレンデール・ロイヤルバンケット', 'ファンタジースプリングス', 35.629413, 139.878062, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'アレンデール・ロイヤルバンケット');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'センター・オブ・ジ・アース', 'センター・オブ・ジ・アース', 'ミステリアスアイランド', 35.6262272, 139.8845498, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'センター・オブ・ジ・アース');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', '海底2万マイル', '海底2万マイル', 'ミステリアスアイランド', 35.626961, 139.884472, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = '海底2万マイル');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'シンドバッド・ストーリーブック・ヴォヤッジ', 'シンドバッド・ストーリーブック・ヴォヤッジ', 'アラビアンコースト', 35.62875, 139.881621, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'シンドバッド・ストーリーブック・ヴォヤッジ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'マジックランプシアター', 'マジックランプシアター', 'アラビアンコースト', 35.6285626, 139.883104, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'マジックランプシアター');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'カスバ・フードコート', 'カスバ・フードコート', 'アラビアンコースト', 35.628461, 139.882695, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'カスバ・フードコート');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ニモ&フレンズ・シーライダー', 'ニモ＆フレンズ・シーライダー', 'ポートディスカバリー', 35.6249184, 139.8825063, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ニモ&フレンズ・シーライダー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'リストランテ・ディ・カナレット', 'リストランテ・ディ・カナレット', 'メディテレーニアンハーバー', 35.625687, 139.887773, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'リストランテ・ディ・カナレット');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ダンス・ザ・グローブ!', 'ダンス・ザ・グローブ！', 'アメリカンウォーターフロント', 35.624423, 139.887676, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ダンス・ザ・グローブ!');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ケープコッド・クックオフ', 'ケープコッド・クックオフ', 'アメリカンウォーターフロント', 35.624612, 139.885083, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ケープコッド・クックオフ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', '【環境演出】スパークリング・ジュビリー・ナイト', '【環境演出】スパークリング・ジュビリー・ナイト', 'メディテレーニアンハーバー', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = '【環境演出】スパークリング・ジュビリー・ナイト');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ピーターパンのネバーランドアドベンチャー', 'ピーターパンのネバーランドアドベンチャー', 'ファンタジースプリングス', 35.627859, 139.8789337, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ピーターパンのネバーランドアドベンチャー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ジャンピン・ジェリーフィッシュ', 'ジャンピン・ジェリーフィッシュ', 'マーメイドラグーン', 35.6264458, 139.8833143, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ジャンピン・ジェリーフィッシュ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ジャスミンのフライングカーペット', 'ジャスミンのフライングカーペット', 'アラビアンコースト', 35.6283524, 139.8810948, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ジャスミンのフライングカーペット');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'インディ・ジョーンズ・アドベンチャー:クリスタルスカルの魔宮', 'インディ・ジョーンズ・アドベンチャー：クリスタルスカルの魔宮', 'ロストリバーデルタ', 35.6267129, 139.8806129, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'インディ・ジョーンズ・アドベンチャー:クリスタルスカルの魔宮');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'レイジングスピリッツ', 'レイジングスピリッツ', 'ロストリバーデルタ', 35.6277111, 139.8807931, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'レイジングスピリッツ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'スカイ・フル・オブ・カラーズ', 'スカイ・フル・オブ・カラーズ', 'パークワイド', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'スカイ・フル・オブ・カラーズ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ニューデイ、ニュードリームス', 'ニューデイ、ニュードリームス', 'パークワイド', 35.6264517, 139.8869221, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ニューデイ、ニュードリームス');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'スナグリーダックリング', 'スナグリーダックリング', 'ファンタジースプリングス', 35.6291282, 139.8786303, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'スナグリーダックリング');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ルックアウト・クックアウト', 'ルックアウト・クックアウト', 'ファンタジースプリングス', 35.6281697, 139.8782511, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ルックアウト・クックアウト');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ファンタジースプリングス・ギフト', 'ファンタジースプリングス・ギフト', 'ファンタジースプリングス', 35.6282401, 139.8770569, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ファンタジースプリングス・ギフト');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ケープコッド・クックオフ(ショーダイニングエリア)', 'ケープコッド・クックオフ（ショーダイニングエリア）', 'アメリカンウォーターフロント', 35.624612, 139.885083, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ケープコッド・クックオフ(ショーダイニングエリア)');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', '美女と野獣“魔法のものがたり”', '美女と野獣“魔法のものがたり”', 'ファンタジーランド', 35.6304511, 139.8778894, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = '美女と野獣“魔法のものがたり”');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'イッツ・ア・スモールワールド', 'イッツ・ア・スモールワールド', 'ファンタジーランド', 35.6304467, 139.8812413, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'イッツ・ア・スモールワールド');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'プーさんのハニーハント', 'プーさんのハニーハント', 'ファンタジーランド', 35.6302111, 139.8805376, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'プーさんのハニーハント');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', '空飛ぶダンボ', '空飛ぶダンボ', 'ファンタジーランド', 35.6314631, 139.8816938, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = '空飛ぶダンボ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'アリスのティーパーティー', 'アリスのティーパーティー', 'ファンタジーランド', 35.6311492, 139.8809805, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'アリスのティーパーティー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ベイマックスのハッピーライド', 'ベイマックスのハッピーライド', 'トゥモローランド', 35.6317007, 139.8788382, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ベイマックスのハッピーライド');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'カリブの海賊', 'カリブの海賊', 'アドベンチャーランド', 35.6347638, 139.8813485, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'カリブの海賊');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'クイーン・オブ・ハートのバンケットホール', 'クイーン・オブ・ハートのバンケットホール', 'ファンタジーランド', 35.6309372, 139.8814195, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'クイーン・オブ・ハートのバンケットホール');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ミッキーのフィルハーマジック', 'ミッキーのフィルハーマジック', 'ファンタジーランド', 35.6314952, 139.8806414, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ミッキーのフィルハーマジック');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'プラザパビリオン・レストラン', 'プラザパビリオン・レストラン', 'ウエスタンランド', 35.6328582, 139.8815443, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'プラザパビリオン・レストラン');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'カントリーベア・シアター', 'カントリーベア・シアター', 'ウエスタンランド', 35.6325284, 139.8824532, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'カントリーベア・シアター');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'カフェ・オーリンズ', 'カフェ・オーリンズ', 'アドベンチャーランド', 35.6342023, 139.8811664, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'カフェ・オーリンズ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'イーストサイド・カフェ', 'イーストサイド・カフェ', 'ワールドバザール', 35.6345587, 139.8801459, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'イーストサイド・カフェ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ザ・ダイヤモンドホースシュー', 'ザ・ダイヤモンドホースシュー', 'ウエスタンランド', 35.6326333, 139.8816527, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ザ・ダイヤモンドホースシュー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ウエスタンリバー鉄道', 'ウエスタンリバー鉄道', 'アドベンチャーランド', 35.6332414, 139.8854715, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ウエスタンリバー鉄道');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'オムニバス', 'オムニバス', 'ワールドバザール', 35.6330125, 139.8796956, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'オムニバス');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ミッキーの家とミート・ミッキー', 'ミッキーの家とミート・ミッキー', 'トゥーンタウン', 35.6302495, 139.8785992, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ミッキーの家とミート・ミッキー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'キャプテンフックス・ギャレー', 'キャプテンフックス・ギャレー', 'ファンタジーランド', 35.6319879, 139.8820402, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'キャプテンフックス・ギャレー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ディズニーシー・エレクトリックレールウェイ(ポートディスカバリー)', 'ディズニーシー・エレクトリックレールウェイ（ポートディスカバリー）', 'ポートディスカバリー', 35.6250071, 139.8856057, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ディズニーシー・エレクトリックレールウェイ(ポートディスカバリー)');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ドリームス・テイク・フライト', 'ドリームス・テイク・フライト', 'ロストリバーデルタ', 35.6257667, 139.8825777, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ドリームス・テイク・フライト');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'モンスターズ・インク“ライド&ゴーシーク!”', 'モンスターズ・インク“ライド＆ゴーシーク！”', 'トゥモローランド', 35.6339596, 139.8783588, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'モンスターズ・インク“ライド&ゴーシーク!”');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'キャッスルカルーセル', 'キャッスルカルーセル', 'ファンタジーランド', 35.6313864, 139.881256, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'キャッスルカルーセル');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ミニー@ファンダーランド', 'ミニー＠ファンダーランド', 'パークワイド', 35.6343228, 139.8795861, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ミニー@ファンダーランド');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'トイズ・ワンダラス・クリスマス!', 'トイズ・ワンダラス・クリスマス！', 'パークワイド', 35.6343228, 139.8795861, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'トイズ・ワンダラス・クリスマス!');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ディズニー・ハーモニー・イン・カラー', 'ディズニー・ハーモニー・イン・カラー', 'パークワイド', 35.6343228, 139.8795861, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ディズニー・ハーモニー・イン・カラー');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ミッキーのマジカルミュージックワールド', 'ミッキーのマジカルミュージックワールド', 'ファンタジーランド', 35.6313055, 139.8773417, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ミッキーのマジカルミュージックワールド');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', '東京ディズニーランド・エレクトリカルパレード・ドリームライツ', '東京ディズニーランド・エレクトリカルパレード・ドリームライツ', 'パークワイド', 35.6343228, 139.8795861, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = '東京ディズニーランド・エレクトリカルパレード・ドリームライツ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'スターブライト・クリスマス', 'スターブライト・クリスマス', 'パークワイド', 35.6343228, 139.8795861, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'スターブライト・クリスマス');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ピーターパン空の旅', 'ピーターパン空の旅', 'ファンタジーランド', 35.6319367, 139.8817773, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ピーターパン空の旅');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ジャンボリミッキー!レッツ・ダンス!', 'ジャンボリミッキー！レッツ・ダンス！', 'アドベンチャーランド', 35.634254, 139.8817086, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ジャンボリミッキー!レッツ・ダンス!');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'センターストリート・コーヒーハウス', 'センターストリート・コーヒーハウス', 'ワールドバザール', 35.6342033, 139.8791317, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'センターストリート・コーヒーハウス');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ホーンテッドマンション', 'ホーンテッドマンション', 'ファンタジーランド', 35.6305519, 139.8821407, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ホーンテッドマンション');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ジャングルクルーズ:ワイルドライフ・エクスペディション', 'ジャングルクルーズ：ワイルドライフ・エクスペディション', 'アドベンチャーランド', 35.6339528, 139.8824076, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ジャングルクルーズ:ワイルドライフ・エクスペディション');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', '魅惑のチキルーム:スティッチ・プレゼンツ“アロハ・エ・コモ・マイ!”', '魅惑のチキルーム：スティッチ・プレゼンツ“アロハ・エ・コモ・マイ！”', 'アドベンチャーランド', 35.6331122, 139.882374, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = '魅惑のチキルーム:スティッチ・プレゼンツ“アロハ・エ・コモ・マイ!”');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ハンガーステージ', 'ハンガーステージ', 'ロストリバーデルタ', 35.6257667, 139.8825777, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ハンガーステージ');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'sea', 'ウォーターフロントパーク', 'ウォーターフロントパーク', 'アメリカンウォーターフロント', 35.6244229, 139.8876761, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'sea' AND name_key = 'ウォーターフロントパーク');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'ファンタジーランド・フォレストシアター', 'ファンタジーランド・フォレストシアター', 'ファンタジーランド', 35.6313055, 139.8773417, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'ファンタジーランド・フォレストシアター');
--> statement-breakpoint
INSERT INTO facilities (park, name_key, name, area, lat, lng, coords_fetched_at, created_at, updated_at)
SELECT 'land', 'シアターオーリンズ', 'シアターオーリンズ', 'アドベンチャーランド', 35.634254, 139.8817086, 1794927600000, 1794927600000, 1794927600000
WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE park = 'land' AND name_key = 'シアターオーリンズ');
