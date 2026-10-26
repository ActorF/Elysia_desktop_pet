<h1 align="center">Elysia Desktop Pet</h1>

<p align="center">Elysia_desktop_pet · A little Elysia for your desktop</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center"><a href="#download">Download</a> · <a href="#character-gallery">Gallery</a> · <a href="#usage">Usage</a> · <a href="#run-from-source">Run from source</a></p>

A chibi Elysia companion for Windows, with a transparent full-body character, mouse-following eyes, and gentle motion. Mix expressions, cat mode, glasses, and four actions, with little clouds that respond to your typing. Includes local chat, optional read-aloud replies, automatic model setup, conversation history management, and body-region interactions. Version 1.4.2 switches to app-managed llama.cpp and fixes manual reading blocked by Windows busy-state detection.

**Current stable version: 1.4.2.** Includes fixes for manual speech reuse, long messages, and chat runtime dependencies. See the [1.4.2 release page](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.4.2) and [release notes](docs/releases/v1.4.2.md).

## Download

| Edition | Program | Features | Checksum |
| --- | --- | --- | --- |
| **1.4.2 Windows installer** | [Download installer](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2-setup.exe) | Includes chat and optional read-aloud replies | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2-setup.exe.sha256) |
| **1.4.2 Windows portable** | [Download EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2.exe) | Same features; double-click to run | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.4.2/Elysia_desktop_pet-1.4.2.exe.sha256) |
| 1.3.0 Windows portable | [Download older EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe) | **No chat or read-aloud replies**; daily and interaction recordings remain included | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe.sha256) |

For **Windows x64**. Follow the installer or double-click the portable EXE; Git, Git LFS, and Node.js are not needed. Version 1.3.0 does not download chat or speech synthesis models.

Quit the old version from its tray before installing or opening the new one. Position, size, outfits, username, chat history, and preferences are saved automatically in `%APPDATA%/Elysia Desktop Pet/` and retained when upgrading; no manual migration is needed.

The app is unsigned. Wait for the complete download and check its SHA256; download the file again if the transfer was interrupted.

