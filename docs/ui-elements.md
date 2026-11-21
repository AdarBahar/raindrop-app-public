# Raindrop app: UI element reference

This document lists every UI element of the app. It is for the UI designer and the backend team.
Current sources: `app/frontend/index.html`, the page script in `app/frontend/` (`core.js`, `filters.js`, `list.js`, `bulk.js`, `review.js`, `bulk-drawer.js`, `keys.js`, `context.js`, `app.js`), `app/frontend/styles.css`.
Current server rules: `app/backend/src/bookmarks.js`, `listing.js`, `bulk-input.js`, `limits.js`, `profile.js`, `server.js`, `config.js`, `util.js`.
Text in quotes is the exact current copy. Items marked **Proposed** are new decisions. They need review.

## 0. Limits and time rules (apply to the whole app)

### 0.1 Raindrop's own limits
The official Raindrop documentation states these values:
- Rate limit: 120 requests per minute for each signed-in user. Over the limit, the API returns `429`.
- List paging: `perpage` maximum is 50.
- Bulk update (`PUT /raindrops/{collectionId}`): a non-empty tags list is **appended**. An empty tags list **removes all tags** from the bookmarks. A bulk update cannot remove only some tags.
- Plans: no cap on bookmarks, collections, tags or devices.

The official documentation does **not** state:
- Maximum number of `ids` for the bulk update.
- Maximum length of folder names, titles, notes, excerpts or tags.
- Maximum number of tags on one bookmark.


