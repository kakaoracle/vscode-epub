'use strict';
/**
 * EPUB 结构解析：container.xml -> OPF -> manifest / spine / metadata / TOC(nav 或 NCX)
 * 零依赖，纯同步解析（文件已整体读入内存）。
 */

const { ZipReader } = require('./zip');
const { parseXml, find, findAll, child, children, textOf, localName } = require('./xml');

/** 把 OPF 内的相对 href 解析成 zip 内的绝对路径 */
function resolveZipPath(baseDir, href) {
  let raw = String(href || '').split('#')[0].split('?')[0].trim();
  try {
    raw = decodeURIComponent(raw);
  } catch (_) { /* 保持原样 */ }
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');
  const combined = baseDir ? `${baseDir}/${raw}` : raw;
  const parts = combined.split(/[/\\]/);
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function dirOf(zipPath) {
  const idx = zipPath.lastIndexOf('/');
  return idx >= 0 ? zipPath.slice(0, idx) : '';
}

/** 根据 XML 声明 / meta charset 猜编码，再解码 Buffer */
function decodeBuffer(data) {
  const head = data.slice(0, 2048).toString('latin1');
  let enc = null;
  const xmlDecl = /encoding\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (xmlDecl) enc = xmlDecl[1];
  if (!enc) {
    const metaCharset = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
    if (metaCharset) enc = metaCharset[1];
  }
  if (!enc) enc = 'utf-8';

  const normalized = enc.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.startsWith('utf8') || normalized === 'utf8') return data.toString('utf8');
  try {
    const decoder = new TextDecoder(enc, { fatal: false });
    const text = decoder.decode(data);
    // 若解码后出现大量替换字符，说明编码猜错了
    if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) return data.toString('utf8');
    return text;
  } catch (_) {
    return data.toString('utf8');
  }
}

class EpubBook {
  /** @param {Buffer} buffer epub 文件字节 */
  constructor(buffer) {
    this.zip = new ZipReader(buffer);
    /** @type {{title:string, creator:string, language:string, publisher:string, description:string}} */
    this.meta = { title: '', creator: '', language: '', publisher: '', description: '' };
    /** @type {Array<{id:string, href:string, mediaType:string, properties:string}>} */
    this.manifest = [];
    /** @type {Array<{index:number, id:string, href:string, mediaType:string, label:string}>} */
    this.spine = [];
    /** @type {Array<{label:string, href:string, fragment:string, index:number, children:Array}>} */
    this.toc = [];
    this.opfPath = '';
    this.opfDir = '';
    this.coverHref = null;

    this._parse();
  }

