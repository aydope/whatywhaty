const User = require("../models/User");
const Post = require("../models/Post");
const Comment = require("../models/Comment");
const Joi = require("joi");

const USER_NOT_FOUND = "کاربر مورد نظر یافت نشد";
const POST_NOT_FOUND = "پست مورد نظر یافت نشد";
const COMMENT_NOT_FOUND = "نظر مورد نظر یافت نشد";
const CANNOT_DELETE_ADMIN = "نمی‌توان کاربران مدیر را حذف کرد";
const USER_DELETED = "کاربر و تمام محتوای مرتبط حذف شد";
const POST_DELETED = "پست با موفقیت حذف شد";
const COMMENT_DELETED = "نظر با موفقیت حذف شد";

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const validatePagination = (query) => {
  const { error, value } = paginationSchema.validate(query, {
    stripUnknown: true,
  });
  if (error)
    throw Object.assign(new Error(error.details[0].message), {
      statusCode: 400,
    });
  return value;
};

const findUserOrFail = async (id, select = "-password") => {
  const user = await User.findById(id).select(select).lean();
  if (!user)
    throw Object.assign(new Error(USER_NOT_FOUND), { statusCode: 404 });
  return user;
};

const findPostOrFail = async (id) => {
  const post = await Post.findById(id);
  if (!post)
    throw Object.assign(new Error(POST_NOT_FOUND), { statusCode: 404 });
  return post;
};

const findCommentOrFail = async (id) => {
  const comment = await Comment.findById(id);
  if (!comment)
    throw Object.assign(new Error(COMMENT_NOT_FOUND), { statusCode: 404 });
  return comment;
};

const deleteCommentRecursive = async (commentId) => {
  const replies = await Comment.find({ parentComment: commentId }).select(
    "_id",
  );
  for (const reply of replies) {
    await deleteCommentRecursive(reply._id);
  }
  await Comment.findByIdAndDelete(commentId);
};

