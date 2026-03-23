# Claude Code WeChat

让 Claude Code 住进你的微信——收消息、发文件、定时问好、远程审批，像一个真正在的人。

- **消息** — 文字、图片、文件、视频、语音、引用，全支持
- **审批** — 不在电脑前？微信远程批准 Claude 的操作
- **心跳** — 每天定时发消息，时间随机，正在聊天时不打扰
- **记忆** — 重启自动回放最近 200 条对话，标注"上一个实例说的"和"你说的"，不混淆历史和当下
- **安全** — 白名单门控，未授权消息静默丢弃

基于微信官方 ClawBot ilink API + Anthropic 官方 [Channels 协议](https://code.claude.com/docs/en/channels-reference)。不逆向，不模拟协议。

## 快速开始

你需要 [Bun](https://bun.sh)、[Claude Code](https://code.claude.com) >= 2.1.81、微信 iOS 最新版（支持 ClawBot 插件）。

**1. 扫码登录**

```bash
npx claude-code-wechat setup
```

**2. 生成 MCP 配置**

```bash
npx claude-code-wechat install
```

**3. 启动**

```bash
claude --dangerously-load-development-channels server:wechat
```

打开微信，找到 ClawBot，发消息。终端里出现，Claude 回复自动发回微信。

<details>
<summary>从源码安装</summary>

```bash
git clone https://github.com/LinekForge/claude-code-wechat.git
cd claude-code-wechat
bun install
bun setup.ts
```
</details>

<details>
<summary>白名单管理</summary>

首次使用时，第一个发消息的人自动加入白名单。也可以手动管理：

```bash
npx claude-code-wechat setup --allow <id> <昵称>
npx claude-code-wechat setup --list
```
</details>

## 架构

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

## License

MIT — Linek & Forge
