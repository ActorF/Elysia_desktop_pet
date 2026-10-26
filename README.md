<h1 align="center">爱莉希雅桌宠</h1>

<p align="center">Elysia_desktop_pet · 陪在桌面上的 Q 版爱莉希雅</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center"><a href="#下载程序">下载程序</a> · <a href="#角色展示">角色展示</a> · <a href="#使用">使用说明</a> · <a href="#源码运行">源码运行</a></p>

透明全身立绘、鼠标目光跟随、轻柔摆动。表情、猫猫形态、眼镜和四种动作可以自由搭配，输入字符时还有小云朵回应。支持本地聊天、可选回复朗读、模型自动配置、聊天记录管理与身体部位互动。1.4.2 改用桌宠自行管理的 llama.cpp，并修复手动朗读被系统忙碌状态误拦截的问题。

**当前正式版本：1.4.2。** 已包含手动朗读复用、长消息和聊天运行库修复。查看 [1.4.2 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.4.2) 与[更新说明](docs/releases/v1.4.2.md)。

## 下载程序

| 版本 | 程序 | 功能 | 校验文件 |
| --- | --- | --- | --- |
| **1.4.2 Windows 安装版** | [下载安装器](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2-setup.exe) | 含聊天与可选回复朗读 | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2-setup.exe.sha256) |
| **1.4.2 Windows 便携版** | [下载 EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2.exe) | 相同功能，双击即可运行 | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2.exe.sha256) |
| 1.3.0 Windows 便携版 | [下载旧版 EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe) | **不含聊天及回复朗读**，保留日常与点击互动录音 | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe.sha256) |

适用于 **Windows x64**。安装版按提示完成安装；便携版双击即可运行，无需 Git、Git LFS 或 Node.js。1.3.0 无需下载聊天或语音合成模型。

升级前先从托盘退出旧版，再安装或打开新版。位置、大小、装扮、用户名、聊天记录与偏好会自动保存到 `%APPDATA%/Elysia Desktop Pet/`，升级后继续保留，无需手动迁移。

程序未进行数字签名。请等待文件完整下载，再用对应 SHA256 核对完整性；下载中断时应重新下载。

