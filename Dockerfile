FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
# ffmpeg — Audio Overview's turn-by-turn Polly clips are merged with it (concat demuxer, no
# re-encoding) rather than naive Buffer concatenation, which glitches at each stitch point.
RUN apk add --no-cache openssl ffmpeg
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3001
ENV PORT=3001

CMD ["npm", "start"]
