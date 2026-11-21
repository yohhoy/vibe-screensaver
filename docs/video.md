# 動画の書き出し

SNS 投稿用などの動画と静止画は、`tools/video-export.mjs` で作る。画面を録画せずに 1 コマずつ描き出すので、コマ落ちせず、同じ種からは同じ映像ができる。形式は 1280×720・30fps の H.264 に固定している。

```sh
node tools/video-export.mjs waterfall --scenes 0,1,2 --seconds 5 --out out.mp4
```

依存は Node.js（22 以降）、Google Chrome、ffmpeg（ffprobe を含む）。作品の HTML は変更しない。オプションの一覧は、引数なしで実行すると出る。

## 静止画

`--out` を `.png` にすると、動画の代わりに静止画（PNG）を作る。各場面の最後のコマを、JPEG を通さずにそのまま書く。

```sh
node tools/video-export.mjs sandpicture --presets 0 --hidden off --warmup 190 --size 1920x1080 --out desert.png
```

- `--warmup` が準備の長さ（絵を進める秒数）で、そのあとに `--seconds`（既定 0）だけ進めた最後のコマを撮る。砂が積もりきるまで待つ作品などは、`--warmup` を長くする。
- `--size 幅x高さ` で大きさを決める（既定 1280x720）。動画は 1280x720 に固定で、`--size` は使えない。
- `--shots 0,1.5,3` で、場面ごとに複数の時刻（収録を始めてからの秒）のコマを撮る。`--seconds` の代わりに使い、Chrome の起動は 1 回で済む。時刻ごとに撮り直さない。
- 2 枚以上なら、`desert-1.png`・`desert-2.png` のように場面ごと・時刻の順に番号を付け、縮小して並べた確認用の画像 `desert.sheet.jpg` も作る（時刻が複数なら 1 行に 1 場面の各時刻、そうでなければ 1 行に 4 枚）。
- 標準出力に、1 枚ごとの明るさ（輝度の平均と最大。0〜255）が出る。明るさの調整は、画像を開かずにこの数値で判断する。ffmpeg で数値を取り直さない。
- `--fade` は使わない。`--scenes`・`--presets`・`--hidden`・`--at`・`--seed` は動画と同じに使える。
- ページのエラー（`Uncaught`・`console.error`。シェーダーのコンパイルの失敗を含む）が起きると、撮影はエラーで止まる。シェーダーのエラーは、GLSL のエラーの行（`ERROR:`）も出す。起動の確認や縦長の画面（`--size 720x1280`）の確認にも、ヘッドレス Chrome を直接呼ばずにこれを使う。
- 画像を開くときは、PNG を 1 枚ずつ開かず、まず `.sheet.jpg` を 1 枚だけ開く。

## 場面の指定

シーンの定義（`SCENES`）がある drone・ripple・waterfall・penguins・teapot・bubbles・orrery は `--scenes` にシーンの番号を、配色の定義（`COLOR_PRESETS`）がある tube・aurora・lavalamp・sandpicture・teapot・pixelcity は `--presets` に配色の番号を並べる。番号ごとに 1 場面ずつ撮る。シーンと配色は別々に選べ、両方を持つ teapot は同時に指定できる。そのときはシーン × 配色の組み合わせごとに 1 場面撮る（`--scenes 3,13 --presets 1,2` なら、シーン 3 の配色 1・2、シーン 13 の配色 1・2 の 4 場面）。範囲外の番号を渡すと、エラーに名前の一覧が出る（名前の無い tube・lavalamp の配色は `#0` のような番号）。省くと、作品が起動時に選んだシーン・配色のまま 1 場面だけを撮る（どれになるかは `--seed` で変わる）。ほかの作品は場面を選べないので、1 場面だけを撮る。

`--presets` で選ぶとき、tube・aurora・lavalamp は配色だけを替える（コース・幕・小物などは起動時のまま）。sandpicture は配色を替えて、新しい絵から撮る。pixelcity は季節を替えて、新しい土地から撮る。teapot はポットの色だけを替える。シーンを選んでから配色を当てるので、シーンを替えても指定した色のまま撮れる（Wireframe に戻ると、作品が色を選び直す）。

各場面の前に `--warmup` の秒数だけ進めてから収録を始める。起動直後は絵が揃っていない作品（パイプが伸びていない pipes など）では長めにする。

## 出来事のタイミング

`--at "秒:式"` で、動画の時刻に式を実行する。式は作品のスクリプトの中で評価するので、作品の変数と関数を使える。隠し要素は、次の節の `--hidden` で出し入れする。

```sh
node tools/video-export.mjs aurora --seconds 15 --warmup 0 --at "1:startSanta()" --out santa.mp4
```

時刻は動画の中の秒で数える。`--warmup` の時間は含まない。

## 隠し要素

隠し要素（tube・aurora・ripple・penguins・diamond・sandpicture・campfire・waterfall・infcastle・bubbles・orrery）の出し方は `--hidden` で決める。

- `auto`（既定）: 作品に任せる。待ち時間が切れたときに出る。
- `off`: 出さない。サムネイルや、隠し要素を写したくない動画に使う。
- `2,8.5`: 自然には出さず、動画のその時刻に呼び出す。時刻は `--at` と同じく動画の中の秒で、`--warmup` は含まない。

```sh
node tools/video-export.mjs sandpicture --presets 0 --hidden off --out desert.mp4
node tools/video-export.mjs aurora --seconds 15 --warmup 0 --hidden 1 --out santa.mp4
```