[1.4.2 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.4.2) · [1.3.0 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0) · [源码运行](#源码运行)

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

输入字符时，人物手边会出现浅粉白色云朵，喇叭动作还会带有扩音弧线。

![待机、奶茶、蛋糕和喇叭动作下的按键云朵](docs/media/key-cloud.png)

<p align="center"><a href="docs/media/megaphone-key-cloud.webm">观看喇叭按键特效</a></p>

## 使用

### 鼠标与托盘

| 操作 | 功能 |
| --- | --- |
| 按住人物并用鼠标左键拖动 | 移动桌宠，可拖出屏幕四边 |
| 左键轻点头部／身体 | 摸头／戳戳回应 |
| 按住人物上的鼠标右键＋滚轮 | 向上放大、向下缩小，从 1% 起持续放大 |
| 点击或右键右下角托盘图标 | 打开“设置”“打开聊天框”“退出”菜单 |
| 设置窗口底部“找回桌宠”或 `Ctrl + Alt + P` | 找回人物并关闭点击穿透 |
| 设置窗口底部“恢复大小并找回” | 恢复 100% 大小并将人物带回屏幕 |

人物外的透明区域可直接点击后方窗口。普通滚轮不会缩放，右键人物也不会弹出设置窗口。

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
- **语音：** 控制自动问候、勿扰、音量与生日月日，查看当前播放状态。
- **聊天：** 修改用户名，开关自动朗读，查看聊天模型和语音环境各自的配置进度；高级选项可指定兼容聊天接口及语音环境。
- **聊天记录：** 左侧选择会话，右侧查看消息，可继续聊天、删除单段或清空记录，删除前会确认。

| 动画参数 | 范围 | 默认值 |
| --- | --- | --- |
| 眼睛跟随幅度 | 0–200% | 100% |
| 摆动幅度 | 0–200% | 100% |
| 摆动速度 | 0.25–3× | 1× |

眼睛跟随默认保持原版效果，0% 关闭形变，200% 增强效果。摆动保持上下同向，幅度为 0% 时停止；关闭再开启对应开关会保留参数。

开启“始终置顶”后，可选择“任务栏在前”或“桌宠在前”，默认桌宠在前。“任务栏在前”会让桌宠保持在任务栏下方、普通应用上方。即使人物开启鼠标穿透，设置窗口仍可操作，底部按钮可以随时找回人物。

### 本地聊天与朗读

首次启动需要联网，自动准备 llama.cpp、默认 Qwen 聊天模型与语音资源，无需安装 Ollama。聊天模型约 **5.8 GB**，语音运行环境下载约 **5.7 GB**，还需预留解压空间。在 **设置 → 聊天** 查看两者各自的进度，可取消或重试；准备完成后复用已保存资源，聊天服务随桌宠启动和退出。

从托盘选择 **打开聊天框**，Enter 发送、Shift + Enter 换行。可在 **设置 → 聊天** 修改称呼你的名字，消息下方可复制文字。

自动朗读**默认关闭**。点击回复的 **Read Aloud／朗读** 只读这一条，不改变自动朗读设置；也可在聊天设置中开启自动朗读。首次加载语音模型可能较慢，短时间内的后续朗读会复用已加载模型。

手动朗读不会被普通全屏或 Windows 忙碌状态误拦截，仍遵守勿扰、静音、锁屏和休眠限制；失败提示会说明具体原因。自动朗读与日常问候保留屏幕状态限制。发送新消息、停止或关闭聊天可中止当前朗读。

默认模型与聊天记录都在本机。**设置 → 聊天记录** 可查看、继续或删除对话，删除前会确认。高级自定义服务需支持 OpenAI 兼容的流式聊天接口；选择远程地址后，对话会发送到该服务。人设文本位于 [electron/chat-persona.md](electron/chat-persona.md)，模型与升级细节见 [1.4.2 更新说明](docs/releases/v1.4.2.md)。

### 日常语音与台词气泡

内置 **36 句日常语音**，在问候、休息、生日等场景播放，并显示台词气泡。可在 **设置 → 语音** 调整音量、开关自动问候和勿扰、设置生日。

### 点击摸头与戳戳

左键轻点头部是摸头，轻点身体是戳戳，会触发表情，配有 **18 句互动语音**。头部与身体共用点击计数，3 秒内第 5 次点击会让她假装生气。可在 **设置 → 互动** 独立开关，拖动和缩放不受影响。

### 鼠标流光

在“互动”页开启 **鼠标流光**，鼠标在桌面移动时会留下所选轨迹。它与点击互动是两个独立开关，默认均开启；流光始终穿透鼠标操作，不抢输入焦点。

| 样式 | 效果 |
| --- | --- |
| 粉色流光 | 默认的细粉色光线 |
| 紫粉绸光 | 较粗的紫色前端，沿移动路径渐变为玫粉色细尾 |
| 星尘尾迹 | 闪点配合短光丝 |

**轨迹保留时间支持 0.1–5 秒的小数，默认 0.6 秒。** 可直接输入 `1.3`、`2.5` 等秒数，或使用步长为 0.1 秒的滑条；“默认”恢复 0.6 秒。关闭流光时也能预选样式和时长，重新开启后生效。切换样式、修改时长或关闭流光会立即清除旧轨迹。

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

需要 **Windows、Node.js 22 或更新版本**。源码维护在 `main`；仓库中的 EXE 使用 Git LFS，克隆完整程序需安装 Git LFS。浏览器检查使用 Microsoft Edge。

```powershell
git lfs install
git clone --branch main https://github.com/ActorF/Elysia_desktop_pet.git
cd Elysia_desktop_pet
git lfs pull
npm ci
npm start
```

`npm test` 运行单元测试。`npm run make:release` 生成安装版与便携版，构建前需准备 `build-resources/voice-bootstrap/` 中的语音资源。完整测试、打包与 GitHub Actions 说明见[验证说明](docs/verification.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `electron/` | 桌面窗口、聊天服务、模型准备、语音调度、托盘与设置保存 |
| `renderer/` | 角色绘制、聊天与设置界面、互动、字幕和鼠标流光 |
| `assets/` | 角色素材、托盘图标及已确认的 54 条录音 |
| `scripts/`、`tests/` | 启动、构建、预览与自动检查 |
| `docs/` | 预览图、更新与验证说明 |
| `release/` | 安装版、便携版与 SHA256 |

项目使用 Electron 透明窗口、PNG 素材合成与 WebGL 网格动画。WebGL 不可用时显示静态合成角色。

## 授权与版权

代码采用 [MIT License](LICENSE)。本项目是基于联动原画的非官方二次创作；爱莉希雅、《崩坏3》及相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有，CoCo 都可品牌权利归其权利人所有。

语音为合成录音，并非游戏官方原声。MIT 代码许可不授予角色、品牌、声音身份或其他第三方素材的权利。素材、模型与运行库的来源及许可见[版权说明](ASSET-NOTICE.md)。
