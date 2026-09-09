/* EPUB Reader — WebView 端逻辑
   职责：渲染章节、CSS 多列分页、翻页交互、应用 VS Code 设置、上报阅读进度与选区。

   设计约定：
   - 排版设置一律来自 VS Code 设置（settings.json），本文件不提供任何自定义设置面板；
     改设置后由扩展宿主推送 {type:'settings'}，这里只负责应用。
   - {type:'selection'} 通道长期保留，供后续的翻译 / AI 总结 / 批注 / 词典功能消费。 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @type {{meta:any, spine:Array, toc:Array, coverHref:string|null}} */
  let book = null;
  let settings = null;
  let fileName = '';

  const state = {
    spineIndex: 0,
    page: 0,          // 当前屏序号（一屏 = columns 列）
    screens: 1,       // 本章总屏数
    m: null,          // 分页几何，见 media/pagination.js
    loading: false,
    pendingFragment: '',
    pendingAtEnd: false
  };

  const els = {};
  const resourceUrls = new Map();   // zip 内路径 -> blob url
  const chapterPromises = new Map();
  const resourcePromises = new Map();
  let resourceToken = 0;
  let saveTimer = null;
  let relayoutTimer = null;
  let wheelAcc = 0;
  let wheelLock = 0;
  let lastCommandAt = 0;
  let lastSelection = '';

  // ---------------------------------------------------------------- 工具

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /** 滚动（连续纵向）模式还是翻页（CSS 多列横向分页）模式 */
  function isScrollMode() { return !!settings && settings.pageMode === 'scroll'; }

  function atTop() { return els.viewport.scrollTop <= 2; }

  function atBottom() {
    const vp = els.viewport;
    return vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 4;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function dirname(zipPath) {
    const idx = String(zipPath).lastIndexOf('/');
    return idx >= 0 ? zipPath.slice(0, idx) : '';
  }

  function resolveZipPath(baseDir, href) {
    let raw = String(href || '').split('#')[0].split('?')[0].trim();
    try { raw = decodeURIComponent(raw); } catch (_) { /* noop */ }
    if (!raw) return '';
    if (/^[a-z]+:/i.test(raw)) return '';              // 外链，交给宿主打开
    if (raw.startsWith('/')) raw = raw.replace(/^\/+/, '');
    const parts = (baseDir ? baseDir + '/' + raw : raw).split('/');
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  }

  function base64ToUrl(base64, mime) {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime || 'application/octet-stream' }));
  }

  function splitFragment(href) {
    const raw = String(href || '').trim();
    const hash = raw.indexOf('#');
    if (hash < 0) return [raw, ''];
    return [raw.slice(0, hash), raw.slice(hash + 1)];
  }

  // ---------------------------------------------------------------- 通信

  function requestChapter(index) {
    return new Promise((resolve) => {
      chapterPromises.set(index, resolve);
      vscode.postMessage({ type: 'loadChapter', index });
    });
  }

  function requestResources(hrefs) {
    if (!hrefs.length) return Promise.resolve({});
    const token = ++resourceToken;
    return new Promise((resolve) => {
      resourcePromises.set(token, resolve);
      vscode.postMessage({ type: 'resources', hrefs, token });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        onInit(msg);
        break;
      case 'chapter': {
        const resolve = chapterPromises.get(msg.index);
        if (resolve) {
          chapterPromises.delete(msg.index);
          resolve({ html: msg.html || '', label: msg.label || '' });
        }
        break;
      }
      case 'resources': {
        const resolve = resourcePromises.get(msg.token);
        if (resolve) {
          resourcePromises.delete(msg.token);
          resolve(msg.items || {});
        }
        break;
      }
      case 'settings':
        applySettings(msg.settings, { keepAnchor: true });
        break;
      case 'command':
        lastCommandAt = Date.now();
        handleCommand(msg.name);
        break;
      case 'fatal':
        showMask(msg.message || '打开失败', true);
        break;
      default:
        break;
    }
  });

  // ---------------------------------------------------------------- 初始化

  function onInit(msg) {
    book = msg.payload;
    settings = msg.settings;
    fileName = msg.fileName || '';

    buildUI();
    applySettings(settings, { keepAnchor: false });

    const progress = settings.rememberProgress ? msg.progress : null;
    const startIndex = progress && Number.isInteger(progress.spineIndex)
      ? clamp(progress.spineIndex, 0, Math.max(0, book.spine.length - 1))
      : 0;

    loadChapter(startIndex, progress ? { progress } : {});
  }

  // ---------------------------------------------------------------- UI 构建

  function buildUI() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="topbar">
        <button class="btn" id="btn-toc" title="目录 (Alt+T)">☰</button>
        <div class="title">
          <span class="book">${escapeHtml(book.meta.title || fileName.replace(/\.epub$/i, ''))}</span>
          <span class="chapter" id="chapter-label"></span>
        </div>
        <button class="btn" id="btn-settings" title="打开阅读器设置 (Alt+S)">⚙</button>
      </div>
      <div class="body-row">
        <aside class="sidebar" id="sidebar" hidden>
          <div class="sidebar-head">
            <input id="toc-filter" type="text" placeholder="搜索章节标题…" />
          </div>
          <div class="toc-list" id="toc-list"></div>
        </aside>
        <main class="stage" id="stage">
          <div class="viewport" id="viewport" tabindex="-1">
            <div class="columns" id="columns">
              <div class="content" id="content"></div>
            </div>
          </div>
          <button class="nav prev" id="nav-prev" title="上一页 (←)">‹</button>
          <button class="nav next" id="nav-next" title="下一页 (→)">›</button>
          <div class="statusbar" id="statusbar">
            <span id="status-left">—</span>
            <span class="status-right">
              <span id="status-right">—</span>
              <span class="progress-bar"><i id="progress-fill"></i></span>
            </span>
          </div>
        </main>
        <div class="mask" id="mask" hidden></div>
      </div>
    `;

    els.sidebar = document.getElementById('sidebar');
    els.tocList = document.getElementById('toc-list');
    els.tocFilter = document.getElementById('toc-filter');
    els.stage = document.getElementById('stage');
    els.viewport = document.getElementById('viewport');
    els.columns = document.getElementById('columns');
    els.content = document.getElementById('content');
    els.navPrev = document.getElementById('nav-prev');
    els.navNext = document.getElementById('nav-next');
    els.statusLeft = document.getElementById('status-left');
    els.statusRight = document.getElementById('status-right');
    els.progressFill = document.getElementById('progress-fill');
    els.statusbar = document.getElementById('statusbar');
    els.mask = document.getElementById('mask');
    els.chapterLabel = document.getElementById('chapter-label');
    els.btnToc = document.getElementById('btn-toc');
    els.btnSettings = document.getElementById('btn-settings');

    els.btnToc.addEventListener('click', toggleToc);
    els.btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    els.navPrev.addEventListener('click', () => { lastCommandAt = Date.now(); prevPage(); });
    els.navNext.addEventListener('click', () => { lastCommandAt = Date.now(); nextPage(); });
    els.tocFilter.addEventListener('input', renderToc);

    els.viewport.addEventListener('wheel', onWheel, { passive: false });
    els.viewport.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('selectionchange', onSelectionChange);

    renderToc();
    app.classList.remove('loading');
  }

  // ---------------------------------------------------------------- 设置应用

  const THEME_COLORS = {
    light: { fg: '#2b2b2b', bg: '#ffffff' },
    sepia: { fg: '#4b3c2a', bg: '#f5ecd9' },
    dark: { fg: '#c9d1d9', bg: '#1b1b1f' },
    green: { fg: '#2f3b30', bg: '#cce8cf' }
  };

  function resolveThemeColors() {
    let theme = settings.theme || 'auto';
    if (theme === 'auto') theme = document.body.classList.contains('vscode-dark') ? 'dark' : 'light';
    const preset = THEME_COLORS[theme] || THEME_COLORS.light;
    return {
      fg: settings.textColor || preset.fg,
      bg: settings.backgroundColor || preset.bg
    };
  }

  /** 应用宿主推送过来的 VS Code 设置；keepAnchor 时在重排后按字符偏移还原阅读位置 */
  function applySettings(next, opts) {
    const options = opts || {};
    let anchor = -1;
    if (options.keepAnchor && book && els.content) anchor = currentCharOffset();

    settings = next;

    const colors = resolveThemeColors();
    const root = document.documentElement;
    root.style.setProperty('--reader-fg', colors.fg);
    root.style.setProperty('--reader-bg', colors.bg);
    root.style.setProperty('--font-size', settings.fontSize + 'px');
    root.style.setProperty('--line-height', String(settings.lineHeight));
    root.style.setProperty('--para-spacing', settings.paragraphSpacing + 'em');
    root.style.setProperty('--page-pad', settings.pageMargin + 'px');
    root.style.setProperty('--col-gap', settings.columnGap + 'px');
    root.style.setProperty('--text-align', settings.textAlign === 'left' ? 'left' : 'justify');
    root.style.setProperty('--font-family', settings.fontFamily);
    document.body.style.background = colors.bg;

    if (els.statusbar) els.statusbar.hidden = !settings.showPageNumber;
    document.body.classList.toggle('mode-scroll', isScrollMode());

    if (book && els.viewport) {
      layout();
      if (anchor >= 0 && scrollToCharOffset(anchor)) {
        // 已按字符偏移还原到原位置
      } else {
        goToScreen(Math.min(state.page, state.screens - 1), false);
      }
      updateStatus();
    }
  }

  // ---------------------------------------------------------------- 目录

  function flattenToc(list, level, out) {
    out = out || [];
    for (const item of list || []) {
      out.push({ item, level: level || 0 });
      if (item.children && item.children.length) flattenToc(item.children, (level || 0) + 1, out);
    }
    return out;
  }

  function renderToc() {
    if (!els.tocList || !book) return;
    const keyword = (els.tocFilter.value || '').trim().toLowerCase();
    const flat = flattenToc(book.toc, 0);
    els.tocList.innerHTML = '';

    let rendered = 0;
    for (const { item, level } of flat) {
      if (keyword && !(item.label || '').toLowerCase().includes(keyword)) continue;
      const button = document.createElement('button');
      button.className = 'toc-item';
      button.textContent = item.label || '（无标题）';
      button.style.paddingLeft = (10 + Math.min(level, 5) * 12) + 'px';
      button.title = item.label || '';
      if (item.index === state.spineIndex) button.classList.add('current');
      button.addEventListener('click', () => goToTocEntry(item));
      els.tocList.appendChild(button);
      rendered++;
    }
    if (!rendered) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.style.padding = '10px';
      empty.textContent = keyword ? '没有匹配的章节' : '本书没有目录';
      els.tocList.appendChild(empty);
    }
  }

  function goToTocEntry(entry) {
    let index = entry.index;
    if (index === undefined || index === null || index < 0) {
      index = book.spine.findIndex((s) => s.href === entry.href);
    }
    if (index < 0) {
      showToast('该目录项无法定位到章节');
      return;
    }
    if (index === state.spineIndex) {
      if (entry.fragment) scrollToFragment(entry.fragment);
      else goToScreen(0, false);
      return;
    }
    state.pendingFragment = entry.fragment || '';
    loadChapter(index, { fragment: entry.fragment });
  }

  function toggleToc() {
    els.sidebar.hidden = !els.sidebar.hidden;
    els.btnToc.classList.toggle('active', !els.sidebar.hidden);
    requestAnimationFrame(relayoutSoon);
  }

  // ---------------------------------------------------------------- 章节渲染

  async function loadChapter(index, opts) {
    const options = opts || {};
    if (!book || index < 0 || index >= book.spine.length) return;
    state.loading = true;
    state.spineIndex = index;
    state.page = 0;
    state.pendingFragment = options.fragment || '';
    state.pendingAtEnd = !!options.atEnd;

    hideMask();
    const { html, label } = await requestChapter(index);
    if (!html) {
      showMask('这一章没有内容');
      state.loading = false;
      return;
    }

    await renderChapter(html, book.spine[index].href);

    if (label) book.spine[index].label = label;
    els.chapterLabel.textContent = chapterTitle(index);
    renderToc();

    if (state.pendingFragment) {
      scrollToFragment(state.pendingFragment);
    } else if (options.progress) {
      restoreProgress(options.progress);
    } else if (state.pendingAtEnd) {
      if (isScrollMode()) {
        els.viewport.scrollTop = els.viewport.scrollHeight;
        syncScrollState();
      } else {
        goToScreen(state.screens - 1, false);
      }
    } else {
      goToScreen(0, false);
    }
    state.pendingFragment = '';
    state.pendingAtEnd = false;
    state.loading = false;
    saveProgress();
  }

  async function renderChapter(html, chapterHref) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const baseDir = dirname(chapterHref);

    // 安全清理：移除脚本与交互元素，剥离事件属性
    doc.querySelectorAll('script, iframe, object, embed, noscript, form, input, button, select, textarea')
      .forEach((node) => node.remove());
    doc.querySelectorAll('*').forEach((el) => {
      if (!el.attributes) return;
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if (/^\s*javascript:/i.test(attr.value)) el.setAttribute(attr.name, '#');
      }
    });

    // 收集需要向宿主请求的资源（图片 / CSS）
    const refs = new Set();
    const addRef = (value) => {
      const resolved = resolveZipPath(baseDir, value);
      if (resolved) refs.add(resolved);
    };
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((el) => addRef(el.getAttribute('href')));
    doc.querySelectorAll('img').forEach((el) => { if (el.getAttribute('src')) addRef(el.getAttribute('src')); });
    doc.querySelectorAll('image').forEach((el) => addRef(el.getAttribute('xlink:href') || el.getAttribute('href')));

    const missing = Array.from(refs).filter((href) => !resourceUrls.has(href));
    if (missing.length) {
      const items = await requestResources(missing);
      for (const href of missing) {
        const item = items[href];
        if (item && item.data) resourceUrls.set(href, base64ToUrl(item.data, item.mime));
      }
    }

    // 书籍自带 CSS 内联注入（CSP 不允许直接引外部文件）
    const inlinedCss = await inlineCss(Array.from(refs).filter((r) => /\.css$/i.test(r)));
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove());

    // 资源引用替换为 blob url
    doc.querySelectorAll('img').forEach((el) => {
      const url = resourceUrls.get(resolveZipPath(baseDir, el.getAttribute('src')));
      if (url) el.setAttribute('src', url);
      el.removeAttribute('srcset');
    });
    doc.querySelectorAll('image').forEach((el) => {
      const attr = el.getAttribute('xlink:href') ? 'xlink:href' : 'href';
      const url = resourceUrls.get(resolveZipPath(baseDir, el.getAttribute(attr)));
      if (url) el.setAttribute(attr, url);
    });

    els.content.innerHTML = '';
    if (inlinedCss) {
      const style = document.createElement('style');
      style.textContent = inlinedCss;
      els.content.appendChild(style);
    }

    const body = doc.body || doc.documentElement;
    const fragment = document.createDocumentFragment();
    while (body.firstChild) fragment.appendChild(body.firstChild);
    els.content.appendChild(fragment);

    // 内部链接 -> 跳章 / 跳锚点；外链 -> 交给宿主
    els.content.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href') || '';
        if (/^[a-z]+:/i.test(href)) {
          e.preventDefault();
          vscode.postMessage({ type: 'openExternal', url: href });
          return;
        }
        const [pathPart, frag] = splitFragment(href);
        const target = resolveZipPath(baseDir, pathPart);
        const index = target ? book.spine.findIndex((s) => s.href === target) : state.spineIndex;
        e.preventDefault();
        if (index >= 0 && index !== state.spineIndex) {
          state.pendingFragment = frag;
          loadChapter(index, { fragment: frag });
        } else if (frag) {
          scrollToFragment(frag);
        }
      });
    });

    // 图片加载完成后需要重新分页
    els.content.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', relayoutSoon, { once: true });
        img.addEventListener('error', relayoutSoon, { once: true });
      }
    });

    layout();
  }

  async function inlineCss(cssRefs) {
    const parts = [];
    for (const href of cssRefs) {
      const url = resourceUrls.get(href);
      if (!url) continue;
      try {
        const res = await fetch(url);
        parts.push('/* ' + href + ' */\n' + (await res.text()));
      } catch (_) { /* 忽略加载失败的样式表 */ }
    }
    return parts.join('\n');
  }

  // ---------------------------------------------------------------- 分页

  function layout() {
    if (!els.viewport || !els.columns) return;
    if (isScrollMode()) {
      // 连续滚动：内容单列纵向流动，一屏 = 一个视口高度
      els.columns.style.columnWidth = 'auto';
      els.columns.style.columnGap = '0px';
      state.m = EpubPagination.measureVertical(els.viewport);
    } else {
      state.m = EpubPagination.measure(els.viewport, els.columns, settings.columns, settings.columnGap);
    }
    state.screens = state.m.screens;
    updateNav();
  }

  function relayoutSoon() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      const anchor = currentCharOffset();
      layout();
      if (anchor >= 0) scrollToCharOffset(anchor);
      else goToScreen(Math.min(state.page, state.screens - 1), false);
      updateStatus();
    }, 60);
  }

  function goToScreen(screen, smooth) {
    if (!state.m) return;
    state.page = EpubPagination.scrollToScreen(els.viewport, state.m, screen, smooth);
    updateStatus();
    updateNav();
    scheduleSave();
  }

  /** 滚动模式：按当前实际 scrollTop 同步屏序号/进度（按钮连点时 state.page 可能滞后） */
  function syncScrollState() {
    if (!state.m) return;
    const step = Math.max(1, state.m.step - 8);
    state.page = clamp(Math.round(els.viewport.scrollTop / step), 0, state.screens - 1);
    updateStatus();
    updateNav();
    scheduleSave();
  }

  /** 滚动模式：向上/下滚动一屏，保留少量重叠让阅读不断片 */
  function scrollByScreen(delta, smooth) {
    const vp = els.viewport;
    const step = Math.max(1, vp.clientHeight - 8);
    const top = vp.scrollTop + delta * step;
    if (smooth && vp.scrollTo) vp.scrollTo({ top, behavior: 'smooth' });
    else vp.scrollTop = top;
    syncScrollState();
  }

  function nextPage() {
    if (state.loading || !book) return;
    if (isScrollMode()) {
      if (!atBottom()) { scrollByScreen(1, true); return; }
      if (state.spineIndex < book.spine.length - 1) loadChapter(state.spineIndex + 1, {});
      return;
    }
    if (state.page < state.screens - 1) goToScreen(state.page + 1, true);
    else if (state.spineIndex < book.spine.length - 1) loadChapter(state.spineIndex + 1, {});
  }

  function prevPage() {
    if (state.loading || !book) return;
    if (isScrollMode()) {
      if (!atTop()) { scrollByScreen(-1, true); return; }
      if (state.spineIndex > 0) loadChapter(state.spineIndex - 1, { atEnd: true });
      return;
    }
    if (state.page > 0) goToScreen(state.page - 1, true);
    else if (state.spineIndex > 0) loadChapter(state.spineIndex - 1, { atEnd: true });
  }

  function updateNav() {
    if (!els.navPrev || !book) return;
    const lastChapter = state.spineIndex >= book.spine.length - 1;
    const atStart = isScrollMode()
      ? (atTop() && state.spineIndex <= 0)
      : (state.page <= 0 && state.spineIndex <= 0);
    const atEnd = isScrollMode()
      ? (atBottom() && lastChapter)
      : (state.page >= state.screens - 1 && lastChapter);
    els.navPrev.style.visibility = atStart ? 'hidden' : 'visible';
    els.navNext.style.visibility = atEnd ? 'hidden' : 'visible';
  }

  function updateStatus() {
    if (!els.statusLeft) return;
    const chapter = chapterTitle(state.spineIndex);
    els.statusLeft.textContent = chapter;
    const total = book ? book.spine.length : 1;
    let bookRatio;
    if (isScrollMode()) {
      const vp = els.viewport;
      const span = Math.max(1, vp.scrollHeight - vp.clientHeight);
      bookRatio = clamp((state.spineIndex + clamp(vp.scrollTop / span, 0, 1)) / total, 0, 1);
    } else {
      bookRatio = clamp((state.spineIndex + (state.page + 1) / Math.max(1, state.screens)) / total, 0, 1);
    }
    els.statusRight.textContent = settings.showPageNumber
      ? (isScrollMode()
        ? `${Math.round(bookRatio * 100)}%`
        : `第 ${state.page + 1}/${state.screens} 页 · ${Math.round(bookRatio * 100)}%`)
      : '';
    els.progressFill.style.width = (bookRatio * 100) + '%';
    if (els.chapterLabel) els.chapterLabel.textContent = chapter;
  }

  function chapterTitle(index) {
    if (!book) return '';
    const spine = book.spine[index];
    if (spine && spine.label) return spine.label;
    const hit = flattenToc(book.toc, 0).find(({ item }) => item.index === index);
    if (hit) return hit.item.label;
    return `第 ${index + 1} 节`;
  }

  // ---------------------------------------------------------------- 位置记忆

  /** 当前屏首个字符在章节中的偏移（用于进度记忆），失败返回 -1 */
  function currentCharOffset() {
    return EpubPagination.currentCharOffset(els.viewport, els.content);
  }

  /** 按字符偏移还原到对应的屏（进度恢复 / 改排版后保持位置） */
  function scrollToCharOffset(offset) {
    if (!state.m) return false;
    if (isScrollMode()) {
      // 滚动模式没有"屏边界"，直接把目标字符所在行对齐到视口顶部，恢复更精确
      const docY = EpubPagination.docYOf(els.viewport, EpubPagination.rangeOfOffset(els.content, offset));
      if (docY < 0) return false;
      EpubPagination.scrollToDocY(els.viewport, docY - 6, false);
      syncScrollState();
      return true;
    }
    const screen = EpubPagination.screenOfCharOffset(els.viewport, els.content, state.m, offset);
    if (screen < 0) return false;
    goToScreen(screen, false);
    return true;
  }

  function scrollToFragment(fragment) {
    if (!fragment) { goToScreen(0, false); return; }
    let target = null;
    try {
      target = els.content.querySelector('[id="' + CSS.escape(fragment) + '"]');
    } catch (_) {
      target = els.content.querySelector('[id="' + fragment + '"]');
    }
    if (!target) {
      for (const el of els.content.querySelectorAll('[id], a[name]')) {
        if (el.id === fragment || el.getAttribute('name') === fragment) { target = el; break; }
      }
    }
    if (!target) { goToScreen(0, false); return; }
    if (isScrollMode()) {
      const docY = EpubPagination.docYOf(els.viewport, target);
      if (docY >= 0) {
        EpubPagination.scrollToDocY(els.viewport, docY - 6, false);
        syncScrollState();
        return;
      }
    }
    goToScreen(EpubPagination.screenOfElement(els.viewport, state.m, target), false);
  }

  function restoreProgress(progress) {
    layout();
    let ok = false;
    if (progress && progress.charOffset > 0) ok = scrollToCharOffset(progress.charOffset);
    if (!ok && progress && typeof progress.ratio === 'number') {
      goToScreen(Math.round(progress.ratio * (state.screens - 1)), false);
    } else if (!ok) {
      goToScreen(0, false);
    }
    if (progress && progress.label && els.chapterLabel) els.chapterLabel.textContent = progress.label;
  }

  function scheduleSave() {
    if (!settings || !settings.rememberProgress) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 700);
  }

  function saveProgress() {
    if (!book || !settings || !settings.rememberProgress) return;
    const charOffset = currentCharOffset();
    vscode.postMessage({
      type: 'saveProgress',
      progress: {
        spineIndex: state.spineIndex,
        charOffset: charOffset >= 0 ? charOffset : 0,
        ratio: state.screens > 1 ? state.page / (state.screens - 1) : 0,
        label: chapterTitle(state.spineIndex)
      }
    });
  }

  // ---------------------------------------------------------------- 交互

  function onWheel(e) {
    if (!book) return;
    // 滚动模式走浏览器原生滚动，只在翻页模式下把滚轮转成整屏翻页
    if (isScrollMode()) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);
    const now = Date.now();
    if (now - wheelLock < 220) return;
    wheelAcc += delta;
    if (wheelAcc > 40) { wheelAcc = 0; wheelLock = now; nextPage(); }
    else if (wheelAcc < -40) { wheelAcc = 0; wheelLock = now; prevPage(); }
  }

  let scrollTimer = null;
  function onScroll() {
    if (!book || !settings) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!state.m) return;
      if (isScrollMode()) {
        syncScrollState();
        return;
      }
      const screen = Math.round(els.viewport.scrollLeft / EpubPagination.screenStep(state.m));
      if (screen !== state.page) {
        state.page = clamp(screen, 0, state.screens - 1);
        updateStatus();
        updateNav();
        scheduleSave();
      }
    }, 120);
  }

  function onResize() {
    if (!book) return;
    relayoutSoon();
  }

  function onKeyDown(e) {
    if (!book) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // 方向键优先由 VS Code 快捷键（命令）处理，这里仅作兜底，避免重复翻页
      if (Date.now() - lastCommandAt < 300) return;
      e.preventDefault();
      if (e.key === 'ArrowRight') nextPage(); else prevPage();
      return;
    }
    if (isScrollMode() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      els.viewport.scrollTop += (e.key === 'ArrowDown' ? 1 : -1) * 90;
      syncScrollState();
      return;
    }
    if (e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); nextPage(); }
    else if (e.key === 'PageUp') { e.preventDefault(); prevPage(); }
    else if (e.key === 'Home') {
      e.preventDefault();
      if (isScrollMode()) { els.viewport.scrollTop = 0; syncScrollState(); }
      else goToScreen(0, false);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (isScrollMode()) { els.viewport.scrollTop = els.viewport.scrollHeight; syncScrollState(); }
      else goToScreen(state.screens - 1, false);
    }
  }

  /** 选区上报：为后续的翻译 / AI 总结 / 批注 / 词典功能预留的通道 */
  function onSelectionChange() {
    if (!book) return;
    const selection = window.getSelection();
    let text = selection ? String(selection).trim() : '';
    if (selection && els.content && !els.content.contains(selection.anchorNode)) text = '';
    text = text.slice(0, 4000);
    if (text === lastSelection) return;
    lastSelection = text;
    vscode.postMessage({
      type: 'selection',
      text,
      spineIndex: state.spineIndex,
      chapter: chapterTitle(state.spineIndex)
    });
  }

  function handleCommand(name) {
    switch (name) {
      case 'nextPage': nextPage(); break;
      case 'prevPage': prevPage(); break;
      case 'toggleToc': toggleToc(); break;
      case 'clearProgress':
        vscode.postMessage({ type: 'clearProgress' });
        goToScreen(0, false);
        break;
      case 'goToStart':
        loadChapter(0, {});
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- 遮罩 / 提示

  function showMask(text, isError) {
    if (!els.mask) return;
    els.mask.hidden = false;
    els.mask.textContent = text;
    els.mask.classList.toggle('error', !!isError);
  }

  function hideMask() {
    if (els.mask) els.mask.hidden = true;
  }

  let toastTimer = null;
  function showToast(text) {
    showMask(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideMask, 1600);
  }

  // ---------------------------------------------------------------- 启动

  vscode.postMessage({ type: 'ready' });
})();
