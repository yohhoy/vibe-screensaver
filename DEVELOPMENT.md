# DEVELOPMENT.md — 実装者向けメモ

作品の概要・操作は [README.md](README.md)、作品ごとの仕様は `docs/specs/<作品名>.md` を参照。

## 方針

- 1 作品 = HTML 1 ファイル。全作品で共通の処理は [common.js](common.js)、共通の CSS は [common.css](common.css) にまとめ、各 HTML から読み込む。ビルド・npm は使わない。
- Three.js（v0.160.0）は jsDelivr から importmap で読み込む。importmap は外部ファイルにできないので、各 HTML に書く。
- 動作環境は WebGL2 に対応したブラウザ（最近の Chrome / Safari / Firefox / Edge）。Three.js を CDN から読み込むため、インターネット接続が必要。
- 調整できる値はファイル冒頭の「設定」節に定数で置く（全作品で共通の値は common.js の「設定」）。名前だけで意味・単位が分からない定数には、その行のコメントに意味・単位・範囲を書く（`CAM_FOV` や `FISH_COLOR` のように名前で分かるものには書かなくてよい）。定数の一覧表はドキュメントに作らない（コメントと二重になり、食い違うため）。
- 時間で進む位相（うねり・明滅など）は JS（倍精度）で 0〜2π に収めてからシェーダーに渡す。GPU の float に経過秒をそのまま渡すと、長時間動かしたときに動きが荒れる。
- ブルームなどを使う作品では、マルチサンプルにするのはシーンを描く描画先だけにする。composer の描画先までマルチサンプルにすると、全画面の処理がとても重くなる。ブルームは解像度を下げて描き、効果がほとんど無い場面では切る。
- コメント・UI の文言は日本語。文体は、ユーザ向けの文章（README.md・index.html）は敬体、実装者向けの文章（DEVELOPMENT.md・CLAUDE.md・docs・コメント）は常体にする。

## ファイルの構成

| ファイル | 内容 |
|---|---|
| `<作品名>.html` | 作品の本体。`<head>` に common.css・common.js・importmap を読み込み、`<body>` には操作ガイド（`#hud`）だけを書く |
| common.js | 全作品で共通の入力・UI と小さな関数（下の「共通の仕組み」） |
| common.css | 全作品で共通の CSS（画面全体、暗転 `#fade`、操作ガイド `#hud`、強度のゲージ `#intensity`） |
| index.html | 作品一覧 |
| docs/specs/ | 作品ごとの仕様 |
| docs/images/ | README 用のサムネイル |
| docs/video.md | 動画の書き出し手順 |
| docs/performance.md | GPU 負荷の基準値 |
| tools/gpu-bench.mjs | 全作品の GPU 負荷をシーン別に測るスクリプト（[docs/performance.md](docs/performance.md)） |

各作品のスクリプトは、次の順番の節に分ける。（任意）の節は、その作品で要るときだけ置く。作品の本体は、作品ごとに分かりやすい節に分けてよい。

| 節 | 内容 |
|---|---|
| 設定 | 調整用の定数（意味はコメントに書く） |
| ユーティリティ（任意） | その作品だけで使う小さな関数・定数。全作品で使うものは common.js に置く |
| シェーダー（任意） | 独自の GLSL |
| three.js 初期化 | レンダラー、シーン、カメラ、ポストエフェクト |
| 状態 | 速度など、実行中に変わる値 |
| （作品の本体） | パイプ、トンネルとハッチ、街・輪・ドローン、雨と波紋、炎と火の粉、クラゲと泡、オーロラ、崖と滝と滝壺、カメラなど |
| シーン切替（任意） | 暗転して次の場面へ移る処理（場面が 1 つだけの作品には無い） |
| 強度 | 強度を変える処理（`setSpeed` など） |
| メインループ | `tick(now)`。経過時間は最大 0.1 秒に抑える |
| 入力・UI | `setupControls()` を 1 回呼ぶ |
| 開始 | 初期化して `renderer.setAnimationLoop(tick)` |

## 共通の仕組み（common.js）

common.js は ES モジュールにせず、通常の `<script src>` で読み込む（`file://` で直接開くと、ES モジュールの import はブラウザに止められるため）。使うものは `window.Common` に置き、各作品は使うものだけを取り出す。

```js
const { TAU, rand, IS_TOUCH, fadeAndRun, setupControls } = Common;
```

### 操作

