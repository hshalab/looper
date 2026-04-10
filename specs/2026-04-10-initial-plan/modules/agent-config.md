# Agents 持久化配置详细实现计划

## 1. 目标

Looper 需要把“调用哪个 coding agent、使用什么模型、带哪些运行参数”从代码中抽离，变成**可持久化、可项目级覆盖、可按 loop/task 选择**的配置实体。

这层配置主要解决三个问题：

1. 不同项目可以选不同 coding agent
2. 同一 coding agent 可以定义多个 profile
3. Reviewer / Worker / Fixer 可以分别绑定不同 profile

---

## 2. 建议的数据模型

### 2.1 AgentProfile

```ts
type AgentVendor = 'claude-code' | 'codex' | 'opencode' | 'cursor-cli'

type AgentProfile = {
  id: string
  name: string
  vendor: AgentVendor
  description?: string
  model?: string
  enabled: boolean
  scope: 'global' | 'project'
  projectId?: string
  mode?: 'interactive' | 'headless'
  params: Record<string, unknown>
  env: Record<string, string>
  createdAt: string
  updatedAt: string
}
```

### 2.2 AgentBinding

```ts
type AgentBinding = {
  id: string
  projectId: string
  targetType: 'reviewer' | 'worker' | 'fixer'
  profileId: string
  fallbackProfileIds?: string[]
  createdAt: string
  updatedAt: string
}
```

---

## 3. 配置优先级

建议优先级从高到低：

1. Run 级临时覆盖
2. Task / Loop 级指定 profile
3. Project 级 binding
4. Global 默认 profile
5. Agent 自身默认值

---

## 4. 统一配置字段

```ts
type UnifiedAgentParams = {
  model?: string
  workingDirectory?: string
  resume?: 'none' | 'latest' | 'session-id'
  sessionId?: string
  outputFormat?: 'text' | 'json' | 'stream-json'
  approvalMode?: string
  sandboxMode?: string
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  extraWritableDirs?: string[]
  subagent?: string
  subagents?: unknown
  configProfile?: string
  timeoutMs?: number
  canWrite?: boolean
  canCommit?: boolean
  canPush?: boolean
}
```

vendor-specific 参数放在 `params` 中。

---

## 5. 各 Agent 可用参数调研摘要

### 5.1 Claude Code

- 关键参数：`--model`、`--permission-mode`、`--allowedTools`、`--disallowedTools`、`--tools`、`-p/--print`、`--output-format`、`--json-schema`、`--continue`、`--resume`、`--fork-session`、`--session-id`、`--name`、`--add-dir`、`--worktree`、`--agent`、`--agents`、`--bare`
- 关键环境变量：`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL`、`ANTHROPIC_BASE_URL`
- 支持 subagent，且子代理可配置 `model / tools / disallowedTools / permissionMode / maxTurns / skills / background`
- 注意：subagent 不能再 spawn subagent

### 5.2 Codex CLI

- 关键参数：`--model/-m`、`--ask-for-approval/-a`、`--sandbox/-s`、`--yolo`、`--full-auto`、`codex exec --json`、`--output-last-message`、`--output-schema`、`--cd/-C`、`--add-dir`、`--profile/-p`、`codex resume`、`codex exec resume --last --all`、`--ephemeral`
- 关键配置/环境变量：`CODEX_HOME`、`CODEX_SQLITE_HOME`、`config.toml`、`.codex/config.toml`
- 支持 subagents，重点配置包括 `agents.max_threads`、`agents.max_depth`、`agents.job_max_runtime_seconds`
- 内置 agent：`default`、`worker`、`explorer`

### 5.3 OpenCode

