const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "دریافت‌کننده اعلان الزامی است"],
      index: true,
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه دریافت‌کننده نامعتبر است",
      },
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "فرستنده اعلان الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه فرستنده نامعتبر است",
      },
    },
    type: {
      type: String,
      enum: {
        values: [
          "comment",
          "reply",
          "like",
          "like_comment",
          "follow",
          "message",
        ],
        message: "نوع اعلان نامعتبر است",
      },
      required: [true, "نوع اعلان الزامی است"],
    },
    message: {
      type: String,
      required: [true, "متن اعلان الزامی است"],
      trim: true,
    },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      validate: {
        validator: function (value) {
          return !value || mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه پست نامعتبر است",
      },
    },
    commentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      validate: {
        validator: function (value) {
          return !value || mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه کامنت نامعتبر است",
      },
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ sender: 1 });
notificationSchema.index({ postId: 1 });

notificationSchema.pre("save", function () {
  if (this.message) {
    this.message = this.message.trim();
  }
  if (this.isRead && !this.readAt) {
    this.readAt = new Date();
  }
});

notificationSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate();
  if (update.message) {
    update.message = update.message.trim();
  }
  if (update.isRead === true && !update.readAt) {
    update.readAt = new Date();
  }
});

notificationSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Notification", notificationSchema);
