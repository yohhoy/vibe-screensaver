# 動画の書き出し

SNS 投稿用などの動画は、画面を録画せずに 1 コマずつ描き出して作る。コマ落ちせず、出来事のタイミングも正確に合わせられる。

投稿用の動画は 1280×720・30fps に固定する。

1. コピーした HTML の `renderer.setAnimationLoop(tick)` を収録用の処理に置き換え、`tick(now)` を 1/FPS 秒ずつ進めて 1 コマずつ描く。
2. 描いた画面を 2D canvas に `drawImage` で写し（フェードは `globalAlpha` と黒い下地で作る）、`toBlob` してローカルの Python サーバーへ `fetch` で送る。
3. サーバーは受け取ったコマを ffmpeg（`-f image2pipe`）に流して H.264 にする。

## 落とし穴

- ヘッドレス Chrome の画面の大きさは `--window-size` どおりにならない（高さが奇数になることがあり、H.264 で失敗する）。収録の前に `renderer.setPixelRatio(1)`、`renderer.setSize(1280, 720)`、`camera.aspect` を固定する。
- コマは JPEG（品質 0.95）で送る。PNG は 1 枚数 MB あり、約 500 枚で Chrome の Blob のメモリ上限に達して `fetch` が失敗する。
- サーバーは HTTP/1.1 にして接続を使い回し、送信に失敗したら送り直す。
- JPEG から作った動画は色の範囲がフルレンジ（`yuvj420p`）になる。最後に `-vf "scale=in_range=pc:out_range=tv,format=yuv420p"` で標準の範囲に変換する。
- Chrome は `--user-data-dir` で普段のプロフィールと分ける。
- 収録は数分かかるので、進み具合（景色・コマ数）をサーバーのログに出し、止まったら気づけるようにする。
- 書き出した `*.mp4` は Git の管理外（`.gitignore`）。
