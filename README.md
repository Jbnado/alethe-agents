<a id="readme-top"></a>

<br />
<div align="center">
  <a href="https://github.com/Kc1t/alethe">
    <img src="./src/assets/alethe-mark.svg" alt="Alethe Logo" width="280" height="80">
  </a>

  <h3 align="center">Alethe</h3>

  <p align="center">
    Reveal the state of every agent, shell, and project.
    <br />
    Built by Kc1t
    <br />
    <a href="./docs/OVERVIEW.md">Overview</a>
    ·
    <a href="./docs/FEATURES.md">Features</a>
    ·
    <a href="https://github.com/Kc1t/alethe/issues">Report Bug</a>
    ·
    <a href="https://github.com/Kc1t/alethe/issues">Request Feature</a>
  </p>
</div>

> [!IMPORTANT]
> Alethe is an early public release. The local desktop app is free and local-first. Official hosted services, such as sync, backup, or cloud features, may be offered separately in the future.

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about">About</a>
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#builds-and-releases">Builds and Releases</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#pending-work">Pending Work</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<div id="about"></div>

## About

**Alethe** is a desktop app for organizing, running, and resuming multiple coding agents and shells in parallel. It brings projects, groups, containers, panes, sub-tabs, real PTYs, persistent layouts, local history, and RAM controls into a single workspace built for daily work with Claude Code, Codex, OpenCode, and local terminals.

The goal is to make the real state of work visible: which agents are running, where they are running, which project they belong to, what session/history they are tied to, and how many resources they are using.

Instead of treating every terminal as a loose window, Alethe turns terminals and agents into persistent units inside a structured workspace. You can organize work by client, product, squad, monorepo, experiment, or task, keep processes alive, close containers without killing PTYs, suspend groups to free RAM, and return later without rebuilding the whole setup.

### Local-first model

- The local app works without an account.
- Projects, layouts, preferences, and scrollback stay on your machine.
- Local export/import does not depend on cloud services.
- Cloud sync and backup may exist later as optional services.
- Spotify uses the user's own credentials from the Spotify Developer Dashboard.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="features"></div>

## Features

### Workspace

- Projects opened as visual containers.
- Groups and subgroups for larger workspaces.
- Recent tabs at the top of the app.
- Automatic layout, spotlight, sidebar, and custom grid modes.
- Container fullscreen and terminal focus mode.
- Drag-and-drop for groups, projects, containers, and panes.
- Home view with recent projects, Claude usage, activity, and Now Playing.

### Terminals and agents

- Real PTY backend in Rust via `portable-pty`.
- Shell, Claude Code, Codex, and OpenCode support.
- Multiple sub-tabs per terminal.
- Process reattach and persisted scrollback.
- Restart, kill, disable, and re-enable terminal flows.
- Terminal search with `xterm.js`.
- Open cwd in Explorer or VS Code.

### Continuity and memory

- Containers can be closed without killing PTYs.
- Groups can be suspended to free memory.
- RAM indicator in the title bar.
- Persisted local session/state.
- Local backup export/import.
- Local Claude/Codex history when available.

### Integrations

- Spotify Now Playing through local OAuth.
- Claude usage and local activity.
- Experimental Agent Planning / Agent Canvas.
- GitHub Actions release builds for Windows, Linux, and macOS.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="built-with"></div>

## Built With

Desktop / backend:

- Rust
- Tauri 2
- `portable-pty`
- `reqwest`
- `serde_json`

Frontend:

- React
- TypeScript
- Vite
- Zustand
- Radix UI
- Lucide React
- `xterm.js`
- `@dnd-kit/core`
- `react-resizable-panels`

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="getting-started"></div>

## Getting Started

You can use installers published in **Releases** or run the app locally from source.

<div id="prerequisites"></div>

### Prerequisites

For local development:

- Node.js 18+
- Rust stable
- Windows 10/11, Linux, or macOS
- Visual Studio Build Tools on Windows

```sh
npm install npm@latest -g
```

On Linux, install the WebKit/GTK dependencies required by Tauri:

```sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

<div id="installation"></div>

### Installation

1. Clone the repository:

   ```sh
   git clone https://github.com/Kc1t/alethe.git
   cd alethe
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Run the desktop app in development mode:

   ```sh
   npm run app
   ```

4. Run only the frontend in the browser:

   ```sh
   npm run dev
   ```

5. Build the frontend:

   ```sh
   npm run build
   ```

6. Build the desktop app/installers:

   ```sh
   npm run tauri -- build
   ```

Build artifacts are written to:

```text
src-tauri/target/release/bundle/
```

