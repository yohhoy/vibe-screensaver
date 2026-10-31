# CLAUDE.md

ブラウザで動くスクリーンセーバ風 3D アニメーション集。概要・操作・設定は [README.md](README.md) を参照。

## 方針

- 1 作品 = HTML 1 ファイルで完結させる。ビルド・npm・外部ファイルは使わない。
- Three.js は既存と同じ importmap（jsDelivr の `three@0.160.0`）で読み込む。
- 新作は既存ファイル（[pipes.html](pipes.html) など）を土台にし、`<head>` の CSS・`#fade`・`#hud`、スクリプトの節の順番（README「ファイルの構成」）を揃える。
- 「入力・UI」節（`fadeAndRun`、全画面、カーソルを隠す処理、`KEY_ACTIONS`、リサイズ）は全ファイル共通。直すときは全ファイル揃えて直す。
- 調整できる値はファイル冒頭の「設定」節に定数で置く。
- コメント・UI の文言は日本語。

## 作品を追加・変更したとき

- [index.html](index.html) の作品一覧にリンクを追加・更新する。
- README.md の一覧表と作品ごとの節（内容・操作・主な設定）を更新する。
- 動作確認は `open <file>.html` でブラウザ表示して確認する。
