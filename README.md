# 星载载荷共用 CAN 总线 · 位级回放系统

审查员录入节点与按时刻排列的标准数据帧请求后，系统以**位级时间线**回放 CAN 2.0A
仲裁、位填充、CRC、ACK、错误标志与帧间隔，并给出每帧获胜节点、错误来源、
错误计数变化、首个违规证据与可展开的位序轨迹。

零第三方依赖，仅需 Node.js ≥ 20。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 至多 4 个节点、初始 TEC | 录入校验 `nodes[].tec`（0~255） |
| 至多 24 条按时刻排列的标准帧请求 | 录入校验 `requests[]`（时刻非递减，ID 0x000~0x7FF，DLC 0~8） |
| 帧标注 ACK / CRC / 指定数据位错误 | `error: {type:'ack'}` / `{type:'crc',sourceNode}` / `{type:'bit',dataBit}`（位序号按 Dn.7→Dn.0 展平） |
| 逐位呈现 SOF、仲裁、填充、CRC、ACK、错误标志、帧间隔 | `attempts[].trace[]`，页面提供单步/连续回放器 |
| 同刻请求仅仲裁获胜帧推进 | 多节点同刻共同驱动 SOF/仲裁场，失败节点转为接收，胜出帧独占后续场 |
| 低标识符获胜 + 定位失败节点「首个发隐性而总线显性」位置 | `arbitration.loserEvidence[]`（含 `globalBit`、位标签、发送/总线电平） |
| 每帧获胜节点 / 错误来源 / 计数变化 / 首个违规证据 / 可展开位序轨迹 | 结果页逐帧卡片 |
| bus-off（TEC≥256）不参与后续仲裁、新请求拒绝 | 请求结局 `rejected`；总线状态事件 `bus-off` |
| 连续 128 次 11 连续隐性位序列后恢复，TEC/REC 清零 | 事件 `recovered(groups=128)`；他节点显性流量只打断当前序列、不抹除已累计次数 |
| 非法帧标识 / 载荷超 DLC / 无效错误位置 → 字段级反馈并清除旧结论 | 400 响应携带 `errors[].field` 路径，页面定位字段并清空结论区 |
| Compose 可配置宿主端口 + 健康响应 | `HOST_PORT` 环境变量，`GET /healthz` |
| Compose 中名为 `verify` 的一次性验收服务 | 见下 |

## 本地运行

```bash
npm start                 # 默认 0.0.0.0:8080
PORT=9090 npm start       # 自定义端口
npm test                  # 代码测试（含 HTTP 冒烟）
npm run build             # 语法检查 + 页面资源检查 + dist/ 产出
npm run verify            # 一次性验收：测试 + 构建 + 健康/页面冒烟 + 三类场景
```

## Docker Compose

```bash
HOST_PORT=9090 docker compose up -d --build web
curl http://127.0.0.1:9090/healthz

# 一次性验收（自动等待 web 健康，跑完退出；退出码即验收结论）
docker compose run --build --rm verify
echo $?   # 0 = 全部通过
```

`verify` 服务顺序执行：

1. `node --test test/` 全量代码测试；
2. 构建检查（语法、页面资源、`dist/`）；
3. 冒烟 Compose 内 `web` 服务的 `/healthz` 与页面，并另起一个独立端口实例复测；
4. 经 HTTP API 验证三类**可观察结果**：
   - 正常仲裁：低 ID 获胜、失败节点首个隐性/显性冲突位、三帧全部成功；
   - 被动错误：TEC 越过 128 后错误标志为 6 个隐性位；
   - bus-off：新请求在请求时刻被拒绝，128×11 空闲位后恢复、在途帧重传成功、计数清零。

## HTTP API

- `GET /healthz` — `{status:"ok", limits:{maxNodes:4,maxRequests:24}}`
- `POST /api/simulate` — 请求/响应示例：

```json
{
  "nodes": [{"name": "CAM-A", "tec": 248}, {"name": "CAM-B", "tec": 0}],
  "requests": [
    {"time": 0, "node": "CAM-A", "id": "0x100", "dlc": 1, "data": "00",
     "error": {"type": "bit", "dataBit": 0}}
  ]
}
```

校验失败返回 `400`：`{"ok":false,"errors":[{"field":"requests[0].id","message":"…"}]}`。

## 仿真语义说明

- 错误计数遵循 CAN 经典规则：发送方/接收方检出错误分别 TEC/REC +8，
  正常完成 -1（下限 0）；TEC≥128 或 REC≥128 为错误被动，TEC≥256 为 bus-off。
- 错误标注是**瞬时故障**：仅作用于该请求的首次尝试，随后控制器按 CAN 规则
  在帧间隔后自动重传；标注 `ack` 时要求总线至少配置 2 个节点（否则物理上
  永无应答者，只能一路升级至 bus-off，无回放价值）。
- 被动错误节点发送 6 个隐性错误标志；其他节点在受填充区看到 6 连同电平
  会自行检出位填充错误，在固定格式区看到显性会检出格式错误。
