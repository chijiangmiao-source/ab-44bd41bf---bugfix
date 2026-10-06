'use strict';
/* global CanEngine */

const Can = window.CanEngine;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }],
  requests: [
    { time: 0, node: 'A', id: '0x100', dlc: 1, data: '11 22', error: null },
    { time: 0, node: 'B', id: '0x180', dlc: 0, data: '', error: null },
  ],
  result: null,
};

const MODE_TEXT = { active: '主动错误', passive: '错误被动', 'bus-off': 'bus-off' };

/* ------------------------- 录入区渲染 ------------------------- */

function renderNodes() {
  const box = $('#nodes');
  box.innerHTML = '';
  state.nodes.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <input type="text" maxlength="8" value="${escapeAttr(n.name)}" data-k="name" placeholder="如 A / CAM1" />
      <input type="number" min="0" max="255" value="${n.tec}" data-k="tec" title="初始发送错误计数 0~255" />
      <button type="button" class="btn small danger" data-act="del-node">删</button>`;
    row.querySelector('[data-k="name"]').addEventListener('input', (e) => { state.nodes[i].name = e.target.value; });
    row.querySelector('[data-k="tec"]').addEventListener('input', (e) => { state.nodes[i].tec = e.target.value === '' ? '' : Number(e.target.value); });
    row.querySelector('[data-act="del-node"]').addEventListener('click', () => { state.nodes.splice(i, 1); renderAll(); });
    box.appendChild(row);
  });
}

function renderRequests() {
  const box = $('#requests');
  box.innerHTML = '';
  state.requests.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const nodeOpts = state.nodes.map((n) => `<option value="${escapeAttr(n.name)}"${n.name === r.node ? ' selected' : ''}>${escapeHtml(n.name || '?')}</option>`).join('');
    const errType = r.error?.type || '';
    const srcNode = state.nodes.find((n) => n.name === (r.error?.sourceNode || ''));
    const srcOpts = state.nodes.filter((n) => n.name !== r.node)
      .map((n) => `<option value="${escapeAttr(n.name)}"${n.name === r.error?.sourceNode ? ' selected' : ''}>${escapeHtml(n.name)}</option>`).join('');
    row.innerHTML = `
      <input type="number" min="0" value="${r.time}" data-k="time" />
      <select data-k="node">${nodeOpts}</select>
      <input type="text" value="${escapeAttr(r.id)}" data-k="id" placeholder="0x123" />
      <input type="number" min="0" max="8" value="${r.dlc}" data-k="dlc" />
      <input type="text" value="${escapeAttr(r.data)}" data-k="data" placeholder="如 11 22 AB" />
      <div class="err-cell">
        <select data-k="etype">
          <option value=""${!errType ? ' selected' : ''}>无</option>
          <option value="ack"${errType === 'ack' ? ' selected' : ''}>ACK 错误</option>
          <option value="crc"${errType === 'crc' ? ' selected' : ''}>CRC 错误</option>
          <option value="bit"${errType === 'bit' ? ' selected' : ''}>数据位错误</option>
        </select>
        <select data-k="esrc" class="${errType === 'crc' ? '' : 'hidden'}">
          <option value="">来源节点…</option>${srcOpts}
        </select>
        <input type="number" min="0" data-k="ebit" class="${errType === 'bit' ? '' : 'hidden'}"
          value="${errType === 'bit' ? r.error.dataBit : ''}" placeholder="位序号" title="按 Dn.7→Dn.0 展平，0 = 首字节最高位" />
      </div>
      <button type="button" class="btn small danger" data-act="del-req">删</button>`;
    const q = selector => row.querySelector(selector);
    q('[data-k="time"]').addEventListener('input', e => { r.time = e.target.value === '' ? '' : Number(e.target.value); });
    q('[data-k="node"]').addEventListener('change', e => { r.node = e.target.value; renderRequests(); });
    q('[data-k="id"]').addEventListener('input', e => { r.id = e.target.value; });
    q('[data-k="dlc"]').addEventListener('input', e => { r.dlc = e.target.value === '' ? '' : Number(e.target.value); });
    q('[data-k="data"]').addEventListener('input', e => { r.data = e.target.value; });
    q('[data-k="etype"]').addEventListener('change', e => {
      const t = e.target.value;
      if (t === 'ack') r.error = { type: 'ack' };
      else if (t === 'crc') r.error = { type: 'crc', sourceNode: q('[data-k="esrc"]').value || state.nodes.find((n) => n.name !== r.node)?.name || '' };
      else if (t === 'bit') r.error = { type: 'bit', dataBit: Number(q('[data-k="ebit"]').value) || 0 };
      else r.error = null;
      renderRequests();
    });
    q('[data-k="esrc"]')?.addEventListener('change', e => { if (r.error) r.error.sourceNode = e.target.value; });
    q('[data-k="ebit"]')?.addEventListener('input', e => { if (r.error) r.error.dataBit = Number(e.target.value); });
    q('[data-act="del-req"]').addEventListener('click', () => { state.requests.splice(i, 1); renderAll(); });
    box.appendChild(row);
  });
  updateCountInfo();
}

function updateCountInfo() {
  $('#count-info').textContent = `节点 ${state.nodes.length}/4，请求 ${state.requests.length}/24`;
}

function renderAll() {
  renderNodes();
  renderRequests();
}

$('#btn-add-node').addEventListener('click', () => {
  if (state.nodes.length >= 4) return;
  state.nodes.push({ name: String.fromCharCode(65 + state.nodes.length), tec: 0 });
  renderAll();
});
$('#btn-add-req').addEventListener('click', () => {
  if (state.requests.length >= 24) return;
  const last = state.requests[state.requests.length - 1];
  state.requests.push({
    time: last ? last.time : 0, node: state.nodes[0]?.name || '',
    id: '0x100', dlc: 0, data: '', error: null,
  });
  renderAll();
});
$('#btn-clear').addEventListener('click', () => {
  state.nodes = [];
  state.requests = [];
  state.result = null;
  clearFieldErrors();
  $('#summary').classList.add('hidden');
  $('#attempts').innerHTML = '<p class="muted placeholder">已清空。</p>';
  renderAll();
});

/* ------------------------- 组装与提交 ------------------------- */

function buildPayload() {
  return {
    nodes: state.nodes.map((n) => ({ name: n.name, tec: Number(n.tec) || 0 })),
    requests: state.requests.map((r) => ({
      time: Number(r.time) || 0,
      node: r.node,
      id: typeof r.id === 'string' ? r.id.trim() : r.id,
      dlc: Number(r.dlc) || 0,
      data: r.data,
      error: r.error,
    })),
  };
}

function clearFieldErrors() {
  $$('.invalid-field').forEach((el) => el.classList.remove('invalid-field'));
  $$('.row.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#field-errors').classList.add('hidden');
}

function showFieldErrors(errors) {
  clearFieldErrors();
  const box = $('#field-errors');
  box.innerHTML = '<h4>字段级反馈（旧结论已清除，请修正后重新执行）</h4><ul></ul>';
  const ul = box.querySelector('ul');
  const seen = new Set();
  for (const e of errors) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="field-path">${e.field || '(根)'}</span>：${escapeHtml(e.message)}`;
    ul.appendChild(li);
    highlightField(e.field);
    seen.add(e.field);
  }
  box.classList.remove('hidden');
}

