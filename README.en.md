<h1 align="center">Elysia Desktop Pet</h1>

<p align="center">Elysia_desktop_pet · A little Elysia for your desktop</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center"><a href="#download">Download</a> · <a href="#character-gallery">Gallery</a> · <a href="#usage">Usage</a> · <a href="#run-from-source">Run from source</a></p>

A chibi Elysia companion for Windows, with a transparent full-body character, mouse-following eyes, and gentle motion. Mix expressions, cat mode, glasses, and four actions, with little clouds that respond to your typing. Version 1.3.0 adds daily voice lines, click interactions, speech bubbles, and three cursor trails.

## Download

**[Download for Windows · Portable Release 1.2.0](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.2.0/Elysia_desktop_pet-1.2.0.exe)**

[Release notes](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.2.0) · [SHA256 checksum](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.2.0/Elysia_desktop_pet-1.2.0.exe.sha256)

**The latest published portable download is 1.2.0; this repository's source is now 1.3.0.** Version 1.3.0 adds 36 daily voice lines, 18 interaction voice lines, speech bubbles of up to two lines, and three cursor trails with adjustable duration. Use the [source and build instructions](#run-from-source) below. See the [1.3.0 changes](docs/releases/v1.3.0.md) or the historical [1.2.0 notes](docs/releases/v1.2.0.md).

Download and double-click the EXE to run; no Node.js installation is needed. Before upgrading, quit the old version from the tray. Version 1.2.0 keeps your position, size, outfit switches, and preferences without manual migration.

<details>
<summary>Download warnings and files ending in .crdownload</summary>