  _parse() {
    // 1) container.xml -> OPF 路径
    const containerText = this.zip.readText('META-INF/container.xml');
    if (!containerText) throw new Error('缺少 META-INF/container.xml，不是有效的 EPUB 文件');
    const container = parseXml(containerText);
    const rootfile = find(container, 'rootfile');
    if (!rootfile) throw new Error('container.xml 中未找到 rootfile');
    this.opfPath = rootfile.attrs['full-path'] || '';
    if (!this.zip.has(this.opfPath)) {
      // 有些书的 full-path 带前导斜杠或编码异常，做一次兜底扫描
      const guess = this.zip.names().find((n) => /\.opf$/i.test(n));
      if (!guess) throw new Error(`找不到 OPF 文件：${this.opfPath}`);
      this.opfPath = guess;
    }
    this.opfDir = dirOf(this.opfPath);

    // 2) OPF
    const opfText = decodeBuffer(this.zip.read(this.opfPath));
    const opf = parseXml(opfText);
    const pkg = find(opf, 'package');
    const root = pkg || opf;

    // metadata
    const metadata = find(root, 'metadata');
    if (metadata) {
      const firstText = (name) => {
        const node = children(metadata, name)[0];
        return node ? textOf(node) : '';
      };
      this.meta.title = firstText('title') || '';
      this.meta.creator = firstText('creator') || '';
      this.meta.language = firstText('language') || '';
      this.meta.publisher = firstText('publisher') || '';
      this.meta.description = firstText('description') || '';

      // EPUB2 封面：<meta name="cover" content="id">
      for (const m of children(metadata, 'meta')) {
        if ((m.attrs.name || '').toLowerCase() === 'cover' && m.attrs.content) {
          this._coverId = m.attrs.content;
        }
      }
    }

    // manifest
    const manifestNode = find(root, 'manifest');
    if (manifestNode) {
      for (const item of children(manifestNode, 'item')) {
        const href = item.attrs.href || '';
        const props = item.attrs.properties || '';
        this.manifest.push({
          id: item.attrs.id || '',
          href: resolveZipPath(this.opfDir, href),
          mediaType: item.attrs['media-type'] || '',
          properties: props
        });
        if (/\bcover-image\b/.test(props)) this.coverHref = resolveZipPath(this.opfDir, href);
      }
    }
    if (this._coverId && !this.coverHref) {
      const cover = this.manifest.find((m) => m.id === this._coverId);
      if (cover) this.coverHref = cover.href;
    }

    this._manifestById = new Map(this.manifest.map((m) => [m.id, m]));

    // spine
    const spineNode = find(root, 'spine');
    const tocId = spineNode ? spineNode.attrs.toc : null;
    if (spineNode) {
      let index = 0;
      for (const itemref of children(spineNode, 'itemref')) {
        const item = this._manifestById.get(itemref.attrs.idref);
        if (!item) continue;
        this.spine.push({
          index: index++,
          id: item.id,
          href: item.href,
          mediaType: item.mediaType,
          label: ''
        });
      }
    }
    this._spineByHref = new Map(this.spine.map((s) => [s.href, s.index]));

    // 3) TOC：优先 EPUB3 nav，其次 NCX
    const navItem = this.manifest.find((m) => /\bnav\b/.test(m.properties)) ||
      this.manifest.find((m) => /nav/i.test(m.href) && /x?html/i.test(m.mediaType));
    let toc = [];
    if (navItem) {
      try {
        toc = this._parseNavDoc(navItem.href);
      } catch (_) { toc = []; }
    }
    if (!toc.length && tocId) {
      const ncxItem = this._manifestById.get(tocId);
      if (ncxItem) {
        try { toc = this._parseNcx(ncxItem.href); } catch (_) { toc = []; }
      }
    }
    if (!toc.length) {
      const ncx = this.manifest.find((m) => /ncx/i.test(m.mediaType) || /\.ncx$/i.test(m.href));
      if (ncx) {
        try { toc = this._parseNcx(ncx.href); } catch (_) { toc = []; }
      }
    }
    if (!toc.length) {
      // 兜底：用 spine 顺序生成目录，标题取章节内首个 h1~h3 的文本
      toc = this.spine.map((s, i) => ({
        label: '',
        href: s.href,
        fragment: '',
        index: i,
        children: []
      }));
      this._fillTocLabelsFromChapters(toc);
    }
    this.toc = toc;

    // 把 spine 的章节标题补全（供底栏显示）
    const flat = flattenToc(toc);
    for (const entry of flat) {
      if (entry.index >= 0 && this.spine[entry.index] && !this.spine[entry.index].label) {
        this.spine[entry.index].label = entry.label;
      }
    }
  }

