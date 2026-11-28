# Buzz 移动端视觉回归

使用 `tests/native/fixtures.ts` 输出的 OPEN_SERVER、FAULT_SERVER 和已安装开发包的模拟器。视觉比对使用全新测试工作区。截图前会统一话题已读状态，避免未读数字改变回复预览的宽度。

```sh
maestro test -e OPEN_SERVER="$OPEN_SERVER" --test-output-dir captures tests/native/visual/conversation.yaml
python3 tests/native/visual/compare.py tests/native/visual/baselines/ios-light captures/*/conversation/takeScreenshot
```

基线来自浅色模式的 Bubai Native E2E iOS 26.5 模拟器。Android 基线位于 `baselines/android-light`，由 BubaiNativeValidation 模拟器生成。比对脚本需要 Pillow，并要求截图尺寸一致。它检查社区标题、悬浮栏、频道和话题消息排版、回复预览和输入框。更新基线前请逐张检查。对照实现来自 `references/buzz/mobile` （参考提交 `ed29172`）的 MessagesNavigationBar、AgentNavigationOverlay 和消息主题。基线截图来自 Bubai 客户端。

`offline-reply.yaml` 需要 FAULT_SERVER。它在缓存频道后中断测试服务器，冷启动读取消息，再次冷启动检查待发送消息，恢复服务并验证自动发送。`gesture-voice.yaml` 验证左滑进入话题和语音入口。`voice-message.yaml` 使用麦克风录音并在用户确认后发送到测试智能体。
