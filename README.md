<h1 align="center">爱莉希雅桌宠</h1>

<p align="center">Elysia_desktop_pet · 陪在桌面上的 Q 版爱莉希雅</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center"><a href="#下载程序">下载程序</a> · <a href="#角色展示">角色展示</a> · <a href="#使用">使用说明</a> · <a href="#源码运行">源码运行</a></p>

透明全身立绘、鼠标目光跟随、轻柔摆动。表情、猫猫形态、眼镜和四种动作可以自由搭配，输入字符时还有小云朵回应。1.4.0 在日常语音、点击互动和鼠标流光基础上，加入本地聊天、回复朗读、模型自动配置与更细致的身体部位互动。

**1.4.0 正式源码、README、程序与校验文件在 `version-control` 分支同步。** 程序可通过下方分支下载入口获取；`main` 分支和 GitHub Release 保持不变，未创建 1.4.0 Release。使用方法见[本地聊天与朗读](#本地聊天与朗读)，完整变化见 [1.4.0 更新说明](docs/releases/v1.4.0.md)。

## 下载程序

**1.4.0 · `version-control` 分支下载：**

| 版本 | 程序 | 校验文件 |
| --- | --- | --- |
| Windows 便携版 | [下载 1.4.0 EXE](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.0.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.0.exe.sha256) |
| Windows 安装版 | [下载 1.4.0 安装器](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.0-setup.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.0-setup.exe.sha256) |

点击上述链接即可下载完整程序，无需安装 Git、Git LFS 或 Node.js。两种版本均会在首次运行时自动准备聊天与语音环境，首次配置需要联网。

便携版下载后双击 `Elysia_desktop_pet-1.4.0.exe` 即可运行；安装版运行 `Elysia_desktop_pet-1.4.0-setup.exe` 完成安装。升级前先从右下角托盘退出旧版，已有正式配置中的位置、大小、装扮开关和偏好会保留，无需手动迁移。

历史 GitHub Release：[1.3.0 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0)（不含聊天功能）。历史 [1.3.0 更新说明](docs/releases/v1.3.0.md)与 [1.2.0 更新说明](docs/releases/v1.2.0.md)保留，也可按下方[源码运行与构建步骤](#源码运行)自行构建。

<details>
<summary>下载提示与文件后缀</summary>

**下载提示：** 当前版本未进行数字签名。如果 Edge 提示“isn't commonly downloaded（不常下载）”，确认使用本页上方的程序下载链接后，在下载列表选择 **⋯ → 保留 → 显示更多 → 仍然保留**，等待下载完成。[微软操作说明](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/download-failures#check-security-and-smartscreen-settings)

**下载完成后，如果文件仍叫 `Unconfirmed 数字.crdownload`，可以将后缀改为 `.exe` 使用。** 先在文件资源管理器中显示“文件扩展名”，再根据所下载的版本，将完整文件名改为 **`Elysia_desktop_pet-1.4.0.exe`** 或 **`Elysia_desktop_pet-1.4.0-setup.exe`**，不要保留末尾的 `.crdownload`。此操作只适用于已经完整下载的文件；仍在下载或下载中断时，请先完成下载。

</details>

## 角色展示

### 全身立绘

<p align="center"><img src="docs/media/character.png" width="400" alt="爱莉希雅全身立绘"></p>
<p align="center"><a href="docs/media/idle.webm">观看待机动画</a></p>

### 全部表情

默认表情，以及害羞、生气、睡觉、惊讶、晕、Wink、伤心、爱心眼、微笑、囧，共 **11 种脸部状态**。

![默认表情与十种可切换表情](docs/media/expressions.png)

### 不同形态

猫猫形态与眼镜是两个独立开关，可以组合成原始形态、猫猫、眼镜、猫猫＋眼镜。装扮在切换表情、动作和重新启动后保留。

![原始形态、猫猫、眼镜与猫猫加眼镜](docs/media/forms.png)

### 动作与手势切换

日常待机、听我说呀！、吃蛋糕、喝奶茶四选一。切换表情或装扮时，当前动作保持不变。喇叭动作不播放声音。

![日常待机、喇叭、吃蛋糕与喝奶茶](docs/media/actions.png)

### 按键云朵

输入一个字符，手心上方就会出现一朵浅粉白色云朵。喇叭动作会将字符向外送出，带有扩音弧线，约一秒消失。

![待机、奶茶、蛋糕和喇叭动作下的按键云朵](docs/media/key-cloud.png)

<p align="center"><a href="docs/media/megaphone-key-cloud.webm">观看喇叭按键特效</a> · 仅图像效果，无声音</p>

## 使用

### 鼠标与托盘

| 操作 | 功能 |
| --- | --- |
| 按住人物并用鼠标左键拖动 | 移动桌宠，可拖出屏幕四边 |
| 左键轻点头部／身体 | 摸头／戳戳回应，头身合计 3 秒内第 5 次点击会假装生气 |
| 按住人物上的鼠标右键＋滚轮 | 向上放大、向下缩小，从 1% 起持续放大 |
| 点击或右键右下角托盘图标 | 打开“设置”“打开聊天框”“退出”菜单 |
| 托盘“设置” | 打开独立设置窗口，桌宠继续显示 |
| 托盘“打开聊天框” | 打开可输入消息的独立聊天窗口 |
| 设置窗口底部“找回桌宠”或 `Ctrl + Alt + P` | 找回人物并关闭点击穿透 |
| 设置窗口底部“恢复大小并找回” | 恢复 100% 大小并将人物带回屏幕 |
| 托盘“退出” | 退出整个程序 |

人物外的透明区域可直接点击后方窗口。普通滚轮不会缩放，右键人物也不会弹出设置窗口。

新版使用透明底粉色托盘图标。位置、大小和偏好会自动保存。

1.4.0 沿用 `%APPDATA%/Elysia Desktop Pet/` 中的正式配置，保留已有位置、大小、装扮和偏好。升级前从托盘退出旧版，再运行新版本，无需手动迁移已有正式配置。

### 设置窗口

设置和人物可以同时显示，窗口可单独移动、调整大小。拖动顶部空白处移动窗口，右上角三个标准图标分别是最小化、最大化／还原和关闭。关闭设置窗口后，桌宠会继续运行。1.4.0 的设置分为 **外观、动画、桌面、互动、语音、聊天、聊天记录** 七页。

<table>
  <tr><th>外观</th><th>动画</th><th>桌面</th></tr>
  <tr>
    <td><a href="docs/media/settings-appearance.png"><img src="docs/media/settings-appearance.png" width="280" alt="外观设置：表情、装扮与动作"></a></td>
    <td><a href="docs/media/settings-animation.png"><img src="docs/media/settings-animation.png" width="280" alt="动画设置：目光跟随、摆动与按键云朵"></a></td>
    <td><a href="docs/media/settings-desktop.png"><img src="docs/media/settings-desktop.png" width="280" alt="桌面设置：大小、任务栏层级与快捷键"></a></td>
  </tr>
</table>

<table>
  <tr><th>互动</th><th>语音</th></tr>
  <tr>
    <td><a href="docs/media/settings-interaction.png"><img src="docs/media/settings-interaction.png" width="420" alt="互动设置：点击回应、三种鼠标流光与保留时间"></a></td>
    <td><a href="docs/media/settings-voice.png"><img src="docs/media/settings-voice.png" width="420" alt="语音设置：自动问候、勿扰、音量、生日与播放状态"></a></td>
  </tr>
</table>

点击截图可查看大图。

- **外观：** 选择表情、猫猫和眼镜装扮、四种动作。快捷键切换后，窗口也会同步更新。
- **动画：** 开关目光跟随、摆动和按键云朵；用滑块或数值框调节下表参数，也可一键恢复默认。
- **桌面：** 调整人物大小、置顶、任务栏前后顺序、鼠标穿透和快捷键。大小支持直接输入百分比，从 1% 起，没有固定的放大上限。
- **互动：** 分别开关点击互动和鼠标流光，选择流光样式与轨迹保留时间。
- **语音：** 控制自动问候、勿扰、音量与生日月日，查看当前播放状态。正式界面不含试听或模拟触发入口。
- **聊天：** 修改用户名，开关自动朗读，查看聊天模型和语音环境各自的配置进度；高级选项可指定已有 Ollama 服务及语音环境。
- **聊天记录：** 左侧选择会话，右侧查看消息，可继续聊天、删除单段或清空记录，删除前会确认。

| 动画参数 | 范围 | 默认值 |
| --- | --- | --- |
| 眼睛跟随幅度 | 0–200% | 100% |
| 摆动幅度 | 0–200% | 100% |
| 摆动速度 | 0.25–3× | 1× |

眼睛跟随默认保持原版效果，0% 关闭形变，200% 增强效果。摆动保持上下同向，幅度为 0% 时停止；关闭再开启对应开关会保留参数。

开启“始终置顶”后，可选择“任务栏在前”或“桌宠在前”，默认桌宠在前。即使人物开启鼠标穿透，设置窗口仍可操作，底部按钮可以随时找回人物。

### 本地聊天与朗读

1.4.0 首次运行会自动准备本地 [Ollama](https://ollama.com/) 与默认模型 `tobestyledintro/qwen3.8-9b-distill:latest`，无需手动安装模型或填写项目路径。**设置 → 聊天** 分别显示聊天模型与语音环境的进度，可取消或在失败后重试；两项就绪状态互相独立。已有自定义服务设置不会被自动覆盖。

从右下角托盘选择 **打开聊天框**，输入消息即可和爱莉希雅聊天，回答会逐步显示。聊天窗口可单独移动、缩放和关闭，关闭窗口后桌宠继续运行。左上加号开启新对话；底部齿轮、输入框和内凹斜箭头同排，齿轮打开设置与记录，悬停可查看说明；箭头发送消息，支持 Enter 发送、Shift + Enter 换行，中文输入法选词时不会误发。停止按钮可停止生成或朗读。

在 **设置 → 聊天** 修改用户名、模型名和 Ollama 服务地址，默认连接 `http://localhost:11434`。消息下方的复制图标可复制正文；爱莉希雅回复下方另有手动朗读图标，悬停或键盘聚焦可查看说明。**设置 → 聊天记录** 左侧选择对话，右侧查看详情，可删除单段或清空所有记录，删除前会确认且保留用户名与设置。用户名和聊天记录保存在 `%APPDATA%/Elysia Desktop Pet/chat-state.json`。模型调用会使用当前用户名和所选对话的近期内容；默认本地服务不需要 API 密钥。

人设沿用本地 `D:\Elysia_AI\core\elysia_system_prompt_zh.md`，副本随程序保存在 `electron/chat-persona.md`，文字聊天不依赖原项目目录。

**可选朗读：** 自动朗读默认关闭，普通文字聊天不会加载语音模型；明确点击回复的朗读图标可单独读这一条，不改变自动朗读设置。开启自动朗读可提前预热，在完整回答生成后朗读；同情绪模型短时复用，闲置 45 秒释放，最近 8 条/24 MiB 以内的合成音频仅在内存缓存，删除记录会清除缓存。根据正文线索选择已有情绪参考，否定和不明确表达回到中性；这不是额外的大模型情绪分类。当前机器 CPU 实测冷启动或切换情绪约 25 秒，暖模型新回复首音约 1.8–2.4 秒，重复朗读无需重新合成；其他电脑耗时可能不同。发送新消息会停止旧朗读；关闭自动朗读、关闭聊天或退出立即释放模型。音量与勿扰沿用“语音”设置，朗读期间暂停日常与点击录音，点击仍可显示表情和静默字幕。

**首次自动配置：** 便携版与安装版均携带约 246 MB 的独立 Python 和爱莉希雅语音资源，首次运行自动安装/启动 Ollama、下载约 6.7 GB 的默认聊天模型及约 5.7 GB 的 GPT-SoVITS 运行环境。设置里显示各自进度、取消与重试；Ollama 安装阶段不能取消，下载和解压不启动声音模型。语音环境放在用户数据目录的 `voice-runtime`，无需原 D 盘项目；本机已有环境仍可作为高级选项使用。资源校验 SHA256 后部署，失败不会报告已就绪。语音权重随程序携带，大型运行环境从固定上游来源下载。当前已完成本机自动化、真实模型与语音验证，但尚未在干净 Windows 虚拟机上完成从零首次安装验收。

`npm run test:chat-tts` 验证实际语音预热、复用、情绪、缓存及进程释放，结果保存在忽略的 `artifacts/chat-tts-check/`，不播放。可通过 `ELYSIA_VOICE_PROJECT_ROOT` 指定完整的可移动语音环境。

源码运行不自动启动首次下载，可在聊天设置中配置，或使用已有 Ollama 服务。`node scripts/package-voice-bootstrap.cjs` 从指定本地源生成独立语音资源包与摘要，不包含个人 `.env` 或聊天数据；正式构建命令见下方。`npm run test:chat` 检查界面，`npm run test:chat-model` 验证真实聊天模型。便携版每次启动使用独立临时目录，避免重复启动互相清理。

### 日常语音与台词气泡

**36 句日常语音**分为 12 类，按本地时间和使用状态送上早晚问候、饭点提醒、欢迎回来、休息提醒、周末问候、生日祝福与退出告别。每类三句轮换选择，一次只说一句。自动问候至少间隔 20 分钟，每天最多 6 次；生日和主动退出单独计数。锁屏、休眠、全屏或勿扰时暂停自动问候，错过的时段不补播。各类条件见 [1.3.0 更新说明](docs/releases/v1.3.0.md#日常语音的触发条件)。

说话时，台词显示在**粉色边框、白色背景**的气泡里，只显示完整台词，按句长调整大小，最多两行。人物在当前显示器右半边时，气泡显示在左侧；在左半边时显示在右侧，并跟随拖动与缩放。录音结束后，气泡约再停留 1.2 秒。

在“语音”页调节音量、开启勿扰或保存生日月日。生日只在本机保存，不需要年份。托盘退出可能先播放告别，再次选择退出可立即跳过；关闭设置窗口不会触发告别。

### 点击摸头与戳戳

在“互动”页开启 **点击互动** 后，左键轻点头顶或刘海是摸头，轻点身体是戳戳，头部（含脸部）／手部随机展示害羞、Wink、爱心眼、微笑；身体／腿部随机展示惊讶、害羞，道具展示微笑。普通表情显示约 **1.8 秒**，期间连点不会替换或延长表情，也不会重复请求语音，但仍累计点击次数。部位范围适配四种动作及待机摆动，并排除透明区域和可见装饰。**头部与身体共同计数，3 秒内第 5 次轻点可以打断普通表情并触发生气回应**，之后休息 3 秒。拖动人物、右键滚轮缩放不会算作轻点，不需要按住鼠标来回抚摸。

三类互动各有 6 句，共 **18 句互动语音**。短时间连点会合并回应；已经开始的语音会完整说完，等待中的生气回应最多保留一条，过期后不补播。日常问候与互动发声共用播放控制，不会叠音。临时互动表情结束后恢复原表情。

点击互动与日常自动问候分别控制。关闭点击互动会清除当前互动声音、字幕和待播回应，仍可拖动、缩放人物及接收日常问候；勿扰或音量为 0 时，点击仍有表情和文字回应。

### 鼠标流光

在“互动”页开启 **鼠标流光**，鼠标在桌面移动时会留下所选轨迹。它与点击互动是两个独立开关，默认均开启；流光始终穿透鼠标操作，不抢输入焦点。

| 样式 | 效果 |
| --- | --- |
| 粉色流光 | 默认的细粉色光线 |
| 紫粉绸光 | 较粗的紫色前端，沿移动路径渐变为玫粉色细尾 |
| 星尘尾迹 | 闪点配合短光丝 |

**轨迹保留时间支持 0.1–5 秒的小数，默认 0.6 秒。** 可直接输入 `1.3`、`2.5` 等秒数，或使用步长为 0.1 秒的滑条；“默认”恢复 0.6 秒。关闭流光时也能预选样式和时长，重新开启后生效。切换样式、修改时长或关闭流光会立即清除旧轨迹，设置自动保存。

流光支持快速甩动、画圈和多显示器。跨屏、锁屏或休眠恢复后从新位置开始，不把不同屏幕或恢复前后的旧位置连起来。

### 按键云朵

每次只显示最近输入的一个字符，支持 `0–9`、`a–z`、`A–Z`、英文标点与符号；空格显示为 `␣`。大小写和符号遵循 Shift 与 Caps Lock。

Enter、Ctrl、Tab、方向键等功能键，以及 Ctrl／Alt／Win 快捷组合不显示。连续输入会替换前一个字符，约一秒消失。普通动作的云朵在手心上方淡出，喇叭动作则向左上方飘出并带有扩音弧线，不播放声音。

可在“动画”页开关按键云朵，不影响表情快捷键。输入仅用于即时显示，不记录或保存。

### 表情快捷键

按住 **空格**，再按下对应数字；数字行和数字小键盘均可使用。再次触发同一表情恢复默认脸，动作与装扮不变。

| 组合键 | 表情 | 组合键 | 表情 |
| --- | --- | --- | --- |
| 空格＋1 | 害羞 | 空格＋2 | 生气 |
| 空格＋3 | 睡觉 | 空格＋4 | 惊讶 |
| 空格＋5 | 晕 | 空格＋6 | Wink |
| 空格＋7 | 伤心 | 空格＋8 | 爱心眼 |
| 空格＋9 | 微笑 | 空格＋0 | 囧 |

### 装扮与动作快捷键

| 组合键 | 功能 | 切换方式 |
| --- | --- | --- |
| 空格＋F1 | 猫猫形态 | 独立开关 |
| 空格＋F2 | 眼镜 | 独立开关 |
| 空格＋F3 | 日常待机 | 选择动作 |
| 空格＋F4 | 听我说呀！ | 选择动作 |
| 空格＋F5 | 吃蛋糕 | 选择动作 |
| 空格＋F6 | 喝奶茶 | 选择动作 |
| 空格＋Backspace | 全部重置 | 默认脸、日常待机、关闭猫猫与眼镜 |

空格组合键在其他窗口中也可用，并且不会拦截其他软件的按键输入。可在设置窗口的“桌面”页关闭空格组合键，或开启备用的 **Ctrl＋Alt＋对应数字／F 键／Backspace**。表情、装扮和动作也能在“外观”页直接选择。

## 源码运行

需要 **Windows、Node.js 22 或更新版本**。`release/` 中的 EXE 使用 Git LFS 保存；克隆时需安装 Git LFS，执行以下命令才能取到完整 EXE，而非小型指针文件。只想使用程序可直接点击上方下载，无需安装 Git。浏览器视觉检查还需要 Microsoft Edge。

```powershell
git lfs install
git clone --branch version-control https://github.com/ActorF/Elysia_desktop_pet.git
cd Elysia_desktop_pet
git lfs pull
npm ci
npm start
```

测试与打包：

```powershell
npm test
npm run test:smoke
npm run test:visual
npm run test:faces
npm run test:zoom
npm run test:settings
npm run test:voice
npm run test:interactions
npm run test:interaction-settings
npm run test:chat
npm run test:chat-native
npm run make:release
npm run verify:release
```

`npm run make:release`（`node scripts/package-release.cjs`）生成 `release/Elysia_desktop_pet-1.4.0.exe` 和 `release/Elysia_desktop_pet-1.4.0-setup.exe`。也可分别运行 `npm run make:portable`、`npm run make:setup`。`npm run verify:release`（`node scripts/verify-package.cjs`）校验正式包；这些命令不会发布到 GitHub。构建需先准备语音资源包，`npm run package` 可生成未封装的应用目录。

1.4.0 晋升时已通过 **391 项单元测试**，并完成聊天界面、原生窗口、真实 Qwen 回复、真实语音及身体部位互动回归；测试范围与首次自动配置限制见 [1.4.0 更新说明](docs/releases/v1.4.0.md#验证范围)。完整命令与检查范围见[验证说明](docs/verification.md)。

## 项目结构

| 目录或文件 | 内容 |
| --- | --- |
| `electron/` | 人物、聊天、设置、字幕和流光窗口，聊天与记录、语音调度、模型配置、托盘、快捷键和设置保存 |
| `renderer/` | 人物绘制、表情与动作、身体部位互动、聊天与记录、字幕、鼠标流光和设置界面 |
| `assets/character/` | 桌宠运行所需的角色素材 |
| `assets/ui/` | 托盘图标 |
| `assets/voice/`、`assets/interaction-voice/` | 36 条日常录音、18 条互动录音及校验清单 |
| `scripts/` | 启动、构建验证与预览工具 |
| `tests/` | 自动测试 |
| `docs/` | 角色预览与验证说明 |
| `release/` | Windows 便携版、安装版与校验文件；EXE 通过 Git LFS 同步到 `version-control` |
| `LICENSE` | MIT 代码许可证 |

项目使用 Electron 透明窗口、PNG 素材合成与 WebGL 网格动画。WebGL 不可用时显示静态合成角色。

## 授权与版权

项目代码使用 [MIT License](LICENSE)。爱莉希雅、《崩坏3》相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有，CoCo 都可品牌权利归其权利人所有。本项目为非官方作品，语音为合成录音，并非游戏官方原声；MIT 代码许可不授予角色、品牌或相关声音权利。见[版权说明](ASSET-NOTICE.md)。
