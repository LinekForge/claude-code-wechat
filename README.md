# Claude Code WeChat Channel

让 Claude Code 住进你的微信——收消息、发文件、定时问好、远程审批，像一个真正在的人。

基于微信官方 ClawBot ilink API + Anthropic 官方 [Channels 协议](https://code.claude.com/docs/en/channels-reference)。不使用逆向工程，不模拟协议，不封号。

> 本项目为社区独立作品，与 Anthropic 和腾讯无关。ilink 协议参考自 `@tencent-weixin/openclaw-weixin` 公开源码，Channels 协议遵循 Anthropic 官方文档。仅供学习和个人使用。

## 它能做什么

收发文字和图片，接收文件、视频、语音，发送文件和语音，显示引用消息。

你不在电脑前的时候，它通过微信告诉你"我想执行这个操作，批准吗？"——你回复 `yes` 或 `no` 就行。

你可以让它每天定时给你发消息——早安、午间、晚安，时间点随机，不机械。正在聊天的时候它不会多发。

重启不丢上下文——最近 200 条微信对话自动回放，它记得你们聊过什么。

## 快速开始

你需要 [Bun](https://bun.sh)、[Claude Code](https://code.claude.com) >= 2.1.81、微信 iOS 最新版（需支持 ClawBot 插件）。ffmpeg + ffprobe 可选（用于视频帧提取）。

**0. 在微信中启用 ClawBot**

iOS 微信更新到最新版，进入"我 → 设置 → 插件"，找到 ClawBot 并启用。目前仅 iOS 支持。

**1. 安装 + 扫码登录**

```bash
npx claude-code-wechat setup
```

一行搞定：安装、显示二维码、微信扫码确认。

> 也可以从源码安装：`git clone https://github.com/LinekForge/claude-code-wechat.git && cd claude-code-wechat && bun install`，然后 `bun setup.ts`。

终端出二维码，微信扫，确认。凭据存到 `~/.claude/channels/wechat/account.json`。

**3. 设置白名单**

第一次用，开自动添加——下一个给 ClawBot 发消息的人自动进白名单：

```bash
bun setup.ts --allow-all
```

> 也可以手动加：`bun setup.ts --allow <sender_id> <昵称>`。不在白名单的消息静默丢弃，防 prompt injection。

**4. 注册 MCP Server**

在 Claude Code 的 MCP 配置中添加 wechat server。配置文件位置为 `~/.claude.json`（全局 `mcpServers` 字段）：

```json
{
  "wechat": {
    "command": "/path/to/bun",
    "args": ["/absolute/path/to/claude-code-wechat/wechat-channel.ts"]
  }
}
```

用绝对路径。`which bun` 查 bun 在哪。

> `--dangerously-load-development-channels server:wechat` 中的 `wechat` 需要和配置里的 server name 一致。

**5. 启动**

```bash
claude --dangerously-load-development-channels server:wechat
```

> `--dangerously-load-development-channels` 是 research preview 阶段测试自定义 Channel 的官方方式。名字里的 "dangerously" 指的是安全提醒（未审核的插件可能有 prompt injection 风险），不是违反使用条款。

打开微信，找到 ClawBot，发条消息。终端里会显示，Claude 会回复到微信。

## 架构

```
wechat-channel.ts  ← 主入口：MCP Server + 工具 + 轮询
├── types.ts       ← 接口和常量
├── config.ts      ← 路径、CDN、超时、日志
├── allowlist.ts   ← 白名单管理
├── ilink-api.ts   ← ilink HTTP 调用层
├── media.ts       ← 媒体加解密、CDN 上传下载、语音合成
├── chat-log.ts    ← 聊天记录持久化和回放
└── heartbeat.ts   ← 心跳调度和热加载

setup.ts           ← 独立 CLI：扫码登录 + 白名单管理
```

## 工具

Claude Code 通过这些 MCP 工具和微信交互：

| 工具 | 做什么 |
|------|--------|
| `wechat_reply` | 发文字到微信 |
| `wechat_send_file` | 发文件/图片/视频——本地路径或 HTTPS URL 都行 |
| `wechat_send_voice` | TTS 合成语音，以 mp3 文件发到微信 |
| `wechat_reload_heartbeat` | 手动刷新心跳配置 |

> 语音功能（`wechat_send_voice`）需要自备 TTS 脚本，放到 `~/.claude/scripts/minimax-voice.sh`。脚本接受两个参数：`(text, output_path)`。不配置则语音发送不可用，其他功能不受影响。

## 配置

### 白名单

```bash
bun setup.ts --allow <id> [昵称]   # 添加
bun setup.ts --nick <id> <昵称>    # 改昵称
bun setup.ts --list                # 查看
bun setup.ts --allow-all           # 自动添加下一个
```

### 心跳

复制示例配置：

```bash
cp heartbeat-config.example.json ~/.claude/channels/wechat/heartbeat-config.json
```

```json
{
  "fixed": [
    { "hour": 9, "minute": 0, "label": "morning" },
    { "hour": 22, "minute": 0, "label": "night" }
  ],
  "random": {
    "active_start": 9,
    "active_end": 22,
    "daily_count": 10,
    "min_per_hour": 1
  }
}
```

`fixed` 是定点触发，`random` 在活跃时段内随机分配。每天零点自动重新生成时间表。

改了配置不用重启——热加载，fs.watch 监听目录变化，MD5 哈希去重。

## 权限远程审批

Claude 想执行需要权限的操作时（写文件、跑命令），审批请求自动发到你微信。回复 `yes <id>` 批准，`no <id>` 拒绝。终端弹框和微信同时有效，哪边先回复算哪边。

> 技术细节：实现为 [Permission Relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)，审批请求硬编码直发微信（不经过 Claude），避免弹框阻塞导致延迟。

## 媒体支持

**接收（微信 → Claude）**：文字、图片、文件、视频（自动 ffmpeg 抽帧）、语音（微信 ASR 转文字）、引用消息。媒体文件从微信 CDN 下载 + AES-128-ECB 解密，存到本地 `media/` 目录。

**发送（Claude → 微信）**：文字、图片、文件、视频、语音（TTS 合成 mp3）。发送时加密上传到微信 CDN。`wechat_send_file` 支持直接传 HTTPS URL，自动下载后上传。

## 会话管理

所有微信消息全量保存到 `chat_history.jsonl`。重启时回放最近 200 条，Claude 知道你们之前聊了什么。回放里标注哪些是"上一个实例"说的，哪些是你说的，让 Claude 分得清历史和当下。

## 安全

- **白名单**：不在 allowlist 里的人发的消息静默丢弃，进不了 Claude 的上下文
- **凭据保护**：account.json 等文件权限 0o600
- **消息不加密**：所有消息经过腾讯 ilink API 服务器，不是端到端加密——不要通过这个通道发密码、token、密钥

## 已知限制

| 限制 | 原因 |
|------|------|
| `--resume` 不兼容 channel flag | Claude Code 限制，重启是新 session |
| 仅 iOS 支持 ClawBot | 微信灰度阶段 |
| 视频只能看关键帧 | Claude 不支持原生视频输入 |
| 语音发送是 mp3 文件不是语音条 | ilink API 不支持 bot 发语音条 |
| ilink API 可能变更 | 微信未承诺第三方兼容性 |

## 协议

本插件使用：
- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference) — Anthropic 官方 MCP Channel 协议
- 微信 ClawBot ilink API — 与 `@tencent-weixin/openclaw-weixin` 相同协议

不逆向、不模拟、不违规。

## License

MIT
