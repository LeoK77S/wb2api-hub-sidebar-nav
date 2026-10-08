// ==UserScript==
// @name         wb2api-hub 面板侧栏导航
// @name:en      wb2api-hub Panel Section Sidebar
// @namespace    https://github.com/LeoK77S/wb2api-hub-sidebar-nav
// @version      1.0.0
// @description  为 workbuddy2api-hub 面板恢复「本页区块导航」侧栏：按页面内的区块现场生成导航、滚动高亮、回到顶部、可收起。纯前端注入，不改动面板本体。
// @description:en  Restore the per-page section sidebar for the workbuddy2api-hub dashboard: auto-generated nav, scroll spy, back-to-top, collapsible.
// @author       LeoK77S
// @homepageURL  https://github.com/LeoK77S/wb2api-hub-sidebar-nav
// @supportURL   https://github.com/LeoK77S/wb2api-hub-sidebar-nav/issues
// @license      MIT
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 上游 v1.6.16 之后的提交把面板自带的侧栏导航停用了（initPageNav 变成空壳、
 * .page-sidebar 被 display:none 隐藏）。这个脚本在浏览器侧把它装回来，
 * 不改面板本体的任何文件。
 *
 * 与面板原实现的区别只有命名空间：面板用 .page-sidebar / .page-nav-*，
 * 这里一律用 .wbpn-*，因此面板将来把这些类名删掉、复用或改语义都不会互相干扰。
 *
 * @match 写得比较宽（所有站点），真正的开关是下面的 isHubPanel()：
 * 只有页面里同时存在多个 .main-page 与一个 <header> 才动手。想收窄范围，
 * 改 @match 那一行即可（例如只留你自己的面板地址）。
 */
