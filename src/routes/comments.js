const Comment = require("../models/Comment");
const Post = require("../models/Post");
const Joi = require("joi");
const { sendNotification } = require("../services/notificationService");
const { likeComment } = require("../services/reactionService");
const { withCommentLikes } = require("../services/likeService");
const { deleteCommentTree } = require("../services/commentService");
const { isObjectId, sameId } = require("../utils/ids");
const { PUBLIC_USER_FIELDS } = require("../utils/publicUser");

const MAX_NESTING_DEPTH = 5;
const POPULATE_AUTHOR_SELECT = PUBLIC_USER_FIELDS;

const createCommentSchema = Joi.object({
  content: Joi.string().min(1).max(280).required().trim(),
  postId: Joi.string().hex().length(24).required(),
  parentCommentId: Joi.string().hex().length(24).allow(null, ""),
});

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

const pagination = (query, defaultLimit, maxLimit) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const pageInfo = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
  hasMore: page < Math.ceil(total / limit),
});

module.exports = async function (fastify) {
  const auth = { preHandler: [fastify.authenticate] };
  const optionalAuth = { preHandler: [fastify.authenticateSilent] };

  const invalidId = (reply) =>
    reply.status(400).send({ success: false, message: "شناسه نامعتبر" });

  fastify.get("/:commentId/replies", optionalAuth, async (req, reply) => {
    try {
      const { commentId } = req.params;
      if (!isObjectId(commentId)) return invalidId(reply);
      const { page, limit, skip } = pagination(req.query, 5, 20);

      const [replies, total] = await Promise.all([
        Comment.find({ parentComment: commentId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("author", POPULATE_AUTHOR_SELECT)
          .populate({
            path: "replies",
            populate: { path: "author", select: POPULATE_AUTHOR_SELECT },
          })
          .lean(),
        Comment.countDocuments({ parentComment: commentId }),
      ]);

      return {
        success: true,
        replies: replies.map((r) => withCommentLikes(r, req.user?._id)),
        pagination: pageInfo(page, limit, total),
      };
    } catch (error) {
      req.log.error({ err: error }, "Get replies error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });

  fastify.post("/", auth, async (req, reply) => {
    try {
      const { error, value } = createCommentSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      if (error) {
        return reply
          .status(400)
          .send({ success: false, message: error.details[0].message });
      }
      const { content, postId, parentCommentId } = value;

      const post = await Post.findById(postId).select("author");
      if (!post) {
        return reply.status(404).send({ success: false, message: "پست یافت نشد" });
      }

      let depth = 0;
      let parentComment = null;

      if (parentCommentId) {
        parentComment = await Comment.findById(parentCommentId).select(
          "author post parentComment depth",
        );

        // A reply must stay inside the post of the comment it answers.
        if (!parentComment || !sameId(parentComment.post, postId)) {
          return reply
            .status(404)
            .send({ success: false, message: "کامنت یافت نشد" });
        }

        depth = parentComment.depth + 1;
        if (depth > MAX_NESTING_DEPTH) {
          return reply
            .status(400)
            .send({ success: false, message: "حداکثر عمق پاسخگویی" });
        }
      }

      const comment = await Comment.create({
        post: postId,
        author: req.user._id,
        content,
        parentComment: parentCommentId || null,
        depth,
      });

      if (parentComment) {
        await Comment.updateOne(
          { _id: parentComment._id },
          { $push: { replies: comment._id } },
        );
      } else {
        await Post.updateOne({ _id: postId }, { $push: { comments: comment._id } });
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
        await sendNotification(fastify, parentComment.author, req.user._id, "reply", {
          postId: post._id,
          commentId: comment._id,
          message: "به کامنت شما پاسخ داد",
        });

        if (parentComment.parentComment) {
          const rootComment = await Comment.findById(parentComment.parentComment)
            .select("author")
            .lean();

          if (
            rootComment &&
            !sameId(rootComment.author, req.user._id) &&
            !sameId(rootComment.author, parentComment.author)
          ) {
            await sendNotification(fastify, rootComment.author, req.user._id, "reply", {
              postId: post._id,
              commentId: comment._id,
              message: "به گفتگوی شما پاسخ داد",
            });
          }
        }
      }

      const payload = withCommentLikes(populatedComment, req.user._id);
      fastify.io?.emit("comment:new", { postId, comment: withCommentLikes(populatedComment) });

      return reply.status(201).send({ success: true, comment: payload });
    } catch (error) {
      req.log.error({ err: error }, "Create comment error");
      return reply.status(500).send({ success: false, message: "خطا در ثبت کامنت" });
    }
  });

  fastify.get("/post/:postId", optionalAuth, async (req, reply) => {
    try {
      const { postId } = req.params;
      if (!isObjectId(postId)) return invalidId(reply);
      const { page, limit, skip } = pagination(req.query, 20, 50);

      const [comments, total] = await Promise.all([
        Comment.find({ post: postId, parentComment: null })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("author", POPULATE_AUTHOR_SELECT)
          .populate(buildRepliesPopulate())
          .lean(),
        Comment.countDocuments({ post: postId, parentComment: null }),
      ]);

      return {
        success: true,
        comments: comments.map((c) => withCommentLikes(c, req.user?._id)),
        pagination: pageInfo(page, limit, total),
      };
    } catch (error) {
      req.log.error({ err: error }, "Get comments error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });

  fastify.post("/:id/like", auth, async (req, reply) => {
    try {
      if (!isObjectId(req.params.id)) return invalidId(reply);

      const result = await likeComment(fastify, req.user._id, req.params.id);
      if (!result) {
        return reply.status(404).send({ success: false, message: "کامنت یافت نشد" });
      }
      return { success: true, ...result };
    } catch (error) {
      req.log.error({ err: error }, "Like comment error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });

  fastify.delete("/:id", auth, async (req, reply) => {
    try {
      if (!isObjectId(req.params.id)) return invalidId(reply);

      const comment = await Comment.findById(req.params.id);
      if (!comment) {
        return reply.status(404).send({ success: false, message: "کامنت یافت نشد" });
      }

      if (!sameId(comment.author, req.user._id) && req.user.role !== "admin") {
        return reply.status(403).send({ success: false, message: "دسترسی ندارید" });
      }

      await deleteCommentTree(comment);

      fastify.io?.emit("comment:deleted", {
        commentId: req.params.id,
        postId: comment.post,
      });

      return { success: true, message: "حذف شد" };
    } catch (error) {
      req.log.error({ err: error }, "Delete comment error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });
};
