const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "فرستنده پیام الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه فرستنده نامعتبر است",
      },
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "دریافت‌کننده پیام الزامی است"],
      validate: {
        validator: function (value) {
          return mongoose.Types.ObjectId.isValid(value);
        },
        message: "شناسه دریافت‌کننده نامعتبر است",
      },
    },
    content: {
      type: String,
      required: [true, "متن پیام الزامی است"],
      maxlength: [1000, "متن پیام نمی‌تواند بیشتر از ۱۰۰۰ کاراکتر باشد"],
      minlength: [1, "متن پیام نمی‌تواند خالی باشد"],
      trim: true,
    },
    type: {
      type: String,
      enum: ["text", "image", "file"],
      default: "text",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    // ✅ اضافه کردن فیلدهای حذف
    deletedForSender: {
      type: Boolean,
      default: false,
    },
    deletedForRecipient: {
      type: Boolean,
      default: false,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// ایندکس‌ها
messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, isRead: 1 });
messageSchema.index({ createdAt: -1 });

// Middleware
messageSchema.pre("save", function () {
  if (this.content) {
    this.content = this.content.trim();
  }
  if (this.isRead && !this.readAt) {
    this.readAt = new Date();
  }
});

messageSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate();
  if (update.content) {
    update.content = update.content.trim();
  }
  if (update.isRead === true && !update.readAt) {
    update.readAt = new Date();
  }
});

messageSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Message", messageSchema);