- 关键参数：`--model/-m`、`permission`、`opencode run --format json`、`--continue/-c`、`--session/-s`、`--fork`、`--prompt`、`--file/-f`、`opencode serve`、`opencode run --attach`、`opencode acp --cwd`
- 关键配置/环境变量：`~/.config/opencode/opencode.json`、`opencode.json`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`、`OPENCODE_PERMISSION`、`OPENCODE_ENABLE_EXA`
- 支持 agent / subagent：primary `build`、`plan`；subagent `general`、`explore`
- 还可配置 `default_agent`、`mode`、`permission.task`

### 5.4 Cursor CLI

- 关键参数：`--model`、`-p/--print`、`--output-format`、`--stream-partial-output`、`--resume <session-id>`、`--force`、`--yolo`
- 关键配置/环境变量：`CURSOR_API_KEY`、`~/.cursor/cli-config.json`、`<project>/.cursor/cli.json`、`CURSOR_CONFIG_DIR`
- 支持 subagents / background agents：`is_background: true`、`readonly: true`、`model: inherit | fast | <model>`
- 内置 subagents：`explore`、`bash`、`browser`

---

## 6. 推荐持久化结构

### 6.1 ClaudeCodeParams

```ts
type ClaudeCodeParams = {
  model?: string
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
  outputFormat?: 'text' | 'json' | 'stream-json'
  allowedTools?: string[]
  disallowedTools?: string[]
  tools?: string[]
  addDirs?: string[]
  useWorktree?: boolean
  sessionMode?: 'new' | 'continue' | 'resume'
  sessionId?: string
  agent?: string
  agentsJson?: unknown
  bare?: boolean
}
```

### 6.2 CodexParams

```ts
type CodexParams = {
  model?: string
  approvalPolicy?: string
  sandboxMode?: string
  fullAuto?: boolean
  yolo?: boolean
  jsonOutput?: boolean
  outputSchemaPath?: string
  cd?: string
  addDirs?: string[]
  profile?: string
  resume?: 'none' | 'last' | 'session'
  sessionId?: string
  ephemeral?: boolean
}
```

### 6.3 OpenCodeParams

```ts
type OpenCodeParams = {
  model?: string
  permission?: 'allow' | 'ask' | 'deny'
  outputFormat?: 'text' | 'json'
  continue?: boolean
  sessionId?: string
  fork?: boolean
  prompt?: string
  files?: string[]
  attach?: boolean
  cwd?: string
  defaultAgent?: string
}
```

### 6.4 CursorCliParams

```ts
type CursorCliParams = {
  model?: string
  print?: boolean
  outputFormat?: 'text' | 'json' | 'stream-json'
  streamPartialOutput?: boolean
  resumeSessionId?: string
  force?: boolean
  yolo?: boolean
  workspace?: string
  subagent?: string
}
```

---

## 7. Looper 内部接口建议

```ts
interface AgentProfileStore {
  list(scope?: 'global' | 'project', projectId?: string): Promise<AgentProfile[]>
  getById(id: string): Promise<AgentProfile | null>
  save(profile: AgentProfile): Promise<void>
  delete(id: string): Promise<void>
}
```

```ts
interface AgentBindingStore {
  listByProject(projectId: string): Promise<AgentBinding[]>
  getByTarget(projectId: string, targetType: 'reviewer' | 'worker' | 'fixer'): Promise<AgentBinding | null>
  save(binding: AgentBinding): Promise<void>
}
```

```ts
interface AgentProfileResolver {
  resolve(input: {
    projectId: string
    targetType: 'reviewer' | 'worker' | 'fixer'
    overrideProfileId?: string
  }): Promise<ResolvedAgentProfile>
}
```

---

## 8. MVP 建议

第一阶段建议只支持：

- `global + project` 两级 AgentProfile
- 每个 loop 绑定一个 profile
- 单个 fallback profile
- UI/CLI 可查看当前绑定

先不做：

- 自动基于任务内容切换 profile
- 复杂 profile 继承链
- 动态 AB 测试 agent

---

## 9. CLI / API 管理设计

## 9.1 CLI 命令建议

建议新增：

- `looper agent profile list`
- `looper agent profile create`
- `looper agent profile update`
- `looper agent profile delete`
- `looper agent binding list`
- `looper agent binding set`
- `looper agent binding unset`
- `looper agent resolve --project <id> --target <reviewer|worker|fixer>`

### 示例

```bash
looper agent profile create --vendor codex --name codex-reviewer-fast --model gpt-5 --json
looper agent binding set --project demo --target reviewer --profile codex-reviewer-fast
looper agent resolve --project demo --target reviewer
```

## 9.2 HTTP API 建议

### Agent Profiles

- `GET /agent-profiles`
- `POST /agent-profiles`
- `GET /agent-profiles/:id`
- `PATCH /agent-profiles/:id`
- `DELETE /agent-profiles/:id`

### Agent Bindings

- `GET /projects/:projectId/agent-bindings`
- `PUT /projects/:projectId/agent-bindings/:targetType`
- `DELETE /projects/:projectId/agent-bindings/:targetType`

### Resolve / Validate

- `POST /agent-profiles/:id/validate`
- `GET /projects/:projectId/agent-resolution/:targetType`

## 9.3 validate 的目标

保存 profile 前后都建议支持 validate：

- vendor 是否已安装
- model 是否可用
- 参数是否合法
- 必需环境变量是否存在
- profile 是否能成功解析成最终命令

---

## 10. UI 配置设计

## 10.1 Settings 页面建议拆分

### Agent Profiles

展示：

- name
- vendor
- model
- scope
- enabled
- last validation status

操作：

- 创建 profile
- 编辑 profile
- 复制 profile
- 禁用 / 启用
- 删除 profile

### Agent Bindings

按项目展示：

- Reviewer -> profile
- Worker -> profile
- Fixer -> profile
- fallback profile

## 10.2 表单设计建议

每种 vendor 表单分成三块：

1. **基础信息**：name / vendor / model / scope
2. **运行参数**：json/text 格式、权限模式、resume、subagent 等
3. **环境变量**：只展示 key，value 可 masked

## 10.3 交互建议

- 保存前做 schema 校验
- 提供“测试配置”按钮
- 对高风险参数给 warning（如 yolo / bypassPermissions / force）
- 支持从已有 profile 复制

---

## 11. 默认推荐 profile 策略

建议不是默认直接绑定某个 vendor，而是提供一组推荐模板。

## 11.1 Reviewer 推荐

目标：偏稳定、结构化输出、尽量低副作用。

推荐倾向：

- Claude Code：适合重审查、subagent 辅助探索
- Codex：适合结构化 JSON 输出与自动化 scripting
- OpenCode：适合已有 OpenCode 生态的团队

默认建议参数：

- `outputFormat=json`
- 尽量只读 / 低写权限
- 开启 resume
- subagent 仅限 explore / worker-like 辅助，不允许无限扩散

## 11.2 Worker 推荐

目标：偏代码实现、验证、分步推进。

推荐倾向：

- Codex：适合脚本化执行、approval/sandbox 控制清晰
- OpenCode：适合 provider/model 灵活切换
- Claude Code：适合高质量规划 + 执行结合

默认建议参数：

- 允许写工作区
- 禁止直接操作受保护分支
- 输出用 `json` 或 `stream-json`
- 强制绑定 worktree/cwd

## 11.3 Fixer 推荐

目标：偏修复、短闭环、可重试。

推荐倾向：

- Codex：适合短任务修复和验证脚本
- Claude Code：适合复杂评论/冲突修复
- Cursor CLI：适合已有 Cursor 工作流团队

默认建议参数：

- 小预算、短超时
- 强制结构化 FixItem 输入
- 开启本地验证
- commit/push 权限可开，但要受 project policy 限制

## 11.4 MVP 推荐模板

建议在系统内预置这些模板：

- `claude-reviewer-safe`
- `codex-reviewer-json`
- `codex-worker-default`
- `opencode-worker-flex`
- `codex-fixer-fast`
- `claude-fixer-complex`

这些模板应可复制后再编辑，而不是硬编码不可改。

---

## 12. 主要参考来源

- Claude Code: https://docs.anthropic.com/en/docs/claude-code/cli-reference , https://docs.anthropic.com/en/docs/claude-code/headless , https://docs.anthropic.com/en/docs/claude-code/settings , https://code.claude.com/docs/en/env-vars , https://docs.anthropic.com/en/docs/claude-code/sub-agents , https://docs.anthropic.com/en/docs/claude-code/model-config
- Codex CLI: https://developers.openai.com/codex/cli/reference , https://developers.openai.com/codex/config-basic , https://developers.openai.com/codex/config-reference , https://developers.openai.com/codex/config-advanced , https://developers.openai.com/codex/cli/features , https://developers.openai.com/codex/subagents
- OpenCode: https://opencode.ai/docs/cli/ , https://opencode.ai/docs/config/ , https://opencode.ai/docs/models/ , https://opencode.ai/docs/agents/ , https://opencode.ai/docs/permissions/ , https://opencode.ai/docs/providers/
- Cursor CLI: https://cursor.com/en-US/blog/cli , https://cursor.com/docs/cli/reference/parameters , https://cursor.com/docs/cli/headless.md , https://cursor.com/docs/cli/reference/configuration , https://cursor.com/docs/subagents.md
