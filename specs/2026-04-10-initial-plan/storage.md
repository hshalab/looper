# Looper 存储接口设计（MVP：SQLite，无 ORM）

## 1. 目标

本 spec 定义 Looper 的持久化抽象，要求：

1. MVP 使用 **SQLite** 落地
2. 业务层不直接依赖数据库细节
3. **不引入 ORM**，采用原生 SQL + 薄 repository
4. schema 通过 migration 文件演进

换句话说：**先确定存储边界，再选择最小可控实现。**

---

## 2. 为什么 MVP 改为 SQLite

当前 Looper 的特点决定了它更适合 SQLite：

- 有常驻 looperd
- 有多类 loop 并发执行
- 有锁、队列、run、event log
- 有恢复逻辑
- 后续会有 UI 查询与筛选

SQLite 在这个阶段的优势：

- 单机零运维
- 原子写入与事务能力完善
- 比 JSON/lowdb 更适合并发与恢复
- 查询能力强，便于后续 UI 和排障
- Bun 原生支持 `bun:sqlite`

同时明确：

- **先不上 ORM**
- **先不用重型 query builder**
- migration 使用原生 SQL 文件

---

## 3. 设计原则

1. **存储实现可替换**：业务层只依赖 `Store` 接口
2. **SQLite 优先，但接口不和 Bun 绑定**
3. **原生 SQL 优先**：避免 ORM 早期绑架数据模型
4. **migration 明确可审计**
5. **关键写操作必须事务化**
6. **Project 配置与运行态分层**

---

## 4. 推荐文件结构

```txt
apps/
  looperd/
    src/
      storage/
        types.ts
        store.ts
        sqlite/
          db.ts
          sqlite-store.ts
          migrations/
            0001_init.sql
            0002_add_queue_items.sql
            0003_add_agent_profiles.sql
          migrate.ts
```

---

## 5. 存储分层

### 5.1 Store Interface Layer

定义领域侧访问接口，例如：

- `ProjectStore`
- `AgentProfileStore`
- `AgentBindingStore`
- `LoopStore`
- `RunStore`
- `TaskStore`
- `ChecklistStore`
- `LockStore`
- `EventLogStore`
- `QueueStore`

### 5.2 Persistence Adapter Layer

实现具体持久化：

- `SqliteProjectStore`
- `SqliteLoopStore`
- `SqliteTaskStore`

### 5.3 Storage Coordinator

统一处理：

- 打开数据库
- 执行 migrations
- 暴露事务能力
- 备份与 healthcheck

---

## 6. SQLite 数据文件建议

MVP 建议使用单数据库文件：

- `~/.looper/looper.db`

同时保留：

- `~/.looper/backups/`
- `~/.looper/logs/`

推荐数据库级设置：

- 开启 `WAL`
- 开启 `foreign_keys`
- 合理设置 `busy_timeout`

---

## 7. 核心接口设计

### 7.1 基础能力

```ts
export interface StorageDriver {
  initialize(): Promise<void>
  backup(): Promise<void>
  healthcheck(): Promise<StorageHealth>
}
```

```ts
export interface StorageHealth {
  ok: boolean
  mode: 'sqlite'
  lastUpdatedAt?: string
  details?: string
}
```

### 7.2 ProjectStore

```ts
export interface ProjectStore {
  list(): Promise<Project[]>
  getById(id: string): Promise<Project | null>
  save(project: Project): Promise<void>
  delete(id: string): Promise<void>
}
```

### 7.3 LoopStore

```ts
export interface LoopStore {
  list(): Promise<Loop[]>
  listByStatus(status: LoopStatus): Promise<Loop[]>
  getById(id: string): Promise<Loop | null>
  save(loop: Loop): Promise<void>
  updateStatus(id: string, status: LoopStatus): Promise<void>
}
```

### 7.4 RunStore

```ts
export interface RunStore {
  listByLoop(loopId: string): Promise<Run[]>
  getById(id: string): Promise<Run | null>
  save(run: Run): Promise<void>
  finish(input: {
    id: string
    status: 'success' | 'failed' | 'cancelled' | 'interrupted' | 'parse_failed'
    summary?: string
    errorMessage?: string
    endedAt: string
  }): Promise<void>
}
```

### 7.5 TaskStore

```ts
export interface TaskStore {
  list(): Promise<Task[]>
  getById(id: string): Promise<Task | null>
  save(task: Task): Promise<void>
  updatePRLink(taskId: string, prNumber: number): Promise<void>
}
```

### 7.6 ChecklistStore

