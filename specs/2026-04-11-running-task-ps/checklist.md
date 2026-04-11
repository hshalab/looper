# Running Task PS Implementation Checklist

## Phase 1: API Contract & Data Access

- [ ] 新增 active runs 聚合接口约定
  - [ ] 路由定为 `GET /api/v1/runs/active`
  - [ ] 明确它是 `runs` 资源下的聚合视图，不引入新的 `process` 领域对象
  - [ ] 明确 query 参数：`type`、`projectId`、`taskId`、`repo`、`prNumber`
  - [ ] 明确返回字段：`runId`、`loopId`、`projectId`、`type`、`status`、`currentStep`、`startedAt`、`target`、`agent`

- [ ] 扩展 `runs` store 查询能力
  - [ ] 增加 `listByStatus(status: string)`
  - [ ] SQLite store 增加对应查询实现
  - [ ] 保持返回顺序稳定，便于上层排序/测试

- [ ] 明确 active agent join 规则
  - [ ] 使用 `agentExecutions.listActive()` 作为数据源
  - [ ] `runId` 为空的 active execution 在 join 时直接跳过
  - [ ] 多个 active execution 绑定同一 run 时，选择最新 `startedAt` 作为主展示对象
  - [ ] 同时返回 `agent.activeCount` 以暴露异常并存情况

## Phase 2: Server Aggregation

- [ ] 在 `apps/looperd/src/server/index.ts` 增加 `/api/v1/runs/active` 路由
  - [ ] 仅支持 `GET`
  - [ ] 读取并校验 query 参数
  - [ ] 调用聚合 builder 返回 `items`

- [ ] 实现 active run view 聚合逻辑
  - [ ] 从 `runs.listByStatus("running")` 读取 active runs
  - [ ] 按 `run.loopId` join `loop`
  - [ ] 从 `loop.type` 派生响应里的 `type`
  - [ ] 按 target 类型构造 `target` 结构
  - [ ] task target 优先展示 task title，缺失时回退 task id
  - [ ] PR target 展示为 `<repo>#<prNumber>`
  - [ ] 挂载 active agent 摘要（vendor / pid / startedAt / lastHeartbeatAt / heartbeatCount / activeCount）

- [ ] 实现过滤逻辑
  - [ ] `type`
  - [ ] `projectId`
  - [ ] `taskId`
  - [ ] `repo + prNumber`

- [ ] 实现排序逻辑
  - [ ] 有活跃 agent execution 的 run 排前面
  - [ ] 同组内按 `run.startedAt` 升序

## Phase 3: CLI Command

- [ ] 在 `apps/cli/src/index.ts` 增加顶级命令 `looper ps`
  - [ ] 命令接入现有 CLI router
  - [ ] 增加 help / example 文案
  - [ ] 保持与现有 `run list` / `loop list` 风格一致

- [ ] 支持 Phase 1 flags
  - [ ] `--json`
  - [ ] `--type <worker|reviewer|fixer>`
  - [ ] `--project <projectId>`

- [ ] 实现 CLI 输出
  - [ ] 调用 `GET /api/v1/runs/active`
  - [ ] 表格列输出：`type` / `target` / `run` / `step` / `agent` / `pid` / `status` / `age`
  - [ ] `age` 由 CLI 基于 `startedAt` 计算相对时长
  - [ ] 无活跃任务时输出 `No running loops.`
  - [ ] 无 active agent 时 `agent` / `pid` 列显示 `-`

## Phase 4: Tests

- [ ] Store 测试
  - [ ] `runs.listByStatus("running")` 只返回目标状态 run
  - [ ] 返回顺序稳定

- [ ] API 测试
  - [ ] 无 active run 时返回空列表
  - [ ] 有 active worker / reviewer / fixer 时正确返回 type + target + currentStep
  - [ ] active agent execution 正确 join 到 run
  - [ ] 当前 step 无 agent 时返回空 agent 展示对象或 `null`
  - [ ] active execution `runId` 为空时被安全跳过
  - [ ] 多个 active execution 绑定同一 run 时只返回一条 run 记录，并带 `activeCount`
  - [ ] `type` / `projectId` / `taskId` / `repo+prNumber` 过滤正确
  - [ ] task target 缺 title 时正确回退到 id

- [ ] CLI 测试
  - [ ] `looper ps --json` 输出结构化结果
  - [ ] 默认表格输出列顺序正确
  - [ ] 空态输出为 `No running loops.`
  - [ ] `--type` / `--project` 正确拼 query 参数

## MVP Cut Line

MVP 必须完成：

- [ ] `GET /api/v1/runs/active`
- [ ] `runs.listByStatus(status)`
- [ ] active run + active agent 聚合视图
- [ ] `looper ps`
- [ ] `--json`
- [ ] `--type` / `--project`
- [ ] 空态输出
- [ ] 基础 API / CLI 测试

后续再做：

- [ ] `--task`
- [ ] `--pr`
- [ ] `--watch`
- [ ] `looper ps -a`
- [ ] queued footer / `--queued`
- [ ] `looper ps --stuck`
- [ ] SSE-based watch
