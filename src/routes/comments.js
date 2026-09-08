const Comment = require("../models/Comment");
const Post = require("../models/Post");
const { sendNotification } = require("../services/notificationService");
const Joi = require("joi");

const MAX_NESTING_DEPTH = 5;
const POPULATE_AUTHOR_SELECT = "username";

const createCommentSchema = Joi.object({
  content: Joi.string().min(1).max(280).required().trim(),
  postId: Joi.string().required(),
  parentCommentId: Joi.string().allow(null, ""),
});

const validateBody = (schema, body) => {
  const { error, value } = schema.validate(body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const err = new Error(error.details[0].message);
    err.statusCode = 400;
    throw err;
  }

  return value;
};

const buildRepliesPopulate = (depth = MAX_NESTING_DEPTH) => {
  if (depth <= 0) return null;

  return {
    path: "replies",
    populate: [
      { path: "author", select: POPULATE_AUTHOR_SELECT },
      buildRepliesPopulate(depth - 1),
    ].filter(Boolean),
  };
};

const deleteRepliesRecursively = async (commentId) => {
  const replies = await Comment.find({ parentComment: commentId }).select(
    "_id",
  );

  for (const reply of replies) {
    await deleteRepliesRecursively(reply._id);
    await Comment.findByIdAndDelete(reply._id);
  }
};

const isAuthorOrAdmin = (comment, user) =>
  comment.author.toString() === user._id.toString() || user.role === "admin";

