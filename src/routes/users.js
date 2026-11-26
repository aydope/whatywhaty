const User = require("../models/User");
const Post = require("../models/Post");
const { sendNotification } = require("../services/notificationService");
const { updateProfileSchema } = require("../validators/user");
const { isUsernameTaken } = require("../utils/usernames");
const { withViewerLikes } = require("../services/likeService");
const { isObjectId, sameId } = require("../utils/ids");
const { PUBLIC_USER_FIELDS } = require("../utils/publicUser");

const USER_NOT_FOUND = "کاربر مورد نظر یافت نشد";
const CANNOT_SELF_ACTION = "نمی‌توانید این عملیات را روی خودتان انجام دهید";
const BLOCKED_BY_USER = "شما توسط این کاربر بلاک شده‌اید";
const USERNAME_TAKEN = "این نام کاربری قبلاً استفاده شده است";
const EMAIL_TAKEN = "این ایمیل قبلاً استفاده شده است";
const INVALID_ID = "شناسه نامعتبر است";

const httpError = (message, statusCode) =>
  Object.assign(new Error(message), { statusCode });

const assertValidId = (id) => {
  if (!isObjectId(id)) throw httpError(INVALID_ID, 400);
};

const assertNotSelf = (currentUserId, targetId) => {
  if (sameId(currentUserId, targetId)) throw httpError(CANNOT_SELF_ACTION, 400);
};

const findUserById = async (id, select = "") => {
  const user = await User.findById(id).select(select);
  if (!user) throw httpError(USER_NOT_FOUND, 404);
  return user;
};

