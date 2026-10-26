# 角色、语音与品牌版权说明

项目代码采用 [MIT License](LICENSE)。

爱莉希雅、《崩坏3》相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有。CoCo 都可相关品牌权利归其权利人所有。

本项目为非官方作品。MIT 代码许可不授予上述角色与品牌的版权及商标权。

`assets/voice/` 与 `assets/interaction-voice/` 中的 54 条语音为本项目使用的合成录音，并非游戏官方原声。它们不代表原配音演员参与本项目、为本项目录制或为本项目背书。

MIT 许可适用于项目代码，不授予角色、品牌、声音身份或其他第三方素材的相关权利。录音清单中的确认状态与 SHA256 用于标明采用的文件版本和核对完整性，不构成第三方授权声明。

## 本地聊天引擎与模型

聊天运行时使用 Microsoft Visual C++ Runtime 14.51.36247.0。四个 DLL 及原始 `MICROSOFT-VC-RUNTIME-LICENSE.txt` 从程序已携带、固定 SHA256 的 `Elysia-voice-assets-v1.zip` 提取，经逐文件摘要校验后部署到用户数据中的 `chat-runtime/`；不修改系统运行库。文件清单和摘要见 [聊天资源清单](electron/chat-bootstrap-manifest.json) 的 `runtimeDependencies`。这些微软文件遵循随附的微软许可条款，不适用本项目的 MIT 许可。

本地聊天使用 ggml 作者开发的 [llama.cpp](https://github.com/ggml-org/llama.cpp)，固定为 `b11669`（稳定版 `v0.7.0` 对应构建），源码提交为 `620d2225cc436ab0b001e3200e590e3b286ef9ab`。Windows x64 Vulkan 运行包来自[官方发布附件](https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-vulkan-x64.zip)，SHA256 为 `2c07574e7bde71321cb785282b20cc821e951132149eeceeea32ddebdbf0598e`。其 MIT 许可保存在 [llama.cpp-LICENSE.txt](electron/notices/llama.cpp-LICENSE.txt)，运行包中的 LLVM OpenMP 许可保存在 [LLVM-OpenMP-LICENSE.txt](electron/notices/LLVM-OpenMP-LICENSE.txt)。

聊天模型采用 Empero / `empero-ai` 发布的 `Qwen3.8-9B-Q4_K_M.gguf`，固定[模型仓库修订](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill-GGUF/tree/760121cd70bb4c36b2b5ec58eb765e0df5987efe) `760121cd70bb4c36b2b5ec58eb765e0df5987efe`，文件 SHA256 为 `df13d66021cef676f82be74053220fd75af6bf2a6a7fb77f5222ab9e50744a7a`。发布者说明其为基于 Alibaba Qwen 团队 `Qwen3.5-9B` 架构的蒸馏模型量化版本，权重采用 Apache-2.0 许可。本项目不修改该量化权重；完整许可见 [Qwen3.8-9B-LICENSE.txt](electron/notices/Qwen3.8-9B-LICENSE.txt)，来源与校验记录见 [chat-model-provenance.txt](electron/notices/chat-model-provenance.txt)。
