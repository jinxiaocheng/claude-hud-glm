# claude-hud-glm (Fork)

> Fork 自 [Siiichenggg/claude-hud-glm](https://github.com/Siiichenggg/claude-hud-glm)

基于原版 claude-hud-glm 插件，增加了 **GLM Coding Plan 配额用量** 的实时显示。

## 效果预览

![Coding Plan 配额预览](coding-plan-preview.png)

状态栏会实时显示：
- **5h: 17% (3h 55m)** — 5小时滚动窗口 token 用量及重置倒计时
- **7d: 63%** — 每周 token 用量百分比

## 与原版的区别

| 特性 | 原版 | 本 Fork |
|------|------|---------|
| 用量数据来源 | Token 余额 API (`/api/biz/tokenAccounts/list/my`) | Coding Plan 配额 API (`/api/monitor/usage/quota/limit`) |
| 显示内容 | Token 包余额百分比 | 5小时窗口 + 每周额度用量 |
| 支持平台 | bigmodel.cn | bigmodel.cn + z.ai |
| 重置倒计时 | Token 过期时间 | 5小时窗口自动倒计时 |

## 工作原理

调用 GLM Coding Plan 的配额查询接口：

```
GET /api/monitor/usage/quota/limit
```

响应中的 `limits` 数组包含多个配额项，通过 `unit` 字段区分：

| unit | 含义 | 显示为 |
|------|------|--------|
| 3 | 5小时滚动窗口 token 用量 | `5h: XX%` |
| 6 | 每周 token 用量 | `7d: XX%` |
| 5 | MCP 工具月度用量 | （暂未显示） |

每个配额项还包含 `nextResetTime` 时间戳，用于计算重置倒计时。

## 安装

### 方式一：直接替换已安装插件

如果你已经通过原版插件市场安装了 `claude-hud-glm`，可以直接替换编译后的文件：

```bash
# 替换缓存版本（实际运行的文件）
cp dist/glm-usage-api.js ~/.claude/plugins/cache/claude-hud-glm/claude-hud-glm/*/dist/glm-usage-api.js
cp dist/render/lines/usage.js ~/.claude/plugins/cache/claude-hud-glm/claude-hud-glm/*/dist/render/lines/usage.js
```

替换后重启 Claude Code 即可生效。

### 方式二：从本仓库安装

```bash
# 克隆到本地
git clone https://github.com/jinxiaocheng/claude-hud-glm.git
cd claude-hud-glm

# 编译（需要 Node.js 环境）
npm install
npm run build
```

## 配置要求

在 `~/.claude/settings.json` 中需要配置以下环境变量：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的API密钥",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
  }
}
```

支持的 BASE_URL：
- `https://api.z.ai/api/anthropic`
- `https://open.bigmodel.cn/api/anthropic`

## 技术细节

- **缓存机制**: 文件缓存，成功结果 60 秒过期，失败结果 15 秒过期
- **认证方式**: Authorization header 直接使用 API token（不加 Bearer 前缀）
- **颜色编码**: 百分比会根据用量自动变色（低 → 绿，中 → 黄，高 → 红）

## 致谢

- 原版插件: [Siiichenggg/claude-hud-glm](https://github.com/Siiichenggg/claude-hud-glm)
- 配额 API 参考: [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins)
