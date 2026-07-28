import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
    ACCESS_TOKEN_SECRET,
    ACCESS_TOKEN_EXPIRY,
    REFRESH_TOKEN_SECRET,
    REFRESH_TOKEN_EXPIRY,
} from "../config";

export default function loginToken(userId: string, remember = false) {
    const accessToken = jwt.sign({ userId }, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
    });
    const refreshToken = jwt.sign({ userId, remember, jti: crypto.randomUUID() }, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY,
    });

    return { accessToken, refreshToken };
}