function highlightField(fp) {
  const nodeM = fp.match(/^nodes\[(\d+)\](?:\.(name|tec))?/);
  if (nodeM) {
    const rows = $$('#nodes .row');
    const row = rows[Number(nodeM[1])];
    row?.classList.add('invalid');
    if (nodeM[2]) row?.querySelector(`[data-k="${nodeM[2]}"]`)?.classList.add('invalid-field');
    return;
  }
  const reqM = fp.match(/^requests\[(\d+)\](?:\.(time|node|id|dlc|data)(?:\[(\d+)\])?|\.error(?:\.(type|sourceNode|dataBit))?)?/);
  if (reqM) {
    const rows = $$('#requests .row');
    const row = rows[Number(reqM[1])];
    if (!row) return;
    row.classList.add('invalid');
    const key = reqM[2] || reqM[4];
    if (key === 'sourceNode') row.querySelector('[data-k="esrc"]')?.classList.add('invalid-field');
    else if (key === 'dataBit') row.querySelector('[data-k="ebit"]')?.classList.add('invalid-field');
    else if (key) row.querySelector(`[data-k="${key}"]`)?.classList.add('invalid-field');
    if (fp.includes('.data')) row.querySelector('[data-k="data"]')?.classList.add('invalid-field');
    if (fp.includes('.error')) row.querySelector('[data-k="etype"]')?.classList.add('invalid-field');
  }
}

