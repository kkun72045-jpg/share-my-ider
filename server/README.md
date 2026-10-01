# 本机令牌服务

运行环境：Node.js 22.12+。服务端仅使用 Node 内置模块，不需要 Web 框架。

在项目目录复制 `.env.example` 为 `.env`，填写 `DECART_API_KEY` 和 Chrome 已加载扩展的准确 `ALLOWED_EXTENSION_ID`，然后运行：

```powershell
node --env-file-if-exists=.env server/index.mjs
```

监听地址固定为 `127.0.0.1`，默认端口 `8787`。`PORT` 只改变端口。本地网页开发可显式设置 `DEV_ORIGIN=http://127.0.0.1:5173`；该值必须是完整且精确的 HTTP 本机来源。

## 可选个人远程接入

这是一组个人服务适配设置，尚未部署 HTTPS 服务，也未完成手机浏览器端到端或 iOS 签名验证。默认仍按上面的本机 Chrome 扩展模式运行。

1. 生成一个独立的随机访问令牌并填入 `BROKER_ACCESS_TOKEN`，不能使用 Decart 根密钥。令牌必须为 32–256 个字符；可接受字母、数字及 `._~+/-`，末尾可有 Base64 的 `=` 填充。推荐生成 32 个随机字节：

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

2. 在 `ALLOWED_EXTENSION_ORIGINS` 填入手机扩展实际请求的来源，多个值用英文逗号隔开，例如 `moz-extension://12345678-abcd-4321-bcde-123456789abc` 或 `safari-web-extension://ABCDEF01-2345-6789-ABCD-EF0123456789`。只接受这两种方案加 UUID 的精确来源，最多 20 个；拒绝网站来源、通配符、`null`、路径、端口和末尾斜杠。UUID 不是扩展商店 ID 或应用 bundle ID。配置额外来源却未配置访问令牌时，服务会拒绝启动。
3. 使用你自己管理的 HTTPS 反向代理，提供有效 TLS 证书，将请求转发到本机 broker。代理须保留 `Origin`、`Authorization`、请求方法和正文，并把上游 `Host` 改成 `127.0.0.1:8787`（自定义端口时相应替换）。broker 不信任 `X-Forwarded-Host` 等头来绕过 Host 校验；继续只绑定 loopback。不要把没有访问令牌的默认服务直接暴露到公网。不要记录 Authorization 或令牌响应。
4. 手机插件使用 HTTPS 服务地址和这枚个人访问令牌。该令牌只用于 broker 认证；上游 `X-API-KEY` 始终来自服务端 `DECART_API_KEY`。轮换访问令牌后重启服务。若浏览器发送不受支持的来源或 `null`，应先解决浏览器适配，不能放开来源校验。

本实现采用固定长度 SHA-256 摘要的 `timingSafeEqual` 比较，精确验证完整 `Bearer` 认证值。现有限额为每进程六次签发／分钟及单并发，不含多用户登录、按用户账单额度或服务部署；不能据此作为面向公众的共享凭证服务。

## 接口

`POST http://127.0.0.1:8787/api/token`

- 请求头：浏览器设置的 `Origin` 必须匹配配置；`Content-Type: application/json`。
- 配置 `BROKER_ACCESS_TOKEN` 后，必须加 `Authorization: Bearer <访问令牌>`，`Bearer` 大小写及令牌内容按精确值检查。
- 请求体：`{}`，最多 1024 字节。不允许用户指定模型、令牌期限或目标上游地址。
- 成功：HTTP 200，`{"apiKey":"ek_…","expiresAt":"ISO 8601 timestamp"}`。
- 错误：`{"error":{"code":"CODE","message":"safe message"}}`。
- 常见状态：401 访问令牌缺失或错误（`UNAUTHORIZED`）；403 来源或 Host 不允许；400/413/415 请求体不合规；429 限速或已有签发进行中；503 服务端尚未配置；502 上游不可用。
- 429 附带 `Retry-After` 秒数。成功及错误响应均禁止缓存。

`GET /health` 返回 HTTP 200 和七个布尔字段：`ok`、`configured`、`apiKeyConfigured`、`extensionConfigured`、`developmentOriginConfigured`、`brokerAuthConfigured`、`mobileOriginsConfigured`。配置访问令牌后，此接口同样要求 Bearer 认证。它不进行上游调用，不返回密钥、扩展 ID 或来源值。命令行可无 Origin 查询健康；浏览器携带的 Origin 仍需匹配来源。

浏览器 `OPTIONS` 预检不携带访问令牌，只在来源、路由和请求方法符合白名单时返回 204；允许请求头为 `Content-Type, Authorization`。它不返回配置状态或签发令牌，实际 GET／POST 仍需认证。

每个进程一分钟最多签发六次，只允许一次签发进行中。每枚令牌有效期 300 秒，权限绑定到请求的来源和 `lucy-vton-3.5`，实时会话最大时长设为 300 秒。会话限制由 Decart 执行；前端仍应主动停止摄像头并断开会话。

Origin 防护阻止其他网页调用；原生程序能够伪造 Origin，因此远程接入必须同时启用独立访问令牌。服务只面向你自己的扩展，不构成操作系统用户之间的隔离边界。

## 测试

```powershell
node --test server/index.test.mjs
```

20 项测试注入模拟 `fetch`，不读取真实密钥，不发起 Decart 请求，也不产生推理费用；覆盖默认模式、手机模式无认证拒绝、两种移动扩展来源、错误来源和 Host、CORS、密钥隔离、限速及并发。此结果不代表 HTTPS 代理或手机真机已验证。

## 官方接口核验

核验日期：2026-10-01。浏览器端依赖 `@decartai/sdk` 0.2.3，许可证 MIT。此服务器原创实现 HTTP broker，通过官方公开 HTTP 契约签发令牌。

- [SDK package.json：版本及许可证](https://github.com/DecartAI/sdk/blob/main/packages/sdk/package.json)
- [SDK MIT LICENSE](https://github.com/DecartAI/sdk/blob/main/packages/sdk/LICENSE)
- [tokens/client.ts：POST /v1/client/tokens、请求限制及 apiKey/expiresAt 响应](https://github.com/DecartAI/sdk/blob/main/packages/sdk/src/tokens/client.ts)
- [shared/request.ts：X-API-KEY 认证头](https://github.com/DecartAI/sdk/blob/main/packages/sdk/src/shared/request.ts)
- [create-client.ts：默认 https://api.decart.ai 服务地址](https://github.com/DecartAI/sdk/blob/main/packages/sdk/src/create-client.ts)
- [shared/model.ts：lucy-vton-3.5 官方实时模型](https://github.com/DecartAI/sdk/blob/main/packages/sdk/src/shared/model.ts)

官方 token 文档链接在核验时无法通过检索工具加载，因此契约以以上官方 SDK 源文件为依据。真实账户权限、额度以及浏览器实时连接需要配置密钥后由用户主动启动验证。
