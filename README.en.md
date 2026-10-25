<h1 align="center">Elysia Desktop Pet</h1>

<p align="center">Elysia_desktop_pet · A little Elysia for your desktop</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center"><a href="#download">Download</a> · <a href="#character-gallery">Gallery</a> · <a href="#usage">Usage</a> · <a href="#run-from-source">Run from source</a></p>

A chibi Elysia companion for Windows, with a transparent full-body character, mouse-following eyes, and gentle motion. Mix expressions, cat mode, glasses, and four actions, with little clouds that respond to your typing.

## Download

**[Download for Windows · Published Portable Release 1.1.0](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.1.0/Elysia_desktop_pet-1.1.0.exe)**

[Release notes](https://github.com/ActorF/Elysia_desktop_pet/releases/tag/v1.1.0) · [SHA256 checksum](https://github.com/ActorF/Elysia_desktop_pet/releases/download/v1.1.0/Elysia_desktop_pet-1.1.0.exe.sha256)

**Version 1.2.0 has been merged into `main`.** The main branch includes the independent settings window, adjustable sway amplitude and speed, eye-follow strength, and taskbar layering. See the [1.2.0 changes](docs/releases/v1.2.0.md).

The EXE currently available on GitHub Releases is still **1.1.0**; a 1.2.0 EXE has not been published yet. To use 1.2.0, [run `main` from source](#run-from-source) or build the portable app using the instructions below.

Download and double-click the EXE to run; no Node.js installation is needed. Before upgrading, quit the old version from the tray. Version 1.2.0 keeps your position, size, outfit switches, and preferences without manual migration.

<details>
<summary>Download warnings and files ending in .crdownload</summary>

The app is currently unsigned. If Microsoft Edge says the file “isn't commonly downloaded,” check that it came from this repository's release page. In the downloads list, choose **⋯ → Keep → Show more → Keep anyway**, then wait for the download to finish. See [Microsoft's instructions](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/download-failures#check-security-and-smartscreen-settings).

**If the download has fully completed but the file is still named `Unconfirmed <number>.crdownload`, you can rename it to use the `.exe` extension.** Enable **File name extensions** in File Explorer, then change the complete filename to **`Elysia_desktop_pet-1.1.0.exe`**. Remove the trailing `.crdownload` entirely.

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

These instructions describe **version 1.2.0 on `main`**. The downloadable 1.1.0 release still uses its original tray menus.

### Mouse and system tray

| Control | What it does |
| --- | --- |
| Hold the left mouse button on the character and drag | Move her freely, including partly beyond any edge of the screen |
| Hold the right mouse button on the character and scroll | Scroll up to enlarge or down to shrink; starts at 1% with no fixed upper size limit |
| Click or right-click the system tray icon | Open a menu with just Settings (`设置`) and Quit (`退出`) |
| Choose Settings (`设置`) | Open a separate settings window while the pet stays visible |
| Choose Bring back (`找回桌宠`) at the bottom of Settings, or press `Ctrl + Alt + P` | Bring her back into view and turn off click-through |
| Choose Restore size and bring back (`恢复大小并找回`) at the bottom of Settings | Restore 100% size and bring her back onto the screen |
| Choose Quit (`退出`) in the tray | Close the entire app |

Transparent space around the character lets clicks pass through to the windows behind her. Scrolling alone does not resize her, and right-clicking the character does not open Settings.

The new tray icon is a pink emblem on a transparent background. Position, size, and preferences are saved automatically.

### Settings window

**Version 1.2.0 adds a separate settings window.** Settings and the pet stay on screen together, and you can move or resize the window independently. Drag its empty header area to move it. The three standard icons at the top right minimize, maximize/restore, and close the window. Closing Settings leaves the pet running.

<table>
  <tr><th>Appearance</th><th>Animation</th><th>Desktop</th></tr>
  <tr>
    <td><a href="docs/media/settings-appearance.png"><img src="docs/media/settings-appearance.png" width="280" alt="Appearance settings: expressions, outfits, and actions"></a></td>
    <td><a href="docs/media/settings-animation.png"><img src="docs/media/settings-animation.png" width="280" alt="Animation settings: eye tracking, sway, and key clouds"></a></td>
    <td><a href="docs/media/settings-desktop.png"><img src="docs/media/settings-desktop.png" width="280" alt="Desktop settings: size, taskbar order, and shortcuts"></a></td>
  </tr>
</table>

Click a screenshot to view it at full size. The app currently uses Chinese labels.

- **Appearance (`外观`):** choose expressions, cat mode, glasses, and one of four actions. Keyboard shortcuts also update the window.
- **Animation (`动画`):** toggle eye tracking, sway, and key clouds. Adjust the parameters below with sliders or number fields, or restore their defaults.
- **Desktop (`桌面`):** change character size, always-on-top behavior, taskbar order, click-through, and shortcuts. Enter a size percentage starting at 1%, with no fixed upper size limit.

| Animation parameter | Range | Default |
| --- | --- | --- |
| Eye follow strength (`眼睛跟随幅度`) | 0–200% | 100% |
| Sway amplitude (`摆动幅度`) | 0–200% | 100% |
| Sway speed (`摆动速度`) | 0.25–3× | 1× |

Eye tracking keeps the original effect at its default strength: 0% removes the deformation, while 200% strengthens it. The upper and lower parts sway in the same direction; 0% amplitude stops the sway. Turning either feature off and back on keeps its values.

Enable Always on top (`始终置顶`) to choose Taskbar in front (`任务栏在前`) or Pet in front (`桌宠在前`); Pet in front is the default. Settings remains usable while the pet is in click-through mode, and the buttons at the bottom can bring her back at any time.

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

Requires **Windows and Node.js 22 or later**. Clone the `main` branch to run 1.2.0. Browser-based visual checks also require Microsoft Edge.

```powershell
git clone --branch main https://github.com/ActorF/Elysia_desktop_pet.git
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
npm run make:portable
node scripts/verify-package.cjs
```

The build creates `release/Elysia_desktop_pet-1.2.0.exe`. Use `npm run package` for an unpacked application directory. See the [verification guide](docs/verification.md) for additional checks; the guide is currently in Chinese.

## Project structure

| Path | Contents |
| --- | --- |
| `electron/` | Transparent pet window, independent settings window, system tray, global shortcuts, key display input, dragging, resizing, and saved settings |
| `renderer/` | Character drawing, expressions and actions, eye tracking, motion, key cloud effects, and settings UI |
| `assets/character/` | Character artwork required by the app |
| `assets/ui/` | System tray icon |
| `scripts/` | Launch, package verification, and preview tools |
| `tests/` | Automated tests |
| `docs/` | Character previews, release notes, and verification documentation |
| `release/` | Locally generated Windows portable app |
| `LICENSE` | MIT license for the code |

The app uses an Electron transparent window, composited PNG artwork, and WebGL mesh animation. When WebGL is unavailable, it displays the statically composited character.

## License & credits

Code uses the [MIT License](LICENSE). Elysia, *Honkai Impact 3rd*, and related characters and brands belong to miHoYo / HoYoverse and their rights holders; CoCo Fresh Tea & Juice belongs to its rights holders. This is an unofficial fan project, and the code license does not grant rights to these characters or brands. See the [asset notice](ASSET-NOTICE.md).