module.exports = async function (fastify, opts) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/:commentId/replies", async (req, reply) => {
    try {
      const { commentId } = req.params;
      const { page = 1, limit = 5 } = req.query;
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(20, Math.max(1, parseInt(limit)));
      const skip = (pageNum - 1) * limitNum;

      const [replies, total] = await Promise.all([
        Comment.find({ parentComment: commentId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .populate("author", "username")
          .populate({
            path: "replies",
            populate: { path: "author", select: "username" },
          })
          .lean(),
        Comment.countDocuments({ parentComment: commentId }),
      ]);

      return {
        success: true,
        replies,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasMore: pageNum < Math.ceil(total / limitNum),
        },
      };
    } catch (error) {
      fastify.log.error({ error }, "Get replies error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });

  fastify.post("/", auth, async (req, reply) => {
    try {
      const { content, postId, parentCommentId } = validateBody(
        createCommentSchema,
        req.body,
      );

      const post = await Post.findById(postId).select("author comments");

      if (!post) {
        return reply.status(404).send({
          success: false,
          message: "پست یافت نشد",
        });
      }

      let depth = 0;
      let parentComment = null;

      if (parentCommentId) {
        parentComment = await Comment.findById(parentCommentId).select(
          "author parentComment depth replies",
        );

        if (!parentComment) {
          return reply.status(404).send({
            success: false,
            message: "کامنت یافت نشد",
          });
        }

        depth = parentComment.depth + 1;

        if (depth > MAX_NESTING_DEPTH) {
          return reply.status(400).send({
            success: false,
            message: "حداکثر عمق پاسخگویی",
          });
        }
      }

      const comment = await Comment.create({
        post: postId,
        author: req.user._id,
        content,
        parentComment: parentCommentId || null,
        depth,
      });

      if (!parentCommentId) {
        await Post.findByIdAndUpdate(postId, {
          $push: { comments: comment._id },
        });
      } else {
        await Comment.findByIdAndUpdate(parentCommentId, {
          $push: { replies: comment._id },
        });
      }

      const populatedComment = await Comment.findById(comment._id)
        .populate("author", POPULATE_AUTHOR_SELECT)
        .lean();

      if (!parentComment) {
        await sendNotification(fastify, post.author, req.user._id, "comment", {
          postId: post._id,
          commentId: comment._id,
          message: "روی پست شما کامنت گذاشت",
        });
      } else {
        await sendNotification(
          fastify,
          parentComment.author,
          req.user._id,
          "reply",
          {
            postId: post._id,
            commentId: comment._id,
            message: "به کامنت شما پاسخ داد",
          },
        );

        if (parentComment.parentComment) {
          const rootComment = await Comment.findById(
            parentComment.parentComment,
          )
            .select("author")
            .lean();

          if (
            rootComment &&
            rootComment.author.toString() !== req.user._id.toString() &&
            rootComment.author.toString() !== parentComment.author.toString()
          ) {
            await sendNotification(
              fastify,
              rootComment.author,
              req.user._id,
              "reply",
              {
                postId: post._id,
                commentId: comment._id,
                message: "به گفتگوی شما پاسخ داد",
              },
            );
          }
        }
      }

      fastify.io?.emit("comment:new", { postId, comment: populatedComment });

      return reply.status(201).send({
        success: true,
        comment: populatedComment,
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      if (error.name === "CastError") {
        return reply.status(400).send({
          success: false,
          message: "شناسه نامعتبر",
        });
      }

      fastify.log.error({ error }, "Create comment error");
      return reply.status(500).send({
        success: false,
        message: "خطا در ثبت کامنت",
      });
    }
  });

  fastify.get("/post/:postId", async (req, reply) => {
    try {
      const { postId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
      const skip = (pageNum - 1) * limitNum;

      const [comments, total] = await Promise.all([
        Comment.find({ post: postId, parentComment: null })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .populate("author", POPULATE_AUTHOR_SELECT)
          .populate(buildRepliesPopulate())
          .lean(),
        Comment.countDocuments({ post: postId, parentComment: null }),
      ]);

      return {
        success: true,
        comments,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasMore: pageNum < Math.ceil(total / limitNum),
        },
      };
    } catch (error) {
      fastify.log.error({ error }, "Get comments error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });

  fastify.post("/:id/like", auth, async (req, reply) => {
    try {
      const comment = await Comment.findById(req.params.id).select(
        "likes author post",
      );

      if (!comment) {
        return reply.status(404).send({
          success: false,
          message: "کامنت یافت نشد",
        });
      }

      const userId = req.user._id;
      const likeIndex = comment.likes.indexOf(userId);

      if (likeIndex === -1) {
        comment.likes.push(userId);
      } else {
        comment.likes.splice(likeIndex, 1);
      }

      comment.likesCount = comment.likes.length;
      await comment.save();

      fastify.io?.emit("comment:liked", {
        commentId: comment._id,
        likesCount: comment.likesCount,
        userId: userId.toString(),
        liked: likeIndex === -1,
      });

      if (likeIndex === -1 && comment.author.toString() !== userId.toString()) {
        await sendNotification(
          fastify,
          comment.author,
          userId,
          "like_comment",
          {
            postId: comment.post,
            commentId: comment._id,
            message: "کامنت شما را لایک کرد",
          },
        );
      }

      return {
        success: true,
        liked: likeIndex === -1,
        likesCount: comment.likesCount,
      };
    } catch (error) {
      if (error.name === "CastError") {
        return reply.status(400).send({
          success: false,
          message: "شناسه نامعتبر",
        });
      }

      fastify.log.error({ error }, "Like comment error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });

  fastify.delete("/:id", auth, async (req, reply) => {
    try {
      const comment = await Comment.findById(req.params.id);

      if (!comment) {
        return reply.status(404).send({
          success: false,
          message: "کامنت یافت نشد",
        });
      }

      if (!isAuthorOrAdmin(comment, req.user)) {
        return reply.status(403).send({
          success: false,
          message: "دسترسی ندارید",
        });
      }

      if (!comment.parentComment) {
        await Post.findByIdAndUpdate(comment.post, {
          $pull: { comments: comment._id },
        });
      }

      if (comment.parentComment) {
        await Comment.findByIdAndUpdate(comment.parentComment, {
          $pull: { replies: comment._id },
        });
      }

      await deleteRepliesRecursively(comment._id);
      await Comment.findByIdAndDelete(comment._id);

      fastify.io?.emit("comment:deleted", {
        commentId: req.params.id,
        postId: comment.post,
      });

      return {
        success: true,
        message: "حذف شد",
      };
    } catch (error) {
      if (error.name === "CastError") {
        return reply.status(400).send({
          success: false,
          message: "شناسه نامعتبر",
        });
      }

      fastify.log.error({ error }, "Delete comment error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });
};
