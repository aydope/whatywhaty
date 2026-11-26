const mongoose = require("mongoose");

const toggleLikePipeline = (userId) => [
  {
    $set: {
      likes: {
        $cond: [
          { $in: [userId, { $ifNull: ["$likes", []] }] },
          { $setDifference: [{ $ifNull: ["$likes", []] }, [userId]] },
          { $concatArrays: [{ $ifNull: ["$likes", []] }, [userId]] },
        ],
      },
    },
  },
];

// Flips the like in a single atomic update so concurrent toggles cannot lose
// writes. The previous state comes from the pre-update document.
const toggleLike = async (Model, targetId, userId, select = "") => {
  const userObjectId = new mongoose.Types.ObjectId(userId.toString());

  const before = await Model.findOneAndUpdate(
    { _id: targetId },
    toggleLikePipeline(userObjectId),
    { returnDocument: "before", updatePipeline: true },
  )
    .select(`likes ${select}`)
    .lean();

  if (!before) return null;

  const wasLiked = (before.likes || []).some(
    (id) => id.toString() === userObjectId.toString(),
  );
  const previousCount = before.likes?.length || 0;

  return {
    doc: before,
    liked: !wasLiked,
    likesCount: wasLiked ? previousCount - 1 : previousCount + 1,
  };
};

// Likes are stored as an id array on the document. API responses expose only
// the count and whether the viewer liked it, so the full list of ids is not
// sent to every client.
const withViewerLikes = (doc, viewerId) => {
  const likes = doc.likes || [];
  const viewer = viewerId ? viewerId.toString() : null;
  const liked = !!viewer && likes.some((id) => id.toString() === viewer);

  return {
    ...doc,
    likesCount: likes.length,
    likes: liked ? [viewerId] : [],
  };
};

const withCommentLikes = (comment, viewerId) => ({
  ...withViewerLikes(comment, viewerId),
  replies: Array.isArray(comment.replies)
    ? comment.replies.map((reply) =>
        reply && typeof reply === "object"
          ? withCommentLikes(reply, viewerId)
          : reply,
      )
    : comment.replies,
});

module.exports = { toggleLike, withViewerLikes, withCommentLikes };
