const User = require("../models/User");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Usernames are unique regardless of case, so "Admin" cannot impersonate "admin".
const isUsernameTaken = (username, excludeUserId) =>
  User.exists({
    username: new RegExp(`^${escapeRegex(username)}$`, "i"),
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  });

module.exports = { isUsernameTaken };
