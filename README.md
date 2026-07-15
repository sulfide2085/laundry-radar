# 深大洗烘雷达

深圳大学粤海校区洗衣房状态看板：实时查看洗衣机 / 烘干机占用情况，支持邮件提醒。

**在线使用：** [https://www.sulfide.xyz/xiyi](https://www.sulfide.xyz/xiyi)

---

## 功能

- 拉取粤海校区附近洗衣房目录，汇总各机位空闲 / 使用中 / 可预约状态
- 按楼栋、设备类型筛选；支持置顶常用设备
- 自动刷新（默认 5 分钟）
- 订阅单台设备：预计完成前约 3 分钟发邮件（可用来等空机，也可提醒自己收衣服）
- 夜间模式、移动端适配
- 洗衣房 `state=2` 显示为「暂停营业」

状态查询免登录，无需授权 token。

---

## 快速开始（本机）

需要 Node.js ≥ 18。

```powershell
cd laundry-radar
npm start
```

浏览器打开：

```text
http://127.0.0.1:8787
```

或：

```powershell
.\start-server.ps1
```

---

## 邮件提醒

页面右下角「设置」填写收信邮箱；设备卡片出现铃铛后可订阅。

服务端默认读取项目根目录 `config.yaml`（**不要提交真实密码**，该文件已在 `.gitignore`）：

```yaml
email:
  enabled: true
  sender_name: "洗烘雷达"
  sender: "notice@example.com"
  smtp_host: "smtp.example.com"
  smtp_port: 465
  smtp_security: "ssl"
  username: "notice@example.com"
  password: "replace_me"
```

可复制 `config.example.yaml` 为 `config.yaml` 再改。也可用环境变量覆盖，例如：

- `EMAIL_SMTP_HOST` / `EMAIL_SMTP_PORT` / `EMAIL_SMTP_SECURITY`
- `EMAIL_USERNAME` / `EMAIL_PASSWORD`
- `EMAIL_SENDER` / `EMAIL_SENDER_NAME` / `EMAIL_ENABLED`
- `REMINDER_LEAD_MINUTES`（默认 `3`）

每个浏览器的收信邮箱保存在 `localStorage`；服务端只在 `data/settings.json`（可用 `DATA_DIR` 改路径）保存按浏览器身份隔离的提醒记录。

---

## Docker

```powershell
docker build -t laundry-radar:latest .
docker run --rm -p 8787:8787 `
  -v ${PWD}\config.yaml:/app/config.yaml:ro `
  -v ${PWD}\data:/app/data `
  laundry-radar:latest
```

Compose：

```powershell
docker compose up -d
```

默认 `compose.yml` 只绑定 `127.0.0.1:8787`，避免直接暴露公网。前面可挂反向代理（如 Caddy）。

---

## Cloudflare Workers

本仓库同时提供 `worker.mjs`，可部署到 Workers（静态资源走 Assets，设置数据走 KV，订阅检查用 Cron 每分钟触发）。

```powershell
# 安装 wrangler 后
wrangler deploy
```

**敏感配置请用 Secret，不要写进仓库：**

```powershell
wrangler secret put EMAIL_PASSWORD
wrangler secret put EMAIL_USERNAME
wrangler secret put EMAIL_SENDER
wrangler secret put EMAIL_SMTP_HOST
```

`wrangler.jsonc` 里只保留非敏感 `vars`（校区坐标、提醒提前量等）。SMTP 密码务必 `secret put`，勿写入 `vars` 或提交 `config.yaml`。

可选本地调试：创建已忽略的 `.dev.vars`，写入与 Secret 同名的键值。

---

## 接口说明

服务端代理上游：

```text
POST https://yshz-user.haier-ioc.com/position/nearPosition
POST https://yshz-user.haier-ioc.com/position/deviceDetailPage
```

默认校区参数（可用环境变量覆盖）：

| 变量 | 默认 |
| --- | --- |
| `CAMPUS_LNG` | `113.936759` |
| `CAMPUS_LAT` | `22.532761` |
| `CAMPUS_ORGANIZATION_ID` | `2000009571` |

本机 HTTP 服务默认 `HOST=0.0.0.0`、`PORT=8787`。

---

## 目录结构

```text
.
├── public/           # 前端页面
├── server.mjs        # Node 本机 / Docker 服务
├── worker.mjs        # Cloudflare Workers 入口
├── wrangler.jsonc    # Workers 配置（无密钥）
├── config.example.yaml
├── compose.yml
└── Dockerfile
```

---

## 隐私与安全

- 勿提交 `config.yaml`、`data/`、`.dev.vars`、`.wrangler/`
- 公开仓库中不应出现真实 SMTP 密码、授权码、私人邮箱
- 线上发信账号与密码仅通过环境变量 / Workers Secret / 服务器本地挂载配置注入

---

## License

Private-use friendly campus utility. Use at your own risk; upstream laundry APIs belong to their respective operators.
