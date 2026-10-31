# vibe-screensaver — Web スクリーンセーバ集

Webブラウザで動く、スクリーンセーバ風のアニメーション集です。

**▶ ブラウザですぐに見る: https://yohhoy.github.io/vibe-screensaver/**

## 動かし方

上の URL を開くか、手元で [index.html](index.html) をブラウザで開きます。WebGL2 対応のブラウザとインターネット接続が必要です。

## [3D パイプ](https://yohhoy.github.io/vibe-screensaver/pipes.html)

[<img src="docs/images/pipes.jpg" width="480" alt="3D パイプ">](https://yohhoy.github.io/vibe-screensaver/pipes.html)

3D 空間に、色とりどりのパイプが自動で伸びていきます。

| キー | 動作 |
|---|---|
| Space | リセット |
| F / ダブルクリック | 全画面 |
| J | ジョイントを球 ⇔ エルボーで切り替え |
| ↑ / ↓ | 速度の変更 |

## [チューブトンネル](https://yohhoy.github.io/vibe-screensaver/tube.html)

[<img src="docs/images/tube.jpg" width="480" alt="チューブトンネル">](https://yohhoy.github.io/vibe-screensaver/tube.html)

ネオングリッドのチューブの中を、どこまでも飛び続けます。

| キー | 動作 |
|---|---|
| Space | 新しいコースと配色に切り替え |
| F / ダブルクリック | 全画面 |
| ↑ / ↓ | 速度の変更 |

<details>
<summary>隠し要素（ネタバレ注意）</summary>

ときどき壁のハッチから Claude Code のマスコットが跳び出してきます。**C** キーですぐに呼び出せます。

</details>

## [ナイトドローン](https://yohhoy.github.io/vibe-screensaver/drone.html)

[<img src="docs/images/drone.jpg" width="480" alt="ナイトドローン">](https://yohhoy.github.io/vibe-screensaver/drone.html)

夜の街を、紙飛行機形のドローンが輪をくぐりながら飛び続けます。

| キー | 動作 |
|---|---|
| Space | 次のコースへ |
| F / ダブルクリック | 全画面 |
| ↑ / ↓ | 速度の変更 |

## [雨の水面](https://yohhoy.github.io/vibe-screensaver/ripple.html)

[<img src="docs/images/ripple.jpg" width="480" alt="雨の水面">](https://yohhoy.github.io/vibe-screensaver/ripple.html)

静かな水面に雨が降り、波紋がゆるやかに広がっては消えていきます。

| キー | 動作 |
|---|---|
| Space | 景色の切り替え（夜の湖面 / 街あかり / 霧雨の朝） |
| F / ダブルクリック | 全画面 |
| ↑ / ↓ | 雨の強さの変更 |

<details>
<summary>隠し要素（ネタバレ注意）</summary>

景色ごとに、ときどき出来事が起こります。夜の湖面では流れ星が流れ、街あかりでは UFO が現れ、霧雨の朝では魚が跳ねます。**C** キーで、いまの景色の出来事をすぐに起こせます。

</details>

## [焚き火](https://yohhoy.github.io/vibe-screensaver/campfire.html)

[<img src="docs/images/campfire.jpg" width="480" alt="焚き火">](https://yohhoy.github.io/vibe-screensaver/campfire.html)

夜の森の焚き火。炎が揺らぎ、火の粉が星空へ舞い上がります。

| キー | 動作 |
|---|---|
| F / ダブルクリック | 全画面 |
| ↑ / ↓ | 火の強さの変更 |

## 開発者向け情報

実装の方針は [DEVELOPMENT.md](DEVELOPMENT.md)、作品ごとの仕様は [docs/](docs/) を参照してください。調整用の定数は、各 HTML ファイル冒頭の「設定」節にあります。

## ライセンス

[MIT License](LICENSE)
