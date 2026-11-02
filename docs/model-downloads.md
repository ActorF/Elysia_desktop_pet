# 模型下载与镜像维护

本文描述 **1.4.3 正式版** 的下载方式。产品变化见[1.4.3 更新说明](releases/v1.4.3.md)。研发状态、来源核对与检查记录集中在本文，不写入 Release 正文。

## 资源与固定版本

| 资源 | 当前源码的分发方式 | 字节数 |
| --- | --- | ---: |
| `Qwen3.8-9B-Q4_K_M.gguf` | 魔搭固定修订优先，Hugging Face 固定修订备用 | 5,780,090,176 |
| `llama-b11669-bin-win-vulkan-x64.zip` | 构建时获取原始包，安装版与便携版直接携带 | 32,182,350 |
| `GPT-SoVITS-v2-240821.7z` | 魔搭 `ActorF/Elysia-voice-runtime` 固定修订优先，Hugging Face 固定修订备用 | 5,744,891,255 |
| `Elysia-voice-assets-v1.zip` | 随程序携带的角色语音模型、配置和解释器桥接资源 | 246,377,253 |

聊天模型的魔搭仓库为 `empero-ai/Qwen3.8-9B-Distill-GGUF`，固定修订 `4f1ed1af3d70d07afa6b613e68b00a68dda20d3d`；原 Hugging Face 修订为 `760121cd70bb4c36b2b5ec58eb765e0df5987efe`。两边文件元数据均为 5,780,090,176 字节、SHA256 `df13d66021cef676f82be74053220fd75af6bf2a6a7fb77f5222ab9e50744a7a`。运行时仍需验证完整文件，不能仅凭同名或网页元数据跳过校验。