**Tested on a test account (issue #26):** the single update (`PUT /raindrop/{id}`) **replaces** tags. The tags sent are the tags saved. The app's `tags_match` check is still useful, for example for case or format changes.

### 0.2 App limits (Proposed)
Raindrop does not state these values, so the app sets them. The server checks them. They live in `config.js`, so they can change without a redesign.

| Limit | Value | Applies to |
|---|---|---|
| Search text | 200 characters | Search box |
| Tag length | 1 to 50 characters, no commas | Tag filter, add-tag input, bulk add/remove |
| Tags per bookmark | 20 | Editor, bulk add |
| Tags per tag filter | 10 | Tag filter (AND rule) |
| Folder name | 1 to 100 characters, after trim | Create folder, new folder in editor |
| Page size | 25, 50 or 100 (default 50) | Paging |
| Bulk action size | 1,000 bookmarks | Bulk edit, "select all matching" |
| Bulk request batch | 100 ids for each Raindrop call | Backend only |
| Custom date range | "from" must not be after "to" | Date inputs |
| Excerpt shown | 200 characters | Bookmark card |
| Suggested new tags | 4 for each model suggestion | Suggest button (existing) |

Raindrop call pacing: the app keeps 700 ms between calls for each user. That gives about 85 calls per minute. A bulk action of 1,000 bookmarks with tag removal needs about 12 minutes. The UI must show progress for such actions (section 5.6).

Model call pacing: all users share the model endpoint, which allows 10 requests a minute. The app keeps 6.5 s between model calls in total, and users take turns, so one user's queued calls do not hold up another user's call. Each user can run one suggestion job at a time; starting a second one while the first runs returns 409 with the message "A suggestion job is already running. Wait for it to finish, or cancel it."

### 0.3 Date and time rules
- The browser shows every date and time in the **user's local time zone**.
- The browser converts each date filter to a **UTC instant range** before the call. The server compares UTC instants only.
- The browser sends the user's IANA time zone name (for example `Europe/Berlin`) with date filters and with the meta request. The server uses this name to find the day boundaries for presets. The server's own clock and time zone are not used.
- "Today", "Last 7 days" and "Last 30 days" start at local midnight of the user.
- Relative age text ("3 days ago") is computed in the browser.

## 1. Screens and states

| State | When | What the user sees |
|---|---|---|
| Sign-in required | No app user. | Gate box with the sign-in message. |
| Connect Raindrop | App user, but no Raindrop connection. | Gate box with the connect button. |
| Loading | App start. Also during "Check for new bookmarks" and bulk actions. | Count text and progress. |
| Main app | Connected. | Header, bookmark list, paging and footer. |
| Logout dialog | The user clicks "Logout". | Dialog with the logout choices (section 4.2). |
| Selection | One or more bookmarks are selected. | Bulk action drawer to the right of the list. On narrow screens, a bulk action bar above the footer. |
| Empty | No bookmark matches the filters. | Text "No bookmarks match." in the list. |
| Error | A request fails. | Error text in the count line or the status line. |

The footer exists (section 6). The paging controls sit under the list.

## 2. Global rules

- The header is sticky at the top on desktop. On phones, the header collapses (section 9).
- Text inputs wait 250 ms after the last key press, then update the list.
- Selects, date presets and folder buttons update the list at once.
- Each filter change resets paging to page 1 and clears the selection.
- Every filter change calls the server again.
- The folder counts and the tag counts ignore all other filters. The date preset counts show the counts of all bookmarks, and, with another filter on, also the counts with that filter (4.9).
- The app uses one language, English. It has no dark mode.
- Changes made in the editor are kept in memory until the page reloads.

## 3. Gate (not signed in, or not connected)

### 3.1 Gate box
- Where: centred on the page, full height.
- Count: 1.
- Width: up to 420 px, or 90 % of the screen width.
- Shows one of the two parts below, never both.

### 3.2 Sign-in message
- Heading: "Sign in required".
- Text: "Open this app through the Admintools sign-in page."
- No buttons. The user must sign in outside this app.

### 3.3 Connect message
- Heading: "Connect Raindrop".
- Text: "Approve this app once. It then reads only your own bookmarks."
- Button: "Connect Raindrop" (link to the Raindrop approval). Count: 1.
- Error text, red, under the button. Hidden unless the approval fails.
- Error text format: "Raindrop did not connect: " followed by the reason from Raindrop.
- Button: "My context", quiet style, under the error text. It opens the "My context" view (section 11). The profile does not need a Raindrop connection.

## 4. Header

The header holds the controls. Rows wrap onto a new line when space runs out.

### 4.1 Account label
- Where: top row, left side.
- Count: 1.
- Content: name in bold, then the account email in grey small text when Raindrop returns one.
- Name source: the Raindrop full name. If none, the app user ID is shown.
- Tooltip: "Signed in to the app as <user>".
- Length: **Proposed** cut-off after 40 characters, with the full name in the tooltip.

### 4.1a "My context" button
- Where: the account area of the sidebar, under the account label, next to "Delete my data".
- Count: 1. Label: "My context". Quiet style.
- Click: opens the "My context" view (section 11).

### 4.2 Logout button and logout dialog
This replaces the old "Disconnect Raindrop" button and its browser confirm box.

**Logout button (Proposed)**
- Where: top row, right side.
- Count: 1. Shown when the user is signed in to Admintools, even when Raindrop is not connected.
- Label: "Logout".
- Click: opens the logout dialog. Nothing changes until the user chooses an option.

**Logout dialog (Proposed)**
- Heading: "Logout". Text under the heading: "Choose what to log out." (Proposed)
- Options, in this order. The wording comes from the product owner:
  1. **"Logout from Raindrop account"**. Removes this app's Raindrop connection for this user. Admintools stays signed in. The app then shows the "Connect Raindrop" screen.
  2. **"Logout from the Admintools?"**. Signs out of Admintools. The Raindrop connection stays stored. See section 8, point 14, for the label.
  3. **"Logout from both"**. Runs option 1, then option 2.
  4. **"Cancel"**. Closes the dialog. Nothing changes.
- Help text under option 2 (Proposed): "This signs you out of every Admintools tool on every browser and device. It does not sign you out of Google."
- If Raindrop is not connected, the dialog shows only option 2 and "Cancel".
- Each option is a button. Cancel has the initial focus.
- While an option runs, all buttons are disabled. The text "Logging out..." shows.
- An error shows in red inside the dialog. The dialog stays open.

**How each option works**
- Option 1 calls the app's disconnect request. It needs a live Admintools session.
- Option 2 is a full-page visit to the Admintools sign-out page. In production the address is set by the operator. The page signs the person out at once. It has no button. It shows the text "User was logged out."
- Option 2 must be a full-page visit. A `fetch` call or an iframe does not sign the person out.
- Option 3 runs option 1 first and waits for its success. Then it starts option 2. If option 1 fails, option 3 stops. It shows "Raindrop logout failed: " plus the reason, and it does not start option 2. The order is required, because option 1 needs the Admintools session.
- After option 2, the Admintools sign-out page is shown. The app has no return address. See section 8, point 15.

### 4.3 Search box
- Where: second row, first item.
- Type: search input. Count: 1.
- Placeholder: "Search title, note, excerpt, link, tag, folder..."
- Visible label: **Proposed** "Search" (section 10).
- Focus: set on page load (autofocus).
- Length: maximum 200 characters (section 0.2). Show a counter after 150 characters.
- Search rules:
  - The text is split at spaces. Each word must appear (AND).
  - Case does not matter.
  - Searched fields: title, excerpt, note, link, domain, tags, folder name.
  - Empty text means no text filter.
  - A text search shows all dates. When the search text starts, the date filter moves to "All time". The user can then click a date preset to see fewer dates, and that choice stays while the search text stays.
  - When the search text is removed, the date filter from before the search returns: a preset the user clicked before the search returns as a choice, and a view the user did not choose returns to the default preset (4.9). A preset the user clicked during the search stays.
  - When the start or the end of the search text changes the date filter, the list reloads at once, without the delay of the search box, and the selection is cleared at once. A bulk action thus never uses a date filter that is different from the one of its selection.
  - Each filter change removes the selection controls and closes an open bulk step at once, before the new list comes. "Select all N matching bookmarks" does nothing while the list on the page has other filters than the current ones.
  - With search text, each result shows a date label in its meta line: "Today", "Last 7 days", "Last 30 days" or "Older than 30 days". The label is the narrowest preset that has the bookmark. `/api/bookmarks` gives it in `period` (`today`, `last7`, `last30`, `older`).
  - With search text, "All time" is not a filter in the count of "Filters (n)". Each other preset is.

### 4.4 Sort select
- Count: 1 select, 6 options. Default: "Newest first".
- Visible label: **Proposed** "Sort by".
- Options (value: label):
  - newest: "Newest first"
  - oldest: "Oldest first"
  - az: "Title A-Z"
  - za: "Title Z-A"
  - folder: "Folder" (then newest first)
  - visits: "Most visited" (then newest first)
- Unknown value: the server uses newest.

### 4.5 Status select
- Count: 1 select, 4 options. Default: "Status: all".
- Options:
  - "" : "Status: all"
  - new: "New" (bookmarks found by the last "Check for new bookmarks")
  - needs: "Unsorted or no tags" (folder is Unsorted, or the tag list is empty)
  - dupes: "Duplicates" (the duplicate view, below)
- With "Unsorted or no tags", a switch shows under the count line, above the list. It has 4 buttons. Each button shows its count:
  - "Any of these" (default): the folder is Unsorted, or the tag list is empty.
  - "No folder and no tags": the folder is Unsorted, and the tag list is empty.
  - "No folder": the folder is Unsorted. The bookmark can have tags.
  - "No tags": the tag list is empty. The bookmark can be in any folder.
- A bookmark with no folder and no tags is in all four. The counts use all the other filters, the date too. The server returns them as `needsCounts` (`any`, `both`, `folder`, `tags`) only with the status "needs". The request sends the kind as `needs` (`both`, `folder` or `tags`). An unknown value means "Any of these".
- A click on a button reloads the list from page 1 and clears the selection, as for any filter change. A bulk action on "all matching" uses the same kind.
- A change of the status and "Clear filters" set the switch back to "Any of these". The switch does not add to the count in "Filters (<n>)".
- The count line names the kind: "unsorted or with no tags", "unsorted and with no tags", "unsorted" or "with no tags".
- The rules are in `app/backend/src/dupes.js`. They prefer a missed match to a false match. Each link gets two keys. The link itself does not change.
- The definite key removes only what cannot change the page:
  - The tracking parameters: `utm_*` (any case), `fbclid`, `gclid`, `dclid`, `msclkid`, `gbraid`, `wbraid`, `yclid`, `igshid`, `mc_cid`, `mc_eid`, `srsltid` and `_ga`.
  - The host case, a default port, and the escapes of letters, digits and "-._~".
  - The order of the parameter names. Repeated names keep the order of their values.
  - A plain fragment. A fragment that starts with "#/" or "#!" stays, because a single-page site uses it for a page.
  - Unknown parameters and the path case always stay.
- The possible key also removes http or https, "www." and a "/" at the end. No other difference gives a possible match.
- Site rules:
  - YouTube (`youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `youtube-nocookie.com`): the key is the video ID from `/watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/` or `/v/`. The definite key also has the playlist and any unknown parameter. The possible key is the video ID only. `ab_channel`, `feature`, `si`, `pp` and `t` do not count.
  - X (`x.com`, `twitter.com`, `mobile.twitter.com`, `mobile.x.com`): a link to a post gives the post ID only, because a post ID is unique on X. `s`, `t`, `ref_src` and `ref_url` do not count. A profile and other pages use the general rules.
  - GitHub (`github.com`): the owner and repository names do not change with capital letters. `tab=readme-ov-file` on the repository page does not count. Files, issues, pull requests and commits stay apart.
  - Google Docs (`docs.google.com`): the fragment stays, because it selects a sheet tab (`#gid=`) or a heading.
- A link that is not an http or https URL matches only the same text. An empty link never matches.
- Bookmarks in a folder named "Archive" (any case) are in no group. So after "Keep recent", the group goes away.
- The counts look at all bookmarks, also bookmarks that the other filters hide.
- A definite group has two or more bookmarks with the same definite key. A possible group has two or more bookmarks with the same possible key and more than one definite key. A possible group also holds the bookmarks of its definite groups. The list shows such a bookmark one time.
- The duplicate view ("dupes"):
  - Two sections: "Duplicates" (the definite groups), then "Possible duplicates". A section with no group shows "No duplicates found."
  - A group shows when at least one of its bookmarks matches the other filters. Then it shows all its bookmarks, except the bookmarks that already show in a group above.
  - In each section, the group with the newest bookmark comes first. In each group, the newest bookmark comes first. The sort select does not apply.
  - The view has no pages, so a group is never split.
  - Each group has a header: "<n> bookmarks." and the reason, for example "The same GitHub repository." or "Possibly the same page: the links differ only in http or https, "www." or a "/" at the end."
  - A bookmark can be in a definite group and in a possible group. It shows one time, in its first group. The header of a later group then adds "<k> of them are in a group above." (or "All of them are in a group above."). Such a group can have no card.
  - Each card also shows its full link.
  - Count line: "<n> duplicate groups and <m> possible groups", with the filter words.
  - When the user selects "Duplicates", the date filter changes to "All time", because a duplicate can be years older than its copy.
- Group actions:
  - "Keep recent": off (disabled) when some bookmarks of the group show in a group above, with the text "Do the group above first." After the user acts on the group above, its older bookmarks are in Archive, and this group changes. Otherwise it selects the older bookmarks of the group and opens the bulk Archive step (5.6), with the question "Move <n> bookmarks to the folder Archive?". Apply, progress and Undo are the same as for the bulk Archive.
  - "Keep all": hides the group. The server stores the group with its bookmark IDs (table `kept_duplicates`). The group shows again only when a bookmark that was not in it joins it. Status text: "Group kept. It shows again only when a new bookmark joins the group." with an "Undo" link. The focus goes to "Undo". Error text: "Keep all failed: " plus the reason. After Undo, the focus goes to the "Keep all" button of the group. A failed Undo shows "Undo failed: " plus the reason, and the "Undo" link stays.
  - The user can also select bookmarks of a group and use any bulk action, or open the editor of one bookmark.
  - A hidden group gives no badge.
- The app never deletes, merges or changes a duplicate by itself. The user decides.

### 4.6 Visited select
- Count: 1 select, 3 options. Default: "Visited: all".
- Options:
  - "" : "Visited: all"
  - yes: "Visited" (at least one visit in this app)
  - no: "Not visited"
- Visits are counted by this app only. Visits from other tools are not counted.

### 4.7 Tags filter
- Type: text input, width 220 px. Count: 1.
- Placeholder: "Tags (comma separated)".
- Visible label: **Proposed** "Tags" (section 10).
- Input format: tags separated by commas. Spaces around a tag are removed.
- Case does not matter. Empty parts are ignored.
- Rule: a bookmark must have every tag typed (AND). Maximum 10 tags (section 0.2).
- Suggestions: the 200 most used tags, each with its count.

### 4.8 Check for new bookmarks button
- Count: 1. Label: "Check for new bookmarks".
- While the check runs: the button is disabled. Status text: "Checking for new bookmarks...". **Proposed:** a spinner too.
- Result text (status line), by case:
  - First check ever: "Baseline saved. Future pulls will label new bookmarks as New."
  - Later checks: "<n> new bookmark(s) found. They are labelled New."
  - Error: the server message. If the request fails: "Check failed: " plus the reason.
- After the check: folders, tags and the list reload.
- Page load and refresh: the page runs a quick check first (`/api/changes`). If it finds new bookmarks, the full check runs by itself before the list shows. The status line then shows the result, as after a click. A failed quick check loads the list as before.
- During the session: the page runs the quick check every 3 minutes, but only while the tab shows and the browser is online. It also runs when the tab shows again or the browser comes back online, when the last check is 3 minutes old or older. No quick check runs while a full check runs.
  - With new bookmarks: the button gets a label, "Check for new bookmarks <n> new" ("<n>+ new" when all of the newest 25 bookmarks are new). The label uses the "New" badge colour.
  - Nothing loads, and the list does not reload. The full check runs only when the user clicks the button. The goal is no change to the list while the user works.
  - With no new bookmarks, the label goes away. A full check also removes it.
- The quick check finds new bookmarks only. A bookmark that was moved, tagged or deleted in Raindrop needs the full check.

### 4.9 Date preset buttons
- Count: 5 buttons. Only one is active.
- Default, on page load and after "Clear filters": the first of "Today", "Last 7 days", "Last 30 days" and "All time" with a count above zero. With no bookmarks at all: "All time". Before the counts load, "Today" is active.
- When the counts reload after a check or a bulk action, a view the user did not choose moves to the new default. The list returns to page 1 and the selection is cleared. A preset the user clicked stays, also when it was the default at that time. "Clear filters" forgets the choice.
- A save or a new folder also reloads the counts. The view does not move then, so an open editor or a bulk step is not disturbed.
- Labels and meaning (local time of the user):
  - "All time": no date limit.
  - "Today": from local midnight today.
  - "Last 7 days": today and the 6 days before (7 days in total).
  - "Last 30 days": today and the 29 days before (30 days in total).
  - "Custom": uses the two date inputs in 4.10.
- Counts: after the page loads, each preset shows its count, for example "Today 3".
  - With another filter on (search text, folder, tags, status or visited), each preset shows "<count with the filters>/<count of all bookmarks>", for example "All time 75/790". The first number ignores only the date filter, so a click on another preset does not change it. A screen reader reads "75 of 790".
  - `/api/meta` gives the counts of all bookmarks. `/api/bookmarks` gives the counts with the other filters (`presets`).
  - After a save, the app reloads the counts with the filters, but not the list, so the view does not move.
- Active state: shown with a fill colour **and** a text cue or `aria-pressed` (section 10).

### 4.10 Custom date inputs
- Count: 2 native date inputs ("from" and "to"), with the word "to" between them.
- Visible labels: **Proposed** "From" and "To".
- Disabled until "Custom" is active. Then they become editable.
- Empty value: no limit on that side (open range).
- "from": the first local day included. "to": the last local day included.
- Validation: **Proposed** if "from" is after "to", the inputs show the error "The start date must be on or before the end date." The list does not run until the error is fixed.
- No minimum or maximum date is set in the inputs.

### 4.11 Folder bar
- Count: 1 "All folders" button, one button per folder, and 1 "+ Create a new folder" button.
- Default: "All folders" (active). Only one button is active.
- Folder button label: "<folder name> (<count>)". The count ignores the other filters.
- Folder list order: name, A to Z, ignoring case.
- "Unsorted" always appears, even with a count of 0.
- If two folders share a name, the second label shows the folder ID: "Name (#id)".
- The folder bar scrolls sideways on phones (section 9). On desktop it wraps onto more lines.
- There is no limit on the number of folders in code.
- Folder colour (built in PR #102): each folder has one hue. The hue comes from the position of the folder in the list: position x 137.5 degrees, modulo 360. This keeps close positions far apart on the colour wheel.
  - Where it shows: the folder name in the side list, and the colour bar of each bookmark card (5.2). "All folders" has no hue. The selected folder keeps its colour, so it still matches the colour bar of its bookmarks. Bold text and a 1 px line above and below the name, in the folder colour, mark it. For "All folders", the line has the text colour.
  - A folder that is not in the list yet gets a hue from a hash of its folder ID.
  - Text contrast: at least 4.5 to 1 in dark theme and in light theme, for all hues. The text lightness is 74 % in dark theme and 24 % in light theme.
  - Known limit: a new folder in the middle of the list moves the colours of the folders after it. The side list shows the new colours at once. The bars in the list can keep the old colours until the next redraw.
  - The folder chips in the phone filter row (section 9) have no colour.

### 4.12 Create folder box
- Opens when the user clicks "+ Create a new folder". The box is hidden at first.
- Items, in order: name input, "Create" button, "Cancel" button, error text.
- Name input: placeholder "Folder name". Focus moves here when the box opens.
- Validation:
  - The name is trimmed. An empty name is refused: "The folder name is empty."
  - A name over 100 characters is refused: "The folder name can have at most 100 characters." (Proposed)
  - A name that matches an existing folder, ignoring case, is refused: "A folder named <name> already exists."
- Keys: Enter in the name input runs "Create". Escape closes the box.
- "Create": disabled while the request runs.
- "Cancel": closes the box, clears the input and the error.
- On success: the box closes, the folder bar reloads, and the new folder is not selected for filtering.
- Creates a top-level folder only.

### 4.13 Result count line
- Where: last row of the header, left side. Count: 1.
- Text when the list is loaded: "Showing <from>–<to> of <matched> bookmarks" (**Proposed** with paging). Example: "Showing 1–50 of 312 bookmarks".
- Text with no filter: "<matched> bookmarks". One result reads "1 bookmark" in each text of this line.
- With a filter other than the date, the text names the filters after the count, separated by commas: "in folder <folder>", "with tag #<tag>" (or "with tags #a, #b"), "matching \"<text>\"", "new only", "unsorted or with no tags" (with the switch of 4.5: "unsorted and with no tags", "unsorted" or "with no tags"), "in duplicate groups", "visited" or "not visited". Example: "Showing 1–4 of 4 bookmarks in folder Business & Startups, with tag #docs". The date filter is not in the text, because the date tabs show it.
- No match: "No bookmarks match" with the same filter text, for example "No bookmarks match in folder Business & Startups."
- Loading text: "Loading bookmarks <loaded>/<total>", then "Loading bookmarks..." when the total is not known yet.
- Start text: "Loading...".
- Error text: the server message, or "Load failed: " or "Start failed: " plus the reason.

### 4.14 Status line
- Where: same row as 4.13, after the count. Count: 1. Grey text.
- Announced to screen readers (section 10).
- Shows one of these texts:
  - The pull result (4.8).
  - "Checking for new bookmarks..." (during a pull).
  - Save result texts (5.5 and 5.7).
  - Bulk result texts (5.6).
  - "Error: Your sign-in ended. Reload the page to sign in again." (a request got a redirect to the sign-in page, in any request that uses the JSON helper).
- The old text "First 500 shown. Narrow the filter to see more." is **removed**. Paging replaces it.

## 5. Bookmark list

### 5.1 List area and paging
- Count: 0 to the page size (25, 50 or 100). The total can be any number.
- Empty result: "No bookmarks match."
- Before the first load: "Loading...".
- Note: the same empty text appears when the account has no bookmarks at all. **Proposed:** a second text for that case, "No bookmarks yet." (section 8, point 9).
- Cards are in one column, with 8 px between them.

**Paging controls (Proposed).** They appear above and below the list. They are one control group:
- "Previous" button. Disabled on page 1.
- Page text: "Page <n> of <total pages>".
- "Next" button. Disabled on the last page.
- Page size select: options 25, 50 and 100. Default 50. Changing the size returns to page 1.
- Keyboard: Previous and Next are buttons in the tab order.

Server: the list call takes `page` and `pageSize`. It returns the total count, so the UI can show the page count. The 500-result cap is removed.

### 5.2 Bookmark card
Each card holds these items, from left to right and top to bottom:

0. Colour bar (built in PR #102). A narrow bar on the left edge of the card. Its colour is the hue of the bookmark folder (4.11). It does not show the domain. The bar is decoration: it has no text and is hidden from screen readers.
1. Selection checkbox (**Proposed**, section 5.6). Count: 1. Label for screen readers: "Select <title>".
2. Title link.
   - Text: the bookmark title. If the title is empty, the link is used.
   - Opens the bookmark link in a new tab. The app counts the visit first.
   - Accessible name: **Proposed** "<title>, opens in a new tab".
   - Link colour blue, bold. No underline.
   - No cut-off in code. **Proposed:** a two-line cut-off with the full title in the tooltip.
   - If the bookmark link is not a web link (http or https), the new tab shows a JSON error. **Proposed:** the card shows a note "This link cannot be opened." and the title is plain text.
3. Badges, on the title line. Maximum 2 status badges, and one duplicate badge.
   - "New" (green): found by a pull and not yet saved.
   - "No folder or tags" (amber): the folder is Unsorted or the tag list is empty, and the card is not "New".
   - "Same URL as 1 other" or "Same URL as <n> others" (red): other bookmarks have the same definite key (4.5).
   - Or "Possibly same URL as 1 other" or "...<n> others" (amber): other bookmarks have the same possible key only. A card shows one of these two badges, not both. A kept group and a bookmark in Archive give no badge.
4. Meta line (small, grey). Each part is a separate element with space between the parts. The line has no " · " separators:
   - Domain (may be empty).
   - Folder label.
   - Created date and time, in the user's local time, for example "17 Oct 2026, 13:05" (**Proposed** format; the current code shows the UTC date only).
   - Age, in brackets, for example "(3 days ago)".
   - Visit text (5.3).
5. Tag chips. One chip per tag. No remove button in the list view. Empty when there are no tags.
6. Excerpt (optional). Grey text. Up to 200 characters. Not shown when the excerpt is empty.
7. Action area (**Proposed**: all cards have it):
   - "Edit" button (5.4). Shown on every card.
   - "Suggest folder and tags" button (5.4). Shown for "New" cards and for cards with "No folder or tags" only.
   - The editor (5.5), when it is open. It replaces the action area.

Card style: an open row with a thin line below it. The title uses the serif font Source Serif 4. The file is served from `app/frontend/fonts/`, because the content security policy allows only fonts from the same origin.

### 5.3 Age text and visit text
- Age text (after the created date), by age:
  - Under 60 minutes: "<n> minute(s) ago" (at least 1 minute).
  - Under 24 hours: "<n> hour(s) ago".
  - Under 21 days: "<n> day(s) ago".
  - Under 6 months: "<n> week(s) ago" (whole weeks).
  - Older than 6 months: "more than 6 months ago".
- Visit text, after the age text:
  - Visited: "visited <n>× (last <date and time in local time>)". The "×" is a multiplication sign.
  - Not visited: "not visited".

### 5.4 Edit and suggest buttons (single bookmark)
- **Edit** (Proposed, new): opens the editor with the current folder and tags. Label "Edit". Count: 1 per card.
- **Suggest folder and tags**: count 1 for each "New" card or card with "No folder or tags".
  - While the request runs: disabled, text "Asking the model...".
  - The button has a title that names what goes to the language model: the title, link, note, excerpt, current folder and tags of the bookmark, the folder names and the known tags.
  - The request uses the same prompt as the batch suggestion (5.6), with one bookmark.
  - Success: the editor opens with a suggestion note (5.5, item 0). Nothing is saved yet. The suggestion keeps the existing tags and adds up to 4 tags, inside the limit of 20 tags. The folder in the editor follows this table:

    | Answer of the model | Folder in the editor | Suggestion note |
    |---|---|---|
    | An existing folder, and the bookmark is in Unsorted | The folder of the model. | "Suggestion: " plus the reason. |
    | An existing folder, and the bookmark is in a different folder | The current folder. | The reason, and "Suggested folder: <name>" with the button "Move to this folder". After the button, the text is "Suggested folder: <name> (selected)." |
    | A proposed new folder | The current folder. | The reason, and "The model proposed a new folder: <name>." with the button "Use this name". The button opens the new folder row (item 2) with the name. Only "Create folder" creates the folder. |
    | No folder | The current folder. | The reason, in amber. |

  - The reason is amber when the model is not sure (status "needs review").
  - When suggested tags did not fit in the limit, the note adds "<n> suggested tags were left out: a bookmark can have at most 20 tags."
  - Profile tags: when the user has active entries in "My context" (section 11), the model can link the bookmark to at most 2 entries. For each one, the note has a check box "Add tag: <tag> (from your profile: <entry name>)". The box is not checked at first, and the tag is not in the tags of the editor. A checked box adds the tag to the tags, with the tag rules of the editor. A cleared box removes it. A tag that the bookmark has is not offered. A tag that does not fit in the limit of 20 tags is not offered.
  - The title of the button also names the active entries of "My context".
  - "Save" stays the only write.
  - Failure: the editor opens with the current folder and tags, and the red text "Suggestion failed: " plus the reason.

### 5.5 Editor (single bookmark)
The editor is a dashed blue box under the card, in place of the action area. It holds these items:

| # | Element | Count | Rules |
|---|---|---|---|
| 0 | Suggestion note | 0 or 1 | Only after "Suggest folder and tags" (5.4). It stays while the editor is open. |
| 1 | Folder label and select | 1 select | Label "Folder". The select lists every folder (including Unsorted) and one last option "+ Create a new folder...". The current folder is selected (or the suggested folder). A value is always selected. |
| 2 | New folder row (only after the last option is chosen) | 1 row | Input "New folder name", button "Create folder", button "Cancel". Same rules as 4.12. Error text: "Create folder failed: " plus the reason. A new folder is selected after it is created. |
| 3 | Tag row | 1 row | Label "Tags". Shows the tag chips, or "none" when there are no tags. |
| 4 | Tag chip | 0 to 20 | Tag text and a remove button. The remove button's accessible name is "Remove tag <tag>". |
| 5 | Add tag input | 1 input | Label "Add tag". Placeholder "Add tag, press Enter". Enter adds the tag. Focus stays in the input after Enter. Suggestions from the tag list in 4.7. |
| 6 | Save button | 1 | Label "Save". Disabled while the save runs. |
| 7 | Discard button | 1 | Label "Discard". Closes the editor and drops all changes. If changes exist, **Proposed:** a confirm step. |
| 7a | Archive button | 1 | Label "Archive". Saves the tags in the editor and moves the bookmark to the folder named "Archive". The folder rules are the same as for the bulk "Archive" (5.6). Disabled while the save runs. Status text: "Moved to Archive." Error text: "Create folder Archive failed: " plus the reason. |
| 8 | Error text | 0 or 1 | Red. Shows "Save failed: " plus the reason, or a suggestion or folder error. |
| 9 | Warning text | 0 or 1 | Amber. Used only for the tag mismatch case (5.7). |

Validation in the editor:
- Folder: required. Always one value.
- Tags, add rule:
  - The text is trimmed. Empty text is ignored.
  - A tag that already exists in the list, ignoring case, is ignored.
  - A tag over 50 characters is refused: "A tag can have at most 50 characters." (Proposed)
  - A tag with a comma is refused: "Tags cannot contain commas." (Proposed). The current code keeps the comma; this changes it.
  - A 21st tag is refused: "A bookmark can have at most 20 tags." (Proposed)
- Tags, remove rule: any tag can be removed. Zero tags is allowed.

Save result:
- Success: the editor closes. The card shows the new folder, the new tags and the correct badges.
- Folder and tag counts in the header reload.
- Failure: the editor stays open, with the error text and the chosen values.

Discard result: the editor closes. The card returns to its earlier state.

### 5.6 Multi-select and bulk edit (Proposed, new)

**Selecting bookmarks**
- Each card has a checkbox (5.2, item 1).
- Shift+click selects a range of cards on the page. Space toggles the focused checkbox.
- The header toolbar has a "Select all on this page" checkbox. It has three states: none, some (indeterminate), all.
- After "Select all on this page", a link appears: "Select all <total> matching bookmarks". The link selects every bookmark that matches the filters, on every page. The app limit is 1,000 (section 0.2). Above 1,000, the link is replaced by: "Only the first 1,000 can be selected. Narrow the filters." (Proposed)
- The selection count is always visible: "<n> selected". A "Clear selection" button sits next to it.
- A filter change, a sort change, or a page change keeps the selection **only** for the page change (**Proposed** decision, section 8, point 1). Filter and sort changes clear it.

**Bulk action bar**
- Appears when at least one bookmark is selected. It stays visible while the list scrolls.
- Wide screens (1,100 px and more): the bar is a side drawer to the right of the list. The list column keeps space for the drawer.
  - One selected bookmark on the page: the drawer is aligned to the row of that bookmark.
  - More than one selected bookmark: the drawer fills the visible part of the list column. The actions are in the middle.
  - The left edge of the drawer has a point, like the middle of "{", next to each selected row in view. The points move with the rows when the list scrolls.
  - The drawer always stays inside the visible part of the page.
  - Hover (wide screen with a mouse, no selection, no running update): the mouse on a row opens the drawer for that one bookmark, with a point to the row. The header shows "Bookmark <n>". "Clear bookmarks selection" is not shown.
    - The drawer opens after 120 ms. It moves to another row only after the mouse stays on that row for 300 ms, so a short pass over a row on the way to the drawer does not move it.
    - The drawer closes 700 ms after the mouse leaves the list and the drawer. The user has this time to move the mouse to the drawer.
    - A click on an action selects the bookmark. The action then works as for a selection.
    - The row buttons "Edit" and "Suggest folder and tags" do not show on hover. They stay for the keyboard and show when the keyboard focus is on them.
- Narrow screens (less than 1,100 px): the bar sits above the footer. On phones it is a bottom bar (section 9).
- Text: "<n> selected".
- Actions (all in one bar), in this order:
  - "AI Suggest folder and tags" (Proposed). It asks the model for each selected bookmark. It saves nothing. See the batch suggestion rules below.
  - "Edit": opens the editor of the row (5.5), as the "Edit" button of the row does. It shows only when the drawer is for one bookmark on this page: one selected bookmark, or a hovered row.
  - "Move to folder": opens a folder select with the folders in 5.5 (item 1) and "+ Create a new folder...". Required.
  - "Add tags": the tag input from 5.5 (item 5). At least one tag. The tags are added to each bookmark. Existing tags stay. Same validation as 5.5.
  - "Remove tags": shows the tags that appear on the selected bookmarks, with counts (for example "work (12)"). Choose one or more. At least one tag. The tags are removed from each bookmark that has them.
  - "Archive": moves the selected bookmarks to the folder named "Archive". If no folder has that name, the app creates a top-level folder "Archive" on Apply. If more than one folder has that name, the app uses the oldest one (the lowest ID). The server refuses a second folder with a name that is in use, so the app never creates one. Archive is a move, so the progress panel and "Undo" work the same. Undo does not delete the created folder.
  - "Clear bookmarks selection".
- Each action opens a confirm step. The confirm step shows the action, the count, and the target:
  - "Move 42 bookmarks to <folder>?"
  - "Add 2 tags to 42 bookmarks?"
  - "Remove 1 tag from 42 bookmarks?"
  - "Move 42 bookmarks to the folder Archive?" When the folder does not exist, the text adds: "The app creates the folder Archive."
  - Buttons: "Apply to 42 bookmarks" and "Cancel". The primary button is not the default when the count is over 100 (**Proposed**).
- Count rule: a bulk action of more than 100 bookmarks shows a progress panel (below).

**Progress panel (Proposed)**
- Shows: "Updating <done> of <total> bookmarks." and a progress bar.
- While a job that changes bookmarks runs, the list reloads at most every 3 seconds, so a saved bookmark leaves a filter that it no longer matches. While the focus is in the list or in the paging controls, this reload waits, so the focus and the text cursor stay. The end of the job reloads the list again.
- While a job runs, the drawer (or the bulk bar) shows the name of the job above the panel: "Move to folder", "Add tags", "Remove tags", "AI Suggest folder and tags", "Apply suggestions" or "Undo". A job of another kind shows "Update".
- When a suggestion job ends with no suggestion, no review opens. The drawer closes, and the focus goes to "Select all".
- Button: "Cancel the update". Stops the remaining bookmarks. The bookmarks already changed stay changed.
- The update runs on the server. Closing the page does not stop it. The panel returns on the next visit, while the update runs.
- When done, the result text is shown in the status line: "Updated <n>. Not updated <m>." When some bookmarks already had the target state, the text adds "No change needed for <u>." after "Updated <n>." These bookmarks are not counted in <n>. If <m> is more than 0, a link shows the list of failures with the reason for each.
- The list reloads at the end.
- If the Admintools sign-in ends while the panel is open, the gateway redirects each request to its login page. The app detects the redirect. The text shows "Your sign-in ended. Reload the page to sign in again." The app stops the state requests. The update continues on the server.

**Undo (Proposed, optional for version 1)**
- After a bulk action, the status line shows "Undo" for 30 seconds. Undo restores the previous folder and tags of each bookmark.
- A bookmark that changed again after the bulk action, in this app or in Raindrop itself, is not restored. Undo reads each bookmark from Raindrop before it compares. The details list it with the reason "Changed after the update. Not restored."
- Undo uses the same progress panel.

**Rules for bulk actions**
- A bookmark that already has the target value is counted as "no change". It is not an error.
- Bulk tag removal uses one request for each bookmark, because Raindrop appends tags in bulk. This is why the progress panel is required.
- A bulk action is refused when the selection has 0 bookmarks.
- A bulk action for 1,000 bookmarks takes about 12 minutes with tag removal (section 0.2).

**Batch suggestion (Proposed, new)**
- Starts at once. It has no confirm step, because it saves nothing.
- The model sees 10 bookmarks in each request. The progress panel reads "Suggesting for <done> of <total> bookmarks."
- Each row on the page that is part of the job shows an AI mark after the row number. The colour is blue (#01A1FE; #0083D1 in the light theme).
  - While the model works on the bookmark: a drop that bounces. It squashes on the ground, stretches up, goes flat at the top, and falls. A ring spreads on the ground at each jump. One loop takes 1 second.
  - When the suggestion for the bookmark is ready: a check (V) in the same colour.
  - A bookmark with no suggestion loses its mark.
  - A check stays while its card is open in the review. Without a review, the checks go after 5 seconds.
  - The suggestion for one card ("Suggest folder and tags" on the card) shows the bouncing drop too.
  - With reduced motion, the drop and the check do not move.
- The model answers in the v2 format. Each answer has a folder decision, existing tags, new tags, a status and a reason.
- The folder decision is "existing", "propose" or "none". A "none" decision never moves a bookmark to Misc.
- The status is "ready" or "needs_review". A "none" decision always needs review.
- A bookmark with no answer, or with an answer that breaks the format, needs review.
- The review is in the actions drawer (wide screens) or the bulk bar (narrow screens). It is not a dialog. While the review is open, it fills the drawer. The selection actions and the hover drawer do not show.
- The drawer has a head that stays at the top while the cards scroll: the title "Suggested folders and tags", the text "Nothing is saved yet. Apply also adds the proposed new tags. A bookmark that is in a folder stays there unless you select the suggested folder. A new folder is used only when you choose it.", "Apply all (<k>)" and "Clear all" (not with one card, see below). The privacy notice is at the end of the cards.
- Every bookmark with a suggestion gets one card. A failed model request is counted in "No suggestion for <m>." The "Show details" link gives the reason.
- A card shows the row number (when the row is on this page), the title, a label with the reason, the folder and the tags. The label is one of these:
  - "Ready": the model is sure, and the folder exists. "Apply all" takes the card.
  - "New folder proposed": the model is sure, but the folder does not exist. The folder line shows "<name> (new folder, proposed)".
  - "Needs review": the model is not sure, or it gave no folder.
  - "Folder change suggested": only for a bookmark that is in a folder. The model is sure, and its only suggestion is a different folder. The card changes nothing until the user decides, so "Apply all" does not take it, and its "Apply" button is disabled. The user selects the suggested folder, changes the card in "Edit", or removes it with "Clear".
- **A bookmark that is in a folder keeps its folder.** The folder of the model is only a suggestion for it. This protects bookmarks that the user sorted before.
  - The card starts with the current folder. The label is "Ready" when the model is sure and the card has a tag change.
  - When the model gave a different folder, the card shows "Suggested folder <name>" with the button "Move to this folder". For a folder that does not exist, the name ends with "(new folder)" and the button reads "Use the new folder".
  - After the user selects the suggested folder, the card shows "Moves from "<current folder>"." with the button "Keep the current folder". The focus goes to that button. A selection in either direction is a decision of the user, so "Apply all" then takes the card.
  - "Apply" and "Apply all" send the folder that the card shows. Without a selection, that is the current folder. With a selection, both actions use the selected folder, also a new one.
  - A proposed folder is never created for a selection that the user did not make.
  - A "none" decision keeps the current folder, and the card needs review.
  - In "Edit", a line under the folder select reads "Suggested folder: <name>. The bookmark stays in "<current folder>" unless you choose a different folder."
  - A bookmark in Unsorted is not protected: its card starts with the folder of the model, as the rules below describe.
- After the first bookmark of the review is saved, the head text changes to "Applied bookmarks are saved in Raindrop. The cards below are not saved yet." A bookmark that already had the folder and tags counts as saved. If every bookmark of an apply fails, the text does not change.
- The tags on the card are the tags that Apply saves. A proposed new tag shows with "(new)" after it. When the card has no tags, "none" shows in the warning colour. Each row with an open card has a point on the drawer edge.
- Each card has three buttons:
  - "Apply": saves this bookmark only. Disabled when the card has no folder. On a card with a proposed folder, the button reads "Create folder and apply". It creates the proposed folder and saves the bookmark. "Edit" lets the user choose another folder.
  - "Edit": shows a folder select, a tags field and the proposed new tags. The button then reads "Done".
  - "Clear": drops this suggestion. Nothing is saved for this bookmark.
- A new folder is a proposal. It is used only when the user chooses it. A proposed folder appears in the select as "New folder: <name>". The user chooses it with "Create folder and apply", or in "Edit".
- A proposed new tag is ticked at first. Apply and "Apply all" add it. In "Edit", each proposed new tag has its own checkbox. The user clears the checkbox to remove the tag. A cleared new tag shows on the card as "Proposed new tags not used: <tags>. Choose Edit to add them."
- Profile tags: when the user has active entries in "My context" (section 11), a card can have the block "From your profile", with a check box "Add tag: <tag> (from your profile: <entry name>)" for at most 2 entries. The box is not checked at first. It shows on the card and in "Edit". Apply and "Apply all" add a profile tag only when its box is checked. A checked tag shows in the tags of the card with "(profile)". A check counts as a change of the card. The entry name is the name at the time of the suggestion. A tag that the bookmark has, or that does not fit in the limit of 20 tags, is not offered.
- The app checks the tags before the review opens, so a "Ready" card does not fail in "Apply all" because of its tags. A suggested tag with a comma or with more than 50 characters is dropped. The suggested tags are added only while the bookmark stays at 20 tags or fewer. The known tags come first. When tags are left out because of the limit, the reason adds "<n> suggested tags were left out: a bookmark can have at most 20 tags."
- When the current tags of the bookmark already break a limit (more than 20 tags, or a tag with more than 50 characters), the card needs review. The reason starts with the limit message and "Edit the tags, then apply.".
- "Apply all (<k>)" saves the cards that have a folder and are "Ready", or that the user edited. It does not take a card with the label "Folder change suggested". It creates a new folder only for a card where the user chose "New folder: <name>" in "Edit". A failed "Create folder and apply" does not add its card to "Apply all".
- A summary under the buttons gives the state of the review, for example "20 of 50 changed. 4 already as suggested. 3 ready for "Apply all". 20 need your decision: apply each one, or choose Edit. 3 got no suggestion." A part with the number 0 does not show. "<n> of <total> changed" counts the bookmarks that the apply jobs of this review changed in Raindrop. "<m> already as suggested" counts the bookmarks that already had the folder and the tags of the apply. The app does not send these to Raindrop. <total> is the number of bookmarks in the suggestion job. While an apply job runs, the count goes up with each saved bookmark, and the summary adds "Saving <n> more." The other cards stay open for a decision during the save. After a cancelled suggestion, the summary adds "<n> not done: the suggestion was cancelled."
- "Clear all" drops all suggestions. Nothing is saved.
- With one card, "Apply all", "Clear all" and the "Apply all" and decision parts of the summary do not show, because the buttons of the card do the same. The drawer is then aligned to the row of the card, as for one selected bookmark. This also applies when a review goes down to one card.
- An applied card or a cleared card leaves the drawer, and its row loses the check. The review closes after the last card.
- Apply creates each approved new folder once, before the moves. A folder with a name that matches an existing folder, ignoring case, is not created. If a folder cannot be created, its rows fail and are not moved.
- Apply checks the final tags of each row. A row with bad tags fails alone. The other rows go on.
- Each bookmark gets its own folder and tags in one single update. The result uses the normal progress panel. Undo is offered as for other bulk actions. Undo does not delete a created folder.

### 5.7 Save message about tags
- The message in the status line changes from the old text:
  - Old text (remove): "Saved, but Raindrop returned different tags. Check classify-log.jsonl."
  - New text (Proposed): "Saved. Raindrop stored different tags than you chose. Review the tags on this bookmark."
- Reason for the change: the old text names a log file (`classify-log.jsonl`). The app no longer writes that file. The change log is now a database table (`classify_log`). Users cannot open either one. Section 8, point 4 explains more.

## 6. Footer and page-wide items

**Footer (Proposed).** The current UI has no footer. The proposed footer is a thin bar at the bottom of the page. It holds:
- "Last checked: <date and time in local time>". The value is the last successful "Check for new bookmarks". If none, "Never checked".
- "Synced <age>", for example "Synced 3 hours ago". It shows how old the stored copy of the bookmarks is. Only the stored copy has it (section 6.2). Built in PR #96.
- App version (for example "v1.4.2"). Read from the server build.
- Link "Open Raindrop" (opens Raindrop in a new tab).
- The footer is not sticky. On phones it sits under the paging controls.

**Other page-wide items**
- Paging controls (5.1). Above and below the list.
- The bulk action bar (5.6), when a selection exists.
- Skip link "Skip to results" (section 10). It is hidden until it receives keyboard focus.
- No sort or filter reset button. **Proposed:** a "Clear filters" button in the header row, shown when a filter is active.
- No keyboard shortcut for search, save or discard. Out of scope for version 1.

### 6.1 Keyboard shortcuts (Proposed)
- The shortcuts work when no text box, select or dialog has focus.
- Down arrow: moves focus to the checkbox of the next row. The first press focuses the first row.
- Up arrow: moves focus to the checkbox of the previous row. Focus stops at the first and last row.
- Space: marks or unmarks the row whose checkbox has focus. This is the normal checkbox behaviour.
- Right arrow: goes to the next page. Left arrow: goes to the previous page. Nothing happens on a disabled button.
- After a page change by keyboard, focus moves to the first row of the new page.
- Ctrl+A (Cmd+A on macOS): selects every row on the page. Press again to clear them. It has the same effect as "Select all on this page" (section 5.6).
- Escape: closes the create folder box (4.12), the editor when nothing changed (5.5), and the filter sheet (9).
- ?: opens the keyboard help dialog. The left sidebar has the button "Keyboard shortcuts (?)" for the same dialog. The dialog lists these shortcuts. Escape or "Close" closes it.

### 6.2 Synced text (built in PR #96)

The app can keep a stored copy of the bookmarks in its own database. The footer text and the warning are built (PR #96, merge commit `87ff179`). The owner confirmed the copy by the merge on 2026-11-10. The page reads `/api/me` again after the first load and after each check, whether it worked or failed. A full sync fills the copy. The copy can be up to 24 hours old, because a change in another Raindrop tool reaches the copy at the next sync. This text tells the user how old the copy is.

| # | Element | Count | Rules |
|---|---|---|---|
| 1 | Synced text | 0 or 1 | A `time` element in the footer, after "Last checked". The text is "Synced " plus the age text. The `datetime` attribute holds `syncedAt`. The `title` attribute holds the date and time in local time (section 0.3). |
| 2 | Old data warning | 0 or 1 | Amber text after the synced text: "The last sync failed. The data can be old." It shows when `syncError` has a value. |

Rules:
- **When it shows.** Show the elements only when the answer of `/api/me` has the field `syncedAt`. The field exists only when the stored copy is on. When it is off, the footer has no synced text and no warning, as before.
- **Age text.** Use the age rules of section 5.3, with the words "Synced" in front: "Synced 1 minute ago", "Synced 3 hours ago", "Synced 2 days ago". The age is never shorter than 1 minute. The browser computes it from `syncedAt`.
- **No time yet.** When `syncedAt` is `null`, the text is "Not synced yet". The first sync runs while the page loads (section 1, state "Loading"), so the user sees this text only for a short time, or after a failed first sync.
- **The warning.** Do not show the text of `syncError`. It can hold names of tables or addresses that the user does not need (section 8, point 4). The warning has no button. The next sync clears it.
- **Update.** Read `/api/me` again when the page loads, and after "Check for new bookmarks" finishes. That action runs a full sync. Compute the age text again every 60 seconds while the page is visible.
- **Screen readers.** Do not use a live region. The text changes slowly, and a live region would speak it at each update. The warning is plain text in the footer, and it is read in the normal reading order.
- **Colors.** The amber warning follows the contrast rules of section 10. It must not be the only sign: the words carry the meaning.
- **Phone.** The text sits in the stacked footer (section 9), under "Last checked".

## 7. Server rules (validation on the backend)

These rules apply in addition to the screen rules. The screens must show the errors.

| Endpoint | Method | Input | Rule | Error text shown |
|---|---|---|---|---|
| /api/bookmarks | GET | q, tags, collection, sort, visited, status, needs, preset, from, to, tz, page, pageSize | Adds **page** (default 1) and **pageSize** (25, 50 or 100; default 50). `from` and `to` are local dates. `tz` is the user's IANA zone. With `status=dupes`, the answer also has `groups` (each with `section`, `key`, `ids`, `note` and `why`) and has no pages: `results` holds all the bookmarks of the groups. Each result has `dupes` (other bookmarks with the same definite key), `maybe_dupes` (other bookmarks with the same possible key only), `url_key` (the definite key), `loose_key` (the possible key), `dupe_note` (the kind of link, for example "YouTube video"), `maybe_why` (the reason for a possible match) and `period` (the narrowest date preset that has the bookmark: `today`, `last7`, `last30` or `older`). Returns `total`, `matched`, `page`, `pageSize`, `pages`, and `presets` (the date counts with all filters except the date). With `status=needs`, `needs` (`both`, `folder` or `tags`) narrows the list (section 4.5), and the answer also has `needsCounts` (`any`, `both`, `folder`, `tags`: the count of each kind with all the other filters, the date too). | Count line shows the error text. |
| /api/me | GET | none | Gives the user, the connection, `lastChecked`, and, when the stored copy is on, `syncedAt` (ISO time of the last full sync, or `null`) and `syncError` (text of the last failure, or `null`). With the copy off, the two fields are not in the answer. | The footer shows no synced text (section 6.2). |
| /api/meta | GET | tz | Preset counts use the user's day boundaries from `tz`. | Count line shows "Load failed: ...". |
| /api/pull | POST | none | First call saves a baseline. | Status line shows the server text. |
| /api/changes | GET | none | The quick check. One Raindrop call reads the newest 25 bookmarks. Returns `added` (how many of them are not in the app) and `more` (true when all 25 are new). Changes nothing and takes no queue turn. The server keeps the answer for 60 seconds for each user. A full check clears it. | Nothing shows. The button keeps its label. |
| /api/suggest | POST | id | Bookmark must exist. Returns `folderId`, `folder` and `label` (the folder that the editor selects), `tags`, `tagsLeftOut`, `reason`, `status` (`ready` or `needs_review`), `suggestedFolder` (`id` and `label`, or null), `proposedFolder` (a name, or null) and `profileTags` (a list of `tag`, `entryId` and `entryName`; not in `tags`). 502 when the model gives no answer for the bookmark. | "Suggestion failed: ..." in the editor. |
| /api/save | POST | id, folderId, tags | folderId must be an existing folder ID, including -1 (Unsorted). Tags are trimmed. Duplicates are removed. Max 20 tags, 50 characters each, no commas. | "Save failed: ..." in the editor. |
| /api/bulk | POST | action (move, addTags, removeTags), ids or filter, folderId or tags | Max 1,000 bookmarks. Returns a job ID. Filter-based selection is resolved on the server. | "Bulk update failed: ..." in the status line. |
| /api/bulk/{jobId} | GET | jobId | Returns done, total, failed list, status (running, done, cancelled). | Progress panel shows "Update failed: ...". |
| /api/bulk/{jobId}/cancel | POST | jobId | Stops the remaining items. | Progress panel shows the server text. |
| /api/duplicates/keep | POST | section (definite or possible), key | The group must exist now. The server stores the IDs that the group has now. Runs in a turn of the user's queue. | "Keep all failed: ..." in the status line. |
| /api/duplicates/unkeep | POST | section, key | Shows the group again (Undo). | "Undo failed: ..." in the status line. |
| /api/folder | POST | name | Name is trimmed. Max 100 characters. Empty is refused. Duplicate name (ignoring case) is refused. | "Create folder failed: ..." in the editor or the create folder box. |
| /go/<id> | GET | id | Bookmark must exist and have a web link. | JSON error in a new tab. **Proposed:** a page that says "This link cannot be opened." |
| /api/disconnect | POST | none | Removes the Raindrop connection for the user. The profile stays. | Confirm box, then page reload. |
| /api/profile | GET | none | The profile of the user (`docs/profile-plan.md`). Works without a Raindrop connection. Returns `entries` (each with `id` as decimal text, `kind`, `name`, `description`, `tag`, `active`, `source`, `sourceRef`, `updatedAt`), `budget` (`used` and `max`, in characters of the JSON text that goes to the model) and `limits`. | "Error: Load failed: ... Close this view and open it again." in the "My context" view (section 11). |
| /api/profile/entry | POST | id (text, only for a change), kind (about, project or interest), name, description, tag (or null), active, reuseTag | Works without a Raindrop connection. Text is trimmed. Name: max 60 characters, not for `about`. Description: max 300 characters, 600 for `about`. One `about` for each user. Tag: not blank, max 50 characters, no commas, not for `about`, and not the tag of a different entry (letter case is ignored). Max 40 entries. The active entries together: max 8,000 characters. With a connection, a new or changed tag that is already a Raindrop tag gives 409 with `tagExists: true`, unless `reuseTag` is true. If the Raindrop tags cannot be read, a new or changed tag gives 503 and nothing is saved. Runs in a turn of the user's queue. | "Error: Save failed: ..." in the form, or the text of the tag question (section 11.4). |
| /api/profile/entry/delete | POST | id (text) | The entry must belong to the user. Runs in a turn of the user's queue. | "Error: Delete failed: ..." in the row of the entry. |

Other server limits:
- Request body: maximum 64 KB.
- Raindrop calls: 120 per minute for each user (official). The app paces calls at 700 ms.
- Model calls: 10 per minute for the whole key.
- Admintools sign-out address: set in `config.js` as `ADMINTOOLS_LOGOUT_URL`. Set the value for each deployment. Each environment sets its own value.

## 8. Decisions and open points

1. **Selection and paging.** Decide if the selection stays across pages (Proposed: yes, within the same filter). Decide if "select all matching" is in version 1.
2. **Bulk limit.** The Proposed limit is 1,000 bookmarks for each action. Confirm the value.
3. **Editing sorted bookmarks.** Every card gets an "Edit" button (Proposed). Confirm this.
4. **Developer text.** The text "Check classify-log.jsonl." refers to a file that the app no longer writes. The change log is now the `classify_log` database table. The new copy is in 5.7. Users must not see log names.
5. **Single-update tag behaviour.** Resolved (issue #26). The single update replaces tags. The bulk update appends tags, and an empty list removes all tags. Remove a subset of tags with one single update for each bookmark (section 5.6).
6. **App limits.** Confirm the values in section 0.2. They are our rules, not Raindrop's. Test that Raindrop accepts folder names of 100 characters.
7. **Footer content.** Confirm the footer items in section 6. Confirm the app version source.
8. **Date format.** Confirm the local date format for cards (Proposed: "17 Oct 2026, 13:05").
9. **Empty states.** Confirm two texts: "No bookmarks match." (filters) and "No bookmarks yet." (account empty).
10. **Long text.** Confirm the title cut-off (two lines) and the name cut-off (40 characters).
11. **Disconnect dialog.** Confirm an in-page dialog. It needs focus handling (section 10).
12. **Undo.** Confirm if undo is in version 1 or later.
13. **Gate copy.** The sign-in text mentions the "Admintools" sign-in page. Check that users know the name.
14. **Logout label.** The product owner wrote the option "Logout from the Admintools?" with a question mark. A button label with a question mark is unusual. Proposed label: "Logout from Admintools". Confirm.
15. **Return after Admintools logout.** The Admintools sign-out page has no return address. The user cannot go back to the app from that page. Ask the Admintools owner if a return address can be added. Until then, the page stays as it is.
16. **Effect on other tools.** Option 2 ends the person's sessions in every Admintools tool on every device. Confirm that this effect is acceptable for the product, and that the help text under option 2 is clear.
17. **Keyboard help.** Section 6.1 lists the shortcuts. The sidebar button and the ? key open the list. Confirm if the footer also shows a short help line (Proposed: no).
18. **Batch suggestion cost.** A batch of 1,000 bookmarks makes 100 model requests. The endpoint allows 10 requests a minute, so the job takes about 11 minutes. Confirm that this is acceptable, and that the review step is required before any save.
19. **Single suggestion prompt.** The "Suggest folder and tags" button on one card still uses the first prompt. Stage 1 changes only the batch suggestion. Confirm if the card button should move to the v2 format, with the same review rules.
20. **Synced text.** Resolved (PR #96, 2026-11-10). The owner confirmed the copy in section 6.2: "Synced <age>", "Not synced yet" and "The last sync failed. The data can be old." The app keeps "Last checked" and the new text side by side, and the error text of the server stays hidden. The page was not checked in a real browser yet. That check is part of the production check with one test user.

## 9. Phone layout (Proposed, new)

**Breakpoints**
- Phone: up to 599 px wide.
- Tablet: 600 to 899 px.
- Desktop: 900 px and wider. The current layout is the desktop layout.

**Phone header**
- Top bar: account name (one line, cut-off rule in 4.1) and a menu button. The menu holds "Disconnect Raindrop" and "Check for new bookmarks".
- Search box: full width, on its own row. Placeholder kept. The label is visible above the box.
- Filter button: "Filters (<n>)". The number is the count of active filters. It opens a full-height sheet with: sort, status, visited, tags, date presets, custom dates, and folders. The sheet has "Show <n> bookmarks" as its main button. Close with a "Close" button or Escape.
- Folder row: a horizontal scroll row of folder chips. It is the only sideways scroll on the page. It has a visible label "Folder".
- Count line: one line, below the filter button.

**Phone list**
- One column. Cards use the full width, with a 16 px side gutter.
- Action buttons ("Edit", "Suggest folder and tags") go on their own row under the card.
- The editor takes the full width. Its fields stack. The folder select and the tag input are full width.
- Tag chips wrap.
- The title and the link text wrap. No sideways scroll for long links.

**Phone paging**
- A compact control: "Previous", "Page <n> of <total>", "Next". Page size moves to the sheet.

**Phone bulk bar**
- A bottom bar, fixed above the footer. It shows "<n> selected" and a "Actions" button. "Actions" opens a sheet with the bulk actions from 5.6.

**Phone footer**
- Stacked: "Last checked", "Synced <age>" and the warning (when shown, section 6.2), the version, and the Raindrop link.

**Touch targets**
- Buttons, checkboxes and chip remove buttons: at least 44 × 44 px on phones. WCAG requires 24 × 24 px at minimum (section 10).

**Reflow**
- The layout must work at 320 px wide with no sideways scroll, except the folder row.
- The layout must work at 400 % zoom on desktop (equal to 320 px wide).

## 10. Accessibility gaps and required fixes

The current UI has the gaps below. Each item lists the WCAG 2.2 reference and the fix. A designer and a developer must check each item.

| # | Gap in the current UI | WCAG 2.2 reference | Required fix |
|---|---|---|---|
| 1 | The search box, tag filter, sort, status and visited selects have no visible label. Placeholders only. | 1.3.1, 3.3.2, 4.1.2 | Add visible labels: "Search", "Tags", "Sort by", "Status", "Visited". |
| 2 | The date inputs have no label. | 1.3.1, 4.1.2 | Add labels "From" and "To". |
| 3 | The remove buttons on tag chips use "×" with no name. | 4.1.2 | Name each button "Remove tag <tag>". |
| 4 | The count line and the status line change, but screen readers do not hear it. | 4.1.3 | Use `role="status"` with `aria-live="polite"`. Use `role="alert"` for save and bulk errors. |
| 5 | The active preset and folder buttons show a blue fill only. | 1.4.1 | Add `aria-pressed` on toggle buttons, and a second cue, such as a check mark or bold text. |
| 6 | The "New" badge is white text on #16a34a at 11 px. Contrast is about 3.3 to 1. | 1.4.3 | Use a darker green (for example #15803d, about 5 to 1). Check with a contrast tool. |
| 7 | The input and button borders are #bbb on white. Contrast is about 1.9 to 1. | 1.4.11 | Use a border colour with at least 3 to 1 contrast, for example #767676. |
| 8 | Focus: the browser default only. | 2.4.7 | Define a visible focus ring on every control (2 px, at least 3 to 1 contrast). |
| 9 | Some controls are smaller than 24 × 24 px (the "×" and the preset buttons). | 2.5.8 | Set a minimum size of 24 × 24 px on desktop and 44 × 44 px on phones. |
| 10 | The editor opens with no focus change. Escape does not close it. | 2.4.3, 2.1.1 | Move focus to the "Folder" select when the editor opens. Return focus to the "Edit" or "Suggest" button when it closes. Escape closes the editor when nothing is changed. |
| 11 | The create folder error is not linked to the input. | 3.3.1, 3.3.3 | Link the error with `aria-describedby` and set `aria-invalid="true"` on the input. |
| 12 | The page has no top-level heading. | 1.3.1, 2.4.6 | Add a visually hidden `h1` "Raindrop search", and headings for the header, the list and the footer. |
| 13 | The page has no landmarks for the header, the list and the footer. | 1.3.1 | Use `header`, `main`, `nav` (for paging) and `footer` elements. |
| 14 | There is no skip link. | 2.4.1 | Add a skip link "Skip to results", which appears on focus. |
| 15 | The title link opens a new tab with no notice. | 3.2.5 (best practice) | Add "opens in a new tab" to the accessible name. |
| 16 | Checkboxes for bulk selection need names. | 4.1.2 | Name each checkbox "Select <title>". Name the header checkbox "Select all on this page". |
| 17 | The loading states ("Asking the model...") are not announced. | 4.1.3 | Announce the change with `aria-live`. Keep the disabled state. |
| 18 | The logout dialog (section 4.2) is modal. Its focus handling is not yet defined. | 2.1.2, 2.4.3 | Trap focus inside the dialog. Use Escape to close it. Start focus on "Cancel". Return focus to the "Logout" button when it closes. Give the dialog an accessible name from its heading. |
| 19 | The layout has no reflow rules. | 1.4.10 | Apply the reflow rules in section 9. |
| 20 | Errors use colour only in some places (red text). | 1.4.1 | Each error starts with the word "Error:" (screen readers and sighted users). Already true for most messages; check each. |

Other checks:
- The page language is set to English (`lang="en"`). Keep it.
- Keyboard: every action must work with the keyboard alone. Test Tab order, Enter and Space on each control.
- Test with a screen reader (VoiceOver on macOS) before release.

## 11. "My context" view (the profile of the user)

The user describes projects and interests here. The plan is `docs/profile-plan.md`. The server rules are in section 7. This version stores the profile only. Suggestions do not use it yet, and the view says so.

### 11.1 The view
- A modal dialog, up to 640 px wide, with a scroll bar when the content is higher than the screen. Heading: "My context".
- Opened by the "My context" button in the sidebar (4.1a) or in the connect message (3.3). It works without a Raindrop connection.
- Text under the heading: "Describe your projects and interests here. The app gives the active entries to the language model, so that a suggestion can link a bookmark to one of your projects. A suggested tag from an entry is added only after you select it."
- A list of five facts about the data:
  1. "The profile is stored in the database of this app."
  2. "The app sends the active entries to the language model with each suggestion request: the text about you, and the name, description and tag of each entry. An entry that is not active is not sent."
  3. "A tag from the profile that you then apply to a bookmark becomes a normal tag in Raindrop. For a confidential project, use a tag that does not show its name."
  4. ""Logout from Raindrop account" keeps the profile. "Delete my data" removes it."
  5. "Do not write passwords or other secrets here."
- When the profile goes to the model (plan PR 5), the text under the heading and fact 2 must change in the same change.
- Budget line: "The active entries use <n> of 8,000 characters. This total is the limit for active entries." A thin bar under it shows the used part.
- Button "Close" at the bottom. Escape also closes the view.
- While the profile loads, "+ Add an entry" and "Save the text" are disabled. A failed load shows "Error: Load failed: <reason> Close this view and open it again."

### 11.2 About you
- Heading: "About you". Label: "A short text about you (optional)". A text area with a counter, for example "47/600".
- Button: "Save the text". Status text after a save: "Text saved." An empty text deletes the stored text, with "Text deleted."
- A text with a change that is not saved stays in the box when an entry is saved or deleted. The stored text replaces it only when the view opens again.
- Error text: "Error: Save failed: " plus the reason.

### 11.3 Projects and interests
- Heading: "Projects and interests".
- Summary line: "<n> entries. The profile can have at most 40 entries. The text about you is one of them." With no entry: "No entries yet. Add a project or an interest."
- One row for each entry: the name in bold, then "<Kind>. <State>, tag "<tag>"." in grey, then the description. Buttons "Edit" and "Delete". Their accessible names have the entry name, for example "Edit Raindrop App".
- The kind is "Project" or "Interest".
- The state has one of three names:
  - "Context and tag": active, with a tag.
  - "Context only": active, no tag.
  - "Inactive": not active.
- "Delete" asks first, in the row: "Delete "<name>"? A tag that is already on a bookmark stays in Raindrop." with "Delete the entry" and "Keep the entry". The focus goes to "Keep the entry". After a delete, the summary line starts with "Entry deleted." A failed delete shows "Error: Delete failed: " plus the reason in the row, next to the question.
- Button: "+ Add an entry". It opens the form (11.4) and hides while the form is open.

### 11.4 Entry form
- Heading: "New entry" or "Edit "<name>"". The focus goes to "Name".
- Fields:
  - "Kind": Project or Interest.
  - "Name": max 60 characters.
  - "Description: what it is about": max 300 characters, with a counter.
  - Check box "Active. Only an active entry is part of the profile that the model gets." On at first.
  - "Tag (optional)": max 50 characters. Help text: "Suggestions can propose this tag for a bookmark that belongs to this entry. Leave it empty, and the entry is context only."
- For a project with a name and no tag, a button offers the default tag: "Use the tag "proj:<name>"". The name is in lower case, with "-" for spaces.
- When Raindrop is not connected: "Raindrop is not connected. The app cannot check if this tag is already a tag in Raindrop."
- "State: <state name>" shows the state that the entry will have. It changes while the user edits.
- Buttons: "Save the entry" and "Cancel".
- An empty name or description gives "Error: The name is empty." or "Error: The description is empty." The field gets `aria-invalid="true"` and the focus.
- The tag question: when the tag is already a tag in Raindrop, the server refuses the save. The form shows the server text, for example "The tag "Claude" is already a tag in Raindrop. Use a different tag, or confirm that this entry uses the same tag.", with the button "Use this tag anyway". The focus goes to that button. A change in the form hides the question.
- Other server errors show as "Error: Save failed: " plus the reason.
- After a save, the form closes and the focus goes to the "Edit" button of the entry. After "Cancel", the focus goes to that "Edit" button, or to "+ Add an entry".
- Escape closes the form when it has no change. With a change, Escape and "Close" keep the view open and show: "The entry has changes. Select "Save the entry" or "Cancel"."
- Some browsers close a dialog on a second Escape, and the page cannot stop that. So a form with a change stays as it is when the view opens again.
- After a save or a delete that worked, the view loads the profile again. If that load fails, the view shows "Error: The change is saved, but the view did not load again: <reason> Close this view and open it again." It does not say that the save failed.

### 11.5 Text direction
- The text that the user writes can be Hebrew. The three text fields and the name and description of each row have `dir="auto"`, so the browser takes the direction from the text.

### 11.5a Phone layout
- The dialog uses up to 94 % of the screen width. The buttons of a row go under the name. Buttons are at least 44 px high (section 9).

### 11.6 Delete my data
- The dialog text of "Delete my data" names the profile: "This removes the Raindrop connection and what the app keeps about you: the visit counts, the New marks, the log of changes with bookmark titles, and your profile ("My context"). Your bookmarks in Raindrop are not changed."
