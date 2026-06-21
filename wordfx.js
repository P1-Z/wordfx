#!/usr/bin/env node

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { ansi: colors, rgb: themeRgb, getTheme, getSkin, setTheme, reloadTheme, themePalette, renderThemeBar, renderThemeRail, themeSpinner } = require('./theme');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(':// needs to run in an interactive terminal.');
  process.exit(1);
}

const ESC = '\x1b[';
const FRAME_INTERVAL = 16; // 60 FPS for smoother animations
const cells = [];
let lastFrameTime = Date.now(); // For delta time calculations
let cursor = 0;
let anchor = null;
let activeEffect = 'none';
let clearAnimation = null;
let mainScreenActive = false;
let forbiddenEntryUntil = 0;
let commandProcessActive = false;
let frame = 0;
let showHelp = true;
let status = 'Type anywhere. Hold Shift + arrows to mark text.';
let statusUntil = Date.now() + 5000;
let timer = null;

const effects = {
  rainbow: { label: 'rainbow' },
  matrix: { label: 'matrix rain' },
  pulse: { label: 'pulse' },
  sparkle: { label: 'sparkle' },
  bold: { label: 'bold' },
  underline: { label: 'underline' },
  none: { label: 'plain' },
};

function size() {
  return {
    width: Math.max(1, process.stdout.columns || 80),
    height: Math.max(3, process.stdout.rows || 24),
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function playStartupAnimation() {
  const frames = 30;
  const startupProfiles = {
    rainbow: [':// SPECTRUM', 'OPENING WORKSPACE', ['MIXING COLORS', 'TUNING EFFECTS', 'LINKING COMMANDS', 'OPENING CANVAS']],
    midnight: [':// AFTER DARK', 'WAKING QUIETLY', ['DIMMING LIGHTS', 'MAPPING NIGHT SKY', 'OPENING CHANNEL', 'READYING DESK']],
    neon: [':// VOLT', 'CHARGING INTERFACE', ['PRIMING TUBES', 'RAISING CURRENT', 'SYNCING GRID', 'IGNITING DISPLAY']],
    ocean: [':// TIDE', 'RAISING THE SIGNAL', ['CHARTING DEPTH', 'TUNING CURRENT', 'OPENING HARBOR', 'SURFACING CANVAS']],
    ember: [':// KINDLE', 'LIGHTING THE SYSTEM', ['CATCHING SPARK', 'FEEDING COLOR', 'WARMING COMMANDS', 'OPENING HEARTH']],
    aurora: [':// AURORA', 'FOLLOWING THE LIGHT', ['FINDING NORTH', 'BENDING COLOR', 'READING SKY', 'OPENING HORIZON']],
    phosphor: [':// CRT 01', 'SCANNING SYSTEM', ['HEATING CATHODE', 'LOCKING SIGNAL', 'SWEEPING FIELD', 'OPENING TERMINAL']],
    paper: [':// PAPER', 'SETTING THE DESK', ['ROLLING SHEET', 'INKING RIBBON', 'ALIGNING MARGIN', 'READY TO TYPE']],
    mono: [':// MONO', 'STARTING CLEANLY', ['CHECKING BUFFER', 'LOADING GLYPHS', 'BINDING INPUT', 'READY']],
  };
  const startupProfile = startupProfiles[getTheme()] || startupProfiles.rainbow;
  const steps = startupProfile[2];
  const stripAnsi = value => String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const gradientText = (text, offset) => Array.from(text, (character, index) => {
    const stops = [
      themeRgb.red, themeRgb.orange, themeRgb.yellow, themeRgb.green,
      themeRgb.cyan, themeRgb.blue, themeRgb.purple, themeRgb.pink,
    ];
    const place = ((index * 0.34 + offset * 0.08) / 1.8) % stops.length;
    const from = Math.floor(place);
    const to = (from + 1) % stops.length;
    const amount = place - from;
    const blend = amount * amount * (3 - 2 * amount);
    const [red, green, blue] = stops[from].map((channel, channelIndex) =>
      Math.round(channel + (stops[to][channelIndex] - channel) * blend)
    );
    return `\x1b[1;38;2;${red};${green};${blue}m${character}`;
  }).join('') + colors.reset;
  const centered = (row, content, width) =>
    `${ESC}${row};${Math.max(1, Math.floor((width - stripAnsi(content).length) / 2) + 1)}H${content}`;

  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H\x1b[?25l');
  for (let index = 0; index <= frames; index++) {
    const { width, height } = size();
    const progress = index / frames;
    const eased = 1 - Math.pow(1 - progress, 3);
    const middle = Math.max(2, Math.floor(height / 2));
    const barWidth = Math.max(1, Math.min(44, width - 12));
    let output = '\x1b[2J\x1b[H';
    if (getSkin() === 'macintosh') {
      output += centered(middle - 2, `${colors.dim}:// STARTING${colors.reset}`, width);
      output += centered(middle, `${colors.purple}${colors.bold}${themeSpinner(index)}${colors.reset}`, width);
      output += centered(middle + 2, `${colors.white}${String(Math.round(progress * 100)).padStart(3)}%${colors.reset}`, width);
    } else {
      output += centered(middle - 3, gradientText(startupProfile[0], index), width);
      output += centered(middle - 1, `${colors.bold}${progress < 1 ? colors.cyan : colors.green}${progress < 1 ? startupProfile[1] : 'SYSTEM READY'}${colors.reset}`, width);
      output += centered(middle + 1, `${renderThemeBar(eased, barWidth, index)} ${colors.white}${String(Math.round(progress * 100)).padStart(3)}%${colors.reset}`, width);
    }
    if (getSkin() !== 'macintosh') {
      const stepProgress = progress * steps.length;
      steps.forEach((step, stepIndex) => {
        const complete = progress === 1 || stepIndex < Math.floor(stepProgress);
        const active = !complete && stepIndex === Math.floor(stepProgress);
        const marker = complete ? '[OK]' : active ? `[${themeSpinner(index)}]` : '[ ]';
        const color = complete ? colors.green : active ? colors.cyan : colors.dim;
        output += centered(middle + 3 + stepIndex, `${color}${marker}${colors.reset} ${active || complete ? colors.white : colors.muted}${step}${colors.reset}`, width);
      });
    }
    process.stdout.write(output);
    await wait(30);
  }
  await wait(180);
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
}

function selectedRange() {
  if (anchor === null || anchor === cursor) return null;
  return [Math.min(anchor, cursor), Math.max(anchor, cursor)];
}

function selectionContains(index) {
  const range = selectedRange();
  return range && index >= range[0] && index < range[1];
}

function escapeText(ch) {
  return ch === '\x1b' ? '' : ch;
}

function rainbowColor(position) {
  const stops = themePalette();
  // More characters show the full spectrum for a smoother transition
  const transitionLength = 1.8;
  const place = ((position / transitionLength) % stops.length + stops.length) % stops.length;
  const from = Math.floor(place);
  const to = (from + 1) % stops.length;
  // Smoothstep with cubic easing for more dynamic transitions
  const amount = place - from;
  const blend = amount * amount * (3 - 2 * amount);
  return stops[from].map((channel, i) =>
    Math.round(channel + (stops[to][i] - channel) * blend)
  );
}

function styleFor(cell, index) {
  const codes = [];
  switch (cell.effect) {
    case 'rainbow': {
      // A compact full rainbow drifts smoothly by a fraction each frame.
      const [red, green, blue] = rainbowColor(index + frame * 0.62);
      codes.push(`1;38;2;${red};${green};${blue}`);
      break;
    }
    case 'matrix': {
      const flicker = Math.sin(frame * 0.22 + index * 0.18) * 14;
      const [red, green, blue] = themeRgb.green.map(channel => Math.max(0, Math.round(channel + flicker)));
      codes.push(`38;2;${red};${green};${blue}`);
      break;
    }
    case 'pulse': {
      const strength = 0.72 + (Math.sin(frame * 0.3 + index * 0.2) + 1) * 0.22;
      const [red, green, blue] = rainbowColor(index * 0.8 + frame * 0.25)
        .map(channel => Math.min(255, Math.round(channel * strength)));
      codes.push(`1;38;2;${red};${green};${blue}`);
      break;
    }
    case 'love': {
      const glow = (Math.sin(frame * 0.28 + index * 0.38) + 1) / 2;
      const red = 235 + Math.round(glow * 20);
      const green = 70 + Math.round(glow * 85);
      const blue = 145 + Math.round(glow * 65);
      codes.push(`1;38;2;${red};${green};${blue}`);
      break;
    }
    case 'sparkle': {
      const sparklePhase = (index * 17 + frame * 7) % 19;
      const lit = sparklePhase < 3;
      
      if (lit) {
        const [red, green, blue] = rainbowColor(index * 1.4 + frame * 0.45)
          .map(channel => Math.min(255, Math.round(channel * 1.22)));
        codes.push(`1;38;2;${red};${green};${blue}`);
      } else {
        codes.push(`38;2;${themeRgb.muted.join(';')}`);
      }
      break;
    }
    case 'bold': codes.push('1'); break;
    case 'underline': codes.push('4'); break;
  }
  if (cell.censored) {
    const pulse = 0.72 + ((index * 19 + frame * 13) % 80) / 200;
    const [red, green, blue] = themeRgb.red.map(channel => Math.min(255, Math.round(channel * pulse)));
    codes.push(`1;38;2;${red};${green};${blue}`);
  }
  
  // Add vibrating color effect for capital letters
  if (cell.ch >= 'A' && cell.ch <= 'Z' && !cell.censored && cell.effect !== 'love') {
    const vibrationSpeed = 0.5;
    const colorShift = Math.sin(frame * vibrationSpeed + index * 0.7);
    
    // Shift between normal color and a bright vibrating color
    if (Math.abs(colorShift) > 0.3) {
      const intensity = Math.abs(colorShift);
      const [red, green, blue] = themeRgb.white.map(channel =>
        Math.min(255, Math.round(channel * (0.85 + intensity * 0.3)))
      );
      codes.push(`1;38;2;${red};${green};${blue}`); // Bright white vibration
    }
  }
  
  if (selectionContains(index)) {
    const [red, green, blue] = themeRgb.white;
    codes.push(`48;2;${themeRgb.selection.join(';')};38;2;${red};${green};${blue}`);
  }
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

function displayedCharacter(cell, index) {
  if (cell.censored) {
    const censorGlyphs = ['█', '▓', '█', '▒', '▓'];
    return censorGlyphs[(Math.floor(frame * 1.8) + index * 3) % censorGlyphs.length];
  }
  
  let char = escapeText(cell.ch);
  
  // Make capital letters vibrate with more intensity
  if (char >= 'A' && char <= 'Z' && cell.effect !== 'love') {
    const vibrationSpeed = 0.5; // Faster vibration
    const vibrationAmount = Math.sin(frame * vibrationSpeed + index * 0.7);
    const jitter = Math.sin(frame * 1.2 + index * 1.3);
    
    // More frequent character swapping for stronger vibration effect
    if (Math.abs(vibrationAmount) > 0.5 || Math.abs(jitter) > 0.8) {
      const alternates = {
        'A': ['Λ', 'А', '∆', 'Α', 'Ᾰ', 'A'],
        'B': ['β', 'В', 'Б', 'Β', 'ℬ', 'B'],
        'C': ['Ϲ', 'С', '⊂', 'Ⅽ', 'ℂ', 'C'],
        'D': ['Ð', 'Ď', 'Đ', 'Ⅾ', 'ⅅ', 'D'],
        'E': ['Ξ', 'Є', 'Ε', 'ℰ', 'Ē', 'E'],
        'F': ['Ғ', 'Ϝ', 'ℱ', 'Ḟ', 'F', 'F'],
        'G': ['Ġ', 'Ǧ', 'Ĝ', 'Ԍ', 'Ḡ', 'G'],
        'H': ['Η', 'Н', 'Ħ', 'ℋ', 'Ḣ', 'H'],
        'I': ['Ι', 'І', 'Ї', 'ℐ', 'Ḭ', 'I'],
        'J': ['Ј', 'Ĵ', 'ℐ', 'Ʝ', 'J', 'J'],
        'K': ['Κ', 'К', 'Ќ', 'ℜ', 'Ḱ', 'K'],
        'L': ['Ł', 'Ľ', 'Ŀ', 'ℒ', 'Ḷ', 'L'],
        'M': ['М', 'Μ', 'Ṁ', 'ℳ', 'Ṃ', 'M'],
        'N': ['Ν', 'Ň', 'Ñ', 'ℕ', 'Ṅ', 'N'],
        'O': ['０', 'Ο', 'Ø', 'ℴ', 'Ṏ', 'O'],
        'P': ['Ρ', 'Р', 'Ƥ', 'ℙ', 'Ṕ', 'P'],
        'Q': ['Ǫ', 'ℚ', 'Ϙ', 'Ⴍ', 'Q', 'Q'],
        'R': ['Я', 'Ř', 'Ŕ', 'ℛ', 'Ṛ', 'R'],
        'S': ['Ѕ', 'Ş', 'Š', 'Ṡ', '$', 'S'],
        'T': ['Т', 'Ŧ', 'Ṫ', 'Ⱦ', '⊤', 'T'],
        'U': ['Ц', 'Ū', 'Ǔ', 'Ṳ', 'Ṷ', 'U'],
        'V': ['Ѵ', 'Ṿ', 'Ʋ', '∨', 'Ṽ', 'V'],
        'W': ['Ш', 'Ẅ', 'Ŵ', 'Ẇ', 'Ẉ', 'W'],
        'X': ['Χ', 'Х', '✕', 'Ⅹ', '×', 'X'],
        'Y': ['Ү', 'Ỳ', 'Ÿ', 'Ƴ', 'Ỷ', 'Y'],
        'Z': ['Ζ', 'Ž', 'Ż', 'ℤ', 'Ẑ', 'Z']
      };
      
      if (alternates[char]) {
        const alts = alternates[char];
        // Combine both vibration sources for more chaotic movement
        const combinedVibration = vibrationAmount + jitter * 0.5;
        const altIndex = Math.floor(Math.abs(combinedVibration * 10)) % alts.length;
        char = alts[altIndex];
      }
    }
  }
  
  return char;
}

function logicalPosition(at, width) {
  let row = 0;
  let col = 0;
  for (let i = 0; i < at; i++) {
    if (cells[i].ch === '\n') {
      row++;
      col = 0;
    } else {
      col++;
      if (col >= width) {
        row++;
        col = 0;
      }
    }
  }
  return { row, col };
}

function indexAt(row, col, width) {
  let r = 0;
  let c = 0;
  for (let i = 0; i <= cells.length; i++) {
    if (r === row && c >= col) return i;
    if (i === cells.length) return i;
    if (cells[i].ch === '\n') {
      if (r === row) return i;
      r++;
      c = 0;
    } else {
      c++;
      if (c >= width) {
        r++;
        c = 0;
      }
    }
  }
  return cells.length;
}

function seededRandom(value) {
  const result = Math.sin(value * 12.9898) * 43758.5453;
  return result - Math.floor(result);
}

function forbiddenBannerLines() {
  const font = {
    F: ['11111', '10000', '11110', '10000', '10000'],
    O: ['01110', '10001', '10001', '10001', '01110'],
    R: ['11110', '10001', '11110', '10100', '10010'],
    B: ['11110', '10001', '11110', '10001', '11110'],
    I: ['11111', '00100', '00100', '00100', '11111'],
    D: ['11110', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '11110', '10000', '11111'],
    N: ['10001', '11001', '10101', '10011', '10001'],
    T: ['11111', '00100', '00100', '00100', '00100'],
    Y: ['10001', '01010', '00100', '00100', '00100'],
  };
  const lines = [];
  for (const word of ['FORBIDDEN', 'ENTRY']) {
    for (let row = 0; row < 5; row++) {
      lines.push(Array.from(word, letter =>
        font[letter][row].replaceAll('1', '█').replaceAll('0', ' ')
      ).join(' '));
    }
    if (word === 'FORBIDDEN') lines.push('');
  }
  return lines;
}

function startClearAnimation() {
  if (cells.length === 0) return;
  playSound('note_dissolve');
  const width = size().width;
  const items = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].ch === '\n') continue;
    const position = logicalPosition(i, width);
    items.push({
      row: position.row,
      col: position.col,
      order: seededRandom(i + 203),
      love: cells[i].effect === 'love',
    });
  }
  const disappearanceOrder = [...items].sort((a, b) => a.order - b.order);
  for (let i = 0; i < disappearanceOrder.length; i++) {
    disappearanceOrder[i].vanishAt = 0.22 + (i / Math.max(1, items.length - 1)) * 0.7;
  }
  clearAnimation = { startedAt: Date.now(), items };
  anchor = null;
}

function renderDissolveFooter(width, height, progress) {
  if (!showHelp || height < 2) return '';
  let divider = '';
  for (let column = 0; column < width; column++) {
    // Keep this identical to the main canvas rainbow-divider motion.
    const wave = Math.sin(column * 0.1 + frame * 0.2) * 0.5 + 0.5;
    const hue = (column * 2 + frame * 3) % 360;
    const saturation = 80 + wave * 20;
    const lightness = 60 + wave * 30;
    const chroma = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
    const intermediate = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const match = lightness / 100 - chroma / 2;
    let red = 0;
    let green = 0;
    let blue = 0;
    if (hue < 60) [red, green] = [chroma, intermediate];
    else if (hue < 120) [red, green] = [intermediate, chroma];
    else if (hue < 180) [green, blue] = [chroma, intermediate];
    else if (hue < 240) [green, blue] = [intermediate, chroma];
    else if (hue < 300) [red, blue] = [intermediate, chroma];
    else [red, blue] = [chroma, intermediate];
    const rgb = [red, green, blue].map(channel => Math.round((channel + match) * 255));
    divider += `\x1b[38;2;${rgb.join(';')}m━`;
  }
  divider = renderThemeRail(width, frame / 4.8);
  const badge = ' :// ';
  const percent = Math.min(100, Math.round(progress * 100));
  const hint = `DISSOLVING ${String(percent).padStart(3)}%  Effects remain active  Ctrl+Q quit`;
  const available = Math.max(0, width - badge.length - 1);
  const visibleHint = hint.slice(0, available).padEnd(available);
  return `${ESC}${height - 1};1H${divider}\x1b[0m` +
    `${ESC}${height};1H${colors.bold}${colors.pink}${badge}${colors.reset} ` +
    `${colors.dim}${colors.muted}${visibleHint}${colors.reset}${ESC}K`;
}

function renderClearAnimation(width, height) {
  if (!clearAnimation) return false;
  const progress = (Date.now() - clearAnimation.startedAt) / 720;
  if (progress >= 1) {
    cells.splice(0, cells.length);
    cursor = 0;
    clearAnimation = null;
    status = 'Canvas cleared.';
    statusUntil = Date.now() + 1200;
    return false;
  }

  let out = '\x1b[?25l\x1b[2J\x1b[H';
  const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+-<>[]{}';
  const loveGlyphs = Array.from('♥♡✦✧·');
  const tick = Math.floor(frame * 4.5);
  const streamColors = [
    themeRgb.red,
    themeRgb.yellow,
    themeRgb.green,
    themeRgb.blue,
    themeRgb.purple,
  ];
  for (let i = 0; i < clearAnimation.items.length; i++) {
    const item = clearAnimation.items[i];
    if (progress >= item.vanishAt) continue;
    // Three rapidly changing glyphs create a compact vertical scrolling stream.
    for (let trail = 2; trail >= 0; trail--) {
      const row = item.row + 1 - trail;
      const col = item.col + 1;
      if (row < 1 || row > height || col < 1 || col > width) continue;
      const glyphIndex = (tick + i * 13 - trail * 7) % glyphs.length;
      const glyph = item.love
        ? loveGlyphs[(tick + i * 3 + trail) % loveGlyphs.length]
        : glyphs[(glyphIndex + glyphs.length) % glyphs.length];
      const [red, green, blue] = item.love
        ? [[255, 185, 220], [255, 105, 180], [220, 65, 145]][trail]
        : streamColors[(i + Math.floor(tick * 0.5)) % streamColors.length];
      out += `${ESC}${row};${col}H\x1b[${trail === 0 ? '1;' : '2;'}38;2;${red};${green};${blue}m${glyph}\x1b[0m`;
    }
  }
  out += renderDissolveFooter(width, height, progress);
  process.stdout.write(out);
  return true;
}

function render() {
  if (commandProcessActive) return;
  const { width, height } = size();
  if (renderClearAnimation(width, height)) return;
  const footerRows = showHelp ? 2 : 0;
  const canvasHeight = Math.max(1, height - footerRows);
  const caret = logicalPosition(cursor, width);
  const scroll = Math.max(0, caret.row - canvasHeight + 1);
  let out = '\x1b[?25l\x1b[H';
  let row = 0;
  let col = 0;

  for (let i = 0; i < cells.length && row < scroll + canvasHeight; i++) {
    const cell = cells[i];
    if (row >= scroll) {
      out += styleFor(cell, i) + displayedCharacter(cell, i) + '\x1b[0m';
    }
    if (cell.ch === '\n') {
      if (row >= scroll) out += `${ESC}K`;
      row++;
      col = 0;
    } else {
      col++;
      if (col >= width) {
        row++;
        col = 0;
      }
    }
  }

  const renderedRows = Math.max(0, row - scroll);
  for (let r = renderedRows; r < canvasHeight; r++) {
    out += `${ESC}K`;
    if (r < canvasHeight - 1) out += '\n';
  }

  // Matrix cells cast animated, disposable trails over the canvas. These are
  // visual overlays only; they never enter the editable text buffer.
  const matrixGlyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ!@#$%^&*()+-=<>[]{}|\\/:;\'"`~';
  const trailColors = [1.35, 1.12, 0.95, 0.76, 0.58, 0.4, 0.24].map(strength =>
    themeRgb.green.map(channel => Math.min(255, Math.round(channel * strength)))
  );
  const maxDepth = 12;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].effect !== 'matrix' || cells[i].ch === '\n') continue;
    const source = logicalPosition(i, width);
    const seed = cells[i].fxSeed ?? ((i * 0.61803398875) % 1);
    const cycle = 25 + Math.floor(seed * 40); // Slower cycle times (was 15-45, now 25-65)
    const offset = Math.floor(seed * 997) % cycle;
    const phase = (frame + offset) % cycle;
    const speed = 0.3 + seed * 0.4; // Slower speed (was 0.5-1.2, now 0.3-0.7)
    const head = phase * speed;
    
    // Add occasional glitch effects
    const glitchChance = seed * 0.1;
    const isGlitching = Math.sin(frame * 0.1 + i) > 0.95 - glitchChance;
    
    for (let depth = 1; depth <= maxDepth; depth++) {
      const distance = head - depth;
      if (distance < -1 || distance >= trailColors.length) continue;
      const screenRow = source.row - scroll + depth + 1;
      if (screenRow < 1 || screenRow > canvasHeight) continue;
      
      let color;
      if (distance < 0) {
        const fadeIn = distance + 1;
        color = trailColors[0].map(channel => Math.round(channel * fadeIn));
      } else {
        const from = Math.floor(distance);
        const to = Math.min(from + 1, trailColors.length - 1);
        const blend = distance - from;
        color = trailColors[from].map((channel, channelIndex) =>
          Math.round(channel + (trailColors[to][channelIndex] - channel) * blend)
        );
      }
      
      // Add brightness variation
      const brightness = isGlitching ? 1.5 : (1 + Math.sin(frame * 0.2 + depth * 0.5) * 0.2);
      const [red, green, blue] = color.map(c => Math.min(255, Math.round(c * brightness)));
      
      // More dynamic glyph selection
      const glyphSpeed = isGlitching ? 15 : 5; // Slower glyph changes (was 10/3, now 15/5)
      const glyphIndex = (i * 31 + depth * 17 + Math.floor(frame / glyphSpeed)) % matrixGlyphs.length;
      const glyph = distance < 1 ? cells[i].ch : matrixGlyphs[glyphIndex];
      
      // Add glow effect for the leading character
      const glowIntensity = distance < 0.5 ? '1;' : '2;';
      out += `${ESC}${screenRow};${source.col + 1}H\x1b[${glowIntensity}38;2;${red};${green};${blue}m${glyph}\x1b[0m`;
    }
  }

  if (showHelp) {
    const range = selectedRange();
    const hint = range
      ? `MARKED ${range[1] - range[0]}  Ctrl+D clear  Ctrl+T matrix  Ctrl+R rainbow  Ctrl+P pulse  Ctrl+S sparkle  Ctrl+B bold  Ctrl+U underline`
      : activeEffect !== 'none'
        ? `ACTIVE ${effects[activeEffect].label.toUpperCase()}  Press its shortcut again to stop  Shift+arrows mark  Ctrl+Q quit`
        : (Date.now() < statusUntil ? status : 'Shift+arrows mark  F1 hide help  Ctrl+Q quit');
    let divider = '';
    for (let column = 0; column < width; column++) {
      // More vibrant animated divider with wave effect
      const wave = Math.sin(column * 0.1 + frame * 0.2) * 0.5 + 0.5;
      const hue = (column * 2 + frame * 3) % 360;
      const saturation = 80 + wave * 20;
      const lightness = 60 + wave * 30;
      
      // Convert HSL to RGB
      const c = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
      const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
      const m = lightness / 100 - c / 2;
      
      let r, g, b;
      if (hue < 60) [r, g, b] = [c, x, 0];
      else if (hue < 120) [r, g, b] = [x, c, 0];
      else if (hue < 180) [r, g, b] = [0, c, x];
      else if (hue < 240) [r, g, b] = [0, x, c];
      else if (hue < 300) [r, g, b] = [x, 0, c];
      else [r, g, b] = [c, 0, x];
      
      const red = Math.round((r + m) * 255);
      const green = Math.round((g + m) * 255);
      const blue = Math.round((b + m) * 255);
      
      divider += `\x1b[38;2;${red};${green};${blue}m━`;
    }
    divider = renderThemeRail(width, frame / 4.8);
    const badgeColor = (range ? themeRgb.pink : activeEffect !== 'none' ? themeRgb.green : themeRgb.cyan).join(';');
    const badge = getSkin() === 'macintosh' ? ' ://  File  Edit  Effects ' : ' :// ';
    const available = Math.max(0, width - badge.length - 1);
    const visibleHint = hint.slice(0, available).padEnd(available);
    out += `${ESC}${height - 1};1H${divider}\x1b[0m`;
    out += `${ESC}${height};1H\x1b[1;38;2;${badgeColor}m${badge}${colors.reset} ${colors.dim}${colors.muted}${visibleHint}${colors.reset}${ESC}K`;
  }

  if (Date.now() < forbiddenEntryUntil) {
    const banner = forbiddenBannerLines();
    const firstRow = Math.max(1, Math.floor((canvasHeight - banner.length) / 2) + 1);
    const glitchTick = Math.floor(frame * 1.8);
    for (let line = 0; line < banner.length; line++) {
      const row = firstRow + line;
      if (row > canvasHeight) break;
      const corrupted = Array.from(banner[line], (character, columnIndex) => {
        const noise = seededRandom(glitchTick * 997 + line * 89 + columnIndex * 17);
        // Increased glitch probability for more dynamic effect
        if (character === '█' && noise < 0.03) return noise < 0.006 ? ' ' : noise < 0.015 ? '▓' : '▒';
        if (character === ' ' && noise > 0.995) return '█';
        return character;
      }).join('');
      const visible = corrupted.slice(0, width);
      const shiftRoll = seededRandom(glitchTick * 71 + line * 13);
      const shift = shiftRoll < 0.03 ? -1 : shiftRoll > 0.97 ? 1 : 0;
      const column = Math.max(1, Math.min(width, Math.floor((width - visible.length) / 2) + 1 + shift));
      const colorRoll = seededRandom(glitchTick * 43 + line * 31);
      // More vibrant color variations
      const glitchPalette = [
        themeRgb.cyan, themeRgb.blue, themeRgb.red,
        themeRgb.yellow, themeRgb.green, themeRgb.purple,
      ];
      const color = glitchPalette[Math.floor(colorRoll * glitchPalette.length)].join(';');
      // Add pulsing effect
      const pulse = 0.8 + Math.sin(frame * 0.5 + line * 0.3) * 0.2;
      const [r, g, b] = color.split(';').map(Number);
      const pulsedColor = `${Math.min(255, Math.round(r * pulse))};${Math.min(255, Math.round(g * pulse))};${Math.min(255, Math.round(b * pulse))}`;
      
      if (shift !== 0) {
        const ghostColumn = Math.max(1, Math.min(width, column - Math.sign(shift)));
        out += `${ESC}${row};${ghostColumn}H${colors.dim}${colors.cyan}${visible}${colors.reset}`;
      }
      out += `${ESC}${row};${column}H\x1b[1;38;2;${pulsedColor}m${visible}\x1b[0m`;
    }
  }

  const screenRow = Math.max(0, Math.min(canvasHeight - 1, caret.row - scroll)) + 1;
  out += `${ESC}${screenRow};${caret.col + 1}H\x1b[5 q\x1b[?25h`;
  process.stdout.write(out);
}

