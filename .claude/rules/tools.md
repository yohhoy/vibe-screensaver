---
paths:
  - "tools/**"
---

# ツール

- 動画の書き出し・変更前後の比較（video-export.mjs・video-compare.mjs）は、先に docs/video.md を読む。
- GPU 負荷の計測（gpu-bench.mjs）は指示があったときだけ行い、先に docs/performance.md を読む。基準値（docs/performance-data.md）は、値を見るか書き直すときだけ読む。
- ツールの使い方は docs/video.md・docs/performance.md で調べる。ソースは、ツールを直すときだけ読む。
- 画像の切り出し・拡大・並べる・明るさの測定は `tools/img.mjs` で行い、ffmpeg のフィルタや PIL を手で組まない（docs/video.md の「画像の切り出し・並べ・明るさ」）。足りない機能は img.mjs に足す。
- 出力やログは全文を見ず、要るところを `grep` などで絞って見る。
