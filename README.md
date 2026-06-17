<a id="readme-top"></a>

<br />
<div align="center">
  <a href="https://github.com/Kc1t/alethe-agents">
    <img src="./src/assets/alethe-logo.png" alt="Alethe Logo" width="160">
  </a>

  <h3 align="center">Alethe</h3>

  <p align="center">
    Reveal the state of every agent, shell, and project.
    <br />
    Built by Kc1t
    <br />
    <a href="https://github.com/Kc1t/alethe-agents/issues">Report Bug</a>
    ·
    <a href="https://github.com/Kc1t/alethe-agents/issues">Request Feature</a>
  </p>
</div>

> [!IMPORTANT]
> Alethe is an early public release. The desktop app is free and local-first. Optional hosted services, such as sync or cloud backup, may be offered separately later.

<div align="center">
  <img src="./docs/assets/alethe-preview.gif" alt="Alethe desktop workspace preview" width="760">
</div>

## About

**Alethe** is a desktop workspace for running and resuming multiple coding agents and shells in parallel. It combines projects, groups, containers, split panes, terminal sub-tabs, real PTYs, local history, session resume, and memory controls in one app.

It is built for people working with Claude Code, Codex, OpenCode, and local terminals across multiple projects.

Built with Tauri, Rust, React, TypeScript, Vite, `portable-pty`, and `xterm.js`.

## Features

- Project and group based workspace.
- Real terminal processes through a Rust PTY backend.
- Split-pane containers with automatic, spotlight, sidebar, and custom grid layouts.
- Multiple sub-tabs per terminal for agents or shells.
- Persisted local projects, layouts, scrollback, sessions, and preferences.
- Close containers without killing running processes.
- Suspend groups to free memory.
- Local backup export/import.
- Spotify Now Playing through the user's own Spotify app credentials.
- Experimental Agent Planning / Agent Canvas.
- GitHub Actions release workflow for Windows, Linux, and macOS.

## Installation

Use the published installers from **Releases**, or run/build from source:

```sh
git clone https://github.com/Kc1t/alethe-agents.git
cd alethe-agents
npm install

# run the desktop app in development mode
npm run app

# run only the frontend in the browser
npm run dev

# build the frontend
npm run build

# build the desktop app/installers
npm run tauri -- build
```

Build artifacts are written to:

```text
src-tauri/target/release/bundle/
```

### Requirements

- Node.js 18+
- Rust stable
- Windows 10/11, Linux, or macOS
- Visual Studio Build Tools on Windows
- Tauri system dependencies on Linux

Linux dependencies:

```sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Spotify

To use Now Playing, create an app in the Spotify Developer Dashboard and register this Redirect URI:

```text
http://127.0.0.1:8888/callback
```

Then add your `Client ID` and `Client Secret` in **Preferences > Spotify**.

For local development, a `.env` file can also provide:

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

## Releases

The release workflow builds installers for:

- Windows x64
- Linux x64
- macOS Apple Silicon
- macOS Intel

Create a release from a tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

> [!NOTE]
> macOS builds distributed outside the App Store should be signed and notarized with an Apple Developer certificate. Without that, users may see an unidentified developer warning.

## Roadmap

- [x] Workspace with projects, groups, and containers.
- [x] Real PTYs with spawn, attach, resize, and scrollback.
- [x] Automatic layouts and custom grid.
- [x] Sub-tabs per terminal.
- [x] Local Windows build.
- [x] GitHub Actions for Windows, Linux, and macOS.
- [ ] Windows release signing.
- [ ] macOS notarization.
- [ ] Linux/macOS validation on real machines.
- [ ] Visual documentation with screenshots/GIFs.
- [ ] Optional cloud sync/backup.
- [ ] Agent marketplace/library.

## License

The source code is distributed under **AGPL-3.0-or-later**. See [`LICENSE`](LICENSE) for details.

Official hosted services, such as sync, backup, billing, or cloud features, may be proprietary and offered separately.

The **Alethe** name, logo, and official branding are reserved for official builds. See [`TRADEMARK.md`](TRADEMARK.md).

## Contact

Kauã Miguel

- Portfolio: <https://kc1t.com>
- GitHub: <https://github.com/Kc1t>
- Project: <https://github.com/Kc1t/alethe-agents>

<p align="right">(<a href="#readme-top">Back to top</a>)</p>