[1.4.2 release page](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.4.2) · [1.3.0 release page](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0) · [Run from source](#run-from-source)

## Character gallery

### Full-body character

<p align="center">
  <img src="docs/media/character.png" alt="Full-body chibi Elysia" width="400">
</p>

<p align="center"><a href="docs/media/idle.webm">Watch the idle animation</a></p>

### Expressions

There are **11 facial states**: Neutral, Blush, Angry, Sleep, Surprised, Dizzy, Wink, Sad, Heart Eyes, Smile, and Awkward.

![Neutral face and ten selectable expressions](docs/media/expressions.en.png)

### Forms

Cat mode and glasses are independent switches. Use the original appearance, cat mode, glasses, or both together. Your choices stay active when you change expressions or actions, and after restarting the app.

![Original appearance, cat mode, glasses, and cat mode with glasses](docs/media/forms.en.png)

### Actions

Choose one of four actions: **Idle, Megaphone, Cake, or Bubble tea**. Changing an expression or outfit keeps the current action. The megaphone does not play sound.

![Idle, megaphone, eating cake, and drinking milk tea](docs/media/actions.en.png)

### Key clouds

Typing creates pale pink-and-white character clouds, with illustrated sound waves in the Megaphone action.

![Key clouds during idle, megaphone, cake, and milk tea actions](docs/media/key-cloud.png)

<p align="center"><a href="docs/media/megaphone-key-cloud.webm">Watch the megaphone key effect</a></p>

## Usage

### Mouse and system tray

| Control | What it does |
| --- | --- |
| Hold the left mouse button on the character and drag | Move her freely, including partly beyond any edge of the screen |
| Left-click her head or body | Pat her head or poke her |
| Hold the right mouse button on the character and scroll | Scroll up to enlarge or down to shrink; starts at 1% with no fixed upper size limit |
| Click or right-click the system tray icon | Open the menu for Settings (`设置`), Open chat (`打开聊天框`), and Quit (`退出`) |
| Choose Bring back (`找回桌宠`) at the bottom of Settings, or press `Ctrl + Alt + P` | Bring her back into view and turn off click-through |
| Choose Restore size and bring back (`恢复大小并找回`) at the bottom of Settings | Restore 100% size and bring her back onto the screen |

Transparent space around the character lets clicks pass through to the windows behind her. Scrolling alone does not resize her, and right-clicking the character does not open Settings.

### Settings window

Settings and the pet stay on screen together, and you can move or resize the window independently. Drag its empty header area to move it. The three standard icons at the top right minimize, maximize/restore, and close the window. Closing Settings leaves the pet running. There are seven tabs: **Appearance, Animation, Desktop, Interaction, Voice, Chat, and Chat history**.

<table>
  <tr><th>Appearance</th><th>Animation</th><th>Desktop</th></tr>
  <tr>
    <td><a href="docs/media/settings-appearance.png"><img src="docs/media/settings-appearance.png" width="280" alt="Appearance settings: expressions, outfits, and actions"></a></td>
    <td><a href="docs/media/settings-animation.png"><img src="docs/media/settings-animation.png" width="280" alt="Animation settings: eye tracking, sway, and key clouds"></a></td>
    <td><a href="docs/media/settings-desktop.png"><img src="docs/media/settings-desktop.png" width="280" alt="Desktop settings: size, taskbar order, and shortcuts"></a></td>
  </tr>
</table>

<table>
  <tr><th>Interaction</th><th>Voice</th></tr>
  <tr>
    <td><a href="docs/media/settings-interaction.png"><img src="docs/media/settings-interaction.png" width="420" alt="Interaction settings: click responses, cursor styles, and trail duration"></a></td>
    <td><a href="docs/media/settings-voice.png"><img src="docs/media/settings-voice.png" width="420" alt="Voice settings: automatic greetings, Do not disturb, volume, birthday, and playback status"></a></td>
  </tr>
</table>

Click a screenshot to view it at full size. The app currently uses Chinese labels.

- **Appearance (`外观`):** choose expressions, cat mode, glasses, and one of four actions. Keyboard shortcuts also update the window.
- **Animation (`动画`):** toggle eye tracking, sway, and key clouds. Adjust the parameters below with sliders or number fields, or restore their defaults.
- **Desktop (`桌面`):** change character size, always-on-top behavior, taskbar order, click-through, and shortcuts. Enter a size percentage starting at 1%, with no fixed upper size limit.
- **Interaction (`互动`):** toggle click responses and cursor trails independently, and choose the trail style and duration.
- **Voice (`语音`):** control automatic greetings, Do not disturb, volume, and birthday month/day, and view playback status.
- **Chat (`聊天`):** change your username, toggle automatic read-aloud, and check independent model and speech setup progress. Advanced options support a compatible chat service or speech environment.
- **Chat history (`聊天记录`):** select a conversation in the left list and read its messages on the right. Continue chatting, delete one conversation, or clear history after confirmation.

| Animation parameter | Range | Default |
| --- | --- | --- |
| Eye follow strength (`眼睛跟随幅度`) | 0–200% | 100% |
| Sway amplitude (`摆动幅度`) | 0–200% | 100% |
| Sway speed (`摆动速度`) | 0.25–3× | 1× |

Eye tracking keeps the original effect at its default strength: 0% removes the deformation, while 200% strengthens it. The upper and lower parts sway in the same direction; 0% amplitude stops the sway. Turning either feature off and back on keeps its values.

Enable Always on top (`始终置顶`) to choose Taskbar in front (`任务栏在前`) or Pet in front (`桌宠在前`); Pet in front is the default. Taskbar in front keeps the pet below the taskbar and above ordinary apps. Settings remains usable in click-through mode, and the buttons at the bottom can bring her back.

### Local chat and read-aloud

First launch needs internet access to prepare llama.cpp, the default Qwen chat model, and speech resources; Ollama is not required. The chat model is about **5.8 GB**, and the speech runtime download is about **5.7 GB**, with additional space needed for extraction. **Settings → Chat** shows separate progress, cancellation, and retry controls. Prepared resources are reused, and the chat service starts and stops with the pet.

Choose **Open chat (打开聊天框)** from the tray. Enter sends a message; Shift + Enter adds a line. Set your preferred name in **Settings → Chat**, and use the controls below messages to copy text.

Automatic read-aloud is **off by default**. Choose **Read Aloud / 朗读** under a reply to read only that message without changing the setting, or enable automatic reading in chat settings. The first speech model load may take a while; subsequent requests within a short interval reuse the loaded model.

Manual reading is not blocked by ordinary fullscreen or Windows busy-state detection. It still respects Do not disturb, mute, screen lock, and sleep, with specific failure messages. Automatic reading and daily greetings retain screen-state restrictions. Sending a new message, stopping, or closing chat cancels the current reading.

The default model and chat history stay on your computer. **Settings → Chat history (聊天记录)** lets you view, continue, or delete conversations after confirmation. Advanced custom services must support OpenAI-compatible streaming chat; choosing a remote address sends conversations to that service. The persona is in [electron/chat-persona.md](electron/chat-persona.md); model and upgrade details are in the [1.4.2 release notes](docs/releases/v1.4.2.md).

### Daily voices and speech bubbles

Elysia has **36 daily voice lines**, displayed in speech bubbles as she speaks. In **Settings → Voice (`语音`)**, adjust volume, enable Do not disturb, or save your birthday month and day.

### Head pats and pokes

Left-click her head for a pat or her body for a poke, with **18 recorded responses**. Both areas share a counter: the fifth click within three seconds makes her pretend to be annoyed. Toggle **Click interactions (`点击互动`)** in Settings → Interaction independently of daily voices and cursor trails; dragging and resizing remain available.

### Cursor trails

Enable **Cursor trail (`鼠标流光`)** in the Interaction tab to leave a trail while moving the mouse across the desktop. Cursor trails and click interactions are independent and enabled by default. The overlay lets clicks through and does not take keyboard focus.

| Style | Appearance |
| --- | --- |
| Pink glow (`粉色流光`) | The default fine pink line |
| Purple-pink ribbon (`紫粉绸光`) | A thick purple head fading along the path into a thin rose-pink tail |
| Stardust (`星尘尾迹`) | Small sparkles with short light strands |

**Trail duration accepts decimal values from 0.1 to 5 seconds; the default is 0.6 seconds.** Enter a value such as `1.3` or `2.5`, or use the slider in 0.1-second steps. Default (`默认`) restores 0.6 seconds. You can choose a style and duration while the trail is off. Changing either value or turning the trail off immediately clears the old trail.

Fast flicks, circles, and multiple displays are supported. Crossing displays or returning from lock/sleep starts a new path instead of connecting to an old point on another display or before the interruption.

### Key cloud behavior

A cloud displays **only the most recently typed character**. It supports `0–9`, `a–z`, `A–Z`, and English punctuation and symbols. A space is shown as `␣`. Letter case and symbols follow Shift and Caps Lock.

Enter, Ctrl, Tab, arrow keys, and other control keys are not displayed, nor are shortcuts using Ctrl, Alt, or the Windows key. Each new character replaces the previous one and disappears in about a second. Clouds fade above her hand in the regular actions; Megaphone sends them toward the upper left with illustrated sound waves. No sound is played.

Toggle **Key cloud** (`按键云朵`) in the Animation tab without affecting expression shortcuts. Input is used only for the immediate display and is never recorded or saved.

### Expression shortcuts

Hold **Space**, then press a number on either the number row or the numeric keypad. Triggering the same expression again restores the neutral face, while keeping the current action and outfit.

| Shortcut | Expression | Shortcut | Expression |
| --- | --- | --- | --- |
| Space + 1 | Blush | Space + 2 | Angry |
| Space + 3 | Sleep | Space + 4 | Surprised |
| Space + 5 | Dizzy | Space + 6 | Wink |
| Space + 7 | Sad | Space + 8 | Heart Eyes |
| Space + 9 | Smile | Space + 0 | Awkward |

### Outfit and action shortcuts

| Shortcut | Feature | Behavior |
| --- | --- | --- |
| Space + F1 | Cat mode | Toggle independently |
| Space + F2 | Glasses | Toggle independently |
| Space + F3 | Idle | Select this action |
| Space + F4 | Megaphone | Select this action |
| Space + F5 | Cake | Select this action |
| Space + F6 | Bubble tea | Select this action |
| Space + Backspace | Reset appearance | Restore the neutral face and Idle action; turn off cat mode and glasses |

Space shortcuts work while other windows are active and do not block those apps from receiving your keystrokes. You can disable them in Settings → Desktop (`桌面`), or enable the alternative **Ctrl + Alt + number / F key / Backspace** shortcuts. Expressions, outfits, and actions are also available directly in the Appearance (`外观`) tab.

## Run from source

Requires **Windows and Node.js 22 or later**. Source is maintained on `main`; repository EXEs use Git LFS, so install Git LFS when cloning the complete programs. Browser checks use Microsoft Edge.

```powershell
git lfs install
git clone --branch main https://github.com/ActorF/Elysia_desktop_pet.git
cd Elysia_desktop_pet
git lfs pull
npm ci
npm start
```

`npm test` runs unit tests. `npm run make:release` builds the installer and portable app; prepare the speech resources in `build-resources/voice-bootstrap/` first. Full testing, packaging, and GitHub Actions instructions are in the [verification guide](docs/verification.md), currently in Chinese.

## Project structure

| Path | Contents |
| --- | --- |
| `electron/` | Desktop windows, chat services, model setup, speech scheduling, tray, and saved settings |
| `renderer/` | Character rendering, chat/settings UI, interactions, captions, and cursor trails |
| `assets/` | Character artwork, tray icon, and 54 confirmed recordings |
| `scripts/`, `tests/` | Launch, packaging, previews, and automated checks |
| `docs/` | Preview images, release notes, and verification guide |
| `release/` | Installer, portable app, and SHA256 files |

The app uses Electron transparent windows, composited PNG artwork, and WebGL mesh animation. When WebGL is unavailable, it displays a statically composited character.

## License & credits

Code uses the [MIT License](LICENSE). This is an unofficial fan project based on collaboration artwork. Elysia, *Honkai Impact 3rd*, and related characters and brands belong to miHoYo / HoYoverse and their rights holders; CoCo Fresh Tea & Juice belongs to its rights holders.

The synthesized recordings are not official game audio. The code license does not grant rights to characters, brands, voice identities, or other third-party assets. See the [asset notice](ASSET-NOTICE.md) for artwork, model, and runtime sources and licenses.
