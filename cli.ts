#!/usr/bin/env node
/**
 * CLI entry point for npx claude-code-wechat.
 * Dispatches to setup.ts functionality.
 */

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "setup") {
  // Re-run with setup.ts args
  process.argv = [process.argv[0], "setup.ts", ...args.slice(1)];
  await import("./setup.js");
} else {
  console.log(`claude-code-wechat v0.1.0

Usage:
  npx claude-code-wechat setup              扫码登录微信
  npx claude-code-wechat setup --allow-all  开启自动白名单
  npx claude-code-wechat setup --allow ID   添加白名单
  npx claude-code-wechat setup --list       查看白名单

启动 Channel:
  claude --dangerously-load-development-channels server:wechat

详细文档: https://github.com/LinekForge/claude-code-wechat`);
}

export {};
