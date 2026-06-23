"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = (io) => {
    const namespace = io.of(/^\/organizations-owner-[0-9a-fA-F]{24}$/);
    namespace.on("connection", (socket) => {
        console.log("Client connected to /organization namespace");
        socket.on("disconnect", () => {
            console.log("Client disconnected from /organization namespace");
        });
    });
};
//# sourceMappingURL=organization.events.js.map