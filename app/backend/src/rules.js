// Rules that the code applies to a suggestion. They do not depend on the model.
// The rules come from the owner's decisions of 2026-11-20 on the bookmark plan.

// Hebrew letters. A title with one of them is a Hebrew bookmark.
const HEBREW = /[֐-׿]/;

// The tag for a Hebrew bookmark. Hebrew is a tag only, never a folder.
export const HEBREW_TAG = 'hebrew';

// The most topic tags of one suggestion (docs/profile-plan.md, section 7.2).
const TOPIC_LIMIT = 4;

// True when the title is in Hebrew.
export function isHebrewTitle(title) {
  return HEBREW.test(title ?? '');
}

// Add the Hebrew tag to the entry of the model when the title is Hebrew.
// The tag keeps the spelling of a known tag. Otherwise it is a new tag. A tag that is already
// suggested is not added twice. A reserved tag (the tag of a profile entry) is never a topic tag,
// so the entry is not changed then. The Hebrew tag takes one of the topic places. When the list
// is full, the last other topic tag gives way. The entry is not changed when the title is not Hebrew.
export function addHebrewTag(entry, title, vocab, reserved = new Set(), current = []) {
  if (!entry || !isHebrewTitle(title)) return entry;
  if (reserved.has(HEBREW_TAG)) return entry;
  // The bookmark has the tag already. A new one would not be a new topic (review round 2 of PR #145).
  if (current.some((t) => t.toLowerCase() === HEBREW_TAG)) return entry;
  const suggested = [...entry.existingTags, ...entry.newTags].some((t) => t.toLowerCase() === HEBREW_TAG);
  if (suggested) return entry;
  const out = { ...entry, existingTags: [...entry.existingTags], newTags: [...entry.newTags] };
  if (out.existingTags.length + out.newTags.length >= TOPIC_LIMIT) {
    if (out.newTags.length) out.newTags.pop();
    else out.existingTags.pop();
  }
  const known = vocab.find((t) => t.toLowerCase() === HEBREW_TAG);
  if (known) out.existingTags.push(known);
  else out.newTags.push(HEBREW_TAG);
  return out;
}

// The Raindrop type of a link: "image", "video", or null (keep the type that Raindrop gives).
// The link is read as a URL. Only the host and the path count. A query string does not count.
// An image is a photo page of an X post, or an image file in the path. A video is a page of a video host.
// bulk.js uses this function when a suggestion is applied. The type is written with the single update of the bookmark.
const X_HOSTS = ['x.com', 'twitter.com'];
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv', 'dailymotion.com'];
const IMAGE_PATH = /\.(jpe?g|png|gif|webp|heic|avif)$/i;
const X_PHOTO_PATH = /\/status\/\d+\/photo\/\d+/;

// True when the host is the domain or a subdomain of it. "example.youtube.com.evil" is not a subdomain.
function onDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function typeForLink(link) {
  let url;
  try {
    url = new URL(link ?? '');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (X_HOSTS.some((d) => onDomain(host, d)) && X_PHOTO_PATH.test(url.pathname)) return 'image';
  if (IMAGE_PATH.test(url.pathname)) return 'image';
  if (VIDEO_HOSTS.some((d) => onDomain(host, d))) return 'video';
  if (onDomain(host, 'ted.com') && url.pathname.startsWith('/talks/')) return 'video';
  return null;
}
