const mongoose = require("mongoose");

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const isObjectId = (value) =>
  typeof value === "string" && OBJECT_ID_PATTERN.test(value);

const sameId = (a, b) => !!a && !!b && a.toString() === b.toString();

const toObjectId = (value) => new mongoose.Types.ObjectId(value);

module.exports = { isObjectId, sameId, toObjectId };
