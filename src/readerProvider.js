'use strict';
/**
 * 自定义只读编辑器：让 .epub 像普通文件一样被 VS Code 打开。
 * 扩展宿主负责解析 EPUB 与读取资源，webview 只负责渲染与交互。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EpubBook } = require('./epub');
const { ProgressStore } = require('./progress');
const { readSettings, updateSetting, isReaderSetting } = require('./settings');

const VIEW_TYPE = 'vscodeEpub.epubReader';
const MAX_CACHED_BOOKS = 4;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.xhtml': 'application/xhtml+xml',
  '.html': 'application/xhtml+xml',
  '.htm': 'application/xhtml+xml'
};

function guessMime(href) {
  const ext = path.extname(href).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}

class EpubReaderProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.store = new ProgressStore(context.globalState);
    /** @type {Map<string, EpubBook>} 已解析的书（LRU 上限 MAX_CACHED_BOOKS） */
    this._books = new Map();
    /** @type {Array<{panel: vscode.WebviewPanel, uri: vscode.Uri}>} */
    this._editors = [];
    this._active = null;
    /** 最近一次在 webview 中选中的文本，供 AI / 翻译 / 批注等功能使用 */
    this._lastSelection = { text: '', spineIndex: -1, chapter: '' };
  }

  /** 当前选中的文本（webview 实时上报） */
  get selection() { return this._lastSelection; }

  get viewType() { return VIEW_TYPE; }

  /** 当前处于激活状态的阅读器（供命令快捷键使用） */
  get activeEditor() { return this._active; }

  async openCustomDocument(uri) {
    // 只读文档：只保留 uri，真正的解析放到 resolveCustomEditor
    return { uri, dispose: () => { } };
  }

  async resolveCustomEditor(document, webviewPanel) {
    const uri = document.uri;
    const mediaDir = path.join(this.context.extensionPath, 'media');

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(mediaDir)]
    };
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview, mediaDir);

    const editorEntry = { panel: webviewPanel, uri };
    this._editors.push(editorEntry);
    if (webviewPanel.active) this._active = editorEntry;

    const changeActive = (active) => {
      if (active) this._active = editorEntry;
      else if (this._active === editorEntry) this._active = null;
    };
    webviewPanel.onDidChangeViewState((e) => changeActive(e.webviewPanel.active));
    webviewPanel.onDidDispose(() => {
      const idx = this._editors.indexOf(editorEntry);
      if (idx >= 0) this._editors.splice(idx, 1);
      if (this._active === editorEntry) this._active = null;
    });

    let book = null;
    const resourceCache = new Map();

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'ready': {
            book = await this._loadBook(uri);
            const settings = readSettings();
            this.store.touchRecent({ path: uri.fsPath, title: book.meta.title });
            webviewPanel.webview.postMessage({
              type: 'init',
              payload: book.toPayload(),
              settings,
              progress: this.store.get(uri.fsPath),
              filePath: uri.fsPath,
              fileName: path.basename(uri.fsPath)
            });
            break;
          }
          case 'loadChapter': {
            if (!book) book = await this._loadBook(uri);
            const chapter = book.readChapter(message.index);
            webviewPanel.webview.postMessage({
              type: 'chapter',
              index: message.index,
              html: chapter ? chapter.html : '',
              label: chapter ? chapter.label : ''
            });
            break;
          }
          case 'resources': {
            if (!book) book = await this._loadBook(uri);
            const hrefs = Array.isArray(message.hrefs) ? message.hrefs : [];
            const items = {};
            for (const href of hrefs) {
              if (!href || items[href] !== undefined) continue;
              const cached = resourceCache.get(href);
              if (cached !== undefined) {
                items[href] = cached;
                continue;
              }
              const data = book.readResource(href);
              if (data === null || data === undefined) {
                items[href] = null;
                resourceCache.set(href, null);
                continue;
              }
              const item = { mime: guessMime(href), data: data.toString('base64') };
              items[href] = item;
              if (resourceCache.size > 300) resourceCache.clear();
              resourceCache.set(href, item);
            }
            webviewPanel.webview.postMessage({ type: 'resources', items, token: message.token });
            break;
          }
          case 'saveProgress': {
            if (message.progress) {
              await this.store.set(uri.fsPath, message.progress);
              if (message.progress.label !== undefined) {
                this.store.touchRecent({ path: uri.fsPath, title: book ? book.meta.title : undefined });
              }
            }
            break;
          }
          case 'updateSetting': {
            await updateSetting(message.key, message.value);
            break;
          }
          case 'clearProgress': {
            await this.store.clear(uri.fsPath);
            webviewPanel.webview.postMessage({ type: 'command', name: 'goToStart' });
            vscode.window.setStatusBarMessage('已清除本书阅读进度', 3000);
            break;
          }
          case 'openExternal': {
            if (message.url) vscode.env.openExternal(vscode.Uri.parse(message.url));
            break;
          }
          case 'openSettings': {
            vscode.commands.executeCommand('workbench.action.openSettings', 'vscodeEpub');
            break;
          }
          case 'selection': {
            // 选区通道：后续翻译 / AI 总结 / 批注 / 词典功能从这里取词
            this._lastSelection = {
              text: message.text || '',
              spineIndex: message.spineIndex,
              chapter: message.chapter || ''
            };
            vscode.commands.executeCommand('setContext', 'vscodeEpub.hasSelection', !!(message.text || '').trim());
            break;
          }
          case 'error': {
            console.error('[epub reader]', message.message);
            break;
          }
          default:
            break;
        }
      } catch (err) {
        const text = err && err.message ? err.message : String(err);
        vscode.window.showErrorMessage(`EPUB 阅读器：${text}`);
        webviewPanel.webview.postMessage({ type: 'fatal', message: text });
      }
    });
  }

  async _loadBook(uri) {
    const key = ProgressStore.normalizeKey(uri.fsPath);
    const cached = this._books.get(key);
    if (cached) {
      // LRU：重新插入到末尾
      this._books.delete(key);
      this._books.set(key, cached);
      return cached;
    }
    const data = await fs.promises.readFile(uri.fsPath);
    const book = new EpubBook(data);
    this._books.set(key, book);
    if (this._books.size > MAX_CACHED_BOOKS) {
      const oldestKey = this._books.keys().next().value;
      this._books.delete(oldestKey);
    }
    return book;
  }

  /** 向当前激活的阅读器转发命令 */
  sendCommand(name, payload) {
    const target = this._active;
    if (!target) return false;
    target.panel.webview.postMessage({ type: 'command', name, payload });
    return true;
  }

  /** 配置变更时同步给所有打开的阅读器 */
  refreshSettings() {
    const settings = readSettings();
    for (const editor of this._editors) {
      editor.panel.webview.postMessage({ type: 'settings', settings });
    }
  }

  _getHtml(webview, mediaDir) {
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'reader.css')));
    const paginationUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'pagination.js')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'reader.js')));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data: blob:`,
      "media-src data: blob:"
    ].join('; ');

    // 阅读器外壳：内容由 JS 填充，主题变量由 CSS 提供
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>EPUB 阅读器</title>
</head>
<body>
<div id="app" class="loading"></div>
<script nonce="${nonce}" src="${paginationUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

module.exports = { EpubReaderProvider, VIEW_TYPE, readSettings, isReaderSetting };
