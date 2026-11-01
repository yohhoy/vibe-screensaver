# DEVELOPMENT.md — 実装者向けメモ

作品の概要・操作は [README.md](README.md) を参照。

## 方針

- 1 作品 = HTML 1 ファイル。全作品で共通の入力・UI は [common.js](common.js)、共通の CSS は [common.css](common.css) にまとめ、各 HTML から読み込む。ビルド・npm は使わない。
- common.js は ES モジュールにせず、通常の `<script src>` で読み込む（`file://` で直接開くと、ES モジュールの import はブラウザに止められるため）。使うものは `window.Common` に置き、各作品は `const { IS_TOUCH, fadeAndRun, logPosition, setupControls } = Common;` で取り出す。
- Three.js は既存と同じ importmap（jsDelivr の `three@0.160.0`）で読み込む。importmap は外部ファイルにできないので、各 HTML に書く。
- 新作は既存ファイル（[pipes.html](pipes.html) など）を土台にし、`<head>`（common.css・common.js・importmap）、`#hud`、スクリプトの節の順番（下の「ファイルの構成」）を揃える。
- 各作品の「入力・UI」節は `setupControls({ changeScene, intensity, keys, onResize })` を 1 回呼ぶだけにする。作品ごとに違うのは、シーン切替・強度の割り当て、作品だけのキー操作（`keys`）、リサイズのときの処理（`onResize`）。暗転・全画面・カーソルを隠す処理・画面を消さない処理・キーとスワイプの受け付け・強度のゲージは common.js で直す。
- キー操作は Cmd / Ctrl / Alt を押しながらの操作には反応させず、ブラウザに任せる（Cmd+F など）。
- **シーン切替**: Space キーと、スマホでの左右スワイプ（指での操作のみ）で行う、暗転して次の場面へ移る操作。`setupControls` の `changeScene` に渡す。場面が 1 つだけの作品は `null` にする。何が変わるかは作品ごとの仕様（`docs/<作品名>.md`）に書く。
- **強度**: ↑↓ キーと、スマホでの上下スワイプ（上へで強める）で変える、作品ごとの強さ（速度・雨の強さ・火の強さ・泡の筋の数）。`setupControls` の `intensity`（強める `up`・弱める `down`・ゲージの位置を返す `level`）に渡す。変えたときは、右端の細いゲージ（`#intensity`）にいまの値を少しの間だけ出す。数値や文字は出さない。倍率で変える値は、`logPosition` でゲージを対数で並べる。
- 調整できる値はファイル冒頭の「設定」節に定数で置く（全作品で共通の値は common.js の「設定」）。名前だけで意味・単位が分からない定数には、その行のコメントに意味・単位・範囲を書く（`CAM_FOV` や `FISH_COLOR` のように名前で分かるものには書かなくてよい）。定数の一覧表はドキュメントに作らない（コメントと二重になり、食い違うため）。
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

| ファイル | 内容 |
|---|---|
| `<作品名>.html` | 作品の本体。下の節に分ける |
| common.js | 全作品で共通の入力・UI（暗転、全画面、カーソルを隠す処理、画面を消さない処理、キーとスワイプ、強度のゲージ）と、`IS_TOUCH`・`logPosition` |
| common.css | 全作品で共通の CSS（画面全体、`#fade`・`#hud`・`#intensity`） |

各作品のスクリプトは同じ順番の節に分ける。

| 節 | 内容 |
|---|---|
| 設定 | 調整用の定数（意味はコメントに書く） |
| シェーダー | 独自の GLSL（tube / drone / ripple / campfire のみ） |
| three.js 初期化 | レンダラー、シーン、カメラ、ポストエフェクト |
| 状態 | 速度など、実行中に変わる値 |
| （作品ごとの本体） | パイプ、トンネルとハッチ、街・輪・ドローン、雨と波紋、炎と火の粉、クラゲと泡など |
| メインループ | `tick(now)`。経過時間は最大 0.1 秒に抑える |
| 入力・UI | `setupControls()` にシーン切替・強度・作品だけのキー操作・リサイズのときの処理を渡す |
| 開始 | 初期化して `renderer.setAnimationLoop(tick)` |

共通の挙動:

- Three.js（v0.160.0）を CDN（jsDelivr）から読み込むため、インターネット接続が必要。
- WebGL2 に対応したブラウザ（最近の Chrome / Safari / Firefox / Edge）で動作する。
- 3 秒間操作しないと、マウスカーソルと操作ガイドが自動で消える。
- スマホなどタッチ操作の端末（`pointer: coarse`）では、表示している間は画面が自動で消えないようにする（Screen Wake Lock。対応ブラウザのみ。断られたら次の操作で取り直す）。PC では何もしない。
- 解像度の倍率の上限は、PC とタッチ操作の端末（`IS_TOUCH`）で分ける（作品ごとの `MAX_PIXEL_RATIO` の `pc` / `touch`）。タッチ操作の端末は画面の密度が高く GPU も非力なので低くする。
- タッチ操作の端末では、ダブルタップ・ピンチでの拡大と長押しでの文字選択を止める（PC では止めない）。操作ガイドはセーフエリア（ノッチ・ホームバー）の内側に置いて画面幅で折り返す。

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
