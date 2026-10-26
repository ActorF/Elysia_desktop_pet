<h1 align="center">爱莉希雅桌宠</h1>

<p align="center">Elysia_desktop_pet · 陪在桌面上的 Q 版爱莉希雅</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center"><a href="#下载程序">下载程序</a> · <a href="#角色展示">角色展示</a> · <a href="#使用">使用说明</a> · <a href="#源码运行">源码运行</a></p>

透明全身立绘、鼠标目光跟随、轻柔摆动。表情、猫猫形态、眼镜和四种动作可以自由搭配，输入字符时还有小云朵回应。支持本地聊天、可选回复朗读、模型自动配置、聊天记录管理与身体部位互动。1.4.2 改用桌宠自行管理的 llama.cpp，并修复手动朗读被系统忙碌状态误拦截的问题。

**当前测试版本：1.4.2，尚非正式版。** 本地修复包位于 `release/`，包含手动朗读复用、长消息和聊天运行库修复；下方远程下载尚未包含这些本地修复，尚未创建 1.4.2 GitHub Release。使用方法见[本地聊天与朗读](#本地聊天与朗读)，变化和验证范围见 [1.4.2 更新说明](docs/releases/v1.4.2.md)。

## 下载程序

| 版本 | 程序 | 功能 | 校验文件 |
| --- | --- | --- | --- |
| 1.4.2 测试版 · Windows 安装版 | [下载安装器](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.2-setup.exe) | 含聊天与可选回复朗读 | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.2-setup.exe.sha256) |
| 1.4.2 测试版 · Windows 便携版 | [下载 EXE](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.2.exe) | 相同功能，双击即可运行 | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/version-control/release/Elysia_desktop_pet-1.4.2.exe.sha256) |
| 1.3.0 Windows 便携版 | [下载 EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe) | **不含聊天及回复朗读**，保留日常与点击互动录音 | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe.sha256) |

点击上述链接即可下载完整程序，无需安装 Git、Git LFS 或 Node.js。1.4.2 的安装版与便携版均会在首次运行时自动准备聊天与语音环境，首次配置需要联网；1.3.0 无需下载聊天或语音合成模型。

安装版运行 `Elysia_desktop_pet-1.4.2-setup.exe` 完成安装；便携版双击 EXE 即可运行。升级前先从右下角托盘退出旧版，已有正式配置中的位置、大小、装扮开关和偏好会保留，无需手动迁移。

