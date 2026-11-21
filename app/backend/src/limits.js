import { config } from './config.js';
import { RequestError } from './util.js';

// The tags the browser sends: a list of text strings, or nothing. Anything else is refused,
// so a string is never split into one-letter tags.
export function tagList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((t) => typeof t === 'string')) {
    throw new RequestError(400, 'Tags must be a list of text.');
  }
  return value;
}

// The app's own limits. Raindrop does not state these values. See config.js.
const { limits } = config;

// The search box text. Checked before the text is split into words.
export function checkSearchText(text) {
  if (text.length > limits.searchLength) {
    throw new RequestError(400, `The search text can have at most ${limits.searchLength} characters.`);
  }
}

// The tag filter, as a list of tags. Each one is already trimmed and lower case.
export function checkTagFilter(tags) {
  if (tags.length > limits.tagsPerFilter) {
    throw new RequestError(400, `A tag filter can have at most ${limits.tagsPerFilter} tags.`);
  }
}

// The text of each tag: length and commas. The list must already be cleaned.
export function checkTagFormat(tags) {
  for (const tag of tags) {
    if (tag.length > limits.tagLength) {
      throw new RequestError(400, `A tag can have at most ${limits.tagLength} characters.`);
    }
    if (tag.includes(',')) throw new RequestError(400, 'Tags cannot contain commas.');
  }
}

// The number of tags one bookmark ends up with. Pass the tags it will have, not the tags being sent.
function checkTagCount(tags) {
  if (tags.length > limits.tagsPerBookmark) {
    throw new RequestError(400, `A bookmark can have at most ${limits.tagsPerBookmark} tags.`);
  }
}

// The tags a bookmark will have after a save. Checks both the format and the count.
export function checkTags(tags) {
  checkTagFormat(tags);
  checkTagCount(tags);
}

// A folder name, after trim. Empty names and long names are refused.
export function checkFolderName(name) {
  if (!name) throw new RequestError(400, 'The folder name is empty.');
  if (name.length > limits.folderName) {
    throw new RequestError(400, `The folder name can have at most ${limits.folderName} characters.`);
  }
}
