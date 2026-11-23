# pi-muse 配置

pi-muse 只从一个配置文件读取启动配置：

```text
.pi-muse/config.json
```

该文件必须存在；缺失、JSON 语法错误、未知字段、类型不合法或未知 `schemaVersion` 都会启动失败。服务端不支持旧的环境变量配置，也不支持 `${ENV_NAME}` 插值。模型 API key 直接写在 `model.apiKey`。自有 `web/` 的 `API_TARGET` 只用于 Vite 的 `/api` 代理，不是服务端配置来源。

## 创建配置 {#create-configuration}

~~~sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
~~~

然后编辑：

~~~json
{
  "schemaVersion": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 12330,
    "accessKey": "",
    "allowedOrigins": [
      "http://localhost:15173",
      "http://127.0.0.1:15173"
    ]
  },
  "model": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "id": "my-model",
    "apiKey": "paste-model-api-key-here",
    "contextWindow": 32768,
    "maxTokens": 4096
  },
  "runtime": {
    "runTimeoutMs": 120000,
    "schedulerIntervalMs": 30000
  },
  "tools": {
    "writable": {
      "enabled": true,
      "actionTimeoutMs": 300000
    },
    "web": {
      "enabled": true
    },
    "weather": {
      "enabled": true,
      "defaultCity": "上海"
    },
    "browser": {
      "enabled": true,
      "allowPrivateTargets": false,
      "desktopPort": 6080
    },
    "presentation": {
      "default": "hidden",
      "overrides": {
        "currentTime": "summary",
        "get_weather": "summary",
        "search_web": "summary",
        "memory": "summary",
        "schedule": "summary"
      }
    }
  }
}
~~~

所有 section 和字段都可以按需省略；省略后使用内置默认值。`schemaVersion` 当前为 `1`。

## 字段说明 {#field-reference}

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | 默认监听全部网卡便于局域网访问；非回环 host 但 `server.accessKey` 为空时仅打印警告，由用户自行决定是否补上 |
| `server.port` | `12330` | HTTP 监听端口；被占用时启动直接报错并指出占用 PID（用 `lsof` 查，跨平台不兼容时退化为通用提示）；只在确认属于本项目开发服务后协调重启，生产或归属不明的进程不擅自停止 |
| `server.accessKey` | 空 | 服务访问密钥，不是模型 key；留空启动会打印非回环 host 的安全警告，但不会阻断启动 |
| `server.allowedOrigins` | localhost / 127.0.0.1 的 15173、12330 共四个 origin | CORS origin 数组；显式配置会替换默认列表，用于自有 Web |
| `model.baseUrl` | 空 | OpenAI-compatible API 根地址，例如 `/v1`；必须与 `model.id` 同时配置 |
| `model.id` | 空 | 唯一业务模型 ID；图片附件要求该模型支持视觉输入，不自动切换或降级 |
| `model.apiKey` | 空 | 模型 API key，直接写在配置文件中 |
| `model.contextWindow` | `32768` | 必须大于 `model.maxTokens` |
| `model.maxTokens` | `4096` | 模型输出上限 |
| `runtime.runTimeoutMs` | `120000` | 聊天轮运行预算（毫秒）；等待人工审批期间暂停计时，所有待审批结束后按剩余预算继续，不重新获得完整预算。审批仍按自身 TTL 到期，Stop/断线仍立即取消；不改变 jobs trigger 的超时语义 |
| `runtime.schedulerIntervalMs` | `30000` | 定时任务扫描间隔 |
| `runtime.monitorScanIntervalMs` | `60000` | 网页监控扫描间隔 |
| `runtime.dataDir` | 配置文件所在目录 | 相对路径按配置文件所在目录解析；推荐绝对路径，但不强制 |
| `tools.writable.enabled` | `true` | 是否注册 `write` / `edit`，并允许 `skills.save`；开启后仍需逐次人工审批，`skills.list/read` 不受该开关影响 |
| `tools.writable.actionTimeoutMs` | `300000` | 文件操作审批有效期（毫秒）；过期不能提交修改 |
| `tools.web.enabled` | `true` | 是否向模型声明 `search_web` / `web_fetch` |
| `tools.web.timeoutMs` | `30000` | 整个 Web 抓取总超时预算（毫秒，含最多 6 次重定向，每跳使用剩余时间） |
| `tools.web.maxResponseBytes` | `2000000` | 单次响应大小上限 |
| `tools.web.maxContentChars` | `50000` | `web_fetch` 默认返回字符上限 |
| `tools.web.searchResults` | `5` | 默认搜索结果数，工具参数最大 10 |
| `tools.web.userAgent` | 浏览器 UA | Web 请求 User-Agent |
| `tools.web.allowPrivateTargets` | `false` | 仅本机联调时显式放宽私网/回环目标限制；其余请求安全边界不变 |
| `tools.weather.enabled` | `true` | 是否向模型声明 `get_weather` |
| `tools.weather.defaultCity` | 空 | 用户未指定城市时使用的默认城市；为空时模型会追问城市 |
| `tools.browser.enabled` | `true` | 是否启用真实浏览器域与 `navigate` / `snapshot` / `act` / `tab` 工具 |
| `tools.browser.executablePath` | 空 | 系统 Chrome 可执行文件路径；省略时使用 Playwright 的 `chrome` channel |
| `tools.browser.allowPrivateTargets` | `false` | 仅本机联调/测试时允许回环与私网页面；默认保持公网 HTTP(S) 边界 |
| `tools.browser.timeoutMs` | `30000` | 标签导航和元素操作超时 |
| `tools.browser.desktopPort` | `6080` | 容器内 websockify/noVNC 桌面端口（1–65535）；只绑定 127.0.0.1，对外桌面访问统一走同源 `/browser/desktop/` 网关 |
| `tools.presentation.default` | `hidden` | 客户端实时流与历史投影的工具展示策略：`hidden` 隐藏工具调用，`summary` 只发送受控摘要 |
| `tools.presentation.overrides` | `{}` | 按工具名覆盖默认策略；名称以 `src/adapters/pi/tools/index.ts` 的显式注册表为准，包括 `currentTime`、`database`、`instructions`、`memory`、`memory_search`、`schedule`、`subagent`、`goal`、`monitor`、`read`、`grep`、`find`、`ls`、`write`、`edit`、`skills`、`search_web`、`web_fetch`、`get_weather`、`navigate`、`snapshot`、`act`、`tab` |