module.exports = async function (fastify, opts) {
  fastify.addHook("preHandler", fastify.authenticateAdmin);

  fastify.get("/dashboard", async (req, reply) => {
    try {
      const [totalUsers, totalPosts, totalComments, recentUsers] =
        await Promise.all([
          User.countDocuments(),
          Post.countDocuments(),
          Comment.countDocuments(),
          User.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .select("-password")
            .lean(),
        ]);

      return reply.view("admin/dashboard.ejs", {
        admin: req.user,
        stats: { totalUsers, totalPosts, totalComments, recentUsers },
      });
    } catch (error) {
      req.log.error({ err: error }, "Dashboard error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در بارگذاری داشبورد" });
    }
  });

  fastify.get("/users", async (req, reply) => {
    try {
      const { page, limit } = validatePagination(req.query);
      const skip = (page - 1) * limit;

      const [users, total] = await Promise.all([
        User.find()
          .select("-password")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        User.countDocuments(),
      ]);

      return {
        success: true,
        users,
        page,
        totalPages: Math.ceil(total / limit),
        total,
        hasMore: page * limit < total,
      };
    } catch (error) {
      if (error.statusCode === 400) {
        return reply
          .status(400)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error }, "Get users error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت لیست کاربران" });
    }
  });

  fastify.get("/users/:id", async (req, reply) => {
    try {
      const user = await findUserOrFail(req.params.id);

      const [userPosts, userComments] = await Promise.all([
        Post.find({ author: user._id })
          .sort({ createdAt: -1 })
          .select("content createdAt likesCount")
          .lean(),
        Comment.find({ author: user._id })
          .sort({ createdAt: -1 })
          .select("content createdAt post")
          .lean(),
      ]);

      return {
        success: true,
        user,
        stats: {
          postCount: userPosts.length,
          commentCount: userComments.length,
        },
        recentPosts: userPosts,
        recentComments: userComments,
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error, userId: req.params.id }, "Get user error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت اطلاعات کاربر" });
    }
  });

  fastify.delete("/users/:id", async (req, reply) => {
    try {
      const user = await findUserOrFail(req.params.id, "role");

      if (user.role === "admin") {
        return reply
          .status(403)
          .send({ success: false, message: CANNOT_DELETE_ADMIN });
      }

      await Promise.all([
        Post.deleteMany({ author: user._id }),
        Comment.deleteMany({ author: user._id }),
        User.findByIdAndDelete(user._id),
      ]);

      fastify.io?.emit("user:deleted", { userId: req.params.id });

      req.log.info(
        { deletedUser: user._id, by: req.user._id },
        "User deleted by admin",
      );
      return { success: true, message: USER_DELETED };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error, userId: req.params.id }, "Delete user error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در حذف کاربر" });
    }
  });

  fastify.get("/posts", async (req, reply) => {
    try {
      const { page, limit } = validatePagination(req.query);
      const skip = (page - 1) * limit;

      const [posts, total] = await Promise.all([
        Post.find()
          .populate("author", "username email")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Post.countDocuments(),
      ]);

      return {
        success: true,
        posts,
        page,
        totalPages: Math.ceil(total / limit),
        total,
        hasMore: page * limit < total,
      };
    } catch (error) {
      if (error.statusCode === 400) {
        return reply
          .status(400)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error }, "Get posts error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت لیست پست‌ها" });
    }
  });

  fastify.get("/posts/:id", async (req, reply) => {
    try {
      const post = await findPostOrFail(req.params.id);

      const [postWithAuthor, comments] = await Promise.all([
        Post.findById(post._id).populate("author", "username email").lean(),
        Comment.find({ post: post._id })
          .populate("author", "username")
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      return {
        success: true,
        post: postWithAuthor,
        comments,
        commentCount: comments.length,
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error, postId: req.params.id }, "Get post error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت اطلاعات پست" });
    }
  });

  fastify.delete("/posts/:id", async (req, reply) => {
    try {
      const post = await findPostOrFail(req.params.id);

      const comments = await Comment.find({ post: post._id }).select("_id");
      for (const comment of comments) {
        await deleteCommentRecursive(comment._id);
      }
      await Post.findByIdAndDelete(post._id);

      fastify.io?.emit("post:deleted", { postId: req.params.id });

      req.log.info(
        { deletedPost: post._id, by: req.user._id },
        "Post deleted by admin",
      );
      return { success: true, message: POST_DELETED };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error, postId: req.params.id }, "Delete post error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در حذف پست" });
    }
  });

  fastify.get("/comments", async (req, reply) => {
    try {
      const { page, limit } = validatePagination(req.query);
      const skip = (page - 1) * limit;

      const [comments, total] = await Promise.all([
        Comment.find({ parentComment: null })
          .populate("author", "username email")
          .populate("post", "content")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Comment.countDocuments({ parentComment: null }),
      ]);

      return {
        success: true,
        comments,
        page,
        totalPages: Math.ceil(total / limit),
        total,
        hasMore: page * limit < total,
      };
    } catch (error) {
      if (error.statusCode === 400) {
        return reply
          .status(400)
          .send({ success: false, message: error.message });
      }
      req.log.error({ err: error }, "Get comments error");
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت لیست نظرات" });
    }
  });

  fastify.get("/comments/:id", async (req, reply) => {
    try {
      const comment = await findCommentOrFail(req.params.id);

      const [commentWithDetails, replies] = await Promise.all([
        Comment.findById(comment._id)
          .populate("author", "username email")
          .populate("post", "content")
          .lean(),
        Comment.find({ parentComment: comment._id })
          .populate("author", "username")
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      return {
        success: true,
        comment: commentWithDetails,
        replies,
        replyCount: replies.length,
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error(
        { err: error, commentId: req.params.id },
        "Get comment error",
      );
      return reply
        .status(500)
        .send({ success: false, message: "خطا در دریافت اطلاعات نظر" });
    }
  });

  fastify.delete("/comments/:id", async (req, reply) => {
    try {
      const comment = await findCommentOrFail(req.params.id);

      await deleteCommentRecursive(comment._id);

      fastify.io?.emit("comment:deleted", {
        commentId: req.params.id,
        postId: comment.post,
        parentComment: comment.parentComment || null,
      });

      req.log.info(
        { deletedComment: comment._id, by: req.user._id },
        "Comment deleted by admin",
      );
      return { success: true, message: COMMENT_DELETED };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error(
        { err: error, commentId: req.params.id },
        "Delete comment error",
      );
      return reply
        .status(500)
        .send({ success: false, message: "خطا در حذف نظر" });
    }
  });

  fastify.delete("/replies/:id", async (req, reply) => {
    try {
      const reply = await findCommentOrFail(req.params.id);

      if (!reply.parentComment) {
        return reply
          .status(400)
          .send({ success: false, message: "این نظر یک ریپلای نیست" });
      }

      await deleteCommentRecursive(reply._id);

      fastify.io?.emit("comment:deleted", {
        commentId: req.params.id,
        postId: reply.post,
        parentComment: reply.parentComment,
      });

      req.log.info(
        { deletedReply: reply._id, by: req.user._id },
        "Reply deleted by admin",
      );
      return { success: true, message: COMMENT_DELETED };
    } catch (error) {
      if (error.statusCode === 404) {
        return reply
          .status(404)
          .send({ success: false, message: error.message });
      }
      req.log.error(
        { err: error, replyId: req.params.id },
        "Delete reply error",
      );
      return reply
        .status(500)
        .send({ success: false, message: "خطا در حذف ریپلای" });
    }
  });
};
