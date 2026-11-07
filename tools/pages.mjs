// 作品の一覧と、場面の選び方。video-export.mjs・video-compare.mjs・gpu-bench.mjs で使う。
// 作品を足したときは、ここだけを直す。

// 作品名（index.html の並びの順）
export const PAGES = ['pipes', 'tube', 'drone', 'ripple', 'campfire', 'jellyfish', 'aurora', 'waterfall', 'lavalamp', 'penguins', 'diamond', 'sandpicture'];

// 作品ごとの場面の選び方。ここに無い作品は場面を選べない。
// - option: 番号を渡す引数。シーンの定義（SCENES）がある作品は 'scenes'、配色の定義（COLOR_PRESETS）がある作品は 'presets'
// - list: 一覧の変数（項目の name を名前に使う。無ければ番号）
// - select: 番号で選ぶ式（i が番号。作品のスクリプトの中で評価する）
export const CHOICES = {
  drone: { option: 'scenes', list: 'SCENES', select: 'setScene(i)' },
  ripple: { option: 'scenes', list: 'SCENES', select: 'setScene(i)' },
  waterfall: { option: 'scenes', list: 'SCENES', select: 'setScene(i)' },
  penguins: { option: 'scenes', list: 'SCENES', select: 'setScene(i)' },
  tube: { option: 'presets', list: 'COLOR_PRESETS', select: 'setColorPreset(i)' },
  aurora: { option: 'presets', list: 'COLOR_PRESETS', select: 'setColorPreset(i)' },
  lavalamp: { option: 'presets', list: 'COLOR_PRESETS', select: 'setColorPreset(i)' },
  sandpicture: { option: 'presets', list: 'COLOR_PRESETS', select: 'startPicture(i)' },   // 配色を替えて、新しい絵から始める
};

// option で場面を選べる作品の名前を「・」でつなぐ（使い方やエラーの表示用）
export const pagesWith = (option) => PAGES.filter((page) => CHOICES[page]?.option === option).join('・');

// 作品のスクリプトの中で評価する式: [番号で選ぶ関数, 名前の一覧]。場面を選べない作品は null
export function choiceExpressions(page) {
  const def = CHOICES[page];
  if (!def) return { select: 'null', names: 'null' };
  return {
    select: `(i) => { ${def.select}; }`,
    names: `${def.list}.map((s, i) => s.name ?? '#' + i)`,
  };
}
