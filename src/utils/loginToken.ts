import jwt from "jsonwebtoken";
import {
    ACCESS_TOKEN_SECRET,
    ACCESS_TOKEN_EXPIRY,
    REFRESH_TOKEN_SECRET,
    REFRESH_TOKEN_EXPIRY_DAYS,
} from "../config";

export default function loginToken(userId: string, remember = false) {
    const accessToken = jwt.sign({ userId }, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
    });
    const refreshToken = jwt.sign({ userId, remember }, REFRESH_TOKEN_SECRET, {
        expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}`,
    });

    return { accessToken, refreshToken };
}
