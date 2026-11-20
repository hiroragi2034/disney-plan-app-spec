CREATE TABLE `acquisition_plan_rows` (
	`row_no` integer PRIMARY KEY NOT NULL,
	`kinds_json` text NOT NULL,
	`url_template` text NOT NULL,
	`url_match` text NOT NULL,
	`state_fragment` text,
	`operations` text NOT NULL,
	`anchor` text NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `acquisition_plan_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`row_no` integer NOT NULL,
	`park` text NOT NULL,
	`needs_revision` integer DEFAULT 0 NOT NULL,
	`revision_reason` text,
	`revision_flagged_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_plan_states_row_park` ON `acquisition_plan_states` (`row_no`,`park`);
--> statement-breakpoint
CREATE TABLE `acquisition_plan_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`row_no` integer NOT NULL,
	`changes_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (1, '["facility_list"]', '{P}/attraction.html', 'attraction.html', NULL, '開くのみ（スクロール不要・展開なし）', 'ページの「{N}件 表示」の宣言件数と、実際に列挙された件数が一致すること', NULL, 1795051455000);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (2, '["facility_list"]', '{P}/show.html', 'show.html', NULL, '開くのみ（スクロール不要・展開なし）', 'ページの「{N}件 表示」の宣言件数と、実際に列挙された件数が一致すること。一覧外の「サービス・情報」は母集合に入れない', NULL, 1795051455000);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (3, '["dpa_page"]', 'tdr/guide/app_service/disneypremieraccess.html', 'disneypremieraccess.html', '#tab-6546897=tds&attraction-more-7040603=open', '主：状態つきURLで直接開く（Sea用フラグメントは state_fragment。開いた後に錨で確かめ、合わなければ副手順に落とす）。副：対象パークのタブを押し、節ごとに錨まで「もっと見る」を押す。対象パークでない側は開かない。スクロール不要', '節ごとの「全{N}件」の宣言件数と、価格つき列挙件数が一致すること', NULL, 1795051455000);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (4, '["operations","show_schedule"]', '{P}/daily/calendar/{D}/', 'daily/calendar', NULL, '開く→休止情報のうちアトラクション／パレード・ショー／レストランの3カテゴリだけ折りたたみを開く（他のカテゴリは開かない）。スクロール不要', '開園時間の表記・当日の大人価格・公演セクションの存在が確認できること。遠い日付で公演が「未定」なのは異常ではない', NULL, 1795051455000);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (5, '["announcements"]', 'tdr/news/update.html', 'news/update.html', NULL, '開く→前回確認より新しい分が初期10件に収まれば展開しない（条件つき展開）。スクロール不要', 'ページの注記「最新の20件のみ表示」があること', NULL, 1795051455000);
--> statement-breakpoint
INSERT INTO `acquisition_plan_rows` (`row_no`, `kinds_json`, `url_template`, `url_match`, `state_fragment`, `operations`, `anchor`, `note`, `updated_at`) VALUES (6, '["ticket_prices"]', 'ticket/index/{M}/?park={P}', 'ticket/index', NULL, '予備行：通常は取らない。行#4に当日価格が無い場合のみ開く', '対象月の当該パークのチケット価格（大人の単価）の表記があること', '予備行', 1795051455000);