  _parseNavDoc(href) {
    const base = dirOf(href);
    const text = decodeBuffer(this.zip.read(href));
    const doc = parseXml(text);
    const navs = findAll(doc, 'nav');
    let navNode = navs.find((n) => (n.attrs['epub:type'] || n.attrs.type || '').split(/\s+/).includes('toc'));
    if (!navNode) navNode = navs[0];
    if (!navNode) return [];

    const parseList = (ol) => {
      const out = [];
      for (const li of children(ol, 'li')) {
        const a = child(li, 'a');
        const nestedOl = children(li, 'ol')[0];
        const rawHref = a ? (a.attrs.href || '') : '';
        const [pathPart, fragment = ''] = splitFragment(rawHref);
        const target = pathPart ? resolveZipPath(base, pathPart) : '';
        const index = target ? this.spineIndexOf(target) : -1;
        const label = a ? textOf(a) : (textOf(child(li, 'span')) || '');
        if (!label && !nestedOl) continue;
        out.push({
          label: label || '（无标题）',
          href: target,
          fragment,
          index,
          children: nestedOl ? parseList(nestedOl) : []
        });
      }
      return out;
    };

    const ol = child(navNode, 'ol');
    return ol ? parseList(ol) : [];
  }

  _parseNcx(href) {
    const base = dirOf(href);
    const text = decodeBuffer(this.zip.read(href));
    const doc = parseXml(text);
    const navMap = find(doc, 'navMap');
    if (!navMap) return [];

    const parsePoints = (parent) => {
      const out = [];
      for (const point of children(parent, 'navPoint')) {
        const labelNode = child(point, 'navLabel');
        const label = textOf(labelNode) || textOf(find(point, 'text')) || '';
        const content = child(point, 'content');
        const rawSrc = content ? content.attrs.src || '' : '';
        const [pathPart, fragment = ''] = splitFragment(rawSrc);
        const target = pathPart ? resolveZipPath(base, pathPart) : '';
        out.push({
          label: label || '（无标题）',
          href: target,
          fragment,
          index: target ? this.spineIndexOf(target) : -1,
          children: parsePoints(point)
        });
      }
      return out;
    };

    return parsePoints(navMap);
  }

  _fillTocLabelsFromChapters(toc) {
    for (const entry of flattenToc(toc)) {
      if (entry.label || entry.index < 0 || !entry.href) continue;
      try {
        const html = decodeBuffer(this.zip.read(entry.href));
        const match = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(html);
        if (match) {
          entry.label = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
        }
      } catch (_) { /* 忽略 */ }
    }
  }

  /** 找到 href 对应的 spine 序号，找不到返回 -1 */
  spineIndexOf(href) {
    if (this._spineByHref.has(href)) return this._spineByHref.get(href);
    const lower = href.toLowerCase();
    for (const [key, value] of this._spineByHref) {
      if (key.toLowerCase() === lower) return value;
    }
    return -1;
  }

  /** 读取某一章节的原始 HTML 文本 */
  readChapter(index) {
    const item = this.spine[index];
    if (!item) return null;
    const data = this.zip.read(item.href);
    if (data === null) return null;
    return { html: decodeBuffer(data), href: item.href, label: item.label };
  }

  /** 读取任意资源（图片/CSS/字体等） */
  readResource(href) {
    const target = this._resolveResource(href);
    if (!target) return null;
    return this.zip.read(target);
  }

  _resolveResource(href) {
    if (!href) return null;
    if (this.zip.has(href)) return href;
    const resolved = resolveZipPath(this.opfDir, href);
    if (this.zip.has(resolved)) return resolved;
    const lower = resolved.toLowerCase();
    for (const name of this.zip.names()) {
      if (name.toLowerCase() === lower) return name;
    }
    return null;
  }

  /** 供 webview 使用的精简结构 */
  toPayload() {
    return {
      meta: this.meta,
      spine: this.spine.map((s) => ({ href: s.href, label: s.label })),
      toc: this.toc,
      coverHref: this.coverHref
    };
  }
}

function splitFragment(href) {
  const raw = String(href || '').trim();
  const hash = raw.indexOf('#');
  if (hash < 0) return [raw, ''];
  return [raw.slice(0, hash), raw.slice(hash + 1)];
}

function flattenToc(toc) {
  const out = [];
  const walk = (list) => {
    for (const item of list) {
      out.push(item);
      if (item.children && item.children.length) walk(item.children);
    }
  };
  walk(toc || []);
  return out;
}

module.exports = { EpubBook, resolveZipPath, decodeBuffer, flattenToc };