The app is currently unsigned. If Microsoft Edge says the file “isn't commonly downloaded,” check that it came from this repository's release page. In the downloads list, choose **⋯ → Keep → Show more → Keep anyway**, then wait for the download to finish. See [Microsoft's instructions](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/download-failures#check-security-and-smartscreen-settings).

**If the download has fully completed but the file is still named `Unconfirmed <number>.crdownload`, you can rename it to use the `.exe` extension.** Enable **File name extensions** in File Explorer, then change the complete filename to **`Elysia_desktop_pet-1.2.0.exe`**. Remove the trailing `.crdownload` entirely.

This only applies to a file that has finished downloading. If the download is still running or was interrupted, complete it first; renaming an incomplete file does not finish the download.

</details>

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

A pale pink-and-white cloud shows a single character above her hand during Idle, Cake, and Bubble tea. With Megaphone selected, it floats outward from the horn with illustrated sound waves, fading within about a second.

![Key clouds during idle, megaphone, cake, and milk tea actions](docs/media/key-cloud.png)

<p align="center"><a href="docs/media/megaphone-key-cloud.webm">Watch the megaphone key effect</a> · Visual effect only, no sound</p>

## Usage

### Mouse and system tray

| Control | What it does |
| --- | --- |
| Hold the left mouse button on the character and drag | Move her freely, including partly beyond any edge of the screen |
| Left-click her head or body | Pat her head or poke her; the fifth click across both areas within three seconds triggers an annoyed response |
| Hold the right mouse button on the character and scroll | Scroll up to enlarge or down to shrink; starts at 1% with no fixed upper size limit |
| Click or right-click the system tray icon | Open a menu with just Settings (`设置`) and Quit (`退出`) |
| Choose Settings (`设置`) | Open a separate settings window while the pet stays visible |
| Choose Bring back (`找回桌宠`) at the bottom of Settings, or press `Ctrl + Alt + P` | Bring her back into view and turn off click-through |
| Choose Restore size and bring back (`恢复大小并找回`) at the bottom of Settings | Restore 100% size and bring her back onto the screen |
| Choose Quit (`退出`) in the tray | Close the entire app |

Transparent space around the character lets clicks pass through to the windows behind her. Scrolling alone does not resize her, and right-clicking the character does not open Settings.

The new tray icon is a pink emblem on a transparent background. Position, size, and preferences are saved automatically.

Version 1.3.0 stores release preferences in `%APPDATA%/Elysia Desktop Pet/` and keeps existing settings and position. If a local 1.3 sample was used previously, missing new options and voice history are imported from its profile without replacing values already present in the release profile.

### Settings window

Settings and the pet stay on screen together, and you can move or resize the window independently. Drag its empty header area to move it. The three standard icons at the top right minimize, maximize/restore, and close the window. Closing Settings leaves the pet running. Version 1.3.0 has five tabs: **Appearance, Animation, Desktop, Interaction, and Voice**.

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
- **Voice (`语音`):** control automatic greetings, Do not disturb, volume, and birthday month/day, and view playback status. The release UI has no sample audition or simulated-trigger tools.

| Animation parameter | Range | Default |
| --- | --- | --- |
| Eye follow strength (`眼睛跟随幅度`) | 0–200% | 100% |
| Sway amplitude (`摆动幅度`) | 0–200% | 100% |
| Sway speed (`摆动速度`) | 0.25–3× | 1× |

Eye tracking keeps the original effect at its default strength: 0% removes the deformation, while 200% strengthens it. The upper and lower parts sway in the same direction; 0% amplitude stops the sway. Turning either feature off and back on keeps its values.

Enable Always on top (`始终置顶`) to choose Taskbar in front (`任务栏在前`) or Pet in front (`桌宠在前`); Pet in front is the default. Settings remains usable while the pet is in click-through mode, and the buttons at the bottom can bring her back at any time.

### Daily voices and speech bubbles

**36 daily voice lines** cover 12 situations, including morning/evening greetings, mealtimes, returning to the computer, breaks, weekends, birthdays, and saying goodbye. Each group has three alternatives, played one at a time according to local time and activity. Automatic greetings are at least 20 minutes apart and limited to six per day; birthday greetings and deliberate exits are counted separately. Locking, sleep, fullscreen apps, and Do not disturb pause automatic greetings; missed occasions are not replayed later. See the [release notes](docs/releases/v1.3.0.md) for the conditions.

Speech appears in a **white bubble with a pink border**, showing the complete text in at most two lines. Its size follows the sentence length. The bubble appears to her left when she is in the right half of the current display, and to her right when she is in the left half. It follows dragging and resizing, and remains for about 1.2 seconds after the recording ends.

Use the Voice tab to adjust volume, enable Do not disturb, or save a birthday month and day locally; no year is required. Quitting from the tray may play a goodbye first. Choose Quit again to skip it; closing Settings does not trigger a goodbye.

### Head pats and pokes

With **Click interactions (`点击互动`)** enabled, left-click her head or fringe for a head pat and a blush, or click her body for a poke and a surprised expression. **Head and body clicks share a counter: the fifth click within three seconds triggers an annoyed response**, followed by a three-second cooldown. Dragging and right-button scrolling do not count as clicks. No held-button stroking gesture is needed.

Each interaction has six alternatives, for **18 interaction voice lines** in total. Rapid clicks are combined; a voice already playing can finish, and at most one annoyed response waits behind it. Expired responses are discarded. Daily and interaction voices share playback control so recordings do not overlap. Temporary expressions restore the previous expression when finished.

Click interactions and automatic daily greetings have separate controls. Turning click interactions off clears their current audio, captions, and pending response, while dragging, resizing, and daily greetings remain available. With Do not disturb enabled or volume set to zero, clicks still produce expressions and text.

### Cursor trails

Enable **Cursor trail (`鼠标流光`)** in the Interaction tab to leave a trail while moving the mouse across the desktop. Cursor trails and click interactions are independent and enabled by default. The overlay lets clicks through and does not take keyboard focus.

| Style | Appearance |
| --- | --- |
| Pink glow (`粉色流光`) | The default fine pink line |
| Purple-pink ribbon (`紫粉绸光`) | A thick purple head fading along the path into a thin rose-pink tail |
| Stardust (`星尘尾迹`) | Small sparkles with short light strands |

**Trail duration accepts decimal values from 0.1 to 5 seconds; the default is 0.6 seconds.** Enter a value such as `1.3` or `2.5`, or use the slider in 0.1-second steps. Default (`默认`) restores 0.6 seconds. You can choose a style and duration while the trail is off. Changing either value or turning the trail off immediately clears the old trail, and preferences are saved automatically.

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

Requires **Windows and Node.js 22 or later**. Clone the repository, install dependencies, and start the app. Browser-based visual checks also require Microsoft Edge.

```powershell
git clone https://github.com/ActorF/Elysia_desktop_pet.git
cd Elysia_desktop_pet
npm ci
npm start
```

Run checks and build the portable app:

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
npm run make:portable
node scripts/verify-package.cjs
```

The build creates `release/Elysia_desktop_pet-1.3.0.exe`. Use `npm run package` for an unpacked application directory. See the [verification guide](docs/verification.md) for additional checks; the guide is currently in Chinese.

## Project structure

| Path | Contents |
| --- | --- |
| `electron/` | Pet, settings, speech and trail windows; voice scheduling, system tray, global shortcuts, dragging, resizing, and saved settings |
| `renderer/` | Character drawing, expressions, actions, click interactions, captions, cursor trails, and settings UI |
| `assets/character/` | Character artwork required by the app |
| `assets/ui/` | System tray icon |
| `assets/voice/`, `assets/interaction-voice/` | 36 daily recordings, 18 interaction recordings, and checksum manifests |
| `scripts/` | Launch, package verification, and preview tools |
| `tests/` | Automated tests |
| `docs/` | Character previews, release notes, and verification documentation |
| `release/` | Locally generated Windows portable app |
| `LICENSE` | MIT license for the code |

The app uses an Electron transparent window, composited PNG artwork, and WebGL mesh animation. When WebGL is unavailable, it displays the statically composited character.

## License & credits

Code uses the [MIT License](LICENSE). Elysia, *Honkai Impact 3rd*, and related characters and brands belong to miHoYo / HoYoverse and their rights holders; CoCo Fresh Tea & Juice belongs to its rights holders. This is an unofficial fan project. Its synthesized recordings are not official game audio, and the code license does not grant character, brand, or related voice rights. See the [asset notice](ASSET-NOTICE.md).
