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
      events.push({ type: 'bus-off', node: name, atBit, tec: s.tec });
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
        // 标识符与 RTR 完全相同：按节点顺序确定性决定发送方
        winner = alive[0];
        tieNote = `标识符 ${fmtId(winner.req.id)} 与 RTR 完全相同，按节点顺序确定 ${winner.node} 获得发送权`;
        for (let j = 1; j < alive.length; j++) {
          loserEvidence.push({
            node: alive[j].node, requestIndex: alive[j].req.index,
            arbBitIndex: 12, label: 'ID*', sent: null, bus: null, globalBit: t - 1,
            detail: tieNote,
          });
        }
      }
      const sharedTransmitters = alive.length > 1
        ? alive.map((a) => ({
          node: a.node,
          requestIndex: a.req.index,
          dlc: a.req.dlc,
          data: [...a.req.data],
        }))
        : null;
      const wReq = winner.req;
      const annotation = isRetry(wReq.index) ? null : wReq.error;

      /* ---- 接收观察者（bus-off 节点不参与；ACK 故障时总线上无接收者） ---- */
      const observerNames = [];
      for (const name of st.keys()) {
        if (name === wReq.node || st.get(name).mode === 'bus-off') continue;
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

      /* ---- 阶段 B：控制场 + 数据场 + CRC（发送方独占驱动，延续填充状态） ---- */
      const restRaw = [];
      restRaw.push({ b: DOM, field: 'CONTROL', label: 'IDE' });
      restRaw.push({ b: DOM, field: 'CONTROL', label: 'r0' });
      for (let k = 3; k >= 0; k--) restRaw.push({ b: (wReq.dlc >> k) & 1, field: 'CONTROL', label: `DLC.${k}` });
      wReq.data.forEach((byte, bi) => {
        for (let k = 7; k >= 0; k--) {
          restRaw.push({ b: (byte >> k) & 1, field: 'DATA', label: `D${bi}.${k}`, dataBit: bi * 8 + (7 - k) });
        }
      });
      const crc = crc15([...logical.map((c) => c.b), ...restRaw.map((c) => c.b)]);
      for (let k = 14; k >= 0; k--) restRaw.push({ b: (crc >> k) & 1, field: 'CRC', label: `CRC${k}` });

      const tx = { phase: 'send', idx: 0, pendingFlag: false, flagLeft: 0, delimLeft: 0, imsLeft: 0, ackFail: false, violation: null };
      const fixedCells = [
        { b: REC, field: 'CRC_DELIM', label: 'CRC_DELIM' },
        { b: REC, field: 'ACK', label: 'ACK_SLOT', ackSlot: true },
        { b: REC, field: 'ACK', label: 'ACK_DELIM', ackDelim: true },
      ];
      for (let k = 0; k < 7; k++) fixedCells.push({ b: REC, field: 'EOF', label: `EOF${k}` });

      // 把逻辑位（含填充插入）逐位送出；txCell 描述当前发送逻辑位
      function sendStuffed(cell) {
        logical.push(cell);
        let bus = cell.b;
        const drives = { [wReq.node]: cell.b };
        let note = null;
        if (annotation && annotation.type === 'bit' && cell.dataBit === annotation.dataBit) {
          bus = 1 - cell.b; // 数据位错误：总线回读反相
          note = `标注数据位错误：${cell.label} 发送 ${cell.b === DOM ? '显性(0)' : '隐性(1)'}，回读为 ${bus === DOM ? '显性(0)' : '隐性(1)'}`;
        }
        const bitRec = emit(cell.field, cell.label, bus, drives, note);
        if (bus !== cell.b) {
          tx.violation = addViolation(wReq.node, 'transmitter', 'bit', bitRec, {
            frameField: 'DATA', fieldLabel: cell.label, expected: cell.b, actual: bus, injected: true,
            detail: `数据位 ${cell.label}：发送 ${cell.b === DOM ? '显性(0)' : '隐性(1)'}，总线回读 ${bus === DOM ? '显性(0)' : '隐性(1)'}，发送方检测到位错误，下一位起发送错误标志`,
          });
          tx.pendingFlag = true;
        }
        // 接收方填充/CRC 输入跟踪
        feedReceiversStuffed(bitRec, cell, bus);
        if (cell.b === last) run++; else { run = 1; last = cell.b; }
        if (run === 5 && !tx.pendingFlag) {
          const sb = last === DOM ? REC : DOM;
          const sbBit = emit('STUFF', 'STUFF', sb, { [wReq.node]: sb },
            `连续 5 个${last === DOM ? '显性' : '隐性'}位后插入${sb === DOM ? '显性' : '隐性'}填充位`);
          feedReceiversStuffed(sbBit, { field: 'STUFF', label: 'STUFF', stuffSlot: true }, sb);
          run = 0; last = null;
        }
      }

      function feedReceiversStuffed(bitRec, cell, bus) {
        for (const o of obs.values()) {
          if (o.phase !== 'rx') continue;
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
            continue;
          }
          let v = bus;
          if (o.crcFault && cell.label === o.flipLabel) v = 1 - v; // 故障节点内部采样受扰
          // 填充检测基于线上实际电平；CRC 输入基于内部采样（去填充序列）
          if (bus === o.last) o.run++; else { o.run = 1; o.last = bus; }
          o.rawSeen.push(v);
          if (o.run === 5) o.expectStuff = true;
        }
      }

      function feedReceiversFlag(bitRec, bus, drivenByRx) {
        // 发送方（或他节点）进入错误处理后接收者的反应：
        //  - 看到他节点的显性主动错误标志：全局错误已被标记，本接收者静默中止接收（REC 不变），等待错误界定符
        //  - 仅看到隐性（被动错误标志不可见）：按填充规则自行检出 6 连同电平，发主动错误标志
        for (const o of obs.values()) {
          if (o.phase !== 'rx') continue;
          if (bus === DOM && !drivenByRx.has(o.name)) {
            if (o.crcDecided && !o.crcFail) {
              // EOF/CRC 界定符等固定位上看到显性 → 格式错误
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

      for (const cell of restRaw) {
        if (tx.phase !== 'send') break; // 已被错误标志中止
        if (tx.pendingFlag) { tx.phase = 'flag'; tx.flagLeft = 6; tx.pendingFlag = false; break; }
        sendStuffed(cell);
      }

      /* ---- 阶段 C：固定格式场 + 错误标志 + 界定符 + IFS ---- */
      const txFlagBit = () => (st.get(wReq.node).mode === 'passive' ? REC : DOM);
      const rxFlagBit = (name) => (st.get(name).rec >= 128 ? REC : DOM);

      let guard = 0;
      while (tx.phase !== 'done' || [...obs.values()].some((o) => o.phase !== 'done')) {
        if (++guard > 600) throw new Error('引擎内部错误：单帧位推进超过上限');

        if (tx.pendingFlag && tx.phase === 'send') { tx.phase = 'flag'; tx.flagLeft = 6; tx.pendingFlag = false; }
        for (const o of obs.values()) if (o.pendingFlag && o.phase === 'rx') { o.phase = 'flag'; o.flagLeft = 6; o.pendingFlag = false; }

        const drives = {};
        let fieldName = 'IDLE', label = '', note = null, cur = null;
        const rxFlagDrivers = new Set();

        if (tx.phase === 'send') {
          cur = fixedCells[tx.idx++];
          fieldName = cur.field; label = cur.label;
          drives[wReq.node] = cur.b;
          if (cur.ackSlot) {
            for (const o of obs.values()) {
              if (o.phase === 'rx' && o.crcDecided && !o.crcFail) drives[o.name] = DOM;
            }
            if (annotation && annotation.type === 'ack') note = '标注 ACK 错误：总线上无接收节点，ACK 槽保持隐性';
          }
        } else if (tx.phase === 'flag') {
          fieldName = 'ERROR_FLAG'; label = `TX_ERROR_FLAG(${wReq.node})`;
          drives[wReq.node] = txFlagBit();
          note = st.get(wReq.node).mode === 'passive'
            ? `${wReq.node} 处于错误被动：发送 6 个隐性错误标志（被动错误标志）`
            : `${wReq.node} 发送 6 个显性主动错误标志`;
        } else if (tx.phase === 'delim') {
          fieldName = 'ERR_DELIM'; label = `TX_ERR_DELIM(${wReq.node})`;
        } else if (tx.phase === 'ims') {
          fieldName = 'IFS'; label = 'INTERMISSION';
        }
        for (const [name, o] of obs) {
          if (o.phase === 'flag') {
            drives[name] = rxFlagBit(name);
            rxFlagDrivers.add(name);
            fieldName = fieldName === 'IDLE' ? 'ERROR_FLAG' : fieldName;
            label += (label ? ' ' : '') + `RX_ERROR_FLAG(${name})`;
          } else if (o.phase === 'delim') {
            if (fieldName === 'IDLE') { fieldName = 'ERR_DELIM'; label = `RX_ERR_DELIM(${name})`; }
          }
        }

        const bus = Object.values(drives).some((v) => v === DOM) ? DOM : REC;
        const bitRec = emit(fieldName, label, bus, drives, note);

        // 发送方监视
        if (tx.phase === 'send') {
          if (cur.ackSlot) {
            if (bus === REC && !tx.ackFail) {
              tx.ackFail = true;
              tx.violation = addViolation(wReq.node, 'transmitter', 'ack', bitRec, {
                frameField: 'ACK', fieldLabel: 'ACK_SLOT', expected: DOM, actual: REC,
                injected: !!(annotation && annotation.type === 'ack'),
                detail: 'ACK 槽总线为隐性位，没有任何节点应答，发送方检出 ACK 错误，ACK 界定符后发送错误标志',
              });
            }
          } else if (cur.ackDelim) {
            if (tx.ackFail) tx.pendingFlag = true;
          } else {
            // CRC 界定符 / EOF：应为隐性，被他节点错误标志拉显性则格式/位错误
            if (bus === DOM) {
              addViolation(wReq.node, 'transmitter', 'form', bitRec, {
                frameField: cur.field, fieldLabel: cur.label, expected: REC, actual: DOM,
                detail: `固定格式位 ${cur.label} 应为隐性，总线被接收节点错误标志拉为显性，发送方检出格式错误`,
              });
              tx.pendingFlag = true;
            }
          }
        } else if (tx.phase === 'flag' || tx.phase === 'delim') {
          feedReceiversFlag(bitRec, bus, rxFlagDrivers);
        }

        // 接收方监视
        for (const o of obs.values()) {
          if (o.phase !== 'rx') continue;
          if (tx.phase !== 'send' || !cur) continue;
          if (cur.label === 'CRC_DELIM' && !o.crcDecided) {
            o.crcDecided = true;
            const seen = o.rawSeen;
            const seenCrc = seen.slice(-15);
            o.crcCalc = crc15(seen.slice(0, -15));
            for (let k = 0; k < 15; k++) {
              if (seenCrc[k] !== ((o.crcCalc >> (14 - k)) & 1)) { o.crcFail = true; o.firstMismatch = 14 - k; break; }
            }
            if (o.crcFail) {
              // CRC 在界定符处完成校验：此处记录首个违规证据，错误标志推迟到 EOF 起点
              addViolation(o.name, 'receiver', 'crc', bitRec, {
                frameField: 'CRC', fieldLabel: o.firstMismatch >= 0 ? `CRC${o.firstMismatch}` : 'CRC',
                injected: o.crcFault,
                crcExpected: '0x' + o.crcCalc.toString(16).toUpperCase().padStart(4, '0'),
                crcReceived: '0x' + crc.toString(16).toUpperCase().padStart(4, '0'),
                detail: o.crcFault
                  ? `接收节点 ${o.name} 在 ${o.flipLabel} 处读到受扰数据，本地计算 CRC=0x${o.crcCalc.toString(16).toUpperCase().padStart(4, '0')} 与收到 CRC 0x${crc.toString(16).toUpperCase().padStart(4, '0')} 不符${o.firstMismatch >= 0 ? `，首个不一致位为 CRC${o.firstMismatch}` : ''}；CRC 界定符处确认失败，不填 ACK，并在 EOF 起点发送错误标志`
                  : `接收节点 ${o.name} CRC 校验失败，EOF 起点发送错误标志`,
              });
            }
          } else if (cur.ackDelim) {
            if (o.crcFail) o.pendingFlag = true; // EOF0 起发错误标志
          } else if ((cur.field === 'CRC_DELIM' || cur.field === 'EOF') && bus === DOM) {
            addViolation(o.name, 'receiver', 'form', bitRec, {
              frameField: cur.field, fieldLabel: cur.label, expected: REC, actual: DOM,
              detail: `接收节点 ${o.name} 在固定格式位 ${cur.label} 采样到显性，格式错误`,
            });
            o.pendingFlag = true;
          }
        }

        // 相位推进
        if (tx.phase === 'flag' && --tx.flagLeft === 0) { tx.phase = 'delim'; tx.delimLeft = 8; }
        else if (tx.phase === 'delim' && --tx.delimLeft === 0) { tx.phase = 'ims'; tx.imsLeft = 3; }
        else if (tx.phase === 'ims' && --tx.imsLeft === 0) tx.phase = 'done';
        else if (tx.phase === 'send' && tx.idx >= fixedCells.length && !tx.pendingFlag) { tx.phase = 'ims'; tx.imsLeft = 3; }

        for (const o of obs.values()) {
          if (o.phase === 'flag' && --o.flagLeft === 0) { o.phase = 'delim'; o.delimLeft = 8; }
          else if (o.phase === 'delim' && --o.delimLeft === 0) o.phase = 'done';
          else if (o.phase === 'waitdelim') {
            // 等待他节点错误界定符：连续 8 个隐性位后结束本次接收（静默，不计 REC）
            if (bus === REC) o.delimWatch++;
            if (o.delimWatch >= 8) o.phase = 'done';
          }
          else if (o.phase === 'rx' && (tx.phase === 'ims' || tx.phase === 'done')) o.phase = 'done';
        }
      }

      /* ---- 错误计数与模式迁移 ---- */
      const txState = st.get(wReq.node);
      const txOk = !tx.violation && !errorsFound.some((e) => e.node === wReq.node);
      if (txOk) txState.tec = Math.max(0, txState.tec - 1);
      for (const o of obs.values()) {
        const s = st.get(o.name);
        if (!errorsFound.some((e) => e.node === o.name) && !o.foreign) s.rec = Math.max(0, s.rec - 1);
      }
      const modeBeforeTx = deltas.get(wReq.node).modeAfter;
      const nextTxMode = modeOf(txState.tec, txState.rec);
      if (nextTxMode === 'bus-off') enterBusOff(wReq.node, t);
      else txState.mode = nextTxMode;
      if (txState.mode === 'passive' && modeBeforeTx === 'active')
        events.push({ type: 'error-passive', node: wReq.node, atBit: t, tec: txState.tec });
      for (const o of obs.values()) {
        const s = st.get(o.name);
        if (s.mode === 'bus-off') continue;
        const before = deltas.has(o.name) ? (deltas.get(o.name).modeAfter) : s.mode;
        const m = modeOf(s.tec, s.rec);
        if (m === 'bus-off') { enterBusOff(o.name, t); continue; }
        if (m === 'passive' && before === 'active') events.push({ type: 'error-passive', node: o.name, atBit: t, tec: s.tec, rec: s.rec });
        s.mode = m;
      }

      for (const [name, d] of deltas) {
        const s = st.get(name);
        d.tecAfter = s.tec; d.recAfter = s.rec; d.modeAfter = s.mode;
      }

      // 请求结局：成功移除；失败保留并在 IFS 后自动重传（标注仅首次生效）
      for (const c of contenders) outcomes[c.req.index].attempts.push(attemptIndex);
      if (txOk) {
        const completed = new Set((sharedTransmitters || [{ requestIndex: wReq.index }])
          .map((sender) => sender.requestIndex));
        for (let k = pending.length - 1; k >= 0; k--) {
          if (completed.has(pending[k].index)) pending.splice(k, 1);
        }
        for (const requestIndex of completed) {
          outcomes[requestIndex].status = 'transmitted';
          outcomes[requestIndex].reason = requestIndex === wReq.index
            ? null
            : `与 ${wReq.node} 使用相同标识符共同发送完成`;
        }
      } else {
        retransmitted.add(wReq.index);
        outcomes[wReq.index].status = 'pending-retry';
        outcomes[wReq.index].reason = '检出错误，发送错误标志后在帧间隔结束自动重传';
      }

      const injected = errorsFound.find((e) => e.injected) || null;
      const firstViolation = errorsFound.length
        ? [...errorsFound].sort((a, b) => a.globalBit - b.globalBit)[0]
        : null;

      const attempt = {
        index: attemptIndex,
        startBit, endBit: t,
        retransmit: isRetry(wReq.index),
        winner: wReq.node,
        winnerRequestIndex: wReq.index,
        frameId: wReq.id, frameIdHex: fmtId(wReq.id),
        dlc: wReq.dlc, data: wReq.data,
        annotation,
        contenders: contenders.map((c) => ({ node: c.node, requestIndex: c.req.index, id: c.req.id, idHex: fmtId(c.req.id) })),
        sharedTransmitters,
        arbitration: { winner: wReq.node, loserEvidence, note: tieNote },
        status: txOk ? 'acknowledged' : 'error',
        ok: txOk,
        crc: '0x' + crc.toString(16).toUpperCase().padStart(4, '0'),
        errorSource: injected ? { node: injected.node, role: injected.role, kind: injected.kind, detail: injected.detail } : null,
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
      runAttempt(contenders);
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
