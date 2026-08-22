# Delos

[English](README.md)

**一个跑在你自己机器上的个人 AI runtime：模型可以换，界面可以换，记忆可以换，但“这个助手是谁”不必跟着重来。**

Delos 想解决的不是“再做一个聊天机器人”，而是一个更烦人的长期问题：当你换模型、换供应商、换界面、换电脑时，为什么总要把整个个人 AI 重新搭一遍？

它把这些部分拆开，让它们通过稳定边界连接：

| 你遇到的问题 | Delos 用什么解决 | 这意味着什么 |
| --- | --- | --- |
| 换模型就像换了一个助手 | **Provider profiles** | OpenAI、Anthropic、兼容 API、本地模型或 delegated provider 可以替换，persona 不必跟着变 |
| Persona 被写死在代码里 | **Plain-file persona + persona packs** | 身份和说话方式是可读、可编辑、可迁移的内容 |
| CLI、网页、Telegram 各自长出一套状态 | **One runtime, multiple surfaces** | 不同入口共享同一套 turn、transcript 与配置边界 |
| 对话结束后什么都忘了 | **本地 transcript + 可选 Mnemosyne** | 短期连续性由 Delos 保存；需要长期受治理记忆时再接 Mnemosyne |
| API key 到处散落 | **Secret references** | 配置文件保存“去哪里取 secret”，而不是保存 secret 本身 |
| 系统坏了不知道哪里坏 | **Backup / restore / doctor** | 状态可以备份、恢复并做一致性检查 |

Delos 本身不运营云服务、账号、订阅或 telemetry backend。你选择什么模型、数据放在哪里、是否启用长期记忆，都由运行它的 host 决定。

Delos 这个名字来自希腊神话中的提洛岛：它是一个承载诞生的地方，而不是替诞生于此的人规定身份。

**Delos is where they are born, not who they must become.**

仓库附带的示例 persona 叫 **Arti**。她只是默认示例，不是产品身份；你可以完全替换她，而不需要改 runtime 架构。 <!-- scan-allow-persona -->

## 5 分钟跑起来

需要 **Node.js 22.22 或更新版本**。

```bash
npm install
npm run build

cp delos.config.example.json delos.config.json
# 编辑 delos.config.json，选择 provider 和 model

# 只有当你的 provider profile 引用了这个环境变量时才需要
export DELOS_MODEL_API_KEY="your-key-here"

# 发一句话，打印回复后退出
npm run start -- --once "Hello."

# 进入交互式对话
npm run start
```

交互式会话里：

- `/exit` 或 `/quit`：退出；
- `/clear`：归档当前 CLI conversation，开启一个新的；
- 正常完成的 turn 会保存在本地，同一配置/provider scope 下重启后仍可继续；
- `--once` 是隔离的一次性调用，不会混入交互式连续性。

## 它内部怎么拼起来

```text
CLI / Web / Desktop / Telegram
              │
              ▼
        Delos runtime
   ┌──────────┼──────────┐
   ▼          ▼          ▼
Persona    Provider   Transcript
 files      adapter      store
   │          │          │
   └──────────┴──────┬───┘
                     ▼
             optional Mnemosyne
```

这里最重要的不是图本身，而是**这些块可以独立替换**。换 provider 不该迁移 persona；换 surface 不该复制 transcript；启用 Mnemosyne 不该改变 system/persona authority。

施工或扩展时，请把 [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) 当作规范合同，而不是 README 的补充读物。

## 模型与 Provider

Delos 支持官方 OpenAI / Anthropic 协议、OpenAI-compatible relay 或本地服务器，以及 delegated local provider tools。

Provider profile 只描述“怎么连接模型”，不保存 credential 本身。

- [Providers](docs/PROVIDERS.md)：各类 provider 的协议与行为；
- [Provider profiles](docs/PROVIDER-PROFILES.md)：配置示例；
- [Secrets](docs/SECRETS.md)：credential 怎样保存和引用。

## Persona：助手是谁，不该由代码决定

默认身份文件很普通：

```text
prompts/
├── identity.md
├── relationship.md
└── response-style.md
```

这正是设计目标。你应该能直接读懂、修改和替换它们。

如果需要一整套可携带的 persona（manifest、variants、contextual activation rules），看 [Persona packs](docs/PERSONA-PACKS.md)。

## 长期记忆：需要时再接 Mnemosyne

Delos 自己负责 runtime 与本地 conversation continuity；长期受治理记忆由独立项目 [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne) 提供，并且**默认关闭**。

```bash
npm install github:Gwendolenmave/mnemosyne

export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

如果你明确启用了 Mnemosyne，但它无法正确接入，Delos 会在启动时 fail closed，而不是假装“记忆已开启”。召回到的 memory 只是受限的 host data，不会变成 system/persona authority。

完整边界见 [Memory integration](docs/MEMORY.md)。

## 多个入口，但只有一个 Delos

CLI、浏览器 UI、desktop shell、Telegram surface 都是同一个 runtime 的入口，而不是四套独立助手。

- [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md)：daemon 与本地应用怎样连接；
- [Surface API](docs/SURFACE-API.md)：稳定的本地 integration API；
- [Desktop, Telegram, and delegated providers](docs/SURFACES-BEYOND-THE-BROWSER.md)：其他入口和 delegated provider。

## 隐私与本地所有权

Delos 自己不会把数据发送到一个“Delos 云”。网络流量取决于你选择的模型路径：

- 远程 provider 会收到完成这一 turn 所需的 prompt、选中的 conversation/context；
- 本地模型可以把模型流量留在本机；
- credential 不应写进 Delos JSON 配置；
- transcript、本地状态、persona 数据和可选 Mnemosyne 数据库都留在 host 的存储边界内。

备份、恢复与健康检查见 [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md)。

## 文档导航

| 文档 | 解决什么问题 |
| --- | --- |
| [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) | 给施工机/维护者看的依赖、所有权、禁止越界规则 |
| [Providers](docs/PROVIDERS.md) | 选 provider 时看协议和能力 |
| [Provider profiles](docs/PROVIDER-PROFILES.md) | 写 provider 配置 |
| [Secrets](docs/SECRETS.md) | 安全处理 credential |
| [Memory integration](docs/MEMORY.md) | 把 Mnemosyne 接进 Delos |
| [Persona packs](docs/PERSONA-PACKS.md) | 创建或迁移 persona |
| [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md) | 备份、恢复、排障 |
| [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md) | 理解 daemon 与本地 app |
| [Surface API](docs/SURFACE-API.md) | 接新的本地 surface |
| [Licensing notes](docs/LICENSING.md) | 通俗理解许可证边界 |

## 许可证与维护

Delos 使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)，属于 source-available、非商业许可。正式条款以 [LICENSE.md](LICENSE.md) 为准；通俗说明见 [Licensing notes](docs/LICENSING.md)。商业使用需要另行取得许可。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。

项目采用封闭维护模式，目前不接受实质性的外部代码贡献；Bug report 仍然欢迎，见 [Contributing](CONTRIBUTING.md)。
