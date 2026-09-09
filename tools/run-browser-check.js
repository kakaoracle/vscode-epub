'use strict';
/** 用 headless Chrome（CDP）跑 tools/pagination-check.html，验证真实的分页与进度恢复行为 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const PORT = 9333;

async function main() {
  const browser = CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) {
    console.error('未找到 Chrome / Edge，跳过浏览器端验证');
    return;
  }

  const target = path.join(__dirname, 'pagination-check.html');
  const url = 'file:///' + target.replace(/\\/g, '/');
  const userDataDir = path.join(require('os').tmpdir(), 'epub-check-profile-' + Date.now());

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1200,800',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    url
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await waitForTarget();
    const payload = await evaluate(wsUrl);
    report(payload);
  } finally {
    child.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口未就绪');
}

function evaluate(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { reject(new Error('执行超时')); ws.close(); }, 30000);

    ws.addEventListener('open', () => {
      const expression = `new Promise((resolve) => {
        const tick = () => {
          const el = document.getElementById('result');
          if (el && el.textContent.indexOf('@@RESULT@@') >= 0) { resolve(el.textContent); return; }
          setTimeout(tick, 100);
        };
        tick();
      })`;
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text || '页面内异常'));
      } else resolve(msg.result && msg.result.result ? msg.result.result.value : '');
    });

    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function report(raw) {
  const match = /@@RESULT@@([\s\S]*?)@@END@@/.exec(raw || '');
  if (!match) {
    console.error('未取得测试结果：', String(raw).slice(0, 300));
    process.exitCode = 1;
    return;
  }
  let results;
  try {
    results = JSON.parse(match[1]);
  } catch (err) {
    console.error('结果解析失败：', err.message);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  console.log('\n[6] 浏览器端分页验证（headless Chrome，真实 CSS 多列布局）');
  for (const item of results) {
    if (item.ok) {
      console.log('  \u2713', item.name, item.info ? '— ' + JSON.stringify(item.info) : '');
    } else {
      failed++;
      console.error('  \u2717', item.name, '—', item.error);
    }
  }
  console.log('');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('浏览器验证失败：', err.message);
  process.exitCode = 1;
});
