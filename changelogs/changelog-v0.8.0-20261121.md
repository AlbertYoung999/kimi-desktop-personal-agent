# v0.8.0 开发记录(开始于 2026-11-21)

> 版本主题:**移动远程控制**——手机/手表访问桌面 session(prd/PRD-mobile-remote.md)。

## 需求与决策(对齐记录)

- 手机端形态:网页(PWA),不做 iOS 原生;手表 watchOS 原生(有真机,主视觉=kimi 头像动效);
- 语音高优先级:首选 Web Speech API(中英混合强),SenseVoice 离线兜底(实测见下);
- 远程:手机 Tailscale(tailnet 直连)/ 手表 Cloudflare **命名隧道**(quick tunnel 实测不支持 SSE)+ CF Access;
- 远程纪律:远程一律不许切 yolo;桥层不暴露 fs 读写;指令落 signals 审计;
- 传输:SSE+POST(不选 WebSocket——无依赖、iOS/watchOS 友好、穿隧道稳);
- 借鉴:talking-to-the-moon(协议/语音确认框/iOS 音频经验)、dsh-mobile(配对 UX、通道实测表、PWA 推送、慢链路工程)。

## 调研实测记录

- **moon bridge**:Python,零鉴权(yolo+RCE 大门)、不流式、单 session——协议借鉴,能力重写;
- **kimi 官方 `kimi web`**:bearer token + BYO TLS 反代,佐证「token + 隧道」是行业标准;
- **SenseVoice 实测**(FunASR,CPU):加载 1.5s,RTF≈0.1;纯中文近完美;中英混合/英文技术词明显短板(npm test→NTM chest、yolo 整词丢失)——定级为离线兜底,非主力;打包走 sherpa-onnx int8(260MB),模型拉取走 modelscope(国内 80s vs GitHub 25min+);
- **Apple Speech(macOS 原生)**:CLI 下被 TCC 卡死,需原生模块,备选;
- **dsh-mobile**:quick tunnel 不支持 SSE(必须命名隧道);Tailscale 区分 tailnet(✅)与 Funnel(❌);iOS PWA 网页推送(iOS 18.4+,锁屏可收,文案脱敏)。

## P1 Step1+2 · RemoteBridge(主进程)

- `src/main/remote-bridge.ts`:原生 node:http 零新依赖;配对(6 位码/5min/一次性,尝试限流)→ 长期 token(sha256 存储,可撤销);REST(tree/open-session/prompt/cancel/permission-respond,409 busy/423 held);SSE 会话+全局双通道(chunk/tool/turn-done/permission,25s 心跳);静态页服务(SPA 回退+路径穿越防护);端口冲突自动 +1;
- db:`remote_devices` 表;settings:`remoteEnabled`(默认开)/`remotePort`(默认 8922);
- agents 设置页「移动访问」区块:开关、局域网地址、配对码大字号+倒计时、设备列表+撤销;
- acp.ts:`addListener` 进程内事件扇出(SSE 事件源);
- 审计:prompt/权限/配对/撤销落 signals。

## P1 Step3 · 手机网页客户端

- `src/renderer/remote/`(手写 DOM):配对屏(数字键盘/自动提交/401 自清)→ 会话列表屏(项目折叠/状态点/下拉刷新/tree-changed 自动刷新)→ 对话屏(open-session 三分支/流式气泡/思考块/权限卡片+震动/停止);
- mdToHtml 抽成 `shared/md.ts` 共用(工厂零影响);
- PWA 化(standalone meta + apple-touch-icon);断线重连(指数退避+回前台 resync 重拉);
- iOS 适配:输入字号≥16px 防缩放、safe-area、overscroll-behavior。

## P1 灵魂注入轮(2026-11-21)

- **首页 kimi 头像主视觉**:CSS 拆件重绘蓝圆脸(眼睛独立可动)——待机呼吸+随机眨眼+眼睛跟随触摸(moon/悬浮球传统)、聆听脉冲环、思考弯月眼旋转光晕、说话声波条(AnalyserNode 频谱驱动,回退 CSS 假动画);星空背景+最近 session chips;
- **语音**:Web Speech API(zh-CN,连续+中间稿)浮层实时稿 → 可编辑确认弹窗(发送/重说/取消,moon 最好的设计);不支持时(HTTP)麦克风置灰 + HTTPS 指引卡(/ca.pem 下载 + iOS 安装/信任步骤 + 一键开 HTTPS 版);
- **TTS 回复**:piper 抽出 synthToFile 共用,新增 piperSynth→`POST /api/tts`(wav,截 2000 字,503 降级);turn-done 自动播报(串行队列、新 turn 打断)、karaoke 文字滚动(clip-path 进度)、顶栏喇叭开关;
- **HTTPS 双栈**:openssl 本地 CA + server 证书(wbRoot/remote-certs,SAN 含局域网 IP),HTTPS=HTTP+1(默认 8923),/ca.pem 免 token 下载,CA 指纹日志;
- /api/asr 占位 501(语音首选浏览器识别,服务端 ASR 留待 P1.5);
- 对话屏氛围:holo 玻璃卡片、顶栏迷你头像+状态点。

