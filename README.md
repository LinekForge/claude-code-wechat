# Claude Code WeChat

> **⚠️ 本项目已全面合并到 [Forge Hub](https://github.com/LinekForge/forge-hub)，不再单独维护。**
>
> Forge Hub 在微信通道基础上新增了 Telegram、飞书、iMessage 多通道支持、多实例路由、远程审批、通道自愈等能力。推荐直接使用 Forge Hub。
>
> 感谢所有 star、issue、PR 的朋友们的支持，这个项目是 Forge Hub 的起点。🙏

---

用微信远程指挥 Claude Code。

你可以在微信里发消息，让电脑上的 Claude Code 继续改项目、回传结果、发送文件；遇到需要权限的操作时，也可以直接在微信里批准或拒绝。

- **消息** — 文字、图片、文件、视频、语音、引用，全支持
- **审批** — 不在电脑前？微信远程批准 Claude 的操作
- **心跳** — 每天定时发消息，时间随机，正在聊天时不打扰
- **记忆** — 重启自动回放最近 200 条对话，标注"上一个实例说的"和"你说的"，不混淆历史和当下
- **安全** — 白名单门控，未授权消息静默丢弃

## 适合谁

适合已经在用 Claude Code、但不想一直守在电脑前的人。

比如：

- 出门在外，用微信让 Claude Code 继续改项目
- Claude Code 需要权限时，直接在微信里批准或拒绝
- 临时想到一个需求，先发到微信，让电脑上的 Claude Code 接着干
- 睡前或路上查看进度，不用打开终端

## 它怎么工作

```text
微信 → ClawBot → claude-code-wechat → Claude Code
微信 ← ClawBot ← claude-code-wechat ← Claude Code
```

基于微信官方 ClawBot ilink API + Anthropic 官方 [Channels 协议](https://code.claude.com/docs/en/channels-reference)。不逆向，不模拟协议。

### 关于 npm / npx

旧版本曾支持：

```bash
npx claude-code-wechat setup
```

该路径已不再维护，也不代表最新产品代码。请全面采用本仓库的最新安装方式。

## 前置要求

- [Node.js](https://nodejs.org) >= 18 或 [Bun](https://bun.sh) >= 1.0
- [Claude Code](https://code.claude.com) >= 2.1.81（需 claude.ai 账号登录，不支持 API key）
- 微信 iOS 最新版（需支持 ClawBot 插件）
- ffmpeg + ffprobe（可选，视频帧提取）

## 快速开始

目标：让你在微信里发一句话，Claude Code 能收到并回复。

**1. 获取源码**

```bash
git clone https://github.com/LinekForge/claude-code-wechat.git
cd claude-code-wechat
bun install
```

**2. 扫码登录**

```bash
bun cli.ts setup
```

这一步需要你用微信扫描终端里的二维码，并在微信里确认。

**3. 生成 MCP 配置**

在你要使用 Claude Code 的项目目录里运行：

```bash
bun /path/to/claude-code-wechat/cli.ts install
```

如果你就在仓库目录里测试，也可以运行：

```bash
bun cli.ts install
```

**4. 检查状态**

```bash
bun /path/to/claude-code-wechat/cli.ts doctor
```

如果有检查项显示还没完成，按提示补一下即可。

**5. 启动**

```bash
claude --dangerously-load-development-channels server:wechat
```

**6. 第一次测试**

打开微信，找到 ClawBot，发一条：

```text
你好，收到吗？
```

如果 Claude Code 回复到了微信，说明连接成功。

## Agent 执行流程

如果你是 agent，按下面流程执行；遇到"需要用户"的步骤时停下，让用户完成后再继续。

**1. 获取源码并安装依赖**

```bash
git clone https://github.com/LinekForge/claude-code-wechat.git
cd claude-code-wechat
bun install
```

**2. 登录微信（需要用户扫码）**

```bash
bun cli.ts setup
```

需要用户用微信扫描终端里的二维码，并在微信里确认登录。

**3. 在目标项目目录安装 MCP 配置**

```bash
bun /absolute/path/to/claude-code-wechat/cli.ts install
```

这一步必须在用户要使用 Claude Code 的项目目录里运行。路径必须指向本仓库的 `cli.ts`。

**4. 检查本机状态**

```bash
bun /absolute/path/to/claude-code-wechat/cli.ts doctor
```

根据 `doctor` 输出继续处理：

| doctor 显示 | 下一步 |
|---|---|
| 微信登录还没完成 | 在仓库目录运行 `bun cli.ts setup`，让用户扫码 |
| 白名单为空 | 在仓库目录运行 `bun cli.ts setup --allow-all`，然后让用户从微信给 ClawBot 发一条消息 |
| Claude 配置还没安装 | 在目标项目目录运行 `bun /absolute/path/to/claude-code-wechat/cli.ts install` |
| ffmpeg/ffprobe 未安装 | 可跳过，只影响视频抽帧 |
| TTS 脚本未配置 | 可跳过，只影响语音发送 |

**5. 启动 channel**

```bash
claude --dangerously-load-development-channels server:wechat
```

这个命令会保持运行。启动后让用户在微信里给 ClawBot 发一条测试消息。

## 日常使用

你可以像这样在微信里发：

```text
帮我看看 forge-launcher 的最新问题，修好后跑一下测试。
```

Claude Code 会在电脑上继续工作。需要权限时，它会把审批请求发到微信；你看懂后回复 `yes <id>` 或 `no <id>` 即可。

<details>
<summary>白名单管理</summary>

首次使用时，第一个发消息的人自动加入白名单。也可以手动管理：

```bash
bun cli.ts setup --allow <id> <昵称>
bun cli.ts setup --list
```
</details>

## 项目结构

```
wechat-channel.ts  ← 主入口：MCP Server + 工具 + 轮询
├── types.ts       ← 接口和常量
├── config.ts      ← 路径、CDN、超时、日志
├── allowlist.ts   ← 白名单管理
├── ilink-api.ts   ← ilink HTTP 调用层
├── media.ts       ← 媒体加解密、CDN 上传下载
├── chat-log.ts    ← 聊天记录持久化和回放
└── heartbeat.ts   ← 心跳调度和热加载

setup.ts           ← 独立 CLI：扫码登录 + 白名单管理
```

## 媒体支持

**接收（微信 → Claude）**

| 类型 | 处理方式 |
|------|---------|
| 文字 | 直接转发 |
| 图片 | CDN 下载 + AES 解密，Claude 可查看 |
| 文件 | CDN 下载 + AES 解密，Claude 可读取 |
| 视频 | CDN 下载 + ffmpeg 抽帧，Claude 可查看关键帧 |
| 语音 | 微信 ASR 自动转文字 |
| 引用 | 显示被引用的原文 |

**发送（Claude → 微信）**

| 类型 | 使用方式 |
|------|---------|
| 文字 | `wechat_reply` 工具 |
| 图片/文件/视频 | `wechat_send_file` 工具，支持本地路径和 HTTPS URL |
| 语音 | `wechat_send_voice` 工具，TTS 合成 mp3 发送 |

> 语音功能需要自备 TTS 脚本（`~/.claude/scripts/minimax-voice.sh`），不配置则不可用，其他功能不受影响。

## 工具

| 工具 | 做什么 |
|------|--------|
| `wechat_reply` | 发文字到微信 |
| `wechat_send_file` | 发文件/图片/视频——本地路径或 HTTPS URL 都行 |
| `wechat_send_voice` | TTS 合成语音，以 mp3 发送 |
| `wechat_reload_heartbeat` | 手动刷新心跳配置 |

## 心跳配置

```bash
cp heartbeat-config.example.json ~/.claude/channels/wechat/heartbeat-config.json
```

```json
{
  "fixed": [{ "hour": 9, "minute": 0, "label": "morning" }],
  "random": { "active_start": 9, "active_end": 22, "daily_count": 10, "min_per_hour": 1 }
}
```

`fixed` 定点触发，`random` 随机分配。改了配置自动生效，不用重启。

## 权限远程审批

Claude 需要执行敏感操作时，审批请求自动发到微信。回复 `yes <id>` 批准，`no <id>` 拒绝。终端和微信同时有效，先到先得。

> 审批请求直发微信，不经过 Claude，速度快。

## 安全提醒

这个项目会把微信变成 Claude Code 的远程入口，请按个人工具来使用：

- 只把你信任的微信账号加入白名单
- `--allow-all` 只建议第一次调试时使用，用完会自动关闭
- 不要通过微信发送密码、token、密钥、验证码等敏感信息
- Claude Code 发来的权限审批，确认看懂后再回复 `yes <id>`
- 如果电脑不在自己控制的环境里，不建议长期运行

## 已知限制

| 限制 | 原因 |
|------|------|
| `--resume` 不兼容 channel flag | Claude Code 限制 |
| 仅 iOS 支持 ClawBot | 微信灰度阶段 |
| 视频只能看关键帧 | Claude 不支持原生视频输入 |
| 语音发送为 mp3 不是语音条 | ilink API 不支持 bot 发语音条 |
| ilink API 可能变更 | 微信未承诺第三方兼容性 |
| 消息经腾讯服务器 | 非端到端加密，不要通过此通道发送密码或密钥 |

## 协议

- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference) — Anthropic 官方 MCP Channel 协议
- 微信 ClawBot ilink API — 与 `@tencent-weixin/openclaw-weixin` 相同协议

> 本项目为社区独立作品，与 Anthropic 和腾讯无关。ilink 协议参考自 `@tencent-weixin/openclaw-weixin` 公开源码，Channels 协议遵循 Anthropic 官方文档。仅供学习和个人使用。

## 贡献者

- [@lightallspiritthing](https://github.com/lightallspiritthing) — 图片识别 Read tool 提示（[#1](https://github.com/LinekForge/claude-code-wechat/pull/1)）
- [@AmberCXX](https://github.com/AmberCXX) — allowlist 重复代码重构（[#2](https://github.com/LinekForge/claude-code-wechat/issues/2)）· TTS stderr 捕获（[#3](https://github.com/LinekForge/claude-code-wechat/issues/3)）

## License

MIT — Linek & Forge
