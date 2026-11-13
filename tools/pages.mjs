// 作品の一覧と、場面の選び方・隠し要素の呼び出し方。video-export.mjs・video-compare.mjs・gpu-bench.mjs で使う。
// 作品を足したときは、ここだけを直す。

// 作品名（index.html の並びの順）
export const PAGES = ['pipes', 'tube', 'drone', 'ripple', 'campfire', 'jellyfish', 'aurora', 'waterfall', 'lavalamp', 'penguins', 'diamond', 'sandpicture', 'infcastle', 'teapot'];

// 作品ごとの場面の選び方。シーン（scenes）と配色（presets）は別々に選べ、両方を持つ作品は同時に指定できる。
// ここに無い作品・無い種類は選べない。
// - scenes: シーンの定義（SCENES）。presets: 配色の定義（COLOR_PRESETS）
// - list: 一覧の変数（項目の name を名前に使う。無ければ番号）
// - select: 番号で選ぶ式（i が番号。作品のスクリプトの中で評価する）。両方を指定したときは、シーンを選んでから配色を選ぶ
const SCENES = { list: 'SCENES', select: 'setScene(i)' };
const PRESETS = { list: 'COLOR_PRESETS', select: 'setColorPreset(i)' };
export const CHOICES = {
  drone: { scenes: SCENES },
  ripple: { scenes: SCENES },
  waterfall: { scenes: SCENES },
  penguins: { scenes: SCENES },
  teapot: { scenes: SCENES, presets: PRESETS },   // 配色はポットの色。Wireframe に戻ると作品が選び直す
  tube: { presets: PRESETS },
  aurora: { presets: PRESETS },
  lavalamp: { presets: PRESETS },
  sandpicture: { presets: { ...PRESETS, select: 'startPicture(i)' } },   // 配色を替えて、新しい絵から始める
};

// 隠し要素を持つ作品の、呼び出す関数名。作品のトップレベルの function で、隠しキー（C）と、待ち時間が切れたときの自然な出現の
// 両方がこの関数を呼ぶ。video-export.mjs の --hidden は、これを差し替えて出現を止め、呼び出す時刻を決める
export const HIDDEN = {
  tube: 'startHatch',
  aurora: 'startSanta',
  ripple: 'startEvent',
  penguins: 'startChick',
  diamond: 'startSpider',
  sandpicture: 'startCamel',
  campfire: 'startSquirrel',
  waterfall: 'startCarp',
  infcastle: 'startHiddenRoom',
};

// kind（'scenes'・'presets'）を選べる作品の名前を「・」でつなぐ（使い方やエラーの表示用）
export const pagesWith = (kind) => PAGES.filter((page) => CHOICES[page]?.[kind]).join('・');

// 作品のスクリプトの中で評価する式: { scenes, presets } のそれぞれが { select: 番号で選ぶ関数, names: 名前の一覧 }。選べない種類は null
export function choiceExpressions(page) {
  const expr = (def) => (def ? `{ select: (i) => { ${def.select}; }, names: ${def.list}.map((s, i) => s.name ?? '#' + i) }` : 'null');
  return `{ scenes: ${expr(CHOICES[page]?.scenes)}, presets: ${expr(CHOICES[page]?.presets)} }`;
}