默认情况下，`.pi-muse/config.json` 所在的 `.pi-muse/` 同时也是实例数据目录。当前默认实例目录已统一为 `.pi-muse/`，旧目录不会被自动读取或迁移。也就是说 sessions、memory、jobs、workspace 和配置文件保持在同一个实例目录内。
`runtime.dataDir: "."` 也表示该配置文件目录，与启动进程的 cwd 无关；若在 `.pi-muse/config.json` 中填 `".pi-muse"`，则会指向其下嵌套的 `.pi-muse/`，不是项目根目录下的同名目录。
公开会话 ID 与内部 pi 会话 ID 区分。`main` 永久存在，专题会话按需创建；聊天历史隔离，助手指令与技能开关全局共享，工作区只有一个实例级根。

## 实例目录结构 {#instance-directory-structure}

```text
DATA_DIR/
  workspace/
    assistant/                    USER.md、SOUL.md、INSTRUCTIONS.md
    domains/news/INSTRUCTIONS.md  新闻推荐规则
    domains/sms/INSTRUCTIONS.md   短信提醒规则
    files/                        普通文件
  sessions/
    index.json
    <sessionId>/                  history/
  state/
    assistant/                    memory.md、identity.json、skill-overrides.json
    main.sqlite                   定时任务、目标、审批、短信状态、Dream 状态、消息反馈
    news.sqlite                   新闻数据和学习画像
    monitors.json                 网页监控
  assets/                         companions/、skills/、subagents/
  runtime/                        auth/、pi/、browser/、traces/、android-updates/
```

「工作区文件」显示助手资料、领域指令与普通文件，详见[指令与提示词](instructions.md)。下拉刷新目录，点右上角的菜单可新建文本或跳转目录。设置和工作区文件页读写同一份原始 Markdown；五份托管指令与人设文档还支持顶部 YAML Frontmatter `include:` 拆分引用并在注入模型前实时展开。主聊天与专题会话共用助手资料与指令，新闻和短信只读取各自领域的规则，子代理只持有当轮上下文。新布局从空状态初始化，旧目录中的数据不导入。

## Android 更新镜像

