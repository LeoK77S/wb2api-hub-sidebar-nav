/*
 * 对「已经在跑的真实面板」的验收：登录进去，注入用户脚本，验证侧栏在
 * 真实数据、真实轮询下的行为。
 *
 * 用法（推荐用环境变量传密码，避免出现在进程列表里）：
 *   PANEL_URL=http://192.168.77.102:10202 PANEL_PASSWORD=xxx node verify/verify-live.mjs
 *   node verify/verify-live.mjs --url http://host:port --password xxx
 *
 * 与 verify.mjs 的分工：verify.mjs 拿固定版本的 dashboard.html 硬编码期望清单，
 * 能发现「少一项 / 多一项 / 标题带上状态数字」；这里面对的是活面板，区块清单
 * 会随数据变（例如国内版成长任务区块整块显隐），所以改为验两类不依赖清单的
 * 性质：
 *   健全性 —— 每个导航项都指向一个真实的顶层 section，且标题与该项文本一致；
 *   完整性 —— 页面里每个「可导航区块」都在清单里，一个不漏。
 * 再加上跳转/高亮/回到顶部/收起/切页这些行为断言。
 *
 * 只读：只做导航与展开收起，不点任何会改服务端状态的按钮。
 */
import path from 'node:path';
import {
  SHOTS, USERSCRIPT,
  eq, parseArgs, findChrome, loadPlaywright, makeChecker, SIDEBAR_STATE,
} from './lib.mjs';

const { check, report } = makeChecker();

const TABS = ['gateway', 'analytics', 'settings', 'logs'];

/* 页面侧：独立走一遍「哪些区块该进导航」——刻意不复用脚本的实现，
   与导航项对照才能验出漏项。 */
