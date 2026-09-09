'use strict';
/** 阅读排版设置：统一从 VS Code 配置读取，改设置即改全局阅读体验 */

const vscode = require('vscode');
const os = require('os');

const SECTION = 'vscodeEpub';

const DEFAULTS = {
  fontSize: 18,
  lineHeight: 1.8,
  paragraphSpacing: 0.8,
  fontFamily: '',
  theme: 'auto',
  textColor: '',
  backgroundColor: '',
  columns: 1,
  columnGap: 40,
  pageMargin: 48,
  textAlign: 'justify',
  pageMode: 'page',
  rememberProgress: true,
  showPageNumber: true
};

/** 依据系统给出中文默认字体栈，避免中文书名/正文落到难看的西文字体上 */
function defaultFontStack() {
  switch (os.platform()) {
    case 'win32':
      return '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif';
    case 'darwin':
      return '"PingFang SC", "Songti SC", "Hiragino Sans GB", "Noto Serif CJK SC", sans-serif';
    default:
      return '"Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei", sans-serif';
  }
}

function readSettings() {
  const config = vscode.workspace.getConfiguration(SECTION);
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = config.get(key, DEFAULTS[key]);
    settings[key] = value === undefined || value === null ? DEFAULTS[key] : value;
  }
  if (!settings.fontFamily) settings.fontFamily = defaultFontStack();
  settings.fontSize = clamp(settings.fontSize, 12, 40);
  settings.lineHeight = clamp(settings.lineHeight, 1, 3);
  settings.paragraphSpacing = clamp(settings.paragraphSpacing, 0, 3);
  settings.columnGap = clamp(settings.columnGap, 0, 120);
  settings.pageMargin = clamp(settings.pageMargin, 0, 160);
  settings.columns = [1, 2, 3].includes(Number(settings.columns)) ? Number(settings.columns) : 1;
  settings.pageMode = settings.pageMode === 'scroll' ? 'scroll' : 'page';
  return settings;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 判断一次配置变更是否影响阅读器排版 */
function isReaderSetting(e) {
  return e.affectsConfiguration(SECTION);
}

async function updateSetting(key, value) {
  const config = vscode.workspace.getConfiguration(SECTION);
  await config.update(key, value, vscode.ConfigurationTarget.Global);
}

module.exports = { readSettings, updateSetting, isReaderSetting, defaultFontStack, DEFAULTS };
