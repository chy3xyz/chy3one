/** OPC-OS 统一控制台 · 前端逻辑（零构建，无框架、无外部依赖）。模块：dom/toast/api/ui/helpers/router/面板/health */
(() => {
  'use strict';

  /* ===== dom ===== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** h('div', { class: 'x', onclick: fn }, ...children) */
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs || {})) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = String(val);
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, val === true ? '' : String(val));
    }
    for (const child of children.flat(2)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const num = v => (v === null || v === undefined || v === '' ? '—' : String(v));
  /** 市场金额（分）→ '¥x.xx'；空值/非法值显示 '—' */
  const money = cents => {
    const n = Number(cents);
    return (cents === null || cents === undefined || cents === '' || !Number.isFinite(n))
      ? '—' : `¥${(n / 100).toFixed(2)}`;
  };
  /** RaaS 计费金额（元）→ '¥x.xx' */
  const yuan = v => {
    const n = Number(v);
    return (v === null || v === undefined || v === '' || !Number.isFinite(n))
      ? '—' : `¥${n.toFixed(2)}`;
  };
  const fmtTime = ts => {
    if (ts === null || ts === undefined || ts === '') return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString('zh-CN', { hour12: false });
  };
  const safeJson = v => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  /** 清空容器并重新填充 */
  const render = (box, ...children) => { box.innerHTML = ''; box.append(...children.flat(2)); };

  /* ===== toast ===== */
  const toast = (() => {
    function show(message, type, ms) {
      const node = h('div', { class: `toast toast-${type}` },
        h('span', { class: 'toast-dot' }), h('span', { class: 'toast-msg', text: message }));
      $('#toasts').append(node);
      setTimeout(() => { node.classList.add('toast-out'); setTimeout(() => node.remove(), 350); }, ms);
    }
    return {
      ok: m => show(m, 'ok', 3500),
      err: m => show(m, 'err', 6000),
      info: m => show(m, 'info', 4000),
    };
  })();

  /* ===== api：fetch 封装，非 2xx 时读取 {error:{code,message}} 并 toast 后抛出 ===== */
  // 部署路径自感知：standalone 服务在 /，DSH hosted 模式挂在 /opcos 前缀下
  const API_BASE = location.pathname.startsWith('/opcos') ? '/opcos' : '';
  /** 会话过期只提示一次并回到登录页，避免轮询面板反复弹错 */
  let sessionExpiredHandled = false;
  const api = {
    async request(method, path, body) {
      let res;
      try {
        res = await fetch(API_BASE + path, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        const err = { code: 'NETWORK_ERROR', message: `无法访问 ${path}，请检查服务状态` };
        toast.err(`出了点小状况（${err.code}）。创意和收入数据不受影响，重试即可`);
        throw err;
      }
      let data = null;
      try { data = await res.json(); } catch { /* 204 等空响应 */ }
      if (!res.ok) {
        const err = (data && data.error) || { code: `HTTP_${res.status}`, message: res.statusText || '请求失败' };
        if ((err.code === 'UNAUTHORIZED' || err.code === 'AUTH_FAILED') && !sessionExpiredHandled) {
          // 会话过期：回到登录页（登录/注册页自身的 fetch 不走本封装，不会递归）
          sessionExpiredHandled = true;
          toast.err('登录已过期，请重新登录');
          const badge = $('#user-badge');
          if (badge) badge.textContent = '未登录';
          $('#logout-btn')?.classList.add('hidden');
          renderLogin();
        } else if (!sessionExpiredHandled) {
          toast.err(`出了点小状况（${err.code}）。创意和收入数据不受影响，重试即可`);
        }
        throw err;
      }
      return data;
    },
    get: p => api.request('GET', p),
    post: (p, b) => api.request('POST', p, b),
  };

  /* ===== ui 组件 ===== */
  const ui = {
    pageTitle: (title, desc) => h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: title }),
      desc ? h('p', { class: 'page-desc', text: desc }) : null),
    statCard: (label, value, sub) => h('div', { class: 'card stat-card' },
      h('div', { class: 'stat-value', text: value }), h('div', { class: 'stat-label', text: label }),
      sub ? h('div', { class: 'stat-sub', text: sub }) : null),
    sectionCard: (title, ...children) => h('div', { class: 'card section-card' },
      title ? h('h3', { class: 'card-title', text: title }) : null, ...children),
    toolbar: (...children) => h('div', { class: 'toolbar' }, ...children),
    formGrid: (...children) => h('div', { class: 'form-grid' }, ...children),
    actions: (...children) => h('div', { class: 'toolbar-actions' }, ...children),
    grow: child => h('div', { class: 'grow' }, child),
    badge: (text, variant = 'muted') => h('span', { class: `badge badge-${variant}`, text }),
    // role="status"：装载中/空态对读屏器播报（aria-live 隐式 polite）
    empty: text => h('div', { class: 'empty', role: 'status', text }),
    loading: text => h('div', { class: 'muted pad', role: 'status', text: text || '加载中…' }),
    field: (labelText, control) => h('label', { class: 'field' },
      h('span', { class: 'field-label', text: labelText }), control),
    table: (headers, rows) => {
      if (!rows || !rows.length) return ui.empty('暂无数据');
      const tr = cells => h('tr', {}, cells.map(c => h('td', {}, (c && c.nodeType) ? c : String(c ?? ''))));
      return h('div', { class: 'table-wrap' },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, headers.map(x => h('th', { text: x, scope: 'col' })))),
          h('tbody', {}, rows.map(tr))));
    },
    /** value JSON 折叠展示 */
    jsonBox: (value, label = 'value') => h('details', { class: 'json-box' },
      h('summary', { text: label }), h('pre', { text: safeJson(value) })),
  };
  const statusBadge = s => ui.badge(String(s || 'unknown'), {
    paid: 'ok', completed: 'ok', succeeded: 'ok', refunded: 'warn', failed: 'err', cancelled: 'err',
  }[String(s)] || 'muted');
  const resolutionBadge = r => (r === 'resolved' ? ui.badge('resolved', 'ok') : ui.badge(String(r || '—'), 'muted'));

  /* ===== 交互辅助 ===== */
  /** 按钮异步操作：点击后禁用并显示进行中文案；错误统一由 api 层 toast */
  function busyBtn(btn, pendingText, fn) {
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = pendingText;
      try { await fn(); } catch { /* 错误已由 api 层 toast 展示 */ }
      finally { btn.disabled = false; btn.textContent = original; }
    });
  }
  /** 面板数据装载：loading → 内容 / 失败空态 */
  async function loadInto(box, loadingText, fn, errText) {
    box.innerHTML = '';
    box.append(ui.loading(loadingText));
    try {
      render(box, await fn());
    } catch {
      render(box, ui.empty(errText || '加载失败，请稍后重试'));
    }
  }
  const onEnter = (input, fn) => input.addEventListener('keydown', ev => { if (ev.key === 'Enter') fn(); });
  /** 面板轮询：每 ms 执行 fn；面板切走（box 脱离文档）后自动清理定时器 */
  function autoPoll(box, fn, ms = 10000) {
    const timer = setInterval(() => {
      if (!box.isConnected) { clearInterval(timer); return; }
      fn();
    }, ms);
  }

  /* ===== router（hash 路由，刷新保持） ===== */
  const ROUTES = {}; // name -> async render(container)
  const ROUTE_NAMES = ['overview', 'ideas', 'market', 'teams', 'team', 'board', 'blackboard', 'skills', 'orders', 'creators', 'bills', 'billing', 'content', 'memory'];
  const router = {
    current() {
      const m = /^#\/([a-z]+)/.exec(location.hash);
      return m && ROUTE_NAMES.includes(m[1]) ? m[1] : 'overview';
    },
    _chain: Promise.resolve(),
    renderPanel() {
      // 串行化渲染：并发时后到者的结果覆盖先到者（首帧竞态——start() 自动渲染
      // overview 的 fetch 在飞行中用户点击导航，旧结果晚到覆盖新面板）
      router._chain = router._chain.then(async () => {
        const name = router.current();
        $$('#sidenav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
        const box = $('#main');
        box.innerHTML = '';
        box.append(ui.loading());
        try {
          await ROUTES[name](box);
        } catch (err) {
          render(box, h('div', { class: 'card panel-error' },
            h('h3', { text: '面板加载失败' }),
            h('p', { class: 'muted', text: `${(err && err.code) || 'ERROR'}：${(err && err.message) || ''}` })));
        }
      }).catch(() => {});
      return router._chain;
    },
    start() {
      window.addEventListener('hashchange', () => router.renderPanel());
      // 深链：官方 GUI 启动器 iframe 以 ?panel=<name> 打开（?opcos-panel 由启动器脚本换名），
      // 初始路由到该面板；非法值忽略，走默认 overview
      const requested = new URLSearchParams(location.search).get('panel');
      if (requested && ROUTE_NAMES.includes(requested)) location.hash = `#/${requested}`;
      if (location.hash !== `#/${router.current()}`) location.hash = `#/${router.current()}`;
      else router.renderPanel();
    },
  };

  /* ===== 面板：总览（创意变现漏斗） ===== */
  const timeline = events => events.length
    ? h('ul', { class: 'timeline' }, events.map(ev => h('li', { class: 'timeline-item' },
        h('div', { class: 'tl-head' },
          h('code', { class: 'tl-type', text: ev.type || 'event' }),
          h('span', { class: 'tl-time', text: fmtTime(ev.timestamp) })),
        ev.payload ? h('pre', { class: 'tl-payload', text: safeJson(ev.payload) }) : null)))
    : ui.empty('暂无埋点事件');

  ROUTES.overview = async box => {
    const ideasNum = h('span', { class: 'funnel-num', text: '—' }),
      runsNum = h('span', { class: 'funnel-num', text: '—' }),
      publishedNum = h('span', { class: 'funnel-num ok', text: '—' }),
      draftsNum = h('span', { class: 'funnel-num', text: '—' }),
      listedNum = h('span', { class: 'funnel-num ok', text: '—' }),
      orderRevenueNum = h('span', { class: 'funnel-num ok', text: '—' }),
      raasRevenueNum = h('span', { class: 'funnel-num ok', text: '—' }),
      ideaInput = h('input', { class: 'input', placeholder: '随时记下一个创意，如：宠物经济测评' }),
      ideaTeamSelect = h('select', { class: 'input' }, h('option', { value: '', text: '个人创意' })),
      ideaBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '记下这个创意' }),
      runBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '运行内容流水线' }),
      recentBox = h('div'),
      healthLine = h('p', { class: 'muted small funnel-health', text: '系统状态加载中…' }),
      telemetryBox = h('div');

    /** 漏斗数字原位刷新（不重绘整面板，保留创意输入框状态） */
    const setNum = (node, v) => { node.textContent = v === null || v === undefined ? '—' : String(v); };
    const refreshFunnel = async () => {
      const f = (await api.get('/api/funnel')) || {};
      const contents = f.contents || {}, skills = f.skills || {}, revenue = f.revenue || {};
      setNum(ideasNum, f.ideas);
      setNum(runsNum, contents.runs);
      setNum(publishedNum, contents.published);
      setNum(draftsNum, skills.drafts);
      setNum(listedNum, skills.listed);
      setNum(orderRevenueNum, money(revenue.orderNetCents));
      setNum(raasRevenueNum, yuan(revenue.raasRevenueYuan));
    };
    const loadRecent = () => loadInto(recentBox, null, async () => {
      const ideas = ((await api.get('/api/ideas')) || {}).ideas || [];
      if (!ideas.length) return ui.empty('还没有创意：在上方漏斗记下第一个创意，运行流水线时将驱动选题');
      return h('ul', { class: 'idea-list' }, ideas.slice(0, 5).map(e => h('li', {},
        h('a', { class: 'idea-text', href: '#/ideas', text: e.name || (e.content || '') }),
        h('span', { class: 'idea-time', text: fmtTime(e.createdAt) }))));
    }, '最近创意加载失败');
    const loadHealth = async () => {
      try {
        const data = (await api.get('/api/health')) || {};
        const plugins = data.plugins || [];
        healthLine.textContent = '系统状态：'
          + (plugins.length
            ? plugins.map(p => `${p.name} ${p.ok ? '正常' : '隔离'}`).join(' · ')
            : '插件清单为空');
      } catch { healthLine.textContent = '系统状态：不可用'; }
    };
    const loadTelemetry = () => loadInto(telemetryBox, null, async () => {
      const o = (await api.get('/api/overview')) || {};
      return timeline((o.telemetry && o.telemetry.recent) || []);
    }, '埋点加载失败');

    // 段1 创意：行内快捷录入 → POST /api/ideas → toast + 漏斗数字即时 +1 + 刷新最近创意
    api.get('/api/teams').then(data => {
      for (const team of (data && data.teams) || []) {
        ideaTeamSelect.append(h('option', { value: team.id, text: `团队：${team.name}` }));
      }
    }).catch(() => { /* 团队缺席：仅个人 */ });
    busyBtn(ideaBtn, '记录中…', async () => {
      const text = ideaInput.value.trim();
      if (!text) return toast.err('先写下创意内容再记录');
      const body = { text };
      if (ideaTeamSelect.value) body.teamId = ideaTeamSelect.value;
      const res = await api.post('/api/ideas', body);
      toast.ok((res && res.hint) || '已记下。跑一次「出作品」，它会变成你的选题');
      ideaInput.value = '';
      if (ideasNum.textContent !== '—') ideasNum.textContent = String(Number(ideasNum.textContent) + 1);
      await loadRecent();
      refreshFunnel().catch(() => {}); // 后台校准全漏斗（错误已由 api 层 toast）
    });
    onEnter(ideaInput, () => ideaBtn.click());
    // 段2 作品：一键运行内容流水线（创意 → 选题 → 撰写 → 审核 → 发布）
    busyBtn(runBtn, '运行中…（LLM 模式可能数秒）', async () => {
      const r = await api.post('/api/content/run', {});
      toast.ok(r && r.publish && r.publish.url
        ? `流水线完成，已发布到 ${r.publish.platform}：${((r.brief || {}).title) || ''}`
        : '流水线已运行（本次未发布）');
      await refreshFunnel();
    });

    const stage = (title, ...children) => h('div', { class: 'funnel-step' },
      h('div', { class: 'funnel-stage', text: title }), ...children);
    const arrow = () => h('div', { class: 'funnel-arrow', 'aria-hidden': 'true', text: '→' });
    const numLine = (node, unit) => h('div', { class: 'funnel-num-line' }, node,
      h('span', { class: 'funnel-unit', text: unit }));

    render(box,
      ui.pageTitle('创意变现', '今天，你的创意走到哪一步了？'),
      ui.sectionCard(null,
        h('div', { class: 'funnel' },
          stage('① 记下的创意 · 选题记忆',
            numLine(ideasNum, '条创意'),
            h('div', { class: 'funnel-action' },
              h('div', { class: 'funnel-input-row' },
                h('div', { class: 'grow', style: 'display:flex;gap:6px;min-width:0' }, ideaInput, ideaTeamSelect),
                ideaBtn))),
          arrow(),
          stage('② 发出的作品 · 内容流水线',
            numLine(runsNum, '次运行'),
            h('div', { class: 'funnel-sub' }, '已发布 ', publishedNum, ' 篇'),
            h('div', { class: 'funnel-action' }, runBtn)),
          arrow(),
          stage('③ 在售的技能 · 草案上架',
            numLine(draftsNum, '个草案'),
            h('div', { class: 'funnel-sub' }, listedNum, ' 个在售'),
            h('div', { class: 'funnel-action funnel-links' },
              h('a', { href: '#/skills', text: '查看草案上架 →' }))),
          arrow(),
          stage('④ 到手的收入 · 订单 + RaaS',
            numLine(orderRevenueNum, '订单净额'),
            h('div', { class: 'funnel-sub' }, 'RaaS 计费 ', raasRevenueNum),
            h('div', { class: 'funnel-action funnel-links' },
              h('a', { href: '#/orders', text: '订单交易' }),
              h('a', { href: '#/billing', text: 'RaaS 计费' })))),
        h('p', { class: 'muted small', style: 'margin:10px 0 0',
          text: '创意直写选题记忆驱动内容流水线；作品沉淀的本能蒸馏为 Skill 上架，订单分成与 RaaS 计费构成双通道收入，全程沉淀记忆资产反哺创意。' })),
      ui.sectionCard('最近创意', recentBox),
      healthLine,
      h('details', { class: 'collapse' },
        h('summary', { text: '最近埋点事件（系统埋点时间线）' }),
        telemetryBox));

    await Promise.all([
      refreshFunnel().catch(() => {}),
      loadRecent(),
      loadHealth(),
      loadTelemetry(),
    ]);
  };

  /* ===== 面板：我的创意（prd2.md M1：创意一等公民 + 三域 + 独立记忆体挂载） ===== */
  const IDEA_STAGE_LABELS = { description: '创意描述', product: '创意产品', operation: '产品运营', asset: '产品资产' };
  const IDEA_STAGES = ['description', 'product', 'operation', 'asset'];
  const DOMAIN_LABELS = { problem: '问题域', solution: '解决域', spacetime: '时空域' };
  const DOMAIN_KEYS = ['problem', 'solution', 'spacetime'];
  const STREAM_LABELS = {
    description: '描述', decisions: '决策', research: '调研', 'model-notes': '模型笔记',
    facts: '品牌事实', users: '用户', analytics: '运营数据',
  };
  const PLATFORM_LABELS = { wechat: '公众号', xiaohongshu: '小红书', douyin: '抖音', twitter: 'Twitter', bilibili: 'B站' };

  ROUTES.ideas = async box => {
    const listBox = h('div');
    const detailBox = h('div');
    const mountLine = h('p', { class: 'muted small', style: 'margin:8px 0 0', text: '' });
    let selectedId = null;

    const refreshMounted = async () => {
      try {
        const data = (await api.get('/api/memory-bodies')) || {};
        const ids = data.mounted || [];
        mountLine.textContent = ids.length
          ? `已挂载记忆体：${ids.join(' · ')}——跨创意检索只命中这份清单`
          : '尚未挂载记忆体：跨创意检索不会命中任何创意，打开详情可挂载';
      } catch { mountLine.textContent = ''; }
    };

    const loadList = () => loadInto(listBox, null, async () => {
      const ideas = ((await api.get('/api/ideas')) || {}).ideas || [];
      if (!ideas.length) return ui.empty('创意库是空的——回总览漏斗记下第一个创意');
      return h('div', { class: 'card-grid' }, ideas.map(idea => h('div', { class: 'card memory-card' },
        h('div', { class: 'memory-head' },
          h('strong', { text: idea.name || idea.id }),
          ui.badge(IDEA_STAGE_LABELS[idea.stage] || idea.stage || '—', 'info')),
        h('p', { class: 'memory-content', text: (idea.domains && idea.domains.problem.summary) || '三域草案待完善' }),
        h('div', { class: 'toolbar-actions' },
          h('button', {
            class: 'btn btn-sm', type: 'button', text: '打开详情',
            onclick: () => { selectedId = idea.id; openDetail(); },
          }),
          h('span', { class: 'muted small', text: fmtTime(idea.createdAt) })))));
    }, '创意列表加载失败');

    /** 详情区：阶段推进 + 三域编辑（带引导问题）+ MVP 方案/验证 + 记忆体 + 工作区 */
    async function openDetail() {
      if (!selectedId) { detailBox.innerHTML = ''; return; }
      await loadInto(detailBox, '加载创意详情…', async () => {
        const [d, sg, ws, ldg, tk, ver] = await Promise.all([
          api.get(`/api/ideas/${selectedId}`),
          api.get(`/api/ideas/${selectedId}/mvp/suggestion`).catch(() => null),
          api.get(`/api/ideas/${selectedId}/workspace`).catch(() => null),
          api.get(`/api/ideas/${selectedId}/ledger`).catch(() => null),
          api.get(`/api/ideas/${selectedId}/token`).catch(() => null),
          api.get(`/api/ideas/${selectedId}/versions`).catch(() => null),
        ]);
        const idea = d.idea;
        const domains = idea.domains || {};
        const questions = d.guidingQuestions || {};
        const stageIndex = IDEA_STAGES.indexOf(idea.stage);

        // 阶段进度：合法的下一阶段可点击推进（生命周期线性单向，prd2.md 1.2）；
        // 点击展开内联迁移表单（不使用浏览器原生弹窗）
        const stepper = h('div', { class: 'tabs' }, IDEA_STAGES.map((s, i) => {
          const isCurrent = s === idea.stage;
          const isNext = i === stageIndex + 1;
          const btn = h('button', { class: `tab${isCurrent ? ' active' : ''}`, type: 'button' },
            h('span', { text: IDEA_STAGE_LABELS[s] }));
          if (isCurrent) btn.disabled = true;
          else if (isNext) {
            btn.title = `推进到${IDEA_STAGE_LABELS[s]}`;
            btn.addEventListener('click', () => {
              const existing = $('#transition-form');
              if (existing) existing.remove();
              const noteInput = h('input', { class: 'input', placeholder: `推进依据，如：MVP 验证过线 / 内测数据达标` });
              const confirmBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '确认推进' });
              const cancelBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '取消' });
              const form = h('div', { class: 'card section-card', id: 'transition-form', style: 'margin-top:10px' },
                h('p', { class: 'small', style: 'margin:0 0 6px' },
                  h('strong', { text: `推进到「${IDEA_STAGE_LABELS[s]}」` }), ' —— 生命周期只允许线性推进，此操作会写入决策记忆'),
                ui.toolbar(ui.grow(ui.field('推进依据 note', noteInput)), ui.actions(confirmBtn, cancelBtn)));
              stepper.after(form);
              cancelBtn.addEventListener('click', () => form.remove());
              confirmBtn.addEventListener('click', async () => {
                confirmBtn.disabled = true;
                confirmBtn.textContent = '推进中…';
                try {
                  const res = await api.post(`/api/ideas/${idea.id}/transition`, { to: s, note: noteInput.value.trim() || undefined });
                  toast.ok(`已推进：${IDEA_STAGE_LABELS[res.transition.from]} → ${IDEA_STAGE_LABELS[res.transition.to]}`);
                  await Promise.all([openDetail(), loadList()]);
                } catch { confirmBtn.disabled = false; confirmBtn.textContent = '确认推进'; }
              });
            });
          } else btn.disabled = true;
          return btn;
        }));

        const domainCards = DOMAIN_KEYS.map(key => {
          const domain = domains[key] || { summary: '', points: [] };
          const summaryInput = h('textarea', { class: 'input', rows: 3, placeholder: '这个域讲什么？（引导问题在上方）' });
          summaryInput.value = domain.summary || '';
          const pointsInput = h('textarea', { class: 'input', rows: 2, placeholder: '要点，一行一个' });
          pointsInput.value = (domain.points || []).join('\n');
          const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '保存这个域' });
          busyBtn(saveBtn, '保存中…', async () => {
            const points = pointsInput.value.split('\n').map(s => s.trim()).filter(Boolean);
            await api.request('PATCH', `/api/ideas/${idea.id}/domains`, {
              domain: key, summary: summaryInput.value.trim(), points,
            });
            toast.ok(`「${idea.name}」的${DOMAIN_LABELS[key]}已更新`);
            await Promise.all([openDetail(), loadList()]);
          });
          return h('div', { class: 'card memory-card' },
            h('div', { class: 'memory-head' }, h('strong', { text: DOMAIN_LABELS[key] })),
            h('ul', { class: 'muted small' }, (questions[key] || []).map(q => h('li', { text: q }))),
            h('div', { class: 'form-grid form-grid-1' },
              ui.field('概述 summary', summaryInput), ui.field('要点 points（一行一个）', pointsInput)),
            h('div', { class: 'toolbar-actions' }, saveBtn));
        });

        // MVP 区（阶段二）：方案生成 + 验证记录 + Go/No-Go
        const mvpBox = h('div');
        const renderMvp = (suggestion, plan) => {
          const sug = suggestion && suggestion.suggestion;
          render(mvpBox,
            h('div', { class: 'memory-head' },
              ui.badge(sug === 'go' ? 'Go：验证充分，可以推进' : sug === 'no-go' ? 'No-Go：验证还不够' : '还没有建议', sug === 'go' ? 'ok' : 'muted'),
              h('span', { class: 'muted small', text: sug ? `依据 ${suggestion.validations} 条验证记录` : '' })),
            (suggestion && suggestion.suggestion === 'no-go')
              ? h('ul', { class: 'muted small' }, suggestion.reasons.map(r => h('li', { text: r }))) : null,
            plan ? h('div', {},
              h('h4', { text: 'MVP 功能清单' }),
              h('ul', {}, plan.features.map(f => h('li', { text: f }))),
              h('h4', { text: '技术栈建议' }),
              h('ul', {}, plan.techStack.map(t => h('li', { text: t }))),
              h('h4', { text: '开发计划' }),
              ...plan.milestones.map(m => h('p', { class: 'small' }, h('strong', { text: m.title }), '：', m.items.join('；'))))
              : ui.empty('还没有 MVP 方案——三域完善后点「生成 MVP 方案」'));
        };
        renderMvp(sg && sg.suggestion ? sg : null, null);
        const planBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '生成 MVP 方案' });
        busyBtn(planBtn, '生成中…', async () => {
          const res = await api.post(`/api/ideas/${idea.id}/mvp/plan`, {});
          toast.ok('MVP 方案已生成，正本已存入决策记忆');
          renderMvp(sg && sg.suggestion ? sg : null, res.plan);
        });
        const vSource = h('select', { class: 'input' },
          h('option', { value: 'feedback', text: '用户反馈' }),
          h('option', { value: 'metric', text: '数据指标' }));
        const vScore = h('input', { class: 'input', type: 'number', min: '0', max: '5', step: '0.5', placeholder: '评分 0-5（可选）' });
        const vContent = h('input', { class: 'input', placeholder: '验证结论，如：12 人内测，10 人愿付费' });
        const vBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '记一条验证' });
        busyBtn(vBtn, '记录中…', async () => {
          const content = vContent.value.trim();
          if (!content) return toast.err('先写验证结论');
          const score = vScore.value === '' ? undefined : Number(vScore.value);
          const fresh = await api.post(`/api/ideas/${idea.id}/mvp/validation`, {
            source: vSource.value, content, ...(score !== undefined && Number.isFinite(score) ? { score } : {}),
          });
          toast.ok(`已记一条${fresh.record.source === 'metric' ? '数据指标' : '用户反馈'}（ Go/No-Go 已更新）`);
          vContent.value = ''; vScore.value = '';
          const freshSg = await api.get(`/api/ideas/${idea.id}/mvp/suggestion`);
          renderMvp(freshSg, null);
        });

        // 工作区（IP-02）：文件列表 + 点开查看
        const wsBox = h('div');
        const renderWs = (root, files) => render(wsBox, files.length
          ? h('ul', { class: 'muted small' }, files.map(f => h('li', {},
              h('a', { href: 'javascript:void(0)', text: f, onclick: async () => {
                const file = await api.get(`/api/ideas/${idea.id}/workspace/file?path=${encodeURIComponent(f)}`);
                render(wsBox, h('pre', { class: 'tl-payload', text: file.content }),
                  h('a', { href: 'javascript:void(0)', text: '← 返回文件列表', onclick: () => renderWs(root, files) }));
              } }))))
          : ui.empty('工作区是空的——MVP 开发的文件都写在这里（Agent 读写根限定了本创意）'));
        renderWs(ws && ws.root, (ws && ws.files) || []);

        // 记忆体：最近条目 + 检索 + 写入
        const entriesBox = h('div');
        const renderEntries = entries => render(entriesBox, entries.length
          ? h('ul', { class: 'timeline' }, entries.map(e => h('li', { class: 'timeline-item' },
              h('div', { class: 'tl-head' },
                ui.badge(`${STREAM_LABELS[e.stream] || e.stream} · ${e.authority === 'model' ? '模型总结' : '用户钦定'}`, 'info'),
                h('span', { class: 'tl-time', text: fmtTime(e.createdAt) })),
              h('p', { class: 'memory-content', text: e.content }))))
          : ui.empty('这条记忆流还是空的——检索、写入或编辑三域都会留痕'));
        renderEntries(d.entries || []);
        const qInput = h('input', { class: 'input', placeholder: '在「我的创意」记忆体里全文检索（≥3 字任意子串）' });
        const searchBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '检索' });
        const search = () => loadInto(entriesBox, '检索中…', async () => {
          const params = new URLSearchParams();
          const q = qInput.value.trim();
          if (q) params.set('q', q);
          params.set('limit', '20');
          const res = await api.get(`/api/ideas/${idea.id}/entries?${params.toString()}`);
          renderEntries(res.entries || []);
        }, '记忆体检索失败');
        searchBtn.addEventListener('click', search);
        onEnter(qInput, search);

        const streamSelect = h('select', { class: 'input' },
          Object.keys(STREAM_LABELS).map(s => h('option', { value: s, text: `${STREAM_LABELS[s]}（${s}）` })));
        const authoritySelect = h('select', { class: 'input' },
          h('option', { value: 'user', text: '用户钦定（user）' }),
          h('option', { value: 'model', text: '模型总结（model）' }));
        const contentInput = h('textarea', { class: 'input', rows: 2, placeholder: '要沉淀进这个创意记忆体的内容' });
        const writeBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '写入记忆体' });
        busyBtn(writeBtn, '写入中…', async () => {
          const content = contentInput.value.trim();
          if (!content) return toast.err('先写下要沉淀的内容');
          await api.post(`/api/ideas/${idea.id}/entries`, {
            stream: streamSelect.value, content, confidence: 0.8, authority: authoritySelect.value,
          });
          toast.ok(`已写入「${STREAM_LABELS[streamSelect.value]}」记忆流`);
          contentInput.value = '';
          search();
        });

        const mountBtn = h('button', { class: `btn btn-sm`, type: 'button', text: d.mounted ? '卸载记忆体' : '挂载记忆体' });
        busyBtn(mountBtn, d.mounted ? '卸载中…' : '挂载中…', async () => {
          const res = await api.post('/api/memory-bodies/mount', {
            ideaIds: [idea.id], action: d.mounted ? 'unmount' : 'mount',
          });
          toast.ok(res.hint || '挂载状态已更新');
          await Promise.all([openDetail(), refreshMounted()]);
        });

        // GEO 监测（prd2.md 4.4，阶段三）：刷新 + 平台快照 + 下跌告警
        const geoBox = h('div');
        const renderGeo = data => {
          const history = (data && data.history) || [];
          const byPlatform = {};
          for (const s of history) byPlatform[s.platform] = s; // 时间倒序 → 每平台保留最新
          const rows = Object.entries(byPlatform).map(([platform, s]) => [
            PLATFORM_LABELS[platform] || platform,
            `${Math.round(s.visibility * 100)}%`,
            `${Math.round(s.citationRate * 100)}%`,
            `${Math.round(s.sentiment * 100)}分`,
            fmtTime(s.at),
          ]);
          render(geoBox,
            ui.table(['平台', '可见性', '引用率', '情感', '采集时间'], rows),
            h('p', { class: 'muted small', style: 'margin:6px 0 0',
              text: data && data.config
                ? `监测平台：${data.config.platforms.join(' / ')} · 告警阈值：可见性下跌 ${Math.round(data.config.alertThreshold * 100)}% · 当前为模拟口径数据（主流 AI 平台无公开可见性 API）`
                : '' }));
        };
        api.get(`/api/ideas/${idea.id}/geo`).then(renderGeo).catch(() => renderGeo(null));
        const geoBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '刷新监测' });
        busyBtn(geoBtn, '监测中…', async () => {
          const res = await api.post(`/api/ideas/${idea.id}/geo/refresh`, {});
          const fresh = await api.get(`/api/ideas/${idea.id}/geo`);
          renderGeo(fresh);
          toast.ok(res.alerts && res.alerts.length
            ? `监测完成：${res.alerts.length} 个平台可见性下跌告警`
            : '监测完成：各平台指标已更新并沉淀到运营数据');
        });

        // 资产与 Token（prd2.md 5，阶段四）：五类账本 + 积分发行
        const assetBox = h('div');
        const renderAsset = (ledgerData, tokenData) => {
          if (!ledgerData) { render(assetBox, ui.empty('创意库缺席，资产账本不可用')); return; }
          const a = ledgerData.ledger.assets;
          render(assetBox,
            h('div', { class: 'card-grid' },
              ui.statCard('财务收入合计', money(a.finance.total), `作品 ${money(a.finance.product_revenue)} · 订阅 ${money(a.finance.subscription_revenue)} · Skill ${money(a.finance.skill_revenue)}`),
              ui.statCard('Skill 沉淀', `${a.skills.length} 个`, a.skills.map(s => `${s.name}（${money(s.revenue)}）`).join(' · ') || '尚无沉淀'),
              ui.statCard('用户资源', num(a.users.total), `30 日活跃 ${num(a.users.active_30d)} · 付费 ${num(a.users.paying)}`),
              ui.statCard('运营数据', `${Math.round((a.analytics.geo_visibility || 0) * 100)}%`, `GEO 可见性 · 互动 ${Math.round((a.analytics.content_engagement || 0) * 100)}% · 转化 ${Math.round((a.analytics.conversion_rate || 0) * 100)}%`)),
            tokenData ? h('div', {},
              h('h4', { style: 'margin:12px 0 4px' }, 'Meme Token 积分 ',
                ui.badge(`${num(tokenData.stats.distributed)} / ${num(tokenData.stats.total_supply)} 已发放 · ${num(tokenData.stats.holders)} 持有`, 'info'),
                ui.badge('社区积分 · 非金融产品', 'muted')),
              h('div', { class: 'form-grid' },
                ui.field('发给谁 to', tokenToInput),
                ui.field('角色 role', tokenRoleSelect),
                ui.field('数量 amount', tokenAmountInput),
                ui.field('事由 reason', tokenReasonInput)),
              ui.toolbar(tokenIssueBtn),
              tokenData.grants.length
                ? ui.table(['对象', '角色', '数量', '事由', '时间'], tokenData.grants.map(g => [g.to, (tokenData.roles.find(r => r.role === g.role) || {}).label || g.role, num(g.amount), g.reason, fmtTime(g.at)]))
                : ui.empty('还没有发放记录——测试反馈、内容贡献、协同参与都值得发一点'))
              : null);
        };
        const tokenToInput = h('input', { class: 'input', placeholder: '接收人 ID（如 user-x / idea-xxx）' });
        const tokenRoleSelect = h('select', { class: 'input' },
          (tk && tk.roles || []).map(r => h('option', { value: r.role, text: `${r.label}（${r.role}）` })));
        const tokenAmountInput = h('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '积分数量' });
        const tokenReasonInput = h('input', { class: 'input', placeholder: '事由，如：MVP 测试反馈' });
        const tokenIssueBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '发放积分' });
        busyBtn(tokenIssueBtn, '发放中…', async () => {
          const to = tokenToInput.value.trim();
          const amount = Number(tokenAmountInput.value);
          if (!to) return toast.err('先填接收人');
          if (!Number.isInteger(amount) || amount <= 0) return toast.err('数量需要是正整数');
          const res = await api.post(`/api/ideas/${idea.id}/token/issue`, {
            to, role: tokenRoleSelect.value, amount, reason: tokenReasonInput.value.trim() || '社区贡献',
          });
          toast.ok(`已发放 ${num(res.grant.amount)} 积分给 ${res.grant.to}`);
          tokenToInput.value = ''; tokenAmountInput.value = ''; tokenReasonInput.value = '';
          const [freshLdg, freshTk] = await Promise.all([
            api.get(`/api/ideas/${idea.id}/ledger`), api.get(`/api/ideas/${idea.id}/token`)]);
          renderAsset(freshLdg, freshTk);
        });
        renderAsset(ldg, tk);

        // 发布到创意市场（ID-05/IM-01/IM-03）+ 协同入口
        const relationsBox = h('div');
        const renderRelations = rels => render(relationsBox, rels.length
          ? ui.table(['类型', '关联创意', '强度', '说明'], rels.map(r => [
              ui.badge(r.type === 'complementary' ? '互补' : '相似', r.type === 'complementary' ? 'ok' : 'info'),
              r.b, `${Math.round(r.score * 100)}%`, r.reason]))
          : ui.empty('暂无关联——市场里的创意更新后会自动重新发现'));
        api.get(`/api/market/ideas/${idea.id}`).then(d2 => renderRelations(d2.relations || [])).catch(() => renderRelations([]));
        const publishBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '发布到市场' });
        busyBtn(publishBtn, '发布中…', async () => {
          const res = await api.post(`/api/ideas/${idea.id}/publish`, {});
          toast.ok(`已发布到创意市场：发现 ${res.relations.length} 条关联`);
          renderRelations(res.relations);
        });
        const collabUser = h('input', { class: 'input', placeholder: '协作者 ID（如 user-y）' });
        const collabRole = h('select', { class: 'input' },
          h('option', { value: 'developer', text: 'MVP开发者（20%）' }),
          h('option', { value: 'operator', text: '内容运营者（20%）' }),
          h('option', { value: 'promoter', text: '社区推广者（15%）' }),
          h('option', { value: 'asset-manager', text: '资产管理者（10%）' }),
          h('option', { value: 'founder', text: '创意发起人（25%）' }));
        const collabText = h('input', { class: 'input', placeholder: '贡献说明，如：MVP 代码贡献' });
        const collabBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '记协同并发 Token' });
        busyBtn(collabBtn, '记录中…', async () => {
          const userId = collabUser.value.trim();
          if (!userId) return toast.err('先填协作者 ID');
          const res = await api.post(`/api/ideas/${idea.id}/collab`, {
            userId, role: collabRole.value, contribution: collabText.value.trim() || '协同贡献',
          });
          toast.ok(`已记协同贡献，发放 ${num(res.record.tokensGranted)} 积分给 ${userId}`);
          collabUser.value = ''; collabText.value = '';
        });

        // 版本链与回滚（ID-04）：三域每次迭代自动入链；回滚以恢复态入新版本，可再撤销
        const versionsBox = h('div');
        const renderVersions = versions => {
          if (!versions || !versions.length) {
            render(versionsBox, ui.empty('还没有版本记录'));
            return;
          }
          const rows = versions.map(v => {
            const lastCell = v.version === versions[0].version
              ? ui.badge('当前', 'ok')
              : (() => {
                  const btn = h('button', { class: 'btn btn-sm', type: 'button', text: '回滚到此版' });
                  btn.addEventListener('click', async () => {
                    if (!window.confirm(`回滚到 v${v.version}？当前三域会先存为新版本（可再撤销）。`)) return;
                    try {
                      const res = await api.post(`/api/ideas/${idea.id}/rollback`, { version: v.version });
                      toast.ok(`已回滚至 v${v.version}，恢复态入链为 v${res.version.version}`);
                      await Promise.all([openDetail(), loadList()]);
                    } catch { /* api 层已 toast */ }
                  });
                  return btn;
                })();
            return [`v${v.version}`, v.note, fmtTime(v.createdAt), lastCell];
          });
          render(versionsBox, ui.table(['版本', '说明', '时间', ''], rows));
        };
        renderVersions(ver && ver.versions);

        return h('div', { class: 'card section-card' },
          h('div', { class: 'memory-head' },
            h('h3', { class: 'card-title', text: idea.name }),
            ui.badge(IDEA_STAGE_LABELS[idea.stage] || idea.stage, 'ok')),
          stepper,
          h('p', { class: 'muted small', text: `创意 ID ${idea.id} · 记录于 ${fmtTime(idea.createdAt)}` }),
          h('div', { class: 'card-grid' }, domainCards),
          ui.sectionCard('MVP 方案与验证（阶段二）',
            ui.toolbar(ui.actions(planBtn),
              h('span', { class: 'muted small', text: '方案基于三域生成；每条验证都会更新 Go/No-Go 建议。' })),
            mvpBox,
            ui.toolbar(ui.field('来源', vSource), ui.field('评分', vScore), ui.grow(ui.field('结论', vContent)), ui.actions(vBtn))),
          ui.sectionCard('三域版本链（ID-04）',
            h('p', { class: 'muted small', style: 'margin:0 0 6px', text: '三域每次迭代自动入链；回滚会把当前三域先存为新版本，可随时再撤销。' }),
            versionsBox),
          ui.sectionCard('GEO 监测（阶段三）',
            ui.toolbar(ui.actions(geoBtn),
              h('span', { class: 'muted small', text: '监测豆包/DeepSeek/ChatGPT/文心的品牌可见性，数据沉淀到运营数据。' })),
            geoBox),
          ui.sectionCard('资产与 Token（阶段四）', assetBox),
          ui.sectionCard('创意市场与协同',
            ui.toolbar(ui.actions(publishBtn),
              h('span', { class: 'muted small', text: '发布摘要到市场，别人可以关注它；阶段变更会通知关注者。' })),
            h('div', { class: 'form-grid' },
              ui.field('协作者 userId', collabUser), ui.field('协同角色 role', collabRole),
              ui.grow(ui.field('贡献说明 contribution', collabText))),
            ui.toolbar(collabBtn),
            relationsBox),
          h('div', { class: 'two-col' },
            ui.sectionCard('记忆体 · 检索与近况',
              ui.toolbar(ui.grow(ui.field('关键词 q', qInput)), ui.actions(searchBtn, mountBtn)),
              entriesBox),
            ui.sectionCard('记忆体 · 写入',
              ui.toolbar(ui.field('记忆流 stream', streamSelect), ui.field('权威 authority', authoritySelect)),
              h('div', { class: 'form-grid form-grid-1' }, ui.field('内容 content', contentInput)),
              ui.toolbar(writeBtn),
              d.home ? h('details', { class: 'collapse' },
                h('summary', { text: '记忆体目录（$DSH_HOME/ideas）' }),
                h('pre', { class: 'tl-payload', text: safeJson(d.home) })) : null)),
          ui.sectionCard('工作区（MVP 开发文件）', wsBox));
      }, '创意详情加载失败');
    }

    render(box,
      ui.pageTitle('我的创意', '每个创意都是独立的生命体：自己的三域描述、自己的记忆体'),
      ui.sectionCard('创意库', listBox, mountLine),
      detailBox);

    await Promise.all([loadList(), refreshMounted()]);
  };

  /* ===== 面板：创意市场（prd2.md 6：浏览/检索/关注/关联/排行/协同） ===== */
  const CONSOLE_FOLLOWER = 'console-user';

  ROUTES.market = async box => {
    const searchInput = h('input', { class: 'input', placeholder: '搜创意：问题域 / 解决域 / 时空域关键词' }),
      stageSelect = h('select', { class: 'input' },
        h('option', { value: '', text: '全部阶段' }),
        ...IDEA_STAGES.map(s => h('option', { value: s, text: IDEA_STAGE_LABELS[s] }))),
      searchBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '搜创意' }),
      listTitle = h('h3', { class: 'card-title', text: '全网创意' }),
      listBox = h('div'),
      rankBox = h('div'),
      notifBox = h('div');

    const renderList = ideas => render(listBox, ideas.length
      ? h('div', { class: 'card-grid' }, ideas.map(idea => h('div', { class: 'card memory-card' },
          h('div', { class: 'memory-head' },
            h('strong', { text: idea.name }),
            ui.badge(IDEA_STAGE_LABELS[idea.stage] || idea.stage, 'info')),
          h('p', { class: 'memory-content', text: idea.problemSummary || idea.solutionSummary || '—' }),
          h('div', { class: 'stat-sub' },
            `关注 ${num(idea.followers)} · 资产 ${money(idea.financeTotalCents)} · GEO ${Math.round((idea.geoVisibility || 0) * 100)}%`),
          h('div', { class: 'toolbar-actions' },
            h('button', {
              class: 'btn btn-sm', type: 'button', text: '+ 关注',
              onclick: async () => {
                await api.post(`/api/market/ideas/${idea.ideaId}/follow`, { follower: CONSOLE_FOLLOWER });
                toast.ok(`已关注「${idea.name}」：阶段变更会通知你`);
                search();
              },
            }),
            h('a', { class: 'btn btn-sm', href: '#/ideas', text: '去详情' })))))
      : ui.empty('还没有发布到市场的创意——在「我的创意」详情里点「发布到市场」'));

    const search = () => loadInto(listBox, '检索中…', async () => {
      const params = new URLSearchParams();
      const q = searchInput.value.trim();
      if (q) params.set('q', q);
      if (stageSelect.value) params.set('stage', stageSelect.value);
      params.set('limit', '50');
      const res = await api.get(`/api/market/ideas?${params.toString()}`);
      renderList(res.ideas || []);
      listTitle.textContent = q || stageSelect.value ? `全网创意（命中 ${res.ideas.length}）` : '全网创意';
    }, '创意市场检索失败');
    searchBtn.addEventListener('click', search);
    onEnter(searchInput, search);
    stageSelect.addEventListener('change', search);

    const renderRank = data => {
      const rows = by => (data && data[by] || []).map((s, i) => [i + 1, s.name, IDEA_STAGE_LABELS[s.stage] || s.stage,
        by === 'assets' ? money(s.financeTotalCents) : by === 'community' ? `${num(s.followers)} 关注` : `${Math.round((s.geoVisibility || 0) * 100)}%`]);
      render(rankBox, h('div', { class: 'three-col' },
        ui.sectionCard('资产榜', ui.table(['#', '创意', '阶段', '收入'], rows('assets'))),
        ui.sectionCard('社区榜', ui.table(['#', '创意', '阶段', '热度'], rows('community'))),
        ui.sectionCard('GEO 榜', ui.table(['#', '创意', '阶段', '可见性'], rows('geo')))));
    };
    const loadRank = () => api.get('/api/market/rankings').then(renderRank).catch(() => renderRank(null));
    const loadNotif = () => loadInto(notifBox, null, async () => {
      const res = await api.get(`/api/notifications?follower=${CONSOLE_FOLLOWER}`);
      const items = res.notifications || [];
      return items.length
        ? h('ul', { class: 'timeline' }, items.map(n => h('li', { class: 'timeline-item' },
            h('div', { class: 'tl-head' }, h('code', { class: 'tl-type', text: n.ideaId }),
              h('span', { class: 'tl-time', text: fmtTime(n.at) }))),
            h('p', { class: 'memory-content', text: n.message })))
        : ui.empty('暂无通知——关注创意后，阶段变更会第一时间告诉你');
    }, '通知加载失败');

    render(box,
      ui.pageTitle('创意市场', '看别人的创意走到哪了，关注它、和它协同'),
      ui.sectionCard(null,
        ui.toolbar(ui.grow(ui.field('关键词 q', searchInput)), ui.field('阶段', stageSelect), ui.actions(searchBtn)),
        listTitle,
        listBox),
      h('p', { class: 'muted small', style: 'margin:0' }, '我的通知'),
      notifBox,
      rankBox);

    await Promise.all([search(), loadRank(), loadNotif()]);
  };

  /* ===== 面板：团队 ===== */
  ROUTES.team = async box => {
    const goalInput = h('input', { class: 'input', type: 'text', placeholder: '例如：帮我做一个跨境电商独立站' }),
      submitBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '组队开工' }),
      resultBox = h('div'),
      templatesBox = h('div', { class: 'card section-card hidden' });
    let templatesLoaded = false;
    const renderTeam = team => {
      const roles = (team && team.roles) || [];
      render(resultBox,
        roles.length
          ? h('div', { class: 'card-grid' }, roles.map((r, i) => {
              const name = typeof r === 'string' ? r : (r.name || r.role || r.title || `角色 ${i + 1}`);
              const desc = typeof r === 'string' ? '' : (r.description || r.duty || r.responsibility || '');
              return h('div', { class: 'card role-card' },
                h('div', { class: 'role-avatar', text: String(name).slice(0, 1) }),
                h('div', { class: 'role-name', text: name }),
                desc ? h('p', { class: 'role-desc', text: desc }) : null);
            }))
          : ui.empty('解析结果为空'),
        h('p', { class: 'muted', text: `目标：${(team && team.goal) || '—'} · 团队规模 ${(team && team.teamSize) ?? roles.length} · 创建于 ${fmtTime(team && team.createdAt)}` }));
    };
    /** 解析失败 → 降级为行业模板选择（点击把模板名填回输入框） */
    async function loadTemplates() {
      if (templatesLoaded) return;
      try {
        const list = await api.get('/api/team/templates');
        const templates = Array.isArray(list) ? list : (list.templates || []);
        render(templatesBox, h('p', { class: 'muted', text: '目标解析失败，请选择行业模板后重试：' }),
          h('div', { class: 'chip-row' }, templates.map(t => h('button', {
            class: 'chip', type: 'button', text: t.label || t.id || '模板',
            onclick: () => { goalInput.value = t.label || t.id || ''; goalInput.focus(); },
          }))));
        templatesLoaded = true;
      } catch { /* 模板列表加载失败则保持隐藏 */ }
    }
    busyBtn(submitBtn, '解析中…', async () => {
      const goal = goalInput.value.trim();
      if (!goal) return toast.err('请先输入创业目标');
      try {
        const team = await api.post('/api/team', { goal });
        renderTeam(team);
        templatesBox.classList.add('hidden');
        toast.ok(`团队已组建：${((team && team.roles) || []).length} 个角色`);
      } catch {
        await loadTemplates();
        templatesBox.classList.remove('hidden');
      }
    });
    render(box,
      ui.pageTitle('AI 团队', '说一句目标，团队替你把活干了'),
      ui.sectionCard(null,
        ui.toolbar(ui.grow(ui.field('创业目标', goalInput)), ui.actions(submitBtn)),
        h('p', { class: 'muted', text: '解析失败时将降级为行业模板选择（跨境电商创业团队、独立开发者团队等）。' })),
      templatesBox, resultBox);
  };

  /* ===== 面板：共享任务板（AS-04） ===== */
  const TASK_BADGE = { pending: 'info', claimed: 'warn', done: 'ok', blocked: 'err' };
  ROUTES.board = async box => {
    const memberInput = h('input', { class: 'input', value: 'op', placeholder: '认领/完成时使用的成员 ID' }),
      titleInput = h('input', { class: 'input', placeholder: '新任务标题，如：整理竞品清单' }),
      addBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '添加任务' }),
      statsBox = h('div'),
      listBox = h('div');
    const member = () => memberInput.value.trim() || 'op';
    /** 乐观锁冲突：toast 当前快照（后端 409 error.current）并刷新 */
    const onConflict = err => {
      if (err && err.code === 'VERSION_CONFLICT') {
        const cur = err.current || {};
        toast.info(`这条任务刚被别人更新了（v${cur.version ?? '?'}），已为你刷新最新状态`);
        load();
        return true;
      }
      return false;
    };
    /** 行内变更按钮：点击禁用 → 变更 → 刷新；错误 api 层已 toast，冲突补 current 快照提示 */
    function actionBtn(label, onClick) {
      const btn = h('button', { class: 'btn btn-sm', type: 'button', text: label });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await onClick(); } catch (err) { onConflict(err); }
        finally { btn.disabled = false; }
      });
      return btn;
    }
    function taskActions(t) {
      const mutate = (path, extra) => api.post(`/api/board/${path}`, { taskId: t.id, member: member(), expectedVersion: t.version, ...extra });
      const buttons = [];
      if (t.status === 'pending') {
        buttons.push(actionBtn('认领', async () => {
          const task = await mutate('claim');
          toast.ok(`已认领：${t.title}（${task.claimedBy || member()}）`);
          load();
        }));
      }
      if (t.status === 'claimed') {
        buttons.push(actionBtn('完成', async () => {
          const result = window.prompt(`交付结果 result（${t.title}）`, '已完成');
          if (result === null) return;
          await mutate('complete', { result: result.trim() || '已完成' });
          toast.ok(`任务完成：${t.title}`);
          load();
        }));
      }
      if (t.status !== 'blocked') {
        buttons.push(actionBtn('阻塞', async () => {
          const reason = window.prompt(`阻塞原因（${t.title}）`, '等待外部资源');
          if (reason === null) return;
          await mutate('block', { reason: reason.trim() || '未填写原因' });
          toast.info(`任务已阻塞：${t.title}`);
          load();
        }));
      }
      return buttons.length
        ? h('div', { class: 'row-actions' }, ...buttons)
        : h('span', { class: 'muted', text: '—' });
    }
    function renderBoard(data) {
      const tasks = (data && data.tasks) || [];
      const stats = (data && data.stats) || {};
      render(statsBox, h('div', { class: 'card-grid' }, [
        ui.statCard('待认领 · pending', num(stats.pending), `共 ${num(stats.total)} 项任务`),
        ui.statCard('进行中 · claimed', num(stats.claimed)),
        ui.statCard('已完成 · done', num(stats.done)),
        ui.statCard('已阻塞 · blocked', num(stats.blocked)),
      ]));
      render(listBox, tasks.length
        ? ui.table(['任务', '状态', '认领者', '版本', '更新时间', '操作'],
            tasks.map(t => [
              h('span', { text: t.title }),
              ui.badge(String(t.status || 'unknown'), TASK_BADGE[t.status] || 'muted'),
              t.claimedBy || '—',
              t.version != null ? `v${t.version}` : '—',
              fmtTime(t.updatedAt),
              taskActions(t),
            ]))
        : ui.empty('还没有任务——把下一个创意拆成一件可认领的事'));
    }
    const load = async () => {
      listBox.innerHTML = '';
      listBox.append(ui.loading());
      try { renderBoard(await api.get('/api/board')); }
      catch { render(listBox, ui.empty('任务板加载失败，请稍后重试')); }
    };
    const quiet = async () => {
      try { renderBoard(await api.get('/api/board')); } catch { /* 轮询失败静默，保留上一帧 */ }
    };
    busyBtn(addBtn, '添加中…', async () => {
      const title = titleInput.value.trim();
      if (!title) return toast.err('请填写任务标题');
      await api.post('/api/board/add', { title });
      toast.ok(`任务已添加：${title}`);
      titleInput.value = '';
      load();
    });
    onEnter(titleInput, () => addBtn.click());
    render(box,
      ui.pageTitle('共享任务板', '团队在为你的创意干活——谁认领了什么一目了然'),
      ui.sectionCard(null,
        ui.toolbar(ui.grow(ui.field('任务标题', titleInput)), ui.grow(ui.field('当前成员', memberInput)),
          ui.actions(addBtn))),
      statsBox,
      listBox);
    await load();
    autoPoll(listBox, quiet);
  };

  /* ===== 面板：黑板 ===== */
  ROUTES.blackboard = async box => {
    let scope = 'global';
    const listBox = h('div'),
      scopeLabel = h('code', { class: 'chip-static', text: 'global' }),
      tabButtons = {};
    const load = () => loadInto(listBox, null, async () => {
      const entries = (((await api.get(`/api/blackboard?scope=${scope}`)) || {}).entries) || [];
      return entries.length
        ? ui.table(['Key', '版本', '写入者', '更新时间', '值'], entries.map(e => [
            h('code', { class: 'key-code', text: e.key }), `v${e.version ?? 0}`,
            `${e.writer || '—'}${e.role ? `（${e.role}）` : ''}`, fmtTime(e.updatedAt),
            ui.jsonBox(e.value),
          ]))
        : ui.empty('黑板还是空的——orchestrator 的第一条规则从这里写起');
    }, '黑板加载失败，请稍后重试');
    function switchScope(s) {
      scope = s;
      scopeLabel.textContent = s;
      Object.entries(tabButtons).forEach(([key, btn]) => btn.classList.toggle('active', key === s));
      load();
    }
    // 写入表单（乐观锁：expectedVersion，默认 0）
    const keyInput = h('input', { class: 'input', placeholder: '键名，如 competitor-findings' }),
      valueInput = h('textarea', { class: 'input', rows: 4, placeholder: '{"summary":"..."}' }),
      writerInput = h('input', { class: 'input', value: 'orchestrator', placeholder: '写入者 ID' }),
      versionInput = h('input', { class: 'input', type: 'number', min: '0', step: '1', value: '0' }),
      roleSelect = h('select', { class: 'input' },
        h('option', { value: 'orchestrator', text: 'orchestrator（全局可写）' }),
        h('option', { value: 'agent', text: 'agent（仅 workflow）' })),
      writeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '写到黑板' });
    valueInput.value = '{}';
    busyBtn(writeBtn, '写入中…', async () => {
      const key = keyInput.value.trim();
      if (!key) return toast.err('请填写 key');
      let value;
      try { value = JSON.parse(valueInput.value || 'null'); }
      catch { return toast.err('value 必须是合法 JSON'); }
      const res = await api.post('/api/blackboard', {
        scope, key, value,
        writer: writerInput.value.trim() || 'console',
        role: roleSelect.value,
        expectedVersion: Number(versionInput.value) || 0,
      });
      if (res && res.status === 'conflict') {
        const winner = res.winner || {};
        toast.err(`这条黑板条目刚被别人更新了（当前 v${winner.version ?? '?'}，writer=${winner.writer || '—'}），已为你回填版本号，可重试`);
        versionInput.value = String(winner.version ?? 0);
      } else {
        const entry = res.entry || {};
        toast.ok(`写入成功：${key} → v${entry.version ?? '?'}`);
        versionInput.value = String(entry.version ?? 0);
      }
      load();
    });
    render(box,
      ui.pageTitle('共享黑板', '团队的公共记忆墙，谁写了什么都能看见'),
      h('div', { class: 'tabs' }, ...['global', 'workflow'].map(s =>
        (tabButtons[s] = h('button', {
          class: 'tab', type: 'button',
          text: s === 'global' ? 'Global · 全局' : 'Workflow · 任务',
          onclick: () => switchScope(s),
        })))),
      listBox,
      ui.sectionCard(null,
        h('h3', { class: 'card-title' }, '写入黑板 · scope ', scopeLabel),
        ui.formGrid(ui.field('Key', keyInput), ui.field('写入者 writer', writerInput),
          ui.field('角色 role', roleSelect), ui.field('期望版本 expectedVersion', versionInput)),
        h('div', { class: 'form-grid form-grid-1' }, ui.field('Value（JSON）', valueInput)),
        ui.toolbar(writeBtn),
        h('p', { class: 'muted', text: 'global 作用域仅 orchestrator 可写；workflow 作用域参与任务的 Agent 可读写。' })));
    switchScope('global');
  };

  /* ===== 面板：Skill 市场 ===== */
  ROUTES.skills = async box => {
    const qInput = h('input', { class: 'input', placeholder: '按名称搜索' }),
      categoryInput = h('input', { class: 'input', placeholder: '类别，如 automation' }),
      compatInput = h('input', { class: 'input', placeholder: 'DSH 版本，如 0.1.5' }),
      stageSelect = h('select', { class: 'input' },
        h('option', { value: '', text: '全部阶段' }),
        ...IDEA_STAGES.map(s => h('option', { value: s, text: IDEA_STAGE_LABELS[s] }))),
      targetSelect = h('select', { class: 'input' }, h('option', { value: '', text: '个人（全局）' })),
      searchBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '搜索' }),
      totalText = h('span', { class: 'muted small' }),
      tableBox = h('div'), draftsBox = h('div'), publishBox = h('div');
    // 安装目标：个人或我的某个创意（SM-02 安装到创意子操作系统）
    api.get('/api/ideas').then(data => {
      for (const idea of (data && data.ideas) || []) {
        targetSelect.append(h('option', { value: idea.id, text: `创意：${idea.name}` }));
      }
    }).catch(() => { /* 创意库缺席：仅个人 */ });
    const kv = (k, v) => h('div', { class: 'kv' },
      h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: v }));
    const PRICING_LABELS = { free: '免费', one_time: '一次性', subscription: '订阅' };
    function pricingCell(skill) {
      const pricing = skill.pricing || { model: skill.price === 0 ? 'free' : 'one_time' };
      const modelText = PRICING_LABELS[pricing.model] || pricing.model || '一次性';
      const periodText = pricing.period === 'monthly' ? '·月' : pricing.period === 'quarterly' ? '·季' : pricing.period === 'yearly' ? '·年' : '';
      return `${modelText}${periodText} ${money(skill.price)}`;
    }
    function installButton(skill) {
      const isSub = (skill.pricing || {}).model === 'subscription';
      const btn = h('button', { class: 'btn btn-sm', type: 'button', text: isSub ? '安装（校验订阅）' : '安装' });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '安装中…';
        try {
          const res = await api.post('/api/skills/install', {
            skillId: skill.id,
            ...(targetSelect.value ? { ideaId: targetSelect.value } : {}),
            ...(currentUser ? { buyerId: currentUser.username } : {}),
          });
          toast.ok(`安装成功：${res && res.installedPath}${res && res.ideaId ? '（已装入创意子操作系统）' : ''}`);
          btn.textContent = '已安装';
        } catch (err) {
          btn.disabled = false; btn.textContent = '重试';
          if (err && err.code === 'SUBSCRIPTION_REQUIRED') toast.err('需要有效订阅：请先在订单页订阅该技能');
        }
      });
      return btn;
    }
    function subscribeButton(skill) {
      const btn = h('button', { class: 'btn btn-sm', type: 'button', text: '订阅' });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '订阅中…';
        try {
          const buyerId = (currentUser && currentUser.username) || `buyer-${skill.id}`;
          const order = await api.post('/api/orders', {
            skillId: skill.id,
            version: skill.version,
            buyerId,
            amountCents: skill.price || 990,
          });
          const paid = await api.post('/api/orders/pay', { orderId: order.id });
          toast.ok(paid.subscription
            ? `订阅生效，权益至 ${fmtTime(paid.subscription.expiresAt)}`
            : '支付成功');
          search();
        } catch { btn.disabled = false; btn.textContent = '订阅'; }
      });
      return btn;
    }
    const search = () => loadInto(tableBox, '搜索中…', async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (qInput.value.trim()) params.set('q', qInput.value.trim());
      if (categoryInput.value.trim()) params.set('category', categoryInput.value.trim());
      if (compatInput.value.trim()) params.set('compat', compatInput.value.trim());
      if (stageSelect.value) params.set('stage', stageSelect.value);
      const data = await api.get(`/api/skills?${params.toString()}`);
      const results = (data && data.results) || [];
      totalText.textContent = `共 ${data && data.total != null ? data.total : results.length} 个 Skill`;
      return results.length
        ? ui.table(['名称', '版本', '作者', '定价', '阶段', '下载', '评分', '兼容', '操作'],
            results.map(s => [
              s.name, s.version, s.authorId, pricingCell(s),
              s.stage ? (IDEA_STAGE_LABELS[s.stage] || s.stage) : '—',
              num(s.downloads),
              s.rating != null ? `${Number(s.rating).toFixed(1)} / 5` : '—',
              (s.compat && s.compat.dsh) || '—',
              h('div', { class: 'row-actions' },
                (s.pricing || {}).model === 'subscription' ? subscribeButton(s) : null,
                installButton(s)),
            ]))
        : ui.empty('货架还是空的——跑几次内容流水线，本能系统会替你蒸馏出第一个技能');
    }, '搜索失败，请稍后重试');
    const loadDrafts = () => loadInto(draftsBox, null, async () => {
      const drafts = (((await api.get('/api/skillforge/drafts')) || {}).drafts) || [];
      if (!drafts.length) return ui.empty('暂无 Skill 草案（重复执行相似工作流后将自动蒸馏）');
      return h('div', { class: 'card-grid' }, drafts.map(d => {
        const def = d.skillDefinition || {};
        return h('div', { class: 'card' },
          h('div', { class: 'role-name', text: `${d.name || '未命名'} v${d.version || '?'}` }),
          kv('触发', def.trigger || '—'),
          kv('工具序列', Array.isArray(def.toolSequence) && def.toolSequence.length
            ? def.toolSequence.join(' → ') : '—'),
          kv('完成条件', def.postConditions || '—'));
      }));
    }, '草案加载失败');
    /** 草案→上架工作流：每条草案一键发布为 community 分类市场技能（定价 ¥9.90） */
    const loadPublish = () => loadInto(publishBox, null, async () => {
      const drafts = (((await api.get('/api/skillforge/drafts')) || {}).drafts) || [];
      if (!drafts.length) return ui.empty('暂无草案：重复执行相似工作流自动蒸馏出草案后，可在此一键上架');
      return h('div', { class: 'card-grid' }, drafts.map(d => {
        const def = d.skillDefinition || {};
        const btn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '上架收钱' });
        busyBtn(btn, '上架中…', async () => {
          const res = await api.post('/api/skills/publish-draft', {});
          toast.ok(`「${res && res.skillId}」已上架，定价 ${money(990)}——去货架看看`);
          await Promise.all([loadPublish(), search()]);
        });
        return h('div', { class: 'card' },
          h('div', { class: 'role-name', text: `${d.name || '未命名'} v${d.version || '?'}` }),
          kv('触发', def.trigger || '—'),
          kv('工具序列', Array.isArray(def.toolSequence) && def.toolSequence.length
            ? def.toolSequence.join(' → ') : '—'),
          h('div', { class: 'publish-actions' }, btn,
            h('span', { class: 'muted small', text: '重新 Ed25519 签名后写入市场索引（community · ¥9.90）' })));
      }));
    }, '草案加载失败');
    searchBtn.addEventListener('click', search);
    onEnter(qInput, search);
    stageSelect.addEventListener('change', search);
    render(box,
      ui.pageTitle('上货架', '你的重复劳动，别人愿意付钱'),
      ui.sectionCard('从草案上架（草案 → 签名包 → 市场索引）', publishBox),
      ui.sectionCard(null,
        ui.toolbar(ui.field('关键词 q', qInput), ui.field('类别 category', categoryInput),
          ui.field('生命周期阶段 stage', stageSelect), ui.field('兼容版本 compat', compatInput),
          ui.actions(searchBtn, totalText),
          h('span', { class: 'muted small', text: '安装到：' }), targetSelect)),
      tableBox,
      ui.sectionCard('Skill 草案（本能提炼）', draftsBox));
    await Promise.all([search(), loadDrafts(), loadPublish()]);
  };

  /* ===== 面板：订单交易 ===== */
  const isUnpaid = status => !['paid', 'completed', 'succeeded', 'refunded'].includes(String(status || ''));
  ROUTES.orders = async box => {
    const defaultBuyer = (currentUser && currentUser.username) || 'buyer-001';
    const skillMeta = new Map(),
      skillSelect = h('select', { class: 'input' }, h('option', { value: '', text: '加载 Skill 列表…' })),
      buyerInput = h('input', { class: 'input', value: defaultBuyer, placeholder: '买家 ID' }),
      amountInput = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: '100' }),
      orderBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '创建订单' }),
      splitBox = h('div'),
      listBuyerInput = h('input', { class: 'input', value: defaultBuyer, placeholder: '必填：按 buyerId 过滤' }),
      refreshBtn = h('button', { class: 'btn', type: 'button', text: '查询订单' }),
      listBox = h('div'),
      subBuyerInput = h('input', { class: 'input', value: defaultBuyer, placeholder: '买家 ID' }),
      subRefreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新订阅' }),
      subListBox = h('div');
    skillSelect.addEventListener('change', () => {
      const s = skillMeta.get(skillSelect.value);
      if (s && s.price != null) amountInput.value = String(s.price);
    });
    async function loadSkillOptions() {
      try {
        const data = await api.get('/api/skills?limit=100');
        render(skillSelect, h('option', { value: '', text: '选择 Skill…' }),
          ...((data && data.results) || []).map(s => {
            skillMeta.set(s.id, s);
            return h('option', { value: s.id, text: `${s.name} v${s.version} · ${money(s.price)}` });
          }));
      } catch {
        render(skillSelect, h('option', { value: '', text: 'Skill 列表加载失败' }));
      }
    }
    function renderSplit(order, split) {
      const item = (v, label, ok) => h('div', { class: 'split-item' },
        h('div', { class: `split-amount${ok ? ' ok-text' : ''}`, text: v }),
        h('div', { class: 'stat-label', text: label }));
      render(splitBox, h('div', { class: 'card split-card' },
        h('p', { class: 'split-title', text: `订单 ${order && order.id} 支付成功，分成明细：` }),
        h('div', { class: 'split-row' },
          item(money(split && split.creator), '创作者分成（85%）', true),
          item(money(split && split.platform), '平台分成（15%）'))));
    }
    function payButton(order) {
      const btn = h('button', { class: 'btn btn-sm', type: 'button', text: '支付' });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '支付中…';
        try {
          const res = await api.post('/api/orders/pay', { orderId: order.id });
          renderSplit(res && res.order, res && res.split);
          toast.ok(`收到 ${money(res && res.order && res.order.amount)}！创作者分得 ${money(res && res.split && res.split.creator)}，平台 ${money(res && res.split && res.split.platform)}`);
          loadOrders();
        } catch { btn.disabled = false; btn.textContent = '支付'; }
      });
      return btn;
    }
    const loadOrders = () => loadInto(listBox, null, async () => {
      // 后端契约：GET /api/orders 必须携带 buyerId（留空时回退到下单表单中的买家）
      const buyerId = listBuyerInput.value.trim() || buyerInput.value.trim();
      if (!buyerId) {
        toast.err('请填写按买家过滤的 buyerId（后端必填）');
        return ui.empty('查询订单需要 buyerId');
      }
      const data = await api.get(`/api/orders?buyerId=${encodeURIComponent(buyerId)}`);
      const orders = ((data || {}).orders) || [];
      return orders.length
        ? ui.table(['订单 ID', 'Skill', '买家', '金额', '状态', '创建时间', '操作'],
            orders.map(o => [
              h('code', { class: 'key-code', text: o.id }), o.skillId || '—', o.buyerId || '—',
              o.amount != null ? money(o.amount) : '—', statusBadge(o.status),
              o.createdAt ? fmtTime(o.createdAt) : '—',
              isUnpaid(o.status) ? payButton(o) : '—',
            ]))
        : ui.empty('还没有订单——把货架链接发给潜在买家');
    }, '订单加载失败');
    busyBtn(orderBtn, '下单中…', async () => {
      const skillId = skillSelect.value;
      if (!skillId) return toast.err('请选择要购买的 Skill');
      const buyerId = buyerInput.value.trim();
      if (!buyerId) return toast.err('请填写买家 ID');
      const amountCents = Number(amountInput.value);
      if (!Number.isInteger(amountCents) || amountCents <= 0) return toast.err('金额（分）必须是正整数');
      const order = await api.post('/api/orders', {
        skillId,
        version: (skillMeta.get(skillId) || {}).version || '1.0.0',
        buyerId,
        amountCents,
      });
      toast.ok(`订单已创建：${order && order.id}`);
      listBuyerInput.value = buyerId;
      loadOrders();
    });
    refreshBtn.addEventListener('click', loadOrders);
    /* 我的订阅（SM-04）：权益窗口 + 一键续订（按市场价下单并支付，自动顺延） */
    const PERIOD_LABELS = { monthly: '包月', quarterly: '季付', yearly: '年付' };
    const loadSubs = () => loadInto(subListBox, null, async () => {
      const buyerId = subBuyerInput.value.trim();
      if (!buyerId) return ui.empty('填写买家 ID 查看订阅权益');
      const res = await api.get(`/api/subscriptions?buyerId=${encodeURIComponent(buyerId)}`);
      const subs = (res && res.subscriptions) || [];
      if (!subs.length) return ui.empty('暂无订阅——购买订阅制 Skill 后自动生效');
      return ui.table(['Skill', '周期', '到期时间', '状态', '操作'], subs.map(s => [
        s.skillId,
        PERIOD_LABELS[s.period] || s.period,
        fmtTime(s.expiresAt),
        s.active ? ui.badge('生效中', 'ok') : ui.badge('已到期', 'err'),
        (() => {
          const btn = h('button', { class: 'btn btn-sm', type: 'button', text: s.active ? '续订' : '重新订阅' });
          btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '续订中…';
            try {
              const detail = await api.get(`/api/skills/${s.skillId}`);
              const order = await api.post('/api/orders', {
                skillId: s.skillId,
                version: (detail.skill && detail.skill.version) || '1.0.0',
                buyerId,
                amountCents: (detail.skill && detail.skill.price) || 990,
              });
              const paid = await api.post('/api/orders/pay', { orderId: order.id });
              toast.ok(paid.subscription
                ? `续订成功，权益至 ${fmtTime(paid.subscription.expiresAt)}`
                : '支付成功');
              loadSubs();
            } catch { btn.disabled = false; btn.textContent = s.active ? '续订' : '重新订阅'; }
          });
          return btn;
        })(),
      ]));
    }, '订阅加载失败');
    subRefreshBtn.addEventListener('click', loadSubs);
    render(box,
      ui.pageTitle('订单', '每一笔确认的订单，创作者拿 85%'),
      ui.sectionCard('下单',
        ui.toolbar(ui.grow(ui.field('Skill', skillSelect)), ui.field('买家 buyerId', buyerInput),
          ui.field('金额（分）', amountInput), ui.actions(orderBtn))),
      splitBox,
      ui.sectionCard('我的订阅',
        ui.toolbar(ui.grow(ui.field('买家 buyerId', subBuyerInput)), ui.actions(subRefreshBtn)),
        subListBox),
      ui.sectionCard('订单列表',
        ui.toolbar(ui.grow(ui.field('按买家过滤', listBuyerInput)), ui.actions(refreshBtn)),
        listBox));
    await Promise.all([loadSkillOptions(), loadOrders(), loadSubs()]);
  };

  /* ===== 面板：创作者中心（SF-07） ===== */
  ROUTES.creators = async box => {
    const listBox = h('div'),
      detailTitle = h('h3', { class: 'card-title', text: '分成流水' }),
      detailBox = h('div');
    /** 点击创作者卡片 → 展开该作者的分成流水表（高亮当前卡片） */
    const loadDetail = authorId => {
      $$('.creator-card', listBox).forEach(c => c.classList.toggle('active', c.dataset.author === authorId));
      detailTitle.textContent = `分成流水 · ${authorId}`;
      loadInto(detailBox, null, async () => {
        const data = await api.get(`/api/creators/${encodeURIComponent(authorId)}`);
        const entries = (data && data.entries) || [];
        if (!entries.length) return ui.empty('该创作者暂无分成流水');
        return [
          h('div', { class: 'big-number', style: 'margin:2px 0 4px', text: money(data && data.balance) }),
          h('div', { class: 'stat-label', style: 'margin-bottom:12px', text: '累计未提取余额（85% 分成，单位：分）' }),
          ui.table(['订单 ID', '订单金额', '创作者分成', '平台分成', '入账时间'],
            entries.map(e => [
              h('code', { class: 'key-code', text: e.orderId }), money(e.amount),
              h('span', { class: 'ok-text', text: money(e.creator) }), money(e.platform), fmtTime(e.recordedAt),
            ])),
        ];
      }, '分成流水加载失败');
    };
    const loadCreators = () => loadInto(listBox, null, async () => {
      const creators = (((await api.get('/api/creators')) || {}).creators) || [];
      if (!creators.length) return ui.empty('还没有分成入账——上架第一个技能就开始累计');
      return h('div', { class: 'card-grid creator-grid' }, creators.map(c => {
        const card = h('div', { class: 'card creator-card', role: 'button', tabindex: '0', 'data-author': c.authorId },
          h('div', { class: 'role-name', text: c.authorId }),
          h('div', { class: 'big-number', text: money(c.balance) }),
          h('div', { class: 'stat-label', text: '累计未提取余额（分）' }),
          h('div', { class: 'stat-sub', text: `分成 ${num(c.splits)} 笔 · 最近入账 ${fmtTime(c.lastAt)}` }));
        const open = () => loadDetail(c.authorId);
        card.addEventListener('click', open);
        card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
        return card;
      }));
    }, '创作者列表加载失败');
    render(box,
      ui.pageTitle('创作者中心', '你赚到的每一笔，都在这里'),
      listBox,
      ui.sectionCard(null, detailTitle, detailBox));
    await loadCreators();
  };

  /* ===== 面板：客户账单（DE-08） ===== */
  ROUTES.bills = async box => {
    const summaryBox = h('div'),
      buyerSelect = h('select', { class: 'input' }, h('option', { value: '', text: '从已成交买家中选择…' })),
      buyerInput = h('input', { class: 'input', placeholder: '或输入任意买家 ID 查询' }),
      queryBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '查询账单' }),
      listBox = h('div');
    const loadSummary = () => loadInto(summaryBox, null, async () => {
      const s = await api.get('/api/bills/summary');
      render(buyerSelect, h('option', { value: '', text: '从已成交买家中选择…' }),
        ...((s && s.buyers) || []).map(b => h('option', { value: b.buyerId, text: `${b.buyerId}（${money(b.spent)}）` })));
      if (!s || (!s.totalBuyers && !s.totalOrders)) return ui.empty('还没有客户消费记录');
      return h('div', { class: 'card-grid' }, [
        ui.statCard('总买家数（已成交）', num(s.totalBuyers)),
        ui.statCard('总订单 · 支付成功口径', `${num(s.totalOrders)} 笔`, '含其后退款（stats.totalPaid）'),
        ui.statCard('订单净额 · paid+delivered', money(s.orderNetAmountCents), `${num(s.orderNetCount)} 笔 · 单位：分`),
        ui.statCard('RaaS 计费收入', yuan(s.raasRevenueYuan), '单位：元'),
        ui.statCard('总收入（订单净额 + RaaS）', yuan(s.totalRevenueYuan), '单位：元'),
      ]);
    }, '账单汇总加载失败');
    const loadBills = () => loadInto(listBox, null, async () => {
      const buyerId = buyerInput.value.trim() || buyerSelect.value;
      if (!buyerId) return ui.empty('请先在上方选择或输入买家 ID');
      const data = await api.get(`/api/bills?buyerId=${encodeURIComponent(buyerId)}`);
      const orders = (data && data.orders) || [];
      if (!orders.length) return ui.empty(`买家 ${data && data.buyerId} 暂无订单`);
      return [
        h('p', { class: 'result-line' },
          `买家 ${data.buyerId} · 共 ${orders.length} 笔订单 · 总消费 `,
          h('strong', { class: 'ok-text', text: money(data.totalSpent) })),
        h('p', { class: 'muted small', style: 'margin:4px 0 10px', text: '总消费口径：paid + delivered 订单金额合计（pending / refunded / cancelled 不计入），单位：分' }),
        ui.table(['订单 ID', 'Skill', '版本', '金额', '状态', '下单时间'],
          orders.map(o => [
            h('code', { class: 'key-code', text: o.id }), o.skillId || '—', o.version || '—',
            money(o.amount), statusBadge(o.status), fmtTime(o.createdAt),
          ])),
      ];
    }, '账单加载失败');
    buyerSelect.addEventListener('change', () => {
      if (buyerSelect.value) { buyerInput.value = buyerSelect.value; loadBills(); }
    });
    busyBtn(queryBtn, '查询中…', loadBills);
    onEnter(buyerInput, loadBills);
    render(box,
      ui.pageTitle('客户账单', '客户为结果付费的明细，随时对账'),
      summaryBox,
      ui.sectionCard('按买家查询',
        ui.toolbar(ui.grow(ui.field('已成交买家', buyerSelect)), ui.grow(ui.field('买家 ID', buyerInput)),
          ui.actions(queryBtn))),
      listBox);
    await loadSummary();
  };

  /* ===== 面板：RaaS 计费 ===== */
  ROUTES.billing = async box => {
    const taskIdInput = h('input', { class: 'input', placeholder: 'task_20260915_001' }),
      agentIdInput = h('input', { class: 'input', value: 'customer-service-acme', placeholder: '数字员工 agentId' }),
      resolutionSelect = h('select', { class: 'input' },
        h('option', { value: 'resolved', text: 'resolved · 自主解决（计费）' }),
        h('option', { value: 'escalated', text: 'escalated · 转人工（免费）' })),
      completeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '结算这一单' }),
      resultBox = h('div'), summaryBox = h('div');
    const loadSummary = () => loadInto(summaryBox, null, async () => {
      const data = await api.get('/api/billing/summary');
      const records = ((data || {}).records) || [];
      return h('div', {},
        h('div', { class: 'big-number', text: yuan(data && data.totalRevenue) }),
        h('div', { class: 'stat-label', style: 'margin-bottom:14px', text: 'RaaS 总收入' }),
        records.length
          ? ui.table(['任务 ID', '处理结果', '金额'],
              records.map(r => [
                h('code', { class: 'key-code', text: r.taskId }), resolutionBadge(r.resolution), yuan(r.amount),
              ]))
          : ui.empty('还没有计费记录——数字员工每自主解决一单 ¥2.50'));
    }, '计费汇总加载失败');
    busyBtn(completeBtn, '结算中…', async () => {
      const taskId = taskIdInput.value.trim();
      if (!taskId) return toast.err('请填写 taskId');
      const res = await api.post('/api/billing/complete', {
        taskId,
        agentId: agentIdInput.value.trim() || 'unknown-agent',
        resolution: resolutionSelect.value,
      });
      render(resultBox, h('p', { class: 'result-line' },
        `任务 ${res.taskId}（${res.resolution}）→ `,
        h('strong', { class: 'ok-text', text: yuan(res.amount) })));
      toast.ok(res.resolution === 'escalated'
        ? '已转人工处理，这一单不收费'
        : `这单自主解决，计费 ${yuan(res.amount)}`);
      loadSummary();
    });
    render(box,
      ui.pageTitle('数字员工计费', 'AI 自己解决问题才收钱，转人工免费'),
      ui.sectionCard('任务结算',
        ui.toolbar(ui.field('任务 taskId', taskIdInput), ui.field('数字员工 agentId', agentIdInput),
          ui.field('处理结果 resolution', resolutionSelect), ui.actions(completeBtn)),
        resultBox),
      ui.sectionCard('计费汇总', summaryBox));
    await loadSummary();
  };

  /* ===== 面板：Content Engine（系统三） ===== */
  ROUTES.content = async box => {
    let publishedCount = 0; // 最近 content_publish 事件数（「第 n 份作品」toast 计数用，renderEvents 刷新）
    const runBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '马上出作品' }),
      ideaSelect = h('select', { class: 'input' }, h('option', { value: '', text: '全局人设（不指定创意）' })),
      resultBox = h('div'),
      eventsBox = h('div'),
      statsBox = h('div');
    // 创意选择器（CO-02：按创意人设出作品）
    api.get('/api/ideas').then(data => {
      for (const idea of (data && data.ideas) || []) {
        ideaSelect.append(h('option', { value: idea.id, text: `${idea.name}（${IDEA_STAGE_LABELS[idea.stage] || idea.stage}）` }));
      }
    }).catch(() => { /* 创意库缺席：保留全局选项 */ });
    const renderResult = r => {
      const brief = (r && r.brief) || {},
        review = (r && r.review) || {},
        publish = (r && r.publish) || {},
        violations = review.violations || [],
        dispatch = r && r.dispatch;
      render(resultBox, h('div', { class: 'card section-card result-card' },
        h('h3', { class: 'card-title' }, '流水线结果 ',
          r && r.success ? ui.badge('发布成功', 'ok') : ui.badge('未发布', 'err')),
        h('p', { class: 'result-line' },
          h('strong', { text: brief.title || '—' }),
          ` · 人设分 ${num(brief.personaScore)} / 5`),
        brief.angle ? h('p', { class: 'muted', style: 'margin:4px 0', text: `差异化角度：${brief.angle}` }) : null,
        Array.isArray(brief.differentiation) && brief.differentiation.length
          ? h('ul', { class: 'diff-list' }, brief.differentiation.map(d => h('li', { text: d })))
          : null,
        violations.length
          ? h('div', { class: 'violation-list' }, violations.map(v => h('div', { class: 'violation-item' },
              ui.badge(String(v.severity || 'low'), v.severity === 'high' ? 'err' : 'warn'),
              h('span', { text: `${v.type}：${v.detail || ''}` }))))
          : h('p', { class: 'ok-text', style: 'margin:8px 0', text: `审核通过 · 合规分 ${num(review.score)} / 100 · E-E-A-T 四维检查 ${Array.isArray(review.eeat) ? review.eeat.filter(x => x.present).length + '/4 达标' : '未启用'}` }),
        publish.url
          ? h('p', { class: 'result-line' }, '发布链接：',
              h('a', { href: publish.url, target: '_blank', rel: 'noopener noreferrer', text: publish.url }))
          : null,
        dispatch ? h('div', {},
          h('h4', { text: `多平台分发（${dispatch.dispatches.length} 平台 · 成功 ${dispatch.dispatches.filter(d => d.result.success).length}）` }),
          h('ul', { class: 'muted small' }, dispatch.dispatches.map(d => h('li', {},
            h('strong', { text: PLATFORM_LABELS[d.platform] || d.platform }), ` · 适配 ${d.adaptationMs}ms · `,
            h('a', { href: d.result.url, target: '_blank', rel: 'noopener noreferrer', text: d.result.success ? '回执链接' : '失败' }))))) : null,
        h('p', { class: 'muted small', style: 'margin:6px 0 0',
          text: `耗时 ${num(r && r.durationMs)} ms · 重写 ${num(r && r.rewrites)} 轮 · 平台 ${publish.platform || '—'}${r && r.ideaId ? ` · 创意 ${r.ideaId}` : ''}` })));
    };
    busyBtn(runBtn, '运行中…（LLM 模式可能需要数秒）', async () => {
      const ideaId = ideaSelect.value || undefined;
      const r = await api.post('/api/content/run', { ideaId, platforms: true });
      renderResult(r);
      toast.ok(r && r.publish && r.publish.url
        ? `第 ${publishedCount + 1} 份作品发布成功 · 已适配 ${r.dispatch ? r.dispatch.dispatches.length : 1} 个平台`
        : '流水线已运行（本次未发布）');
      quiet();
    });
    const renderEvents = events => {
      publishedCount = events.length;
      render(eventsBox, events.length
        ? h('ul', { class: 'timeline' }, events.map(ev => h('li', { class: 'timeline-item' },
            h('div', { class: 'tl-head' },
              h('code', { class: 'tl-type', text: ev.type || 'event' }),
              h('span', { class: 'tl-time', text: fmtTime(ev.timestamp) })),
            ev.payload
              ? h('div', { class: 'stat-sub', text: `${ev.payload.title || '—'} · ${ev.payload.platform || '—'} · ${num(ev.payload.durationMs)} ms` })
              : null)))
        : ui.empty('还没有作品——记一个创意（回总览），10 秒生成第一篇'));
    };
    const renderStats = (data, events) => {
      const mode = (data && data.mode) || {};
      render(statsBox, h('div', { class: 'card-grid' }, [
        ui.statCard('流水线运行次数', num(data && data.runs), '含失败（stats.runs）'),
        ui.statCard('content_publish 事件', num(events.length)),
        ui.statCard('撰写模式', mode.llm ? 'DeepSeek LLM' : '模板策略', mode.llm ? '已配置 API Key' : '未配置 API Key'),
        ui.statCard('热点选题', mode.hotSearch ? '已接入 web' : '常青库兜底'),
      ]));
    };
    const quiet = async () => {
      try {
        const [evRes, statsRes] = await Promise.all([api.get('/api/content/events'), api.get('/api/content/stats')]);
        const events = (evRes && evRes.events) || [];
        renderEvents(events);
        renderStats(statsRes, events);
      } catch { /* 轮询失败静默，保留上一帧 */ }
    };
    render(box,
      ui.pageTitle('出作品', '把创意变成能发布、能涨粉的作品'),
      ui.sectionCard('运行流水线',
        ui.toolbar(ui.field('用哪个创意的人设（CO-02）', ideaSelect), ui.actions(runBtn),
          h('span', { class: 'muted small', text: '指定创意则用该创意记忆体的人设与选题；默认五平台分发（CO-03）。配置 DeepSeek API Key 后走 LLM 撰写。' })),
        resultBox),
      h('div', { class: 'two-col' },
        ui.sectionCard('最近发布事件（10s 自动刷新）', eventsBox),
        ui.sectionCard('运行统计', statsBox)));
    await quiet();
    autoPoll(eventsBox, quiet);
  };

  /* ===== 面板：创意资产（原记忆库，七类资产 tab + 创意三件套聚合） ===== */
  const MEMORY_CATEGORIES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
  /** 资产语义标签：topic=创意选题 / fact=爆款模式 / soul=人设 / lesson=教训 / rules=红线 / user=受众 / project=矩阵 */
  const ASSET_LABELS = {
    topic: '创意选题', fact: '爆款模式', soul: '人设', lesson: '教训',
    rules: '红线', user: '受众', project: '矩阵',
  };
  /** 创意三件套：topic 选题 + fact 爆款模式 + lesson 教训（默认聚合视图，直接反哺选题） */
  const ASSET_TRIO = ['topic', 'fact', 'lesson'];

  ROUTES.memory = async box => {
    let currentView = 'trio';
    const counts = {},
      countBadges = { trio: null },
      tabButtons = {},
      listBox = h('div'),
      qInput = h('input', { class: 'input', placeholder: '全文关键词' }),
      searchBtn = h('button', { class: 'btn', type: 'button', text: '检索' });
    const viewCategories = view => (view === 'trio' ? ASSET_TRIO : [view]);

    // GET /api/memory 单类返回上限 50：徽标按 50 封顶（'50+' 表示“不少于 50”）
    const loadCounts = async () => {
      await Promise.all(MEMORY_CATEGORIES.map(async c => {
        try {
          const entries = (((await api.get(`/api/memory?category=${c}`)) || {}).entries) || [];
          counts[c] = entries.length;
          if (countBadges[c]) countBadges[c].textContent = entries.length >= 50 ? '50+' : String(entries.length);
        } catch { /* 计数失败保持占位 */ }
      }));
      const trioSum = ASSET_TRIO.reduce((s, c) => s + (counts[c] || 0), 0);
      const trioSaturated = ASSET_TRIO.some(c => (counts[c] || 0) >= 50);
      if (countBadges.trio) countBadges.trio.textContent = trioSaturated ? `${trioSum}+` : String(trioSum);
    };

    const search = () => loadInto(listBox, '检索中…', async () => {
      const q = qInput.value.trim();
      const grouped = await Promise.all(viewCategories(currentView).map(async category => {
        const params = new URLSearchParams({ category });
        if (q) params.set('q', q);
        return (((await api.get(`/api/memory?${params.toString()}`)) || {}).entries) || [];
      }));
      const entries = grouped.flat().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!entries.length) {
        return ui.empty(currentView === 'trio'
          ? '资产库是空的——每条创意、每次发布、每个教训都会自动存进来'
          : '该类资产暂无条目');
      }
      return h('div', { class: 'card-grid memory-grid' }, entries.map(e => h('div', { class: 'card memory-card' },
        h('div', { class: 'memory-head' },
          ui.badge(`${ASSET_LABELS[e.category] || e.category || '—'}（${e.category || '—'}）`, 'info'),
          e.confidence != null ? h('span', { class: 'muted small', text: `置信度 ${e.confidence}` }) : null),
        h('p', { class: 'memory-content', text: e.content || '' }),
        h('div', { class: 'stat-sub', text: fmtTime(e.createdAt) }))));
    }, '资产检索失败');

    function switchView(view) {
      currentView = view;
      Object.entries(tabButtons).forEach(([key, btn]) => btn.classList.toggle('active', key === view));
      search();
    }

    // 写入资产（沿用七类 category + scope + confidence；写入后刷新当前视图与计数徽标）
    const categorySelect = h('select', { class: 'input' },
        MEMORY_CATEGORIES.map(c => h('option', { value: c, text: `${ASSET_LABELS[c]}（${c}）` }))),
      scopeSelect = h('select', { class: 'input' },
        ['global', 'workflow', 'agent'].map(s => h('option', { value: s, text: s }))),
      contentInput = h('textarea', { class: 'input', rows: 3, placeholder: '要沉淀的资产内容（创意、爆款模式、教训…）' }),
      confidenceInput = h('input', { class: 'input', type: 'number', min: '0', max: '1', step: '0.05', value: '0.8' }),
      writeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '存为资产' });
    busyBtn(writeBtn, '写入中…', async () => {
      const content = contentInput.value.trim();
      if (!content) return toast.err('请填写资产内容');
      const confidence = Number(confidenceInput.value);
      await api.post('/api/memory', {
        scope: scopeSelect.value,
        category: categorySelect.value,
        content,
        confidence: Number.isFinite(confidence) ? confidence : 0.8,
      });
      toast.ok(`资产已写入（${ASSET_LABELS[categorySelect.value] || categorySelect.value} / ${scopeSelect.value}）`);
      contentInput.value = '';
      await Promise.all([search(), loadCounts()]);
    });
    searchBtn.addEventListener('click', search);
    onEnter(qInput, search);

    // 顶部资产 tab：创意三件套（默认）+ 七类单类视图，各带计数徽标
    const tabs = h('div', { class: 'tabs asset-tabs' },
      tabButtons.trio = h('button', { class: 'tab', type: 'button', onclick: () => switchView('trio') },
        h('span', { text: '创意三件套' }),
        (countBadges.trio = h('span', { class: 'tab-count', text: '…' }))),
      ...MEMORY_CATEGORIES.map(c =>
        tabButtons[c] = h('button', { class: 'tab', type: 'button', onclick: () => switchView(c) },
          h('span', { text: `${ASSET_LABELS[c]} ${c}` }),
          (countBadges[c] = h('span', { class: 'tab-count', text: '…' })))));

    render(box,
      ui.pageTitle('创意资产', '越用越准的创意资产库：人设、爆款模式、踩过的坑'),
      tabs,
      ui.sectionCard(null,
        ui.toolbar(ui.grow(ui.field('关键词 q', qInput)), ui.actions(searchBtn)),
        listBox),
      ui.sectionCard('写入资产',
        ui.toolbar(ui.field('类别 category（七选一）', categorySelect), ui.field('作用域 scope', scopeSelect),
          ui.field('置信度 confidence', confidenceInput)),
        h('div', { class: 'form-grid form-grid-1' }, ui.field('内容 content', contentInput)),
        ui.toolbar(writeBtn),
        h('p', { class: 'muted', text: 'topic 类资产即「创意选题」：运行内容流水线时将被选题策略直连为候选，创意 → 内容是现成通路。' })));
    switchView('trio');
    await loadCounts();
  };

  /* ===== health / 启动 ===== */
  async function initHealth() {
    const badge = $('#status-badge');
    const footer = $('#footer');
    try {
      const res = await fetch(API_BASE + '/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.ok === false) throw new Error('unhealthy');
      badge.textContent = '运行中';
      badge.className = 'badge badge-ok';
      const rt = data.runtime || {};
      const parts = [
        rt.cordisVersion ? `Cordis ${rt.cordisVersion}` : null,
        rt.apiLevel != null ? `API Level ${rt.apiLevel}` : null,
        `已装载插件 ${Array.isArray(data.plugins) ? data.plugins.length : 0} 个`,
        Array.isArray(data.quarantined) && data.quarantined.length ? `隔离插件 ${data.quarantined.length} 个` : null,
      ].filter(Boolean);
      footer.textContent = `运行时：${parts.join(' · ')}`;
    } catch {
      badge.textContent = '离线';
      badge.className = 'badge badge-err';
      $('#health-banner').classList.remove('hidden');
      footer.textContent = '运行时：不可用（/api/health 无响应）';
    }
  }

  /* ===== 主题：跟随系统深浅色（standalone / iframe 内无宿主标记时） ===== */
  const themeMedia = window.matchMedia('(prefers-color-scheme: light)');
  const applyTheme = light => document.body.classList.toggle('opc-light', light);
  applyTheme(themeMedia.matches);
  const onThemeChange = ev => applyTheme(ev.matches);
  if (typeof themeMedia.addEventListener === 'function') themeMedia.addEventListener('change', onThemeChange);
  else if (typeof themeMedia.addListener === 'function') themeMedia.addListener(onThemeChange);

  /* ===== 鉴权状态（多用户云操作系统） ===== */
  let currentUser = null;

  /* ===== 面板：协作团队（多用户协作组织层） ===== */
  ROUTES.teams = async box => {
    const nameInput = h('input', { class: 'input', placeholder: '队伍名称，如：出海小分队' });
    const createBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '建队' });
    const listBox = h('div');

    const loadTeams = () => loadInto(listBox, null, async () => {
      const teams = ((await api.get('/api/teams')) || {}).teams || [];
      if (!teams.length) return ui.empty('还没有队伍——创建一支，把擅长描述、开发、运营、资产的小伙伴拉进来');
      return h('div', { class: 'card-grid' }, teams.map(team => {
        const isOwner = team.ownerId === (currentUser && currentUser.id);
        const inviteInput = h('input', { class: 'input', placeholder: '按用户名邀请成员' });
        const inviteBtn = h('button', { class: 'btn btn-sm', type: 'button', text: '邀请' });
        busyBtn(inviteBtn, '邀请中…', async () => {
          const username = inviteInput.value.trim();
          if (!username) return toast.err('先填对方用户名');
          await api.post(`/api/teams/${team.id}/members`, { username });
          toast.ok(`已邀请 ${username} 加入「${team.name}」`);
          loadTeams();
        });
        const memberNodes = (team.members || []).map(m => h('span', { class: 'badge badge-info', style: 'margin:2px;display:inline-block' },
          `${m.displayName || m.username || m.userId}（${m.role === 'owner' ? '队长' : '成员'}）`,
          isOwner && m.role !== 'owner' ? h('a', { href: 'javascript:void(0)', text: ' ×', title: '移出队伍',
            onclick: async () => {
              await api.post(`/api/teams/${team.id}/members/remove`, { username: m.username || m.userId });
              toast.ok('已移出队伍');
              loadTeams();
            } }) : null));
        return h('div', { class: 'card memory-card' },
          h('div', { class: 'memory-head' },
            h('strong', { text: team.name }),
            isOwner ? ui.badge('我创建', 'ok') : ui.badge('成员', 'info')),
          h('div', { style: 'margin:6px 0' }, memberNodes),
          ui.toolbar(ui.grow(ui.field('邀请成员（用户名）', inviteInput)), ui.actions(inviteBtn)));
      }));
    }, '团队加载失败');

    busyBtn(createBtn, '创建中…', async () => {
      const name = nameInput.value.trim();
      if (!name) return toast.err('先起个队名');
      await api.post('/api/teams', { name });
      toast.ok(`队伍「${name}」已就绪，去邀请伙伴吧`);
      nameInput.value = '';
      loadTeams();
    });

    render(box,
      ui.pageTitle('协作团队', '一个队伍共享一组创意：成员都能看、都能接着推进'),
      ui.sectionCard('创建队伍', ui.toolbar(ui.grow(ui.field('队名', nameInput)), ui.actions(createBtn))),
      ui.sectionCard('我的队伍', listBox));

    await loadTeams();
  };

  /* ===== 登录页（未登录时接管主区，不启动面板路由） ===== */
  function renderLogin() {
    document.querySelector('.sidenav')?.classList.add('hidden');
    const box = $('#main');
    let mode = 'login';
    const usernameInput = h('input', { class: 'input', autocomplete: 'username', placeholder: '2-32 位字母/数字/下划线' });
    const passwordInput = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '至少 6 位' });
    const displayInput = h('input', { class: 'input', placeholder: '昵称（可选）' });
    const displayField = ui.field('昵称 displayName', displayInput);
    displayField.classList.add('hidden');
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', text: '登录' });
    const toggle = h('a', { href: 'javascript:void(0)', text: '还没有账号？注册一个 →' });
    toggle.addEventListener('click', () => {
      mode = mode === 'login' ? 'register' : 'login';
      displayField.classList.toggle('hidden', mode === 'login');
      submit.textContent = mode === 'login' ? '登录' : '注册并进入';
      toggle.textContent = mode === 'login' ? '还没有账号？注册一个 →' : '已有账号？直接登录 →';
    });
    const form = h('form', { class: 'card section-card login-card', onsubmit: async (ev) => {
      ev.preventDefault();
      const original = submit.textContent;
      submit.disabled = true;
      submit.textContent = mode === 'login' ? '登录中…' : '注册中…';
      try {
        const body = { username: usernameInput.value.trim(), password: passwordInput.value };
        if (mode === 'register' && displayInput.value.trim()) body.displayName = displayInput.value.trim();
        const res = await fetch(API_BASE + `/api/auth/${mode}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.err(`（${(data.error && data.error.code) || res.status}）${(data.error && data.error.message) || '请重试'}`);
          return;
        }
        location.reload();
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    } },
      h('h2', { class: 'page-title', text: '登录 CreativeOS' }),
      h('p', { class: 'muted', text: '每个创意者都有自己的云操作系统——创意、记忆与收入都在你的账号里。' }),
      ui.field('用户名 username', usernameInput),
      ui.field('密码 password', passwordInput),
      displayField,
      h('div', { class: 'toolbar-actions' }, submit),
      h('p', { class: 'small', style: 'margin:10px 0 0' }, toggle));
    render(box, h('div', { class: 'login-wrap' }, form));
  }

  async function initAuth() {
    const badge = $('#user-badge');
    const logoutBtn = $('#logout-btn');
    try {
      const res = await fetch(API_BASE + '/api/auth/me');
      currentUser = ((await res.json()) || {}).user || null;
    } catch {
      currentUser = null;
    }
    if (currentUser) {
      badge.textContent = `${currentUser.displayName}（${currentUser.username}）`;
      badge.classList.remove('hidden');
      logoutBtn.classList.remove('hidden');
      logoutBtn.addEventListener('click', async () => {
        await fetch(API_BASE + '/api/auth/logout', { method: 'POST' }).catch(() => {});
        location.reload();
      });
      router.start();
    } else {
      badge.textContent = '未登录';
      badge.classList.remove('hidden');
      renderLogin();
    }
  }

  initHealth();
  initAuth();
})();
