const Post = require("../models/Post");
const Comment = require("../models/Comment");
const { sendNotification } = require("../services/notificationService");
const { createPostSchema } = require("../validators/post");

const formatPosts = (posts) =>
  posts.map((p) => ({
    ...p,
    likesCount: p.likes?.length || 0,
    commentsCount: p.comments?.length || 0,
  }));

const getCommentsForPost = async (postId) =>
  Comment.find({ post: postId, parentComment: null })
    .sort({ createdAt: -1 })
    .populate("author", "username")
    .lean();

module.exports = async function (fastify, opts) {
  const auth = { preHandler: [fastify.authenticate] };
  const optionalAuth = { preHandler: [fastify.authenticateSilent] };

  fastify.post("/", auth, async (req, reply) => {
    try {
      const { error, value } = createPostSchema.validate(req.body);

      if (error) {
        return reply.status(400).send({
          success: false,
          message: error.details[0].message,
        });
      }

      const post = await Post.create({
        author: req.user._id,
        content: value.content,
      });

      const populated = await Post.findById(post._id).populate(
        "author",
        "username",
      );

      fastify.io.emit("post:new", populated);

      return {
        success: true,
        post: populated,
      };
    } catch (error) {
      fastify.log.error({ error }, "Create post error");
      return reply.status(500).send({
        success: false,
        message: "خطا در ایجاد پست",
      });
    }
  });

  fastify.get("/feed", auth, async (req, reply) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = 10;
      const skip = (page - 1) * limit;
      const followingIds = [...req.user.following, req.user._id];

      const posts = await Post.find({ author: { $in: followingIds } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", "username")
        .lean();

      return {
        success: true,
        posts: formatPosts(posts),
        page,
        hasMore: posts.length === limit,
      };
    } catch (error) {
      fastify.log.error({ error }, "Get feed error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت فید",
      });
    }
  });

  fastify.get("/user/:userId", auth, async (req, reply) => {
    try {
      const posts = await Post.find({ author: req.params.userId })
        .sort({ createdAt: -1 })
        .populate("author", "username")
        .lean();

      return {
        success: true,
        posts: formatPosts(posts),
      };
    } catch (error) {
      if (error.name === "CastError") {
        return reply.status(400).send({
          success: false,
          message: "شناسه نامعتبر",
        });
      }

      fastify.log.error({ error }, "Get user posts error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت پست‌ها",
      });
    }
  });

  fastify.get("/explore", auth, async (req, reply) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = 10;
      const cacheKey = `explore:${page}`;

      const cached = await fastify.redis.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const posts = await Post.aggregate([
        {
          $addFields: {
            likesCount: { $size: { $ifNull: ["$likes", []] } },
            commentsCount: { $size: { $ifNull: ["$comments", []] } },
          },
        },
        {
          $addFields: {
            score: {
              $add: [
                { $multiply: ["$likesCount", 2] },
                { $multiply: ["$commentsCount", 1.5] },
                {
                  $divide: [
                    1,
                    { $add: [{ $subtract: [new Date(), "$createdAt"] }, 1] },
                  ],
                },
              ],
            },
          },
        },
        { $sort: { score: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "author",
            foreignField: "_id",
            pipeline: [{ $project: { username: 1 } }],
            as: "author",
          },
        },
        { $unwind: "$author" },
        {
          $project: {
            content: 1,
            likes: 1,
            comments: 1,
            createdAt: 1,
            likesCount: 1,
            commentsCount: 1,
            "author.username": 1,
            "author._id": 1,
          },
        },
      ]);

      const result = {
        success: true,
        posts,
        page,
        hasMore: posts.length === limit,
      };

      await fastify.redis.setex(cacheKey, 300, JSON.stringify(result));

      return result;
    } catch (error) {
      fastify.log.error({ error }, "Explore error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت پست‌ها",
      });
    }
  });

  fastify.get("/:id", optionalAuth, async (req, reply) => {
    try {
      const post = await Post.findById(req.params.id)
        .populate("author", "username")
        .lean();

      if (!post) {
        return reply.status(404).view("404.ejs", {
          title: "پست یافت نشد",
          user: req.user,
        });
      }

      if ((req.headers.accept || "").includes("application/json")) {
        return {
          success: true,
          post: formatPosts([post])[0],
        };
      }

      const comments = await getCommentsForPost(req.params.id);
      const totalComments = await Comment.countDocuments({
        post: req.params.id,
      });

      return reply.view("post.ejs", {
        post: formatPosts([post])[0],
        comments,
        totalComments,
        user: req.user,
        title: `پست ${post.author?.username || ""} · واتی‌واتی`,
      });
    } catch (error) {
      if (error.name === "CastError") {
        return reply.status(404).view("404.ejs", {
          title: "پست یافت نشد",
          user: req.user,
        });
      }

      fastify.log.error({ error }, "Get post error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });

  fastify.post("/:id/like", auth, async (req, reply) => {
    try {
      const post = await Post.findById(req.params.id);

      if (!post) {
        return reply.status(404).send({
          success: false,
          message: "پست یافت نشد",
        });
      }

      const userId = req.user._id;
      const likeIndex = post.likes.indexOf(userId);

      if (likeIndex === -1) {
        post.likes.push(userId);
      } else {
        post.likes.splice(likeIndex, 1);
      }

      await post.save();

      const liked = likeIndex === -1;
      const likesCount = post.likes.length;

      fastify.io?.emit("post:liked", {
        postId: post._id,
        likesCount,
        userId: userId.toString(),
        liked,
      });

      if (liked && post.author.toString() !== userId.toString()) {
        await sendNotification(fastify, post.author, userId, "like", {
          postId: post._id,
          message: "پست شما را لایک کرد",
        });
      }

      try {
        const stream = fastify.redis.scanStream({
          match: "explore:*",
          count: 100,
        });

        const pipeline = fastify.redis.pipeline();

        stream.on("data", (keys) => {
          if (keys.length > 0) {
            keys.forEach((key) => pipeline.del(key));
          }
        });

        stream.on("end", () => {
          pipeline.exec().catch((error) => {
            fastify.log.warn({ error }, "Failed to invalidate explore cache");
          });
        });
      } catch (cacheError) {
        fastify.log.warn({ cacheError }, "Cache invalidation warning");
      }

      return {
        success: true,
        liked,
        likesCount,
      };
    } catch (error) {
      if (error.name === "CastError") {
        return reply.status(400).send({
          success: false,
          message: "شناسه نامعتبر",
        });
      }

      fastify.log.error({ error }, "Like post error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });

  fastify.delete("/:id", auth, async (req, reply) => {
    try {
      const post = await Post.findById(req.params.id);

      if (!post) {
        return reply.status(404).send({
          success: false,
          message: "پست یافت نشد",
        });
      }

      const isAuthor = post.author.toString() === req.user._id.toString();
      const isAdmin = req.user.role === "admin";

      if (!isAuthor && !isAdmin) {
        return reply.status(403).send({
          success: false,
          message: "دسترسی ندارید",
        });
      }

      await Comment.deleteMany({ post: post._id });
      await Post.findByIdAndDelete(req.params.id);

      fastify.io?.emit("post:deleted", { postId: req.params.id });

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

      fastify.log.error({ error }, "Delete post error");
      return reply.status(500).send({
        success: false,
        message: "خطا",
      });
    }
  });
};
