# CLI / UI 详细实现计划

## 1. 目标

CLI 和 UI 都只作为 `looperd` 的客户端，不直接操作 GitHub、Git、Agent。

---

## 2. CLI 实现计划

### 2.1 核心命令

- `looper status`
- `looper project add`
- `looper agent profile list`
- `looper agent profile create`
- `looper agent binding list`
- `looper agent binding set`
- `looper daemon install`
- `looper daemon status`
- `looper daemon logs`
- `looper loop list`
- `looper loop start`
- `looper loop pause`
- `looper task create`
- `looper task show`
- `looper run list`
- `looper logs tail`

### 2.2 CLI 分层

- command parser
- api client
- output formatter

### 2.3 输出策略

- 默认人类可读
- 提供 `--json`
- 错误统一输出 request id / run id

### 2.4 `looper status` 命令建议

`looper status` 用于聚合展示各模块状态，避免用户分别调用 daemon / db / loop / queue 多个命令。

建议展示：

- looperd 服务状态
- daemon 状态（如适用）
- SQLite db 路径、schema 版本、pending migrations
- scheduler 状态与队列长度
- reviewer / worker / fixer 的运行摘要
- 外部工具可用性（bun / git / gh / osascript）
- 通知开关状态

建议参数：

- `--json`
- `--watch`
- `--verbose`

人类可读模式建议优先输出红/黄/绿摘要，JSON 模式则直接返回聚合状态原文。

### 2.5 daemon 命令建议

- `looper daemon install`：安装并注册 launchd plist
- `looper daemon start|stop|restart`：管理后台服务
- `looper daemon status`：展示 launchd + healthz 双状态
- `looper daemon logs`：查看 looperd stdout/stderr

推荐让 daemon 命令既输出 launchd 信息，也输出 `looperd` 自身健康状态，避免只看到“已加载”但服务实际上不可用。

---

## 3. UI 实现计划

### 3.1 MVP 页面

- Dashboard
- Loops 列表
- Task 详情
- PR / Run 详情
- Settings
- Agent Profiles
- Agent Bindings

### 3.2 页面优先级

先只做只读页面，再补操作按钮。

### 3.3 关键组件

- Loop status badge
- Run timeline
- Checklist panel
- PR health summary
- Agent log viewer
- Agent profile form
- Agent binding matrix

### 3.4 Agent 配置页建议

- Profile 列表页：按 vendor / scope / enabled 筛选
- Profile 编辑页：按 vendor 渲染不同参数表单
- Binding 页：按 `reviewer / worker / fixer` 配置项目绑定
- Resolve 预览：展示最终解析后的 vendor/model/关键参数

---

## 4. 客户端 API 约束

- 所有状态修改都走 HTTP API
- CLI/UI 不缓存真相源
- 界面轮询或 SSE 均可，MVP 先轮询
