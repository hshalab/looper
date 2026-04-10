# 核心领域模型详细实现计划

## 1. 目标

用稳定的领域模型承载三类 loop 的状态推进，避免业务逻辑散落在 controller 和 shell 调用里。

---

## 2. 建议聚合

- `Project`
- `Loop`
- `Run`
- `Task`
- `Checklist`
- `PullRequestSnapshot`
- `Lock`

---

## 3. 关键规则

### 3.1 Loop

- 同一 `project + type + target` 只能有一个 active loop
- `paused` loop 不能被 scheduler 自动执行

### 3.2 Run

- 每个 run 必须绑定一个 loop
- `running` -> 结束态只能发生一次

### 3.3 Task / Checklist

- Worker 只能在存在 checklist 时开始
- Agent 补充的 checklist item 必须标记 `source=agent`
- 所有 checklist 完成前不能开 PR

### 3.4 Lock

- 锁必须有 owner、key、expiresAt
- 锁过期后允许抢占

---

## 4. 值对象建议

- `LoopType`
- `LoopStatus`
- `RunStatus`
- `LoopStep`
- `ReviewConclusion`
- `PRHealth`
- `NotificationLevel`

---

## 5. 状态机落地

## 5.1 通用状态枚举

```ts
type LoopStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'

type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'parse_failed'
```

### 合法迁移

- `LoopStatus`: `idle -> queued -> running -> completed|failed|paused|interrupted`
- `paused -> queued|completed`
- `interrupted -> queued|failed`
- `RunStatus`: `queued -> running -> success|failed|cancelled|interrupted|parse_failed`

## 5.2 三类 Loop 的 step 枚举

```ts
type ReviewerStep = 'discover' | 'filter' | 'claim' | 'snapshot' | 'review' | 'publish'
type WorkerStep = 'prepare-task' | 'prepare-worktree' | 'plan-step' | 'execute-step' | 'validate-step' | 'sync-checklist' | 'open-pr'
type FixerStep = 'discover-pr' | 'claim-pr' | 'collect-fixes' | 'repair' | 'validate' | 'push' | 'recheck'
```

说明：

- `watch` 不作为长期占用的运行态 step
- watch 行为由下一轮 scheduler poll 自然覆盖
- `interrupted` 必须记录最后成功 step，供恢复时重入

## 5.3 可恢复性标注

- Reviewer：`snapshot / review / publish` 可恢复
- Worker：`plan-step / execute-step / validate-step / open-pr` 可恢复
- Fixer：`collect-fixes / repair / validate / push` 可恢复

恢复时规则：

- 若最后一步未产生外部副作用，则从该 step 重试
- 若最后一步已产生外部副作用，则从下一步或幂等检查点继续

建议每个 Loop 单独实现 transition 函数：

```ts
function transitionReviewerLoop(state: ReviewerLoopState, event: ReviewerEvent) {
  // ...
}
```

不要把状态迁移藏在 service 逻辑分支里。

---

## 6. 审计事件

建议内建这些事件：

- `loop.created`
- `loop.started`
- `run.started`
- `agent.invoked`
- `agent.completed`
- `pr.review.posted`
- `task.checklist.updated`
- `notification.sent`
