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
        toast.err(`${err.code}：${err.message}`);
        throw err;
      }
      let data = null;
      try { data = await res.json(); } catch { /* 204 等空响应 */ }
      if (!res.ok) {
        const err = (data && data.error) || { code: `HTTP_${res.status}`, message: res.statusText || '请求失败' };
        toast.err(`${err.code}：${err.message}`);
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
    empty: text => h('div', { class: 'empty', text }),
    loading: text => h('div', { class: 'muted pad', text: text || '加载中…' }),
    field: (labelText, control) => h('label', { class: 'field' },
      h('span', { class: 'field-label', text: labelText }), control),
    table: (headers, rows) => {
      if (!rows || !rows.length) return ui.empty('暂无数据');
      const tr = cells => h('tr', {}, cells.map(c => h('td', {}, (c && c.nodeType) ? c : String(c ?? ''))));
      return h('div', { class: 'table-wrap' },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, headers.map(x => h('th', { text: x })))),
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

  /* ===== router（hash 路由，刷新保持） ===== */
  const ROUTES = {}; // name -> async render(container)
  const ROUTE_NAMES = ['overview', 'team', 'blackboard', 'skills', 'orders', 'creators', 'bills', 'billing', 'memory'];
  const router = {
    current() {
      const m = /^#\/([a-z]+)/.exec(location.hash);
      return m && ROUTE_NAMES.includes(m[1]) ? m[1] : 'overview';
    },
    async renderPanel() {
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
    },
    start() {
      window.addEventListener('hashchange', () => router.renderPanel());
      if (location.hash !== `#/${router.current()}`) location.hash = `#/${router.current()}`;
      else router.renderPanel();
    },
  };

  /* ===== 面板：总览 ===== */
  const timeline = events => events.length
    ? h('ul', { class: 'timeline' }, events.map(ev => h('li', { class: 'timeline-item' },
        h('div', { class: 'tl-head' },
          h('code', { class: 'tl-type', text: ev.type || 'event' }),
          h('span', { class: 'tl-time', text: fmtTime(ev.timestamp) })),
        ev.payload ? h('pre', { class: 'tl-payload', text: safeJson(ev.payload) }) : null)))
    : ui.empty('暂无埋点事件');

  ROUTES.overview = async box => {
    const o = (await api.get('/api/overview')) || {};
    const bb = o.blackboard || {};
    const orders = o.orders || {};
    render(box,
      ui.pageTitle('总览', '四大变现系统运行状态一览'),
      h('div', { class: 'card-grid' }, [
        ui.statCard('团队模板数 · AI Startup-in-a-Box', num((o.team || {}).templates)),
        ui.statCard('黑板条数 · 共享工作区', num(Number(bb.global || 0) + Number(bb.workflow || 0)),
          `global ${num(bb.global)} · workflow ${num(bb.workflow)}`),
        ui.statCard('市场 Skill 数 · Skill Forge', num((o.market || {}).skills)),
        ui.statCard('订单净交易 / 收入', `${num(orders.netRevenue)} 笔`,
          `已支付 ${num(orders.totalPaid)} 笔 · 退款 ${num(orders.refunded)} 笔`),
        ui.statCard('RaaS 计费收入 · Digital Employee', yuan((o.billing || {}).revenue)),
        ui.statCard('记忆条数 · Content Engine 记忆库', num((o.memory || {}).count)),
      ]),
      ui.sectionCard('最近埋点事件', timeline((o.telemetry && o.telemetry.recent) || [])));
  };

  /* ===== 面板：团队 ===== */
  ROUTES.team = async box => {
    const goalInput = h('input', { class: 'input', type: 'text', placeholder: '例如：帮我做一个跨境电商独立站' }),
      submitBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '解析并组建团队' }),
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
      ui.pageTitle('虚拟创业团队', 'AI Startup-in-a-Box：输入创业目标，自动拉起角色 Agent 团队'),
      ui.sectionCard(null,
        ui.toolbar(ui.grow(ui.field('创业目标', goalInput)), ui.actions(submitBtn)),
        h('p', { class: 'muted', text: '解析失败时将降级为行业模板选择（跨境电商创业团队、独立开发者团队等）。' })),
      templatesBox, resultBox);
  };

  /* ===== 面板：黑板 ===== */
  ROUTES.blackboard = async box => {
    let scope = 'global';
    const listBox = h('div'),
      scopeLabel = h('code', { class: 'chip-static', text: 'global' }),
      tabButtons = {};
    const load = () => loadInto(listBox, null, async () =>
      ui.table(['Key', '版本', '写入者', '更新时间', '值'],
        ((((await api.get(`/api/blackboard?scope=${scope}`)) || {}).entries) || []).map(e => [
          h('code', { class: 'key-code', text: e.key }), `v${e.version ?? 0}`,
          `${e.writer || '—'}${e.role ? `（${e.role}）` : ''}`, fmtTime(e.updatedAt),
          ui.jsonBox(e.value),
        ])), '黑板加载失败，请稍后重试');
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
      writeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '写入黑板' });
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
        toast.err(`BLACKBOARD_CONFLICT：乐观锁冲突，黑板当前为 v${winner.version ?? '?'}（writer=${winner.writer || '—'}），已回填版本号可重试`);
        versionInput.value = String(winner.version ?? 0);
      } else {
        const entry = res.entry || {};
        toast.ok(`写入成功：${key} → v${entry.version ?? '?'}`);
        versionInput.value = String(entry.version ?? 0);
      }
      load();
    });
    render(box,
      ui.pageTitle('共享黑板', '多 Agent 共享工作区：全局事实与任务事件，乐观锁并发仲裁'),
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
      searchBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '搜索' }),
      totalText = h('span', { class: 'muted small' }),
      tableBox = h('div'), draftsBox = h('div');
    const kv = (k, v) => h('div', { class: 'kv' },
      h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: v }));
    function installButton(skill) {
      const btn = h('button', { class: 'btn btn-sm', type: 'button', text: '安装' });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '安装中…';
        try {
          const res = await api.post('/api/skills/install', { skillId: skill.id });
          toast.ok(`安装成功：${res && res.installedPath}`);
          btn.textContent = '已安装';
        } catch { btn.disabled = false; btn.textContent = '重试'; }
      });
      return btn;
    }
    const search = () => loadInto(tableBox, '搜索中…', async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (qInput.value.trim()) params.set('q', qInput.value.trim());
      if (categoryInput.value.trim()) params.set('category', categoryInput.value.trim());
      if (compatInput.value.trim()) params.set('compat', compatInput.value.trim());
      const data = await api.get(`/api/skills?${params.toString()}`);
      const results = (data && data.results) || [];
      totalText.textContent = `共 ${data && data.total != null ? data.total : results.length} 个 Skill`;
      return ui.table(['名称', '版本', '作者', '价格', '下载', '评分', '兼容', '操作'],
        results.map(s => [
          s.name, s.version, s.authorId, money(s.price), num(s.downloads),
          s.rating != null ? `${Number(s.rating).toFixed(1)} / 5` : '—',
          (s.compat && s.compat.dsh) || '—', installButton(s),
        ]));
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
    searchBtn.addEventListener('click', search);
    onEnter(qInput, search);
    render(box,
      ui.pageTitle('Skill 市场', 'Skill Forge：浏览、搜索、安装技能包'),
      ui.sectionCard(null,
        ui.toolbar(ui.field('关键词 q', qInput), ui.field('类别 category', categoryInput),
          ui.field('兼容版本 compat', compatInput), ui.actions(searchBtn, totalText))),
      tableBox,
      ui.sectionCard('Skill 草案（本能提炼）', draftsBox));
    await Promise.all([search(), loadDrafts()]);
  };

  /* ===== 面板：订单交易 ===== */
  const isUnpaid = status => !['paid', 'completed', 'succeeded', 'refunded'].includes(String(status || ''));
  ROUTES.orders = async box => {
    const skillMeta = new Map(),
      skillSelect = h('select', { class: 'input' }, h('option', { value: '', text: '加载 Skill 列表…' })),
      buyerInput = h('input', { class: 'input', value: 'buyer-001', placeholder: '买家 ID' }),
      amountInput = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: '100' }),
      orderBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '创建订单' }),
      splitBox = h('div'),
      listBuyerInput = h('input', { class: 'input', value: 'buyer-001', placeholder: '必填：按 buyerId 过滤' }),
      refreshBtn = h('button', { class: 'btn', type: 'button', text: '查询订单' }),
      listBox = h('div');
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
          toast.ok(`支付成功：${(res && res.order && res.order.id) || order.id}`);
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
      return ui.table(['订单 ID', 'Skill', '买家', '金额', '状态', '创建时间', '操作'],
        (((data || {}).orders) || []).map(o => [
          h('code', { class: 'key-code', text: o.id }), o.skillId || '—', o.buyerId || '—',
          o.amount != null ? money(o.amount) : '—', statusBadge(o.status),
          o.createdAt ? fmtTime(o.createdAt) : '—',
          isUnpaid(o.status) ? payButton(o) : '—',
        ]));
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
    render(box,
      ui.pageTitle('订单交易', 'Skill 购买与支付：创作者 85% / 平台 15% 分成'),
      ui.sectionCard('下单',
        ui.toolbar(ui.grow(ui.field('Skill', skillSelect)), ui.field('买家 buyerId', buyerInput),
          ui.field('金额（分）', amountInput), ui.actions(orderBtn))),
      splitBox,
      ui.sectionCard('订单列表',
        ui.toolbar(ui.grow(ui.field('按买家过滤', listBuyerInput)), ui.actions(refreshBtn)),
        listBox));
    await Promise.all([loadSkillOptions(), loadOrders()]);
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
      if (!creators.length) return ui.empty('暂无创作者分成：在「订单交易」完成一笔支付后即按 85/15 入账');
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
      ui.pageTitle('创作者中心', 'SF-07 收益统计：创作者余额与分成流水（85% 创作者 / 15% 平台，金额单位：分）'),
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
      if (!s || (!s.totalBuyers && !s.totalOrders)) return ui.empty('暂无交易数据：完成一笔 Skill 订单支付后即出账单');
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
      ui.pageTitle('客户账单', 'DE-08 客户账单：买家订单明细与总消费，顶部汇总市场净额与 RaaS 收入'),
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
      completeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '结算任务' }),
      resultBox = h('div'), summaryBox = h('div');
    const loadSummary = () => loadInto(summaryBox, null, async () => {
      const data = await api.get('/api/billing/summary');
      return h('div', {},
        h('div', { class: 'big-number', text: yuan(data && data.totalRevenue) }),
        h('div', { class: 'stat-label', style: 'margin-bottom:14px', text: 'RaaS 总收入' }),
        ui.table(['任务 ID', '处理结果', '金额'],
          (((data || {}).records) || []).map(r => [
            h('code', { class: 'key-code', text: r.taskId }), resolutionBadge(r.resolution), yuan(r.amount),
          ])));
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
      toast.ok(`任务已结算：${yuan(res.amount)}`);
      loadSummary();
    });
    render(box,
      ui.pageTitle('RaaS 计费', 'Digital Employee 数字员工：按结果付费，自主解决收费、转人工免费'),
      ui.sectionCard('任务结算',
        ui.toolbar(ui.field('任务 taskId', taskIdInput), ui.field('数字员工 agentId', agentIdInput),
          ui.field('处理结果 resolution', resolutionSelect), ui.actions(completeBtn)),
        resultBox),
      ui.sectionCard('计费汇总', summaryBox));
    await loadSummary();
  };

  /* ===== 面板：记忆库 ===== */
  const MEMORY_CATEGORIES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
  ROUTES.memory = async box => {
    const categorySelect = h('select', { class: 'input' },
        MEMORY_CATEGORIES.map(c => h('option', { value: c, text: c }))),
      scopeSelect = h('select', { class: 'input' },
        ['global', 'workflow', 'agent'].map(s => h('option', { value: s, text: s }))),
      contentInput = h('textarea', { class: 'input', rows: 3, placeholder: '要写入的记忆内容' }),
      confidenceInput = h('input', { class: 'input', type: 'number', min: '0', max: '1', step: '0.05', value: '0.8' }),
      writeBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '写入记忆' }),
      qInput = h('input', { class: 'input', placeholder: '全文关键词' }),
      filterCategory = h('select', { class: 'input' }, h('option', { value: '', text: '全部类别' }),
        MEMORY_CATEGORIES.map(c => h('option', { value: c, text: c }))),
      searchBtn = h('button', { class: 'btn', type: 'button', text: '检索' }),
      listBox = h('div');
    const search = () => loadInto(listBox, '检索中…', async () => {
      const params = new URLSearchParams();
      if (qInput.value.trim()) params.set('q', qInput.value.trim());
      if (filterCategory.value) params.set('category', filterCategory.value);
      const entries = (((await api.get(`/api/memory${params.toString() ? `?${params}` : ''}`)) || {}).entries) || [];
      if (!entries.length) return ui.empty('没有匹配的记忆');
      return h('div', { class: 'card-grid memory-grid' }, entries.map(e => h('div', { class: 'card memory-card' },
        h('div', { class: 'memory-head' },
          ui.badge(e.category || '—', 'info'),
          e.confidence != null ? h('span', { class: 'muted small', text: `置信度 ${e.confidence}` }) : null),
        h('p', { class: 'memory-content', text: e.content || '' }),
        h('div', { class: 'stat-sub', text: fmtTime(e.createdAt) }))));
    }, '记忆检索失败');
    busyBtn(writeBtn, '写入中…', async () => {
      const content = contentInput.value.trim();
      if (!content) return toast.err('请填写记忆内容');
      const confidence = Number(confidenceInput.value);
      await api.post('/api/memory', {
        scope: scopeSelect.value,
        category: categorySelect.value,
        content,
        confidence: Number.isFinite(confidence) ? confidence : 0.8,
      });
      toast.ok(`记忆已写入（${categorySelect.value} / ${scopeSelect.value}）`);
      contentInput.value = '';
      search();
    });
    searchBtn.addEventListener('click', search);
    onEnter(qInput, search);
    render(box,
      ui.pageTitle('记忆库', 'Content Engine 七类记忆：soul / user / project / fact / lesson / topic / rules'),
      ui.sectionCard('写入记忆',
        ui.toolbar(ui.field('类别 category（七选一）', categorySelect), ui.field('作用域 scope', scopeSelect),
          ui.field('置信度 confidence', confidenceInput)),
        h('div', { class: 'form-grid form-grid-1' }, ui.field('内容 content', contentInput)),
        ui.toolbar(writeBtn)),
      ui.sectionCard('记忆检索',
        ui.toolbar(ui.grow(ui.field('关键词 q', qInput)), ui.field('类别 category', filterCategory),
          ui.actions(searchBtn)),
        listBox));
    await search();
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

  initHealth();
  router.start();
})();
