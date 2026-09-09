'use strict';
/** 解析链路自测：生成 EPUB -> 用 src/ 的实现解析 -> 断言关键结果 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { buildEpub3, buildEpub2 } = require('./make-sample-epub');
const { EpubBook } = require('../src/epub');
const { ZipReader } = require('../src/zip');
const { parseXml } = require('../src/xml');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713', name);
  } catch (err) {
    console.error('  \u2717', name, '\n     ', err.message);
    process.exitCode = 1;
  }
}

console.log('\n[1] ZIP 读取（stored + deflate 混合）');
const zipBuffer = buildEpub3();
check('解析出全部 10 个条目', () => {
  const zip = new ZipReader(zipBuffer);
  assert.strictEqual(zip.names().length, 10, '实际: ' + zip.names().join(', '));
});
check('stored 条目（mimetype）正确', () => {
  const zip = new ZipReader(zipBuffer);
  assert.strictEqual(zip.readText('mimetype'), 'application/epub+zip');
});
check('deflate 条目正确解压且内容完整', () => {
  const zip = new ZipReader(zipBuffer);
  const opf = zip.readText('OEBPS/content.opf');
  assert.ok(opf.includes('<dc:title>示例电子书 · EPUB3</dc:title>'), 'OPF 内容异常');
  assert.ok(opf.length > 500, '解压长度异常: ' + opf.length);
});
check('二进制条目（PNG）字节一致', () => {
  const zip = new ZipReader(zipBuffer);
  const png = zip.read('OEBPS/images/cover.png');
  assert.strictEqual(png.length, 70, 'PNG 长度: ' + png.length);
  assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
});

console.log('\n[2] XML 解析');
check('属性含 > 与实体时仍正确', () => {
  const node = parseXml('<root a="1 &lt; 2"><child x=\'y\'>文本&amp;实体</child></root>');
  const root = node.children[0];
  assert.strictEqual(root.attrs.a, '1 < 2');
  const child = root.children[0];
  assert.strictEqual(child.attrs.x, 'y');
  assert.strictEqual(child.children[0].text, '文本&实体');
});
check('CDATA 与注释不破坏结构', () => {
  const node = parseXml('<a><!-- c --><b><![CDATA[<not/>tag]]></b></a>');
  const a = node.children[0];
  const b = a.children[0];
  assert.strictEqual(b.children[0].text, '<not/>tag');
});

console.log('\n[3] EPUB3 解析（nav 目录）');
const book3 = new EpubBook(buildEpub3());
check('书名/作者/语言', () => {
  assert.strictEqual(book3.meta.title, '示例电子书 · EPUB3');
  assert.strictEqual(book3.meta.creator, 'WorkBuddy');
  assert.strictEqual(book3.meta.language, 'zh-CN');
});
check('spine 顺序与数量正确', () => {
  assert.strictEqual(book3.spine.length, 3);
  assert.ok(book3.spine[0].href.endsWith('chap01.xhtml'), book3.spine[0].href);
  assert.ok(book3.spine[2].href.endsWith('chap03.xhtml'), book3.spine[2].href);
});
check('目录来自 nav 文档（含嵌套）', () => {
  assert.strictEqual(book3.toc.length, 2, JSON.stringify(book3.toc.map((t) => t.label)));
  assert.strictEqual(book3.toc[0].label, '第一章 初见');
  assert.strictEqual(book3.toc[0].index, 0);
  assert.strictEqual(book3.toc[1].children.length, 1);
  assert.strictEqual(book3.toc[1].children[0].label, '第三章 尾声');
  assert.strictEqual(book3.toc[1].children[0].index, 2);
});
check('封面识别', () => {
  assert.ok(book3.coverHref && book3.coverHref.endsWith('images/cover.png'), String(book3.coverHref));
});
check('章节正文可读且带 CSS 引用', () => {
  const chapter = book3.readChapter(1);
  assert.ok(chapter.html.includes('第二章第 1 段'), '章节内容缺失');
  assert.ok(chapter.html.includes('images/cover.png'), '图片引用缺失');
  assert.ok(chapter.html.includes('style.css'), 'CSS 引用缺失');
});
check('资源按相对路径解析（CSS）', () => {
  const css = book3.readResource('OEBPS/style.css');
  assert.ok(css && css.toString('utf8').includes('text-indent'), 'CSS 读取失败');
});
check('章节内相对路径可解析为 zip 内绝对地址', () => {
  const data = book3.readResource('images/cover.png');
  assert.ok(data && data.length === 70, '按章节相对目录解析图片失败');
});
check('toPayload 可序列化', () => {
  const json = JSON.stringify(book3.toPayload());
  assert.ok(json.length > 200);
  assert.strictEqual(JSON.parse(json).spine.length, 3);
});

console.log('\n[4] EPUB2 解析（NCX 目录 + 锚点）');
const book2 = new EpubBook(buildEpub2());
check('书名', () => assert.strictEqual(book2.meta.title, '示例电子书 · EPUB2'));
check('NCX 目录解析', () => {
  assert.strictEqual(book2.toc.length, 2);
  assert.strictEqual(book2.toc[0].label, '第一篇');
  assert.strictEqual(book2.toc[1].label, '第二篇');
  assert.strictEqual(book2.toc[1].fragment, 'section2');
  assert.strictEqual(book2.toc[1].index, 1);
});
check('spine 章节标题回落到目录', () => {
  assert.strictEqual(book2.spine[0].label, '第一篇');
});

console.log('\n[5] 写盘后再读取（真实文件 I/O）');
check('samples 目录中的书能被解析', () => {
  const target = path.join(__dirname, '..', 'samples', 'sample-epub3.epub');
  if (!fs.existsSync(target)) {
    throw new Error('缺少示例文件，请先运行 node tools/make-sample-epub.js');
  }
  const book = new EpubBook(fs.readFileSync(target));
  assert.strictEqual(book.spine.length, 3);
  assert.strictEqual(book.meta.title, '示例电子书 · EPUB3');
});

console.log(`\n完成：${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}\n`);
