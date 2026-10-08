/*
 * verify.mjs / verify-live.mjs 共用的零件：参数解析、Chromium 定位、
 * playwright-core 加载、断言收集器、页面侧状态读取、静态服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const USERSCRIPT = path.join(ROOT, 'wb2api-hub-sidebar-nav.user.js');
export const FIXTURE = path.join(HERE, 'fixture.html');
export const SHOTS = path.join(HERE, 'shots');
export const VIEWPORT = { width: 1440, height: 720 };

export const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseArgs(argv, defaults){
  const out = { ...defaults };
  for(let i = 0; i < argv.length; i++){
    const key = argv[i];
    if(key.startsWith('--')) out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

/* 浏览器可执行文件：显式路径 > CHROME_PATH > ms-playwright 缓存目录 */
export function findChrome(explicit){
  const cands = [explicit, process.env.CHROME_PATH].filter(Boolean);
  const caches = [
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  for(const dir of caches){
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch(e){ continue; }
    for(const name of entries.filter(n => n.startsWith('chromium-')).sort().reverse()){
      cands.push(path.join(dir, name, 'chrome-win64', 'chrome.exe'));
      cands.push(path.join(dir, name, 'chrome-linux', 'chrome'));
      cands.push(path.join(dir, name, 'chrome-linux64', 'chrome'));
      cands.push(path.join(dir, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
    const shell = entries.filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse()[0];
    if(shell) cands.push(path.join(dir, shell, 'chrome-win64', 'headless_shell.exe'));
  }
  for(const c of cands){ if(c && fs.existsSync(c)) return c; }
  return null;
}

/* 本机常见的既有安装，作为 npm 依赖之外的兜底（不下载浏览器） */
export async function loadPlaywright(){
  const unwrap = m => (m && m.chromium) ? m : (m && m.default) || m;
  try { return unwrap(await import('playwright-core')); }
  catch(e){}
  const guesses = [
    path.join(os.homedir(), 'WorkSpace', 'chat', 'node_modules', 'playwright-core', 'index.js'),
  ];
  for(const g of guesses){
    if(fs.existsSync(g)) return unwrap(await import(pathToFileURL(g).href));
  }
  throw new Error('找不到 playwright-core：请先 npm i playwright-core，或用 NODE_PATH 指向已有安装');
}

export function makeChecker(){
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '\n         → ' + detail));
  };
  const report = () => {
    const failed = results.filter(r => !r.ok);
    console.log('\n' + '='.repeat(60));
    console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    return failed;
  };
  return { check, report, results };
}

/* 页面侧的侧栏状态（在浏览器里跑） */
export const SIDEBAR_STATE = () => {
  const page = document.querySelector('.main-page.active');
  const sb = page && page.querySelector('.wbpn-sidebar');
  return {
    pageId: page ? page.id : null,
    on: page ? page.classList.contains('wbpn-on') : false,
    collapsed: page ? page.classList.contains('wbpn-collapsed') : false,
    hasSidebar: !!sb,
    labels: sb ? Array.from(sb.querySelectorAll('.wbpn-nav .wbpn-item')).map(b => b.textContent) : [],
    targets: sb ? Array.from(sb.querySelectorAll('.wbpn-nav .wbpn-item')).map(b => b.dataset.target) : [],
    active: sb ? (sb.querySelector('.wbpn-item.active') || {}).textContent || null : null,
    hasTop: sb ? !!sb.querySelector('button.wbpn-top') : false,
    hasToggle: sb ? !!sb.querySelector('button.wbpn-toggle') : false,
    sidebarWidth: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
    navVisible: sb ? getComputedStyle(sb.querySelector('.wbpn-nav')).display !== 'none' : false,
  };
};

/* 起一个只读静态服务：面板在 http:// 下才用得上 localStorage 等能力 */
export function serve(files){
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const file = files[url.pathname];
      if(!file){ res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* 真实面板在没有后端/未登录时会弹「面板密码」遮罩（#panelGate，z-index 600），
   它会挡住所有点击。那层遮罩属于未登录态，不是要验的布局，用样式表
   !important 压掉（才能盖过它自己的行内 display）。 */
export async function dismissGate(page){
  await page.addStyleTag({ content: '#panelGate{display:none!important}' });
  await page.waitForTimeout(80);
}