function insert(text) {
  const range = selectedRange();
  if (range) {
    cells.splice(range[0], range[1] - range[0]);
    cursor = range[0];
    anchor = null;
  }
  const additions = Array.from(text, ch => ({
    ch,
    effect: activeEffect,
    ...(activeEffect === 'matrix' ? { fxSeed: Math.random() } : {}),
  }));
  cells.splice(cursor, 0, ...additions);
  cursor += additions.length;
  applyAutomaticNameEffects();
  checkForbiddenEntry();
}

const AUTO_PAIRS = Object.freeze({
  '"': '"',
  "'": "'",
  '(': ')',
  '{': '}',
  '[': ']',
  '<': '>',
});
const AUTO_CLOSERS = new Set(Object.values(AUTO_PAIRS));

function newCell(ch) {
  return {
    ch,
    effect: activeEffect,
    ...(activeEffect === 'matrix' ? { fxSeed: Math.random() } : {}),
  };
}

function insertAutoPair(opening) {
  const closing = AUTO_PAIRS[opening];
  const range = selectedRange();
  if (range) {
    cells.splice(range[1], 0, newCell(closing));
    cells.splice(range[0], 0, newCell(opening));
    cursor = range[1] + 2;
    anchor = null;
  } else {
    cells.splice(cursor, 0, newCell(opening), newCell(closing));
    cursor++;
  }
  applyAutomaticNameEffects();
  checkForbiddenEntry();
}

