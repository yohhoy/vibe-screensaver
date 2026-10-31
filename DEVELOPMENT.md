# DEVELOPMENT.md — 実装者向けメモ

作品の概要・操作は [README.md](README.md) を参照。

## 方針

- 1 作品 = HTML 1 ファイルで完結させる。ビルド・npm・外部ファイルは使わない。
- Three.js は既存と同じ importmap（jsDelivr の `three@0.160.0`）で読み込む。
- 新作は既存ファイル（[pipes.html](pipes.html) など）を土台にし、`<head>` の CSS・`#fade`・`#hud`、スクリプトの節の順番（下の「ファイルの構成」）を揃える。
- 「入力・UI」節（`fadeAndRun`、全画面、カーソルを隠す処理、`KEY_ACTIONS`、リサイズ）は全ファイル共通。直すときは全ファイル揃えて直す。
- キー操作（`KEY_ACTIONS`）は Cmd / Ctrl / Alt を押しながらの操作には反応させず、ブラウザに任せる（Cmd+F など）。
- 調整できる値はファイル冒頭の「設定」節に定数で置く。名前だけで意味・単位が分からない定数には、その行のコメントに意味・単位・範囲を書く（`CAM_FOV` や `FISH_COLOR` のように名前で分かるものには書かなくてよい）。定数の一覧表はドキュメントに作らない（コメントと二重になり、食い違うため）。
- 時間で進む位相（うねり・明滅など）は JS（倍精度）で 0〜2π に収めてからシェーダーに渡す。GPU の float に経過秒をそのまま渡すと、長時間動かしたときに動きが荒れる。
- コメント・UI の文言は日本語。
- 文体は、ユーザ向けの文章（README.md・index.html）は敬体、実装者向けの文章（DEVELOPMENT.md・CLAUDE.md・コメント）は常体にする。

## 作品を追加・変更したとき

- [index.html](index.html) の作品一覧にリンクを追加・更新する。
- README.md の作品ごとの節（1 行の概要・操作）を更新する。
- 新作や見た目が大きく変わったときは、README.md のサムネイル（`docs/images/<作品名>.jpg`、640×360）を撮り直し、作品ごとの節の見出しの下に載せる。ヘッドレス Chrome の `--screenshot` と `--virtual-time-budget` で撮れる。HUD は CSS で隠し、pipes は `updatePipes` を先に回してパイプを伸ばしてから撮る。
- `docs/<作品名>.md` の仕様（と、コースや景色などの定義）を更新する。新作ならファイルを作り、下の「作品ごとの仕様」に追加する。
- 動作確認は `open <file>.html` でブラウザ表示して確認する。

## ファイルの構成

どの HTML ファイルも単独で動くよう、共通部分も各ファイルに書く。そのかわり、スクリプトは同じ順番の節に分ける。

| 節 | 内容 |
|---|---|
| 設定 | 調整用の定数（意味はコメントに書く） |
| シェーダー | 独自の GLSL（tube / drone / ripple / campfire のみ） |
| three.js 初期化 | レンダラー、シーン、カメラ、ポストエフェクト |
| 状態 | 速度など、実行中に変わる値 |
| （作品ごとの本体） | パイプ、トンネルとハッチ、街・輪・ドローン、雨と波紋、炎と火の粉、クラゲと泡など |
| メインループ | `tick(now)`。経過時間は最大 0.1 秒に抑える |
| 入力・UI | 暗転（`fadeAndRun`）、全画面、カーソルを隠す処理、キー操作（`KEY_ACTIONS`）、リサイズ |
| 開始 | 初期化して `renderer.setAnimationLoop(tick)` |

共通の挙動:

- Three.js（v0.160.0）を CDN（jsDelivr）から読み込むため、インターネット接続が必要。
- WebGL2 に対応したブラウザ（最近の Chrome / Safari / Firefox / Edge）で動作する。
- 3 秒間操作しないと、マウスカーソルと操作ガイドが自動で消える。

## 作品ごとの仕様

作品ごとの仕様は `docs/` に分けてある。作品を触るときは、そのファイルを読んでから作業する。調整用の定数の意味は、各 HTML の「設定」節のコメントを見る。

| 作品 | 仕様 |
|---|---|
| pipes.html — 3D パイプ | [docs/pipes.md](docs/pipes.md) |
| tube.html — チューブトンネル | [docs/tube.md](docs/tube.md)（隠し要素のマスコットを含む） |
| drone.html — ナイトドローン | [docs/drone.md](docs/drone.md)（コースの定義を含む） |
| ripple.html — 雨の水面 | [docs/ripple.md](docs/ripple.md)（景色の定義を含む） |
| campfire.html — 焚き火 | [docs/campfire.md](docs/campfire.md) |
| jellyfish.html — クラゲ水槽 | [docs/jellyfish.md](docs/jellyfish.md) |

SNS 投稿用などの動画の書き出し手順は [docs/video.md](docs/video.md) にある。
