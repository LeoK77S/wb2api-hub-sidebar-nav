/*
 * 对 wb2api-hub-sidebar-nav.user.js 的无头验收。
 *
 * 用真实浏览器（Playwright/Chromium）加载一块面板页面，把油猴脚本按
 * 「用户脚本」的方式在页面脚本之前注入，然后逐条断言侧栏的行为契约。
 *
 * 用法：
 *   node verify/verify.mjs                  # 跑离线夹具（verify/fixture.html）
 *   node verify/verify.mjs --page real      # 跑上游真实 dashboard.html（联网拉取）
 *   node verify/verify.mjs --page <路径>     # 跑指定的 dashboard.html
 *
 * 想在你自己已经跑起来的面板上验，用 verify-live.mjs。
 * 依赖与浏览器解析规则见 lib.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE, SHOTS, USERSCRIPT, VIEWPORT,
  eq, parseArgs, findChrome, loadPlaywright, makeChecker, serve, dismissGate, SIDEBAR_STATE,
} from './lib.mjs';

// 上游 main 的固定提交：保证「跑的是哪一版面板」可复现
const REAL_URL = 'https://raw.githubusercontent.com/ardeyouxipianyi/workbuddy2api-hub/'
  + '5a04d08/dashboard.html';

/* 各页面应有的导航项 —— 由页面 HTML 静态数出来的，不是脚本自己算的，
   所以能真正发现「少一项 / 多一项 / 标题带状态数字」这类错。 */
const EXPECT = {
  real: {
    gateway: ['账号', '当前禁用账号与模型', '最近请求', '当前版本模型库与能力清单'],
    analytics: ['Token 时序', '积分扣减历史', '各账号用量透视与模型消耗分布', '按 API Key 的消耗归属', '模型性能指标与用量一览'],
    settings: ['面板访问密码', 'API Key 与出口绑定', '代理槽', '限额', 'OpenRouter 价估算',
      '429 自动切换出站身分', '国际版每日活跃打卡', '本地网络工具 (web_search / web_fetch)', '运行信息'],
    logs: [],
  },
  fixture: {
    gateway: ['账号', '最近请求', '模型清单'],
    analytics: ['Token 时序', '积分扣减历史'],
    settings: ['面板访问密码', 'API Key 与出口绑定', '代理槽', '限额', '运行信息'],
    logs: [],
  },
};

const { check, report, results } = makeChecker();



async function fetchReal(){
  const cached = path.join(SHOTS, 'dashboard-upstream.html');
  if(fs.existsSync(cached)) return cached;
  console.log('拉取上游 dashboard.html（' + REAL_URL + '）…');
  const res = await fetch(REAL_URL, { redirect: 'follow' });
  if(!res.ok) throw new Error('拉取失败 HTTP ' + res.status);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(cached, await res.text());
  return cached;
}

async function switchTab(page, name){
  await page.click('#btnNav' + name[0].toUpperCase() + name.slice(1));
  await page.waitForTimeout(400);   // 让 MutationObserver 的 200ms 去抖跑完
}

async function clickNav(page, label){
  await page.click(`.main-page.active .wbpn-item:text-is("${label}")`);
  await page.waitForTimeout(900);   // 平滑滚动 + 抑制窗口
}

/* ---- 主流程 ---- */

