/* 导航与路由 */
(function () {
  'use strict';
  const U = window.UI, h = U.h, add = U.add, CH = window.CHAPTERS;
  const toc = document.getElementById('toc'), main = document.getElementById('main');
  const current = () => { const id = (location.hash || '').replace('#', ''); return CH.find((c) => c.id === id) || CH[0]; };
  function drawToc() {
    const cur = current(); toc.textContent = '';
    add(toc, [h('div', { class: 'brand' }, 'RocksDB LSM 交互教程'), h('div', { class: 'sub' }, '10 章 · 可运行的引擎 · 对照 11.x 源码')]);
    for (const c of CH) add(toc, h('a', { href: '#' + c.id, class: c === cur ? 'on' : '' }, h('span', { class: 'n' }, c.n), h('span', null, c.title), c.quizN && U.quizDone(c.id, c.quizN) ? h('span', { class: 'ok', title: '自测已完成' }, '✓') : null));
  }
  function render() {
    const cur = current(), i = CH.indexOf(cur); main.textContent = '';
    const art = h('article', null, h('h1', null, (cur.n === '★' ? '' : `第 ${cur.n} 章 `) + cur.title));
    add(main, art);
    try { cur.render(art); } catch (e) { add(art, h('pre', null, '渲染出错：' + (e && e.stack ? e.stack : e))); }
    add(art, h('div', { class: 'pager' }, i > 0 ? h('a', { href: '#' + CH[i - 1].id }, '← ' + CH[i - 1].title) : h('span'), i < CH.length - 1 ? h('a', { href: '#' + CH[i + 1].id }, CH[i + 1].title + ' →') : h('span')));
    drawToc(); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('lsm-progress', drawToc);
  render();
})();
