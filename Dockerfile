FROM node:alpine

WORKDIR /usr/app
COPY ./ /usr/app
RUN npm install --legacy-peer-deps

ENV NODE_MAX_OLD_SPACE_SIZE=2048
CMD [ "sh", "-c", "node --max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE} index.js" ]