GitHub 发布成功后可向 `POST /updates/android/refresh` 发送空请求，通知服务端从固定的官方仓库同步。请求无需登录，也无需发送任何密钥。服务端在 `runtime/android-updates/` 保存近期版本，校验所有 APK 的大小和 SHA-256 后才发布新清单。同步失败时继续提供原有版本。

支持镜像的 Android 客户端会优先访问已保存服务器的 `/updates/android/latest`。镜像不可用或校验不通过时，客户端使用官方 GitHub。镜像可以走现有 HTTP 地址，更新包的包名与签名仍须匹配已安装的应用。首次安装请使用官方 HTTPS 发布页。

## 数据存储与安全边界 {#data-storage-and-security-boundaries}

- **数据明文存储**：会话历史、用户档案、记忆、工作区与状态文件均为明文存储。实例目录、`auth.key`（签名密钥）及任何实例备份均包含敏感凭据与个人数据，必须按敏感数据严格保护权限（建议 `0700`/`0600`），切勿公开或上传。
- **访问凭据有效性**：登录 Token 长期有效且可跨服务重启维持；更换 `server.accessKey` 并重启服务使配置生效后，旧 Token 全部失效。
- **单进程独占与故障处理**：单进程独占一个 `DATA_DIR`。遇到文件损坏或格式非法时服务会明确报错，绝不通过静默删除损坏数据来恢复空态；须停止服务后通过有效备份离线恢复。

## 技能目录与默认开关 {#skill-directories}

服务端统一发现三类标准 `SKILL.md` 技能：实例自有目录 `DATA_DIR/assets/skills/`、随服务端发布的内置技能，以及运行服务端用户的 `~/.agents/skills/` 通用目录。这里的家目录属于服务端运行用户；容器部署需要将所需共享目录挂载到该用户可读的位置。

同名时按“实例自有 > 内置自有 > 通用”选择，清单标明来源和当前启用状态；优先项关闭时，不会自动改用低优先级的同名技能。默认开关分来源：内置技能按随服务端发布的 `assets/skills-defaults.json` 清单（当前 9 项全部默认开启，可随版本逐项调整）；通用技能与实例自建技能一律默认关闭，只有用户手动保存的选择才生效。新增或发现的通用/自建技能不会自动启用，关闭技能不会进入本轮技能装配。手动保存的选择始终优先于默认值；来源身份随选择保存，新来源不会继承另一来源的开关。

通用目录只读，Pi Muse 不复制、修改这些技能，也不在其中生成私有配置。标准技能不需要附加 `config.json`；旧技能配置文件不被改写，也不再用来默认开启技能。按名称保存的旧选择不生效。请在助手技能页重新选择。服务端提供统一清单、正文详情和启用保存接口，具体字段与错误以当前 `/docs` 为准；这不代表旧客户端已经支持来源分组展示。

在「设置 → 助手技能」使用开关选择各聊天会话可用的技能，修改后点击「保存技能」。点击技能名称可展开来源与说明。共享技能来自服务端共享目录，文件只读，默认关闭。

开关修改后点击「保存技能」，下一轮对话生效；保存按技能来源身份绑定。目录刷新遇到同名新来源时，旧草稿和旧正文不会套给新来源，需要按当前清单重新选择。尚未包含这些客户端改动的旧 APK 仍可使用其已有清单和开关入口，但不一定显示来源与正文。

通用目录支持常见的技能文件夹入口链接，按真实技能根读取；技能内部链接、越界文件与超限正文会进入诊断而不会加载。共享技能中的脚本和 `extension.ts` 不会执行，启用技能也不会放开 bash、安装依赖或增加原有工具权限。普通 `read` 只获得已启用技能的精确说明与受支持文本资源，不获得整个家目录的访问权限。

以上 `SKILL.md` 技能与全局开关只作用于主聊天和专题聊天会话；短信、新闻及后续领域 Agent 不会注入任何聊天技能，只依赖各自领域的提示词、独立规则板与自学习画像运行。

## 文件写入审批 {#file-write-approvals}

