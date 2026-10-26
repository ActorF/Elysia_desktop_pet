<h1 align="center">爱莉希雅桌宠</h1>

<p align="center">Elysia_desktop_pet · 陪在桌面上的 Q 版爱莉希雅</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

**当前正式版本：1.4.2。** 支持表情与装扮、点击互动、日常语音、本地聊天和回复朗读。聊天后台由桌宠自动管理，无需安装 Ollama。

<p align="center"><img src="docs/media/character.png" width="320" alt="爱莉希雅桌宠全身概览"></p>

## 下载

| 版本 | 程序 | 校验 |
| --- | --- | --- |
| **1.4.2 安装版** | [下载安装器](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2-setup.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2-setup.exe.sha256) |
| **1.4.2 便携版** | [下载 EXE](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2.exe.sha256) |
| 1.3.0 便携版 | [下载旧版 EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe) | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe.sha256) |

适用于 **Windows x64**。安装版按提示安装；便携版双击即可运行，无需 Git 或 Node.js。两种 1.4.2 程序功能相同。

**1.3.0 不含聊天及回复朗读**，保留日常与点击互动录音，无需下载聊天或语音合成模型。

升级前先从托盘退出旧版，再打开或安装新版。已有位置、大小、装扮、用户名、聊天记录与偏好会保留。程序未进行数字签名，可用上方 SHA256 核对下载文件。

## 快速上手

| 操作 | 功能 |
| --- | --- |
| 左键按住人物并拖动 | 移动桌宠 |
| 左键轻点头部／身体 | 摸头／戳戳；连续点击太多会假装生气 |
| 按住人物上的右键＋滚轮 | 放大或缩小 |
| 点击或右键右下角托盘图标 | 打开设置、聊天框或退出程序 |
| Ctrl + Alt + P | 找回桌宠并关闭点击穿透 |

在 **设置 → 外观** 选择表情、猫猫、眼镜及四种动作；**动画** 页调整目光跟随、摆动和按键云朵；**桌面** 页调整置顶、任务栏顺序和穿透。

**互动** 页分别控制点击互动与鼠标流光，提供三种轨迹样式。**语音** 页管理日常问候、音量、勿扰和生日；内置 36 条日常录音与 18 条互动录音。

## 本地聊天与朗读

1. **首次启动需要联网准备模型。** 在“设置 → 聊天”查看进度，可取消或重试。需下载约 5.8 GB 聊天模型和 5.7 GB 语音环境包，解压还需额外磁盘空间。
2. 从托盘选择 **打开聊天框**。Enter 发送、Shift + Enter 换行；在“设置 → 聊天”修改称呼你的名字。
3. 自动朗读**默认关闭**。点击回复下方的 **Read Aloud／朗读** 可单独朗读这一条，也可在聊天设置中开启自动朗读。

首次加载语音模型可能较慢。勿扰、静音、锁屏或休眠时会暂停朗读；失败提示会说明具体原因。

默认使用本机模型，聊天记录保存在本机，可在 **设置 → 聊天记录** 查看和删除。已准备的模型会在下次打开桌宠时复用，聊天服务随程序启动和退出。

## 更多说明

- [1.4.2 更新说明](docs/releases/v1.4.2.md)：本次改进、升级和模型资源说明。
- [验证与构建说明](docs/verification.md)：源码运行、测试、打包及 GitHub Actions。
- [角色人设](electron/chat-persona.md)：程序使用的人设文本。
- [1.3.0 发布页](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0)：旧版下载与说明。

## 授权与版权

代码采用 [MIT License](LICENSE)。本项目是基于联动原画的非官方二次创作；爱莉希雅、《崩坏3》及相关角色与品牌权利归 miHoYo / HoYoverse 及其权利人所有，CoCo 都可品牌权利归其权利人所有。

语音为合成录音，并非游戏官方原声。MIT 代码许可不授予角色、品牌、声音身份或其他第三方素材的权利。素材、模型与运行库的来源及许可见[版权说明](ASSET-NOTICE.md)。
