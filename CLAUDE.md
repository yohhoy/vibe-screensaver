# CLAUDE.md

ブラウザで動くスクリーンセーバ風アニメーション集。概要・操作は [README.md](README.md)、実装の方針・構成・設定は [DEVELOPMENT.md](DEVELOPMENT.md) を参照。

@DEVELOPMENT.md

## コードの書き方

- シェーダーはできるだけ複雑にしない。見た目の調整はまず定数や色で行い、ループや分岐を増やさない。
- three.js の `Vector4` の初期値は `(0, 0, 0, 1)`（w が 1）。uniform の初期値に使うときは 4 つとも明示する。

## 動画の書き出し

SNS 投稿用などの動画は、画面を録画せずに 1 コマずつ描き出して作る。コマ落ちせず、出来事のタイミングも正確に合わせられる。

1. コピーした HTML の `renderer.setAnimationLoop(tick)` を収録用の処理に置き換え、`tick(now)` を 1/FPS 秒ずつ進めて 1 コマずつ描く。
2. 描いた画面を 2D canvas に `drawImage` で写し（フェードは `globalAlpha` と黒い下地で作る）、`toBlob` してローカルの Python サーバーへ `fetch` で送る。
3. サーバーは受け取ったコマを ffmpeg（`-f image2pipe`）に流して H.264 にする。

落とし穴:

- ヘッドレス Chrome の画面の大きさは `--window-size` どおりにならない（高さが奇数になることがあり、H.264 で失敗する）。収録の前に `renderer.setPixelRatio(1)`、`renderer.setSize(1920, 1080)`、`camera.aspect` を固定する。
- コマは JPEG（品質 0.95）で送る。PNG は 1 枚数 MB あり、約 500 枚で Chrome の Blob のメモリ上限に達して `fetch` が失敗する。
- サーバーは HTTP/1.1 にして接続を使い回し、送信に失敗したら送り直す。
- JPEG から作った動画は色の範囲がフルレンジ（`yuvj420p`）になる。最後に `-vf "scale=in_range=pc:out_range=tv,format=yuv420p"` で標準の範囲に変換する。
- Chrome は `--user-data-dir` で普段のプロフィールと分ける。
- 収録は数分かかるので、進み具合（景色・コマ数）をサーバーのログに出し、止まったら気づけるようにする。

## Git

- ブランチを作らず、main に直接コミットする。push は指示があったときだけ。
