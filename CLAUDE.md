# CLAUDE.md

ブラウザで動くスクリーンセーバ風アニメーション集。概要・操作は [README.md](README.md)、実装の方針・構成は [DEVELOPMENT.md](DEVELOPMENT.md)、作品ごとの仕様は `docs/specs/<作品名>.md` を参照。

@DEVELOPMENT.md

## コードの書き方

- シェーダーはできるだけ複雑にしない。見た目の調整はまず定数や色で行い、ループや分岐を増やさない。
- three.js の `Vector4` の初期値は `(0, 0, 0, 1)`（w が 1）。uniform の初期値に使うときは 4 つとも明示する。

## 動画の書き出し

SNS 投稿用などの動画は `node tools/video-export.mjs` で作る。先に [docs/video.md](docs/video.md) を読む（使い方と確認のしかた）。

## Git

- ブランチを作らず、main に直接コミットする。push は指示があったときだけ。
