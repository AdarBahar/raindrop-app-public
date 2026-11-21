# Prompt: compare UI skills on a project

This file holds a prompt for Claude Code. The prompt runs several UI skills on a project, one skill for each copy of the UI. It then builds a `compare.html` page. Use the page to decide which skill to use.

The prompt comes from a test on this project (raindrop-app). The notes after the prompt explain what the test found.

## How to use

1. Open a new Claude Code session in the project folder.
2. Paste the prompt below.
3. Read the safety verdicts in step 1. The session waits for your yes.
4. Open `compare.html` and choose a skill. The session applies nothing until you choose.

## Prompt

```text
Goal: find out which UI skill improves the UI of this project best. Do not change the repository. Use copies in the scratchpad directory.

Skills to compare:
1. unslop: https://github.com/heydamir/unslop
2. frontend-design (already installed as a plugin)
3. Impeccable: https://github.com/pbakaus/impeccable
4. UI/UX Pro Max: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
5. Taste Skill: https://github.com/Leonxlnx/taste-skill
Also search the internet for other UI skills. Rank the new ones. Add the top 2 to the list.

Step 1. Safety review. Do this before you run any skill.
- Download each repository to its own new, empty scratchpad directory. Do not install anything.
- Read SKILL.md, the reference files, the scripts, the hooks, and any install file.
- Search for network calls, shell calls, binary downloads, hidden Unicode characters, and text that hides things.
- Give each skill a verdict: safe, safe with limits, or not safe. Show me the verdicts. Stop if any skill is not safe. Then wait for my yes before step 2.
- Never run a hook or a downloaded binary. Follow the skill text by hand when a skill needs one.
- If the permission system blocks a script, stop and ask me. Do not bypass the block.

Step 2. Prepare the test page.
- Read the UI files of the project. Find how to render the main screen.
- If the screen needs a login or a real backend, build a small mock server in the scratchpad. It serves the frontend files and fake API data.
- Take screenshots with the Chrome that is installed. Use these flags:
  --headless=new --hide-scrollbars --window-size=1440,1000 --virtual-time-budget=4000
- Take dark and light theme screenshots. Headless Chrome copies the system theme. Check that each screenshot really shows the theme you want. For light theme, use --blink-settings=preferredColorScheme=1.
- Chrome needs a window of at least 500 px. Check phone width in an iframe of 390 px.
- In zsh, arrays start at 1. Check loops that use array indexes.

Step 3. Make one version for each skill.
- Copy the original frontend to a new directory for each skill. Apply the skill to that copy only.
- Follow each skill as written: audit, direction, passes, checklist.
- Keep the product features, the text content, and the JavaScript behavior.
- Take a screenshot of every version in both themes.

Step 4. Build compare.html. Embed the images as base64 so the page can read the pixels.
- Buttons for dark theme and light theme.
- A view with all versions side by side. Add a caption for each version.
- A marked-difference view. The user picks two versions. Red marks each 8 px block that differs. Show the share of the screen that differs.
- An overlay view with a draggable line. Left of the line is the first version. Right is the second.
- An overlay view with a blend slider.
- Test every view in a browser before you tell me that it works.

Step 5. Report.
- For each skill, say what it changed, what it missed, what it did not run, and what I must not trust.
- Give contrast numbers for text colors. The target is 4.5 to 1.
- State clearly which parts of a skill you ran by hand.
- Recommend one skill, or a mix. Then wait. Do not apply anything to the repository until I choose.

Rules for the writing style: use short sentences, active voice, and simple words.
```

## Notes from the test on raindrop-app

- **Safety review:** Impeccable has hooks that run a downloaded native binary on every edit. The test did not run the binary or the hooks. The permission system blocked the UI/UX Pro Max script until the user approved it.
- **Chrome and themes:** The system theme changes the "light" screenshots. Headless Chrome copied the dark mode of the Mac, so the first light screenshots were dark. Always check the theme in each image.
- **Array index fault:** In zsh, a loop with index 0 skipped one version. Use names, not indexes.
- **Phone width:** Headless Chrome crops a window narrower than about 500 px. Use an iframe of 390 px.
- **Taste Skill:** It builds company landing pages. It fits a logged-in tool less well. Remove it from the list for such a project.
- **Skills that run by hand:** unslop, Impeccable, and Taste Skill have no scripts that this prompt allows. The session follows their text by hand. Say so in the report.
- **Unknowns:** The prompt does not state the stack, the login, or the main screen of the project. The session must first determine these facts.
