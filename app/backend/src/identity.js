// Who is signed in. This file is the only place that decides the user.
//
// Admintools signs the person in and sends the email in X-Admintools-Email.
// The app listens on 127.0.0.1 only, so only nginx can send this header.
// The header is never read from a cookie or a form.

const HEADER = 'x-admintools-email';
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MAX_LENGTH = 254;

// Return the signed-in email in lower case, or null when the header is missing or not valid.
// A repeated header arrives as one joined value, so it fails the check too.
export function currentUser(req) {
  const value = req.headers[HEADER];
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_LENGTH && EMAIL.test(email) ? email : null;
}
