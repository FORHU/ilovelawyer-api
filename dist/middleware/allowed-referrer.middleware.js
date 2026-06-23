"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("../config");
function createAllowedReferrerMiddleware(customReferrer) {
    return function (req, res, next) {
        if (config_1.isDev) {
            const referringRoute = req.get("Referrer");
            if (referringRoute && referringRoute.includes(customReferrer)) {
                next();
            }
            else {
                return res.status(403).json({ error: "Unauthorized access" });
            }
        }
        else {
            next();
        }
    };
}
exports.default = createAllowedReferrerMiddleware;
//# sourceMappingURL=allowed-referrer.middleware.js.map