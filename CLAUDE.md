# CLAUDE.md

ブラウザで動くスクリーンセーバ風アニメーション集。概要・操作は [README.md](README.md)、実装の方針・構成は [DEVELOPMENT.md](DEVELOPMENT.md)、作品ごとの仕様は `docs/specs/<作品名>.md` を参照。

## 作業ごとに読むもの

DEVELOPMENT.md は自動では読み込まない。作業に応じて必要な節だけを読む（どれを読むかは `.claude/rules/` が、該当するファイルを開いたときに案内する）。

## 大きなファイルの読み方

- 作品の HTML は大きい（1000〜2000 行を超える）ので全文を読まない。`grep -n '^// ----' <file>.html` で節の行番号を出し、`Read` の offset・limit で関係する節だけを読む。
- 見た目の確認は、まず `node tools/video-compare.mjs` の数値（全コマ一致・差分）で判断する。画像を開くのは要るときだけにし、縮小した 1〜2 枚にする。
- ヘッドレス Chrome のログは全文を見ず、`grep -E 'Uncaught|Error'` などで絞る。

## コードの書き方

- コメント・UI の文言は日本語（シーン名とそのラベルは英語）。ユーザ向けの文章は敬体、実装者向けの文章は常体。
- シェーダーはできるだけ複雑にしない。見た目の調整はまず定数や色で行い、ループや分岐を増やさない。
- three.js の `Vector4` の初期値は `(0, 0, 0, 1)`（w が 1）。uniform の初期値に使うときは 4 つとも明示する。

## 動画の書き出し

SNS 投稿用などの動画・静止画（PNG）は `node tools/video-export.mjs` で作る。先に [docs/video.md](docs/video.md) を読む（使い方と確認のしかた）。

## Git

- ブランチを作らず、main に直接コミットする。push は指示があったときだけ。
