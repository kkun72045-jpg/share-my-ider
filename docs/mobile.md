# 手机验证说明

核验于 2026-10-01。本轮交付是共用 `panel.html` 的浏览器插件界面、可转换源包及个人远程凭证适配；**没有部署 HTTPS 服务，没有 iOS 签名安装包，也没有手机摄像头／Decart 端到端真机验证**。

`npm run build` 生成 `dist-mobile-firefox/` 与 `dist-mobile-safari/`。Firefox 包选择 142+ 作为基线，声明视频、认证信息和网页图片传输，遵循 [Firefox 内置数据同意机制](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)。两包均由 `action.default_popup` 调出，不含电脑专用侧边栏 API。点“选网页图片”后才读取当前页图片元数据。

Firefox Android 支持 [action popup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action) 与网页 [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。摄像头仍需授权，[popup 关闭会卸载页面](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups)；不能据此承诺持续试衣。开发测试：手机开启 USB 调试、连接 ADB，在 Firefox 构建目录运行 `web-ext run -t firefox-android`，按提示选设备和浏览器。[官方步骤](https://www.extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)

Safari iOS：在 Mac 运行 `xcrun safari-web-extension-packager <源包目录> --ios-only`（旧名 converter），处理兼容警告，在 Xcode 选择 Team、签名并 Run 到设备，再启用 Safari 扩展。[打包](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)、[签名](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)。也可用需开发者会员的 [App Store Connect 网页打包](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)。网页摄像头支持不等于 popup 可用；其授权、关闭和后台限制须真机验证。

[Decart](https://github.com/DecartAI/sdk) 使用 LiveKit；[LiveKit](https://docs.livekit.io/reference/client-sdk-js/#browser-support) 列有 Firefox Android／Safari iOS，不能替代本插件 SDK 兼容测试。

手机 `127.0.0.1` 指手机自身。须自行部署 HTTPS 代理，保留 Origin／Authorization，将上游 Host 改为 `127.0.0.1:8787`。在服务端设置随机 `BROKER_ACCESS_TOKEN` 和精确 `ALLOWED_EXTENSION_ORIGINS`；手机 GET `/health`、POST `/api/token` 均带 `Authorization: Bearer <访问令牌>`，POST 正文为 `{}`。根密钥只留服务端。详见[服务配置](../server/README.md)。这是个人认证与全局限流，尚无多用户登录／用户额度；禁止公网暴露默认无认证服务。接通后验授权、换衣、断网、关闭 popup 与后台摄像头释放，再确认账单会话结束。