| 操作 | PC | スマホ | 作品側で渡すもの |
|---|---|---|---|
| シーン切替 | Space | 左右スワイプ | `changeScene`（場面が 1 つだけなら `null`） |
| 強度 | ↑ / ↓ | 上下スワイプ（上へで強める） | `intensity`（`up`・`down`・`level`） |
| 全画面 | F / ダブルクリック | — | — |
| 作品だけの操作 | J・C など | — | `keys` |

各作品の「入力・UI」節では、これを `setupControls()` に渡す。

```js
setupControls({
  changeScene: reset,                       // シーン切替
  intensity: {                              // 強度
    up: () => setSpeed(speed * SPEED_STEP),
    down: () => setSpeed(speed / SPEED_STEP),
    level: () => logPosition(speed, MIN_SPEED, MAX_SPEED),   // ゲージの位置（0..1）
  },
  keys: { KeyJ: toggleJoint },              // 作品だけのキー操作（KeyboardEvent.code）
  onResize() { /* カメラ・レンダラーの大きさを合わせる */ },
});
```

- **シーン切替**: 暗転して次の場面へ移る操作。何が変わるかは作品ごとの仕様（`docs/specs/<作品名>.md`）に書く。暗転は `fadeAndRun(change)` で、暗転している間に `change()` を呼ぶ。暗転中かは `isFading()` で分かる。
- **強度**: 作品ごとの強さ（速度・雨の強さ・火の強さ・泡の筋の数・オーロラの帯の数・水量）。変えたときは、右端の細いゲージ（`#intensity`）にいまの値を少しの間だけ出す。数値や文字は出さない。倍率で変える値は、`logPosition` でゲージを対数で並べる。
- キー操作は Cmd / Ctrl / Alt を押しながらの操作には反応させず、ブラウザに任せる（Cmd+F など）。
- スワイプは指での操作だけを受け付ける（マウスのドラッグや 2 本目の指には反応しない）。十分に動き、縦横の一方の動きがもう一方の 2 倍以上あるときだけスワイプとみなす。
- 3 秒間操作しないと、マウスカーソルと操作ガイドが自動で消える。

### スマホなどタッチ操作の端末

`IS_TOUCH`（`pointer: coarse`）で判定し、次のように扱う。PC ではどれも行わない。

- 表示している間は画面が自動で消えないようにする（Screen Wake Lock。対応ブラウザのみ。断られたら次の操作で取り直す）。
- 解像度の倍率の上限を下げる。作品ごとの `MAX_PIXEL_RATIO` を `{ pc, touch }` で書く。タッチ操作の端末は画面の密度が高く GPU も非力なので低くする。
- ダブルタップ・ピンチでの拡大と、長押しでの文字選択を止める（common.css）。
- 操作ガイドはセーフエリア（ノッチ・ホームバー）の内側に置き、画面幅で折り返す（これは PC でも同じ）。

### 小さな関数

`TAU`、`clamp`、`rand(a, b)`、`randIn([a, b])`、`randInt(n)`、`randSign()`、`pick(arr)`、`randExp(mean)`（指数分布）、`randomInterval([mean, min, max])`（ランダムに起こる出来事の間隔）、`gray(v, a)`（canvas に渡す灰色）、`emit(sys, rate, dt, spawn)`（粒を一定のペースで生む）。2 つ以上の作品で使う小さな関数は、各作品に書かずにここに置く。three.js に頼るもの（`THREE.MathUtils.smoothstep` など）は three.js のものを使う。

## 作品を追加・変更したとき

- 新作は既存ファイル（[pipes.html](pipes.html) など）を土台にし、`<head>`、`#hud`、節の順番を揃える。
- [index.html](index.html) の作品一覧にリンクを追加・更新する。
- README.md の作品ごとの節（1 行の概要・操作）を更新する。
- 新作や見た目が大きく変わったときは、README.md のサムネイル（`docs/images/<作品名>.jpg`、640×360）を撮り直し、作品ごとの節の見出しの下に載せる。ヘッドレス Chrome の `--screenshot` と `--virtual-time-budget` で撮れる。HUD は CSS で隠し、pipes は `updatePipes` を先に回してパイプを伸ばしてから撮る。
- `docs/specs/<作品名>.md` の仕様（と、コースや景色などの定義）を更新する。新作ならファイルを作り、下の「作品ごとの仕様」に追加する。
- 動作確認は `open <file>.html` でブラウザ表示して確認する。ヘッドレス Chrome で確かめるときは、ページを開くだけでなく、`--enable-logging=stderr` でコンソールのエラー（`Uncaught`）が出ていないかも見る。
- 見た目を変えないリファクタリングは、`Math.random` を固定の乱数に差し替え、決まったコマ数だけ進めた画像を変更前後で比べる。
  - three.js は UUID を作るのに `Math.random` を使う。テクスチャや材質を作る順番を変えると乱数の列がずれ、コードが正しくても画像が変わる。比べるときは、変更前のコードも作る順番を揃える。
  - `setAnimationLoop` を止めて 1 回だけ描くと、撮影した画像が空白になることがある。同じコマを描き続けて撮る。
  - 空白の画像どうしでも差は 0 になる。差だけでなく、画像に中身があることも確かめる。
