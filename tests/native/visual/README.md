# Buzz 移动端视觉回归

使用 `tests/native/fixtures.ts` 输出的 OPEN_SERVER、FAULT_SERVER 和已安装开发包的模拟器。视觉比对使用全新测试工作区。截图前会统一话题已读状态，避免未读数字改变回复预览的宽度。

```sh
maestro test -e OPEN_SERVER="$OPEN_SERVER" --test-output-dir captures tests/native/visual/conversation.yaml
python3 tests/native/visual/compare.py tests/native/visual/baselines/ios-light captures/*/conversation/takeScreenshot
```

基线来自浅色模式的 Bubai Native E2E iOS 26.5 模拟器。Android 基线位于 `baselines/android-light`，由 BubaiNativeValidation 模拟器生成。比对脚本需要 Pillow，并要求截图尺寸一致。它检查社区标题、悬浮栏、频道和话题消息排版、回复预览和输入框。更新基线前请逐张检查。对照实现来自 `references/buzz/mobile` （参考提交 `ed29172`）的 MessagesNavigationBar、AgentNavigationOverlay 和消息主题。基线截图来自 Bubai 客户端。

`offline-reply.yaml` 需要 FAULT_SERVER。它在缓存频道后中断测试服务器，冷启动读取消息，再次冷启动检查待发送消息，恢复服务并验证自动发送。`gesture-voice.yaml` 验证左滑进入话题和语音入口。`voice-message.yaml` 使用麦克风录音并在用户确认后发送到测试智能体。

首页基线也包含更多菜单。频道的固定数据含标题、正文、代码块和回复预览。运行
`mention.yaml` 与 `sent-message.yaml` 可另外采集提及候选、发送成功和编辑后的画面。
`pending.yaml` 连接测试代理，让它暂存一次发送请求。Maestro 断言并截取「正在发送」后释放请求，再核对服务端回执。该流程只使用本机测试服务。

首页比对区域覆盖社区栏、筛选、分组标题、频道列表与悬浮栏。原版仓库只有 Android 空首页和新建菜单两张移动端截图，两者使用不同数据。频道与话题的当前基线用于发现 Bubai 自身的布局回退。

交互回归可按以下场景分别运行，每次使用独立测试社区。搜索流程会生成超过一页的历史消息。

| 流程 | 验证点 |
|---|---|
| `edit-preserves-draft.yaml` | 编辑旧消息后取消或保存，原草稿仍在 |
| `search-destination.yaml` | 搜索后定位到旧频道消息或话题中的具体回复 |
| `home-reconnect.yaml` | HTTP 可用，仅中断实时连接，提示出现并随恢复消失 |
| `late-receipt.yaml` | 服务端先接收，延迟释放回执，核对等待状态和最终消息数量 |
| `offline-attachment.yaml` | 断网选文件，重启后保留，联网后确认服务端收到附件 |

后面三条使用 `network-fixture.ts` 的 FAULT_SERVER。执行离线附件流程前，将名为 `Bubai-QA-icon.png` 的测试图片拷入 Android 的 Download 目录或导入 iOS 模拟器相册。
