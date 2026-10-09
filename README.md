# CubstartHomeworkGrader

This project is designed to streamline the process of downloading and viewing student submissions for grading.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (includes npm)

## Installation

```sh
git clone https://github.com/cubstart/CubstartHomeworkGrader.git
cd CubstartHomeworkGrader
npm install
```

`npm install` also downloads the Chromium browser that Playwright uses to talk to Gradescope (via the `postinstall` script). If that step is skipped or fails, run it manually:

```sh
npx playwright install chromium
```

## Running

```sh
npm start        # or: npm run start
```

Then open <http://localhost:3000> and click **Log in to Gradescope**. A browser window opens; sign in there, and the login is saved in `.gradescope-profile/` for future runs.

The grader UI runs on port `3000`. To use a different port, set `PORT`:

```sh
PORT=4000 npm start          # macOS/Linux
$env:PORT=4000; npm start    # Windows PowerShell
```

Downloaded submissions are stored in `data/`.

## Security

Student submissions are untrusted code, so the app:

- **Only accepts connections from your own machine.** Every server binds to the loopback addresses (`127.0.0.1`, plus `::1` where IPv6 is available) and rejects any request that isn't from a loopback address or doesn't use `localhost`, `127.0.0.1` or `[::1]` as its host. Other devices on your network can't reach it.
- **Serves each submission from its own port.** That makes each one a separate browser origin, so one student's code can't read another student's files or the class roster. The ports are picked by the OS and shown in the preview URL.
- **Sandboxes previews.** Student pages can't navigate the grader tab or open popups, and can't install service workers.
- **Limits extraction.** A submission is rejected if it unzips to more than 200 MB or 5,000 files.

Open the UI at `localhost`, `127.0.0.1` or `[::1]`; other hostnames, even ones that point at your machine, are refused.
