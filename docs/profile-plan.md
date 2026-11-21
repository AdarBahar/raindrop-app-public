# Plan: a user profile for smarter suggestions

Status: decision P1 (the schema) is approved. PR 1 (the backend) is merged ([#139](https://github.com/AdarBahar/raindrop-app/pull/139)). PR 2 (the view) is merged ([#140](https://github.com/AdarBahar/raindrop-app/pull/140)). PR 3 (the protection of sorted bookmarks) is merged ([#141](https://github.com/AdarBahar/raindrop-app/pull/141)). PR 4 (the single-bookmark path on the v2 prompt) is merged ([#142](https://github.com/AdarBahar/raindrop-app/pull/142)). Its gate of section 9 passed, and the owner approved decision P6 on 2026-11-19. PR 5 (the profile in the prompt) is built on the branch `feat/profile-prompt`. Its gate of section 9 failed in the first run on 2026-11-19. The reply check changed after that run. A second run is recorded in section 9. It gave 4 wrong matches by a shared name, and the rule of section 7.1, item 2, was added on 2026-11-20 after it. The next run is the third run. PR 6 is not started. Date: 2026-11-18.
The plan had three reviews. The review documents are not kept in the repository. Sections 13 to 15 record each finding and its answer.
Revision 2 added the changes from the first review. Version 1 improves tags only.
Revision 3 adds the changes from the second review: the ID contract, tag ownership, the protection of sorted bookmarks before the model change, a stronger release gate, the adapter for the single-bookmark path, and two disclosures. Sections 13 and 14 give the answer to each finding.
Revision 4 adds the targeted corrections from the third review: the order of the tag checks, tags of inactive entries, the collision check without a ready copy, the "Apply all" contract, the tag-count text of the prompt, and the repository cap. Section 15 gives the answers. The design and the order of the pull requests did not change.

## 1. Problem

The suggestion prompt (`V2_SYSTEM` and `buildMessagesV2` in `app/backend/src/llm.js`) gives the model these items only:

- the folder names,
- the known tags,
- the title, URL, note and the first 300 characters of the excerpt of each bookmark.

The model knows nothing about the user. It cannot link a bookmark to a project of the user.

## 2. Evidence

A test on 2026-11-18 sent 99 bookmarks of the owner to the model three times. Nothing was saved.

| | A: prompt of today | B: with a profile | C: profile and folder descriptions |
|---|---|---|---|
| Bookmarks with a project tag | 0 | 11 | 1 |
| Bookmarks with a `context` entry | 0 | 39 | 49 |
| Same folder as now | 80 | 63 | 58 |
| New folders proposed | 3 | 3 | 8 |

These numbers are counts. They are not accuracy figures, because the test had no labeled answers.

What the test supports:

1. A profile can make the model give useful project tags (B).
2. The model names a profile entry much more often than it should. A named entry is not proof of a real relation.
3. A profile changes the folder proposals too: 36 changed folders in B, 19 in A. A prompt rule alone does not prevent this.
4. Broad folder descriptions cause more folder changes and more new folders (C).
5. Keyword matching without the model was wrong for about half of its hits.

What the test does not prove: that B is more accurate than A, or that all 11 project tags are correct. Section 9 defines the measurement that must prove it.

## 3. Goal and limits

Goal of version 1: better precision of project tags, from a small profile that the user approved, with no increase of wrong folder moves.

- The user keeps a profile: projects, interests, and one short text about the user.
- The suggestion prompt includes the active profile. The model can propose the tag of an entry for a bookmark that clearly belongs to that entry.
- The review shows which entry gave a tag. A profile tag is not selected at first. The user selects each one.
- A sorted bookmark keeps its folder unless the user selects a different folder. This protection is released before the profile reaches the model.
- A user with no profile gets the same bulk prompt as today, byte for byte.

The design aims for fewer wrong project links, not for more links.

Not in scope for version 1 (see section 11): folder descriptions, a preferred folder for an entry, examples from the sorted bookmarks, folder priors for each domain, an "intent" field, private repos, README text, and other import sources. Version 1 stores no Raindrop folder ID.

## 4. Rules

- The user owns the profile. The app never writes an entry without an action of the user. An import makes drafts, and the user accepts each draft.
- Every query on the new table is scoped by `user_id`. A request never selects an entry by its ID alone.
- `deleteUserData` removes the rows of the new table. A disconnect from Raindrop keeps the profile, because the profile holds no Raindrop data.
- The profile routes work when Raindrop is not connected. They are placed before the connection check in `server.js`.
- The migration only adds.
- Profile writes run in the queue turn of the user. The code in a turn does not call `serialize` or `syncNow`.
- A suggest job reads the profile one time, when the job starts. This snapshot is the only source for the reply check and for the entry names in the review.
- Profile text is data. It goes into the user message as JSON and never into the system message. JSON data and the reply check lower the risk, but text in the profile can still influence the model. So text from an import stays untrusted after the user accepts it, and the user is told to keep sensitive text out of the profile.
- The server enforces the reply contract: known folders, valid tags, sent entry keys. This check proves that the reply follows the contract. It does not prove that a match is right. The measurement of section 9 and the review step cover that.
- A suggestion alone never writes to Raindrop. Apply stays the only write step. A proposed folder is never created without an explicit action of the user.

## 5. Data model (migration `005_profile.sql`)

`profile_entries`

| Column | Type | Content |
|---|---|---|
| `user_id` | TEXT NOT NULL | The user. |
| `id` | BIGINT identity | Primary key together with `user_id`. |
| `kind` | TEXT NOT NULL | `about`, `project` or `interest`. A CHECK constraint allows only these. |
| `name` | TEXT NOT NULL | Short name, for example "raindrop-app". Empty for `about`. |
| `description` | TEXT NOT NULL | What the project or interest is about. |
| `tag` | TEXT, nullable | The tag that the model can propose. |
| `active` | BOOLEAN NOT NULL | An entry that is not active is not sent. |
| `source` | TEXT NOT NULL | `manual` or `github`. A CHECK constraint allows only these. |
| `source_ref` | TEXT, nullable | The stable ID of the source item. For GitHub this is the numeric repository ID. |
| `updated_at` | TEXT NOT NULL | ISO time. |

Indexes:

- A partial unique index on `(user_id)` where `kind = 'about'`. The database allows one `about` row for each user.
- A partial unique index on `(user_id, source, source_ref)` where `source_ref` is not null. An import cannot make a second entry for the same repository.
- A partial unique index on `(user_id, lower(tag))` where `tag` is not null. Two entries of one user cannot have the same tag, in any letter case. A tag then names exactly one entry.

The migration gives the runtime role its rights on the table, the same as migration 004.

**Entry IDs.** `pg` returns a `BIGINT` as a string. The code never converts an entry ID to a JavaScript number. The API uses the decimal string. The prompt uses a key of the form `p<id>`, for example `"p17"`. A model cannot write this key as a JSON number, so the reply check is an exact string comparison with no conversion.

**States.** An entry has one of three states. The form shows them by name:

| State | Columns | Effect |
|---|---|---|
| Context only | `active`, no `tag` | The model can read it. It proposes no tag. |
| Context and tag | `active`, with `tag` | The model can propose the tag for a strong match. |
| Inactive | not `active` | It is not sent. |

**Limits**, in `config.limits` (proposed): 40 entries for each user, 60 characters for a name, 300 for a description, 600 for the `about` text.

**Total budget.** The serialized profile block of the active entries can have 8,000 characters at most. The count is the length of the JSON text that is sent, with its keys and punctuation. Forty long entries do not fit, so the budget is the real limit for active entries, and the form says so. A save that goes over the budget is refused with a clear message, and the form shows the used part of the budget. The app never trims the profile silently, so every entry that the user sees as active is sent.

**Tag rules.** A tag of an entry is reserved: the model can use it only through its entry (section 7).

- The tags of all entries of the user are reserved, also the tags of inactive entries. Only a tag of an active entry in the snapshot of the job can be accepted as a profile tag. The reply of the model cannot make an inactive entry active.
- Validation trims the tag. An empty tag, or a tag of spaces only, is refused. Then `checkTagFormat` applies.
- The unique index refuses a tag that another entry of the user has.
- When a tag is set or changed, and Raindrop is connected, the server compares it with all Raindrop tags of the user, without letter case. It uses the full tag set, not the 80 tags of `tagVocab`. If the tag exists there, the save is refused with the message that the tag is already a topic tag. The user chooses a different tag, or sends the save again with an explicit `reuseTag` confirmation. A reuse is a decision of the user and is never silent. An unchanged tag is not checked again, because it can exist in Raindrop from earlier applies.
- The check needs the bookmarks of the user. The route calls `ensureSnapshot` before it takes the queue turn, as the queue rule requires, and reads the tags before the turn. The write runs in the turn. If the bookmarks cannot be read (the first sync is not complete, a sync failed, or Raindrop does not answer), the save of a new or changed tag is refused with a clear message: "The tag cannot be checked now. Try again in a moment." The server never treats an unread tag set as empty. A save that does not change a tag needs no check and always works.
- When Raindrop is not connected, the user has no Raindrop tags that the app can read, so there is no check. The form says so.
- The form proposes `proj:<name>` as the default tag for a project. The user can change it. This prefix makes a collision with a topic tag improbable.

## 6. Backend

New file `app/backend/src/profile.js`: validation, the limits and the budget, and one function `contextFor(userId)` that builds the profile snapshot. Both suggestion paths call this one function.

New store functions in `store.js`: `profile(userId)`, `saveEntry(userId, entry)`, `deleteEntry(userId, id)`. `deleteUserData` removes the table rows in its transaction.

New routes in `server.js`. The write routes pass the write guard of today (`writeAllowed`: the `Sec-Fetch-Site` header and the JSON content type). This guard is not a CSRF token, and this plan adds none.

| Route | Purpose |
|---|---|
| `GET /api/profile` | The entries and the used part of the budget. |
| `POST /api/profile/entry` | Create or change one entry. |
| `POST /api/profile/entry/delete` | Delete one entry. |
| `POST /api/profile/import/github` | PR 6. Return drafts. It saves nothing. |

## 7. Prompt and reply

### 7.1 Request

- `buildMessagesV2(batch, folders, vocab, profile)`. With no profile, the messages are equal to the messages of today, byte for byte.
- `folders` stays a list of strings in all cases. The reply check does not change for folders.
- With a profile, the user message gets one more key: `profile: { about, entries: [{ id: "p17", name, description, tag }] }`.
- The tags of the entries are removed from `knownTags`. The model can see them only in the profile.
- The system message gets a "PERSONAL CONTEXT" section only when a profile is sent. Its rules:
  1. A topic tag says what the bookmark is about. A profile tag says that the bookmark belongs to one project or interest of the user. They are different decisions.
  2. Propose a profile tag only when the bookmark is clearly about the subject of that entry. The same language, library or framework is not enough. A shared common word is not enough. A general subject overlap is not enough. The name of a site, a product or a service in a description is not enough: the bookmark must be about the work that the entry describes. (The last sentence was added on 2026-11-20, after the second gate run gave 4 wrong matches by a shared name.)
  3. At most 2 entries for each bookmark. When in doubt, propose none.
  4. List each used entry key in `context`.
  5. The app adds the tag of each entry in `context` to the suggestion. The model does not put the tag of an entry in its tag lists.
  6. The profile does not change the folder rules.
- The prompt of today says "Recommend 1 to 4 relevant tags in total". With a profile, this line is replaced by two separate limits: 1 to 4 topic tags, and at most 2 profile tags in addition. Without a profile, the system message stays equal to the message of today, byte for byte.
- New reply field: `"context": string[]`.
- `classifyV2` uses `maxTokens: 2000` today. The reply is longer with `context` and up to 6 tags. PR 5 sets the value from a test with a full reply for 10 bookmarks, each with 4 topic tags, 2 profile tags and a reason of full length.

### 7.2 Reply check

In `parseRepliesV2` and `normalizeEntry`:

`normalizeEntry` joins `tags.existing` and `tags.new` today and keeps the first 4. A profile tag in place 5 or 6 would be lost. So the checks run in this fixed order:

1. Read all tag strings of both lists. Drop a tag that fails `validTag`. Remove duplicates without letter case.
2. Clean `context`: keep only values that are strings and are exactly equal to a key of an active entry in the snapshot. A number, or a string with other text, is dropped. Duplicates are removed. The first 2 valid keys stay.
3. Split the tags with the reserved set. The reserved set holds the tags of all entries of the user, active and inactive, and comes from the snapshot. It does not come from the 80 known tags.
4. Each key in the cleaned `context` gives the tag of its entry, when the entry has a tag. The app takes the tag from the snapshot, and the model does not repeat it. A reserved tag in a list of the model is dropped. It never goes back into the topic tags. This is true for both lists, so neither list is a way to add the tag of an entry. (Changed on 2026-11-19 after the first gate run, see section 9. Before the change, the model had to repeat the tag in `tags.existing`, and the check dropped 18 of 21 entries that the model named.)
5. Keep the first 4 tags that are not reserved as topic tags, as today. Keep at most 2 accepted profile tags, in a third list: `profileTags: [{ tag, entryId, entryName }]`. The name comes from the snapshot, so a later edit of the profile does not change a review that is open.
6. When the row is built, a tag that the bookmark already has is not proposed again, in any list. Then the tag limit of the bookmark applies to the selection: a profile tag that does not fit is dropped from the list.

An entry in `context` that has no tag is not reported.

Details that were added when PR 5 was built:

- The snapshot exists for each user who has an entry. When no entry is active, nothing is sent and the messages are the messages of a user with no profile, but the reserved set still applies to the reply.
- The system message with a profile has a sixth rule in "PERSONAL CONTEXT". Rule 5 tells the model that the app adds the tag of each entry in `context`, and that the model does not put the tag of an entry in its tag lists.
- The token limit of a reply is 2,000 without a profile and 4,000 with one. A test builds a full reply for 10 bookmarks and estimates one token for each 3 characters.
- A checked profile tag counts as a change of the card, so "Apply all" takes the card.

A suggestion only adds. A tag that the bookmark already has stays on it, also when it is a reserved tag and also when its entry is inactive. A box that is not checked means "do not add". It never removes a tag.

### 7.3 Bulk path

`bulk-suggest.js` takes the snapshot at the start of the job, passes it to `ask`, and copies `profile_tags` into each review row. `jobView` already returns the rows whole.

In the review, a profile tag has its own check box, with the text "from your profile: <entry name>". The box is not checked at first. "Apply all" sends only the checked tags, so it never adds a profile tag that the user did not select. Topic tags keep their defaults of today.

### 7.4 Single-bookmark path

`bookmarks.suggest` uses the older `classify` today, and `list.js` reads only `folderId` and `tags` from the response. PR 4 moves this path to `classifyV2` with a batch of one, and removes `classify` and its parser. PR 4 has no profile. It is measured alone (section 9).

The mapping from the v2 reply to the editor:

| Reply | Folder in the editor | Message in the editor |
|---|---|---|
| `existing`, the bookmark is in Unsorted | The folder of the model. | The reason of the model. |
| `existing`, the bookmark is sorted | The current folder. | "Suggested folder: <name>", with a control that selects it. |
| `propose` | The current folder. | "The model proposed a new folder: <name>". The user can create it with the folder box. Nothing is created here. |
| `none` | The current folder. | The reason of the model, as a warning. |
| No answer for the bookmark | No change. | The error of today (502). |

The response keeps `folderId`, `folder`, `label` and `tags`, and adds `reason`, `suggestedFolder` (ID and label, or null), `proposedFolder` (name, or null), `status`, and `profileTags` (empty before PR 5). `tags` holds the current tags and the suggested topic tags, without duplicates in any letter case, cut at the tag limit of a bookmark. When tags were cut, the message says how many. `list.js` shows the message and, from PR 5, the profile tags as boxes that are not checked. Save stays the only write.

Details that were added when PR 4 was built: the response has `tagsLeftOut` (the number of suggested tags over the limit), and the frontend builds the text. The reason shows for each reply, in amber when the status is `needs_review`. For a proposed folder, the button "Use this name" opens the new folder row with the name. The title of the suggest button now names all the data that goes to the model, because the v2 prompt also sends the current folder and tags of the bookmark.

## 8. Frontend

- A "My context" view, opened from the header. It works without a Raindrop connection. It has the text about the user and the list of entries (add, edit, delete, the three states). It shows the budget meter.
- The view states the privacy facts:
  - The profile is stored in the app database.
  - The active entries are sent to the model endpoint with each suggestion request.
  - A profile tag that the user applies becomes a normal tag in Raindrop. Its text is stored there and is visible where Raindrop shows tags. For a confidential project, use a tag that does not reveal the name.
  - A disconnect keeps the profile. "Delete my data" removes it. Tags that were applied stay in Raindrop.
- The review card and the editor follow sections 7.3 and 7.4. A profile tag is presented as a proposal of the model.
- `docs/ui-elements.md` changes in the same PR as the code: a new section for the view, and changes in sections 5.4, 5.5 and 5.6.

### 8.1 Protection of sorted bookmarks (PR 3)

Today `review.js` starts each card with the folder of the model, and "Apply all" takes every ready card. PR 3 changes this for a bookmark that is in a folder (not in Unsorted):

- The folder of the card starts as the current folder. The folder of the model shows as "Suggested folder: <name>", or "New folder proposed: <name>", with a control that selects it.
- "Apply" and "Apply all" send the folder of the card. So a sorted bookmark keeps its folder unless the user selected a different one on that card.
- When the user selected a different folder on the card, "Apply" and "Apply all" both use that selection. This is true for an existing folder and for a proposed new folder. The selection also marks the card as edited, so "Apply all" includes it.
- "Apply all" never creates a proposed folder that the user did not select.
- A `none` reply keeps the current folder, and the card still needs review.
- A bookmark in Unsorted keeps the behavior of today.
- A card whose only suggestion is a different folder changes nothing as it is. It gets the label "Folder change suggested" and is not in "Apply all" until the user decides. Its "Apply" button is disabled until then. This detail was added when PR 3 was built.

This change does not depend on the profile. It applies to all users.

## 9. Measurement and release gates

The numbers of section 2 do not measure accuracy. The gates need a labeled set.

**The set.** The owner labels about 60 of their own bookmarks. For each one, the label gives the right profile entries (or none) and the right folder. The set contains: clear project cases, general bookmarks about the stack of a project (negative), bookmarks that fit two entries, entries with similar names, bookmarks with no relation, weak titles, sorted bookmarks that must stay in their folder, wrongly sorted bookmarks, and Unsorted bookmarks. It has at least 20 positive and 20 negative cases. The set holds private bookmarks, so it stays in a local file that git ignores.

**The script.** `app/backend/scripts/suggest-eval.mjs` runs the set and saves nothing to Raindrop. It runs the exact build and prompt that the release will have. It prints:

- for profile tags: true positives, false positives, false negatives, the number of predicted matches, precision and recall on the clear cases,
- for folders, bookmark by bookmark: the proposed folder, the folder that the review default would apply, and the labeled folder,
- the request size in characters and the token use that the endpoint reports, for each bookmark.

**State of the script after PR 4.** It has the folder comparison of the PR 4 gate. It keeps a copy of the older prompt as the baseline, because PR 4 removes that prompt from the app. It prints the request size in characters. It does not print the token use yet, because `chat` does not return it. PR 5 adds the profile figures and the token use. The set is in `app/backend/data/suggest-eval.json`, which git ignores.

**Gate for PR 3 (protection).** For each sorted bookmark of the set, the folder that "Apply all" would send is the current folder. Tests in the repo prove the same for Apply, Apply all, and each reply action.

**Gate for PR 4 (single path on v2, no profile).** The script compares the older prompt and the v2 prompt, with one bookmark for each request, against the labeled folders. The v2 path must not be worse on folder correctness, and the owner reads each difference.

**Result of the gate for PR 4 (2026-11-19).** The set has 60 bookmarks of the owner: 56 sorted, which the owner labeled as in the right folder, and the 4 Unsorted bookmarks of the library. One run for each prompt.

| | Older prompt | v2 prompt |
|---|---|---|
| The folder in the editor is the labeled folder, all 60 | 34 | 55 |
| The same, 56 sorted bookmarks | 33 | 55 |
| The same, 4 Unsorted bookmarks | 1 | 0 |
| The model named the labeled folder, 56 sorted bookmarks | 33 | 41 |
| Requests with no usable answer | 1 | 1 |

The failed request of the older prompt was a 503 answer of the endpoint. The failed request of v2 was a reply that was not valid JSON after two tries. Three runs of the older prompt gave 34 of 60 each time.

The gate passes. The gain comes from the rule that a sorted bookmark keeps its folder, not from better folder selection. For an Unsorted bookmark the v2 editor selects the folder of the model, and there v2 was right for 0 of 4: three times it selected "Dev Projects". Four bookmarks are too few for a conclusion. Folder descriptions (section 11) are the planned answer to this pull.

**State of the script after PR 5.** With a `profile` in the set, the script asks a third path, v2 with the profile, and prints the figures of the gate below and the token use. The set holds the limits of decision P7 as `gate: { minPredicted, minRecall }`. Without them, or without entry labels, the gate result is "INCOMPLETE". Each bookmark has `rightEntries` and can have `unclear: true`. `scripts/suggest-label.mjs` writes these labels.

**Gate for PR 5 (profile).** All of these:

- precision of profile tags of 90% or more,
- a minimum number of predicted matches, so that the precision figure has meaning,
- a minimum recall on the clear cases, so that a model that almost always abstains does not pass,
- for sorted bookmarks, no folder that the default would apply differs from the current folder (this follows from PR 3, and the script confirms it),
- for Unsorted bookmarks, folder correctness with the profile is not worse than without it, compared bookmark by bookmark.

The owner sets the two minimum numbers after the labels exist and before anyone looks at the first result of PR 5. They are written into decision P7 at that time, so the result cannot shape them.

**Result of the first gate run of PR 5 (2026-11-19): failed.** The set had 100 bookmarks and 20 entries, and the owner gave an entry to 82 bookmarks.

| Limit | Result |
|---|---|
| Precision of 90% or more | 83% (5 of 6): failed |
| 8 predicted matches or more | 6: failed |
| Recall of 50% or more | 5% (5 of 97): failed |
| No sorted bookmark leaves its folder | 0: passed |
| No Unsorted bookmark is right without the profile and wrong with it | 0: passed |

Other figures of this run: the folder in the editor is the labeled folder for 50 of 100 bookmarks on the older path and for 95 on v2. A request has 4,780 characters as a mean with the profile and 1,810 without it (2,216 and 444 input tokens). 5 requests with the profile gave no usable answer (1 with status 503, 4 replies that were not valid JSON), against 1 without it.

A second run recorded the entries that the model names in `context`, before the reply check: 21 entries, 14 right and 7 wrong (precision 67%, recall 16%). The model put the tag of the entry in `tags.existing` for 3 of the 21, so the check of that time dropped 18. The entries "tools" and "infra" had 29 labels and the model named neither one time.

Changes after this run, each approved by the owner on 2026-11-19:

1. The reply check takes the tag from the entry in `context` (section 7.2, item 4).
2. The owner examines the labels of 5 bookmarks where the model and the label disagree.
3. The entries "tools" and "infra" leave the set, because they are too wide for the rule "only a clear match".

The limits of decision P7 do not change. But the set and the check changed after a result was seen, so the next run is not a blind run. Read its result with that in mind.

Two limits of this measurement:

- A profile tag is not checked at first, so the review default applies none of them. The gate therefore measures the profile tags that the model proposes. It does not measure the tags that a user selects.
- A set of 60 bookmarks finds regressions. It is not strong statistical proof of the behavior in production. Each report gives the raw counts with the percentages.

## 10. Pull requests

| PR | Content | Tests and gate |
|---|---|---|
| 1 | Migration 005, store functions, `profile.js`, the routes before the connection check, `deleteUserData`. No change to a suggestion. | Store tests with real IDs from `pg` (need the database env vars). A user cannot read, change or delete an entry of another user through its ID. The database refuses a second `about` row and a second entry with the same tag in a different letter case. Blank tags, the collision with a Raindrop tag and `reuseTag`. The collision check with the stored copy on and no complete sync, with a failed sync, with the stored copy off, with no connection, and after a sync: it never passes silently when the tags cannot be read. Disconnect keeps the profile, `deleteUserData` removes it. The limits and the budget. |
| 2 | The "My context" view, the three states, the privacy text, the specification. | Edit, limits, budget meter, empty state and error tests. a11y test. The write guard test. |
| 3 | The protection of sorted bookmarks in the review (section 8.1). | Apply and "Apply all" for `existing`, `propose` and `none` on sorted and on Unsorted bookmarks. No folder is created without a selection. A proposed folder that the user selected, followed by "Apply all". The gate of section 9. |
| 4 | The single-bookmark path moves to the v2 prompt with the adapter of section 7.4. `classify` is removed. No profile yet. | Each row of the mapping table, for a sorted and for an Unsorted bookmark, with the fallback to the current folder. The tag limit, the editor messages. The gate of section 9. |
| 5 | The profile in the prompt for both paths, the reply check, `profileTags`, the boxes that are not checked, the evaluation of profile tags. | The bulk prompt without a profile is equal to the prompt of today. Malformed replies, unknown keys, numbers in `context`, a profile tag without its entry in either tag list, a tag dropped by the tag limit, "Apply all" with profile tags that are not checked. Four topic tags followed by two profile tags. A reserved tag of an inactive entry in either list. A profile tag that the bookmark already has: it stays and is not proposed. A full reply for 10 bookmarks inside the token limit. A profile edit during a job does not change the names in its review. Two users never see each other's context. The gate of section 9. |
| 6 | GitHub import of public repos: drafts only. | See below. |

PRs 1 and 2 change no suggestion. PR 3 changes the review default for all users (decision P4). PR 4 changes the single-bookmark suggestion for all users (decision P6). PR 5 changes a suggestion only for a user who has a profile, and it reaches both paths in the same release.

PR 6 in detail:

- The user gives a GitHub user name. The server validates it against the GitHub name rules before any request. The server calls only `api.github.com`, with a request timeout, and reads the public repos: ID, name, description, topics, the fork flag and the archived flag. It reads no code and no README.
- It follows the pages up to 300 repos and reads the rate-limit headers. It keeps the answer for a user name in memory for 10 minutes. All users share the limit of 60 calls for each hour of the server IP, so the server also keeps its own count and refuses an import before the limit is reached.
- The response has `complete` (true or false), `fetchedCount`, and an `error` text when the read stopped early. `complete` is true only when the server read the last page. The cap of 300 repos, a timeout, a rate limit or an error makes it false when more repos can exist. Exactly 300 repos with no next page is complete. The view shows "Partial import" when `complete` is false and never says that all repos were read.
- The response is a list of drafts. Forks and archived repos are marked and are not selected at first. The user selects, edits and saves each draft. Nothing is saved without that.
- A repo that is already in the profile (same `source_ref`) shows as "already imported", with a proposed update when its GitHub text changed. A text that the user edited is never replaced without the user. A renamed repo matches by its ID.
- An entry is marked "not found among the current public repositories" only after a complete read that does not contain its repo. The repo can be private now, so the text does not say that it is deleted. A partial read marks nothing. The entry of the user always stays.
- Tests: exactly 300 repos, more than 300 repos, and a partial read that cannot mark an entry.
- A private project gets a manual entry. The form has all the fields for it.

## 11. Later

Each item needs its own evidence from the labeled set before it is built.

- Folder descriptions. They must go to the model in a separate structure (`folderContext`), and the allowed folder list must stay a list of strings. A description is bound to a Raindrop folder ID, so it also needs a rule for a reconnect to a different Raindrop account.
- A preferred folder for an entry. It has the same account rule.
- Examples: sorted bookmarks of the user that are near each batch.
- Folder priors for each domain. An "intent" field.
- Private repos, with a GitHub App that has narrow rights. README summaries. Other sources.

## 12. Decisions

| ID | Decision | State |
|---|---|---|
| P1 | The schema change of migration 005, as section 5 describes it, with string entry IDs and the unique tag index. | Approved by the owner on 2026-11-18. |
| P2 | The default tag that the form proposes for a project: `proj:<name>`, which the user can change, with the collision check. | Proposed. Both reviews agree. |
| P3 | The privacy statement must cover three facts: the profile is stored, the active entries go to the model endpoint, and an applied profile tag is stored in Raindrop. This joins decision D6 of `docs/bookmark-store-plan.md`. | Open. Resolve before PR 5 is released to other users. |
| P4 | PR 3 changes the review default for all users: a sorted bookmark keeps its folder unless the user selects a different one. | Proposed. Both reviews agree. It is released before PR 5. |
| P5 | PR 6 sends a GitHub user name from the server to GitHub. All users share the limit of the server IP. | Proposed. Both reviews agree, with the partial-result fields. |
| P6 | The single-bookmark suggestion moves to the v2 prompt for all users, in its own PR 4 with its own gate. Its results can change for a user with no profile. | Approved by the owner on 2026-11-19, after the comparison of PR 4 (section 9). |
| P7 | The gate of PR 5: precision of 90% or more, with a minimum number of predicted matches and a minimum recall. The owner sets the two minimum numbers after the labels exist and before the first run with the profile. | Approved by the owner on 2026-11-19, before a run with the profile: 8 predicted matches or more, and a recall of 50% or more on the clear cases. |
| P8 | A profile tag is not checked at first in the review and in the editor. Topic tags keep their defaults of today. | Proposed. The second review recommends it. |

## 13. Answers to the first review

| Finding | Answer |
|---|---|
| P1-1 Folder objects break the parser | Correct. Folder descriptions left version 1. Section 11 records the separate structure for a later version. |
| P1-2 `context` proves membership, not relevance | Accepted. Sections 4, 7 and 9. No keyword gate on the server. |
| P1-3 Folder IDs and the Raindrop account | Correct. Version 1 stores no folder ID. Section 11 records the rule for later. |
| P2-1 Token budget | Accepted. A total budget with no silent trim. The script reports the real size. |
| P2-2 Stable source ID | Accepted. `source_ref` and a unique index. |
| P2-3 Two suggestion paths | Accepted. The profile reaches both paths in PR 5. |
| P2-4 Depth of the GitHub import | Accepted in part. Public metadata as drafts, plus manual entries. No README text in version 1. |
| P2-5 Provenance in the review | Accepted. Only entries that gave an accepted tag are named. |
| P2-6 Profile routes without a connection | Accepted. |
| P3-1 Database constraints | Accepted. |
| P3-2 Privacy and the write guard | Accepted. |
| A, B, C, D | Accepted. Folder descriptions and the preferred folder are postponed. |

## 14. Answers to the second review

Each code claim of the review was checked against `main` and is correct.

| Finding | Answer |
|---|---|
| P1-1 `BIGINT` and the numeric `context` | Accepted. Section 5: IDs stay strings in the code, and the prompt uses keys of the form `p<id>`. Section 7.2: exact string comparison, no conversion. PR 1 tests use real IDs from `pg`. |
| P1-2 The protection came after the model change | Accepted. The protection is PR 3. The profile is PR 5. Section 8.1 defines the folder that Apply and "Apply all" send. Section 9 measures the applied folder apart from the proposed folder. |
| P1-3 Tag ownership and selection | Accepted. A unique index on the tag without letter case. A collision with a Raindrop tag refuses the save unless the user confirms the reuse. Profile tags are not checked at first (decision P8). The provenance is a list of `{ tag, entryId, entryName }`. |
| P2-1 The precision gate can pass with almost no predictions | Accepted. Section 9: counts of true positives, false positives and false negatives, a minimum number of predicted matches, a minimum recall, folder checks bookmark by bookmark, and the exact release build. The two minimum numbers are set before the first run. |
| P2-2 The adapter of the single-bookmark path | Accepted. Section 7.4 has the mapping table and the response fields. The move is its own PR 4 with its own comparison, before the profile. Decision P6 stays open until that comparison. |
| P2-3 Applied project tags go to Raindrop | Accepted. Section 8 and decision P3. |
| P2-4 Partial GitHub imports | Accepted. PR 6: `complete`, `fetchedCount`, `error`, the "Partial import" text, name validation, a timeout, the rate-limit headers, and no "not found" mark after a partial read. |
| P3 Capacity text | Accepted. Section 5: the budget is the real limit, and the count includes the JSON text. |
| P3 Tag normalization | Accepted. Section 5: trim, refuse blank tags, compare without letter case. |
| P3 Snapshot provenance | Accepted. Sections 4 and 7.2: names come from the snapshot of the job. |
| P3 Data minimization | Accepted. Section 4: approved text stays untrusted, and the user is told to keep sensitive text out. |

One point goes further than the review asked. The review allowed the single-path move to stay in the profile PR or to be split. This plan splits it and puts it before the profile. Then the profile reaches both paths in one release, which the first review required, and the single-path change is measured alone, which the second review required.

## 15. Answers to the third review

The review approves the direction and the order of the six pull requests. It has no new P1 finding. Each code claim was checked against `main` and is correct.

| Finding | Answer | Where |
|---|---|---|
| R3-1 Profile tags are lost by the limit of 4 tags | Accepted. The checks have a fixed order, and the split comes before the limit. | Section 7.2, PR 5 |
| R3-2 Tags of inactive entries | Accepted. All tags of the user are reserved. Only an active entry in the snapshot can give a tag. A tag that is on a bookmark stays there. | Sections 5 and 7.2, PR 5 |
| R3-3 Collision check without a ready copy | Accepted. `ensureSnapshot` before the queue turn. A tag that cannot be checked is refused with a clear message. | Section 5, PR 1 |
| R3-4 "Apply all" and a selected folder | Accepted, with the contract that the review recommends: a selection of the user applies in both actions, and a folder that was not selected is never created. | Section 8.1, PR 3 |
| R3-5 The tag-count text of the prompt | Accepted. Two separate limits in the prompt with a profile. The token limit comes from a test with a full reply. | Section 7.1, PR 5 |
| R3-6 The cap of 300 repos | Accepted. `complete` is true only after the last page. The text for a missing repo changed. | Section 10, PR 6 |
| Cautions about the gate | Accepted. The minimum numbers are fixed before anyone sees a PR 5 result. Raw counts are reported. Proposed profile tags are measured apart from selected tags. | Section 9 |

The review gives these recommendations for the decisions: approve P1, P2, P3, P4, P5, P7 (the framework) and P8, and keep P6 as a separate release decision. The owner still makes each decision in section 12.

## 16. Risks

- **Wrong matches.** This is the main risk. The defences are the prompt rules, the limit of 2 entries, the reserved and unique tags, boxes that are not checked, and the gate of PR 5.
- **Folder moves of sorted bookmarks.** The model can propose them with or without a profile. PR 3 makes the default safe before the profile exists.
- **Tag clutter.** Each applied profile tag is a new tag in Raindrop. Context-only entries add none.
- **Prompt size.** The profile adds 8,000 characters at most to each request. The script measures the real cost.
- **Untrusted text in the profile.** A GitHub description can hold text that tries to instruct the model. The profile is sent as data, and the reply check accepts only known folders, valid tags and sent entry keys. This lowers the risk and does not remove it.
- **Privacy.** A description leaves the server when the user writes it into an active entry. An applied tag is stored in Raindrop. The view says both.
- **The single path changes for all users** (decision P6). PR 4 measures it alone before release.
