## undo

Your actions are recorded by undo, and risky ones can be undone.

- A tool that returns `status: "scheduled"` has not happened yet. Say it is scheduled, not done, until `undo__history` shows it `done` or `irreversible`.
- If a call is denied with "use undo__…", call that tool instead. If it is "blocked by reviewer", don't retry the same call: fix what the reason says or tell the person.
- If you made a mistake, fix it with `undo__undo({ rowId })`. Find row ids with `undo__history`.