## P1 灵魂移植轮(2026-11-21,推翻自研视觉改原版移植)

- 用户否决自研首页(太丑),改为**忠实移植 talking-to-the-moon**:Three.js 月相渲染(天文算法真实月相,vendor three@0.160 断外网依赖)、星空/月晕/12 张背景轮播、result-card(折叠/展开/30s 自动隐藏)、TTS karaoke 原版滚动、语音确认弹窗、file-card 信件飞入动画(备用);
- 架构适配:WS→REST+SSE;单 session→左上角会话按钮+底部抽屉项目树;localStorage 历史→open-session 真实历史;补配对屏/权限审批卡/busy·held 提示;thought chunk 按氛围舍弃;
- 移动端:iOS WebGL 低电量模式 catch 降级;DPR 上限 2;贴图/背景图本地打包(LAN 无碍,隧道首屏会慢)。

## P1 优化轮(2026-11-21,真机反馈)

- 工具状态行归位:result-card 上缘一行小字(小字弱化,滚动更新,turn 结束隐藏);
- 「···」菜单 + **双界面模式**:月之暗面(moon 原版)⇄ 经典对话(悬浮窗 chat 结构),共享全部状态(消息/SSE/权限/TTS),切换不断线;语音播报开关与 HTTPS 指引收进菜单;
- 经典对话补**会话配置按钮**:权限(常规/Auto/Plan,远程禁 yolo——桥端 403 拦截且 setter 不执行)/ 预设(服务端注入 system prompt)/ 模型+思考深度(两段菜单,同桌面);配置每次开菜单强制重拉防不同步;
- **微信式输入**:空输入显语音钮、有字显发送钮、流式显停止钮;点语音进「按住说话」模式(长条+上滑取消+键盘切回,模式记忆);桥新增 GET/POST session-config、model-options、prompt modeId 注入。

## P1 架构修正轮(2026-11-22,一套代码对齐)

- **用户纠偏:手机=平权 channel,不重写**。工厂后端抽象:`ChatBackend` 接口(chat-backend.ts)+ `createElectronBackend` 桌面默认实现;工厂 29 处 window.kimi 全部改走 backend,宿主专属能力收进可选 `host`(captureRegion/setBallState/tts/onImagePasted 等,缺省隐藏或 no-op);悬浮窗/channel 零改动回归;
- **远程适配器**(backend-remote.ts):ChatBackend → 桥 REST+SSE 全量映射(含双通道事件 hub、lastLoad 缓存);host 提供 TTS 队列/getSettings/openExternal/imagePicker(相册选图);
- **经典对话整建制换装 createChatPanel**:手写 cv 实现退役,获得工厂全能力——per-session 队列三操作(编辑/直接发送/取消)、长按复制/引用、权限/预设/模型+思考菜单(**yolo 拦截同步撤销**,桥端恢复可选+审计标注 remote-yolo)、多图上传(≤10,桥 body 上限 50MB)、lightbox、per-session 草稿;
- 桥新增:POST /api/new-session(手机端可建会话)、GET /api/prompt-modes、SSE 全局通道 session-mode/model/thinking 回传(桌面改动实时同步到手机);
- 微信式语音保留:语音模式隐藏工厂输入区,确认弹窗 → panel.setInputText + sendNow。

## P1 风暴修复轮(2026-11-22,真机「未连接/无历史」根因)

连锁三根因,全部实测定位:
1. **openSession 防抖令牌是全局的** → 多方并发互相 stale → 历史永远渲染不出。修:per-sessionId `openTokens: Map`(acp.ts);
2. **重同步风暴**:树数据 2s 一变的 tree-changed 触发客户端全量 resync(open-session + config 三连),每 1~2s 一轮。修(渲染层):tree-changed 只刷树、live 期间禁止 open-session、resync 500ms 合并、stale 重试封顶 3 次退避;
3. **onSwitchSession 无限回环**(主凶):工厂加载完成回告 → 宿主 setSession → 工厂 setSession → 再回告……每秒上千请求(实测 20s 内 2.1 万次)。修:宿主回显守卫(currentSession.id === sid 直接 return)。修复后 20s 内请求数 21346 → 53。

## P1 修复轮(2026-11-22)

- **发送按钮变色块**:moon 原版 style.css 的全局 `button{}` 元素选择器污染工厂按钮——36px 横向 padding 把内容盒压成 0,flex-shrink 把 SVG 挤成 0 宽。修:全局规则改 `button:not([class*="kp-"])`(moon 视觉不动,工厂按钮豁免)。教训:**移植第三方页面时,全局元素选择器(button/input/a)是最高危的污染点**。

## 待办

- Step4 语音链路(mkcert HTTPS、Web Speech 确认框、piper TTS 推送);
- P1.5 Whisper/SenseVoice 兜底、文件产物推送;P2 watchOS;P3 远程隧道+PWA 推送。
