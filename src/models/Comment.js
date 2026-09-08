const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: [true, "پست کامنت الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه پست نامعتبر است",
      },
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "نویسنده کامنت الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه نویسنده نامعتبر است",
      },
    },
    content: {
      type: String,
      required: [true, "متن کامنت الزامی است"],
      maxlength: [280, "متن کامنت نمی‌تواند بیشتر از ۲۸۰ کاراکتر باشد"],
      minlength: [1, "متن کامنت نمی‌تواند خالی باشد"],
      trim: true,
    },
    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        validate: {
          validator: function (value) {
            return mongoose.Types.ObjectId.isValid(value);
          },
          message: "شناسه کاربر نامعتبر است",
        },
      },
    ],
    parentComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
      validate: {
        validator: function (value) {
          return !value || mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه کامنت والد نامعتبر است",
      },
    },
    replies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",
        validate: {
          validator: function (value) {
            return mongoose.Types.ObjectId.isValid(value);
          },
          message: "شناسه پاسخ نامعتبر است",
        },
      },
    ],
    depth: {
      type: Number,
      default: 0,
      min: [0, "عمق کامنت نمی‌تواند منفی باشد"],
      max: [5, "عمق کامنت نمی‌تواند بیشتر از ۵ باشد"],
    },
  },
  {
    timestamps: true,
  },
);

commentSchema.index({ post: 1, parentComment: 1 });
commentSchema.index({ author: 1 });
commentSchema.index({ post: 1, createdAt: -1 });
commentSchema.index({ parentComment: 1, createdAt: 1 });

commentSchema.pre("save", function () {
  if (this.content) {
    this.content = this.content.trim();
  }
  if (this.parentComment) {
    this.depth = 1;
  }
});

commentSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate();
  if (update.content) {
    update.content = update.content.trim();
  }
});

commentSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  if (obj.isDeleted) {
    delete obj.content;
  }
  return obj;
};

module.exports = mongoose.model("Comment", commentSchema);