async function main(){
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(SHOTS, { recursive: true });

  let targetPath, kind;
  if(args.page === 'fixture'){ targetPath = FIXTURE; kind = 'fixture'; }
  else if(args.page === 'real'){ targetPath = await fetchReal(); kind = 'real'; }
  else { targetPath = path.resolve(args.page); kind = 'real'; }
  if(!fs.existsSync(targetPath)) throw new Error('页面不存在：' + targetPath);

  const chrome = findChrome(args.chrome);
  if(!chrome) throw new Error('找不到 Chromium：用 --chrome <路径> 或 CHROME_PATH 指定');
  const { chromium } = await loadPlaywright();

  const { server, port } = await serve({ '/page.html': targetPath, '/fixture.html': FIXTURE });
  const url = 'http://127.0.0.1:' + port + '/page.html';

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // 关键：在页面任何脚本之前注入，模拟油猴的 @run-at document-idle
  await page.addInitScript({ path: USERSCRIPT });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  // 真实面板在没有后端时会弹出「面板密码」遮罩，会挡住所有点击，压掉它
  // （刷新后要重新压一次，见 lib.mjs 的 dismissGate）
  await dismissGate(page);

  console.log('\n页面：' + targetPath);
  console.log('模式：' + kind + '，浏览器：' + chrome + '\n');

  const expected = EXPECT[kind];

  /* 1. 网关页：侧栏存在、清单正确、标题已剔除状态 <em> */
  let s = await page.evaluate(SIDEBAR_STATE);
  check('网关页生成了侧栏', s.hasSidebar && s.on, JSON.stringify(s));
  check('网关页导航项与预期一致', eq(s.labels, expected.gateway),
    'got=' + JSON.stringify(s.labels) + ' want=' + JSON.stringify(expected.gateway));
  check('导航项标题不含状态 <em> 内容', !s.labels.some(l => /[()（）]\s*\d/.test(l)), JSON.stringify(s.labels));
  check('侧栏含「回到顶部」按钮', s.hasTop);
  check('侧栏含收起按钮', s.hasToggle);
  check('侧栏已占宽（非 0）', s.sidebarWidth > 100, s.sidebarWidth + 'px');
  check('默认高亮第一项', s.active === expected.gateway[0], 'active=' + s.active);

  await page.screenshot({ path: path.join(SHOTS, '01-gateway.png') });

  /* 2. 点击导航项：滚到该区块并把高亮交给它 */
  const second = expected.gateway[1];
  await clickNav(page, second);
  let after = await page.evaluate(() => {
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
  await page.screenshot({ path: path.join(SHOTS, '02-clicked.png') });

  /* 3. 滚动高亮：滚到更靠后的区块，高亮应跟着走。
     先把视口压矮，保证页面真的能滚（无后端时真实面板内容很短，滚不动就
     不会有 scroll 事件，这一项会假失败）。 */
  const last = expected.gateway[expected.gateway.length - 1];
  await page.setViewportSize({ width: VIEWPORT.width, height: 360 });
  await page.waitForTimeout(300);
  const scrollable = await page.evaluate(() =>
    Math.round(document.documentElement.scrollHeight - window.innerHeight));
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }));
  await page.waitForTimeout(300);
  s = await page.evaluate(SIDEBAR_STATE);
  check('滚到底时高亮最后一项', s.active === last,
    'active=' + s.active + ' want=' + last + ' 可滚距离=' + scrollable);
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(300);

  /* 4. 回到顶部 */
  await page.click('.main-page.active button.wbpn-top');
  await page.waitForTimeout(900);
  const topState = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    active: (document.querySelector('.main-page.active .wbpn-item.active') || {}).textContent || null,
    hash: location.hash,
  }));
  check('回到顶部把页面滚到 0', topState.y === 0, 'scrollY=' + topState.y);
  check('回到顶部后高亮回到第一项', topState.active === expected.gateway[0], 'active=' + topState.active);
  check('回到顶部后清掉 URL 锚点', topState.hash === '', topState.hash);

  /* 5. 收起：压成细轨、清单隐藏，且刷新后仍保持 */
  await page.click('.main-page.active button.wbpn-toggle');
  await page.waitForTimeout(150);
  s = await page.evaluate(SIDEBAR_STATE);
  check('收起后页面带上 collapsed 类', s.collapsed);
  check('收起后侧栏压成细轨（<80px）', s.sidebarWidth > 0 && s.sidebarWidth < 80, s.sidebarWidth + 'px');
  check('收起后导航清单隐藏', !s.navVisible);
  await page.screenshot({ path: path.join(SHOTS, '03-collapsed.png') });

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  await dismissGate(page);
  s = await page.evaluate(SIDEBAR_STATE);
  check('刷新后仍保持收起', s.collapsed && !s.navVisible, JSON.stringify({ collapsed: s.collapsed, navVisible: s.navVisible }));

  await page.click('.main-page.active button.wbpn-toggle');
  await page.waitForTimeout(150);
  s = await page.evaluate(SIDEBAR_STATE);
  check('再点一次可展开', !s.collapsed && s.navVisible && s.sidebarWidth > 100, JSON.stringify(s));

  /* 6. 切标签页：每页各按自己的区块重建，单区块页不给侧栏 */
  for(const tab of ['analytics', 'settings', 'logs', 'gateway']){
    await switchTab(page, tab);
    s = await page.evaluate(SIDEBAR_STATE);
    const want = expected[tab];
    if(want.length >= 2){
      check('切到 ' + tab + '：侧栏清单正确', s.hasSidebar && eq(s.labels, want),
        'has=' + s.hasSidebar + ' got=' + JSON.stringify(s.labels) + ' want=' + JSON.stringify(want));
    } else {
      check('切到 ' + tab + '：区块不足两项，不给侧栏', !s.hasSidebar && !s.on, JSON.stringify(s));
    }
  }
  await switchTab(page, 'settings');
  await page.screenshot({ path: path.join(SHOTS, '04-settings.png'), fullPage: false });

  /* 7. 非当前页不该被改动（切回网关页仍是原样，没有重复包一层） */
  await switchTab(page, 'gateway');
  const wraps = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.main-page')).map(p => p.querySelectorAll(':scope > .wbpn-body').length));
  check('每页最多包一层内容容器（无重复包裹）', wraps.every(n => n <= 1), JSON.stringify(wraps));
  const sbs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.main-page')).map(p => p.querySelectorAll(':scope > .wbpn-sidebar').length));
  check('每页最多一个侧栏', sbs.every(n => n <= 1), JSON.stringify(sbs));

  /* 8. 让位：面板自己那条侧栏还活着时，本脚本必须退出并撤掉自己包的那层，
        不能同页出现两条侧栏。真实面板把 .page-sidebar 设成 display:none!important，
        所以这里给假侧栏一个 ID 规则把它的可见性顶回来。 */
  await page.addStyleTag({ content: '#wbpnFakeNative{display:block!important}' });
  await page.evaluate(() => {
    const page = document.querySelector('.main-page.active');
    const fake = document.createElement('aside');
    fake.id = 'wbpnFakeNative';
    fake.className = 'page-sidebar';
    const btn = document.createElement('button');
    btn.className = 'page-nav-item';
    btn.textContent = '面板自带的项';
    fake.appendChild(btn);
    page.insertBefore(fake, page.firstChild);
  });
  await page.waitForTimeout(500);
  const standDown = await page.evaluate(() => {
    const page = document.querySelector('.main-page.active');
    return {
      fakeVisible: getComputedStyle(document.getElementById('wbpnFakeNative')).display !== 'none',
      ownSidebars: page.querySelectorAll(':scope > .wbpn-sidebar').length,
      on: page.classList.contains('wbpn-on'),
      ownBodies: page.querySelectorAll(':scope > .wbpn-body').length,
    };
  });
  check('面板自带侧栏可用时脚本让位（不留自己的侧栏）',
    standDown.fakeVisible && standDown.ownSidebars === 0 && !standDown.on, JSON.stringify(standDown));
  check('让位时撤掉自己包的内容容器', standDown.ownBodies === 0, JSON.stringify(standDown));

  await page.evaluate(() => document.getElementById('wbpnFakeNative').remove());
  await page.waitForTimeout(500);
  s = await page.evaluate(SIDEBAR_STATE);
  check('自带侧栏消失后脚本重新接管', s.hasSidebar && s.on && eq(s.labels, expected.gateway), JSON.stringify(s));

  /* 9. 窄屏回退：横向胶囊行 */
  await page.setViewportSize({ width: 760, height: 900 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => {
    const sb = document.querySelector('.main-page.active .wbpn-sidebar');
    const nav = sb && sb.querySelector('.wbpn-nav');
    return {
      hasSidebar: !!sb,
      flexDir: nav ? getComputedStyle(nav).flexDirection : null,
      fullWidth: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
      pageWidth: Math.round(document.querySelector('.main-page.active').getBoundingClientRect().width),
    };
  });
  check('窄屏下导航变横向胶囊行', narrow.hasSidebar && narrow.flexDir === 'row', JSON.stringify(narrow));
  check('窄屏下侧栏铺满内容宽', narrow.fullWidth >= narrow.pageWidth - 2, JSON.stringify(narrow));
  await page.screenshot({ path: path.join(SHOTS, '05-narrow.png') });
  await page.setViewportSize(VIEWPORT);

  /* 10. 脚本自身的报错 */
  const scriptErrors = pageErrors.filter(m => /wb2api-hub-sidebar-nav|wbpn/.test(m));
  check('脚本自身没有抛错', scriptErrors.length === 0, JSON.stringify(scriptErrors));

  await browser.close();
  server.close();

  const failed = report();
  console.log('截图：' + SHOTS);
  if(pageErrors.length) console.log('（页面自身报错 ' + pageErrors.length + ' 条，多因无后端接口，仅记录）');
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('\n运行失败：' + (e && e.stack || e)); process.exit(2); });
