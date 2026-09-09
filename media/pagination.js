/* EPUB Reader — 分页几何与位置记忆
 * 独立成模块的原因：这是整个阅读器最容易出错的部分（CSS 多列溢出 + 字符偏移定位），
 * 抽出来后 tools/pagination-check.html 可以直接验证真实代码，而不是验证一份副本。
 *
 * 分页原理：.columns 是一个高度固定、column-fill:auto 的 CSS 多列容器；
 * 内容超出单屏时，浏览器会沿行内方向（横向）溢出出新的列，
 * 父容器 .viewport 作为滚动容器，其 scrollWidth 即为所有列的总宽度。
 */
(function (global) {
  'use strict';

  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  /** 计算列宽与屏数，并把列宽写回 DOM */
  function measure(viewport, columns, cols, columnGap) {
    const columnCount = Math.max(1, Number(cols) || 1);
    const gap = columnCount > 1 ? (Number(columnGap) || 0) : 0;
    const available = viewport.clientWidth;
    const colW = Math.max(100, Math.floor((available - gap * (columnCount - 1)) / columnCount));

    columns.style.columnWidth = colW + 'px';
    columns.style.columnGap = gap + 'px';

    // scrollWidth = 列数 * colW + (列数-1) * gap  =>  反解列数
    const totalColumns = Math.max(1, Math.round((viewport.scrollWidth + gap) / (colW + gap)));
    const screens = Math.max(1, Math.ceil(totalColumns / columnCount));

    return { colW, gap, cols: columnCount, totalColumns, screens };
  }

  /** 一屏滚动的距离（cols 列 + 其间的 gap） */
  function screenStep(m) {
    return m.axis === 'y' ? m.step : m.cols * (m.colW + m.gap);
  }

  function scrollToScreen(viewport, m, screen, smooth) {
    const target = Math.min(Math.max(0, screen), m.screens - 1);
    const pos = target * screenStep(m);
    if (m.axis === 'y') {
      if (smooth && viewport.scrollTo) viewport.scrollTo({ top: pos, behavior: 'smooth' });
      else viewport.scrollTop = pos;
    } else {
      if (smooth && viewport.scrollTo) viewport.scrollTo({ left: pos, behavior: 'smooth' });
      else viewport.scrollLeft = pos;
    }
    return target;
  }

  /** 滚动模式的几何：内容纵向连续流动，一屏 = 一个视口高度 */
  function measureVertical(viewport) {
    const step = Math.max(1, viewport.clientHeight);
    const total = Math.max(1, viewport.scrollHeight);
    return {
      axis: 'y',
      step,
      colW: viewport.clientWidth,
      gap: 0,
      cols: 1,
      totalColumns: 1,
      screens: Math.max(1, Math.ceil(total / step))
    };
  }

  /** 元素或 Range 在文档中的纵向坐标（相对内容顶部），失败返回 -1 */
  function docYOf(viewport, target) {
    if (!target) return -1;
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : target;
    if (!rect || (rect.top === 0 && rect.bottom === 0)) return -1;
    const vpRect = viewport.getBoundingClientRect();
    return rect.top + viewport.scrollTop - vpRect.top;
  }

  /** 把文档纵向坐标滚到视口顶部（滚动模式下用于精确恢复阅读位置） */
  function scrollToDocY(viewport, docY, smooth) {
    const top = Math.max(0, docY);
    if (smooth && viewport.scrollTo) viewport.scrollTo({ top, behavior: 'smooth' });
    else viewport.scrollTop = top;
  }

  function rangeOfOffset(content, offset) {
    const loc = locationOfOffset(content, offset);
    if (!loc) return null;
    const range = document.createRange();
    range.setStart(loc.node, loc.off);
    range.collapse(true);
    return range;
  }

  /** 判断某个文本片段矩形是否落在视口（当前屏）可见范围内 */
  function isVisibleIn(r, vp) {
    return r.width > 0 && r.height > 0 &&
      r.right > vp.left + 0.5 &&
      r.left < vp.right - 0.5 &&
      r.bottom > vp.top + 0.5 &&
      r.top < vp.bottom - 0.5;
  }

  /**
   * 当前屏首个字符在章节中的偏移；失败返回 -1。
   *
   * 注意：不能用"视口左上角 + 固定偏移"取样 —— 那里通常是页边距留白，
   * caretRangeFromPoint 会命中上一屏末尾的字符，导致进度恢复差一屏。
   * 这里改为按文档顺序找第一个在当前屏可见的文本片段，再在其内部精确定位。
   */
  function currentCharOffset(viewport, content) {
    if (!content || !viewport) return -1;
    const vp = viewport.getBoundingClientRect();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();

      for (const r of rects) {
        if (!isVisibleIn(r, vp)) continue;
        // 命中当前屏第一个可见片段：在文本内部取精确插入点（避开留白）
        const x = Math.max(r.left + 1, vp.left + 1);
        const y = r.top + Math.min(r.height / 2, 8);
        const caret = caretRangeAt(x, y);
        if (caret && content.contains(caret.startContainer)) {
          // 插入点落在节点末尾时会产生歧义（等价于下一节点开头），回退一个字符保证可逆
          let extra = caret.startOffset;
          if (caret.startContainer.nodeType === 3 &&
            caret.startContainer.length > 0 && extra >= caret.startContainer.length) {
            extra = caret.startContainer.length - 1;
          }
          return offsetOf(content, caret.startContainer, extra);
        }
        return offsetOf(content, node, 0);
      }
    }
    return -1;
  }

  function offsetOf(root, node, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current === node) return acc + offset;
      acc += current.length;
    }
    return -1;
  }

  /**
   * 由偏移反查 DOM 位置。
   * 注意必须用严格大于：若用 >=，偏移落在节点末尾时会同时匹配「上一节点末尾」和
   * 「下一节点开头」，写入与读回可能落到不同位置，导致恢复时差一屏。
   */
  function locationOfOffset(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (acc + node.length > offset) return { node, off: offset - acc };
      acc += node.length;
    }
    return null;
  }

  /** 文档坐标 -> 屏序号 */
  function screenOfDocX(m, docX) {
    const column = Math.max(0, Math.floor(docX / (m.colW + m.gap)));
    return Math.floor(column / m.cols);
  }

  /** 找出某个字符偏移所在的屏；失败返回 -1 */
  function screenOfCharOffset(viewport, content, m, offset) {
    const loc = locationOfOffset(content, offset);
    if (!loc) return -1;
    const range = document.createRange();
    range.setStart(loc.node, loc.off);
    range.setEnd(loc.node, Math.min(loc.off + 1, loc.node.length));
    let rect = range.getBoundingClientRect();
    if (!rect || (rect.left === 0 && rect.top === 0)) {
      range.setEnd(loc.node, loc.off);
      rect = range.getBoundingClientRect();
    }
    if (!rect || (rect.left === 0 && rect.top === 0)) return -1;
    const vpRect = viewport.getBoundingClientRect();
    const docX = rect.left + viewport.scrollLeft - vpRect.left;
    return screenOfDocX(m, docX);
  }

  /** 找出某个元素（锚点）所在的屏 */
  function screenOfElement(viewport, m, el) {
    if (!el) return 0;
    const vpRect = viewport.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const docX = rect.left + viewport.scrollLeft - vpRect.left;
    return screenOfDocX(m, docX);
  }

  global.EpubPagination = {
    measure,
    measureVertical,
    screenStep,
    scrollToScreen,
    currentCharOffset,
    screenOfCharOffset,
    screenOfElement,
    offsetOf,
    locationOfOffset,
    rangeOfOffset,
    docYOf,
    scrollToDocY
  };
})(window);
