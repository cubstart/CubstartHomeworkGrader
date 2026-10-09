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

## Grading status (MongoDB, optional)

To track which students have been graded, shared across every grader, copy `.env.example` to `.env` and fill it in:

```sh
MONGODB_URI=mongodb+srv://user:password@cluster.example.mongodb.net/
# Optional: database name (default cubstart-grader) and the name recorded as grader (default: your OS username)
MONGODB_DB=cubstart-grader
GRADER_NAME=Your Name
```

Statuses are stored in the `grades` collection, one document per assignment and submission (`assignmentId`, `submissionId`, `graded`, `gradedBy`, `updatedAt`, plus the student's name and email). Without `MONGODB_URI` everything else still works; the header just shows "Grading status off".

## Running

```sh
npm start        # or: npm run start
```

Then open <http://localhost:3000>. In Gradescope, open the assignment → **Review Grades** → **Export Submissions**, and drop the downloaded zip onto the page (or click **Import zip**). Re-importing an assignment's export replaces the earlier import; grading status is kept.

Mark a student graded with the **Mark graded** button or the `g` key. Graded students get a ✓, **Hide graded** filters them out, and other graders' changes show up within about 10 seconds.

The grader UI runs on port `3000`. To use a different port, set `PORT`:

```sh
PORT=4000 npm start          # macOS/Linux
$env:PORT=4000; npm start    # Windows PowerShell
```

Imported submissions are stored in `data/`.

## Security

Student submissions are untrusted code, so the app:

- **Only accepts connections from your own machine.** Every server binds to the loopback addresses (`127.0.0.1`, plus `::1` where IPv6 is available) and rejects any request that isn't from a loopback address or doesn't use `localhost`, `127.0.0.1` or `[::1]` as its host. Other devices on your network can't reach it.
- **Serves each submission from its own port.** That makes each one a separate browser origin, so one student's code can't read another student's files or the class roster. The ports are picked by the OS and shown in the preview URL.
- **Sandboxes previews.** Student pages can't navigate the grader tab or open popups, and can't install service workers.
- **Limits extraction.** A submission is rejected if it unzips to more than 200 MB or 5,000 files.

Open the UI at `localhost`, `127.0.0.1` or `[::1]`; other hostnames, even ones that point at your machine, are refused.
