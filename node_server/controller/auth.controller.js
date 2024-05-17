import { SessionModel } from "../models/Session.model.js";
import { UserModel } from "../models/User.model.js";
import { v4 as uuid } from "uuid";
import { createHash, isValidPassword } from "../utils/authUtils.js";
import { ChatModel } from "../models/Chat.model.js";
import { config } from "dotenv";
import axios from "axios";
import jwt from "jsonwebtoken";
import { sendVerificationEmail } from "../utils/VerfiyEmail.js";
import { Lambda_Client } from "./lambda-client.js";
import { generateRandomString } from "../utils/utils.js";

config();

const NOD_ENV = process.env.NODE_ENV;
const COOKIE_AGE = Number(process.env.COOKIE_AGE);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const origin = process.env.ORIGIN;

const lambdaClient = new Lambda_Client();

export const createSession = async (user_id) => {
  const sid = uuid();
  await SessionModel.create({ sid, user: user_id });
  const currentDate = new Date();
  const maxAge = COOKIE_AGE * 60 * 60 * 1000;
  const expires = new Date(currentDate.getTime() + maxAge);
  return { sid, maxAge, expires };
};

export const loginController = async (req, res) => {
  const { email, password } = req.body;
  const user = await UserModel.findOne({ email });
  if (!user) return res.json({ details: "No user found!" });

  const passwordMatch = isValidPassword(user, password);

  if (!passwordMatch) return res.json({ details: "Wrong password!" });
  const { sid, expires, maxAge } = await createSession(user._id);
  res.cookie("sid", sid, {
    httpOnly: true,
    secure: NOD_ENV === "PROD",
    sameSite: NOD_ENV === "PROD" ? "none" : "lax",
    expires,
    maxAge,
  });
  res.json({ details: "Login Success!" });
};

export const verifyEmailRequest = async (req, res) => {
  const email = req.body.email;
  const existingUser = await UserModel.findOne({ email });
  if (!existingUser)
    return res.json({ details: "No user found! Please send valid email" });
  if (existingUser.email_verified)
    return res.json({ details: "Email already verified!" });
  if (!existingUser)
    return res.json({ details: "No user find with this email!" });

  const token = jwt.sign({ email }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });

  existingUser.verfication_token = token;
  await existingUser.save();

  const user = await sendVerificationEmail(email, token);
  res.cookie("token", token, {
    httpOnly: true,
    secure: NOD_ENV === "PROD",
    sameSite: NOD_ENV === "PROD" ? "none" : "lax",
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log("Email Sent!", user);
  res.json({ details: "Verification Email Sent!", user: existingUser, token });
};

export const verifyEmail = async (req, res) => {
  const token = req.params.token;
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const User = await UserModel.findOne({ email: decoded.email });
  if (!User) return res.json({ details: "No user found!" });
  User.email_verified = true;
  await User.save();

  console.log("Email Verified!");
  res.redirect(process.env.REDIRECT_URL);
};

export const logoutController = async (req, res) => {
  res.clearCookie("sid");
  res.send({
    details: "Logout Success!",
  });
};

const createChat = async (user) => {
  try {
    const id = user._id;
    const chat = await ChatModel.create({ intialized_by: id });
    console.log("Chat Created!");
    return chat;
  } catch (error) {
    console.log(error);
  }
};

export const getUserDetails = async (req, res) => {
  const sid = req.cookies.sid;
  const session = await SessionModel.findOne({
    sid,
  });
  if (!session) return res.json({ details: "No session found!" });
  const user = await UserModel.findById(session.user);
  if (!user) return res.json({ details: "No user found!" });
  return res.json({
    success: true,
    message: "User details fetched successfully!",
    user,
  });
};

const createUser = async (user) => {
  const { email, password } = user;
  const username = email.split("@")[0];
  const hash = createHash(password);
  const new_user = await UserModel.create({ email, password: hash, username });
  const chat = await createChat(new_user);
  new_user.chats = [chat._id];
  await new_user.save();
};

export const registerController = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ details: "email or password is missing!" });
    const user = await UserModel.findOne({ email });
    if (user) return res.json({ details: "email already exists!" });
    await createUser({ email, password });
    res.json({ details: "Registered Successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ details: "Error registering!" });
  }
};

