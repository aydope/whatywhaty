const Comment = require("../models/Comment");
const Post = require("../models/Post");

const collectDescendantIds = async (rootId) => {
  const ids = [rootId];
  let frontier = [rootId];

  while (frontier.length) {
    const children = await Comment.find({ parentComment: { $in: frontier } })
      .select("_id")
      .lean();
    frontier = children.map((c) => c._id);
    ids.push(...frontier);
  }

  return ids;
};

// Deletes a comment with all of its replies and keeps the parent comment and
// the post in sync, so reply and comment counts stay correct.
const deleteCommentTree = async (comment) => {
  const ids = await collectDescendantIds(comment._id);

  if (comment.parentComment) {
    await Comment.updateOne(
      { _id: comment.parentComment },
      { $pull: { replies: comment._id } },
    );
  } else {
    await Post.updateOne(
      { _id: comment.post },
      { $pull: { comments: comment._id } },
    );
  }

  await Comment.deleteMany({ _id: { $in: ids } });
  return ids;
};

module.exports = { deleteCommentTree };