```ts
export interface ChecklistStore {
  listByTask(taskId: string): Promise<ChecklistItem[]>
  create(item: ChecklistItem): Promise<void>
  update(item: ChecklistItem): Promise<void>
  markDone(id: string): Promise<void>
  listOpenByTask(taskId: string): Promise<ChecklistItem[]>
}
```

### 7.7 LockStore

```ts
export interface LockStore {
  acquire(lock: LockRecord): Promise<boolean>
  release(key: string): Promise<void>
  get(key: string): Promise<LockRecord | null>
  listExpired(now: string): Promise<LockRecord[]>
}
```

### 7.8 EventLogStore

```ts
export interface EventLogStore {
  append(event: EventLogRecord): Promise<void>
  listByEntity(entityType: string, entityId: string): Promise<EventLogRecord[]>
}
```

### 7.9 QueueStore

```ts
export interface QueueStore {
  enqueue(item: QueueItemRecord): Promise<void>
  dequeue(id: string): Promise<void>
  listScheduled(): Promise<QueueItemRecord[]>
  markAttempt(id: string, attempts: number): Promise<void>
}
```

---

## 8. 业务层如何使用

业务服务只能依赖接口，例如：

```ts
export interface LooperStores {
  projects: ProjectStore
  agentProfiles: AgentProfileStore
  agentBindings: AgentBindingStore
  loops: LoopStore
  runs: RunStore
  tasks: TaskStore
  checklist: ChecklistStore
  locks: LockStore
  events: EventLogStore
  queue: QueueStore
}
```

重点：这里完全不出现 SQLite SQL 细节。

---

## 9. SQLite 实现约束

### 9.1 事务

以下操作建议放进事务：

- 创建 run + 写 event
- acquire lock + 变更 loop 状态
- 完成 checklist item + 更新 task
- enqueue/dequeue + attempts 更新

### 9.2 恢复

looperd 启动时应执行：

1. 打开 SQLite
2. 执行 migrations
3. 扫描过期锁并清理
4. 将异常中断的 `running` run 标为 `failed` 或 `interrupted`
5. 恢复未完成的 queue items
6. 记录恢复事件

### 9.3 备份

- 启动 migration 前自动备份 db
- 大版本升级前建议再做一次命名备份

---

## 10. 记录模型建议

建议区分 **领域对象** 与 **存储记录**：

- `Loop` / `LoopRecord`
- `Task` / `TaskRecord`
- `Run` / `RunRecord`
- `QueueItem` / `QueueItemRecord`

这样做的好处：

- SQL schema 调整时不影响业务层
- 未来迁 Postgres 更容易
- 能显式处理序列化字段（如 `Date -> string`）

---

## 11. Project 真相源与合并策略

Project 需要明确双层职责：

- **config 文件**：真相源，保存 repo 注册信息与静态配置（`repoPath`、`baseBranch`、`worktreeRoot`）
- **storage**：运行态镜像，保存运行统计与状态（`archived`、最后同步时间、活跃 loop 数等）

启动时建议：

1. 读取 config 中的项目列表
2. 合并到 storage 中的 `projects`
3. config 已删除的项目不物理删除，而是标记 `archived`
4. 运行态字段只写 storage，不回写 config

---

## 12. 为什么先不上 ORM

当前阶段不建议引入 ORM，原因：

- 数据模型仍在快速变化
- Looper 更偏调度器/状态机，而不是典型 CRUD 后台
- 锁、队列、恢复、事件日志更适合直接用 SQL 表达
- 使用 ORM 反而会引入额外抽象和 migration 绑定

MVP 推荐组合：

- `bun:sqlite`
- 原生 SQL
- 薄 repository
- SQL migration 文件

未来如确实需要类型化 query builder，再单独评估是否引入更轻量的方案。

---

## 13. SQLite Migration 策略

详细设计见：[`./modules/sqlite-migrations.md`](./modules/sqlite-migrations.md)

当前约定：

- 使用 `schema_migrations` 跟踪已应用版本
- migration 文件按序号命名
- looperd 启动时自动执行未应用 migration
- migration 前自动备份数据库
- migration 失败则阻止服务进入 running 状态

补充：由于 Looper 预期通过 npm 分发，数据库 schema 升级必须是**自动升级流程**的一部分，而不是要求用户手工执行独立升级命令。

---

## 14. MVP 非目标

当前阶段先不做：

- 通用 ORM
- 多数据库兼容层
- 分布式事务
- 跨实例锁
- 高级索引优化

---

## 15. 建议的下一步

1. 在 `packages/core` 定义领域模型
2. 在 `apps/looperd` 定义 store interfaces
3. 先实现 SQLite driver + migrations runner
4. 用 Reviewer Loop 打通第一条完整链路
