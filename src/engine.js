/**
 * 星载载荷共用 CAN 总线位级回放引擎（CAN 2.0A 标准数据帧，零依赖）
 *
 * 位级建模：
 *  SOF / 11 位标识符仲裁（MSB 先发；显性 0、线与；低标识符获胜）/ RTR
 *  位填充（SOF~CRC 序列，每 5 个连续同电平后插入 1 个反相填充位，仲裁期同样生效）
 *  控制场 IDE/r0/DLC、数据场（0~8 字节）、CRC15(多项式 0x4599)+CRC 界定符
 *  ACK 槽 / ACK 界定符 / EOF(7) / 帧间隔 IFS(3)
 *  错误标志（主动错误 6 显性 / 被动错误 6 隐性）+ 错误界定符(8 隐性)
 *
 * 仲裁证据：定位失败节点“首次发送隐性位而总线为显性位”的全局位位置。
 *
 * 仲裁平局（标准数据帧 RTR 相同且 11 位标识符完全相同）：无仲裁败者，各方
 * 继续共同驱动 IDE/r0/DLC/数据/CRC。整帧内容（DLC+载荷，CRC 随之确定）完全
 * 一致才能共享同一物理帧与 ACK 成功结局；否则在逻辑内容的**首个驱动不一致位**，
 * 驱动隐性的一方回读显性 → 位错误（TEC+8），下一位起的主动错误标志在受填充区
 * 表现为 6 连同电平，驱动显性的一方随即检出位/位填充错误（TEC+8），整帧销毁、
 * 无 ACK，帧间隔后各自自动重传；持续冲突按 CAN 规则升级错误被动直至 bus-off。
 *
 * 错误标注（仅作用于该请求的首次发送尝试，重传按瞬时故障恢复）：
 *  ack：无任何接收节点应答        crc：指定接收节点 CRC 校验失败
 *  bit：发送方指定数据位回读异常
 *
 * 错误计数：发送/接收方检出错误 TEC/REC +8；正常完成 -1（下限 0）。
 * TEC>=128 或 REC>=128 错误被动；TEC>=256 bus-off。
 * bus-off 节点不参与后续仲裁、新请求拒绝；监测到 128 次 11 连续隐性位序列后恢复并清零。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CanEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DOM = 0;
  const REC = 1;
  const MAX_NODES = 4;
  const MAX_REQUESTS = 24;
  const RECOVERY_GROUPS = 128;
  const RECOVERY_GROUP_LEN = 11;
  const CRC_POLY = 0x4599;

  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  function crc15(bits) {
    let crc = 0;
    for (const b of bits) {
      const si = ((crc >> 14) & 1) ^ (b & 1);
      crc = (crc << 1) & 0x7fff;
      if (si) crc ^= CRC_POLY;
    }
    return crc >>> 0;
  }

  const fmtId = (id) => '0x' + id.toString(16).toUpperCase().padStart(3, '0');

  /* ------------------------- 输入校验（字段级） ------------------------- */

  function validateInput(input) {
    const errors = [];
    const field = (p, m) => errors.push({ field: p, message: m });

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      field('', '请求体必须是对象');
      return { errors, value: null };
    }

    const rawNodes = Array.isArray(input.nodes) ? input.nodes : null;
    if (!rawNodes) field('nodes', '缺少节点列表');
    else if (rawNodes.length < 1) field('nodes', '至少需要 1 个节点');
    else if (rawNodes.length > MAX_NODES) field('nodes', `节点数量不得超过 ${MAX_NODES} 个`);

    const names = new Set();
    const nodes = (rawNodes || []).slice(0, MAX_NODES + 1).map((n, i) => {
      const p = `nodes[${i}]`;
      if (!n || typeof n !== 'object' || Array.isArray(n)) { field(p, '节点必须是对象'); return null; }
      const name = typeof n.name === 'string' ? n.name.trim() : '';
      if (!name) field(`${p}.name`, '节点名称不能为空');
      else if (name.length > 8) field(`${p}.name`, '节点名称最长 8 个字符');
      else if (names.has(name)) field(`${p}.name`, `节点名称「${name}」重复`);
      else names.add(name);
      let tec = n.tec;
      if (tec === undefined || tec === null) tec = 0;
      if (!isInt(tec) || tec < 0 || tec > 255) field(`${p}.tec`, '初始发送错误计数必须是 0~255 的整数');
      return { name, tec: isInt(tec) && tec >= 0 && tec <= 255 ? tec : 0 };
    }).filter(Boolean);

    const rawReqs = Array.isArray(input.requests) ? input.requests : null;
    if (!rawReqs) field('requests', '缺少数据帧请求列表');
    else if (rawReqs.length > MAX_REQUESTS) field('requests', `数据帧请求不得超过 ${MAX_REQUESTS} 条`);

    const requests = [];
    let lastTime = null;
    (rawReqs || []).slice(0, MAX_REQUESTS + 1).forEach((r, i) => {
      const p = `requests[${i}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) { field(p, '请求必须是对象'); return; }

      let time = r.time;
      if (time === undefined || time === null) time = i;
      if (!isInt(time) || time < 0) { field(`${p}.time`, '时刻必须是非负整数'); time = i; }
      else if (lastTime !== null && time < lastTime) field(`${p}.time`, '请求必须按时刻非递减排列');
      lastTime = time;

      const node = typeof r.node === 'string' ? r.node.trim() : '';
      if (!names.has(node)) field(`${p}.node`, `节点「${r.node}」不存在`);

      let id = r.id;
      if (typeof id === 'string' && /^0x[0-9a-fA-F]{1,3}$/.test(id.trim())) id = parseInt(id.trim(), 16);
      if (!isInt(id) || id < 0 || id > 0x7ff) field(`${p}.id`, '帧标识必须是 0x000~0x7FF 的 11 位标准标识符');
      if (!isInt(id)) id = 0;

      let dlc = r.dlc;
      if (dlc === undefined || dlc === null) dlc = Array.isArray(r.data) ? r.data.length : 0;
      if (!isInt(dlc) || dlc < 0 || dlc > 8) { field(`${p}.dlc`, 'DLC 必须是 0~8 的整数'); dlc = 0; }

      let data = [];
      if (r.data !== undefined && r.data !== null) {
        if (typeof r.data === 'string') {
          const s = r.data.trim().replace(/\s+/g, '');
          if (s === '') data = [];
          else if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
            for (let k = 0; k < s.length; k += 2) data.push(parseInt(s.slice(k, k + 2), 16));
          } else field(`${p}.data`, '载荷必须是偶数位十六进制字节串（如 11 22 AB）');
        } else if (Array.isArray(r.data)) {
          data = r.data.map((b, j) => {
            if (!isInt(b) || b < 0 || b > 255) { field(`${p}.data[${j}]`, '数据字节必须是 0~255 的整数'); return 0; }
            return b;
          });
        } else field(`${p}.data`, '载荷格式无效');
      }
      if (data.length > 8) { field(`${p}.data`, '经典 CAN 单帧载荷最多 8 字节'); data = data.slice(0, 8); }
      if (data.length > dlc) field(`${p}.data`, `载荷长度 ${data.length} 字节超出 DLC=${dlc}`);
      while (data.length < dlc) data.push(0);
      data = data.slice(0, dlc);

      let annotation = null;
      const e = r.error;
      if (e !== undefined && e !== null && e !== '') {
        if (typeof e !== 'object' || Array.isArray(e)) { field(`${p}.error`, '错误标注必须是对象'); }
        else if (!['ack', 'crc', 'bit'].includes(e.type)) {
          field(`${p}.error.type`, '错误类型只能是 ack、crc 或 bit');
        } else if (e.type === 'bit') {
          const pos = e.dataBit;
          const maxBit = dlc * 8 - 1;
          if (!isInt(pos) || pos < 0 || pos > maxBit) {
            field(`${p}.error.dataBit`,
              dlc === 0 ? 'DLC=0 的帧没有可标注的数据位' : `数据位位置必须是 0~${maxBit} 的整数（按 Dn.7→Dn.0 展平）`);
          } else annotation = { type: 'bit', dataBit: pos };
        } else if (e.type === 'crc') {
          const src = typeof e.sourceNode === 'string' ? e.sourceNode.trim() : '';
          if (!src) field(`${p}.error.sourceNode`, 'CRC 错误须指定来源接收节点');
          else if (src === node) field(`${p}.error.sourceNode`, 'CRC 错误来源不能是发送节点自身');
          else if (!names.has(src)) field(`${p}.error.sourceNode`, `错误来源节点「${src}」不存在`);
          else annotation = { type: 'crc', sourceNode: src };
        } else {
          // ACK 故障必须存在其他节点（否则物理上永远无应答，只能一路升级至 bus-off）
          if (names.size < 2) field(`${p}.error.type`, '标注 ACK 错误要求总线上至少配置 2 个节点（须存在可能的应答者）');
          else annotation = { type: 'ack' };
        }
      }

      requests.push({ time, node, id, dlc, data, error: annotation });
    });

    if (errors.length) return { errors, value: null };
    return { errors: [], value: { nodes, requests } };
  }

  /* ----------------------------- 位级仿真 ----------------------------- */

  const modeOf = (tec, rec) =>
    (tec >= 256 ? 'bus-off' : (tec >= 128 || rec >= 128) ? 'passive' : 'active');

  function simulate(rawInput) {
    const { errors, value } = validateInput(rawInput);
    if (errors.length) return { ok: false, errors };

    const input = value;
    const st = new Map();
    for (const n of input.nodes) st.set(n.name, { tec: n.tec, rec: 0, mode: modeOf(n.tec, 0), busOffAt: null });

    const pending = input.requests.map((r, index) => ({ ...r, index }));
    const outcomes = input.requests.map((r, index) => ({
      index, time: r.time, node: r.node, id: r.id,
      status: null, reason: null, attempts: [],
    }));
    const retransmitted = new Set(); // 标注只作用于首次尝试
    const attempts = [];
    const events = [];
    const segments = [];
    let frameSeg = null, idleSeg = null;
    let t = 0, attemptSeq = 0;
    const recovery = new Map();
    const busOffRounds = new Map(); // 节点 → 累计 bus-off 次数（用于识别持续同内容冲突的病态 livelock）

    function beginIdle() {
      if (!idleSeg) { idleSeg = { type: 'idle', startBit: t, bits: [] }; segments.push(idleSeg); }
      frameSeg = null;
    }
    function beginFrame(attemptIndex) {
      idleSeg = null;
      frameSeg = { type: 'frame', startBit: t, bits: [], attemptIndex };
      segments.push(frameSeg);
    }

    function recoveryTick(bit) {
      for (const [name, rc] of recovery) {
        if (bit === REC) {
          rc.partial++;
          if (rc.partial === RECOVERY_GROUP_LEN) {
            rc.partial = 0;
            rc.groups++;
            if (rc.groups >= RECOVERY_GROUPS) {
              const s = st.get(name);
              s.tec = 0; s.rec = 0; s.mode = 'active'; s.busOffAt = null;
              recovery.delete(name);
              events.push({ type: 'recovered', node: name, atBit: t, groups: RECOVERY_GROUPS });
            }
          }
        } else rc.partial = 0; // 显性位打断当前连续序列，已累计次数保留
      }
    }

    function emit(fieldName, label, bus, drives, note) {
      const bit = { i: t, field: fieldName, label, bus };
      if (note) bit.note = note;
      if (drives && Object.keys(drives).length) bit.drives = { ...drives };
      (frameSeg || (beginIdle(), idleSeg)).bits.push(bit);
      t++;
      recoveryTick(bus);
      return bit;
    }

    function idleTo(target) {
      while (t < target) emit('IDLE', 'IDLE', REC, null);
    }

    function rejectDueBusOff(now) {
      for (const req of pending) {
        const s = st.get(req.node);
        if (s.mode !== 'bus-off' || req.time > now) continue;
        if (s.busOffAt !== null && req.time > s.busOffAt) {
          // bus-off 之后到达的新请求：拒绝
          outcomes[req.index].status = 'rejected';
          outcomes[req.index].reason = '节点处于 bus-off，新发送请求被拒绝';
          events.push({ type: 'rejected', requestIndex: req.index, node: req.node, atBit: now });
          req._done = true;
        }
        // bus-off 前已在途的请求保留，恢复后自动重传
      }
      for (let k = pending.length - 1; k >= 0; k--) if (pending[k]._done) pending.splice(k, 1);
    }

    function enterBusOff(name, atBit) {
      const s = st.get(name);
      if (s.mode === 'bus-off') return;
      s.mode = 'bus-off';
      s.busOffAt = atBit;
      recovery.set(name, { groups: 0, partial: 0 });
      busOffRounds.set(name, (busOffRounds.get(name) || 0) + 1);
      events.push({ type: 'bus-off', node: name, atBit, tec: s.tec, round: busOffRounds.get(name) });
      for (const req of pending) {
        if (req.node === name && outcomes[req.index].status !== 'rejected') {
          outcomes[req.index].status = 'waiting-busoff';
          outcomes[req.index].reason = 'TEC 达到 256 进入 bus-off，在途请求挂起，恢复后重传';
        }
      }
    }

    /* ------------------------- 单次发送尝试 ------------------------- */

    function runAttempt(contenders) {
      const attemptIndex = attemptSeq++;
      beginFrame(attemptIndex);
      const startBit = frameSeg.startBit;

      const w0 = contenders[0];
      const isRetry = (reqIdx) => retransmitted.has(reqIdx);
      const deltas = new Map();
      const snap = (name) => {
        const s = st.get(name);
        return { node: name, tecBefore: s.tec, recBefore: s.rec, tecAfter: s.tec, recAfter: s.rec, modeAfter: s.mode };
      };
      for (const c of contenders) deltas.set(c.node, snap(c.node));

      /* ---- 阶段 A：SOF + 仲裁场（多节点共同驱动，含联合位填充） ---- */
      const logical = []; // 获胜视角的逻辑位（不含填充位）
      let run = 0, last = null;
      let alive = contenders.map((c) => ({ ...c, lostAt: -1 }));
      const loserEvidence = [];

      function pushRaw(b, fieldName, label, extra) {
        const cell = { b, field: fieldName, label, stuff: false, ...(extra || {}) };
        logical.push(cell);
        if (b === last) run++; else { run = 1; last = b; }
        return cell;
      }
      function jointStuffBit() {
        const sb = last === DOM ? REC : DOM;
        const drives = Object.fromEntries(alive.map((a) => [a.node, sb]));
        emit('STUFF', 'STUFF', sb, drives,
          `连续 5 个${last === DOM ? '显性' : '隐性'}位后插入${sb === DOM ? '显性' : '隐性'}填充位`);
        run = 0; last = null;
      }

      // SOF
      {
        const drives = Object.fromEntries(alive.map((a) => [a.node, DOM]));
        emit('SOF', 'SOF', DOM, drives, `${alive.map((a) => a.node).join('、')} 同时发起 SOF`);
        pushRaw(DOM, 'SOF', 'SOF');
      }

      // ID10..ID0, RTR
      for (let k = 0; k < 12; k++) {
        const label = k < 11 ? `ID${10 - k}` : 'RTR';
        const drives = {};
        for (const a of alive) drives[a.node] = k < 11 ? ((a.req.id >> (10 - k)) & 1) : DOM;
        const bus = Object.values(drives).some((v) => v === DOM) ? DOM : REC;
        const survivors = [];
        for (const a of alive) {
          if (alive.length > 1 && drives[a.node] === REC && bus === DOM && a.lostAt < 0) {
            a.lostAt = k;
            loserEvidence.push({
              node: a.node, requestIndex: a.req.index, arbBitIndex: k, label,
              sent: REC, bus: DOM, globalBit: t,
              detail: `节点 ${a.node} 在仲裁场 ${label}（第 ${k + 1} 个标识符/RTR 位）首次发送隐性位(1)，总线被低标识符节点拉为显性位(0)，仲裁失败并转为接收`,
            });
          }
          if (a.lostAt < 0) survivors.push(a);
        }
        emit('ARBITRATION', label, bus, drives,
          alive.length > 1 ? `仲裁位 ${label}：${alive.map((a) => `${a.node}发${drives[a.node]}`).join('，')}` : null);
        const winnerVal = survivors.length ? drives[survivors[0].node] : bus;
        pushRaw(winnerVal, 'ARBITRATION', label);
        if (run === 5) jointStuffBit();
        alive = survivors;
      }

      let winner, tieNote = null;
      if (alive.length === 1) {
        winner = alive[0];
      } else {
        // 标识符与 RTR 完全相同：仲裁场未分胜负，无人获得独占发送权。
        // 按节点顺序仅作确定性展示，各方仍为共同发送方（见 phaseB 联合驱动）。
        winner = alive[0];
        tieNote = `标识符 ${fmtId(winner.req.id)} 与 RTR 完全相同，仲裁场未分胜负，各节点继续共同驱动控制场/数据场/CRC`;
      }
      // 共同发送方：仲裁平局的全部存活节点。整帧内容（DLC+载荷，CRC 随之唯一确定）
      // 完全一致时共享同一物理帧；否则在首个驱动不一致位产生真实位错误。
      const jointTxs = alive.length > 1 ? alive.map((a) => ({
        name: a.node,
        req: a.req,
        cells: [
          { b: DOM, field: 'CONTROL', label: 'IDE' },
          { b: DOM, field: 'CONTROL', label: 'r0' },
          ...[3, 2, 1, 0].map((k) => ({ b: (a.req.dlc >> k) & 1, field: 'CONTROL', label: `DLC.${k}` })),
          ...a.req.data.flatMap((byte, bi) =>
            [...Array(8).keys()].map((k) => ({
              b: (byte >> (7 - k)) & 1, field: 'DATA', label: `D${bi}.${7 - k}`, dataBit: bi * 8 + k,
            }))),
        ],
      })) : null;
      const identicalFrame = jointTxs
        ? jointTxs.every((j) => j.req.dlc === winner.req.dlc &&
            j.req.data.length === winner.req.data.length &&
            j.req.data.every((b, k) => b === winner.req.data[k]))
        : true;
      const sharedTransmitters = (jointTxs && identicalFrame)
        ? alive.map((a) => ({
          node: a.node,
          requestIndex: a.req.index,
          dlc: a.req.dlc,
          data: [...a.req.data],
        }))
        : null;
      const wReq = winner.req;
      const annotation = isRetry(wReq.index) ? null : wReq.error;

      /* ---- 接收观察者（bus-off 节点与全部共同发送方不参与；ACK 故障时总线上无接收者） ---- */
      const txNames = jointTxs ? jointTxs.map((j) => j.name) : [wReq.node];
      const observerNames = [];
      for (const name of st.keys()) {
        if (txNames.includes(name) || st.get(name).mode === 'bus-off') continue;
        if (annotation && annotation.type === 'ack') continue;
        observerNames.push(name);
      }
      const obs = new Map();
      for (const name of observerNames) {
        const crcFault = annotation && annotation.type === 'crc' && annotation.sourceNode === name;
        // 故障注入点：该接收者在固定位置读到反相位（优先 D0.7，DLC=0 时为 IDE）
        const flipLabel = wReq.dlc > 0 ? 'D0.7' : 'IDE';
        obs.set(name, {
          name, phase: 'rx', flagLeft: 0, delimLeft: 0, pendingFlag: false,
          run, last, expectStuff: false, rawSeen: logical.map((c) => c.b),
          crcDecided: false, crcFail: crcFault, flipLabel, crcCalc: 0, firstMismatch: -1, violation: null,
          foreign: false, delimWatch: 0,
        });
      }

      const errorsFound = [];
      function addViolation(node, role, kind, bitRec, extra) {
        const ev = { node, role, kind, globalBit: bitRec.i, ...extra };
        errorsFound.push(ev);
        if (!deltas.has(node)) deltas.set(node, snap(node));
        const s = st.get(node);
        if (role === 'transmitter') { s.tec += 8; } else { s.rec += 8; }
        return ev;
      }

      /* ---- 阶段 B/C：控制场 + 数据场 + CRC + 固定场 + 错误标志 + 界定符 + IFS ----
         普通仲裁仅获胜方独占驱动；仲裁平局时各方共同驱动，首个逻辑驱动不一致位
         即为可复核的真实位错误（驱动隐性方回读显性 → TEC+8 → 错误标志）。 */
      const fixedCells = [
        { b: REC, field: 'CRC_DELIM', label: 'CRC_DELIM' },
        { b: REC, field: 'ACK', label: 'ACK_SLOT', ackSlot: true },
        { b: REC, field: 'ACK', label: 'ACK_DELIM', ackDelim: true },
      ];
      for (let k = 0; k < 7; k++) fixedCells.push({ b: REC, field: 'EOF', label: `EOF${k}` });

      // 发送方表：普通仲裁 1 个；仲裁平局时为全部共同发送节点
      const txList = (jointTxs || [{ name: wReq.node, req: wReq, cells: null }]).map((j) => {
        const cells = j.cells || [
          { b: DOM, field: 'CONTROL', label: 'IDE' },
          { b: DOM, field: 'CONTROL', label: 'r0' },
          ...[3, 2, 1, 0].map((k) => ({ b: (j.req.dlc >> k) & 1, field: 'CONTROL', label: `DLC.${k}` })),
          ...j.req.data.flatMap((byte, bi) =>
            [7, 6, 5, 4, 3, 2, 1, 0].map((k) => ({
              b: (byte >> k) & 1, field: 'DATA', label: `D${bi}.${k}`, dataBit: bi * 8 + (7 - k),
            }))),
        ];
        const crcVal = crc15([...logical.map((c) => c.b), ...cells.map((c) => c.b)]);
        const allCells = [
          ...cells,
          ...[14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
            .map((k) => ({ b: (crcVal >> k) & 1, field: 'CRC', label: `CRC${k}` })),
        ];
        return {
          name: j.name, req: j.req, cells, allCells, crc: crcVal,
          phase: 'send', idx: 0, fixIdx: 0,
          run, last, // 延续仲裁场的位填充计数（平局各方此前逻辑位完全一致）
          pendingFlag: false, flagLeft: 0, delimLeft: 0, imsLeft: 0,
          ackFail: false, violation: null,
          passive: st.get(j.name).mode === 'passive',
        };
      });
      const txs = new Map(txList.map((x) => [x.name, x]));
      const crc = txs.get(wReq.node).crc; // 结果展示用获胜方视角 CRC

      // 发送方下一位驱动：内容/CRC（含自发填充位）或固定格式场
      function nextSendBit(x) {
        if (x.run === 5 && x.idx >= x.allCells.length) {
          return { b: x.last === DOM ? REC : DOM, stuff: true, field: 'STUFF', label: 'STUFF' };
        }
        if (x.idx < x.allCells.length) {
          if (x.run === 5) return { b: x.last === DOM ? REC : DOM, stuff: true, field: 'STUFF', label: 'STUFF' };
          return { ...x.allCells[x.idx++], stuff: false };
        }
        if (x.fixIdx < fixedCells.length) return { ...fixedCells[x.fixIdx++], stuff: false, fix: true };
        return null;
      }

      function txBitViolation(x, bitRec, bb, bus, injected, collision, detail) {
        x.violation = addViolation(x.name, 'transmitter', 'bit', bitRec, {
          frameField: bb.stuff ? 'STUFF' : (bb.field || 'DATA'),
          fieldLabel: bb.stuff ? 'STUFF' : (bb.label || ''),
          expected: bb.b, actual: bus, injected: !!injected, collision: !!collision,
          detail,
        });
        x.pendingFlag = true;
      }

      function feedOneStuffed(o, bitRec, cell, bus) {
        if (o.phase !== 'rx') return;
        if (cell.stuffSlot) {
          if (o.expectStuff) {
            if (bus === o.last) {
              addViolation(o.name, 'receiver', 'stuff', bitRec, {
                frameField: 'STUFF', fieldLabel: 'STUFF', expected: 1 - o.last, actual: bus,
                detail: `接收节点 ${o.name} 期待反相填充位却读到连续第 6 个${bus === DOM ? '显性' : '隐性'}位，位填充错误`,
              });
              o.pendingFlag = true;
            }
            o.expectStuff = false; o.run = 0; o.last = null;
          }
          return;
        }
        let v = bus;
        if (o.crcFault && cell.label === o.flipLabel) v = 1 - v; // 故障节点内部采样受扰
        if (bus === o.last) o.run++; else { o.run = 1; o.last = bus; }
        o.rawSeen.push(v);
        if (o.run === 5) o.expectStuff = true;
      }
      function feedReceiversStuffed(bitRec, cell, bus) {
        for (const o of obs.values()) feedOneStuffed(o, bitRec, cell, bus);
      }

      function feedReceiversFlag(bitRec, bus, drivenByRx) {
        // 错误标志对接收者的影响：
        //  - 看到他节点显性主动错误标志：全局错误已被标记，静默中止接收等待错误界定符（固定区→格式错误）
        //  - 仅看到 6 连同电平（被动错误标志不可见）：自行检出位填充错误并发主动错误标志
        for (const o of obs.values()) {
          if (o.phase !== 'rx') continue;
          if (bus === DOM && !drivenByRx.has(o.name)) {
            if (o.crcDecided && !o.crcFail) {
              addViolation(o.name, 'receiver', 'form', bitRec, {
                frameField: 'EOF', fieldLabel: 'EOF/ACK 固定区', expected: REC, actual: DOM,
                detail: `接收节点 ${o.name} 在帧尾固定格式区采样到他节点显性错误标志，格式错误`,
              });
              o.pendingFlag = true;
            } else {
              o.phase = 'waitdelim';
              o.delimWatch = 0;
              o.foreign = true;
            }
            continue;
          }
          if (o.crcDecided) continue;
          if (o.expectStuff) {
            if (bus === o.last && !drivenByRx.has(o.name)) {
              addViolation(o.name, 'receiver', 'stuff', bitRec, {
                frameField: 'ERROR_FLAG', fieldLabel: 'ERROR_FLAG', expected: 1 - o.last, actual: bus,
                detail: `被动错误标志为隐性不可见，接收节点 ${o.name} 检出连续第 6 个${bus === DOM ? '显性' : '隐性'}位，位填充错误并发主动错误标志`,
              });
              o.pendingFlag = true;
            }
            o.expectStuff = false; o.run = 0; o.last = null;
          } else if (bus === o.last) o.run++; else { o.run = 1; o.last = bus; }
          if (o.run === 5) o.expectStuff = true;
        }
      }

      // 阶段 B：各方共同发送控制/数据/CRC 逻辑位（含联合填充），直至 CRC 结束或出现分歧
      while (txList.every((x) => x.phase === 'send') && !txList.some((x) => x.pendingFlag)) {
        const bits = new Map();
        for (const x of txList) {
          if (x.idx >= x.allCells.length) continue; // 内容/CRC 已发完，固定场由阶段 C 处理
          if (x.run === 5) bits.set(x.name, { b: x.last === DOM ? REC : DOM, stuff: true, field: 'STUFF', label: 'STUFF' });
          else bits.set(x.name, { ...x.allCells[x.idx++], stuff: false });
        }
        if (!bits.size) break;
        const ref = bits.has(wReq.node) ? txs.get(wReq.node) : txList.find((x) => bits.has(x.name));
        const refBit = bits.get(ref.name);
        const fieldName = refBit.stuff ? 'STUFF' : refBit.field;
        const label = refBit.stuff ? 'STUFF' : refBit.label;
        const drives = Object.fromEntries([...bits.entries()].map(([n, bb]) => [n, bb.b]));
        let bus = Object.values(drives).some((v) => v === DOM) ? DOM : REC;
        const valList = [...bits.values()].map((bb) => bb.b);
        const diverged = valList.some((v) => v === DOM) && valList.some((v) => v === REC);
        let note = null;
        if (diverged) {
          const losers = [...bits.entries()].filter(([, bb]) => bb.b === REC).map(([n]) => n);
          const winners0 = [...bits.entries()].filter(([, bb]) => bb.b === DOM).map(([n]) => n);
          note = `仲裁平局后首个帧内容驱动分歧位：${losers.join('、')} 发隐性(1)，${winners0.join('、')} 发显性(0)，线与总线为显性(0)；${losers.join('、')} 回读不一致，于本位检出位错误，下一位起发送错误标志`;
        }
        // 标注位错误（仅获胜请求的首次尝试）：发送回读反相
        let injectedHere = false;
        if (annotation && annotation.type === 'bit' && !refBit.stuff && refBit.dataBit === annotation.dataBit &&
          bits.has(wReq.node)) {
          bus = 1 - bus;
          injectedHere = true;
          note = `标注数据位错误：${label} 总线回读为${bus === DOM ? '显性(0)' : '隐性(1)'}（注入故障）` +
            (diverged ? `；同时存在共同驱动分歧` : '');
        }
        const bitRec = emit(fieldName, label, bus, drives, note);
        for (const [n, bb] of bits) {
          if (bb.b !== bus) {
            const injected = injectedHere && n === wReq.node;
            txBitViolation(txs.get(n), bitRec, bb, bus, injected, diverged,
              diverged
                ? `仲裁场未能分出胜负，帧内容位 ${bb.stuff ? '填充位' : bb.label}：节点 ${n} 发送${bb.b === DOM ? '显性(0)' : '隐性(1)'}，总线为${bus === DOM ? '显性(0)' : '隐性(1)'}，与共同发送节点驱动不一致，检出位错误，下一位起发送错误标志`
                : `数据位 ${bb.label}：发送 ${bb.b === DOM ? '显性(0)' : '隐性(1)'}，总线回读 ${bus === DOM ? '显性(0)' : '隐性(1)'}，发送方检测到位错误，下一位起发送错误标志`);
          } else if (bb.stuff) {
            const x = txs.get(n); x.run = 0; x.last = null;
          } else {
            const x = txs.get(n); if (bus === x.last) x.run++; else { x.run = 1; x.last = bus; }
          }
        }
        feedReceiversStuffed(bitRec, { field: fieldName, label, stuffSlot: refBit.stuff }, bus);
      }

      /* ---- 阶段 C：固定格式场 + 错误标志 + 界定符 + IFS（各发送方独立相位） ---- */
      const txFlagBitOf = (x) => (x.passive ? REC : DOM);
      const rxFlagBit = (name) => (st.get(name).rec >= 128 ? REC : DOM);

      let guard = 0;
      while (txList.some((x) => x.phase !== 'done') || [...obs.values()].some((o) => o.phase !== 'done')) {
        if (++guard > 2000) throw new Error('引擎内部错误：单帧位推进超过上限');

        for (const x of txList) if (x.pendingFlag && x.phase === 'send') { x.phase = 'flag'; x.flagLeft = 6; x.pendingFlag = false; }
        for (const o of obs.values()) if (o.pendingFlag && o.phase === 'rx') { o.phase = 'flag'; o.flagLeft = 6; o.pendingFlag = false; }

        const drives = {};
        const sendMetas = new Map();
        const flagLabels = [];
        const delimLabels = [];
        let fieldName = 'IDLE', label = '', note = null, cur = null;
        const rxFlagDrivers = new Set();

        for (const x of txList) {
          if (x.phase === 'send' && x.idx >= x.allCells.length && x.run !== 5 && x.fixIdx >= fixedCells.length) {
            x.phase = 'ims'; x.imsLeft = 3; // 固定场全部发完 → 进入 IFS
          }
        }
        for (const x of txList) {
          if (x.phase === 'flag') {
            drives[x.name] = txFlagBitOf(x);
            flagLabels.push(`${x.name}${x.passive ? '(被动,隐性)' : '(主动,显性)'}`);
          } else if (x.phase === 'delim') {
            delimLabels.push(x.name);
          } else if (x.phase === 'ims') {
            if (fieldName === 'IDLE') { fieldName = 'IFS'; label = 'INTERMISSION'; }
          } else if (x.phase === 'send') {
            const bb = nextSendBit(x);
            if (!bb) { x.phase = 'ims'; x.imsLeft = 3; }
            else {
              drives[x.name] = bb.b;
              sendMetas.set(x.name, bb);
              if (!cur && bb.fix) cur = bb;
            }
          }
        }
        for (const [name, o] of obs) {
          if (o.phase === 'flag') {
            drives[name] = rxFlagBit(name);
            rxFlagDrivers.add(name);
          }
        }
        // 仍在发送的代表帧（接收者跟随其总线序列；被动错误标志不可见时存活帧继续）
        const lead = txList.find((x) => x.phase === 'send') || null;
        const leadBit = lead ? sendMetas.get(lead.name) : null;
        if (leadBit) {
          fieldName = leadBit.stuff ? 'STUFF' : leadBit.field;
          label = leadBit.stuff ? 'STUFF' : leadBit.label;
        }
        if (flagLabels.length) {
          fieldName = 'ERROR_FLAG';
          const parts = [];
          if (leadBit) parts.push(`${lead.name} 继续驱动 ${leadBit.stuff ? 'STUFF' : leadBit.label}`);
          parts.push(`错误标志：${flagLabels.join('、')}`);
          label = parts.join('｜');
          note = flagLabels.some((s) => s.includes('被动'))
            ? '错误被动节点发送 6 个隐性错误标志（对总线不可见）；主动错误标志为 6 个显性位'
            : null;
        } else if (!leadBit && delimLabels.length) {
          fieldName = 'ERR_DELIM'; label = `ERR_DELIM(${delimLabels.join('、')})`;
        }

        // ACK 槽：CRC 正确的接收者填显性
        const isAckSlot = !!(leadBit && leadBit.ackSlot);
        if (isAckSlot) {
          for (const o of obs.values()) {
            if (o.phase === 'rx' && o.crcDecided && !o.crcFail) drives[o.name] = DOM;
          }
          if (txList.length > 1 && identicalFrame && txList.every((x) => x.phase === 'send')) {
            // 整帧内容完全一致的共同发送方：各自接收校验均通过，在唯一 ACK 槽互为应答者
            for (const x of txList) if (x.phase === 'send') drives[x.name] = DOM;
            note = `整帧内容完全一致，共同发送节点 ${txList.map((x) => x.name).join('、')} 在 ACK 槽互为应答者，共享同一物理帧完成`;
          }
          if (annotation && annotation.type === 'ack') note = '标注 ACK 错误：总线上无接收节点，ACK 槽保持隐性';
        }
        const bus = Object.values(drives).some((v) => v === DOM) ? DOM : REC;
        const bitRec = emit(fieldName, label, bus, drives, note);

        // ---- 发送方逐位监视 ----
        for (const x of txList) {
          if (x.phase !== 'send') continue;
          const bb = sendMetas.get(x.name);
          if (!bb) continue;
          if (!bb.fix) {
            if (bb.b !== bus) {
              const otherFlag = txList.some((q) => q !== x && (q.phase === 'flag'));
              txBitViolation(x, bitRec, bb, bus, false, true,
                bb.stuff
                  ? `共同发送节点 ${x.name} 的填充位回读与总线不一致（${bus === DOM ? '显性(0)' : '隐性(1)'}），检出位错误`
                  : otherFlag
                    ? `节点 ${x.name} 继续发送 ${bb.label}（${bb.b === DOM ? '显性(0)' : '隐性(1)'}），总线被共同发送节点的错误标志拉为${bus === DOM ? '显性(0)' : '隐性(1)'}，检出位/位填充错误`
                    : `节点 ${x.name} 在 ${bb.label} 发送${bb.b === DOM ? '显性(0)' : '隐性(1)'}而总线为${bus === DOM ? '显性(0)' : '隐性(1)'}，检出位错误`);
            } else if (bb.stuff) { x.run = 0; x.last = null; }
            else { if (bus === x.last) x.run++; else { x.run = 1; x.last = bus; } }
          } else if (bb.ackSlot) {
            if (bus === REC && !x.ackFail) {
              x.ackFail = true;
              x.violation = addViolation(x.name, 'transmitter', 'ack', bitRec, {
                frameField: 'ACK', fieldLabel: 'ACK_SLOT', expected: DOM, actual: REC,
                injected: !!(annotation && annotation.type === 'ack'),
                detail: txList.length > 1
                  ? `共同发送节点均为发送方、不能为自身帧应答，ACK 槽总线为隐性位，节点 ${x.name} 检出 ACK 错误，ACK 界定符后发送错误标志`
                  : 'ACK 槽总线为隐性位，没有任何节点应答，发送方检出 ACK 错误，ACK 界定符后发送错误标志',
              });
            }
          } else if (bb.ackDelim) {
            if (x.ackFail) x.pendingFlag = true;
          } else if (bus === DOM && bb.field !== 'ACK_SLOT') {
            // CRC 界定符 / ACK 界定符 / EOF：应为隐性，被错误标志拉显性 → 格式错误
            addViolation(x.name, 'transmitter', 'form', bitRec, {
              frameField: bb.field, fieldLabel: bb.label, expected: REC, actual: DOM,
              detail: `固定格式位 ${bb.label} 应为隐性，总线被错误标志拉为显性，发送方 ${x.name} 检出格式错误`,
            });
            x.violation = { kind: 'form' };
            x.pendingFlag = true;
          }
        }

        // ---- 接收方监视 ----
        const activeFlagOnBus = txList.some((x) => x.phase === 'flag' && txFlagBitOf(x) === DOM) ||
          [...obs.values()].some((o) => o.phase === 'flag' && rxFlagBit(o.name) === DOM);
        const anyTxFlag = txList.some((x) => x.phase === 'flag');
        if (activeFlagOnBus || (anyTxFlag && !lead)) {
          feedReceiversFlag(bitRec, bus, rxFlagDrivers);
        } else if (leadBit && !leadBit.fix) {
          feedReceiversStuffed(bitRec, { field: leadBit.field, label: leadBit.label, stuffSlot: leadBit.stuff }, bus);
        } else if (leadBit) {
          for (const o of obs.values()) {
            if (o.phase !== 'rx') continue;
            if (leadBit.label === 'CRC_DELIM' && !o.crcDecided) {
              o.crcDecided = true;
              const seen = o.rawSeen;
              const seenCrc = seen.slice(-15);
              o.crcCalc = crc15(seen.slice(0, -15));
              for (let k = 0; k < 15; k++) {
                if (seenCrc[k] !== ((o.crcCalc >> (14 - k)) & 1)) { o.crcFail = true; o.firstMismatch = 14 - k; break; }
              }
              if (o.crcFail) {
                addViolation(o.name, 'receiver', 'crc', bitRec, {
                  frameField: 'CRC', fieldLabel: o.firstMismatch >= 0 ? `CRC${o.firstMismatch}` : 'CRC',
                  injected: o.crcFault,
                  crcExpected: '0x' + o.crcCalc.toString(16).toUpperCase().padStart(4, '0'),
                  crcReceived: '0x' + lead.crc.toString(16).toUpperCase().padStart(4, '0'),
                  detail: o.crcFault
                    ? `接收节点 ${o.name} 在 ${o.flipLabel} 处读到受扰数据，本地计算 CRC=0x${o.crcCalc.toString(16).toUpperCase().padStart(4, '0')} 与收到 CRC 0x${lead.crc.toString(16).toUpperCase().padStart(4, '0')} 不符${o.firstMismatch >= 0 ? `，首个不一致位为 CRC${o.firstMismatch}` : ''}；CRC 界定符处确认失败，不填 ACK，并在 EOF 起点发送错误标志`
                    : `接收节点 ${o.name} CRC 校验失败，EOF 起点发送错误标志`,
                });
              }
            } else if (leadBit.ackDelim) {
              if (o.crcFail) o.pendingFlag = true;
            } else if ((leadBit.field === 'CRC_DELIM' || leadBit.field === 'EOF') && bus === DOM) {
              addViolation(o.name, 'receiver', 'form', bitRec, {
                frameField: leadBit.field, fieldLabel: leadBit.label, expected: REC, actual: DOM,
                detail: `接收节点 ${o.name} 在固定格式位 ${leadBit.label} 采样到显性，格式错误`,
              });
              o.pendingFlag = true;
            }
          }
        }

        // ---- 相位推进 ----
        for (const x of txList) {
          if (x.phase === 'flag' && --x.flagLeft === 0) { x.phase = 'delim'; x.delimLeft = 8; }
          else if (x.phase === 'delim' && --x.delimLeft === 0) { x.phase = 'ims'; x.imsLeft = 3; }
          else if (x.phase === 'ims' && --x.imsLeft === 0) x.phase = 'done';
        }
        for (const o of obs.values()) {
          if (o.phase === 'flag' && --o.flagLeft === 0) { o.phase = 'delim'; o.delimLeft = 8; }
          else if (o.phase === 'delim' && --o.delimLeft === 0) o.phase = 'done';
          else if (o.phase === 'waitdelim') {
            if (bus === REC) o.delimWatch++;
            if (o.delimWatch >= 8) o.phase = 'done';
          } else if (o.phase === 'rx' && !txList.some((x) => x.phase === 'send' || x.phase === 'flag')) {
            o.phase = 'done';
          }
        }
      }

      /* ---- 错误计数与模式迁移（逐发送方/接收者） ---- */
      const txOk = new Map();
      for (const x of txList) {
        const ok = !x.violation && !errorsFound.some((e) => e.node === x.name);
        txOk.set(x.name, ok);
        const s = st.get(x.name);
        if (ok) s.tec = Math.max(0, s.tec - 1);
        const before = deltas.has(x.name) ? deltas.get(x.name).modeAfter : s.mode;
        const m = modeOf(s.tec, s.rec);
        if (m === 'bus-off') enterBusOff(x.name, t);
        else {
          s.mode = m;
          if (m === 'passive' && before === 'active') events.push({ type: 'error-passive', node: x.name, atBit: t, tec: s.tec });
        }
      }
      for (const o of obs.values()) {
        const s = st.get(o.name);
        if (!errorsFound.some((e) => e.node === o.name) && !o.foreign) s.rec = Math.max(0, s.rec - 1);
        if (s.mode === 'bus-off') continue;
        const before = deltas.has(o.name) ? deltas.get(o.name).modeAfter : s.mode;
        const m = modeOf(s.tec, s.rec);
        if (m === 'bus-off') { enterBusOff(o.name, t); continue; }
        if (m === 'passive' && before === 'active') events.push({ type: 'error-passive', node: o.name, atBit: t, tec: s.tec, rec: s.rec });
        s.mode = m;
      }
      for (const [name, d] of deltas) {
        const s = st.get(name);
        d.tecAfter = s.tec; d.recAfter = s.rec; d.modeAfter = s.mode;
      }

      // 请求结局：成功方移除；失败方保留，帧间隔后自动重传（标注仅首次生效）
      for (const c of contenders) outcomes[c.req.index].attempts.push(attemptIndex);
      const allTxOk = txList.every((x) => txOk.get(x.name));
      const anyTxOk = txList.some((x) => txOk.get(x.name));
      for (const x of txList) {
        const ok = txOk.get(x.name);
        const o = outcomes[x.req.index];
        if (ok) {
          for (let k = pending.length - 1; k >= 0; k--) if (pending[k].index === x.req.index) pending.splice(k, 1);
          o.status = 'transmitted';
          if (txList.length > 1 && allTxOk && identicalFrame) {
            o.reason = `与 ${txList.filter((q) => q.name !== x.name).map((q) => q.name).join('、')} 标识符与整帧内容完全一致，共享同一物理帧共同发送完成（回放保留全部参与发送节点）`;
          } else if (txList.length > 1) {
            const failed = txList.filter((q) => !txOk.get(q.name)).map((q) => q.name);
            o.reason = `同标识符共同发送中本节点帧正常应答完成；${failed.join('、')} 因帧内容不一致检出错误，已另行自动重传`;
          } else o.reason = null;
        } else {
          retransmitted.add(x.req.index);
          if (o.status === 'transmitted') { /* 不应发生 */ }
          else if (o.status !== 'waiting-busoff') o.status = 'pending-retry';
          const firstCollision = errorsFound.find((e) => e.collision);
          o.reason = firstCollision
            ? `标识符仲裁平局但整帧内容不同，在首个驱动不一致位（${firstCollision.fieldLabel}，全局位 ${firstCollision.globalBit}）检出位错误，错误标志销毁该帧，帧间隔后自动重传；持续冲突将升级 TEC 直至 bus-off`
            : x.violation && x.violation.kind === 'ack'
              ? 'ACK 槽无应答，检出 ACK 错误，帧间隔后自动重传'
              : '检出错误，发送错误标志后在帧间隔结束自动重传';
        }
      }

      const injected = errorsFound.find((e) => e.injected) || null;
      const firstViolation = errorsFound.length
        ? [...errorsFound].sort((a, b) => a.globalBit - b.globalBit)[0]
        : null;
      const collisionEvent = errorsFound.find((e) => e.collision) || null;

      const attempt = {
        index: attemptIndex,
        startBit, endBit: t,
        retransmit: isRetry(wReq.index),
        winner: wReq.node,
        winnerRequestIndex: wReq.index,
        frameId: wReq.id, frameIdHex: fmtId(wReq.id),
        dlc: wReq.dlc, data: wReq.data,
        annotation,
        contenders: contenders.map((c) => ({ node: c.node, requestIndex: c.req.index, id: c.req.id, idHex: fmtId(c.req.id), dlc: c.req.dlc })),
        jointTransmitters: txList.map((x) => ({
          node: x.name, requestIndex: x.req.index,
          dlc: x.req.dlc, data: [...x.req.data],
          ok: txOk.get(x.name),
        })),
        sharedTransmitters: (jointTxs && allTxOk && identicalFrame)
          ? txList.map((x) => ({ node: x.name, requestIndex: x.req.index, dlc: x.req.dlc, data: [...x.req.data] }))
          : null,
        arbitration: { winner: wReq.node, loserEvidence, note: tieNote },
        status: allTxOk ? 'acknowledged' : anyTxOk ? 'partial' : 'error',
        ok: allTxOk,
        crc: '0x' + crc.toString(16).toUpperCase().padStart(4, '0'),
        errorSource: injected ? { node: injected.node, role: injected.role, kind: injected.kind, detail: injected.detail } : null,
        collision: collisionEvent ? {
          field: collisionEvent.frameField, fieldLabel: collisionEvent.fieldLabel,
          globalBit: collisionEvent.globalBit,
          expected: collisionEvent.expected, actual: collisionEvent.actual,
          detail: collisionEvent.detail,
        } : null,
        errors: errorsFound,
        firstViolation,
        counterChanges: [...deltas.values()],
        trace: frameSeg.bits,
      };
      attempts.push(attempt);
      frameSeg = null; // 帧段结束，后续空闲位归入新的 idle 段
      return attempt;
    }

    /* ----------------------------- 主调度 ----------------------------- */

    let safety = 0;
    while (pending.length) {
      if (++safety > 2048) throw new Error('引擎内部错误：发送尝试次数超过上限（请检查是否存在持续故障的病态输入）');
      rejectDueBusOff(t);
      if (!pending.length) break;
      const due = pending.filter((r) => r.time <= t && st.get(r.node).mode !== 'bus-off');
      if (!due.length) {
        const nextFuture = pending.reduce((m, r) => (r.time > t && (m === null || r.time < m) ? r.time : m), null);
        if (recovery.size) {
          // bus-off 恢复中：逐位推进，遇到其他节点到期请求或未来请求到达时刻立即停下
          let steps = 0;
          while (recovery.size && steps++ < 4096) {
            if (pending.some((r) => r.time <= t && st.get(r.node).mode !== 'bus-off')) break;
            if (nextFuture !== null && t >= nextFuture) { rejectDueBusOff(t); break; }
            emit('IDLE', 'IDLE', REC, null);
          }
        } else if (nextFuture !== null) {
          idleTo(nextFuture);
        } else break;
        continue;
      }
      const byNode = new Map();
      for (const r of due) if (!byNode.has(r.node)) byNode.set(r.node, r);
      const contenders = [...byNode.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([node, req]) => ({ node, req }));
      const attempt = runAttempt(contenders);

      // 持续同内容冲突的物理 livelock 防护：两个节点用相同 ID 但不同 DLC/载荷
      // 在同一时刻反复竞争，每次都在同一分歧位销毁帧——即便 bus-off 恢复后内容
      // 不变仍会重复。第二次 bus-off 时终止该批仍在途的冲突请求（真实总线上表现为
      // 反复 bus-off，无回放价值），并给出明确事件。
      if (attempt.collision) {
        const collideNodes = attempt.jointTransmitters.filter((j) => !j.ok).map((j) => j.node);
        const repeatedOff = collideNodes.some((n) => st.get(n).mode === 'bus-off' && busOffRounds.get(n) >= 2);
        if (repeatedOff) {
          const idxSet = new Set(attempt.jointTransmitters.map((j) => j.requestIndex));
          for (const r of pending) {
            if (!idxSet.has(r.index)) continue;
            const o = outcomes[r.index];
            o.status = 'aborted';
            o.reason = '与同标识符节点的帧内容（DLC/载荷）持续不一致，恢复后仍在同一分歧位冲突，反复 bus-off，发送按物理 livelock 终止；请修正节点发送内容';
            events.push({ type: 'collision-aborted', node: r.node, requestIndex: r.index, atBit: t, globalBit: attempt.collision.globalBit });
            r._done = true;
          }
          for (let k = pending.length - 1; k >= 0; k--) if (pending[k]._done) pending.splice(k, 1);
        }
      }
    }

    // 尾部空闲：保证 bus-off 恢复过程完整可观察
    let guard = 0;
    while (recovery.size && guard++ < 4096) emit('IDLE', 'IDLE', REC, null);

    for (const o of outcomes) {
      if (o.status === 'pending-retry') { o.status = 'aborted'; o.reason = '持续错误导致节点 bus-off，发送中止'; }
    }

    return {
      ok: true,
      nodes: [...st.entries()].map(([name, s]) => ({ name, tec: s.tec, rec: s.rec, mode: s.mode })),
      requests: outcomes,
      attempts,
      events,
      segments,
      totalBits: t,
      constants: {
        recoveryGroups: RECOVERY_GROUPS,
        recoveryGroupLength: RECOVERY_GROUP_LEN,
        recoveryBits: RECOVERY_GROUPS * RECOVERY_GROUP_LEN,
      },
    };
  }

  return { DOM, REC, crc15, validateInput, simulate, fmtId, MAX_NODES, MAX_REQUESTS };
});