function insertWithAutoPair(key) {
  if (key.length !== 1) return insert(key);
  if (AUTO_CLOSERS.has(key) && cells[cursor]?.ch === key && !selectedRange()) {
    cursor++;
    return;
  }
  if (AUTO_PAIRS[key]) return insertAutoPair(key);
  insert(key);
}

function runEnteredCommand() {
  const command = cells.map(cell => cell.ch).join('').trim().toLowerCase();
  if (!['cmd', 'cmd.brb', 'cmd.note', 'cmd.fix', 'cmd.guide', 'cmd.word', 'cmd.theme', 'cmd.skin', 'cmd.sally', 'cmd.selina', 'cmd.player', 'cmd.mediaplayer', 'cmd.mediactrl', 'cmd.update'].includes(command)) return false;

  cells.splice(0, cells.length);
  cursor = 0;
  anchor = null;

  if (command === 'cmd.sally' || command === 'cmd.selina') launchLoveProcess();
  else if (command === 'cmd.player' || command === 'cmd.mediaplayer' || command === 'cmd.mediactrl') launchMediaControlProcess();
  else if (command === 'cmd.update') launchUpdateProcess();
  else if (command === 'cmd.note') launchNoteProcess();
  else if (command === 'cmd.fix') launchNoteProcess(true);
  else if (command === 'cmd.guide') launchGuideProcess();
  else if (command === 'cmd.word') launchWordProcess();
  else if (command === 'cmd.theme' || command === 'cmd.skin') launchThemeProcess();
  else launchCommandProcess(command === 'cmd.brb');
  return true;
}

