const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "نویسنده پست الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه نویسنده نامعتبر است",
      },
    },
    content: {
      type: String,
      required: [true, "متن پست الزامی است"],
      maxlength: [280, "متن پست نمی‌تواند بیشتر از ۲۸۰ کاراکتر باشد"],
      minlength: [1, "متن پست نمی‌تواند خالی باشد"],
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
    comments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",
        validate: {
          validator: function (value) {
            return mongoose.Types.ObjectId.isValid(value);
          },
          message: "شناسه کامنت نامعتبر است",
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

postSchema.index({ createdAt: -1 });
postSchema.index({ author: 1, createdAt: -1 });

postSchema.pre("save", function () {
  if (this.content) {
    this.content = this.content.trim();
  }
});

postSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate();
  if (update.content) {
    update.content = update.content.trim();
  }
});

postSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Post", postSchema);
