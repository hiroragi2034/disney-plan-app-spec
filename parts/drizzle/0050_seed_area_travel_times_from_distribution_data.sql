INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'ポートディスカバリー', 'メディテレーニアンハーバー', 'ポートディスカバリー', 'メディテレーニアンハーバー', 5, 'マゼランズからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMH0523', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'ポートディスカバリー' AND area_b_key = 'メディテレーニアンハーバー');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'マーメイドラグーン', 'メディテレーニアンハーバー', 'マーメイドラグーン', 'メディテレーニアンハーバー', 6, 'マゼランズからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMH0523', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'マーメイドラグーン' AND area_b_key = 'メディテレーニアンハーバー');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アラビアンコースト', 'メディテレーニアンハーバー', 'アラビアンコースト', 'メディテレーニアンハーバー', 8, 'マゼランズからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMH0523', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アラビアンコースト' AND area_b_key = 'メディテレーニアンハーバー');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'メディテレーニアンハーバー', 'ロストリバーデルタ', 'メディテレーニアンハーバー', 'ロストリバーデルタ', 8, 'マゼランズからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMH0523', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'メディテレーニアンハーバー' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アメリカンウォーターフロント', 'マーメイドラグーン', 'アメリカンウォーターフロント', 'マーメイドラグーン', 12, 'ビッグシティ・ヴィークルからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BAW0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アメリカンウォーターフロント' AND area_b_key = 'マーメイドラグーン');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アメリカンウォーターフロント', 'ロストリバーデルタ', 'アメリカンウォーターフロント', 'ロストリバーデルタ', 12, 'ビッグシティ・ヴィークルからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BAW0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アメリカンウォーターフロント' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'マーメイドラグーン', 'ミステリアスアイランド', 'マーメイドラグーン', 'ミステリアスアイランド', 6, 'センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMI0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'マーメイドラグーン' AND area_b_key = 'ミステリアスアイランド');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'ポートディスカバリー', 'ミステリアスアイランド', 'ポートディスカバリー', 'ミステリアスアイランド', 6, 'センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMI0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'ポートディスカバリー' AND area_b_key = 'ミステリアスアイランド');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アラビアンコースト', 'ミステリアスアイランド', 'アラビアンコースト', 'ミステリアスアイランド', 7, 'センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMI0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アラビアンコースト' AND area_b_key = 'ミステリアスアイランド');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'ミステリアスアイランド', 'ロストリバーデルタ', 'ミステリアスアイランド', 'ロストリバーデルタ', 7, 'センター・オブ・ジ・アースからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BMI0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'ミステリアスアイランド' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'ポートディスカバリー', 'ロストリバーデルタ', 'ポートディスカバリー', 'ロストリバーデルタ', 5, 'アクアトピアからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BPD0102', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'ポートディスカバリー' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アラビアンコースト', 'ポートディスカバリー', 'アラビアンコースト', 'ポートディスカバリー', 8, 'アクアトピアからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BPD0102', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アラビアンコースト' AND area_b_key = 'ポートディスカバリー');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'ポートディスカバリー', 'マーメイドラグーン', 'ポートディスカバリー', 'マーメイドラグーン', 9, 'アクアトピアからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BPD0102', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'ポートディスカバリー' AND area_b_key = 'マーメイドラグーン');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アラビアンコースト', 'ロストリバーデルタ', 'アラビアンコースト', 'ロストリバーデルタ', 3, 'インディ・ジョーンズ・アドベンチャーからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BLD0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アラビアンコースト' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'マーメイドラグーン', 'ロストリバーデルタ', 'マーメイドラグーン', 'ロストリバーデルタ', 5, 'インディ・ジョーンズ・アドベンチャーからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BLD0101', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'マーメイドラグーン' AND area_b_key = 'ロストリバーデルタ');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アラビアンコースト', 'マーメイドラグーン', 'アラビアンコースト', 'マーメイドラグーン', 6, 'シンドバッド・ストーリーブック・ヴォヤッジからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=BAC0102', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アラビアンコースト' AND area_b_key = 'マーメイドラグーン');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'sea', 'アメリカンウォーターフロント', 'ファンタジースプリングス', 'アメリカンウォーターフロント', 'ファンタジースプリングス', 21, '東京ディズニーシーを「端から端まで」歩いたら……　かかった“驚きの時間”に「家から駅までとあまり変わらない……？」（1/2） | ディズニー ねとらぼ', 'https://nlab.itmedia.co.jp/cont/articles/3588963/amp/', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'sea' AND area_a_key = 'アメリカンウォーターフロント' AND area_b_key = 'ファンタジースプリングス');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'land', 'トゥモローランド', 'ワールドバザール', 'トゥモローランド', 'ワールドバザール', 3, 'オムニバスからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=AWB0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'land' AND area_a_key = 'トゥモローランド' AND area_b_key = 'ワールドバザール');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'land', 'アドベンチャーランド', 'ワールドバザール', 'アドベンチャーランド', 'ワールドバザール', 2, 'オムニバスからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=AWB0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'land' AND area_a_key = 'アドベンチャーランド' AND area_b_key = 'ワールドバザール');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'land', 'ウエスタンランド', 'ワールドバザール', 'ウエスタンランド', 'ワールドバザール', 5, 'オムニバスからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=AWB0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'land' AND area_a_key = 'ウエスタンランド' AND area_b_key = 'ワールドバザール');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'land', 'ファンタジーランド', 'ワールドバザール', 'ファンタジーランド', 'ワールドバザール', 4, 'オムニバスからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=AWB0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'land' AND area_a_key = 'ファンタジーランド' AND area_b_key = 'ワールドバザール');
--> statement-breakpoint
INSERT INTO area_travel_times (park, area_a, area_b, area_a_key, area_b_key, minutes, source_title, source_url, fetched_at, created_at, updated_at)
SELECT 'land', 'クリッターカントリー', 'ワールドバザール', 'クリッターカントリー', 'ワールドバザール', 6, 'オムニバスからの移動時間、距離、歩数（ディズニー歩数）', 'https://disney.hosuu.jp/syosai_information.php?code=AWB0103', '2026-11-13', 1794495600000, 1794495600000
WHERE NOT EXISTS (SELECT 1 FROM area_travel_times WHERE park = 'land' AND area_a_key = 'クリッターカントリー' AND area_b_key = 'ワールドバザール');
