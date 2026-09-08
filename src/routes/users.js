const User = require("../models/User");
const Post = require("../models/Post");
const { sendNotification } = require("../services/notificationService");
const { updateProfileSchema } = require("../validators/user");

const USER_NOT_FOUND = "کاربر مورد نظر یافت نشد";
const CANNOT_SELF_ACTION = "نمی‌توانید این عملیات را روی خودتان انجام دهید";
const BLOCKED_BY_USER = "شما توسط این کاربر بلاک شده‌اید";
const USERNAME_TAKEN = "این نام کاربری قبلاً استفاده شده است";

const findUserById = async (id, select = "") => {
  const user = await User.findById(id).select(select);

  if (!user) {
    const error = new Error(USER_NOT_FOUND);
    error.statusCode = 404;
    throw error;
  }

  return user;
};

const ensureNotSelf = (currentUserId, targetId) => {
  if (currentUserId === targetId.toString()) {
    const error = new Error(CANNOT_SELF_ACTION);
    error.statusCode = 400;
    throw error;
  }
};

const ensureNotBlocked = (targetUser, currentUserId) => {
  if (targetUser.blockedUsers?.includes(currentUserId)) {
    const error = new Error(BLOCKED_BY_USER);
    error.statusCode = 403;
    throw error;
  }
};

const isUsernameTaken = async (username, excludeUserId) => {
  const existingUser = await User.findOne({
    username,
    _id: { $ne: excludeUserId },
  });

  return !!existingUser;
};

const formatPosts = (posts) =>
  posts.map((post) => ({
    ...post,
    likesCount: post.likes?.length || 0,
    commentsCount: post.comments?.length || 0,
  }));