export const verifyUserName = async (req, res) => {
  const { username } = req.body;
  const user = await UserModel.findOne({ username });
  if (user) return res.json({ details: "Username already exists!" });
  res.json({ details: "Username is available!" });
};

export const storeAvatarUrl = async (user_id, avatar_url) => {
  try {
    await UserModel.updateOne({ _id: user_id }, { avatar_url });
    console.log("Successfully stored avatar url");
  } catch (error) {
    console.log(error);
  }
};

export const storeAvatarToS3 = async (image_url, user_id) => {
  const response = await fetch(image_url);
  const blob = await response.blob();
  const image_name = generateRandomString(6);
  const uploadResponse = await lambdaClient.uploadImage(image_name, blob);
  if (uploadResponse) {
    const avatar_url = lambdaClient.constructImageUrl(image_name);
    await storeAvatarUrl(user_id, avatar_url);
  }
  return uploadResponse;
};

const createGoogleUser = async (user) => {
  const { email, name, given_name, family_name, picture } = user;
  const hash = createHash(name);
  const new_user = await UserModel.create({
    username: email.split("@")[0],
    email,
    password: hash,
    full_name: name,
    email_verified: true,
    method: "google",
    avatar_url: picture,
  });
  const chat = await createChat(new_user);
  new_user.chats = [chat._id];
  await new_user.save();
  storeAvatarToS3(picture, new_user._id);
  return new_user;
};

export const handleGoogleUser = async (profile) => {
  const { email } = profile;
  const user = await UserModel.findOne({ email });
  if (user) {
    if (user.method != "google")
      return {
        success: false,
        message: "User with similar email already exists!",
        user: null,
      };
    return {
      success: true,
      message: "User logged in successfully!",
      user,
    };
  }
  const newUser = await createGoogleUser(profile);
  return {
    success: true,
    message: "User created successfully!",
    user: newUser,
  };
};

export const googleAuthCallback = async (req, res) => {
  const { code } = req.query;
  try {
    // Exchange authorization code for access token
    const { data } = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const { access_token, id_token } = data;

    // Use access_token or id_token to fetch user profile
    const { data: profile } = await axios.get(
      "https://www.googleapis.com/oauth2/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );
    const { message, success, user } = await handleGoogleUser(profile);
    if (success) {
      const { sid, expires, maxAge } = await createSession(user._id);
      console.log("Session Created!", { sid, expires, maxAge });
      return res
        .cookie("sid", sid, {
          httpOnly: true,
          secure: NOD_ENV === "PROD",
          sameSite: NOD_ENV === "PROD" ? "none" : "lax",
          expires,
          maxAge,
        })
        .redirect(origin);
    }
    res.redirect(origin);
  } catch (error) {
    console.error("Error:", error);
    res.redirect(origin);
  }
};

export const createNewChats = async (req, res) => {
  try {
    const chatTitle = req.body.chatTitle;
    const userId = req.user.user;
    let user = {
      _id: userId,
    };
    const userDetails = await UserModel.findById(userId);
    const secondLastChatId = userDetails.chats[userDetails.chats.length - 1];
    // check last chat messages if empty, did not create new
    const lastChat = await ChatModel.find({
      intialized_by: userId,
      _id: secondLastChatId,
    });
    if (lastChat[0]?.messages.length === 0) {
      return res.json({
        message: "use last chat",
      });
    }
    const chat = await createChat(user);
    if (chatTitle) {
      chat.title = chatTitle;
    } else {
      const date = new Date();
      chat.title = `New Chat ${date.getDate()}${date.getMilliseconds()}`;
    }
    await chat.save();
    userDetails.chats.push(chat._id);
    await userDetails.save();
    res.status(201).json({
      message: "chat created success",
    });
  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message || "something went wrong",
    });
  }
};
