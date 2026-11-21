# Raindrop UI samples: brief

Five design samples for the main flow: show bookmarks and search them.

Decision on 2026-10-18: sample A (Ledger) is the design of the app. Samples B to E were removed from the repository after the choice. This brief keeps their descriptions for the record.
Source of truth for behaviour and copy: `docs/ui-elements.md`.
Shared data and helpers: `docs/ui-samples/data.js`. Each sample inlines this file in a `<script>` block before its own script. Do not change the data.

## Rules for every sample

Each sample is one self-contained HTML file in `docs/ui-samples/`. It is published as an artifact. Follow the artifact page contract (no doctype or html/head/body tags; `<title>` and `<style>` at the top; theme tokens on `:root` with both themes; `claude:viewport-fit-sides` meta with the two `max()` gutter paddings).

Every sample must show these elements and make them work with the sample data:

1. Search box with visible label "Search", placeholder "Search title, note, excerpt, link, tag, folder...", autofocus, 250 ms debounce, AND rule over words (use `matches`).
2. Sort select, 6 options, label "Sort by", default "Newest first".
3. Status select (all / New / Unsorted or no tags) and Visited select (all / Visited / Not visited).
4. Tags filter (AND rule, comma separated) or clickable tags. Clicking a tag chip adds that tag to the filter.
5. Date presets: All time, Today, Last 7 days, Last 30 days, Custom. Show counts from `presetCounts()`, for example "Today (3)". Custom shows two date inputs "From" and "To". Mark the active one with `aria-pressed` and a second cue (not colour alone).
6. Folders: "All folders" and one entry per folder with the count from `folderCounts()`. "Unsorted" always shows. A "+ Create a new folder" control (it can open a small inline box; no need to store it).
7. Count line, `role="status"`: "Showing 1–25 of 42 bookmarks". With no filter: "42 bookmarks". Empty: "No bookmarks match."
8. Status line (grey) next to the count, with a sample text such as "3 new bookmarks found. They are labelled New."
9. A "Check for new bookmarks" button. On click: disabled and text "Checking for new bookmarks..." with a spinner for 1.5 s, then the status text updates.
10. Bookmark item: selection checkbox (name "Select <title>"), title link (new tab, bold, no underline, two-line cut-off), badges "New" (green) and "No folder or tags" (amber, only when not New), meta line "domain · folder · 17 Oct 2026, 13:05 (3 days ago) · visited 3× (last ...)", tag chips, excerpt (grey, max 200 chars), "Edit" button on every item, "Suggest folder and tags" button only on New or needs-sort items.
11. Edit opens an inline editor: folder select (all folders plus "+ Create a new folder..."), tag chips with remove buttons (name "Remove tag <tag>"), "Add tag" input with placeholder "Add tag, press Enter", Save and Discard. Focus moves to the folder select on open. Escape closes. Save updates the item in memory and closes.
12. "Suggest folder and tags": disabled with text "Asking the model..." for 1.2 s, then opens the editor with a suggested folder and up to 4 extra tags (pick from the sample's own logic, for example the folder with the most matching tags).
13. Multi-select: "Select all on this page" checkbox with indeterminate state; a bulk bar appears with "<n> selected", "Move to folder", "Add tags", "Remove tags", "Clear selection". The bar is sticky at the bottom. Actions can be mock buttons that show a confirm step text, for example "Move 4 bookmarks to Home lab?" with "Apply to 4 bookmarks" and "Cancel".
14. Paging: Previous, "Page 1 of 2", Next, page size select (25, 50, 100; default 25 in the samples so paging is visible). Paging controls above and below the list.
15. Footer: "Last checked: 17 Oct 2026, 13:05", "v1.4.2", link "Open Raindrop".
16. Account label "Adar Bahar" with grey email "adar@example.com", and a "Logout" button that opens an in-page dialog with the three options and Cancel (section 4.2). Focus starts on Cancel, Escape closes.
17. "Clear filters" button, visible only when a filter is active.
18. Phone layout: one column, folder row scrolls sideways, filters collapse into a "Filters (n)" button that opens a sheet on screens under 600 px. Bulk bar is a bottom bar.
19. Accessibility: visible focus rings, labels on every control, `aria-live` on count and status, skip link "Skip to results", landmarks (`header`, `main`, `nav`, `footer`), visually hidden `h1` "Raindrop search", min target 24 px on desktop and 44 px on phones.

Keep the copy exactly as in `docs/ui-elements.md`. Use real sample data only. No lorem ipsum. Keep motion minimal and respect `prefers-reduced-motion`. Use only Google Fonts for type.

## The five samples

### A. `a-ledger.html` — Sidebar and list (after the first inspiration image)
Dark-first. A fixed 248 px left sidebar: app name, account, then "Folders" with counts, then "Tags" with counts (top 12, then "Show all"). Main column: search bar at the top, then a toolbar row with sort, status, visited and the date presets as a segmented control. The list is dense rows, one bookmark per row: a 40 px square tile with the domain's first letter in a colour derived from the domain, title on the first line with badges, meta on the second line, tags as small chips on the right. Row hover reveals Edit, Suggest and the checkbox. A small keyboard hint row sits at the bottom of the sidebar ("/" search, "E" edit, "J/K" move). Palette: deep ink blue-black, slate greys with a blue bias, one warm amber accent. Type: IBM Plex Sans for text, IBM Plex Mono for counts and dates. Light theme: the same structure on a cool off-white with the same amber.

### B. `b-board.html` — Dense folder panels (after the second inspiration image)
Dark-first, compact. The page is a grid of panels, one panel per folder, 3 columns on desktop (auto-fill, min 300 px), 1 on phones. Each panel has a header with the folder name, its count, and a small menu; the body is a list of one-line items: 16 px favicon-style monogram, the title, and the age on the right in a muted colour. Search filters the items inside every panel and hides empty panels; the count line reports the total. A top strip holds: account, search (right), status tabs (All / New / Needs sorting) as underlined tabs, then sort and visited as small selects, and the date presets as a chip row. Hover on an item reveals a small action group (Edit, Suggest). The editor opens below the item inside the panel. Selected items get a left stripe. Palette: charcoal with a green-grey bias, panel surfaces one step lighter, ice-blue link titles, one leaf-green accent for "New". Type: Source Sans 3 only, tight sizes (13 to 14 px). Light theme: pale grey ground, white panels.

### C. `c-finder.html` — Search first, master and detail
Light-first. The search bar is the hero: 56 px tall, full width of a 1100 px centred column, with the shortcut hint inside. Under it a single wrapping row of filter chips: presets, status, visited, folder (a popover select), tags (typed). The results are a left list (420 px) of compact rows (title, domain, age). Arrow keys move the selection; Enter opens the link. The right pane shows the selected bookmark in full: large title, link, folder, tags, created, visits, excerpt, note, with Edit and Suggest buttons and the editor inline in that pane. On phones the detail pane opens as a full-screen sheet with a "Back to results" button. Palette: cool off-white, graphite text, one deep green accent. Type: Instrument Sans for text, JetBrains Mono for shortcut keys and dates. Dark theme: graphite ground.

### D. `d-table.html` — Data table for bulk work
Light-first, utilitarian. A filter rail across the top in two rows: row 1 search, sort, status, visited, tags; row 2 presets, custom dates, folder select, "Check for new bookmarks". Below, a table with a sticky header: checkbox, Title (domain under it in grey), Folder, Tags, Created (tabular, with age in a tooltip), Visits, Actions (Edit, Suggest). Column headers for Title, Folder, Created and Visits are sortable and drive the sort select. Rows are 44 px. Selected rows get a tinted background. The bulk bar sits under the sticky header, not at the bottom, on desktop; at the bottom on phones. A density switch (Comfortable / Compact) is a small extra. The editor opens as a row directly under the edited row, spanning all columns. Palette: white, warm hairline greys, a strong steel-blue accent, green and amber for badges. Type: Public Sans with tabular numerals. Dark theme: warm charcoal, same accent lightened.

### E. `e-shelf.html` — Card gallery
Light-first, visual. A top bar with the app name set in Fraunces (display serif) and the account on the right. Under it: search (left) and sort (right). A horizontal row of folder chips with counts, scrollable. A right rail (240 px) of tags with counts and the date presets as a vertical radio list; the rail becomes a sheet on phones. The main area is a card grid (auto-fill, min 260 px). Each card: a 16:9 header tile coloured from the domain with a large monogram and the domain name, then the title (two lines), the excerpt (three lines), tag chips, and a footer with the date, the visit count and the Edit button. New and needs-sort badges sit on the header tile. The editor replaces the card body. Palette: pale moss-grey ground, white cards, warm dark text, one plum accent. Type: Fraunces for the app name and headings, Nunito Sans for the rest. Dark theme: deep moss-charcoal ground.
