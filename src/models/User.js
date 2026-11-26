const mongoose = require("mongoose");
const { cleanDisplayName, cleanBio } = require("../utils/text");
const validator = require("validator");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "نام کاربری الزامی است"],
      unique: true,
      trim: true,
      minlength: [3, "نام کاربری باید حداقل ۳ کاراکتر باشد"],
      maxlength: [30, "نام کاربری باید حداکثر ۳۰ کاراکتر باشد"],
      match: [
        /^[a-zA-Z0-9_]+$/,
        "نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و خط‌تیره باشد",
      ],
    },
    email: {
      type: String,
      required: [true, "ایمیل الزامی است"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: function (value) {
          return validator.isEmail(value);
        },
        message: "لطفا یک ایمیل معتبر وارد کنید",
      },
    },
    password: {
      type: String,
      required: [true, "رمز عبور الزامی است"],
      minlength: [6, "رمز عبور باید حداقل ۶ کاراکتر باشد"],
      select: false,
    },
    displayName: {
      type: String,
      default: "",
      maxlength: [50, "نام نمایشی نمی‌تواند بیشتر از ۵۰ کاراکتر باشد"],
      set: cleanDisplayName,
    },
    bio: {
      type: String,
      default: "",
      maxlength: [160, "بیو نمی‌تواند بیشتر از ۱۶۰ کاراکتر باشد"],
      set: cleanBio,
    },
    sessions: {
      type: [
        {
          _id: false,
          hash: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
    // Bumped whenever the password changes; tokens carry the version they were
    // issued for, so older access tokens stop working immediately.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    followers: [
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
    following: [
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
    blockedUsers: [
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
    resetPasswordToken: {
      type: String,
      default: null,
      select: false,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index({ username: "text" });

userSchema.pre("save", async function () {
  if (this.username) {
    this.username = this.username.trim();
  }
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
  if (this.isModified("password")) {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    if (!this.isNew) this.tokenVersion += 1;
  }
});

userSchema.pre("findOneAndUpdate", async function () {
  const update = this.getUpdate();
  if (update.username) {
    update.username = update.username.trim();
  }
  if (update.email) {
    update.email = update.email.toLowerCase().trim();
  }
  if (update.password) {
    const salt = await bcrypt.genSalt(12);
    update.password = await bcrypt.hash(update.password, salt);
    update.$inc = { ...(update.$inc || {}), tokenVersion: 1 };
  }
});

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.sessions;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  delete obj.__v;
  return obj;
};

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
