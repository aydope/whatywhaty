const Post = require("../models/Post");
const Comment = require("../models/Comment");
const { toggleLike } = require("./likeService");
const { sendNotification } = require("./notificationService");

const EXPLORE_VERSION_KEY = "explore:version";

// Explore pages are cached per version; bumping it retires every cached page
// at once without scanning keys. Cache problems never fail a request.
const bumpExploreCache = async (fastify) => {
  try {
    if (fastify.redis?.status === "ready") {
      await fastify.redis.incr(EXPLORE_VERSION_KEY);
    }
  } catch (error) {
    fastify.log.warn({ err: error }, "Could not invalidate explore cache");
  }
};

const likePost = async (fastify, userId, postId) => {
  const result = await toggleLike(Post, postId, userId, "author");
  if (!result) return null;

  fastify.io?.emit("post:liked", {
    postId,
    likesCount: result.likesCount,
    userId: userId.toString(),
    liked: result.liked,
  });

  if (result.liked && result.doc.author.toString() !== userId.toString()) {
    await sendNotification(fastify, result.doc.author, userId, "like", {
      postId,
      message: "پست شما را لایک کرد",
    });
  }

  await bumpExploreCache(fastify);
  return { liked: result.liked, likesCount: result.likesCount };
};

const likeComment = async (fastify, userId, commentId) => {
  const result = await toggleLike(Comment, commentId, userId, "author post");
  if (!result) return null;

  fastify.io?.emit("comment:liked", {
    commentId,
    likesCount: result.likesCount,
    userId: userId.toString(),
    liked: result.liked,
  });

  if (result.liked && result.doc.author.toString() !== userId.toString()) {
    await sendNotification(fastify, result.doc.author, userId, "like_comment", {
      postId: result.doc.post,
      commentId,
      message: "کامنت شما را لایک کرد",
    });
  }

  return { liked: result.liked, likesCount: result.likesCount };
};

module.exports = { likePost, likeComment, bumpExploreCache, EXPLORE_VERSION_KEY };