$('#btn-run').addEventListener('click', async () => {
  clearFieldErrors();
  let result;
  try {
    const resp = await fetch('/api/simulate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    result = await resp.json();
  } catch (e) {
    showFieldErrors([{ field: '', message: '请求失败：' + e.message }]);
    return;
  }
  if (!result.ok) {
    // 校验失败：清除旧结论
    state.result = null;
    $('#summary').classList.add('hidden');
    $('#attempts').innerHTML = '<p class="muted placeholder">输入未通过校验，暂无结论。</p>';
    $('#stale-hint').classList.remove('hidden');
    showFieldErrors(result.errors || []);
    return;
  }
  $('#stale-hint').classList.add('hidden');
  state.result = result;
  renderResult(result);
});

/* ------------------------- 结果渲染 ------------------------- */

function renderResult(r) {
  // 节点状态卡
  const cards = $('#stat-cards');
  cards.innerHTML = '';
  for (const n of r.nodes) {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `
      <div><span class="node">${escapeHtml(n.name)}</span><span class="badge ${n.mode}">${MODE_TEXT[n.mode]}</span></div>
      <div class="counts">TEC=${n.tec}　REC=${n.rec}</div>`;
    cards.appendChild(d);
  }

  // 事件
  const log = $('#event-log');
  log.innerHTML = '';
  if (!r.events.length) log.innerHTML = '<span class="muted">无状态迁移事件。</span>';
  for (const ev of r.events) {
    const d = document.createElement('div');
    d.className = `event-line ${ev.type}`;
    d.innerHTML = eventText(ev, r);
    log.appendChild(d);
  }

  // 请求结局
  const tb = $('#outcomes-table tbody');
  tb.innerHTML = '';
  r.requests.forEach((q, i) => {
    const tr = document.createElement('tr');
    const tag = outcomeTag(q.status);
    tr.innerHTML = `<td>${i}</td><td>${q.time}</td><td>${escapeHtml(q.node)}</td>
      <td class="mono">${Can.fmtId(q.id)}</td><td><span class="tag ${tag.cls}">${tag.text}</span></td>
      <td>${q.attempts?.length || 0}</td><td>${escapeHtml(q.reason || '')}</td>`;
    tb.appendChild(tr);
  });
  $('#summary').classList.remove('hidden');

  // 逐帧卡片
  const box = $('#attempts');
  box.innerHTML = '';
  r.attempts.forEach((a) => box.appendChild(renderAttemptCard(a, r)));
}

function outcomeTag(status) {
  switch (status) {
    case 'transmitted': return { text: '发送成功', cls: 'ok' };
    case 'rejected': return { text: '已拒绝', cls: 'rejected' };
    case 'aborted': return { text: '中止', cls: 'aborted' };
    case 'waiting-busoff': return { text: '挂起(bus-off)', cls: 'waiting' };
    case 'pending-retry': return { text: '待重传', cls: 'waiting' };
    default: return { text: status || '?', cls: '' };
  }
}

function eventText(ev, r) {
  const at = `<span class="mono">位 ${ev.atBit}</span>`;
  switch (ev.type) {
    case 'error-passive':
      return `⚪ <b>${escapeHtml(ev.node)}</b> 在 ${at} 进入<b>错误被动</b>（TEC=${ev.tec}${ev.rec ? `，REC=${ev.rec}` : ''}），错误标志转为 6 个隐性位`;
    case 'bus-off':
      return `🔴 <b>${escapeHtml(ev.node)}</b> 在 ${at} TEC=${ev.tec} 达到 256，进入 <b>bus-off</b>：退出仲裁，新请求被拒绝，等待 128×11 连续隐性位`;
    case 'recovered':
      return `🟢 <b>${escapeHtml(ev.node)}</b> 在 ${at} 完成 ${ev.groups} 次 11 连续隐性位监测，<b>恢复发送资格</b>，TEC/REC 清零`;
    case 'rejected':
      return `⛔ ${at} 节点 <b>${escapeHtml(ev.node)}</b> 的请求 #${ev.requestIndex} 被<b>拒绝</b>（bus-off）`;
    case 'aborted':
      return `⛔ ${at} 节点 <b>${escapeHtml(ev.node)}</b> 的请求 #${ev.requestIndex} 中止`;
    case 'collision-aborted':
      return `⛔ ${at} 节点 <b>${escapeHtml(ev.node)}</b> 的请求 #${ev.requestIndex} 与同标识符节点帧内容持续不一致，反复 bus-off 后按物理 livelock 终止（首个分歧位 ${ev.globalBit}）`;
    default: return JSON.stringify(ev);
  }
}

function renderAttemptCard(a, r) {
  const card = document.createElement('div');
  card.className = `attempt ${a.ok ? 'ok-frame' : 'err'}${a.retransmit ? ' retx' : ''}`;
  const dataHex = a.data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '—';
  const shared = a.sharedTransmitters?.length > 1
    ? a.sharedTransmitters.map((s) => `${s.node}（请求 #${s.requestIndex}）`).join('、')
    : null;
  const joint = a.jointTransmitters?.length > 1 ? a.jointTransmitters : null;
  const headStatus = a.ok
    ? { cls: 'ok', text: '正常应答完成' }
    : a.status === 'partial'
      ? { cls: 'warn', text: '部分共同发送成功 / 内容分歧方错误重传' }
      : { cls: 'bad', text: '检出错误并重传' };
  card.innerHTML = `
    <div class="att-head">
      <span class="seq">帧尝试 #${a.index}${a.retransmit ? '（自动重传）' : ''}</span>
      <span class="winner">🏆 ${escapeHtml(a.winner)}</span>
      <span class="frameid">ID=${a.frameIdHex}　DLC=${a.dlc}　数据=[${dataHex}]　CRC=${a.crc}</span>
      <span class="status ${headStatus.cls}">${headStatus.text}</span>
    </div>
    <div class="att-body">
      <div class="kv-grid">
        <div class="kv"><span class="k">同刻候选：</span>${a.contenders.map((c) => `${escapeHtml(c.node)}(${c.idHex},DLC=${c.dlc})`).join('、')}</div>
        <div class="kv"><span class="k">仲裁结果：</span>${escapeHtml(a.arbitration.winner)} 获胜（低标识符优先）${a.arbitration.note ? '；' + escapeHtml(a.arbitration.note) : ''}</div>
        ${joint ? `<div class="kv"><span class="k">仲裁平局共同驱动：</span>${joint.map((j) => `${escapeHtml(j.node)}（请求 #${j.requestIndex}，DLC=${j.dlc}，数据=[${(j.data || []).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '—'}]）<span class="jtag ${j.ok ? 'j-ok' : 'j-err'}">${j.ok ? '本方应答成功' : '本方检出错误'}</span>`).join('；')}</div>` : ''}
        ${shared ? `<div class="kv"><span class="k">共同发送：</span>${escapeHtml(shared)}（整帧内容完全一致，共享同一物理帧，各自获得成功结局）</div>` : ''}
      </div>
      <div class="evidence-wrap"></div>
      <h5 class="muted">错误计数变化</h5>
      <table class="cc-table">
        <thead><tr><th>节点</th><th>角色</th><th>TEC(前→后)</th><th>REC(前→后)</th><th>模式</th></tr></thead>
        <tbody class="cc-body"></tbody>
      </table>
      <button type="button" class="btn small btn-open-trace">逐位回放该帧（${a.trace.length} 位）…</button>
      <div class="trace-preview"></div>
    </div>`;

  // 仲裁证据
  const ew = card.querySelector('.evidence-wrap');
  for (const ev of a.arbitration.loserEvidence) {
    const d = document.createElement('div');
    d.className = 'evidence arbitration';
    d.innerHTML = `<h5>仲裁失败证据 · ${escapeHtml(ev.node)}</h5>
      <div>${escapeHtml(ev.detail)}</div>
      <div class="loc">全局位序号=${ev.globalBit}　场位置=${ev.label}　该节点发送=${bitTxt(ev.sent)}　总线=${bitTxt(ev.bus)}</div>`;
    d.querySelector('.loc').addEventListener('click', () => openTrace(a, ev.globalBit));
    ew.appendChild(d);
  }
  // 仲裁平局后首个驱动分歧证据
  if (a.collision) {
    const d = document.createElement('div');
    d.className = 'evidence collision';
    d.innerHTML = `<h5>仲裁平局后首个驱动分歧 · ${escapeHtml(a.collision.fieldLabel)}（${escapeHtml(a.collision.field)}）</h5>
      <div>${escapeHtml(a.collision.detail)}</div>
      <div class="loc">全局位序号=${a.collision.globalBit}　场=${a.collision.field}/${escapeHtml(a.collision.fieldLabel)}　分歧方期望发送=${bitTxt(a.collision.expected)}　总线=${bitTxt(a.collision.actual)}　→ 错误标志（无正常 ACK，TEC+8，帧间隔后自动重传）</div>`;
    d.querySelector('.loc').addEventListener('click', () => openTrace(a, a.collision.globalBit));
    ew.appendChild(d);
  }
  // 错误/首个违规
  if (a.firstViolation) {
    const d = document.createElement('div');
    d.className = 'evidence';
    const v = a.firstViolation;
    d.innerHTML = `<h5>首个违规证据 · ${escapeHtml(v.node)}（${v.role === 'transmitter' ? '发送方' : '接收方'}）</h5>
      <div>${escapeHtml(v.detail)}</div>
      <div class="loc">全局位序号=${v.globalBit}　场=${v.frameField}/${v.fieldLabel || ''}　错误类型=${v.kind}</div>`;
    d.querySelector('.loc').addEventListener('click', () => openTrace(a, v.globalBit));
    ew.appendChild(d);
  }
  if (a.errors.length > 1) {
    const ul = document.createElement('div');
    ul.className = 'kv';
    ul.innerHTML = `<span class="k">本次尝试全部检出：</span>` + a.errors.map((e) =>
      `${escapeHtml(e.node)}(${e.role === 'transmitter' ? '发' : '收'}) ${e.kind}@${e.globalBit}`).join('；');
    ew.appendChild(ul);
  }

  // 计数表
  const ccb = card.querySelector('.cc-body');
  for (const c of a.counterChanges) {
    const roles = new Set(a.errors.filter((e) => e.node === c.node).map((e) => e.role === 'transmitter' ? '发送方' : '接收方'));
    const dt = c.tecAfter - c.tecBefore, dr = c.recAfter - c.recBefore;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(c.node)}</td><td>${[...roles].join('/') || '旁观'}</td>
      <td>${c.tecBefore} → <b class="${dt > 0 ? 'delta-up' : dt < 0 ? 'delta-down' : ''}">${c.tecAfter}</b> ${dt ? `(${dt > 0 ? '+' : ''}${dt})` : ''}</td>
      <td>${c.recBefore} → <b class="${dr > 0 ? 'delta-up' : dr < 0 ? 'delta-down' : ''}">${c.recAfter}</b> ${dr ? `(${dr > 0 ? '+' : ''}${dr})` : ''}</td>
      <td><span class="badge ${c.modeAfter}">${MODE_TEXT[c.modeAfter]}</span></td>`;
    ccb.appendChild(tr);
  }

  // 迷你轨迹
  const pv = card.querySelector('.trace-preview');
  const errorBits = new Set(a.errors.map((e) => e.globalBit));
  let lastField = null;
  for (const b of a.trace) {
    if (lastField !== b.field && ['SOF', 'ARBITRATION', 'CONTROL', 'DATA', 'CRC', 'CRC_DELIM', 'ACK', 'EOF', 'ERROR_FLAG', 'ERR_DELIM', 'IFS'].includes(b.field)) {
      const sep = document.createElement('span');
      sep.className = 'field-sep'; sep.title = b.field;
      pv.appendChild(sep);
      lastField = b.field;
    }
    const c = document.createElement('span');
    c.className = `mini ${b.bus === 0 ? 'dom' : 'rec'}${b.field === 'STUFF' ? ' stuff' : ''}${errorBits.has(b.i) ? ' error' : ''}`;
    c.title = `#${b.i} ${b.field}/${b.label} = ${b.bus}${b.note ? '\n' + b.note : ''}`;
    c.addEventListener('click', () => openTrace(a, b.i));
    pv.appendChild(c);
  }

  card.querySelector('.att-head').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    card.classList.toggle('open');
  });
  card.querySelector('.btn-open-trace').addEventListener('click', () => { card.classList.add('open'); openTrace(a); });
  return card;
}

