'use strict';
/**
 * 极简 XML 解析器（零依赖）。
 * 足以解析 EPUB 的 container.xml / OPF / NCX / nav.xhtml 这类由工具生成的规范 XML。
 * 产出节点结构：{ name, attrs, children, text }
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026'
};

function decodeEntities(str) {
  if (!str || str.indexOf('&') < 0) return str;
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body];
    return named !== undefined ? named : match;
  });
}

function parseXml(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const len = src.length;
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];

  const pushText = (str) => {
    if (!str) return;
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    // 合并相邻文本节点（CDATA 与纯文本可能被拆开）
    if (last && last.name === '#text') last.text += str;
    else parent.children.push({ name: '#text', attrs: {}, children: [], text: str });
  };

  let i = 0;
  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      pushText(src.slice(lt + 9, end < 0 ? len : end));
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE 等声明，可能带内部子集 [ ... ]
      let j = lt + 2;
      let depth = 0;
      while (j < len) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt);
      if (gt < 0) break;
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    // 开标签：找到未被引号包裹的 '>'
    let gt = -1;
    let quote = null;
    for (let k = lt + 1; k < len; k++) {
      const c = src[k];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') { gt = k; break; }
    }
    if (gt < 0) break;

    let raw = src.slice(lt + 1, gt);
    let selfClosing = false;
    if (raw.endsWith('/')) {
      selfClosing = true;
      raw = raw.slice(0, -1);
    }

    const nameMatch = /^([^\s/>]+)/.exec(raw.trimStart());
    const name = nameMatch ? nameMatch[1] : '';
    const attrs = {};
    const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
    let m;
    while ((m = attrRe.exec(raw)) !== null) {
      const key = m[1];
      const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || ''));
      attrs[key] = decodeEntities(value);
    }

    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** 去掉命名空间前缀：dc:title -> title */
function localName(name) {
  const idx = String(name).indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/** 深度优先查找第一个 localName 命中的节点 */
function find(node, name) {
  const target = localName(name);
  const walk = (n) => {
    for (const child of n.children) {
      if (child.name === '#text') continue;
      if (localName(child.name) === target) return child;
    }
    for (const child of n.children) {
      if (child.name === '#text') continue;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node);
}

/** 深度优先查找所有 localName 命中的节点 */
function findAll(node, name) {
  const target = localName(name);
  const out = [];
  const walk = (n) => {
    for (const child of n.children) {
      if (child.name === '#text') continue;
      if (localName(child.name) === target) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** 取节点的直接子元素中 localName 命中的第一个 */
function child(node, name) {
  const target = localName(name);
  for (const c of node.children) {
    if (c.name !== '#text' && localName(c.name) === target) return c;
  }
  return null;
}

/** 取节点的直接子元素中所有 localName 命中的 */
function children(node, name) {
  const target = localName(name);
  return node.children.filter((c) => c.name !== '#text' && localName(c.name) === target);
}

/** 递归收集节点内所有文本 */
function textOf(node) {
  if (!node) return '';
  let out = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (c.name === '#text') out += c.text;
      else walk(c);
    }
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

module.exports = { parseXml, find, findAll, child, children, textOf, localName, decodeEntities };
