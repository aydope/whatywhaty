// Bidi overrides and zero-width spaces can be used to fake someone else's
// name, so they are removed. The zero-width non-joiner (U+200C) is kept
// because Persian text needs it.
const INVISIBLE = /[\u200B\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const cleanDisplayName = (value) =>
  typeof value === "string"
    ? value.replace(INVISIBLE, "").replace(CONTROL, "").replace(/\s+/g, " ").trim()
    : value;

const cleanBio = (value) =>
  typeof value === "string"
    ? value
        .replace(INVISIBLE, "")
        .replace(CONTROL, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : value;

module.exports = { cleanDisplayName, cleanBio };