module.exports = async function (fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/search", auth, async (req, reply) => {
    try {
      const query = req.query.q?.trim() || "";

      if (query.length < 2 || query.length > 64) {
        return { success: true, users: [] };
      }

      const sanitizedQuery = query.replace(/[.*+?^${}()|[\]\\'"!]/g, "\\$&");

      const users = await User.find({
        username: { $regex: sanitizedQuery, $options: "i" },
        _id: { $ne: req.user._id },
      })
        .select("username")
        .limit(10);

      return { success: true, users };
    } catch (error) {
      req.log.error({ error, query: req.query.q }, "Search users error");
      return reply.status(500).send({
        success: false,
        message: "خطا در جستجوی کاربران",
      });
    }
  });

  fastify.put("/profile", auth, async (req, reply) => {
    try {
      const { error, value } = updateProfileSchema.validate(req.body);

      if (error) {
        return reply.status(400).send({
          success: false,
          message: error.details[0].message,
        });
      }

      if (value.username) {
        const taken = await isUsernameTaken(value.username, req.user._id);

        if (taken) {
          return reply.status(400).send({
            success: false,
            message: USERNAME_TAKEN,
          });
        }
      }

      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: value },
        { new: true, runValidators: true },
      ).select("-password");

      return { success: true, user: updatedUser };
    } catch (error) {
      req.log.error({ error, userId: req.user._id }, "Profile update error");
      return reply.status(500).send({
        success: false,
        message: "خطا در به‌روزرسانی پروفایل",
      });
    }
  });

  fastify.get("/:id/posts", async (req, reply) => {
    try {
      const posts = await Post.find({ author: req.params.id })
        .sort({ createdAt: -1 })
        .populate("author", "username")
        .lean();

      return { success: true, posts: formatPosts(posts) };
    } catch (error) {
      req.log.error({ error, userId: req.params.id }, "Get posts error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت پست‌ها",
      });
    }
  });

  fastify.post("/:id/follow", auth, async (req, reply) => {
    try {
      const targetId = req.params.id;
      const currentUserId = req.user._id;

      ensureNotSelf(currentUserId, targetId);

      const [targetUser, currentUser] = await Promise.all([
        findUserById(targetId, "blockedUsers followers"),
        User.findById(currentUserId).select("following"),
      ]);

      ensureNotBlocked(targetUser, currentUserId);

      const isFollowing = currentUser.following.includes(targetId);

      const updateCurrent = isFollowing
        ? { $pull: { following: targetId } }
        : { $push: { following: targetId } };

      const updateTarget = isFollowing
        ? { $pull: { followers: currentUserId } }
        : { $push: { followers: currentUserId } };

      await Promise.all([
        User.findByIdAndUpdate(currentUserId, updateCurrent),
        User.findByIdAndUpdate(targetId, updateTarget),
      ]);

      const newFollowersCount = isFollowing
        ? targetUser.followers.length - 1
        : targetUser.followers.length + 1;

      if (!isFollowing) {
        await sendNotification(
          fastify,
          targetUser._id,
          currentUserId,
          "follow",
          {
            message: "شما را دنبال کرد",
          },
        );

        fastify.io?.to(`user:${targetId}`).emit("user:followed", {
          followerId: currentUserId,
          followerUsername: req.user.username,
          followersCount: newFollowersCount,
        });
      } else {
        fastify.io?.to(`user:${targetId}`).emit("user:unfollowed", {
          followerId: currentUserId,
          followersCount: newFollowersCount,
        });
      }

      return {
        success: true,
        following: !isFollowing,
        followersCount: newFollowersCount,
      };
    } catch (error) {
      req.log.error({ error, targetId: req.params.id }, "Follow error");
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message || "خطا",
      });
    }
  });

  fastify.post("/:id/block", auth, async (req, reply) => {
    try {
      const targetId = req.params.id;
      const currentUserId = req.user._id;

      ensureNotSelf(currentUserId, targetId);

      const [targetUser, currentUser] = await Promise.all([
        findUserById(targetId, "followers"),
        User.findById(currentUserId).select("blockedUsers following"),
      ]);

      const isBlocked = currentUser.blockedUsers.includes(targetId);

      if (isBlocked) {
        await User.findByIdAndUpdate(currentUserId, {
          $pull: { blockedUsers: targetId },
        });
      } else {
        await Promise.all([
          User.findByIdAndUpdate(currentUserId, {
            $push: { blockedUsers: targetId },
            $pull: { following: targetId },
          }),
          User.findByIdAndUpdate(targetId, {
            $pull: { followers: currentUserId },
          }),
        ]);
      }

      return { success: true, blocked: !isBlocked };
    } catch (error) {
      req.log.error({ error, targetId: req.params.id }, "Block error");
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message || "خطا",
      });
    }
  });

  fastify.get("/:id/followers", async (req, reply) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      const user = await User.findById(req.params.id)
        .select("followers")
        .populate({
          path: "followers",
          select: "username",
          options: {
            skip,
            limit: parseInt(limit),
            sort: { createdAt: -1 },
          },
        });

      if (!user) {
        return reply.status(404).send({
          success: false,
          message: USER_NOT_FOUND,
        });
      }

      const totalFollowers = await User.findById(req.params.id).select(
        "followers",
      );

      const totalCount = totalFollowers?.followers?.length || 0;
      const hasMore = skip + user.followers.length < totalCount;

      return {
        success: true,
        followers: user.followers,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        total: totalCount,
      };
    } catch (error) {
      req.log.error({ error, userId: req.params.id }, "Get followers error");
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message || "خطا",
      });
    }
  });

  fastify.get("/:id/following", async (req, reply) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      const user = await User.findById(req.params.id)
        .select("following")
        .populate({
          path: "following",
          select: "username",
          options: {
            skip,
            limit: parseInt(limit),
            sort: { createdAt: -1 },
          },
        });

      if (!user) {
        return reply.status(404).send({
          success: false,
          message: USER_NOT_FOUND,
        });
      }

      const totalFollowing = await User.findById(req.params.id).select(
        "following",
      );

      const totalCount = totalFollowing?.following?.length || 0;
      const hasMore = skip + user.following.length < totalCount;

      return {
        success: true,
        following: user.following,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        total: totalCount,
      };
    } catch (error) {
      req.log.error({ error, userId: req.params.id }, "Get following error");
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message || "خطا",
      });
    }
  });

  fastify.get("/:id/info", auth, async (req, reply) => {
    try {
      const user = await User.findById(req.params.id).select("username");

      if (!user) {
        return reply.status(404).send({
          success: false,
          message: USER_NOT_FOUND,
        });
      }

      return { success: true, data: { user } };
    } catch (error) {
      req.log.error({ error, userId: req.params.id }, "Get user info error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت اطلاعات کاربر",
      });
    }
  });
};
