# Ledger: flows in the sample

The lead design is sample A, `a-ledger.html`. This note lists each flow from `docs/ui-elements.md` and how to reach it in the sample. The "Sample state" select in the footer is a sample-only control. It does not exist in the real app.

| Flow | Section | How to reach it in the sample |
|---|---|---|
| Sign-in required | 3.2 | Sample state: "Sign-in required". |
| Connect Raindrop | 3.3 | Sample state: "Connect Raindrop". The button returns to the main app. |
| Connect error | 3.3 | Sample state: "Connect Raindrop: error". |
| Loading | 1, 4.13 | Sample state: "Loading". The count line shows "Loading bookmarks n/312" with a thin bar. |
| Load error | 1, 4.13 | Sample state: "Load error". The count line shows the error. "Try again" reloads. |
| No bookmarks yet | 5.1, 8.9 | Sample state: "No bookmarks yet". |
| No bookmarks match | 5.1 | Type a search with no hits. |
| Search, filters, presets, folders, tags | 4.3 to 4.11 | Toolbar and sidebar. "Clear filters" shows when a filter is active. |
| Custom date error | 4.10 | Preset "Custom", then set "From" after "To". |
| Create folder | 4.12 | Sidebar "+ Create a new folder". Try an empty name or "Recipes" for the errors. |
| Check for new bookmarks | 4.8 | Button at the top. Spinner, then the status text. |
| Edit | 5.4, 5.5 | Hover a row, click "Edit", or press J/K then E. Focus moves to "Folder". Escape closes when nothing changed. |
| Discard with changes | 5.5 | Change a tag, then click "Discard". A confirm step appears. |
| Tag validation | 5.5 | Add a tag with a comma, a tag over 50 characters, or a 21st tag. |
| Create folder in the editor | 5.5 | In "Folder" choose "+ Create a new folder...". |
| Tag mismatch after save | 5.7 | Add a tag with capital letters or a space, then "Save". The status line shows the warning. |
| Suggest folder and tags | 5.4 | Click "Suggest folder and tags" on a New card. |
| Suggest failure | 5.4 | Click "Suggest folder and tags" on "Expense tracking in a plain spreadsheet". |
| Save failure | 5.5 | Sample state: "Save failed". |
| Link cannot be opened | 5.2 | Sample state: "Link cannot be opened". The first row shows the note and a plain title. |
| Multi-select | 5.6 | Check rows, Shift+click for a range, or "Select all on this page". |
| Select all matching | 5.6 | After "Select all on this page", click "Select all 42 matching bookmarks". |
| Bulk move, add tags, remove tags | 5.6 | Select rows, then use the bulk bar. The question line updates with the target. |
| Bulk confirm over 100 | 5.6 | Not reachable with 42 bookmarks. Apply is not the primary button when the count is over 100. |
| Progress panel | 5.6 | Any bulk action runs the panel in the sample. Sample state: "Bulk update of 1,000" shows a long run with 3 failures. |
| Cancel the update | 5.6 | Click "Cancel the update" while the panel runs. |
| Failures list | 5.6 | After the 1,000 run, click "Show 3 failures" in the status line. |
| Undo | 5.6 | After a bulk action, click "Undo" in the status line within 30 seconds. |
| Logout dialog | 4.2 | Sidebar "Logout". Focus starts on "Cancel". Escape closes. |
| Logout from Raindrop | 4.2 | Dialog option 1. Shows the "Connect Raindrop" gate. |
| Logout from Admintools | 4.2 | Dialog option 2. Shows the Admintools sign-out page. |
| Logout from both | 4.2 | Dialog option 3. Runs option 1, then option 2. |
| Phone layout | 9 | Make the window narrower than 600 px. "Filters (n)" opens the sheet. The folder row scrolls. The bulk bar has an "Actions" button. |
| Keyboard | 10 | "/" focuses search. J and K move the cursor. E edits. Enter opens the link. |

Differences from the spec, on purpose, in the sample:
- The progress panel runs for every bulk action, not only above 100 bookmarks. This makes the flow visible with 42 bookmarks.
- The sample uses a short tick for the progress. The real app paces at 700 ms for each Raindrop call.
- The "Bulk update of 1,000" state does not change any bookmark.
