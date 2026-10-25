<h1 align="center">爱莉希雅桌宠</h1>

<p align="center">Elysia_desktop_pet · 陪在桌面上的 Q 版爱莉希雅</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center"><a href="#下载程序">下载程序</a> · <a href="#角色展示">角色展示</a> · <a href="#使用">使用说明</a> · <a href="#源码运行">源码运行</a></p>

透明全身立绘、鼠标目光跟随、轻柔摆动。表情、猫猫形态、眼镜和四种动作可以自由搭配，输入字符时还有小云朵回应。

## 下载程序

**[下载 Windows 便携版 · 1.2.0](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.2.0/Elysia_desktop_pet-1.2.0.exe)**

[更新说明](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.2.0) · [SHA256 校验文件](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.2.0/Elysia_desktop_pet-1.2.0.exe.sha256)

**1.2.0 新增：** 独立设置窗口，自由调节摆动幅度、摆动速度和眼睛跟随幅度，还能选择让任务栏或桌宠显示在前面。详见 [1.2.0 更新说明](docs/releases/v1.2.0.md)。

下载后双击 EXE 即可运行，无需安装 Node.js。升级前先从右下角托盘退出旧版；1.2.0 会保留已有的位置、大小、装扮开关和偏好，无需手动迁移。

<details>
<summary>下载提示与文件后缀</summary>

**下载提示：** 当前版本未进行数字签名。如果 Edge 提示“isn't commonly downloaded（不常下载）”，确认文件来自本仓库发布页后，在下载列表选择 **⋯ → 保留 → 显示更多 → 仍然保留**，等待下载完成。[微软操作说明](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/download-failures#check-security-and-smartscreen-settings)

**下载完成后，如果文件仍叫 `Unconfirmed 数字.crdownload`，可以将后缀改为 `.exe` 使用。** 先在文件资源管理器中显示“文件扩展名”，再将完整文件名改为 **`Elysia_desktop_pet-1.2.0.exe`**，不要保留末尾的 `.crdownload`。此操作只适用于已经完整下载的文件；仍在下载或下载中断时，请先完成下载。

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
| 按住人物上的鼠标右键＋滚轮 | 向上放大、向下缩小，从 1% 起持续放大 |
| 点击或右键右下角托盘图标 | 打开只有“设置”和“退出”两项的菜单 |
| 托盘“设置” | 打开独立设置窗口，桌宠继续显示 |
| 设置窗口底部“找回桌宠”或 `Ctrl + Alt + P` | 找回人物并关闭点击穿透 |
| 设置窗口底部“恢复大小并找回” | 恢复 100% 大小并将人物带回屏幕 |
| 托盘“退出” | 退出整个程序 |

人物外的透明区域可直接点击后方窗口。普通滚轮不会缩放，右键人物也不会弹出设置窗口。

新版使用透明底粉色托盘图标。位置、大小和偏好会自动保存。

### 设置窗口

**1.2.0 新增独立设置窗口。** 设置和人物可以同时显示，窗口可单独移动、调整大小。拖动顶部空白处移动窗口，右上角三个标准图标分别是最小化、最大化／还原和关闭。关闭设置窗口后，桌宠会继续运行。

<table>
  <tr><th>外观</th><th>动画</th><th>桌面</th></tr>
  <tr>
    <td><a href="docs/media/settings-appearance.png"><img src="docs/media/settings-appearance.png" width="280" alt="外观设置：表情、装扮与动作"></a></td>
    <td><a href="docs/media/settings-animation.png"><img src="docs/media/settings-animation.png" width="280" alt="动画设置：目光跟随、摆动与按键云朵"></a></td>
    <td><a href="docs/media/settings-desktop.png"><img src="docs/media/settings-desktop.png" width="280" alt="桌面设置：大小、任务栏层级与快捷键"></a></td>
  </tr>
</table>

点击截图可查看大图。

- **外观：** 选择表情、猫猫和眼镜装扮、四种动作。快捷键切换后，窗口也会同步更新。
- **动画：** 开关目光跟随、摆动和按键云朵；用滑块或数值框调节下表参数，也可一键恢复默认。
- **桌面：** 调整人物大小、置顶、任务栏前后顺序、鼠标穿透和快捷键。大小支持直接输入百分比，从 1% 起，没有固定的放大上限。

| 动画参数 | 范围 | 默认值 |
| --- | --- | --- |
| 眼睛跟随幅度 | 0–200% | 100% |
| 摆动幅度 | 0–200% | 100% |
| 摆动速度 | 0.25–3× | 1× |

眼睛跟随默认保持原版效果，0% 关闭形变，200% 增强效果。摆动保持上下同向，幅度为 0% 时停止；关闭再开启对应开关会保留参数。

开启“始终置顶”后，可选择“任务栏在前”或“桌宠在前”，默认桌宠在前。即使人物开启鼠标穿透，设置窗口仍可操作，底部按钮可以随时找回人物。

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

需要 **Windows、Node.js 22 或更新版本**。克隆仓库后安装依赖并启动；浏览器视觉检查还需要 Microsoft Edge。

```powershell
git clone https://github.com/ActorF/Elysia_desktop_pet.git
cd Elysia_desktop_pet
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
npm run make:portable
node scripts/verify-package.cjs
```

构建后生成 `release/Elysia_desktop_pet-1.2.0.exe`。`npm run package` 可生成未封装的应用目录，更多检查见[验证说明](docs/verification.md)。

## 项目结构

| 目录或文件 | 内容 |
| --- | --- |
| `electron/` | 透明人物窗口、独立设置窗口、托盘、全局快捷键、拖动、缩放与设置保存 |
| `renderer/` | 人物绘制、表情与动作组合、目光跟随、摆动和设置界面 |
| `assets/character/` | 桌宠运行所需的角色素材 |
| `assets/ui/` | 托盘图标 |
| `scripts/` | 启动、构建验证与预览工具 |
| `tests/` | 自动测试 |
| `docs/` | 角色预览与验证说明 |
| `release/` | 本地生成的 Windows 便携版 |
| `LICENSE` | MIT 代码许可证 |

项目使用 Electron 透明窗口、PNG 素材合成与 WebGL 网格动画。WebGL 不可用时显示静态合成角色。

## 授权与版权

项目代码使用 [MIT License](LICENSE)。爱莉希雅、《崩坏3》相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有，CoCo 都可品牌权利归其权利人所有。本项目为非官方作品；MIT 代码许可不授予这些角色与品牌的权利。见[版权说明](ASSET-NOTICE.md)。