[1.3.0 更新说明](docs/releases/v1.3.0.md) · [1.3.0 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0) · [源码运行与构建步骤](#源码运行)

<details>
<summary>下载提示与文件后缀</summary>

**下载提示：** 当前版本未进行数字签名。如果 Edge 提示“isn't commonly downloaded（不常下载）”，确认使用本页上方的程序下载链接后，在下载列表选择 **⋯ → 保留 → 显示更多 → 仍然保留**，等待下载完成。[微软操作说明](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/download-failures#check-security-and-smartscreen-settings)

**下载完成后，如果文件仍叫 `Unconfirmed 数字.crdownload`，可以将后缀改为 `.exe` 使用。** 先在文件资源管理器中显示“文件扩展名”，再根据所下载的版本，将完整文件名改为 **`Elysia_desktop_pet-1.4.2.exe`** 或 **`Elysia_desktop_pet-1.4.2-setup.exe`**，不要保留末尾的 `.crdownload`。此操作只适用于已经完整下载的文件；仍在下载或下载中断时，请先完成下载。

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

1.4.2 沿用 `%APPDATA%/Elysia Desktop Pet/` 中的正式配置，保留已有位置、大小、装扮和偏好。升级前从托盘退出旧版，再运行新版本，无需手动迁移已有正式配置。

### 设置窗口

设置和人物可以同时显示，窗口可单独移动、调整大小。拖动顶部空白处移动窗口，右上角三个标准图标分别是最小化、最大化／还原和关闭。关闭设置窗口后，桌宠会继续运行。当前设置分为 **外观、动画、桌面、互动、语音、聊天、聊天记录** 七页。

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
- **聊天：** 修改用户名，开关自动朗读，查看聊天模型和语音环境各自的配置进度；高级选项可指定兼容聊天接口及语音环境。
- **聊天记录：** 左侧选择会话，右侧查看消息，可继续聊天、删除单段或清空记录，删除前会确认。

| 动画参数 | 范围 | 默认值 |
| --- | --- | --- |
| 眼睛跟随幅度 | 0–200% | 100% |
| 摆动幅度 | 0–200% | 100% |
| 摆动速度 | 0.25–3× | 1× |

眼睛跟随默认保持原版效果，0% 关闭形变，200% 增强效果。摆动保持上下同向，幅度为 0% 时停止；关闭再开启对应开关会保留参数。

开启“始终置顶”后，可选择“任务栏在前”或“桌宠在前”，默认桌宠在前。即使人物开启鼠标穿透，设置窗口仍可操作，底部按钮可以随时找回人物。

1.4.1 修复副屏任务栏顺序异常或其他置顶程序遮挡后，桌宠落到普通窗口后方的问题。“任务栏在前”模式会恢复任务栏在桌宠上方、桌宠在普通应用上方的顺序，并保持任务栏的位置、可见性和当前焦点；保留字幕、流光等辅助窗的前后顺序，关闭置顶或切换模式后恢复当前设置。适用范围是普通 Windows 桌面，不承诺覆盖安全桌面、独占全屏或特殊系统层。

### 本地聊天与朗读

从托盘选择 **打开聊天框** 即可聊天，Enter 发送、Shift + Enter 换行。首次启动需要联网，自动准备 llama.cpp、默认 Qwen 聊天模型与语音资源，无需安装 Ollama。桌宠在后台启动自己的聊天服务，退出时释放，下次打开自动恢复；在 **设置 → 聊天** 查看聊天和语音各自的进度、取消或重试。

在 **设置 → 聊天** 修改用户名或开关自动朗读，自动朗读**默认关闭**。消息下方可复制文字，点击回复的 **Read Aloud／朗读** 可单独读这一条，不改变自动朗读设置。首次加载语音模型可能需要较长时间，请等待状态更新。

手动朗读不会被普通全屏或 Windows 忙碌状态误拦截，仍遵守“语音”页的勿扰、静音、锁屏和休眠限制；失败提示会说明具体原因。自动朗读与自动问候保留屏幕状态限制。

**设置 → 聊天记录** 可查看或删除保存在本机的对话，删除前会确认。升级保留用户名、聊天记录与偏好；旧版默认聊天连接会迁移，自定义连接保留。高级自定义服务需支持 OpenAI 兼容的流式聊天接口。人设 system prompt 位于 [electron/chat-persona.md](electron/chat-persona.md)，资源体积与验证范围见 [1.4.2 更新说明](docs/releases/v1.4.2.md)。

### 日常语音与台词气泡

内置 **36 句日常语音**，在问候、休息、生日等场景播放，并显示台词气泡。可在 **设置 → 语音** 调整音量、开关自动问候和勿扰、设置生日。

### 点击摸头与戳戳

左键轻点头部是摸头，轻点身体是戳戳，会触发表情，配有 **18 句互动语音**；短时间连续点击太多会让她假装生气。可在 **设置 → 互动** 独立开关，拖动和缩放不受影响。

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

`npm run make:release`（`node scripts/package-release.cjs`）生成 `release/Elysia_desktop_pet-1.4.2.exe` 和 `release/Elysia_desktop_pet-1.4.2-setup.exe`。也可分别运行 `npm run make:portable`、`npm run make:setup`。`npm run verify:release`（`node scripts/verify-package.cjs`）校验正式包；这些命令不会发布到 GitHub。构建需先准备语音资源包，`npm run package` 可生成未封装的应用目录。

本次聊天与朗读验证结果、已知检查限制和第二台电脑测试清单见 [1.4.2 更新说明](docs/releases/v1.4.2.md#验证结果与限制)。首次自动配置仍待全新 Windows 环境的全链路验收。完整命令与检查范围见[验证说明](docs/verification.md)。

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
| `release/` | Windows 安装版、便携版与校验文件；1.4.2 EXE 通过 Git LFS 保存在 `version-control` |
| `LICENSE` | MIT 代码许可证 |

项目使用 Electron 透明窗口、PNG 素材合成与 WebGL 网格动画。WebGL 不可用时显示静态合成角色。

## 授权与版权

项目代码使用 [MIT License](LICENSE)。爱莉希雅、《崩坏3》相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有，CoCo 都可品牌权利归其权利人所有。本项目为非官方作品，语音为合成录音，并非游戏官方原声；MIT 代码许可不授予角色、品牌或相关声音权利。见[版权说明](ASSET-NOTICE.md)。
