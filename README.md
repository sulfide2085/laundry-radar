# 洗烘雷达

本地私有小工具，用来展示深圳大学粤海校区洗衣房的全部设备占用情况。

## Cloudflare

已部署 Workers：

```text
https://laundry-radar.sulfide2085.workers.dev
```

重新部署：

```powershell
wrangler deploy
```

SMTP 密码用密钥保存（勿写入仓库）：

```powershell
wrangler secret put EMAIL_PASSWORD
```

订阅检查用 Cron（每分钟）触发；设置数据存在 KV `SETTINGS`。

## 运行

```powershell
cd D:\pyitme\laundry-radar
npm start
```

然后打开：

```text
http://127.0.0.1:8787
```

也可以直接运行：

```powershell
.\start-server.ps1
```

状态查询免登录可用，不需要配置授权 token。服务端会先通过附近洗衣房接口拉取粤海校区洗衣房目录，再逐个查询各品类设备状态；洗衣房 `state=2` 会在页面显示为“暂停营业”。

## 邮件提醒

页面右下角打开“设置”，填写自己的邮箱。设备卡片上出现铃铛按钮时可以订阅这台设备，服务器会在预计完成前 3 分钟发一封邮件；这既可以用来等上一位洗完，也可以提醒自己来收衣服。

服务器默认读取项目根目录的 `config.yaml`：

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

本机这份 `config.yaml` 已经从 `tg-giveaway-radar` 复制过来。部署到云服务器时，把 `config.yaml` 一起放到项目根目录；Compose 会把它挂载到容器里的 `/app/config.yaml`。每个浏览器的收信邮箱保存在各自的 `localStorage`，服务端只在 `data/settings.json` 保存按浏览器身份隔离的提醒记录，可用 `DATA_DIR` 改到其他目录。

## Docker

构建镜像：

```powershell
docker build -t laundry-radar:latest .
```

运行容器：

```powershell
docker run --rm -p 8787:8787 -v ${PWD}\config.yaml:/app/config.yaml:ro -v ${PWD}\data:/app/data laundry-radar:latest
```

然后打开：

```text
http://127.0.0.1:8787
```

使用 Compose 部署时可以直接启动：

```powershell
docker compose up -d
```

默认 `compose.yml` 只绑定服务器本机 `127.0.0.1:8787`，避免服务直接暴露到公网。

## 接口

服务端代理请求：

```text
POST https://yshz-user.haier-ioc.com/position/nearPosition
POST https://yshz-user.haier-ioc.com/position/deviceDetailPage
```

默认校区坐标和组织：

- `CAMPUS_LNG=113.936759`
- `CAMPUS_LAT=22.532761`
- `CAMPUS_ORGANIZATION_ID=2000009571`