const pagination = (query, defaultLimit, maxLimit) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = async function (fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  const fail = (req, reply, error, fallback) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ success: false, message: error.message });
    }
    req.log.error({ err: error }, fallback);
    return reply.status(500).send({ success: false, message: fallback });
  };

  fastify.get("/search", auth, async (req, reply) => {
    try {
      // "@alice" searches by id; anything else matches id and display name.
      const query = (typeof req.query.q === "string" ? req.query.q : "")
        .trim()
        .replace(/^@/, "");
      if (query.length < 2 || query.length > 64) {
        return { success: true, users: [] };
      }

      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = await User.find({
        $or: [
          { username: { $regex: escaped, $options: "i" } },
          { displayName: { $regex: escaped, $options: "i" } },
        ],
        _id: { $ne: req.user._id },
      })
        .select(PUBLIC_USER_FIELDS)
        .limit(25)
        .lean();

      // Exact id first, then ids that start with the query, then the rest.
      const needle = query.toLowerCase();
      const rank = (u) => {
        const name = u.username.toLowerCase();
        return name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
      };
      const users = found.sort((a, b) => rank(a) - rank(b)).slice(0, 10);

      const blockedByYou = new Set((req.user.blockedUsers || []).map(String));
      return {
        success: true,
        users: users.map((u) => ({
          ...u,
          isBlockedByYou: blockedByYou.has(u._id.toString()),
        })),
      };
    } catch (error) {
      return fail(req, reply, error, "خطا در جستجوی کاربران");
    }
  });

  fastify.put("/profile", auth, async (req, reply) => {
    try {
      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) {
        return reply
          .status(400)
          .send({ success: false, message: error.details[0].message });
      }

      if (value.username && (await isUsernameTaken(value.username, req.user._id))) {
        return reply.status(400).send({ success: false, message: USERNAME_TAKEN });
      }

      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: value },
        { returnDocument: "after", runValidators: true },
      ).select("-password");

      return { success: true, user: updatedUser };
    } catch (error) {
      if (error.code === 11000) {
        return reply.status(400).send({ success: false, message: EMAIL_TAKEN });
      }
      return fail(req, reply, error, "خطا در به‌روزرسانی پروفایل");
    }
  });

  fastify.get("/:id/posts", auth, async (req, reply) => {
    try {
      assertValidId(req.params.id);
      const { page, limit, skip } = pagination(req.query, 50, 100);

      const posts = await Post.find({ author: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", PUBLIC_USER_FIELDS)
        .lean();

      return {
        success: true,
        posts: posts.map((post) => ({
          ...withViewerLikes(post, req.user._id),
          commentsCount: post.comments?.length || 0,
        })),
        page,
        hasMore: posts.length === limit,
      };
    } catch (error) {
      return fail(req, reply, error, "خطا در دریافت پست‌ها");
    }
  });

  fastify.post("/:id/follow", auth, async (req, reply) => {
    try {
      const targetId = req.params.id;
      assertValidId(targetId);
      assertNotSelf(req.user._id, targetId);

      const targetUser = await findUserById(targetId, "blockedUsers");
      if ((targetUser.blockedUsers || []).some((id) => sameId(id, req.user._id))) {
        throw httpError(BLOCKED_BY_USER, 403);
      }

      const isFollowing = req.user.following.some((id) => sameId(id, targetId));
      const op = isFollowing ? "$pull" : "$addToSet";

      await Promise.all([
        User.updateOne({ _id: req.user._id }, { [op]: { following: targetId } }),
        User.updateOne({ _id: targetId }, { [op]: { followers: req.user._id } }),
      ]);

      const { followers } = await User.findById(targetId).select("followers").lean();
      const followersCount = followers.length;

      if (isFollowing) {
        fastify.io?.to(`user:${targetId}`).emit("user:unfollowed", {
          followerId: req.user._id,
          followersCount,
        });
      } else {
        await sendNotification(fastify, targetId, req.user._id, "follow", {
          message: "شما را دنبال کرد",
        });
        fastify.io?.to(`user:${targetId}`).emit("user:followed", {
          followerId: req.user._id,
          followerUsername: req.user.username,
          followersCount,
        });
      }

      return { success: true, following: !isFollowing, followersCount };
    } catch (error) {
      return fail(req, reply, error, "خطا");
    }
  });

  fastify.post("/:id/block", auth, async (req, reply) => {
    try {
      const targetId = req.params.id;
      assertValidId(targetId);
      assertNotSelf(req.user._id, targetId);
      await findUserById(targetId, "_id");

      const isBlocked = req.user.blockedUsers.some((id) => sameId(id, targetId));

      if (isBlocked) {
        await User.updateOne({ _id: req.user._id }, { $pull: { blockedUsers: targetId } });
      } else {
        await Promise.all([
          User.updateOne(
            { _id: req.user._id },
            { $addToSet: { blockedUsers: targetId }, $pull: { following: targetId } },
          ),
          User.updateOne({ _id: targetId }, { $pull: { followers: req.user._id } }),
        ]);
      }

      fastify.io
        ?.to(`user:${targetId}`)
        .emit(isBlocked ? "user:unblocked" : "user:blocked", {
          userId: req.user._id.toString(),
        });

      return { success: true, blocked: !isBlocked };
    } catch (error) {
      return fail(req, reply, error, "خطا");
    }
  });

  const listRelation = (field) => async (req, reply) => {
    try {
      assertValidId(req.params.id);
      const { page, limit, skip } = pagination(req.query, 20, 50);

      // Slice the id array in the database and only load that page of users.
      const doc = await User.findById(req.params.id)
        .select({ _id: 1, [field]: { $slice: [skip, limit] } })
        .populate({ path: field, select: PUBLIC_USER_FIELDS })
        .lean();
      if (!doc) throw httpError(USER_NOT_FOUND, 404);

      const [{ total }] = await User.aggregate([
        { $match: { _id: doc._id } },
        { $project: { total: { $size: { $ifNull: [`$${field}`, []] } } } },
      ]);
      const hasMore = skip + doc[field].length < total;

      return {
        success: true,
        [field]: doc[field],
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        total,
      };
    } catch (error) {
      return fail(req, reply, error, "خطا");
    }
  };

  fastify.get("/:id/followers", auth, listRelation("followers"));
  fastify.get("/:id/following", auth, listRelation("following"));

  fastify.get("/:id/info", auth, async (req, reply) => {
    try {
      assertValidId(req.params.id);
      const user = await findUserById(req.params.id, PUBLIC_USER_FIELDS);
      return { success: true, data: { user } };
    } catch (error) {
      return fail(req, reply, error, "خطا در دریافت اطلاعات کاربر");
    }
  });
};
