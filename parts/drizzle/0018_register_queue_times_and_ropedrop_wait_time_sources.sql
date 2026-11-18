INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'queue-times.com（シー）',
       'https://queue-times.com/parks/275/stats',
       'sea',
       '掲示待ち時間のリアルタイム値と、パークごと・日ごとの履歴統計（全ライドの平均待ち時間／平均最大待ち時間）。全期間平均は現在の水準より低めに出るため、プラン作成時の推定には直近の期間の数字を使うこと。ランド版（parks/274）も同じサイトにある',
       'script',
       1794495600000,
       1794495600000
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://queue-times.com/parks/275/stats');
--> statement-breakpoint
INSERT INTO wait_time_sources (name, url, park, provides, fetch_method, last_checked_at, created_at)
SELECT 'RopeDrop Planner',
       'https://ropedropplanner.com/ja/tdr/wait-times',
       'both',
       'ランド・シー両パークの現在の待ち時間と30日平均。過去統計と天気予報などを組み合わせた予測寄りのサイト（公式ではない独立系）',
       'script',
       1794495600000,
       1794495600000
WHERE NOT EXISTS (SELECT 1 FROM wait_time_sources WHERE url = 'https://ropedropplanner.com/ja/tdr/wait-times');
