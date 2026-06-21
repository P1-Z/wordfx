'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataPathWithLegacy } = require('./storage');

const themePath = dataPathWithLegacy('theme.json', path.join(__dirname, 'theme.json'));
const themes = Object.freeze({
  macintosh: Object.freeze({
    label: 'Macintosh',
    description: 'Classic Macintosh system colors',
    skin: 'macintosh',
    effect: { name: 'pinwheel', filled: '\u2588', empty: ' ', spinner: ['|', '/', '-', '\\'], palette: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'] },
    colors: {
      cyan: [78, 145, 148], purple: [134, 105, 155], pink: [170, 100, 135],
      green: [92, 150, 110], red: [176, 92, 92], white: [239, 235, 216],
      yellow: [190, 170, 95], blue: [90, 116, 165], orange: [190, 135, 80],
      muted: [143, 137, 126], selection: [70, 88, 126],
    },
  }),
  rainbow: Object.freeze({
    label: 'Rainbow',
    description: 'Original full-spectrum colors',
    effect: { name: 'rainbow', filled: '\u2501', empty: '\u2500', spinner: ['/', '-', '\\', '|'], palette: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'] },
    colors: {
      cyan: [112, 184, 178], purple: [145, 132, 184], pink: [190, 126, 154],
      green: [126, 174, 142], red: [199, 111, 116], white: [218, 222, 229],
      yellow: [196, 171, 112], blue: [111, 151, 190], orange: [193, 145, 105],
      muted: [142, 151, 166], selection: [56, 62, 82],
    },
  }),
  midnight: Object.freeze({
    label: 'Midnight',
    description: 'Low-glare cool tones',
    effect: { name: 'drift', filled: '\u2501', empty: '\u2500', spinner: ['/', '-', '\\', '|'], palette: ['cyan', 'blue', 'purple', 'pink'] },
    colors: {
      cyan: [86, 157, 171], purple: [105, 91, 151], pink: [153, 91, 132],
      green: [83, 139, 126], red: [165, 82, 98], white: [194, 205, 222],
      yellow: [168, 148, 97], blue: [72, 105, 158], orange: [168, 105, 82],
      muted: [91, 105, 128], selection: [35, 43, 67],
    },
  }),
  neon: Object.freeze({
    label: 'Neon',
    description: 'Electric cyan and magenta',
    effect: { name: 'pulse', filled: '\u2588', empty: '\u2591', spinner: ['\u25c6', '\u25c7'], palette: ['cyan', 'blue', 'purple', 'pink'] },
    colors: {
      cyan: [35, 245, 235], purple: [165, 75, 255], pink: [255, 55, 195],
      green: [55, 245, 205], red: [255, 55, 135], white: [238, 245, 255],
      yellow: [205, 175, 255], blue: [55, 125, 255], orange: [255, 75, 185],
      muted: [135, 155, 185], selection: [54, 45, 88],
    },
  }),
  ocean: Object.freeze({
    label: 'Ocean',
    description: 'Deep blue and seafoam',
    effect: { name: 'wave', filled: '\u2248', empty: '~', spinner: ['~', '\u2248', '\u223f', '\u2248'], palette: ['blue', 'cyan', 'green', 'cyan'] },
    colors: {
      cyan: [74, 205, 210], purple: [126, 142, 210], pink: [185, 125, 180],
      green: [90, 205, 165], red: [220, 105, 115], white: [220, 238, 242],
      yellow: [220, 195, 110], blue: [70, 135, 220], orange: [220, 145, 90],
      muted: [115, 155, 175], selection: [34, 67, 91],
    },
  }),
  ember: Object.freeze({
    label: 'Ember',
    description: 'Warm firelight palette',
    effect: { name: 'flicker', filled: '\u2593', empty: '\u2591', spinner: ['*', '+', '\u00b7', '+'], palette: ['red', 'orange', 'yellow', 'orange'] },
    colors: {
      cyan: [105, 190, 185], purple: [180, 120, 165], pink: [225, 105, 135],
      green: [145, 190, 105], red: [235, 82, 68], white: [242, 225, 205],
      yellow: [245, 195, 75], blue: [105, 145, 190], orange: [245, 125, 50],
      muted: [170, 140, 125], selection: [85, 48, 38],
    },
  }),
  aurora: Object.freeze({
    label: 'Aurora',
    description: 'Soft polar light and drifting stars',
    effect: { name: 'comet', filled: '\u2726', empty: '\u00b7', spinner: ['\u00b7', '\u2727', '\u2726', '\u2736'], palette: ['green', 'cyan', 'blue', 'purple', 'pink'] },
    colors: {
      cyan: [92, 211, 196], purple: [153, 118, 214], pink: [207, 120, 188],
      green: [102, 207, 148], red: [218, 105, 128], white: [225, 239, 238],
      yellow: [205, 207, 127], blue: [93, 145, 218], orange: [219, 144, 104],
      muted: [108, 137, 151], selection: [42, 72, 89],
    },
  }),
  phosphor: Object.freeze({
    label: 'Phosphor',
    description: 'Green CRT glow and radar sweep',
    effect: { name: 'sweep', filled: '\u2588', empty: '\u00b7', spinner: ['<', '^', '>', 'v'], palette: ['green', 'white', 'green'] },
    colors: {
      cyan: [82, 197, 126], purple: [105, 163, 116], pink: [133, 179, 112],
      green: [78, 224, 112], red: [201, 106, 84], white: [191, 245, 196],
      yellow: [178, 208, 93], blue: [72, 151, 112], orange: [198, 151, 78],
      muted: [73, 119, 82], selection: [27, 75, 41],
    },
  }),
  paper: Object.freeze({
    label: 'Paper',
    description: 'Warm ink, stationery, and typewriter ticks',
    effect: { name: 'typewriter', filled: '=', empty: '.', spinner: ['.', ':', '!', ':'], palette: ['red', 'orange', 'blue', 'purple'] },
    colors: {
      cyan: [78, 137, 140], purple: [116, 92, 125], pink: [151, 92, 107],
      green: [91, 132, 86], red: [158, 76, 69], white: [228, 215, 184],
      yellow: [177, 145, 69], blue: [72, 105, 139], orange: [172, 105, 64],
      muted: [130, 116, 94], selection: [75, 65, 55],
    },
  }),
  mono: Object.freeze({
    label: 'Mono',
    description: 'Clean grayscale',
    effect: { name: 'scanner', filled: '\u25a0', empty: '\u00b7', spinner: ['\u25a0', '\u25a1'], palette: ['muted', 'white', 'muted'] },
    colors: {
      cyan: [205, 210, 218], purple: [165, 170, 180], pink: [195, 198, 205],
      green: [215, 220, 225], red: [175, 180, 188], white: [235, 238, 242],
      yellow: [200, 205, 212], blue: [155, 165, 178], orange: [190, 195, 202],
      muted: [125, 132, 145], selection: [58, 62, 70],
    },
  }),
});

const rgb = {};
const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};
let activeTheme = 'rainbow';

function readThemeName() {
  try {
    const saved = JSON.parse(fs.readFileSync(themePath, 'utf8'));
    return typeof saved.theme === 'string' && themes[saved.theme] ? saved.theme : 'rainbow';
  } catch {
    return 'rainbow';
  }
}

function applyTheme(name) {
  const selected = themes[name] ? name : 'rainbow';
  activeTheme = selected;
  for (const [color, value] of Object.entries(themes[selected].colors)) {
    rgb[color] = [...value];
    ansi[color] = `\x1b[38;2;${value.join(';')}m`;
  }
  return selected;
}

function reloadTheme() {
  return applyTheme(readThemeName());
}

function setTheme(name) {
  if (!themes[name]) throw new Error(`Unknown theme: ${name}`);
  const temporaryPath = `${themePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ theme: name }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, themePath);
  return applyTheme(name);
}

function getTheme() {
  return activeTheme;
}

function getSkin() {
  return themes[activeTheme].skin || 'standard';
}

function themePalette() {
  const theme = themes[activeTheme];
  return theme.effect.palette.map(name => rgb[name]);
}

function effectRgb(theme, effect, index, frame, width) {
  const palette = effect.palette.map(name => theme.colors[name]);
  const motion = effect.name === 'wave'
    ? Math.sin(index * 0.65 - frame * 0.3) * 0.8
    : effect.name === 'flicker'
      ? Math.sin(index * 8.31 + frame * 2.17) * 0.7
      : effect.name === 'scanner'
        ? -Math.abs(index - ((frame * 0.7) % Math.max(1, width))) * 0.18
        : frame * 0.08;
  const place = ((index * 0.24 + motion) % palette.length + palette.length) % palette.length;
  const from = Math.floor(place);
  const to = (from + 1) % palette.length;
  const amount = place - from;
  const color = palette[from].map((channel, channelIndex) =>
    Math.round(channel + (palette[to][channelIndex] - channel) * amount)
  );
  if (effect.name === 'pulse') {
    const strength = 0.78 + (Math.sin(frame * 0.45 + index * 0.22) + 1) * 0.16;
    return color.map(channel => Math.min(255, Math.round(channel * strength)));
  }
  return color;
}

function renderThemeBar(progress, width, frame = 0, themeName = activeTheme) {
  const theme = themes[themeName] || themes[activeTheme];
  const effect = theme.effect;
  const safeProgress = Math.max(0, Math.min(1, progress));
  const filled = Math.round(safeProgress * width);
  const tone = name => `\x1b[38;2;${theme.colors[name].join(';')}m`;
  if (effect.name === 'pinwheel') {
    const spinner = effect.spinner[Math.floor(frame) % effect.spinner.length];
    const label = progress >= 1 ? '[ OK ]' : `[ ${spinner} ]`;
    const tone = effect.palette[Math.floor(frame / 2) % effect.palette.length];
    return `${ansi[tone]}${label.padEnd(Math.max(label.length, width))}${ansi.reset}`;
  }
  if (effect.name === 'comet') {
    let output = '';
    for (let index = 0; index < width; index++) {
      if (index >= filled) output += `${ansi.dim}${tone('muted')}\u00b7`;
      else {
        const paletteName = effect.palette[(index + Math.floor(frame / 3)) % effect.palette.length];
        const sparkle = (index * 7 + Math.floor(frame)) % 11 === 0 ? '\u2736' : index === filled - 1 ? '\u2726' : '\u00b7';
        output += `${tone(paletteName)}${sparkle}`;
      }
    }
    return `${output}${ansi.reset}`;
  }
  if (effect.name === 'sweep') {
    const scan = filled > 0 ? Math.floor(frame * 0.7) % filled : 0;
    let output = '';
    for (let index = 0; index < width; index++) {
      if (index === scan && index < filled) output += `${ansi.bold}${tone('white')}>`;
      else if (index < filled) output += `${tone('green')}=`;
      else output += `${ansi.dim}${tone('muted')}.`;
    }
    return `${output}${ansi.reset}`;
  }
  if (effect.name === 'typewriter') {
    let output = '';
    for (let index = 0; index < width; index++) {
      if (index < filled) output += `${tone(effect.palette[index % effect.palette.length])}=`;
      else if (index === filled && safeProgress < 1) output += `${tone('white')}${Math.floor(frame / 2) % 2 ? '|' : ':'}`;
      else output += `${ansi.dim}${tone('muted')}.`;
    }
    return `${output}${ansi.reset}`;
  }
  let output = '';
  for (let index = 0; index < width; index++) {
    if (index >= filled) {
      output += `${ansi.dim}${ansi.muted}${effect.empty}`;
      continue;
    }
    const [red, green, blue] = effectRgb(theme, effect, index, frame, width);
    const glyph = effect.name === 'wave' && (index + frame) % 3 === 0 ? '~' : effect.filled;
    output += `\x1b[38;2;${red};${green};${blue}m${glyph}`;
  }
  return output + ansi.reset;
}

function renderThemeRail(width, frame = 0) {
  const palette = themePalette();
  let output = '';
  for (let index = 0; index < width; index++) {
    const place = ((index / Math.max(1, width) * palette.length - frame * 0.06) % palette.length + palette.length) % palette.length;
    const from = Math.floor(place);
    const to = (from + 1) % palette.length;
    const amount = place - from;
    const smooth = amount * amount * (3 - 2 * amount);
    const shade = palette[from].map((channel, channelIndex) =>
      Math.round(channel + (palette[to][channelIndex] - channel) * smooth)
    );
    output += `\x1b[38;2;${shade.join(';')}m\u2501`;
  }
  return `${output}${ansi.reset}`;
}

function themeSpinner(frame = 0) {
  const spinner = themes[activeTheme].effect.spinner;
  return spinner[Math.floor(frame) % spinner.length];
}

reloadTheme();

module.exports = { rgb, ansi, themes, getTheme, getSkin, setTheme, reloadTheme, themePalette, renderThemeBar, renderThemeRail, themeSpinner };