function bitTxt(v) { return v === 0 ? '显性(0)' : v === 1 ? '隐性(1)' : '—'; }

/* ------------------------- 位回放播放器 ------------------------- */

const player = { trace: null, idx: 0, timer: null, attempt: null };

function openTrace(a, gotoBit) {
  player.attempt = a;
  player.trace = a.trace;
  $('#trace-title').textContent = `帧尝试 #${a.index} · 获胜 ${a.winner} · ${a.frameIdHex} · 共 ${a.trace.length} 位`;
  $('#tr-slider').max = String(a.trace.length - 1);
  const start = gotoBit !== undefined ? a.trace.findIndex((b) => b.i >= gotoBit) : 0;
  renderTrack();
  seek(Math.max(0, start));
  $('#trace-modal').classList.remove('hidden');
  play();
}

function closeTrace() {
  stop();
  $('#trace-modal').classList.add('hidden');
}
$('#trace-close').addEventListener('click', closeTrace);
$('#trace-modal').addEventListener('click', (e) => { if (e.target.id === 'trace-modal') closeTrace(); });

function renderTrack() {
  const track = $('#tr-track');
  track.innerHTML = '';
  const frag = document.createDocumentFragment();
  const errorBits = new Set(player.attempt.errors.map((e) => e.globalBit));
  player.trace.forEach((b, k) => {
    const cell = document.createElement('span');
    cell.className = `bitcell ${b.bus === 0 ? 'dom' : 'rec'}${b.field === 'STUFF' ? ' stuff' : ''}${errorBits.has(b.i) ? ' errorbit' : ''}`;
    cell.dataset.k = k;
    cell.innerHTML = `<span class="bar"></span>`;
    cell.title = `#${b.i} ${b.field}/${b.label}`;
    cell.addEventListener('click', () => seek(k));
    frag.appendChild(cell);
  });
  track.appendChild(frag);
  $('#tr-legend').innerHTML = `
    <span><span class="sw" style="background:var(--dom)"></span>显性 0（SOF/仲裁/数据）</span>
    <span><span class="sw" style="background:var(--rec)"></span>隐性 1（线与空闲）</span>
    <span><span class="sw" style="background:var(--passive)"></span>填充位</span>
    <span><span class="sw" style="background:var(--err)"></span>违规证据位</span>`;
}

