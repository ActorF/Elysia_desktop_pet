<h1 align="center">Elysia Desktop Pet</h1>

<p align="center">Elysia_desktop_pet · A little Elysia for your desktop</p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

**Current stable version: 1.4.2.** Expressions, outfits, click interactions, daily voice lines, local chat, and optional read-aloud replies. The app manages its own chat backend; Ollama is not required.

<p align="center"><img src="docs/media/character.png" width="320" alt="Full-body overview of Elysia Desktop Pet"></p>

## Download

| Edition | Program | Checksum |
| --- | --- | --- |
| **1.4.2 installer** | [Download installer](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2-setup.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2-setup.exe.sha256) |
| **1.4.2 portable** | [Download EXE](https://media.githubusercontent.com/media/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2.exe) | [SHA256](https://raw.githubusercontent.com/ActorF/Elysia_desktop_pet/main/release/Elysia_desktop_pet-1.4.2.exe.sha256) |
| 1.3.0 portable | [Download older EXE](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe) | [SHA256](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.3.0/Elysia_desktop_pet-1.3.0.exe.sha256) |

For **Windows x64**. Follow the installer or double-click the portable EXE; Git and Node.js are not needed. Both 1.4.2 editions have the same features.

**1.3.0 has no chat or reply read-aloud.** It retains daily and interaction recordings and does not download chat or speech synthesis models.

Exit the old version from the tray before upgrading. Position, size, outfits, username, chat history, and preferences are preserved. The app is unsigned; use the SHA256 links above to check downloaded files.

## Quick start

| Action | Result |
| --- | --- |
| Hold the left mouse button on the character and drag | Move the pet |
| Left-click the head / body | Head pat / poke; too many clicks trigger a playful angry response |
| Hold the right mouse button on the character and scroll | Resize the pet |
| Click or right-click the system tray icon | Open settings, open chat, or quit |
| Ctrl + Alt + P | Bring the pet back and disable click-through |

In **Settings → Appearance (外观)**, choose expressions, cat mode, glasses, and four actions. **Animation (动画)** controls gaze, motion, and typing clouds; **Desktop (桌面)** controls topmost behavior, taskbar order, and click-through.

**Interaction (互动)** has separate switches for click responses and cursor trails, with three trail styles. **Voice (语音)** controls daily greetings, volume, Do not disturb, and birthdays. The app includes 36 daily recordings and 18 interaction recordings.

## Local chat and read-aloud

1. **The first launch needs internet access to prepare models.** Check progress, cancel, or retry in Settings → Chat (聊天). Downloads are about 5.8 GB for chat and 5.7 GB for the speech runtime archive; extraction requires additional disk space.
2. Choose **Open chat (打开聊天框)** from the tray. Enter sends a message; Shift + Enter adds a line. Set your preferred name in Settings → Chat.
3. Automatic read-aloud is **off by default**. Click **Read Aloud / 朗读** under a reply to read that message, or enable automatic reading in chat settings.

The first speech model load may take a while. Do not disturb, mute, screen lock, and sleep pause reading; a failed request shows the reason.

The default model runs locally, and conversations are stored on your computer. View or delete them in **Settings → Chat history (聊天记录)**. Prepared models are reused on later launches, and the chat service starts and stops with the app.

## More information

- [1.4.2 release notes](docs/releases/v1.4.2.md): improvements, upgrades, and model resources.
- [Verification and build guide](docs/verification.md): source setup, tests, packaging, and GitHub Actions; currently in Chinese.
- [Character persona](electron/chat-persona.md): the persona text used by the app.
- [1.3.0 release page](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.3.0): the older version and its downloads.

## License and credits

Code uses the [MIT License](LICENSE). This is an unofficial fan project based on collaboration artwork. Elysia, *Honkai Impact 3rd*, and related characters and brands belong to miHoYo / HoYoverse and their rights holders; CoCo Fresh Tea & Juice belongs to its rights holders.

The synthesized recordings are not official game audio. The code license does not grant rights to characters, brands, voice identities, or other third-party assets. See the [asset notice](ASSET-NOTICE.md) for artwork, model, and runtime sources and licenses.
