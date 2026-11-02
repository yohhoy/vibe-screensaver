// 全作品で共通の入力・UI と小さな関数。
// 暗転、全画面、カーソルと操作ガイドを隠す処理、画面を消さない処理、キー操作とスワイプ、強度のゲージ、乱数など。
//
// file:// で直接開いても動くよう、ES モジュールではなく通常のスクリプトとして読み込み、
// 使うものは window.Common に置く。各作品は
//   const { TAU, rand, IS_TOUCH, fadeAndRun, setupControls } = Common;
// のように使うものだけ取り出し、「入力・UI」節で setupControls() を 1 回呼ぶ。
(() => {
  // ---- 設定 ----
  const FADE_MS = 850;              // 暗転の時間。common.css の #fade の transition より少し長く
  const IDLE_MS = 3000;             // カーソルと操作ガイドを隠すまでの時間
  const SWIPE_MIN_PX = 60;          // スワイプとみなす移動量（CSS ピクセル）
  const INTENSITY_SHOW_MS = 1500;   // 強度を変えたとき、ゲージを出しておく時間

  // スマホなどタッチ操作の端末か。解像度の倍率の上限などと、画面を消さない処理を切り替える
  const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

  // ---- 小さな関数 ----
  const TAU = 2 * Math.PI;
  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randIn = ([a, b]) => rand(a, b);
  const randInt = (n) => Math.floor(Math.random() * n);   // 0〜n-1 の整数
  const randSign = () => (Math.random() < 0.5 ? -1 : 1);
  const pick = (arr) => arr[randInt(arr.length)];
  // 平均 mean の指数分布。ランダムに起こる出来事の待ち時間に使う
  const randExp = (mean) => -Math.log(1 - Math.random()) * mean;
  // 指数分布で平均 mean 秒の間隔（min〜max に収める）
  const randomInterval = ([mean, min, max]) => clamp(randExp(mean), min, max);
  // canvas に渡す灰色（v: 0〜255、a: 不透明度）
  const gray = (v, a = 1) => `rgba(${v},${v},${v},${a})`;
  // 粒の器 sys（max・list・carry を持つ）に、1 秒に rate 個のペースで、dt 秒ぶんの粒を spawn() で作って加える。
  // 端数は次のフレームへ持ち越し、器がいっぱいなら作らない
  function emit(sys, rate, dt, spawn) {
    sys.carry += rate * dt;
    for (; sys.carry >= 1; sys.carry--) if (sys.list.length < sys.max) sys.list.push(spawn());
  }

  // ---- 暗転 ----
  let fadeEl = null;
  let fading = false;

  // 暗転している間に change() を実行して、明るく戻す
  function fadeAndRun(change) {
    if (fading) return;
    fading = true;
    fadeEl.style.opacity = 1;
    setTimeout(() => {
      change();
      fadeEl.style.opacity = 0;
      fading = false;
    }, FADE_MS);
  }

  // 暗転している最中か。暗転の間は動きを止めておきたい作品が使う
  const isFading = () => fading;

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }

  // ---- 操作が無ければカーソルと操作ガイドを隠す ----
  let idleTimer;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
  }

  // ---- 画面を消さない ----
  // スマホなどタッチ操作の端末では、眺めている間は画面を自動で消さない（Screen Wake Lock 対応ブラウザのみ）。
  // PC では OS のスリープやスクリーンセーバを妨げないよう何もしない。
  // タブが隠れると解除されるので、タブに戻ったときや画面に触れたときに取り直す
  let wakeLockRequest = null;   // 取得中・取得済みの間は Promise、解除されたら null
  function keepScreenOn() {
    if (!IS_TOUCH || wakeLockRequest || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    wakeLockRequest = navigator.wakeLock.request('screen').then(
      (lock) => lock.addEventListener('release', () => { wakeLockRequest = null; }),
      () => { wakeLockRequest = null; },   // 操作の前や省電力モードでは断られる。次に触れたときに取り直す
    );
  }

  // ---- 強度のゲージ ----
  // 倍率で変える値を、ゲージ上で等間隔に並べるための位置（0..1）
  function logPosition(value, min, max) {
    return Math.log(value / min) / Math.log(max / min);
  }

  let intensityEl = null;
  let intensityTimer;
  // 強度を変え、いまの値を右端のゲージで少しの間だけ見せる
  function adjustIntensity(intensity, dir) {
    (dir > 0 ? intensity.up : intensity.down)();
    intensityEl.querySelector('.fill').style.height = `${intensity.level() * 100}%`;
    intensityEl.classList.add('show');
    clearTimeout(intensityTimer);
    intensityTimer = setTimeout(() => intensityEl.classList.remove('show'), INTENSITY_SHOW_MS);
  }

  // ---- 操作の受け付け ----
  // changeScene: シーン切替（Space・左右スワイプ）。暗転して次の場面へ移る処理。場面が 1 つだけなら null
  // intensity:   強度（↑↓・上下スワイプ）。{ up, down, level }。level はゲージの位置（0..1）を返す
  // keys:        作品だけのキー操作。{ KeyJ: toggleJoint } のように KeyboardEvent.code で書く
  // onResize:    画面の大きさが変わったときの処理
  function setupControls({ changeScene = null, intensity, keys = {}, onResize }) {
    // 暗転は body の先頭に置き、操作ガイドとゲージは暗転の上に重ねる
    fadeEl = Object.assign(document.createElement('div'), { id: 'fade' });
    document.body.prepend(fadeEl);
    intensityEl = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'intensity' }));
    intensityEl.appendChild(Object.assign(document.createElement('div'), { className: 'fill' }));

    const keyActions = {
      Space: changeScene,
      KeyF: toggleFullscreen,
      ArrowUp: () => adjustIntensity(intensity, 1),
      ArrowDown: () => adjustIntensity(intensity, -1),
      ...keys,
    };
    addEventListener('keydown', (e) => {
      wake();
      // Cmd+F や Ctrl+R などのブラウザのショートカットは横取りしない
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyActions[e.code];
      if (!action) return;
      e.preventDefault();
      action();
    });

    // スマホでは、左右スワイプでシーン切替、上下スワイプで強度の調整（上へで強める）
    let swipeStart = null;   // 指を置いた位置。指が離れるまで覚えておく
    addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.isPrimary) swipeStart = { x: e.clientX, y: e.clientY };
    });
    addEventListener('pointerup', (e) => {
      if (!swipeStart || !e.isPrimary) return;
      const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
      swipeStart = null;
      // 十分に動き、一方の向きの動きがもう一方の 2 倍以上あるときだけスワイプとみなす
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < SWIPE_MIN_PX) return;
      if (ax >= 2 * ay) {
        wake();
        changeScene?.();
      } else if (ay >= 2 * ax) {
        wake();
        adjustIntensity(intensity, dy < 0 ? 1 : -1);
      }
    });
    addEventListener('pointercancel', () => { swipeStart = null; });

    addEventListener('dblclick', toggleFullscreen);
    addEventListener('mousemove', wake);
    document.addEventListener('visibilitychange', keepScreenOn);
    addEventListener('pointerdown', keepScreenOn);
    addEventListener('resize', onResize);

    wake();
    keepScreenOn();
  }

  window.Common = {
    TAU, clamp, rand, randIn, randInt, randSign, pick, randExp, randomInterval, gray, emit,
    IS_TOUCH, fadeAndRun, isFading, logPosition, setupControls,
  };
})();
