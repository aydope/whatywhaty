const mongoose = require("mongoose");
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
      set: function (value) {
        return value.trim();
      },
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
    refreshToken: {
      type: String,
      default: null,
      select: false,
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
userSchema.index({ email: 1 });

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
  }
});

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.__v;
  return obj;
};

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
