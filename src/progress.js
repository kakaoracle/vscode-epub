'use strict';
/**
 * 阅读进度存储。
 * 按「文件绝对路径」记忆，存于 globalState —— 换工作区、重开 VS Code 都还在。
 */

const path = require('path');

const PROGRESS_KEY = 'vscodeEpub.progress';
const RECENT_KEY = 'vscodeEpub.recent';
const MAX_RECENT = 30;

class ProgressStore {
  /** @param {import('vscode').Memento} globalState */
  constructor(globalState) {
    this.state = globalState;
  }

  static normalizeKey(filePath) {
    return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
  }

  /** @returns {{spineIndex:number, charOffset:number, ratio:number, label:string, updatedAt:number}|null} */
  get(filePath) {
    const all = this.state.get(PROGRESS_KEY) || {};
    return all[ProgressStore.normalizeKey(filePath)] || null;
  }

  set(filePath, progress) {
    const all = this.state.get(PROGRESS_KEY) || {};
    all[ProgressStore.normalizeKey(filePath)] = {
      spineIndex: progress.spineIndex | 0,
      charOffset: progress.charOffset | 0,
      ratio: Number(progress.ratio) || 0,
      label: progress.label || '',
      updatedAt: Date.now()
    };
    return this.state.update(PROGRESS_KEY, all);
  }

  clear(filePath) {
    const all = this.state.get(PROGRESS_KEY) || {};
    delete all[ProgressStore.normalizeKey(filePath)];
    return this.state.update(PROGRESS_KEY, all);
  }

  /** 记录最近阅读，返回更新后的列表 */
  touchRecent(entry) {
    const list = (this.state.get(RECENT_KEY) || []).filter(
      (item) => ProgressStore.normalizeKey(item.path) !== ProgressStore.normalizeKey(entry.path)
    );
    list.unshift({
      path: entry.path,
      title: entry.title || path.basename(entry.path),
      updatedAt: Date.now()
    });
    const trimmed = list.slice(0, MAX_RECENT);
    this.state.update(RECENT_KEY, trimmed);
    return trimmed;
  }

  recent() {
    return this.state.get(RECENT_KEY) || [];
  }
}

module.exports = { ProgressStore };