- GPU の負荷は `node tools/gpu-bench.mjs` で変更前後を測って比べる。基準値と比べ方は [docs/performance.md](docs/performance.md) にある。
- 手で測るときは、描画のあとに `gl.readPixels` で 1 画素読み、GPU の完了を待ってから時間を測る（描画の命令を出すだけなら、すぐに戻ってしまう）。GPU のクロックが負荷に応じて変わるので、ふつうに測ると値が段階的に変わる。変更前後を交互に数回ずつ測り、中央値で比べる。

## 作品ごとの仕様

作品ごとの仕様は `docs/specs/` に分けてある。作品を触るときは、そのファイルを読んでから作業する。調整用の定数の意味は、各 HTML の「設定」節のコメントを見る。

| 作品 | 仕様 |
|---|---|
| pipes.html — 3D パイプ | [docs/specs/pipes.md](docs/specs/pipes.md) |
| tube.html — チューブトンネル | [docs/specs/tube.md](docs/specs/tube.md)（隠し要素のマスコットを含む） |
| drone.html — ナイトドローン | [docs/specs/drone.md](docs/specs/drone.md)（コースの定義を含む） |
| ripple.html — 雨の水面 | [docs/specs/ripple.md](docs/specs/ripple.md)（景色の定義を含む） |
| campfire.html — 焚き火 | [docs/specs/campfire.md](docs/specs/campfire.md) |
| jellyfish.html — クラゲ水槽 | [docs/specs/jellyfish.md](docs/specs/jellyfish.md) |
| aurora.html — オーロラ | [docs/specs/aurora.md](docs/specs/aurora.md)（隠し要素のサンタクロースを含む） |
| waterfall.html — 滝 | [docs/specs/waterfall.md](docs/specs/waterfall.md)（景色の定義を含む） |

### 仕様の書き方

`docs/specs/<作品名>.md` は、`# <作品名>.html — 名前` の下に 1〜2 文の概要を置き、次の順番の `##` 節に分ける。（任意）の節は、その作品で要るときだけ置く。

| 節 | 内容 |
|---|---|
| カメラ | 視点と動き |
| （作品の本体） | 崖、滝、クラゲ、泡など、作品ごとに分かりやすい節に分ける |
| シーン切替 | 暗転している間に何が変わるか。場面が 1 つだけの作品では「無い」と書く |
| 強度 | 何を変えるか、範囲、最初の値、1 回の操作でどれだけ変わるか。それに伴う変化 |
| 隠し要素（任意） | README で「隠し要素」として扱うもの。出方と、呼び出すキー |
| 描き方（任意） | 見た目に出ない実装の工夫と、負荷を抑える工夫 |
| コース・景色の定義（任意） | `COURSES`・`SCENES` などの項目の表 |

- 数値を書くのは、動きや見た目の仕様として意味があるものだけにする。調整用の定数を並べない。
- 「なぜそうするか」（別のやり方でどう見た目が崩れるかなど）は、コードから読み取れないので残す。
- 表記を揃える。
  - 強度: 「強度は X。範囲は A〜B、最初は C で、1 回の操作で D 倍ずつ変える。」
  - 時間の間隔: 「ときどき（A〜B 秒おき、平均 C 秒ほどに 1 回）」
  - 隠しキー: 「**C** キーですぐに呼び出せる（操作ガイドには表示しない）。」
  - 用語: 「操作ガイド」（HUD とは書かない）、`MSAA`、「起動時」、`canvas`

SNS 投稿用などの動画の書き出し手順は [docs/video.md](docs/video.md) にある。