function playLoadingCue() {
  playSound('opening or loading');
}

function launchMediaControlProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const child = spawn(process.execPath, [path.join(__dirname, 'media-control-mode.js')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `Media player failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? 'Media player closed.' : 'Media player closed unexpectedly.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchLoveProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const child = spawn(process.execPath, [path.join(__dirname, 'love-mode.js')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `Love animation failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? 'I love you.' : 'Love animation closed unexpectedly.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchThemeProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  let selectedTheme = null;
  const child = spawn(process.execPath, [path.join(__dirname, 'theme-mode.js')], {
    cwd: __dirname,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  child.on('message', message => {
    if (message?.type === 'theme-selected' && typeof message.theme === 'string') selectedTheme = message.theme;
  });

  child.on('error', error => {
    playSound('error');
    status = `Theme selector failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    if (selectedTheme) setTheme(selectedTheme);
    else reloadTheme();
    if (code === 42) return restartApplication();
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? `Skin applied: ${getTheme().toUpperCase()}.` : 'Skin selector closed unexpectedly.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function restartApplication() {
  cleanup();
  if (process.env.TFX_LAUNCHER === '1') process.exit(42);

  const child = spawn(process.env.ComSpec || 'cmd.exe', [
    '/d',
    '/c',
    'start',
    '',
    path.join(__dirname, 'launch-wordfx.cmd'),
  ], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', error => {
    playSound('error');
    console.error(`:// could not restart: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('spawn', () => {
    child.unref();
    process.exit(0);
  });
}

function launchUpdateProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const child = spawn(process.execPath, [path.join(__dirname, 'updater.js')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `Update failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    if (code === 42) return restartApplication();
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? ':// is already up to date.' : 'Update did not complete.';
    statusUntil = Date.now() + 2500;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchWordProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const child = spawn(process.execPath, [path.join(__dirname, 'word-mode.js')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `Word game failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? 'Word game closed.' : 'Word game closed unexpectedly.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchGuideProcess() {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const child = spawn(process.execPath, [path.join(__dirname, 'guide-mode.js')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `Guide failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0 ? 'Guide closed.' : 'Guide closed unexpectedly.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchNoteProcess(fixMode = false) {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const childArgs = [path.join(__dirname, 'note-mode.js')];
  if (fixMode) childArgs.push('--fix');
  const child = spawn(process.execPath, childArgs, {
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('error', error => {
    playSound('error');
    status = `${fixMode ? 'Fix' : 'Note'} mode failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = code === 0
      ? `${fixMode ? 'Fix' : 'Note'} closed.`
      : `${fixMode ? 'Fix' : 'Note'} could not be saved.`;
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function launchCommandProcess(breakOnly = false) {
  playLoadingCue();
  commandProcessActive = true;
  process.stdin.off('data', handleKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[3J\x1b[2J\x1b[H');

  const childArgs = [path.join(__dirname, 'command-mode.js')];
  if (breakOnly) childArgs.push('--brb-main');
  const child = spawn(process.execPath, childArgs, {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, WORDFX_PARENT_ALT: '1', WORDFX_SKIP_STARTUP_SOUND: '1' },
  });

  child.on('error', error => {
    playSound('error');
    status = `Command mode failed: ${error.message}`;
    statusUntil = Date.now() + 3000;
  });

  child.on('exit', code => {
    if (code === 42) return restartApplication();
    commandProcessActive = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
    status = breakOnly ? 'Welcome back.' : 'Returned from command mode.';
    statusUntil = Date.now() + 1800;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    render();
  });
}

function checkForbiddenEntry() {
  const forbidden = 'phantom';
  const start = cursor - forbidden.length;
  if (start < 0) return;
  const candidate = cells
    .slice(start, cursor)
    .map(cell => cell.ch)
    .join('')
    .toLowerCase();
  const isWordCharacter = ch => ch !== undefined && /^[a-z0-9_]$/i.test(ch);
  if (candidate !== forbidden) return;
  if (isWordCharacter(cells[start - 1]?.ch) || isWordCharacter(cells[cursor]?.ch)) return;
  for (let i = start; i < cursor; i++) {
    cells[i].ch = '█';
    cells[i].effect = 'none';
    cells[i].censored = true;
  }
  forbiddenEntryUntil = Date.now() + 2600;
}

function applyAutomaticNameEffects() {
  const names = [
    { text: 'cato', effect: 'rainbow' },
    { text: 'jared', effect: 'rainbow' },
    { text: 'sally', effect: 'love' },
    { text: 'selina', effect: 'love' },
  ];
  const isWordCharacter = ch => ch !== undefined && /^[a-z0-9_]$/i.test(ch);
  for (const cell of cells) {
    if (!cell.autoNameEffect) continue;
    cell.effect = cell.autoBaseEffect;
    delete cell.autoNameEffect;
    delete cell.autoBaseEffect;
  }
  for (const name of names) {
    for (let start = 0; start <= cells.length - name.text.length; start++) {
      const candidate = cells
        .slice(start, start + name.text.length)
        .map(cell => cell.ch)
        .join('')
        .toLowerCase();
      if (candidate !== name.text) continue;
      if (isWordCharacter(cells[start - 1]?.ch)) continue;
      if (isWordCharacter(cells[start + name.text.length]?.ch)) continue;
      for (let i = start; i < start + name.text.length; i++) {
        cells[i].autoBaseEffect = cells[i].effect;
        cells[i].autoNameEffect = true;
        cells[i].effect = name.effect;
      }
    }
  }
}

function eraseBackward() {
  const range = selectedRange();
  if (range) {
    cells.splice(range[0], range[1] - range[0]);
    cursor = range[0];
    anchor = null;
  } else if (cursor > 0) {
    const opening = cells[cursor - 1]?.ch;
    const closing = cells[cursor]?.ch;
    if (AUTO_PAIRS[opening] === closing) {
      cells.splice(cursor - 1, 2);
      cursor--;
    } else {
      cells.splice(--cursor, 1);
    }
  }
  applyAutomaticNameEffects();
}

function applyEffect(effect) {
  const range = selectedRange();
  if (!range) {
    if (effect === 'none') {
      activeEffect = 'none';
    } else {
      activeEffect = activeEffect === effect ? 'none' : effect;
    }
    status = activeEffect === 'none'
      ? 'Typing effect disabled.'
      : `${effects[activeEffect].label} enabled for new text.`;
    playSound(activeEffect === 'none' ? 'toggle_off' : 'toggle_on');
    statusUntil = Date.now() + 1800;
    return;
  }
  for (let i = range[0]; i < range[1]; i++) {
    cells[i].effect = effect;
    delete cells[i].autoNameEffect;
    delete cells[i].autoBaseEffect;
    if (effect === 'matrix') cells[i].fxSeed = Math.random();
  }
  status = `Applied ${effects[effect].label}.`;
  playSound('select');
  statusUntil = Date.now() + 1800;
  anchor = null;
}

function moveHorizontal(delta, extend) {
  const previousCursor = cursor;
  if (extend && anchor === null) anchor = cursor;
  if (!extend && anchor !== null) {
    const range = selectedRange();
    cursor = range ? (delta < 0 ? range[0] : range[1]) : cursor;
    anchor = null;
    return;
  }
  cursor = Math.max(0, Math.min(cells.length, cursor + delta));
  if (!extend) anchor = null;
  if (cursor !== previousCursor) playSound('navigate');
}

function moveVertical(delta, extend) {
  const previousCursor = cursor;
  if (extend && anchor === null) anchor = cursor;
  const width = size().width;
  const pos = logicalPosition(cursor, width);
  cursor = indexAt(Math.max(0, pos.row + delta), pos.col, width);
  if (!extend) anchor = null;
  if (cursor !== previousCursor) playSound('navigate');
}

function cleanup() {
  if (timer) clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[0 q\x1b[0m');
  if (mainScreenActive) {
    mainScreenActive = false;
    process.stdout.write('\x1b[?1049l');
  } else {
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

function quit() {
  playSound('closing or quitting');
  cleanup();
  process.exit(0);
}

function handleKey(data) {
  const key = data.toString('utf8');
  playTypingSound(key);
  const range = selectedRange();
  const selectionHasEffect = range && cells
    .slice(range[0], range[1])
    .some(cell => cell.effect !== 'none');
  if (key === '\x03' || key === '\x11') return quit();
  if (clearAnimation) return;
  if (key === '\x04' && selectionHasEffect) applyEffect('none');
  else if (key === '\x12') applyEffect('rainbow');
  else if (key === '\x14') applyEffect('matrix');
  else if (key === '\x10') applyEffect('pulse');
  else if (key === '\x13') applyEffect('sparkle');
  else if (key === '\x02') applyEffect('bold');
  else if (key === '\x15') applyEffect('underline');
  else if (key === '\x00' || key === '\x1b[49~') applyEffect('none');
  else if (key === '\x1bOP' || key === '\x1b[11~') {
    showHelp = !showHelp;
    playSound(showHelp ? 'toggle_on' : 'toggle_off');
  }
  else if (key === '\r' || key === '\n') {
    if (!runEnteredCommand()) startClearAnimation();
  }
  else if (key === '\x7f' || key === '\b') eraseBackward();
  else if (/^\x1b\[(?:1;2)?D$/.test(key)) moveHorizontal(-1, key.includes(';2'));
  else if (/^\x1b\[(?:1;2)?C$/.test(key)) moveHorizontal(1, key.includes(';2'));
  else if (/^\x1b\[(?:1;2)?A$/.test(key)) moveVertical(-1, key.includes(';2'));
  else if (/^\x1b\[(?:1;2)?B$/.test(key)) moveVertical(1, key.includes(';2'));
  else if (key === '\x1b[H' || key === '\x1b[1~') { cursor = 0; anchor = null; playSound('navigate'); }
  else if (key === '\x1b[F' || key === '\x1b[4~') { cursor = cells.length; anchor = null; playSound('navigate'); }
  else if (!key.startsWith('\x1b') && !/[\x00-\x08\x0b-\x1f]/.test(key)) insertWithAutoPair(key);
  render();
}

process.on('exit', () => {
  if (mainScreenActive) process.stdout.write('\x1b[?1049l');
  process.stdout.write('\x1b[?25h\x1b[0m');
});
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.stdout.on('resize', render);
async function start() {
  mainScreenActive = true;
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  await warmSoundSystem();
  playSound('opening or loading');
  await playStartupAnimation();

  process.stdin.setEncoding(null);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleKey);
  lastFrameTime = Date.now();
  timer = setInterval(() => {
    // Use delta time for smoother animations
    const now = Date.now();
    const deltaTime = Math.min(100, now - lastFrameTime) / 1000; // Cap at 100ms
    lastFrameTime = now;

    // Keep animation timing stable while rendering intermediate frames smoothly.
    frame += deltaTime * 60; // 60 FPS target
    render();
  }, FRAME_INTERVAL);
  render();
}

start().catch(error => {
  playSound('error');
  cleanup();
  console.error(`:// failed to start: ${error.message}`);
  process.exitCode = 1;
});
