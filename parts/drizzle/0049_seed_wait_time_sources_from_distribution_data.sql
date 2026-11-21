INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'urtrip（ランド）',
       'https://urtrip.jp/tdl-attraction-waitingtime-data/',
       'land',
       'アトラクション別の過去データ分析：平均・最大・最小の待ち時間と、日ごとの平均待ち時間の推移',
       'browser',
       1794456015035,
       1794456015036
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://urtrip.jp/tdl-attraction-waitingtime-data/');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'urtrip（シー）',
       'https://urtrip.jp/tds-attraction-waitingtime-data/',
       'sea',
       'アトラクション別の過去データ分析：平均・最大・最小の待ち時間と、日ごとの平均待ち時間の推移',
       'browser',
       1794456015035,
       1794456015074
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://urtrip.jp/tds-attraction-waitingtime-data/');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'テマパ！',
       'https://www.temapa.jp/park/tdr/facility/258/',
       'both',
       '施設ごとの現在の待ち時間と、平均・最大の待ち時間（リンク先は施設別ページの一例）',
       'browser',
       1794456015035,
       1794456015095
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://www.temapa.jp/park/tdr/facility/258/');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'disneyreal（ファンタジースプリングス）',
       'https://disneyreal.asumirai.info/guide/fantasysprings.html',
       'sea',
       'ファンタジースプリングスの待ち時間統計：平均・中央値・最小・最大',
       'browser',
       1794456015035,
       1794456015115
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://disneyreal.asumirai.info/guide/fantasysprings.html');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'queue-times.com（シー）',
       'https://queue-times.com/parks/275/stats',
       'sea',
       '掲示待ち時間のリアルタイム値と、パークごと・日ごとの履歴統計（全ライドの平均待ち時間／平均最大待ち時間）。全期間平均は現在の水準より低めに出るため、プラン作成時の推定には直近の期間の数字を使うこと。ランド版（parks/274）も同じサイトにある',
       'browser',
       1794495600000,
       1794495600000
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://queue-times.com/parks/275/stats');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'RopeDrop Planner',
       'https://ropedropplanner.com/ja/tdr/wait-times',
       'both',
       'ランド・シー両パークの現在の待ち時間と30日平均。過去統計と天気予報などを組み合わせた予測寄りのサイト（公式ではない独立系）',
       'browser',
       1794495600000,
       1794495600000
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://ropedropplanner.com/ja/tdr/wait-times');
