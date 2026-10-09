# CubstartHomeworkGrader
This project is designed to streamline viewing student submissions for grading.

## Usage
1. `npm install`, then `npm start` and open http://localhost:3000.
2. In Gradescope, open the assignment → **Review Grades** → **Export Submissions** and download the zip.
3. Drop the zip anywhere on the grader page (or click **Import zip**).

The export (`assignment_<id>_export/submission_<id>/…` plus `submission_metadata.yml`) is unpacked into `data/<assignment id>/`. Student names and emails come from the metadata file, and nested `.zip` uploads are extracted in place. Re-importing an assignment's export replaces the earlier import.
