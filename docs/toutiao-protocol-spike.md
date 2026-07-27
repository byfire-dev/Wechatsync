# 头条协议 Spike 与自有适配器边界

## 目标

本次改动为头条闭环建立一个可维护的自有协议层，并恢复“识别当前账号、保存文章到草稿箱、返回稳定草稿 ID/地址”的最小能力。

它不实现发布状态核验，也不向 VibeMarket 暴露新的头条在线核验能力。草稿列表与已发布列表接口只作为后续研究入口保留，必须取得脱敏响应样本并验证账号绑定语义后才能接入生产路径。

## 已验证事实

本 Spike 使用了四类证据：

1. 当前登录态下，`https://mp.toutiao.com/profile_v4/graphic/publish` 可以打开头条图文编辑器。
2. 已安装的 Wechatsync `2.0.9` 构建中，头条适配器使用以下协议：
   - 账号：`GET /mp/agw/media/get_media_info`
   - CSRF：`HEAD /ttwid/check/`
   - 图片：`POST /spice/image`
   - 草稿：`POST /mp/agw/article/publish?source=mp&type=article&aid=1231`
3. 上游仓库历史实现也使用 `get_media_info` 和 `article/publish`，说明协议来源不是本次凭空推断。
4. `get_media_info` 与 `user_login_status_api` 的真实响应是 `HTTP 200`、`Content-Type: text/plain; charset=utf-8`，正文为 JSON。生产探测因此以有界 JSON 解析和严格业务结构为准，MIME 只在正文无法解析时用于错误分类。

本 PR 没有把历史实现中的原始响应日志和任意 URL 页面转发能力带入新实现。

## 生产适配器支持的固定操作

| 操作     | 固定目标                        | 输出                               |
| -------- | ------------------------------- | ---------------------------------- |
| 账号识别 | `TOUTIAO_ENDPOINTS.account`     | `userId`、用户名、头像             |
| 保存草稿 | `TOUTIAO_ENDPOINTS.saveDraft`   | 字符串 `pgcId`、规范化草稿地址     |
| 图片上传 | `TOUTIAO_ENDPOINTS.uploadImage` | HTTPS 图片地址、平台图片 URI、尺寸 |

保存草稿必须在 `https://mp.toutiao.com` 的主页面上下文中执行。执行函数会再次校验页面 origin 和固定 endpoint，不接受外部消息传入的 URL、请求头、Cookie 或 token。

## ID 与响应规则

- 账号 ID 和 `pgc_id` 在扩展边界内统一表示为十进制字符串。
- 字符串 ID 必须匹配 1～32 位正十进制整数。
- 数字 ID 只有在 `Number.isSafeInteger` 为真时才允许转换。
- 对 19 位数字形式的账号 ID 和 `pgc_id`，解析器会在 `JSON.parse` 前保留所有超出安全整数范围的数字词法值，再只读取精确的 `data.user.id` 或 `data.pgc_id` 路径。
- HTTP 错误、非 JSON、超大响应、未知结构、平台拒绝均不得推断为成功。
- 平台原始错误正文不写日志，也不直接返回给调用方。

## 已关闭的风险入口

旧的 `src/content/toutiao.ts` 接受 `TOUTIAO_PAGE_FETCH` 消息中的任意 URL 和请求参数。新适配器不依赖该入口，因此本 PR 删除对应 content script 及 manifest 注册。

头条公开自有适配器优先于 `private/` 中同 ID 的实现，避免私有子模块存在时静默覆盖本次安全边界；其他平台仍保持原有的私有适配器覆盖语义。

旧版 `$syncer.addTask`、`magicCall/uploadImage` 等写操作只接受顶层 `http://localhost` 页面调用。content script 会校验同窗口消息、精确 origin 和顶层 frame，background 再以 Chrome 提供的 `MessageSender` 做第二次校验；扩展自身页面仍可走原生内部路径。只读的旧版 `getAccounts` 兼容行为保持不变。

图片下载只允许无凭据、无重定向的公开 HTTP(S) 图片或受限的 base64 图片。适配器会拒绝本机、内网、链路本地、保留地址、非默认端口、非图片 MIME 和超过 10MB 的图片，避免扩展的全域网络权限被文章内容用作内网读取通道。任一需要上传的图片失败时，本次头条草稿保存整体失败，不会保留原远程地址后继续报告成功；图片处理日志也不记录完整源地址或结果地址。

浏览器侧仅能基于 URL 字面值做同步拦截，无法可靠证明公网域名在整个请求期间不会经 DNS 解析到私网。当前风险通过可信 VibeMarket 调用 origin、禁止重定向和目标字面值校验共同收敛；若未来允许不受信任内容源直接投递图片，应把图片抓取迁移到具备 DNS/IP 出口策略的后端代理。

## 本期明确不做

- 不实现 `inspectPublication`
- 不启用头条 `publication_inspection` 桥接能力
- 不调用草稿列表或发布列表；登录状态接口只在账号接口缺少身份时做只读消歧，不作为账号身份来源
- 不支持直接发布；`draftOnly: false` 会在发出网络请求前失败
- 不自动修改、重投或发布文章

## 手工验收清单

1. 构建并重新加载扩展。
2. 保持头条创作中心已登录。
3. 从 VibeMarket 向头条投递一篇无敏感内容的测试文章。
4. 确认扩展结果包含字符串 `postId`，且草稿地址形如：
   `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=<postId>`。
5. 打开草稿地址，确认标题、正文和图片与投递内容一致。
6. 确认文章只进入草稿箱，没有直接发布。
7. 在未登录、平台拒绝和非头条标签页场景下，确认系统返回明确失败且不产生伪造草稿 ID。

完成以上验收并采集脱敏的草稿列表响应 fixture 后，再进入头条在线核验 PR。
