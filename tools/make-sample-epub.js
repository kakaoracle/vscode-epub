'use strict';
/** 生成一个用于自测的 EPUB 文件（零依赖 ZIP 写入器），可同时作为示例书使用 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name:string, data:Buffer, store?:boolean}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const useStored = !!entry.store;
    const payload = useStored ? raw : zlib.deflateRawSync(raw);
    const method = useStored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x800, 6);       // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0, 12);          // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/** 1x1 透明 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

function makeChapter(title, paragraphs, extra) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1>${title}</h1>
  ${paragraphs.map((p) => `<p>${p}</p>`).join('\n  ')}
  ${extra || ''}
</body>
</html>`;
}

function buildEpub3() {
  const chapters = [
    { file: 'chap01.xhtml', title: '第一章 初见', paras: Array.from({ length: 12 }, (_, i) => `这是第一章的第 ${i + 1} 段正文内容，用于验证分页、行距与字号设置是否生效。中文排版测试：汉字、标点，以及 English words 混排。`) },
    { file: 'chap02.xhtml', title: '第二章 深入', paras: Array.from({ length: 10 }, (_, i) => `第二章第 ${i + 1} 段。这里放一张图片：<img src="images/cover.png" alt="封面" />`) },
    { file: 'chap03.xhtml', title: '第三章 尾声', paras: Array.from({ length: 8 }, (_, i) => `第三章第 ${i + 1} 段，测试内部链接跳转与目录定位。`), extra: '<p id="anchor-end"><a href="chap01.xhtml">回到第一章</a></p>' }
  ];

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>示例电子书 · EPUB3</dc:title>
    <dc:creator>WorkBuddy</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>本地测试</dc:publisher>
    <meta name="cover" content="cover-img" />
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="css" href="style.css" media-type="text/css" />
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image" />
    ${chapters.map((c, i) => `<item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml" />`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${chapters.map((c, i) => `<itemref idref="c${i + 1}" />`).join('\n    ')}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="chap01.xhtml">第一章 初见</a></li>
      <li><a href="chap02.xhtml">第二章 深入</a>
        <ol><li><a href="chap03.xhtml">第三章 尾声</a></li></ol>
      </li>
    </ol>
  </nav>
</body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="sample-1" /></head>
  <docTitle><text>示例电子书</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>第一章 初见</text></navLabel><content src="chap01.xhtml" /></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>第二章 深入</text></navLabel><content src="chap02.xhtml" /></navPoint>
  </navMap>
</ncx>`;

  const css = 'body { margin: 0; }\np { text-indent: 2em; margin: 0.5em 0; }\nh1 { text-align: center; }';

  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/style.css', data: css },
    { name: 'OEBPS/images/cover.png', data: PNG_1X1 },
    ...chapters.map((c) => ({ name: 'OEBPS/' + c.file, data: makeChapter(c.title, c.paras, c.extra) }))
  ]);
}

/** EPUB2：没有 nav 文档，只靠 NCX */
function buildEpub2() {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>示例电子书 · EPUB2</dc:title>
    <dc:creator opf:role="aut">WorkBuddy</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="c1" href="chap01.xhtml" media-type="application/xhtml+xml" />
    <item id="c2" href="chap02.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1" />
    <itemref idref="c2" />
  </spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="sample-2" /></head>
  <docTitle><text>示例电子书</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>第一篇</text></navLabel><content src="chap01.xhtml" /></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>第二篇</text></navLabel><content src="chap02.xhtml#section2" /></navPoint>
  </navMap>
</ncx>`;

  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/chap01.xhtml', data: makeChapter('第一篇', Array.from({ length: 6 }, (_, i) => `EPUB2 第一章段落 ${i + 1}。`)) },
    { name: 'OEBPS/chap02.xhtml', data: makeChapter('第二篇', Array.from({ length: 6 }, (_, i) => `EPUB2 第二章段落 ${i + 1}。`), '<h2 id="section2">第二节</h2><p>锚点测试段落。</p>') }
  ]);
}

if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  const files = [
    ['sample-epub3.epub', buildEpub3()],
    ['sample-epub2.epub', buildEpub2()]
  ];
  for (const [name, buf] of files) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, buf);
    console.log('已生成', target, (buf.length / 1024).toFixed(1) + ' KB');
  }
}

module.exports = { buildZip, buildEpub3, buildEpub2 };