(function(){
  'use strict';

  /* ---- 配置 ---- */

  const TOP_VAR = '--wbpn-top';           // 吸顶偏移量，写进 :root
  const COLLAPSE_KEY = 'wbpn-collapsed';  // 收起状态，跨页面跨刷新共用
  const MIN_SECTIONS = 2;                 // 少于两项就不给侧栏：白占一列
  const BIND_FLAG = '__wbpnBound';        // 全局事件只绑一次
  const OBSERVE_FLAG = '__wbpnObserved';
  /* 面板把内容区卡在 max-width:1280px。侧栏要占掉 196px 一列，内容列就只剩
     ~974px，而面板里最宽的表（账号表）最小内容宽约 1050px —— 于是表格冒出横向
     滚动条，右侧几列被藏起来。侧栏在场时把上限放松到能容下最宽的表即可：
     1050(表) + 48(main 左右内边距) + 196(侧栏) + 20(栏间距) ≈ 1314，留足余量取 1800。
     侧栏不在场时不碰这个上限，页面保持面板原样。 */
  const WIDE_MAX = '1800px';

  const C = {
    on: 'wbpn-on',
    collapsed: 'wbpn-collapsed',
    body: 'wbpn-body',
    wide: 'wbpn-wide',
    sidebar: 'wbpn-sidebar',
    head: 'wbpn-head',
    title: 'wbpn-title',
    toggle: 'wbpn-toggle',
    top: 'wbpn-top',
    nav: 'wbpn-nav',
    item: 'wbpn-item',
    flash: 'wbpn-flash',
  };

  /* ---- 样式 ---- */
  /* 只依赖面板的 CSS 变量（--panel/--line/--fg 等），且都给了兜底值，
     所以面板换主题或删掉这些变量都不会让侧栏变成透明方块。 */
  const CSS = `
/* 侧栏在场时放松内容区宽度上限，免得内容被挤到出横向滚动条（见 WIDE_MAX 注释）。
   用 !important 是因为这条是刻意覆盖宿主面板的布局约束，而面板换写法就可能
   把权重抬到我们之上。 */
main.${C.wide}{max-width:${WIDE_MAX}!important}
.main-page.${C.on}.active{display:grid;grid-template-columns:196px minmax(0,1fr);gap:20px;align-items:start}
.main-page.${C.on} > *{grid-column:2;min-width:0}
.main-page.${C.on} > .${C.sidebar}{grid-column:1;grid-row:1 / -1;position:sticky;
  top:var(${TOP_VAR},84px);z-index:6;background:var(--panel,#111827);border:1px solid var(--line,#1f293d);
  border-radius:14px;padding:10px;box-shadow:var(--shadow,0 1px 3px rgba(0,0,0,.3));
  max-height:calc(100vh - var(${TOP_VAR},84px) - 20px);overflow:auto}
.${C.head}{display:flex;align-items:center;justify-content:space-between;gap:6px}
/* 面板往往有一条全局的 button{background:var(--accent);box-shadow:...} 与
   button:hover{border-color:...}。那套样式是为面板自己的实心按钮写的，会漏进
   侧栏这几个透明按钮（悬停时莫名多一圈强调色描边、无端带一层阴影）。这里把
   它挡掉，侧栏按钮的外观只由本文件决定，换个面板也不会变样。 */
.${C.sidebar} button{box-shadow:none;font:inherit}
.${C.title}{font-size:11px;font-weight:700;color:var(--dim,#94a3b8);text-transform:uppercase;
  letter-spacing:.6px;padding:6px 10px 8px}
.${C.toggle}{appearance:none;flex:0 0 auto;width:22px;height:22px;padding:0;
  display:inline-flex;align-items:center;justify-content:center;border-radius:6px;
  border:1px solid var(--line,#1f293d);background:var(--panel2,#1e293b);color:var(--dim,#94a3b8);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:all .15s ease}
.${C.toggle}:hover{color:var(--fg,#f1f5f9);border-color:var(--line-hover,#334155)}
.${C.top}{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;
  margin-bottom:8px;padding:7px 10px;border-radius:8px;font-size:12px;font-weight:600;
  background:var(--panel2,#1e293b);border:1px solid var(--line,#1f293d);color:var(--fg,#f1f5f9);
  font-family:inherit;cursor:pointer;transition:all .15s ease}
.${C.top}:hover{background:var(--panel2,#1e293b);border-color:var(--accent,#3b82f6);color:var(--accent,#3b82f6)}
.${C.nav}{display:flex;flex-direction:column;gap:2px}
.${C.item}{appearance:none;background:transparent;border:1px solid transparent;color:var(--dim,#94a3b8);
  text-align:left;padding:8px 10px;border-radius:8px;font:inherit;font-size:13px;line-height:1.35;
  cursor:pointer;transition:all .15s ease;overflow-wrap:anywhere}
.${C.item}:hover{color:var(--fg,#f1f5f9);background:var(--panel2,#1e293b);border-color:var(--accent,#3b82f6)}
.${C.item}.active{color:var(--fg,#f1f5f9);background:var(--panel2,#1e293b);border-color:var(--line,#1f293d);font-weight:600}
/* 收起：整列压成一条细轨，只留展开按钮。窄屏导航本来就是一条横栏，没得收。 */
@media (min-width:861px){
  .main-page.${C.on}.${C.collapsed}.active{grid-template-columns:44px minmax(0,1fr);gap:12px}
  .main-page.${C.on}.${C.collapsed} > .${C.sidebar}{padding:6px 4px;overflow:hidden}
  .main-page.${C.on}.${C.collapsed} .${C.title},
  .main-page.${C.on}.${C.collapsed} .${C.nav},
  .main-page.${C.on}.${C.collapsed} .${C.top}{display:none}
  .main-page.${C.on}.${C.collapsed} .${C.head}{justify-content:center;padding:0}
}
.main-page.${C.on} section{scroll-margin-top:var(${TOP_VAR},84px)}
.main-page.${C.on} section.${C.flash}{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
@media (max-width:860px){
  .main-page.${C.on}.active{grid-template-columns:minmax(0,1fr);gap:14px}
  .main-page.${C.on} > *{grid-column:1}
  .main-page.${C.on} > .${C.sidebar}{grid-row:auto;max-height:none;overflow:visible;padding:8px;
    border-radius:12px;background:var(--header-bg,var(--panel,#111827));
    display:flex;align-items:center;gap:8px}
  .${C.title}{display:none}
  .${C.head}{display:none}
  .${C.nav}{flex:1 1 auto;min-width:0;flex-direction:row;gap:6px;overflow-x:auto;
    -webkit-overflow-scrolling:touch;padding-bottom:2px;scrollbar-width:thin}
  .${C.item}{white-space:nowrap;padding:7px 12px;border-radius:999px;
    background:var(--panel2,#1e293b);border-color:var(--line,#1f293d)}
  .${C.top}{width:auto;flex:0 0 auto;margin-bottom:0;padding:7px 12px;border-radius:999px;white-space:nowrap}
}
`;

  /* ---- 运行期状态 ---- */
  let lockUntil = 0;      // 平滑滚动期间抑制滚动高亮
  let timer = 0;
  let lastActivePage = null;

  /* ---- 只在这块面板上动手 ---- */
  function isHubPanel(){
    return document.querySelectorAll('.main-page').length >= 2 && !!document.querySelector('header');
  }

  function injectStyle(){
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---- 区块清单 ---- */

  /* 参与导航的区块：页面内最外层的 section（嵌套的 section 属于父区块的内容，
     不单独成项），自身没被 display:none 隐藏，且带 h2 标题。判据用 computed
     display 而不是 offsetParent —— 后者在整页隐藏（切到别的标签页）时会把所有
     区块都判成不可见，导航会整个空掉。 */
  function sectionsOf(page){
    if(!page) return [];
    return Array.from(page.querySelectorAll('section')).filter(function(sec){
      if(getComputedStyle(sec).display === 'none') return false;
      if(!sec.querySelector('h2')) return false;
      for(let p = sec.parentElement; p && p !== page; p = p.parentElement){
        if(p.tagName === 'SECTION') return false;
      }
      return true;
    });
  }

  function labelOf(section, index){
    const h2 = section.querySelector('h2');
    if(h2){
      const clone = h2.cloneNode(true);
      clone.querySelectorAll('em').forEach(el => el.remove());  // <em> 是状态标记，不是标题
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if(text) return text;
    }
    return '未命名区块 ' + (index + 1);
  }

  /* 由标题内容导出稳定 id：与区块顺序无关，链接可以长期复用 */
  function anchorId(label, taken){
    let hash = 5381;
    for(let i = 0; i < label.length; i++) hash = ((hash << 5) + hash + label.charCodeAt(i)) >>> 0;
    const base = 'wbpn-sec-' + hash.toString(36);
    let id = base, n = 2;
    while(taken.has(id)) id = base + '-' + (n++);
    return id;
  }

  /* 区块清单的指纹：只有它变了才重建导航，免得面板轮询重建表格时把高亮抖掉 */
  function signatureOf(page){
    return sectionsOf(page).map(function(sec, i){ return labelOf(sec, i); }).join('\u0001');
  }

  /* ---- 定位与高亮 ---- */

  /* 跳转时要让开的距离：吸顶 header，窄屏下再加上同样吸顶的导航条本身 */
  function headerOffset(page){
    const header = document.querySelector('header');
    const base = (header ? header.offsetHeight : 64) + 14;
    const sidebar = page ? page.querySelector('.' + C.sidebar) : null;
    if(sidebar && window.matchMedia('(max-width:860px)').matches){
      return base + sidebar.offsetHeight + 10;
    }
    return base;
  }

  function syncOffset(){
    const header = document.querySelector('header');
    const top = (header ? header.offsetHeight : 64) + 14;
    document.documentElement.style.setProperty(TOP_VAR, top + 'px');
  }

  function setActive(page, id){
    const nav = page ? page.querySelector('.' + C.nav) : null;
    if(!nav) return;
    nav.querySelectorAll('.' + C.item).forEach(function(item){
      item.classList.toggle('active', !!id && item.dataset.target === id);
    });
  }

  function scrollToSection(page, id, smooth){
    const section = document.getElementById(id);
    if(!section) return;
    const top = section.getBoundingClientRect().top + window.pageYOffset - headerOffset(page);
    window.scrollTo({ top: Math.max(0, top), behavior: smooth === false ? 'auto' : 'smooth' });
    setActive(page, id);
    lockUntil = Date.now() + 700;
    section.classList.add(C.flash);
    setTimeout(() => section.classList.remove(C.flash), 900);
    try {
      const url = new URL(window.location.href);
      url.hash = id;
      history.replaceState(null, '', url.toString());
    } catch(e){}
  }

  function scrollToTop(page){
    window.scrollTo({ top: 0, behavior: 'smooth' });
    lockUntil = Date.now() + 700;
    const first = page ? page.querySelector('.' + C.item) : null;
    if(first) setActive(page, first.dataset.target);
    try {
      const url = new URL(window.location.href);
      history.replaceState(null, '', url.pathname + url.search);
    } catch(e){}
  }

  function spy(){
    if(Date.now() < lockUntil) return;
    const page = document.querySelector('.main-page.active.' + C.on);
    if(!page) return;
    const nav = page.querySelector('.' + C.nav);
    if(!nav) return;
    const items = Array.from(nav.querySelectorAll('.' + C.item));
    if(!items.length) return;
    const threshold = headerOffset(page) + 8;
    let activeId = items[0].dataset.target;
    for(const item of items){
      const section = document.getElementById(item.dataset.target);
      if(!section) continue;
      if(section.getBoundingClientRect().top - threshold <= 0) activeId = item.dataset.target;
      else break;
    }
    // 滚到底时高亮最后一项，否则末尾区块永远点不亮
    if(window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4){
      activeId = items[items.length - 1].dataset.target;
    }
    setActive(page, activeId);
  }

  /* 滚动高亮：滚动事件本身已按帧节流，这里不再叠一层 requestAnimationFrame
     （后台标签页会挂起 rAF，反而让高亮停在旧位置）。 */
  function onScroll(){ spy(); }

  /* ---- 收起 ---- */

  function collapsedPref(){
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch(e){ return false; }
  }

  function applyCollapse(page, collapsed){
    if(!page) return;
    page.classList.toggle(C.collapsed, !!collapsed);
    const btn = page.querySelector('.' + C.toggle);
    if(!btn) return;
    const label = collapsed ? '展开本页导航' : '收起本页导航';
    btn.textContent = collapsed ? '\u00bb' : '\u00ab';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function toggleCollapse(page){
    const collapsed = !page.classList.contains(C.collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch(e){}
    applyCollapse(page, collapsed);
  }

  /* ---- 构建 ---- */

  /* 面板自己那条侧栏（.page-sidebar）还活着时，让位给面板本体：某些分支或旧版本
     里它仍可用，此时再插一条就是并排两条。上游现状是它被 display:none 隐藏，
     或者根本不生成，这两种情况才由本脚本接管。 */
  function nativeSidebarActive(page){
    const native = page.querySelector('.page-sidebar');
    if(!native) return false;
    if(getComputedStyle(native).display === 'none') return false;
    return !!native.querySelector('.page-nav-item');
  }

  /* 撤掉自己包的那层内容容器，把子节点还给页面本身 */
  function unwrap(page){
    const body = page.querySelector('.' + C.body);
    if(!body) return;
    Array.from(body.children).forEach(function(el){ page.insertBefore(el, body); });
    body.remove();
  }

  /* 侧栏在场时给内容容器加宽，撤走时还原（见 WIDE_MAX 注释） */
  function syncWide(page, wide){
    const main = page.closest('main') || page.parentElement;
    if(main) main.classList.toggle(C.wide, !!wide);
  }

  function standDown(page){
    const own = page.querySelector('.' + C.sidebar);
    if(own) own.remove();
    unwrap(page);
    page.classList.remove(C.on, C.collapsed);
    syncWide(page, false);
    delete page.dataset.wbpnSignature;
  }

  function init(page){
    if(!page) return;
    syncOffset();
    if(nativeSidebarActive(page)){ standDown(page); return; }
    const sections = sectionsOf(page);

    // 区块不足两项（例如日志页只有一个视图）就不给侧栏，页面保持单栏
    if(sections.length < MIN_SECTIONS){ standDown(page); return; }

    const signature = signatureOf(page);
    let sidebar = page.querySelector('.' + C.sidebar);
    // 清单没变就不动 DOM，保留现有高亮（加宽要先于这个早退，否则会漏掉）
    syncWide(page, true);
    if(sidebar && page.dataset.wbpnSignature === signature) return;

    const taken = new Set(Array.from(document.querySelectorAll('[id]')).map(el => el.id));
    const anchors = [];
    sections.forEach(function(section, i){
      const label = labelOf(section, i);
      let id = section.id;
      if(!id){
        id = anchorId(label, taken);
        section.id = id;
      }
      taken.add(id);
      anchors.push({ id: id, label: label });
    });

    // 重建时保留原来的高亮，别因为一次重建就闪回第一项
    const prevActive = sidebar ? sidebar.querySelector('.' + C.item + '.active') : null;
    const prevTarget = prevActive ? prevActive.dataset.target : null;

    // 内容整体包一层：grid 里只剩「侧栏 + 内容」两项，侧栏才跨得满整个内容区，
    // 区块之间的间距也不会被网格行间距再叠一次。
    let body = page.querySelector('.' + C.body);
    if(!body){
      body = document.createElement('div');
      body.className = C.body;
      Array.from(page.children).forEach(function(el){
        // 面板自己那条侧栏不能被卷进内容容器，否则它的两栏布局会塌成一栏
        if(el !== sidebar && !el.classList.contains('page-sidebar')) body.appendChild(el);
      });
      page.appendChild(body);
    }

    if(!sidebar){
      sidebar = document.createElement('aside');
      sidebar.className = C.sidebar;
      sidebar.setAttribute('aria-label', '本页区块导航');
      page.insertBefore(sidebar, page.firstChild);
    }
    sidebar.textContent = '';
    const head = document.createElement('div');
    head.className = C.head;
    const title = document.createElement('div');
    title.className = C.title;
    title.textContent = '本页导航';
    head.appendChild(title);
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = C.toggle;
    collapseBtn.addEventListener('click', function(){ toggleCollapse(page); });
    head.appendChild(collapseBtn);
    sidebar.appendChild(head);
    applyCollapse(page, collapsedPref());

    // 排在区块清单之外：它不是一个区块，不参与高亮与滚动侦测。
    const toTop = document.createElement('button');
    toTop.type = 'button';
    toTop.className = C.top;
    toTop.textContent = '\u2191 回到顶部';
    toTop.title = '回到顶部';
    toTop.addEventListener('click', function(){ scrollToTop(page); });
    sidebar.appendChild(toTop);

    const nav = document.createElement('nav');
    nav.className = C.nav;
    anchors.forEach(function(a){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = C.item;
      btn.dataset.target = a.id;
      btn.textContent = a.label;
      btn.title = a.label;
      btn.addEventListener('click', function(){ scrollToSection(page, a.id); });
      nav.appendChild(btn);
    });
    sidebar.appendChild(nav);

    page.classList.add(C.on);
    page.dataset.wbpnSignature = signature;

    if(!window[BIND_FLAG]){
      window[BIND_FLAG] = true;
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', function(){
        syncOffset();
        init(document.querySelector('.main-page.active'));
        onScroll();
      });
    }
    observe();
    const keep = prevTarget && anchors.some(function(a){ return a.id === prevTarget; });
    setActive(page, keep ? prevTarget : anchors[0].id);
    onScroll();
  }

  /* 区块在运行时可能增删或整块显隐（例如国内版的成长任务区块），让导航跟上。
     顺带把切换主标签页也接住：切页只是给 .main-page 换 .active，这里同样能看见。 */
  function refresh(){
    timer = 0;
    const page = document.querySelector('.main-page.active');
    if(page !== lastActivePage){
      lastActivePage = page;
      init(page);
      restoreHash();
      return;
    }
    init(page);
  }

  function observe(){
    if(window[OBSERVE_FLAG] || typeof MutationObserver === 'undefined') return;
    window[OBSERVE_FLAG] = true;
    const schedule = function(records){
      // 导航自身重建/改高亮引起的变更不必再算一遍，否则滚动时会自激
      if(records && records.every(function(r){
        const el = r.target;
        return el && el.closest && el.closest('.' + C.sidebar);
      })) return;
      if(timer) clearTimeout(timer);
      timer = setTimeout(refresh, 200);
    };
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
    });
  }

  /* 带 #锚点 打开时直接落到对应区块 */
  function restoreHash(){
    const page = document.querySelector('.main-page.active.' + C.on);
    if(!page) return;
    const id = (window.location.hash || '').slice(1);
    if(!id) return;
    // 被隐藏的区块不进导航，也不该作为锚点落点（否则会滚到一个不可见的位置）
    const navigable = sectionsOf(page).some(function(s){ return s.id === id; });
    if(navigable) scrollToSection(page, id, false);
  }

  /* ---- 启动 ---- */

  function start(){
    if(!isHubPanel()) return;
    injectStyle();
    lastActivePage = document.querySelector('.main-page.active');
    init(lastActivePage);
    observe();
    restoreHash();
    window.addEventListener('hashchange', restoreHash);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
