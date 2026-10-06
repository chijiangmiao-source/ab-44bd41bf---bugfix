'use strict';

/**
 * 一次性验收（verify）：
 *   阶段 1  node --test 全量代码测试（仲裁 / 填充 / CRC / ACK / 被动错误 / bus-off 恢复 / 字段校验）
 *   阶段 2  构建检查（语法 + 页面资源 + dist 产出）
 *   阶段 3  启动真实 HTTP 服务，健康检查与页面资源冒烟
 *   阶段 4  通过 HTTP API 验证可观察结果：
 *           正常仲裁 / 被动错误 / bus-off 恢复 /
 *           相同 ID 载荷首位差异 / 相同 ID DLC 差异 / 相同 ID 整帧一致 / 持续冲突 bus-off 终止
 *
 * 任一阶段失败即以非零码退出，退出码如实反映验收结果。
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.VERIFY_PORT || '8090';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr || new Error('healthz 未就绪');
}

async function api(payload) {
  const r = await fetch(`${BASE}/api/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  /* ---------- 阶段 1：代码测试 ---------- */
  section('阶段 1：node --test 代码测试');
  try {
    run(process.execPath, ['--test', 'test/']);
    check('单元测试全部通过', true);
  } catch {
    check('单元测试全部通过', false);
    process.exit(1);
  }

  /* ---------- 阶段 2：构建检查 ---------- */
  section('阶段 2：构建检查');
  try {
    run(process.execPath, ['scripts/build.cjs']);
    check('构建检查通过', true);
  } catch {
    check('构建检查通过', false);
    process.exit(1);
  }

  /* ---------- 阶段 3：启动 HTTP 服务 + 冒烟 ---------- */
  // 若由 Compose 编排（depends_on: web healthy），先冒烟编排内的 web 服务
  const WEB_BASE = process.env.VERIFY_WEB_BASE;
  if (WEB_BASE) {
    section(`阶段 3a：冒烟 Compose 编排内的 web 服务（${WEB_BASE}）`);
    try {
      const r = await fetch(`${WEB_BASE}/healthz`);
      const j = await r.json();
      check('编排 web /healthz 返回 200', r.status === 200 && j.status === 'ok');
      const page = await (await fetch(`${WEB_BASE}/`)).text();
      check('编排 web 页面可访问', page.includes('执行回放仿真'));
    } catch (e) {
      check('编排 web 服务冒烟', false, e.message);
    }
  }

  section(`阶段 3b：启动独立 HTTP 服务（PORT=${PORT}）并冒烟`);  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });

  let exitCode = 0;
  try {
    await waitHealthy(8000);
    check('/healthz 返回 200', true);
    const h = await (await fetch(`${BASE}/healthz`)).json();
    check('健康响应含服务名与限制', h.service === 'can-bus-replay' && h.limits.maxNodes === 4 && h.limits.maxRequests === 24,
      JSON.stringify(h));

    for (const asset of ['/', '/app.js', '/style.css', '/engine.js']) {
      const r = await fetch(`${BASE}${asset}`);
      check(`页面资源可访问 ${asset}`, r.status === 200, `HTTP ${r.status}`);
    }
    const idx = await (await fetch(`${BASE}/`)).text();
    check('页面包含逐位回放入口', idx.includes('执行回放仿真') && idx.includes('位序轨迹'));

    /* ---------- 阶段 4：三类可观察结果（经 HTTP API） ---------- */
    section('阶段 4a：正常仲裁（低标识符获胜 + 首个违规证据）');
    const normal = await api({
      nodes: [{ name: 'CAM-A', tec: 0 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x200', dlc: 2, data: '11 22' },
        { time: 0, node: 'CAM-B', id: '0x100', dlc: 1, data: 'AA' },
        { time: 0, node: 'RADAR', id: '0x180', dlc: 0 },
      ],
    });
    check('API 返回 200', normal.status === 200);
    {
      const r = normal.body;
      check('同刻仅最低 ID 帧获胜 CAM-B(0x100)', r.attempts[0].winner === 'CAM-B' && r.attempts[0].frameIdHex === '0x100');
      const losers = r.attempts[0].arbitration.loserEvidence;
      check('两个失败节点均给出仲裁证据', losers.length === 2);
      const radar = losers.find((e) => e.node === 'RADAR');
      check('证据定位「发隐性、总线显性」位置', radar && radar.sent === 1 && radar.bus === 0 && typeof radar.globalBit === 'number',
        JSON.stringify(radar));
      check('三条请求最终全部发送成功', r.requests.every((q) => q.status === 'transmitted'));
      check('各节点仍处主动错误模式', r.nodes.every((n) => n.mode === 'active'));
      check('获胜帧位轨迹覆盖 SOF…IFS',
        ['SOF', 'ARBITRATION', 'CONTROL', 'DATA', 'CRC', 'ACK', 'EOF', 'IFS']
          .every((f) => r.attempts[0].trace.some((b) => b.field === f)));
    }

    section('阶段 4b：被动错误（TEC≥128 后错误标志为 6 个隐性位）');
    const passive = await api({
      nodes: [{ name: 'CAM-A', tec: 126 }, { name: 'CAM-B', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
        { time: 400, node: 'CAM-A', id: '0x101', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
      ],
    });
    check('API 返回 200', passive.status === 200);
    {
      const r = passive.body;
      check('出现 error-passive 状态事件', r.events.some((e) => e.type === 'error-passive' && e.node === 'CAM-A'));
      const A = r.nodes.find((n) => n.name === 'CAM-A');
      check('CAM-A 最终为 passive 模式', A && A.mode === 'passive' && A.tec >= 128, `TEC=${A?.tec}`);
      // 第二次标注故障的首次尝试（index=2：首帧失败、首帧重传成功、次帧失败…）
      const fail2 = r.attempts.find((a) => a.annotation?.type === 'bit' && a.winnerRequestIndex === 1);
      check('被动帧存在', !!fail2);
      const flags = fail2.trace.filter((b) => b.field === 'ERROR_FLAG' && b.drives && b.drives['CAM-A'] !== undefined);
      check('错误被动标志为 6 个隐性位', flags.length === 6 && flags.every((b) => b.drives['CAM-A'] === 1),
        `flags=${flags.map((b) => b.drives['CAM-A']).join('')}`);
      check('请求最终经自动重传成功', r.requests.every((q) => q.status === 'transmitted'));
    }

    section('阶段 4c：bus-off（拒绝新请求 + 128×11 空闲恢复）');
    const busoff = await api({
      nodes: [{ name: 'CAM-A', tec: 248 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
        { time: 600, node: 'CAM-B', id: '0x300', dlc: 0 },
        { time: 1000, node: 'CAM-A', id: '0x200', dlc: 0 }, // bus-off 期间新请求 → 拒绝
      ],
    });
    check('API 返回 200', busoff.status === 200);
    {
      const r = busoff.body;
      const off = r.events.find((e) => e.type === 'bus-off');
      check('CAM-A 进入 bus-off（TEC=256）', off && off.node === 'CAM-A' && off.tec === 256, JSON.stringify(off));
      const rej = r.requests.find((q) => q.id === 0x200);
      check('bus-off 期间新请求被拒绝', rej && rej.status === 'rejected');
      const rejEv = r.events.find((e) => e.type === 'rejected');
      check('拒绝事件发生在请求时刻（位 1000）', rejEv && rejEv.atBit === 1000, `at=${rejEv?.atBit}`);
      const rec = r.events.find((e) => e.type === 'recovered');
      check('128 次 11 连续隐性位后恢复', rec && rec.groups === 128);
      check('恢复后在途请求自动重传成功',
        r.attempts.some((a) => a.winner === 'CAM-A' && a.ok && a.startBit >= rec.atBit - 3));
      const A = r.nodes.find((n) => n.name === 'CAM-A');
      check('恢复后 TEC/REC 清零且模式为 active', A.tec === 0 && A.rec === 0 && A.mode === 'active',
        JSON.stringify(A));
      check('恢复期间他节点正常通信不抹除已累计次数',
        rec.atBit > off.atBit + 1408, `off=${off.atBit} rec=${rec.atBit}`);
    }

    section('阶段 4d：非法输入字段级反馈（并确认不产生结论）');    const bad = await api({
      nodes: [{ name: 'A' }],
      requests: [{ node: 'A', id: '0x800', dlc: 2, data: [1, 2, 3], error: { type: 'bit', dataBit: 99 } }],
    });
    check('非法输入返回 400', bad.status === 400);
    check('字段路径覆盖 id / data / dataBit',
      bad.body.errors.some((e) => e.field.includes('.id')) &&
      bad.body.errors.some((e) => e.field.includes('.data')) &&
      bad.body.errors.some((e) => e.field.includes('dataBit')));
    check('响应不含旧结论字段', bad.body.attempts === undefined);

    /* ---------- 阶段 4e：相同标识符 + 载荷首位差异 ---------- */
    section('阶段 4e：相同标识符 · 载荷首位差异（首个分歧位必须形成可复核错误结论）');
    const payloadDiff = await api({
      nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }, { name: 'C', tec: 0 }],
      requests: [
        { time: 0, node: 'A', id: '0x100', dlc: 1, data: '00' }, // D0.7=0
        { time: 0, node: 'B', id: '0x100', dlc: 1, data: '80' }, // D0.7=1
      ],
    });
    check('API 返回 200', payloadDiff.status === 200);
    {
      const r = payloadDiff.body;
      const a0 = r.attempts[0];
      check('仲裁场未分胜负（无虚假仲裁败者证据）', a0.arbitration.loserEvidence.length === 0 &&
        a0.arbitration.note && a0.arbitration.note.includes('仲裁场未分胜负'));
      check('给出首个驱动分歧证据（D0.7）', a0.collision && a0.collision.fieldLabel === 'D0.7' &&
        a0.collision.actual === 0, JSON.stringify(a0.collision));
      const bad = a0.trace.find((b) => b.i === a0.collision.globalBit);
      check('分歧位线与可复核：A 发显性、B 发隐性、总线显性',
        bad && bad.drives.A === 0 && bad.drives.B === 1 && bad.bus === 0, JSON.stringify(bad && bad.drives));
      check('分歧后紧跟错误标志且无 ACK 场',
        a0.trace.some((b) => b.i > a0.collision.globalBit && b.field === 'ERROR_FLAG' && b.bus === 0) &&
        !a0.trace.some((b) => b.field === 'ACK'));
      check('两位发送方首个尝试 TEC 均 +8',
        a0.counterChanges.find((c) => c.node === 'A').tecAfter === 8 &&
        a0.counterChanges.find((c) => c.node === 'B').tecAfter === 8);
      check('首个尝试不是成功结局', a0.ok === false && a0.status === 'error' && a0.sharedTransmitters === null);
      check('两条请求最终经自动重传成功（有观察者 C 应答）',
        r.requests.every((q) => q.status === 'transmitted'));
      check('轨迹覆盖分歧证据位与错误标志', a0.trace.some((b) => b.field === 'DATA') &&
        a0.trace.some((b) => b.field === 'ERROR_FLAG'));
    }

    /* ---------- 阶段 4f：相同标识符 + DLC 差异 ---------- */
    section('阶段 4f：相同标识符 · DLC 差异（分歧定位在 DLC 控制位）');
    const dlcDiff = await api({
      nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }, { name: 'C', tec: 0 }],
      requests: [
        { time: 0, node: 'A', id: '0x200', dlc: 0 },
        { time: 0, node: 'B', id: '0x200', dlc: 1, data: '00' },
      ],
    });
    check('API 返回 200', dlcDiff.status === 200);
    {
      const r = dlcDiff.body;
      const a0 = r.attempts[0];
      check('分歧证据位于 CONTROL/DLC.0', a0.collision &&
        a0.collision.field === 'CONTROL' && a0.collision.fieldLabel === 'DLC.0',
        JSON.stringify(a0.collision));
      const bad = a0.trace.find((b) => b.i === a0.collision.globalBit);
      check('DLC.0 驱动可复核：A=0(显性) B=1(隐性) 总线=0',
        bad.drives.A === 0 && bad.drives.B === 1 && bad.bus === 0, JSON.stringify(bad.drives));
      check('B 检到位错误并发错误标志，无正常 ACK',
        a0.errors.some((e) => e.node === 'B' && e.kind === 'bit') &&
        a0.trace.some((b) => b.field === 'ERROR_FLAG') && !a0.trace.some((b) => b.field === 'ACK'));
      check('两条请求最终重传成功', r.requests.every((q) => q.status === 'transmitted'));
    }

    /* ---------- 阶段 4g：相同标识符 · 整帧完全一致 ---------- */
    section('阶段 4g：相同标识符 · 整帧完全一致（共享同一物理帧，保留全部参与节点）');
    const identical = await api({
      nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }],
      requests: [
        { time: 0, node: 'A', id: '0x100', dlc: 1, data: 'AB' },
        { time: 0, node: 'B', id: '0x100', dlc: 1, data: 'AB' },
      ],
    });
    check('API 返回 200', identical.status === 200);
    {
      const r = identical.body;
      check('只有一个物理帧尝试', r.attempts.length === 1);
      const a0 = r.attempts[0];
      check('整帧一致 → acknowledged，无分歧/错误标志',
        a0.status === 'acknowledged' && a0.collision === null &&
        !a0.trace.some((b) => b.field === 'ERROR_FLAG'));
      check('共同发送方包含 A 与 B', a0.sharedTransmitters &&
        a0.sharedTransmitters.map((s) => s.node).sort().join(',') === 'A,B');
      const ack = a0.trace.find((b) => b.label === 'ACK_SLOT');
      check('唯一 ACK 槽双方均驱动显性（互为应答者）', ack && ack.bus === 0 &&
        ack.drives.A === 0 && ack.drives.B === 0, JSON.stringify(ack && ack.drives));
      check('两条请求各自结局为成功并注明共享物理帧',
        r.requests.length === 2 && r.requests.every((q) => q.status === 'transmitted' &&
          q.reason.includes('共享同一物理帧')));
      check('正常完成，TEC 保持 0', r.nodes.every((n) => n.tec === 0 && n.mode === 'active'));
    }

    /* ---------- 阶段 4h：持续冲突升级 bus-off（无第三方应答者） ---------- */
    section('阶段 4h：相同 ID 内容冲突且无应答者 → 错误被动 / bus-off / 重传 / livelock 终止一致');
    const collideOff = await api({
      nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }],
      requests: [
        { time: 0, node: 'A', id: '0x100', dlc: 1, data: '00' },
        { time: 0, node: 'B', id: '0x100', dlc: 1, data: '01' },
      ],
    });
    check('API 返回 200', collideOff.status === 200);
    {
      const r = collideOff.body;
      const a0 = r.attempts[0];
      check('首个尝试在 D0.0 分歧且有错误标志', a0.collision &&
        a0.collision.fieldLabel === 'D0.0' &&
        a0.trace.some((b) => b.field === 'ERROR_FLAG'));
      check('出现错误被动与 bus-off 事件',
        r.events.some((e) => e.type === 'error-passive') &&
        r.events.filter((e) => e.type === 'bus-off').length >= 2);
      const aborts = r.events.filter((e) => e.type === 'collision-aborted');
      check('第二次 bus-off 后两条请求按物理 livelock 终止', aborts.length === 2 &&
        r.requests.every((q) => q.status === 'aborted'));
    }
  } catch (e) {
    failures++;
    console.error('  ✗ 验收过程发生异常：', e);
  } finally {
    server.kill('SIGTERM');
  }

  section(failures === 0 ? '验收结论：通过 ✅' : `验收结论：失败（${failures} 项）❌`);
  exitCode = failures === 0 ? 0 : 1;
  // 等待服务进程退出
  await new Promise((res) => server.on('exit', res)).catch(() => {});
  process.exit(exitCode);
}

main();
