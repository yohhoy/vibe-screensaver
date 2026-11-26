---
paths:
  - "tools/**"
---

# ツールを直すとき

- ツールの使い方は docs/video.md・docs/performance.md に書いてある。ソースを読むのは、ツールを直すときだけにする。
- 引数や動きを変えたら、ファイル冒頭の使い方（`USAGE`）と docs/video.md・docs/performance.md の説明も合わせる。
- common.mjs・pages.mjs は video-export・video-compare・bench で共通なので、変えたら全作品（`pages.mjs` の `PAGES`）を video-export で撮り、エラーで止まらないことを確かめる。
- 画像の加工で足りない機能は、ffmpeg を手で組まずに img.mjs に足す。
- 負荷の基準値（docs/performance-data.md）は、値を見るか書き直すときだけ読む。
