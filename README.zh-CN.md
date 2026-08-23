# Delos

[English](README.md)

**保留这个助手，替换底下的机器。**

Delos 是一个跑在本机的个人 AI runtime。它把最容易被绑死在一起的几样东西——**persona、模型访问、对话状态、界面和长期记忆**——拆开，让它们通过稳定边界连接。

这样做的意义很简单：你想换其中一块时，不必把整套助手重新搭一遍。换 provider，不必重写 persona；加 Telegram 或网页入口，不必再造第二个助手；换 persona，不必改 runtime 代码；长期记忆也可以等真正需要时再接。

Delos 本身不运营云服务、账号系统、订阅或 telemetry backend。模型走哪里、数据放哪里，都由运行它的人决定。

## 从这里开始

| 我想…… | 先看这里 |
| --- | --- |
| 在本机跑起来，直接聊几句 | [快速开始](#快速开始) |
| 换一个模型或 provider | [Providers](docs/PROVIDERS.md) + [Provider profiles](docs/PROVIDER-PROFILES.md) |
| 改“这个助手是谁” | [`prompts/`](prompts/) + [Persona packs](docs/PERSONA-PACKS.md) |
| 加长期受治理记忆 | [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne) + [Memory integration](docs/MEMORY.md) |
| 接一个新的界面 | [Surface API](docs/SURFACE-API.md) |
| 修改 Delos 本身 | **先读 [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md)** |
| 备份、恢复或排查本地状态 | [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md) |

## 快速开始

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

# 或进入交互式会话
npm run start
```

交互式会话会把完成的 turn 保存在本地，所以同一配置/provider scope 下重启后仍可继续。`/clear` 开一个新 conversation，`/exit` 和 `/quit` 退出；`--once` 不会混进交互式连续性。

## 一张图理解 Delos

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

重点不是盒子有几个，而是**盒子之间有边界**：

- **Persona 是内容。** 身份和回复风格放在可读文件里，而不是埋进 application code。
- **Provider 可以替换。** OpenAI、Anthropic、兼容 API、本地模型服务器和 delegated provider 都走 provider contract。
- **多个界面共享一个 runtime。** CLI、浏览器、desktop、Telegram 是同一个助手的不同入口，不是四个各自长状态的助手。
- **长期记忆是可选项。** Delos 自己可以运行；需要长期受治理记忆时，再接 [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne)。

## 最常见的几种改法

### 换模型，不换助手

Provider profile 只描述**怎么连接模型**；credential 不应该直接塞进普通配置文件。

想知道不同 provider 的协议行为，看 [Providers](docs/PROVIDERS.md)；想看配置例子，看 [Provider profiles](docs/PROVIDER-PROFILES.md)；credential 怎么放，看 [Secrets](docs/SECRETS.md)。

### 换助手，不换 runtime

默认 persona 就是普通文本文件：

```text
prompts/
├── identity.md
├── relationship.md
└── response-style.md
```

直接读、改、替换这些文件，就能改变助手。需要可携带 manifest、variant 或按场景激活的 persona 时，再看 [Persona packs](docs/PERSONA-PACKS.md)。

仓库也带了一个叫 **Arti** 的示例 persona。她只是默认例子，不是 Delos 的产品身份。 <!-- scan-allow-persona -->

### 真正需要时，再加长期记忆

Delos 负责 runtime 和本地 conversation continuity；Mnemosyne 是单独的长期记忆包，并且**默认关闭**。

```bash
npm install github:Gwendolenmave/mnemosyne

export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

如果你明确要求启用 Mnemosyne，但 Delos 无法正确接入，它会在启动时 fail closed，而不是假装“记忆已经开了”。召回到的 memory 仍然只是受限 host data，不会变成 system/persona authority。

完整边界见 [Memory integration](docs/MEMORY.md)。

### 加新界面，不再造一个助手

新的 surface 应该走共享 runtime 边界，而不是自己另建 transcript、provider registry、persona store 或 memory system。

接入合同看 [Surface API](docs/SURFACE-API.md)；daemon / browser 的关系看 [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md)；desktop、Telegram 和 delegated-provider 边界看 [Surfaces beyond the browser](docs/SURFACES-BEYOND-THE-BROWSER.md)。

## Local-first 的意思是：网络边界由你决定

Delos 不会把数据发到一个“Delos 云”。真正会不会出网，取决于你配置的 provider 路径。

- 远程 provider 会收到完成当前 turn 所需的 prompt 和选中 context，并按它自己的条款处理；
- 本地模型可以把模型流量留在本机；
- credential 不应写进普通 Delos JSON 配置；
- transcript、本地状态、persona 文件和可选 Mnemosyne 数据库都留在 host 的存储边界里。

## 如果你要改代码

README 是给人看的地图；[Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) 才是给施工机和维护者的规范合同。

最常用的下一步文档可以按任务找：

- **模型访问：** [Providers](docs/PROVIDERS.md)、[Provider profiles](docs/PROVIDER-PROFILES.md)、[Secrets](docs/SECRETS.md)
- **身份：** [Persona packs](docs/PERSONA-PACKS.md)
- **记忆：** [Memory integration](docs/MEMORY.md)
- **界面：** [Surface API](docs/SURFACE-API.md)、[Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md)
- **运维：** [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md)

如果实现和 Architecture 对不上，不要猜哪边“应该”是真的；直接检查当前代码和测试，再把过时的一边一起修掉。

## 为什么叫 Delos？

在希腊神话里，Delos 是一个承载诞生的地方。这个名字很适合它的设计目标：runtime 可以承载一个身份，但不替那个身份规定“你必须是谁”。

**Delos is where they are born, not who they must become.**

## 许可证与维护

Delos 使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)，属于 source-available、非商业许可；商业使用需要另行取得许可。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。

项目采用封闭维护模式，目前不接受实质性的外部代码贡献；Bug report 和负责任的安全报告仍然欢迎，见 [Contributing](CONTRIBUTING.md) 与 [Security](SECURITY.md)。
