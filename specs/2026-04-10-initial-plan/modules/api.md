# HTTP API 详细实现计划

## 1. 目标

提供稳定、可脚本化、面向 CLI/UI 的服务接口。

---

## 2. API 设计原则

- REST 风格优先
- 统一使用 `/api/v1` 前缀
- 返回统一 envelope
- 幂等写接口支持 `Idempotency-Key`
- 长任务返回 `taskId/runId`
- 认证通过 `Authorization: Bearer <local-token>` header 承载（如启用）

---

## 3. 返回格式

```ts
type ApiResponse<T> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
  requestId: string
}
```

---

## 4. 建议补充接口

### 4.1 系统

- `GET /api/v1/healthz`
- `GET /api/v1/config`
- `GET /api/v1/status`

### 4.2 审计

- `GET /api/v1/events`
- `GET /api/v1/events/:entityType/:entityId`

### 4.3 Worktrees

- `GET /api/v1/worktrees`
- `POST /api/v1/worktrees/:taskId/recover`

### 4.4 Agent Profiles

- `GET /api/v1/agent-profiles`
- `POST /api/v1/agent-profiles`
- `GET /api/v1/agent-profiles/:id`
- `PATCH /api/v1/agent-profiles/:id`
- `DELETE /api/v1/agent-profiles/:id`
- `POST /api/v1/agent-profiles/:id/validate`

### 4.5 Agent Bindings

- `GET /api/v1/projects/:projectId/agent-bindings`
- `PUT /api/v1/projects/:projectId/agent-bindings/:targetType`
- `DELETE /api/v1/projects/:projectId/agent-bindings/:targetType`
- `GET /api/v1/projects/:projectId/agent-resolution/:targetType`

---

## 5. 错误码建议

- `LOOP_NOT_FOUND`
- `TASK_NOT_FOUND`
- `PR_ALREADY_CLAIMED`
- `AGENT_NOT_AVAILABLE`
- `WORKTREE_NOT_FOUND`
- `VALIDATION_FAILED`

---

## 5.1 聚合状态接口

`GET /api/v1/status` 应作为总览接口，供 `looper status` 直接消费。

建议返回：

```ts
type LooperStatusResponse = {
  service: {
    healthy: boolean
    version: string
    daemonMode: 'foreground' | 'launchd'
    startedAt?: string
  }
  storage: {
    mode: 'sqlite'
    dbPath: string
    schemaVersion: string
    pendingMigrations: string[]
    healthy: boolean
  }
  scheduler: {
    healthy: boolean
    queuedItems: number
    runningItems: number
  }
  loops: {
    reviewer: { running: number; paused: number; failed: number }
    worker: { running: number; paused: number; failed: number }
    fixer: { running: number; paused: number; failed: number }
  }
  notifications: {
    osascriptEnabled: boolean
  }
  tools: {
    bun: boolean
    git: boolean
    gh: boolean
    osascript: boolean
  }
}
```

---

## 6. 实现顺序

1. healthz
2. tasks
3. loops
4. runs/logs
5. pr actions
6. agent profiles / bindings
