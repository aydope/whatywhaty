const mongoose = require("mongoose");

const objectIdRef = (ref, required = false, message) => ({
  type: mongoose.Schema.Types.ObjectId,
  ref,
  ...(required ? { required: [true, message] } : { default: null }),
});

const messageSchema = new mongoose.Schema(
  {
    sender: objectIdRef("User", true, "فرستنده پیام الزامی است"),
    recipient: objectIdRef("User", true, "دریافت‌کننده پیام الزامی است"),
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
    replyTo: objectIdRef("Message"),
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    pinnedAt: {
      type: Date,
      default: null,
    },
    pinnedBy: objectIdRef("User"),
    deletedForSender: {
      type: Boolean,
      default: false,
    },
    deletedForRecipient: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Conversation pages are read by _id (monotonic with time), once per direction.
messageSchema.index({ sender: 1, recipient: 1, _id: -1 });
// Unread totals and per-sender unread counts.
messageSchema.index({ recipient: 1, isRead: 1, sender: 1 });
messageSchema.index(
  { sender: 1, recipient: 1, pinnedAt: -1 },
  { partialFilterExpression: { pinned: true } },
);

messageSchema.pre("save", function () {
  if (this.isRead && !this.readAt) {
    this.readAt = new Date();
  }
});

messageSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Message", messageSchema);