const ELIGIBLE = () => {
  const page = document.querySelector('.main-page.active');
  if(!page) return null;
  const sections = Array.from(page.querySelectorAll('section')).filter(sec => {
    if(getComputedStyle(sec).display === 'none') return false;
    if(!sec.querySelector('h2')) return false;
    for(let p = sec.parentElement; p && p !== page; p = p.parentElement){
      if(p.tagName === 'SECTION') return false;
    }
    return true;
  });
  return sections.map(sec => {
    const h2 = sec.querySelector('h2');
    const clone = h2.cloneNode(true);
    clone.querySelectorAll('em').forEach(el => el.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  });
};

/* 页面侧：导航项的健全性 —— 目标真实存在、是 section、标题一致、是顶层 */
const SOUNDNESS = () => {
  const page = document.querySelector('.main-page.active');
  const items = Array.from(page.querySelectorAll('.wbpn-nav .wbpn-item'));
  return items.map(item => {
    const sec = document.getElementById(item.dataset.target);
    if(!sec) return { label: item.textContent, ok: false, why: '锚点指向的元素不存在' };
    if(sec.tagName !== 'SECTION') return { label: item.textContent, ok: false, why: '锚点不是 section' };
    const h2 = sec.querySelector('h2');
    if(!h2) return { label: item.textContent, ok: false, why: '区块没有 h2' };
    const clone = h2.cloneNode(true);
    clone.querySelectorAll('em').forEach(el => el.remove());
    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if(text !== item.textContent) return { label: item.textContent, ok: false, why: '标题不一致：' + text };
    for(let p = sec.parentElement; p && p !== page; p = p.parentElement){
      if(p.tagName === 'SECTION') return { label: item.textContent, ok: false, why: '该项是嵌套 section' };
    }
    return { label: item.textContent, ok: true, why: '' };
  });
};

async function switchTab(page, name){
  await page.click('#btnNav' + name[0].toUpperCase() + name.slice(1));
  await page.waitForTimeout(700);   // 去抖 200ms + 面板自己加载数据
}

async function main(){
  const args = parseArgs(process.argv.slice(2), {});
  const url = args.url || process.env.PANEL_URL;
  const password = args.password || process.env.PANEL_PASSWORD;
  if(!url) throw new Error('缺少面板地址：用 --url 或环境变量 PANEL_URL');
  if(!password) throw new Error('缺少面板密码：用 --password 或环境变量 PANEL_PASSWORD');

  const chrome = findChrome(args.chrome);
  if(!chrome) throw new Error('找不到 Chromium：用 --chrome <路径> 或 CHROME_PATH 指定');
  const { chromium } = await loadPlaywright();

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // 按用户脚本的方式在页面脚本之前注入
  await page.addInitScript({ path: USERSCRIPT });
  await page.goto(url.replace(/\/+$/, '') + '/?tab=gateway', { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  console.log('\n面板：' + url);
  console.log('浏览器：' + chrome + '\n');

  /* 0. 登录闸门（闸门是异步弹的：面板要先问一次 /settings 才知道要不要登录） */
  const gateVisible = () => page.evaluate(() => {
    const gate = document.getElementById('panelGate');
    return !!gate && getComputedStyle(gate).display !== 'none';
  });
  let gateShown = false;
  for(let i = 0; i < 16; i++){
    gateShown = await gateVisible();
    if(gateShown) break;
    await page.waitForTimeout(500);
  }
  if(gateShown){
    await page.fill('#panelPwdInput', password);
    await page.evaluate(() => submitPanelLogin());
    await page.waitForTimeout(3000);
  }
  const loggedIn = await page.evaluate(() => {
    const gate = document.getElementById('panelGate');
    const token = sessionStorage.getItem('wb-proxy-panel-token');
    return { gateVisible: !!gate && getComputedStyle(gate).display !== 'none', token: !!token };
  });
  check('已登录面板（闸门关闭 / 拿到面板 token）', !loggedIn.gateVisible || loggedIn.token, JSON.stringify(loggedIn));

  /* 1. 面板自带侧栏的现状：部署版应当已经不再提供它 */
  const native = await page.evaluate(() => {
    const el = document.querySelector('.page-sidebar');
    return {
      exists: !!el,
      visible: !!el && getComputedStyle(el).display !== 'none',
      initPageNavStubbed: /function initPageNav\(page\)\{\s*return;/.test(document.documentElement.innerHTML),
    };
  });
  check('面板自带的 .page-sidebar 不可见（脚本可以接管）', !native.visible, JSON.stringify(native));
  console.log('        面板自带侧栏：' + (native.exists ? '元素存在但隐藏' : '元素不存在') +
    '，initPageNav 空壳=' + native.initPageNavStubbed);

  /* 2. 网关页：接管 + 清单健全性 + 完整性 */
  let s = await page.evaluate(SIDEBAR_STATE);
  console.log('        网关页导航：' + JSON.stringify(s.labels));
  check('网关页生成了侧栏', s.hasSidebar && s.on, JSON.stringify(s));
  check('导航项 ≥2 且含回到顶部与收起按钮',
    s.labels.length >= 2 && s.hasTop && s.hasToggle, JSON.stringify({ n: s.labels.length, top: s.hasTop, toggle: s.hasToggle }));
  check('默认高亮第一项', s.active === s.labels[0], 'active=' + s.active);

  const sound = await page.evaluate(SOUNDNESS);
  const bad = sound.filter(x => !x.ok);
  check('每个导航项都指向真实顶层区块且标题一致', bad.length === 0, JSON.stringify(bad));

  const eligible = await page.evaluate(ELIGIBLE);
  check('页面内可导航区块一个不漏', eq(eligible, s.labels),
    '页面里有=' + JSON.stringify(eligible) + ' 导航里=' + JSON.stringify(s.labels));

  await page.screenshot({ path: path.join(SHOTS, 'live-01-gateway.png') });

  /* 3. 点击跳转 */
  if(s.labels.length >= 2){
    const second = s.labels[1];
    await page.click(`.main-page.active .wbpn-item:text-is("${second}")`);
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => {
      const item = document.querySelector('.main-page.active .wbpn-item.active');
      const sec = item && document.getElementById(item.dataset.target);
      const header = document.querySelector('header');
      return {
        active: item ? item.textContent : null,
        top: sec ? Math.round(sec.getBoundingClientRect().top) : null,
        offset: (header ? header.offsetHeight : 64) + 14,
        scrollY: Math.round(window.scrollY),
        maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        hash: location.hash,
      };
    });
    check('点击后高亮切到被点的项', after.active === second, 'active=' + after.active);
    const nearTop = after.top !== null && after.top >= -4 && after.top <= after.offset + 60;
    const atBottom = after.maxScroll > 0 && after.scrollY >= after.maxScroll - 4;
    check('点击后该区块滚到吸顶线附近', nearTop || atBottom,
      'top=' + after.top + ' offset=' + after.offset + ' scrollY=' + after.scrollY + '/' + after.maxScroll);
    check('点击后 URL 锚点指向该区块', /^#wbpn-sec-/.test(after.hash), after.hash);
  }

  /* 4. 滚动高亮（压矮视口保证真能滚） */
  await page.setViewportSize({ width: 1440, height: 360 });
  await page.waitForTimeout(300);
  const scrollable = await page.evaluate(() =>
    Math.round(document.documentElement.scrollHeight - window.innerHeight));
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }));
  await page.waitForTimeout(300);
  s = await page.evaluate(SIDEBAR_STATE);
  check('滚到底时高亮最后一项', s.active === s.labels[s.labels.length - 1],
    'active=' + s.active + ' 可滚距离=' + scrollable);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  /* 5. 回到顶部 */
  await page.click('.main-page.active button.wbpn-top');
  await page.waitForTimeout(900);
  const topState = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    active: (document.querySelector('.main-page.active .wbpn-item.active') || {}).textContent || null,
    hash: location.hash,
  }));
  check('回到顶部把页面滚到 0', topState.y === 0, 'scrollY=' + topState.y);
  check('回到顶部后高亮回到第一项并清锚点', topState.active === s.labels[0] && topState.hash === '',
    JSON.stringify(topState));

  /* 6. 收起 */
  await page.click('.main-page.active button.wbpn-toggle');
  await page.waitForTimeout(200);
  s = await page.evaluate(SIDEBAR_STATE);
  check('收起后压成细轨且清单隐藏',
    s.collapsed && s.sidebarWidth > 0 && s.sidebarWidth < 80 && !s.navVisible, JSON.stringify(s));
  await page.screenshot({ path: path.join(SHOTS, 'live-02-collapsed.png') });
  await page.click('.main-page.active button.wbpn-toggle');
  await page.waitForTimeout(200);
  s = await page.evaluate(SIDEBAR_STATE);
  check('再点一次可展开', !s.collapsed && s.navVisible && s.sidebarWidth > 100, JSON.stringify(s));

  /* 7. 逐页切换：每页各按自己的区块重建；区块不足两项的页面不给侧栏 */
  for(const tab of TABS){
    await switchTab(page, tab);
    s = await page.evaluate(SIDEBAR_STATE);
    const want = await page.evaluate(ELIGIBLE);
    console.log('        ' + tab + '：' + JSON.stringify(s.labels));
    if(want.length >= 2){
      check('切到 ' + tab + '：侧栏存在且清单与页面区块一致',
        s.hasSidebar && s.on && eq(s.labels, want),
        'has=' + s.hasSidebar + ' 导航=' + JSON.stringify(s.labels) + ' 页面=' + JSON.stringify(want));
    } else {
      check('切到 ' + tab + '：区块不足两项，不给侧栏', !s.hasSidebar && !s.on, JSON.stringify(s));
    }
  }
  await switchTab(page, 'settings');
  await page.screenshot({ path: path.join(SHOTS, 'live-03-settings.png') });

  /* 8. 轮询不打断：面板每几秒重建表格，等一轮看侧栏还在、高亮没被抖回第一项 */
  await switchTab(page, 'gateway');
  const before = await page.evaluate(SIDEBAR_STATE);
  await page.waitForTimeout(12000);
  const afterPoll = await page.evaluate(SIDEBAR_STATE);
  check('面板轮询一轮后侧栏仍在且清单不变',
    afterPoll.hasSidebar && eq(afterPoll.labels, before.labels),
    JSON.stringify({ before: before.labels, after: afterPoll.labels }));
  const wraps = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.main-page')).map(p => p.querySelectorAll(':scope > .wbpn-body').length));
  check('每页最多包一层内容容器（轮询未造成重复包裹）', wraps.every(n => n <= 1), JSON.stringify(wraps));

  /* 9. 脚本自身报错 */
  const scriptErrors = pageErrors.filter(m => /wb2api-hub-sidebar-nav|wbpn/.test(m));
  check('脚本自身没有抛错', scriptErrors.length === 0, JSON.stringify(scriptErrors));

  await browser.close();

  const failed = report();
  console.log('截图：' + SHOTS);
  if(pageErrors.length) console.log('（页面自身报错 ' + pageErrors.length + ' 条，仅记录）');
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('\n运行失败：' + (e && e.stack || e)); process.exit(2); });
