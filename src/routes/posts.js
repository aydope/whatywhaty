const Post = require("../models/Post");
const Comment = require("../models/Comment");
const { createPostSchema } = require("../validators/post");
const { isObjectId, sameId } = require("../utils/ids");
const { PUBLIC_USER_FIELDS } = require("../utils/publicUser");
const { withViewerLikes, withCommentLikes } = require("../services/likeService");
const {
  likePost,
  bumpExploreCache,
  EXPLORE_VERSION_KEY,
} = require("../services/reactionService");

const PAGE_SIZE = 10;
const EXPLORE_CANDIDATES = 500;
const EXPLORE_CACHE_SECONDS = 300;

const formatPosts = (posts, viewerId) =>
  posts.map((post) => ({
    ...withViewerLikes(post, viewerId),
    commentsCount: post.comments?.length || 0,
  }));

const getCommentsForPost = async (postId, viewerId) => {
  const comments = await Comment.find({ post: postId, parentComment: null })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("author", PUBLIC_USER_FIELDS)
    .lean();
  return comments.map((comment) => withCommentLikes(comment, viewerId));
};

const pageFrom = (query) => Math.max(1, parseInt(query.page, 10) || 1);

module.exports = async function (fastify) {
  const auth = { preHandler: [fastify.authenticate] };
  const optionalAuth = { preHandler: [fastify.authenticateSilent] };

  const invalidId = (reply) =>
    reply.status(400).send({ success: false, message: "شناسه نامعتبر" });

  fastify.post("/", auth, async (req, reply) => {
    try {
      const { error, value } = createPostSchema.validate(req.body);

      if (error) {
        return reply
          .status(400)
          .send({ success: false, message: error.details[0].message });
      }

      const post = await Post.create({
        author: req.user._id,
        content: value.content,
      });
      const populated = await Post.findById(post._id).populate("author", PUBLIC_USER_FIELDS);

      fastify.io.emit("post:new", populated);
      await bumpExploreCache(fastify);

      return { success: true, post: populated };
    } catch (error) {
      req.log.error({ err: error }, "Create post error");
      return reply.status(500).send({ success: false, message: "خطا در ایجاد پست" });
    }
  });

  fastify.get("/feed", auth, async (req, reply) => {
    try {
      const page = pageFrom(req.query);
      const followingIds = [...req.user.following, req.user._id];

      const posts = await Post.find({ author: { $in: followingIds } })
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .populate("author", PUBLIC_USER_FIELDS)
        .lean();

      return {
        success: true,
        posts: formatPosts(posts, req.user._id),
        page,
        hasMore: posts.length === PAGE_SIZE,
      };
    } catch (error) {
      req.log.error({ err: error }, "Get feed error");
      return reply.status(500).send({ success: false, message: "خطا در دریافت فید" });
    }
  });

  fastify.get("/user/:userId", auth, async (req, reply) => {
    try {
      if (!isObjectId(req.params.userId)) return invalidId(reply);
      const page = pageFrom(req.query);

      const posts = await Post.find({ author: req.params.userId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * 20)
        .limit(20)
        .populate("author", PUBLIC_USER_FIELDS)
        .lean();

      return {
        success: true,
        posts: formatPosts(posts, req.user._id),
        page,
        hasMore: posts.length === 20,
      };
    } catch (error) {
      req.log.error({ err: error }, "Get user posts error");
      return reply.status(500).send({ success: false, message: "خطا در دریافت پست‌ها" });
    }
  });

  fastify.get("/explore", auth, async (req, reply) => {
    try {
      const page = pageFrom(req.query);
      const viewerId = req.user._id;
      const redisReady = fastify.redis.status === "ready";

      let cacheKey = null;
      let result = null;

      if (redisReady) {
        try {
          const version = (await fastify.redis.get(EXPLORE_VERSION_KEY)) || "0";
          cacheKey = `explore:${version}:${page}`;
          const cached = await fastify.redis.get(cacheKey);
          if (cached) result = JSON.parse(cached);
        } catch (error) {
          req.log.warn({ err: error }, "Explore cache read failed");
        }
      }

      if (!result) {
        // Only the most recent posts are ranked, so the cost of one page does
        // not grow with the size of the collection.
        const posts = await Post.aggregate([
          { $sort: { createdAt: -1 } },
          { $limit: EXPLORE_CANDIDATES },
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
                ],
              },
            },
          },
          { $sort: { score: -1, createdAt: -1 } },
          { $skip: (page - 1) * PAGE_SIZE },
          { $limit: PAGE_SIZE },
          {
            $lookup: {
              from: "users",
              localField: "author",
              foreignField: "_id",
              pipeline: [{ $project: { username: 1, displayName: 1 } }],
              as: "author",
            },
          },
          { $unwind: "$author" },
          {
            $project: {
              content: 1,
              createdAt: 1,
              likesCount: 1,
              commentsCount: 1,
              "author._id": 1,
              "author.username": 1,
              "author.displayName": 1,
            },
          },
        ]);

        result = { posts, page, hasMore: posts.length === PAGE_SIZE };

        if (cacheKey) {
          fastify.redis
            .setex(cacheKey, EXPLORE_CACHE_SECONDS, JSON.stringify(result))
            .catch((error) =>
              req.log.warn({ err: error }, "Explore cache write failed"),
            );
        }
      }

      // The cached page is shared by everyone; whether the viewer liked each
      // post is looked up separately.
      const liked = await Post.find({
        _id: { $in: result.posts.map((p) => p._id) },
        likes: viewerId,
      })
        .select("_id")
        .lean();
      const likedIds = new Set(liked.map((p) => p._id.toString()));

      return {
        success: true,
        ...result,
        posts: result.posts.map((post) => ({
          ...post,
          likes: likedIds.has(post._id.toString()) ? [viewerId] : [],
        })),
      };
    } catch (error) {
      req.log.error({ err: error }, "Explore error");
      return reply.status(500).send({ success: false, message: "خطا در دریافت پست‌ها" });
    }
  });

  fastify.get("/:id", optionalAuth, async (req, reply) => {
    const notFound = () =>
      reply.status(404).view("404.ejs", {
        title: "پست یافت نشد",
        user: req.user,
      });

    try {
      if (!isObjectId(req.params.id)) return notFound();

      const post = await Post.findById(req.params.id)
        .populate("author", PUBLIC_USER_FIELDS)
        .lean();
      if (!post) return notFound();

      const viewerId = req.user?._id;
      const formatted = formatPosts([post], viewerId)[0];

      if ((req.headers.accept || "").includes("application/json")) {
        return { success: true, post: formatted };
      }

      const [comments, totalComments] = await Promise.all([
        getCommentsForPost(req.params.id, viewerId),
        Comment.countDocuments({ post: req.params.id }),
      ]);

      return reply.view("post.ejs", {
        post: formatted,
        comments,
        totalComments,
        user: req.user,
        title: `پست ${post.author?.username || ""} · واتی‌واتی`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Get post error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });

  fastify.post("/:id/like", auth, async (req, reply) => {
    try {
      if (!isObjectId(req.params.id)) return invalidId(reply);

      const result = await likePost(fastify, req.user._id, req.params.id);
      if (!result) {
        return reply.status(404).send({ success: false, message: "پست یافت نشد" });
      }
      return { success: true, ...result };
    } catch (error) {
      req.log.error({ err: error }, "Like post error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });

  fastify.delete("/:id", auth, async (req, reply) => {
    try {
      if (!isObjectId(req.params.id)) return invalidId(reply);

      const post = await Post.findById(req.params.id).select("author");
      if (!post) {
        return reply.status(404).send({ success: false, message: "پست یافت نشد" });
      }

      const isAuthor = sameId(post.author, req.user._id);
      if (!isAuthor && req.user.role !== "admin") {
        return reply.status(403).send({ success: false, message: "دسترسی ندارید" });
      }

      await Promise.all([
        Comment.deleteMany({ post: post._id }),
        Post.deleteOne({ _id: post._id }),
      ]);

      fastify.io?.emit("post:deleted", { postId: req.params.id });
      await bumpExploreCache(fastify);

      return { success: true, message: "حذف شد" };
    } catch (error) {
      req.log.error({ err: error }, "Delete post error");
      return reply.status(500).send({ success: false, message: "خطا" });
    }
  });
};