function seek(k) {
  player.idx = Math.max(0, Math.min(player.trace.length - 1, k));
  const b = player.trace[player.idx];
  $$('#tr-track .bitcell').forEach((el, i) => el.classList.toggle('cur', i === player.idx));
  $('#tr-slider').value = String(player.idx);
  $('#tr-pos').textContent = `#${b.i} / ${player.trace[player.trace.length - 1].i}`;
  const drives = b.drives ? Object.entries(b.drives).map(([n, v]) => `${escapeHtml(n)} 发 ${v}`).join('；') : '（无驱动器，空闲）';
  $('#tr-detail').innerHTML = `
    <div><b>${b.field} / ${b.label}</b>　总线 = ${b.bus === 0 ? '显性 0' : '隐性 1'}　|　${drives}</div>
    ${b.note ? `<div style="color:var(--warn);margin-top:3px">${escapeHtml(b.note)}</div>` : ''}`;
  const cur = $('#tr-track .bitcell.cur');
  cur?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
}

function play() {
  stop();
  $('#tr-play').textContent = '⏸ 暂停';
  const ms = Number($('#tr-speed').value);
  player.timer = setInterval(() => {
    if (player.idx >= player.trace.length - 1) { stop(); $('#tr-play').textContent = '▶ 播放'; return; }
    seek(player.idx + 1);
  }, ms);
}
function stop() { if (player.timer) { clearInterval(player.timer); player.timer = null; } }

