# CubstartHomeworkGrader

This project is designed to streamline the process of viewing student submissions for grading.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (includes npm)

## Installation

```sh
git clone https://github.com/cubstart/CubstartHomeworkGrader.git
cd CubstartHomeworkGrader
npm install
```

## Grades and comments (MongoDB, optional)

To record grades and comments, shared across every grader, copy `.env.example` to `.env` and fill it in:

```sh
MONGODB_URI=mongodb+srv://user:password@cluster.example.mongodb.net/
# Optional: database name (default cubstart-grader) and the name recorded as grader (default: your OS username)
MONGODB_DB=cubstart-grader
GRADER_NAME=Your Name
```

Grades are stored in the `grades` collection, one document per assignment and submission: `assignmentId`, `submissionId`, the student's `name` and `email`, `graded`, and, once a rubric item is picked, `score`, `maxScore` and `rubric` (the item's label), plus an optional `comment`. `gradedBy` and `updatedAt` record the last change. Without `MONGODB_URI` everything else still works; the header just shows "Grading status off".

The rubric is a single choice, the same for every assignment, defined as `RUBRIC` in `server.js`:

| Points | Label |
| --- | --- |
| 5 | Uses all required elements |
| 4 | Uses most required elements |
| 2 | Uses some required elements |
| 0 | No work |

## Running

```sh
npm start        # or: npm run start
```

Then open <http://localhost:3000>. In Gradescope, open the assignment → **Review Grades** → **Export Submissions**, and drop the downloaded zip onto the page (or click **Import zip**). Re-importing an assignment's export replaces the earlier import; grading status is kept.

Grade a student from the panel under the preview: click a rubric item or press its number (`1`-`4`). Graded students get a ✓ and their score (for example `5/5`) in the list, and the count line shows the class average. Clicking the selected item again, or the ✓ button, clears the grade; `g` toggles graded without a score. The comment box saves on its own shortly after you stop typing, when you click elsewhere, or on Ctrl/Cmd+Enter; Esc leaves it so `j`/`k` work again. **Hide graded** filters graded students out, and other graders' changes show up within about 10 seconds.

The grader UI runs on port `3000`. To use a different port, set `PORT`:

```sh
PORT=4000 npm start          # macOS/Linux
$env:PORT=4000; npm start    # Windows PowerShell
```

Imported submissions are stored in `data/`.

Student pages sometimes reference assets with paths that only worked on the student's own setup: `/assets/photo.jpg` while `index.html` sits inside `HW1/`, a GitHub Pages path like `/repo-name/HW1/assets/photo.jpg`, or the wrong letter case. The preview falls back to the matching file inside the submission, so the page looks the way the student saw it. Assets that were never uploaded still show as broken.

## Security

Student submissions are untrusted code, so the app:

- **Only accepts connections from your own machine.** Every server binds to the loopback addresses (`127.0.0.1`, plus `::1` where IPv6 is available) and rejects any request that isn't from a loopback address or doesn't use `localhost`, `127.0.0.1` or `[::1]` as its host. Other devices on your network can't reach it.
- **Serves each submission from its own port.** That makes each one a separate browser origin, so one student's code can't read another student's files or the class roster. The ports are picked by the OS and shown in the preview URL.
- **Sandboxes previews.** Student pages can't navigate the grader tab or open popups, and can't install service workers.
- **Limits extraction.** A submission is rejected if it unzips to more than 200 MB or 5,000 files.

Open the UI at `localhost`, `127.0.0.1` or `[::1]`; other hostnames, even ones that point at your machine, are refused.