作品のトップレベルの関数（`pages.mjs` の `HIDDEN`）を、待ち時間が切れたときの呼び出しと隠しキー（C）が共有している。ツールはその関数を空に差し替えて自然な出現を止め、元の関数を指定の時刻に呼ぶ。隠し要素を足す作品も、この形にして `HIDDEN` に足す。

## 確認

動画の大きさ・コマ数・色の範囲は、書き出しのあとにツールが確かめる。合わなければエラーで止まり、動画は残さない。場面の中ほどが真っ暗なときは警告を出す。

中身の確認は動画を開かず、まず `<出力先>.thumbs.jpg`（等間隔の 12 コマを並べた画像）を見る。`*.mp4` と `*.thumbs.jpg` は Git の管理外（`.gitignore`）。

## 作品の暗転

作品の暗転（`fadeAndRun`）は DOM の要素で作っていて canvas に写らない。収録中は暗転せずにすぐ切り替え、フェードはツールが `--fade` の秒数で各場面の最初と最後に入れる。canvas の外の DOM（操作ガイドなど）も動画には写らない。

## 変更前後の比較

見た目を調整するときは、`tools/video-compare.mjs` で 2 つの版を同じ条件で撮って並べる。上の段が比べる版、下の段が作業ツリーの版になる。どの作品でも使える。

```sh
node tools/video-compare.mjs waterfall --scenes 0,2 --case "少ない:setWater(0.13)" --case "標準:setWater(1)" --open
```

- `--base` で比べる版を選ぶ。git のコミット（既定は `HEAD`）か、控えておいた作品の HTML のパスか、`kept` を渡す。HTML のパスなら、`common.js` などは `HEAD` のものを使う。撮影の処理（video-export.mjs・common.mjs・pages.mjs）は、どちらの版にも作業ツリーのものを使う。
- `--scenes`・`--presets` は video-export と同じ。比べる版にその一覧（`SCENES`・`COLOR_PRESETS`）が無いと、撮影がエラーで止まる。
- `--case "名前:式"` で列を足す。収録の最初に式を実行するので、強度などの条件を作品ごとの式で渡せる（式は `--at` と同じく作品のスクリプトの中で評価する）。省くと 1 列だけ撮る。
- フェードは入れない。読み込みの失敗（`net::ERR_`）で撮影が止まったら、自動で撮り直す。
- 動画は横 1920px までに収める。

コミットせずに何度か調整を重ねるときは、調整を始める前に `--keep` で変更前の版を控え、比べるときは `--base kept` を使う。控えた版は `.kept/<作品名>.html`（Git の管理外）に置き、次に `--keep` するまで残る。一時フォルダに手で写さない。

```sh
node tools/video-compare.mjs bubbles --keep
node tools/video-compare.mjs bubbles --base kept --scenes 2 --seconds 2
```

撮影は 1 場面ずつ、版と列の数だけ繰り返すので、場面と列が多いと数分かかる。調整の途中は、変えたシーンだけを短い `--seconds`（1〜2 秒）で比べる。全シーンを比べるのは、リファクタリングの確かめや仕上げのときに 1 回だけにする。

中身の確認は、まず `<出力先>.thumbs.jpg` を見る。各場面の最後のコマを 1 枚に並べた画像で、`--case` の式で変えた状態が落ち着いたころのコマになる。動画や静止画を何枚も開くより、確認にかかるトークンが少ない。

標準出力には列ごと・場面ごとの差（PSNR）が出る。同じ映像なら「全コマ一致」になる。動画を圧縮してから比べるので、丸め誤差ほどの違いでも 45〜50dB まで下がることがある。値だけで見た目の差を判断せず、画像も見る。

## 画像の切り出し・並べ・明るさ

撮った静止画や動画から確認用の画像を作るとき・明るさを測るときは、`tools/img.mjs` を使う。ffmpeg の `crop`・`hstack`・`tile`・`signalstats` などを手で組まない。

```sh
# 3 枚を並べて 1 枚にする（長辺 800px。既定の出力は <最初の入力>.grid.jpg）
node tools/img.mjs grid a-1.png a-2.png a-3.png --out cmp.jpg
# 変更前後を 2 列に並べる。--crop で同じ範囲を切り出す（px か %）
node tools/img.mjs grid before.png after.png --crop 0,50%,100%,50% --out cmp.jpg
# 小さい範囲を拡大する。--nearest で画素のまま拡大する
node tools/img.mjs grid shot.png --crop 600,300,80,60 --nearest --out zoom.png
# 動画から時刻を指定して取り出す。動画 1 本が 1 行になる
node tools/img.mjs grid before.mp4 after.mp4 --at 1,2,3 --out frames.jpg
# 範囲の明るさ（輝度 0..255）の平均・最大。--rows で上からの帯ごとの平均も出す
node tools/img.mjs luma a-1.png a-2.png --crop 0,0,100%,20% --rows 4
```

- grid の出力は長辺 `--max`（既定 800px）に収まるので、`sips -Z` で縮小し直さなくてよい。コマの並び（何行目がどの入力か）は標準出力に出る。
- コマの大きさは最初の入力（切り出し後）の縦横比で決める。縦長と横長を混ぜると、縦横比を保って黒で埋める。
- 文字は描き込まない（この ffmpeg には `drawtext` が無い）。どのコマが何かは、標準出力の並びで判断する。
- `*.grid.jpg` は Git の管理外（`.gitignore`）。出力は scratchpad の下を指す。