- `write` / `edit` 只操作唯一 DATA_DIR/workspace/，每次修改仍需完整预览、人工审批与文件版本绑定；拒绝、过期、取消或版本变化不提交。路径越界与符号链接始终拒绝，模型没有 bash。
- 每次操作都需独立人工审批，审批载荷保留完整修改前后文本和文件版本；`edit` 的待替换文本必须唯一命中。
- 提交前重新检查路径安全与文件版本。文件在等待期间变化时，旧审批不能授权覆盖，需重新发起操作和审批。
- 拒绝、审批过期或运行取消均不会提交该次修改；服务重启会取消上一进程遗留的 pending 审批。审批有效期由登记时的 `expiresAt` 固定，提交前再次校验期限和取消状态。
- `skills` 工具参数为 `action=list|read|save`、`name`、可选 `file`（默认 `SKILL.md`）与 save 必填的完整 `content`。`name` 只能是小写字母、数字或单个连字符，最长 64 位；允许 `SKILL.md` 及 `references/`、`assets/` 下 `.md/.txt/.json/.csv/.yaml/.yml` 普通 UTF-8 文本，单文件最大 100KB。
- `skills.save` 只能在用户明确要求时使用，写入 `DATA_DIR/assets/skills/<name>`；同名内置或通用技能会创建实例自有覆盖，原来源文件不变，新来源仍需手动启用。保存资源前必须先保存合法实例 `SKILL.md`。审批预览为 `scope=skill`、path=`<name>/<file>`，同样绑定版本并在提交前复查路径、取消、过期与文件变化。
- 新建技能默认关闭，不创建或修改技能 `config.json`。通过助手技能开关手动启用后，新定义、参考与资产从下一轮模型装配生效；当前轮不会获得新技能指令或扩展能力。拒绝、过期、Stop 或等待期间文件变化均不落盘，结果未明不自动重发。
- 技能维护拒绝删除、目录操作、`config.json` 直接编辑、脚本/代码、二进制、嵌套 `SKILL.md`、绝对路径、穿越与符号链接。已启用技能的普通 `read` 只额外开放该技能的 `SKILL.md` 与受支持资源文本，不开放 ls/grep/find 或邻居文件；子代理仅继承父轮实际工具快照，角色只能收窄；技能写入仍逐次人工审批。
- 关闭 `tools.writable.enabled` 会移除 `write` / `edit` 并受控拒绝 `skills.save`，但保留 `skills.list/read`；工具展示策略不能跳过审批或开启被关闭的写入能力。

创建并使用技能：

1. 先在助手设置中手动启用 `skill-creator`，并确保服务端允许受审批保护的文件写入；未启用时模型没有技能维护工具。技能选择接口和正文详情可在服务端 `/docs` 查看，客户端入口依其实际版本。
2. 在聊天中明确说明需要创建或修改的技能，例如“创建一个 Linux 新闻筛选技能，优先关注内核和发行版更新”。
3. 查看该次技能文件修改的完整审批预览，确认目标路径与修改前后内容后批准，并核对实际写入回执；批准本身不代表保存已成功。
4. 手动启用新建的实例自有技能，并在下一轮对话使用。修改已经启用的同一来源技能也从下一轮重读；创建覆盖或批准保存本身不代表启用新来源。

## 工具展示策略 {#tool-presentation-policy}

展示配置影响自有 Web消费的实时流与历史投影，不禁用工具、不改变模型收到的完整结果，也不改写 pi JSONL。修改配置后重启服务生效；已有历史会按当前策略重新投影，没有第二套历史或在线迁移。文件操作审批是独立的安全流程，不因隐藏工具卡片而省略。

- `hidden`：实时流不发送该工具的整组 `TOOL_CALL_*`，历史不返回该调用及对应工具结果。只保留普通 user/assistant 文本。
- `summary`：使用原工具名和稳定 ID 展示现有卡片，参数统一为 `{}`，结果采用受控摘要。例如保存记忆只显示“已保存记忆”，不显示记忆原文；读文件只确认执行结束，不展示正文。
- 搜索摘要保留来源 URL/title，删除 snippet 和供应商诊断，去掉 URL query/fragment（依赖 query 的来源链接可能无法直达；需要原链接时由最终回答提供）。搜索失败使用合法 `{error}`，不会伪造成“找到 0 条来源”。
- 示例配置显式开启时间、天气、搜索、记忆、提醒摘要；**省略整个 presentation 时所有工具默认隐藏**。未知工具名/无效模式启动失败。可以为关闭的 Web/天气工具预先配置策略，但展示配置不能开启这些能力。
- 这是展示选择，不是信息保密边界：模型仍可在最终回答中引用原始结果；调用前“我先查一下”等普通 assistant 文本仍然流式展示。`summary` 仍然有卡片，不是完全静默。