On Windows, installers are usually generated under:

```text
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

### Useful scripts

| Command | Description |
|---|---|
| `npm run app` | Opens the Tauri app in development mode. |
| `npm run dev` | Starts only the Vite frontend. |
| `npm run build` | Compiles TypeScript and generates `dist/`. |
| `npm run preview` | Serves a local preview of the frontend build. |
| `npm run tauri -- build` | Builds the desktop app/installers. |

### Spotify

To use Now Playing, create an app in the Spotify Developer Dashboard and register this Redirect URI:

```text
http://127.0.0.1:8888/callback
```

Then add your `Client ID` and `Client Secret` in **Preferences > Spotify**.

For local development, you may also use a `.env` file:

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

<div id="builds-and-releases"></div>

### Builds and Releases

This repository includes a GitHub Actions workflow that builds installers for:

- Windows x64
- Linux x64
- macOS Apple Silicon
- macOS Intel

To create a release from a tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

You can also run the workflow manually:

```text
Actions > Release > Run workflow
```

> [!NOTE]
> For macOS distribution outside the App Store, professional builds should be signed and notarized with an Apple Developer certificate. Without that, users may see an unidentified developer warning.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="usage"></div>

## Usage

### Basic flow

1. Create a project.
2. Add terminals or agents to the project.
3. Open more projects to create containers in the workspace.
4. Use automatic layouts or draw a custom grid.
5. Close containers without killing processes.
6. Reopen the project when you want to resume.
7. Suspend groups when you need to free RAM.

### Concepts

| Concept | Meaning |
|---|---|
| **Group** | Logical collection of projects. |
| **Project** | Work unit with terminals, layout, and state. |
| **Container** | Visual representation of an opened project. |
| **Pane** | Terminal rendered inside a container. |
| **Terminal** | Persistent unit with cwd, tabs, PTY, and state. |
| **Sub-tab** | Internal terminal tab, each one tied to an agent/PTY. |
| **PTY** | Real terminal process managed by the Rust backend. |

### Mental model

```text
Group
├── Project A
│   ├── Claude Code
│   ├── Codex
│   └── Shell
└── Project B
    ├── OpenCode
    └── Shell
```

### Screenshots

Screenshots and GIFs are not included in this initial public README. Add them later under `docs/assets/` and reference them here when they are ready.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="roadmap"></div>

## Roadmap

- [x] Workspace with projects, groups, and containers.
- [x] Real PTYs with spawn, attach, resize, and scrollback.
- [x] Automatic layouts and custom grid.
- [x] Sub-tabs per terminal.
- [x] Home view with recents, activity, usage, and Spotify.
- [x] Experimental Agent Planning / Agent Canvas.
- [x] Local Windows build.
- [x] GitHub Actions for Windows, Linux, and macOS.
- [ ] Windows release signing.
- [ ] macOS notarization.
- [ ] Linux builds tested on popular distributions.
- [ ] Visual documentation with real screenshots/GIFs.
- [ ] Optional cloud sync/backup.
- [ ] Agent marketplace/library.
- [ ] Opt-in diagnostic telemetry, if it proves useful.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="pending-work"></div>

## Pending Work

### Product

- Improve public onboarding.
- Finalize release copy and download page.
- Define support and security policies.
- Create a contribution guide.
- Add real screenshots of the app.

### Engineering

- Test Linux/macOS builds in runners and real machines.
- Sign and notarize builds.
- Expand PTY lifecycle tests.
- Review compatibility with shells beyond PowerShell/pwsh.
- Review recovery flows when agent CLIs change their session formats.
- Harden local token storage per platform.
- Review the remaining Vite/esbuild audit warning before a larger public release.

### Documentation

- Build guide per operating system.
- Spotify Developer credentials guide.
- Agent Planning guide.
- Backup/restore guide.
- PATH/CLI troubleshooting guide.

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="license"></div>

## License

The source code is distributed under **AGPL-3.0-or-later**. See [`LICENSE`](LICENSE) for details.

Official hosted services, such as sync, backup, billing, or cloud features, may be proprietary and offered separately.

The **Alethe** name, logo, and official branding are reserved for official builds. See [`TRADEMARK.md`](TRADEMARK.md).

<p align="right">(<a href="#readme-top">Back to top</a>)</p>

<div id="contact"></div>

## Contact

Kauã Miguel

- Portfolio: <https://kc1t.com>
- GitHub: <https://github.com/Kc1t>
- Project: <https://github.com/Kc1t/alethe>

<p align="right">(<a href="#readme-top">Back to top</a>)</p>
# alethe-agents