语音运行环境继续固定原有文件、大小和 SHA256 `9d9ba79de6aca0cf28a3635ccb1dbbb08b6aef362c4352e32fad99bb49e3000a`。原包已发布到[魔搭公开仓库](https://www.modelscope.cn/models/ActorF/Elysia-voice-runtime)，固定修订为 `3d17cbeceaa5502ec5789c76953f27ab700afc24`；没有替换运行环境版本。原 Hugging Face 固定修订保留作备用。HF-Mirror 的范围请求回到了 Hugging Face，因此没有把该地址加入程序。

## 下载行为

两套配置流程共用 `electron/resource-download.cjs`。资源清单可用有序的 `sources`，旧的单个 `url` 仍可读取。下载器检查每一跳 HTTPS 来源、文件长度、续传范围和最终 SHA256；连接超时、流传输停顿或来源失败会尝试下一个来源，保留同一文件的 `.part` 进度。

连接等待默认 15 秒，数据停顿默认 30 秒，总下载期限为 4 小时；持续传输不会因为连接等待期限而被截断。用户取消后保留正常的未完成下载，损坏内容会重新获取。聊天旧文件仍保留可恢复副本；语音只有程序专用的哈希命名缓存允许直接替换损坏包，避免多占一个大包的空间。

正式构建的 llama.cpp 清单设为 `bundled: true`，从安装包资源目录读取并核对 ZIP。缺失或损坏时要求重新取得完整安装包，不在最终用户首次启动时依赖 GitHub 获取运行环境。构建命令会调用 `prepare:chat`，构建资源保存在忽略的 `build-resources/chat-bootstrap/`。原始 ZIP 与 MIT、LLVM OpenMP 许可一起保留。

## 国内语音源的接入条件

维护者需要魔搭账号及本机写入授权；普通使用者不需要账号、令牌、SDK 或手动选择下载源。只托管当前完整运行包及来源说明，不上传用户配置、聊天记录、角色皮肤草稿或开发目录。

上传完成后，应通过匿名接口核对文件大小、SHA256 和固定修订号，再检查直链及其重定向。所有条件满足后，才将固定修订的地址写入 `voice-bootstrap-manifest.json` 的 `sources`，原始 Hugging Face 地址继续作备用。不要加入尚未上传的占位地址、登录页或长期保存临时签名 CDN 地址。

维护工具已经准备好，普通用户不运行这些命令：

```powershell
# 查看确切文件、原始地址和摘要；不下载、不上传
node scripts/prepare-voice-mirror.cjs

# 账号准备好后，维护者准备原始完整包
node scripts/prepare-voice-mirror.cjs --download

# 将 owner/voice-runtime 替换为维护者自己的真实仓库
python scripts/publish-voice-mirror.py --repo owner/voice-runtime
python scripts/publish-voice-mirror.py --repo owner/voice-runtime --publish

# 先检查匿名下载，再启用已核对的固定版本
node scripts/configure-voice-mirror.cjs --repo owner/voice-runtime
node scripts/configure-voice-mirror.cjs --repo owner/voice-runtime --apply
```

发布器使用官方 `modelscope-hub`，仅上传固定原始压缩包和生成的 README。写入授权从本机 `MODELSCOPE_API_TOKEN` 或项目隔离的登录配置读取，不放进命令参数、聊天或安装包。工具将 SDK 缓存、临时文件和原始包放在项目的 `build-resources/voice-mirror/`；没有 SDK 时只给出安装指引，不自动安装。国内源配置完成后重新构建，才会进入后续安装包。

2026-11-01，维护账号 `ActorF` 使用本机官方 CLI 登录后，已将固定原包及生成的来源 README 上传到 `ActorF/Elysia-voice-runtime`。配置工具核对匿名元数据中的完整大小、SHA256 和固定修订，并实际取得正确的单字节 `206` 响应后，才启用清单中的国内源。官方 `modelscope-hub 0.6.1` 安装在 `build-resources/voice-mirror/.venv/` 中，原包、下载缓存与临时文件均位于 D 盘。

## 本地检查

2026-11-01 的记录位于忽略的 `artifacts/domestic-download-20261101/`。使用已打包源码和真实包内资源，确认解压 llama.cpp、准备 Visual C++ 依赖无需 GitHub；真实魔搭下载在 128 KiB 后取消，再次运行以 `Range: bytes=131072-` 续传并得到 `206`，随后再次取消，总计保留 256 KiB 模型片段。没有启动模型推理或安装应用到系统目录。

该检查验证本机下载链路和包内接线，不等同于中国大陆各运营商的完整大文件下载结果。单元测试另覆盖镜像切换、取消、连接/数据超时、错误范围、损坏内容、磁盘错误及拒绝未授权跳转。

本地 `1.4.3-preview.1` 安装版和便携版位于同一检查目录下的 `release/`，各附 SHA256。两种封装使用相同应用负载，包内 72 项资源已核对，运行代码与源码一致；原正式 `release/` 目录及 GitHub Release 未替换。解包检查副本与下载片段已移入 D 盘回收站，报告继续保留。

语音镜像上线后，`preview2/packaged-voice-download-result.json` 记录了 `1.4.3-preview.2` 实际包内代码的匿名下载：魔搭入口直接返回 `200`，保存 128 KiB 后取消；重试发送 `Range: bytes=131072-`，收到正确的 `206` 与完整文件长度，再保存 128 KiB 后取消。包内语音资源与解压工具哈希均与固定清单一致，未使用 Hugging Face/GitHub 备用源，未解压或启动模型。完整单元检查 484 项通过；启用实际镜像清单后的语音及镜像工具检查 31 项通过。发布完成后已退出本次项目隔离的官方 SDK 登录，下载检查不使用维护者凭据。

已生成的 `1.4.3-preview.2` 安装版和便携版位于 `artifacts/domestic-download-20261101/preview2/release/`，各附 SHA256。`preview2/preview-packages-result.json` 核对了两种封装中的相同应用负载、72 项资源以及包内源码与当前源码的一致性。原正式版本与 `1.3.0` 文件继续保留，本次没有更新 GitHub main 或正式 Release。

用户随后试运行安装版并要求清理：已通过官方卸载器卸载本次安装，将测试配置、下载数据以及 `1.4.3-preview.2` setup EXE 和配套校验/更新元数据移入回收站。预览便携版、正式历史版本、源码及构建资源保留；清理记录位于 `artifacts/setup-cleanup-20261101-preview2/cleanup-result.json`。

上述内容为预览阶段记录。用户随后授权将本次改进晋升为 **1.4.3 正式版**；正式安装版、便携版及 SHA256 统一放在项目根目录的 `release/`。本地应用预览包、旧解包副本及临时模型环境在正式发布后清理，报告继续保留；1.3.0、历史正式版本、源码、构建资源及独立美术/视频工程不属于本次样本清理范围。