如果希望聊天只显示助手文本，在现有 `tools` section 内加入：

~~~json
"presentation": {
  "default": "hidden",
  "overrides": {}
}
~~~

## 真实浏览器 {#real-browser}

浏览器域使用 `playwright-core` 驱动本机系统 Chrome，不下载浏览器，且固定以带 GUI 的真实窗口启动；不提供 headless 模式。Chrome 懒启动，profile 固定在 `DATA_DIR/runtime/browser/profile/`；服务端调试页 `/browser` 与 Agent 的 `navigate` / `snapshot` / `act` / `tab` 工具共享同一实例和持久登录态。服务关闭时会结束 WS 订阅并优雅关闭 Chrome。Docker 部署使用 Xvfb/X11、x11vnc、websockify 和 noVNC 提供完整真实窗口，而不是回退 headless；见 [浏览器 Docker 说明](browser-docker.md)。

`/browser` 不内置服务地址，会按当前访问地址调用相对 REST API，并使用同源的 `ws://` 或 `wss://` 连接帧流。因此本机地址、局域网 IP、域名和反向代理地址都可以直接访问；页面不通过 URL 参数自动登录，`accessKey`/`key` 查询参数会被直接移除，需手动输入 AccessKey。HTTPS 反代需要同时转发 `/ws/browser` 并保留 Upgrade 头。

Docker 容器内的完整远程桌面（noVNC）不再单独发布端口，而是由服务端同源代理：`POST /api/browser/desktop-ticket`（Bearer 鉴权）换取一次性 60 秒 ticket，用返回的 `launchPath` 打开 `/browser/desktop/launch?ticket=...`，服务端签发 HttpOnly 会话 cookie（1 小时有效）后重定向到 `/browser/desktop/vnc.html`。`GET /api/browser/status` 可随时查询浏览器开关与桌面可达性。HTTP 明文部署下桌面流量不加密，仅在可信网络使用。

默认只允许公网 HTTP(S)；需要访问本机测试页面时显式设置 `tools.browser.allowPrivateTargets: true`。该地址规则只是与 web 工具共享的基础实现，浏览器域不依赖 `web_fetch`。浏览器不向模型暴露任意 JavaScript evaluate，也不返回 cookie、localStorage 或密码值；外部页面标题、文本与元素名称都按不可信数据处理。

## 错误策略 {#error-policy}

- 配置文件是必需文件，不存在不会回退到环境变量。
- JSON 语法错误、未知字段、类型不合法、未知 `schemaVersion` 会启动失败。
- `model.baseUrl` 与 `model.id` 必须同时为空或同时配置。
- `model.baseUrl` 只接受无凭据、无 query、无 fragment 的 HTTP(S) URL。
- 非回环 `server.host` 推荐配置 `server.accessKey`；当前默认行为是 host 为 `0.0.0.0` 但留空 accessKey 时仅打印警告而非阻断。
- 服务不会自动创建或改写配置文件，避免启动路径意外覆盖用户手写配置。
- Web 请求默认只允许公网 HTTP(S)，阻断回环、私网、链路本地和保留地址；每个重定向都会重新校验。本机联调可显式设置 `tools.web.allowPrivateTargets: true`，不改变其余请求安全约束。

## 密钥与文件权限 {#keys-and-file-permissions}

`config.json` 可能同时包含模型 key 和工作区访问密钥：

- 不提交到 Git；`.pi-muse/` 已在 gitignore 中。
- 不截图、不在聊天中粘贴完整内容。
- 建议权限保持 `0600`。
- 服务端不会把 key 写入日志、返回客户端或写入 pi 会话文件。
- 备份配置文件时按敏感凭据同等保护。

## mock 配置 {#mock-configuration}

`pnpm dev:mock` 不读取 `.pi-muse/config.json`，也不调用真实模型。它在 `scripts/dev-mock.ts` 中显式构造隔离配置：

- 监听 `127.0.0.1:17891`
- 使用 fake provider
- 数据目录为 `.pi-muse/mock`

mock 的端口和目录不提供环境变量覆盖；确需调整时直接修改脚本中的显式配置对象。
