# Scheduler / Queue 详细实现计划

## 1. 目标

把“发现工作”和“执行工作”分离，避免 loop 逻辑直接写成无限轮询脚本。

---

## 2. 模块职责

- 周期扫描
- work item 入队
- 执行限流
- 失败重试
- 超时控制
- 锁协调

---

## 3. 数据结构

```ts
type QueueItem = {
  id: string
  type: 'reviewer' | 'worker' | 'fixer'
  targetId: string
  dedupeKey: string
  scheduledAt: string
  attempts: number
}
```

`QueueItem` 不应仅存在内存里，必须持久化到 storage，以便 looperd 重启后恢复待执行工作。

---

## 4. 执行模型

### 4.1 scanner

负责按固定周期发现候选 PR / task。

### 4.2 planner

负责把候选对象转成 `QueueItem`。

### 4.2.1 Loop 优先级

建议优先级：

1. `reviewer`
2. `fixer`
3. `worker`

原因：

- 先完成 review 决策，再进入 fixer 更安全
- worker 通常周期更长，优先级可低于面向已有 PR 的闭环任务

### 4.3 executor

负责真正调用对应 service 执行。

---

## 5. 重试策略

- 默认最多 3 次
- 指数退避
- 区分可重试与不可重试错误

---

## 6. 并发策略

- 同一 PR / task 同时只能有一个 active item
- Reviewer / Worker / Fixer 可以分别限流

补充约束：

- 同一 PR 使用统一锁 `pr:{repo}:{pr}`
- 同一 task 使用统一锁 `task:{taskId}`
- 当 reviewer item 存在时，fixer item 不得抢占同一 PR