$('#tr-play').addEventListener('click', () => {
  if (player.timer) { stop(); $('#tr-play').textContent = '▶ 播放'; }
  else { if (player.idx >= player.trace.length - 1) seek(0); play(); }
});
$('#tr-step').addEventListener('click', () => { stop(); $('#tr-play').textContent = '▶ 播放'; seek(player.idx + 1); });
$('#tr-first').addEventListener('click', () => { stop(); $('#tr-play').textContent = '▶ 播放'; seek(0); });
$('#tr-slider').addEventListener('input', (e) => { stop(); $('#tr-play').textContent = '▶ 播放'; seek(Number(e.target.value)); });
$('#tr-speed').addEventListener('change', () => { if (player.timer) play(); });

/* ------------------------- 示例场景 ------------------------- */

const SAMPLES = {
  normal: {
    nodes: [{ name: 'CAM-A', tec: 0 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
    requests: [
      { time: 0, node: 'CAM-A', id: '0x200', dlc: 2, data: '11 22', error: null },
      { time: 0, node: 'CAM-B', id: '0x100', dlc: 1, data: 'AA', error: null },
      { time: 0, node: 'RADAR', id: '0x180', dlc: 0, data: '', error: null },
      { time: 200, node: 'RADAR', id: '0x180', dlc: 0, data: '', error: null },
    ],
  },
  passive: {
    nodes: [{ name: 'CAM-A', tec: 126 }, { name: 'CAM-B', tec: 0 }],
    requests: [
      { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
      { time: 300, node: 'CAM-A', id: '0x101', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
    ],
  },
  busoff: {
    nodes: [{ name: 'CAM-A', tec: 248 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
    requests: [
      { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
      { time: 600, node: 'CAM-B', id: '0x300', dlc: 0, data: '', error: null },
      { time: 1000, node: 'CAM-A', id: '0x200', dlc: 0, data: '', error: null },
    ],
  },
  tie: {
    nodes: [{ name: 'CAM-A', tec: 0 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
    requests: [
      // 同 ID 但载荷首位不同：仲裁场分不出胜负，D0.7 处形成首个驱动分歧错误
      { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: null },
      { time: 0, node: 'CAM-B', id: '0x100', dlc: 1, data: '80', error: null },
      // 后续时刻两节点整帧完全一致：共享同一物理帧共同发送
      { time: 800, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: null },
      { time: 800, node: 'CAM-B', id: '0x100', dlc: 1, data: '00', error: null },
    ],
  },
};

function loadSample(key) {
  const s = JSON.parse(JSON.stringify(SAMPLES[key]));
  state.nodes = s.nodes;
  state.requests = s.requests;
  renderAll();
}
$('#btn-sample-normal').addEventListener('click', () => loadSample('normal'));
$('#btn-sample-passive').addEventListener('click', () => loadSample('passive'));
$('#btn-sample-busoff').addEventListener('click', () => loadSample('busoff'));
$('#btn-sample-tie').addEventListener('click', () => loadSample('tie'));

/* ------------------------- 工具 ------------------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ------------------------- 初始化 ------------------------- */

renderAll();
